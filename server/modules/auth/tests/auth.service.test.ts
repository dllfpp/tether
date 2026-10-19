import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      getUserById: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    mfa: {
      isTotpRequired: () => false,
      verifySecondFactor: async () => false,
    },
    generateMfaToken: (userId) => `mfa-${userId}`,
    verifyMfaToken: (token) => (token === 'mfa-1' ? 1 : null),
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      getUserById: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      getUserById: () => undefined,
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

const alice = { id: 1, username: 'alice', password_hash: 'hash' };

function aliceWithAuthenticator(verifySecondFactor: (userId: number, code: unknown) => Promise<boolean>) {
  return createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => alice,
      getUserById: (userId) => (userId === 1 ? alice : undefined),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => true,
    mfa: { isTotpRequired: () => true, verifySecondFactor },
  });
}

test('with the authenticator on, the password only earns a ticket for the code step', async () => {
  const service = createAuthService(aliceWithAuthenticator(async () => true));

  const result = await service.login('alice', 'right-password');

  assert.deepEqual(result, { success: true, mfaRequired: true, mfaToken: 'mfa-1' });
  assert.equal('token' in result, false, 'no session before the code');
});

test('a good code on a valid ticket signs in; a bad code or ticket does not', async () => {
  const service = createAuthService(aliceWithAuthenticator(async (_userId, code) => code === '123456'));

  assert.equal((await service.loginWithCode('mfa-1', '123456')).token, 'signed-token');
  await assert.rejects(
    service.loginWithCode('mfa-1', '000000'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_MFA_INVALID_CODE',
  );
  await assert.rejects(
    service.loginWithCode('forged', '123456'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_MFA_EXPIRED',
  );
});
