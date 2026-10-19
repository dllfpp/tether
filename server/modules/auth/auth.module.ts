import { createRequire } from 'node:module';

import { authFactorsDb, getConnection, userDb } from '@/modules/database/index.js';

import { authenticateToken, generateMfaToken, generateToken, verifyMfaToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createMfaService } from './mfa.service.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const databaseConnection = getConnection();

const mfaService = createMfaService({
  factors: authFactorsDb,
  // Recovery codes are random and long; fewer rounds keep checking all ten fast.
  hashCode: (code) => bcrypt.hash(code, 10),
  compareCode: (code, hash) => bcrypt.compare(code, hash),
});

const authService = createAuthService({
  users: {
    hasUsers: () => userDb.hasUsers(),
    createUser: (username, passwordHash) => userDb.createUser(username, passwordHash),
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    getUserById: (userId) => userDb.getUserById(userId),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
  },
  transaction: {
    begin: () => databaseConnection.prepare('BEGIN').run(),
    commit: () => databaseConnection.prepare('COMMIT').run(),
    rollback: () => databaseConnection.prepare('ROLLBACK').run(),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
  mfa: mfaService,
  generateMfaToken,
  verifyMfaToken,
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, mfaService, authenticateToken);
