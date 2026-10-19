import assert from 'node:assert/strict';
import test from 'node:test';

import { authenticator } from 'otplib';

import type { StoredMfa, StoredPasskey } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { createMfaService } from '../mfa.service.js';

function createService() {
  let mfa: StoredMfa = { totpSecret: null, totpEnabled: false, recoveryCodeHashes: [] };
  const passkeys: StoredPasskey[] = [];
  const service = createMfaService({
    factors: {
      getMfa: () => mfa,
      saveMfa: (_userId, next) => { mfa = next; },
      listPasskeys: () => passkeys,
      getPasskeyByCredentialId: (id) => passkeys.find((passkey) => passkey.credentialId === id),
      addPasskey: () => undefined,
      markPasskeyUsed: () => undefined,
      deletePasskey: () => false,
    },
    // Readable stand-ins for bcrypt.
    hashCode: async (code) => `hash:${code}`,
    compareCode: async (code, hash) => hash === `hash:${code}`,
  });
  return { service, state: () => mfa };
}

async function enabled() {
  const created = createService();
  const { secret } = await created.service.startTotpSetup(1, 'alice');
  const { recoveryCodes } = await created.service.enableTotp(1, authenticator.generate(secret));
  return { ...created, secret, recoveryCodes };
}

test('the authenticator turns on only with a good first code, and returns ten recovery codes', async () => {
  const { service, state } = createService();
  const setup = await service.startTotpSetup(1, 'alice');

  assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\/Tether:alice\?secret=/);
  assert.match(setup.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(service.isTotpRequired(1), false, 'not before a code confirms it');
  await assert.rejects(
    service.enableTotp(1, '000000'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_MFA_INVALID_CODE',
  );

  const { recoveryCodes } = await service.enableTotp(1, authenticator.generate(setup.secret));

  assert.equal(recoveryCodes.length, 10);
  assert.ok(recoveryCodes.every((code) => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(code)));
  assert.equal(service.isTotpRequired(1), true);
  assert.equal(state().recoveryCodeHashes.length, 10, 'only hashes are stored');
});

test('a code cannot be replayed, and a recovery code works once', async () => {
  const { service, secret, recoveryCodes } = await enabled();

  // The code that enabled the authenticator was just used.
  assert.equal(await service.verifySecondFactor(1, authenticator.generate(secret)), false);

  const recovery = recoveryCodes[0];
  assert.equal(await service.verifySecondFactor(1, recovery.toUpperCase().replace('-', ' ')), true);
  assert.equal(await service.verifySecondFactor(1, recovery), false, 'used up');
  assert.equal(service.getFactors(1).recoveryCodesLeft, 9);
});

test('turning the authenticator off needs a code and clears everything', async () => {
  const { service, recoveryCodes, state } = await enabled();

  await assert.rejects(service.disableTotp(1, 'nope'));
  await service.disableTotp(1, recoveryCodes[1]);

  assert.deepEqual(state(), { totpSecret: null, totpEnabled: false, recoveryCodeHashes: [] });
  assert.equal(service.isTotpRequired(1), false);
});

test('a passkey sign-in with an unknown credential fails', async () => {
  const { service } = createService();
  await assert.rejects(
    service.verifyPasskeyLogin({ id: 'unknown' } as never, { rpId: 'tether.example', origin: 'https://tether.example' }),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_PASSKEY_INVALID',
  );
});
