/**
 * CloudCLI live: auth factors repository.
 *
 * Persists the second login factors of a user: the authenticator (TOTP)
 * secret, the hashed recovery codes and the WebAuthn passkeys.
 */

import { getConnection } from '@/modules/database/connection.js';

type MfaRow = {
  user_id: number;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string;
};

type PasskeyRow = {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

/** One stored passkey, decoded. Used by the Auth module. */
export type StoredPasskey = {
  id: number;
  userId: number;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

/** The authenticator state of a user, decoded. Used by the Auth module. */
export type StoredMfa = {
  totpSecret: string | null;
  totpEnabled: boolean;
  recoveryCodeHashes: string[];
};

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toPasskey(row: PasskeyRow): StoredPasskey {
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: row.counter,
    transports: parseStringArray(row.transports),
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

// authFactorsDb: used by Auth to store and check the authenticator, recovery codes and passkeys.
export const authFactorsDb = {
  /** The authenticator state of a user; an empty state when nothing was set up. */
  getMfa(userId: number): StoredMfa {
    const row = getConnection()
      .prepare('SELECT * FROM auth_mfa WHERE user_id = ?')
      .get(userId) as MfaRow | undefined;
    return {
      totpSecret: row?.totp_secret ?? null,
      totpEnabled: row?.totp_enabled === 1,
      recoveryCodeHashes: row ? parseStringArray(row.recovery_codes) : [],
    };
  },

  /** Replaces the authenticator state of a user. */
  saveMfa(userId: number, mfa: StoredMfa): void {
    getConnection()
      .prepare(`
        INSERT INTO auth_mfa (user_id, totp_secret, totp_enabled, recovery_codes, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          totp_secret = excluded.totp_secret,
          totp_enabled = excluded.totp_enabled,
          recovery_codes = excluded.recovery_codes,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(userId, mfa.totpSecret, mfa.totpEnabled ? 1 : 0, JSON.stringify(mfa.recoveryCodeHashes));
  },

  /** Every passkey of a user, oldest first. */
  listPasskeys(userId: number): StoredPasskey[] {
    const rows = getConnection()
      .prepare('SELECT * FROM auth_passkeys WHERE user_id = ? ORDER BY id')
      .all(userId) as PasskeyRow[];
    return rows.map(toPasskey);
  },

  /** The passkey with this credential id, whoever owns it. */
  getPasskeyByCredentialId(credentialId: string): StoredPasskey | undefined {
    const row = getConnection()
      .prepare('SELECT * FROM auth_passkeys WHERE credential_id = ?')
      .get(credentialId) as PasskeyRow | undefined;
    return row ? toPasskey(row) : undefined;
  },

  /** Stores a newly registered passkey. */
  addPasskey(passkey: Omit<StoredPasskey, 'id' | 'createdAt' | 'lastUsedAt'>): void {
    getConnection()
      .prepare(`
        INSERT INTO auth_passkeys (user_id, credential_id, public_key, counter, transports, name)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        passkey.userId,
        passkey.credentialId,
        passkey.publicKey,
        passkey.counter,
        JSON.stringify(passkey.transports),
        passkey.name,
      );
  },

  /** Records a successful sign-in with a passkey. */
  markPasskeyUsed(id: number, counter: number): void {
    getConnection()
      .prepare('UPDATE auth_passkeys SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(counter, id);
  },

  /** Deletes one passkey of a user; false when it was not theirs. */
  deletePasskey(userId: number, id: number): boolean {
    const result = getConnection()
      .prepare('DELETE FROM auth_passkeys WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  },
};
