#!/usr/bin/env node
// Tether: the way back in when the authenticator and every recovery
// code are lost. Turns the authenticator off for every user, so the password
// alone signs in again; with --passkeys it also deletes every passkey.
// Run on the server (root access is the proof of identity):
//
//   node /opt/tether/deploy/reset-mfa.mjs [--passkeys]
//
// The database path comes from DATABASE_PATH, else from the install's .env.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const Database = require('better-sqlite3');

function databasePath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  try {
    const line = readFileSync(join(root, '.env'), 'utf8').split('\n').find((row) => row.startsWith('DATABASE_PATH='));
    if (line) return line.slice('DATABASE_PATH='.length).trim();
  } catch {
    // No .env: fall through to the default.
  }
  return join(root, 'data', 'auth.db');
}

const path = databasePath();
const db = new Database(path);
const mfa = db.prepare("UPDATE auth_mfa SET totp_secret = NULL, totp_enabled = 0, recovery_codes = '[]'").run();
console.log(`${path}: authenticator turned off (${mfa.changes} user(s)).`);
if (process.argv.includes('--passkeys')) {
  const passkeys = db.prepare('DELETE FROM auth_passkeys').run();
  console.log(`${passkeys.changes} passkey(s) deleted.`);
}
db.close();
