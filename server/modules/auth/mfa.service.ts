import { randomInt } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';

import type { StoredMfa, StoredPasskey } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Where passkeys are bound: the site's host name and the exact page origin.
 * Exported for the Auth router, which reads it from the request.
 */
export type RelyingParty = { rpId: string; origin: string };

type MfaDependencies = {
  factors: {
    getMfa(userId: number): StoredMfa;
    saveMfa(userId: number, mfa: StoredMfa): void;
    listPasskeys(userId: number): StoredPasskey[];
    getPasskeyByCredentialId(credentialId: string): StoredPasskey | undefined;
    addPasskey(passkey: Omit<StoredPasskey, 'id' | 'createdAt' | 'lastUsedAt'>): void;
    markPasskeyUsed(id: number, counter: number): void;
    deletePasskey(userId: number, id: number): boolean;
  };
  hashCode(code: string): Promise<string>;
  compareCode(code: string, hash: string): Promise<boolean>;
};

const RP_NAME = 'Tether';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// One step either side of now: a phone clock a few seconds off still works.
authenticator.options = { window: 1 };

function invalidCode(): AppError {
  return new AppError('Invalid code', { code: 'AUTH_MFA_INVALID_CODE', statusCode: 401 });
}

function newRecoveryCode(): string {
  const pick = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

/** Codes are typed by hand: spaces and case do not matter. */
function normalizeCode(code: unknown): string {
  return typeof code === 'string' ? code.replace(/\s+/g, '').toLowerCase() : '';
}

/**
 * Creates the second-factor service: authenticator codes (TOTP), one-time
 * recovery codes and passkeys (WebAuthn). Pending WebAuthn challenges and the
 * last accepted TOTP code per user live in memory: both are only good for
 * minutes, and a restart only means asking again.
 */
export function createMfaService(dependencies: MfaDependencies) {
  const { factors } = dependencies;
  // challenge -> expiry; a challenge can be answered once.
  const registrationChallenges = new Map<string, { userId: number; expiresAt: number }>();
  const loginChallenges = new Map<string, number>();
  // A TOTP code cannot be replayed within its own time window.
  const lastTotpCode = new Map<number, string>();

  function dropExpired(now: number) {
    for (const [challenge, entry] of registrationChallenges) {
      if (entry.expiresAt < now) registrationChallenges.delete(challenge);
    }
    for (const [challenge, expiresAt] of loginChallenges) {
      if (expiresAt < now) loginChallenges.delete(challenge);
    }
  }

  async function newRecoveryCodes() {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const hashes = await Promise.all(codes.map((code) => dependencies.hashCode(code)));
    return { codes, hashes };
  }

  function checkTotp(userId: number, secret: string | null, code: string): boolean {
    if (!secret || !/^\d{6}$/.test(code) || lastTotpCode.get(userId) === code) return false;
    if (!authenticator.check(code, secret)) return false;
    lastTotpCode.set(userId, code);
    return true;
  }

  /** Accepts an authenticator code, or uses up one recovery code. */
  async function verifySecondFactor(userId: number, codeInput: unknown): Promise<boolean> {
    const code = normalizeCode(codeInput);
    const mfa = factors.getMfa(userId);
    if (!mfa.totpEnabled) return false;
    if (checkTotp(userId, mfa.totpSecret, code)) return true;
    if (!/^[a-z0-9]{5}-?[a-z0-9]{5}$/.test(code)) return false;
    const formatted = code.includes('-') ? code : `${code.slice(0, 5)}-${code.slice(5)}`;
    for (const hash of mfa.recoveryCodeHashes) {
      if (await dependencies.compareCode(formatted, hash)) {
        factors.saveMfa(userId, {
          ...mfa,
          recoveryCodeHashes: mfa.recoveryCodeHashes.filter((item) => item !== hash),
        });
        return true;
      }
    }
    return false;
  }

  return {
    verifySecondFactor,

    /** True when a password alone no longer signs this user in. */
    isTotpRequired(userId: number): boolean {
      return factors.getMfa(userId).totpEnabled;
    },

    /** What the security settings show. Never returns secrets. */
    getFactors(userId: number) {
      const mfa = factors.getMfa(userId);
      return {
        totpEnabled: mfa.totpEnabled,
        recoveryCodesLeft: mfa.totpEnabled ? mfa.recoveryCodeHashes.length : 0,
        passkeys: factors.listPasskeys(userId).map((passkey) => ({
          id: passkey.id,
          name: passkey.name,
          createdAt: passkey.createdAt,
          lastUsedAt: passkey.lastUsedAt,
        })),
      };
    },

    /** Starts authenticator setup: a new secret, kept off until a code confirms it. */
    async startTotpSetup(userId: number, username: string) {
      const mfa = factors.getMfa(userId);
      if (mfa.totpEnabled) {
        throw new AppError('The authenticator is already on', { code: 'AUTH_MFA_ALREADY_ENABLED', statusCode: 409 });
      }
      const secret = authenticator.generateSecret();
      factors.saveMfa(userId, { ...mfa, totpSecret: secret, totpEnabled: false });
      const otpauthUrl = authenticator.keyuri(username, RP_NAME, secret);
      return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }) };
    },

    /** Turns the authenticator on with a first good code; returns the recovery codes, shown once. */
    async enableTotp(userId: number, codeInput: unknown) {
      const mfa = factors.getMfa(userId);
      if (mfa.totpEnabled) {
        throw new AppError('The authenticator is already on', { code: 'AUTH_MFA_ALREADY_ENABLED', statusCode: 409 });
      }
      if (!checkTotp(userId, mfa.totpSecret, normalizeCode(codeInput))) throw invalidCode();
      const { codes, hashes } = await newRecoveryCodes();
      factors.saveMfa(userId, { totpSecret: mfa.totpSecret, totpEnabled: true, recoveryCodeHashes: hashes });
      return { recoveryCodes: codes };
    },

    /** Turns the authenticator off; needs a current code or a recovery code. */
    async disableTotp(userId: number, codeInput: unknown) {
      if (!(await verifySecondFactor(userId, codeInput))) throw invalidCode();
      factors.saveMfa(userId, { totpSecret: null, totpEnabled: false, recoveryCodeHashes: [] });
      return { success: true };
    },

    /** Replaces every recovery code; needs a current code or a recovery code. */
    async regenerateRecoveryCodes(userId: number, codeInput: unknown) {
      if (!(await verifySecondFactor(userId, codeInput))) throw invalidCode();
      const { codes, hashes } = await newRecoveryCodes();
      factors.saveMfa(userId, { ...factors.getMfa(userId), recoveryCodeHashes: hashes });
      return { recoveryCodes: codes };
    },

    async passkeyRegistrationOptions(user: { id: number; username: string }, rp: RelyingParty) {
      dropExpired(Date.now());
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rp.rpId,
        userName: user.username,
        userID: new TextEncoder().encode(String(user.id)),
        attestationType: 'none',
        excludeCredentials: factors.listPasskeys(user.id).map((passkey) => ({
          id: passkey.credentialId,
          transports: passkey.transports as AuthenticatorTransportFuture[],
        })),
        // A discoverable credential lets the login page ask without a username.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      registrationChallenges.set(options.challenge, { userId: user.id, expiresAt: Date.now() + CHALLENGE_TTL_MS });
      return options;
    },

    async verifyPasskeyRegistration(userId: number, response: RegistrationResponseJSON, rp: RelyingParty, nameInput: unknown) {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: (challenge) => {
          const entry = registrationChallenges.get(challenge);
          registrationChallenges.delete(challenge);
          return Boolean(entry && entry.userId === userId && entry.expiresAt >= Date.now());
        },
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
      }).catch(() => null);
      if (!verification?.verified || !verification.registrationInfo) {
        throw new AppError('The passkey could not be verified', { code: 'AUTH_PASSKEY_INVALID', statusCode: 400 });
      }
      const { credential } = verification.registrationInfo;
      const name = typeof nameInput === 'string' && nameInput.trim() ? nameInput.trim().slice(0, 60) : 'Passkey';
      factors.addPasskey({
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? [],
        name,
      });
      return { success: true };
    },

    async passkeyLoginOptions(rp: RelyingParty) {
      dropExpired(Date.now());
      const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required' });
      loginChallenges.set(options.challenge, Date.now() + CHALLENGE_TTL_MS);
      return options;
    },

    /** Checks a passkey sign-in; returns the user it belongs to. */
    async verifyPasskeyLogin(response: AuthenticationResponseJSON, rp: RelyingParty): Promise<number> {
      const passkey = typeof response?.id === 'string' ? factors.getPasskeyByCredentialId(response.id) : undefined;
      const verification = passkey
        ? await verifyAuthenticationResponse({
          response,
          expectedChallenge: (challenge) => {
            const expiresAt = loginChallenges.get(challenge);
            loginChallenges.delete(challenge);
            return expiresAt !== undefined && expiresAt >= Date.now();
          },
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpId,
          credential: {
            id: passkey.credentialId,
            publicKey: Buffer.from(passkey.publicKey, 'base64url'),
            counter: passkey.counter,
            transports: passkey.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: true,
        }).catch(() => null)
        : null;
      if (!passkey || !verification?.verified) {
        throw new AppError('Passkey sign-in failed', { code: 'AUTH_PASSKEY_INVALID', statusCode: 401 });
      }
      factors.markPasskeyUsed(passkey.id, verification.authenticationInfo.newCounter);
      return passkey.userId;
    },

    deletePasskey(userId: number, id: number) {
      if (!factors.deletePasskey(userId, id)) {
        throw new AppError('Passkey not found', { code: 'AUTH_PASSKEY_NOT_FOUND', statusCode: 404 });
      }
      return { success: true };
    },
  };
}
