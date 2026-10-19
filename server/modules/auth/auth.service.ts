import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    getUserById(userId: number): AuthUser | undefined;
    updateLastLogin(userId: number): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
  // CloudCLI live: second factor after the password.
  mfa: {
    isTotpRequired(userId: number): boolean;
    verifySecondFactor(userId: number, code: unknown): Promise<boolean>;
  };
  generateMfaToken(userId: number): string;
  verifyMfaToken(token: string): number | null;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  function signedIn(user: AuthUser) {
    dependencies.users.updateLastLogin(numericUserId(user.id));
    return {
      success: true,
      user: { id: user.id, username: user.username },
      token: dependencies.generateToken(user),
    };
  }

  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      // CloudCLI live: with the authenticator on, the password only earns a
      // short-lived ticket for the code step, never a session.
      if (dependencies.mfa.isTotpRequired(numericUserId(user.id))) {
        return {
          success: true,
          mfaRequired: true,
          mfaToken: dependencies.generateMfaToken(numericUserId(user.id)),
        };
      }

      return signedIn(user);
    },

    /** CloudCLI live: second login step, an authenticator or recovery code. */
    async loginWithCode(mfaTokenInput: unknown, code: unknown) {
      const userId = typeof mfaTokenInput === 'string' ? dependencies.verifyMfaToken(mfaTokenInput) : null;
      const user = userId === null ? undefined : dependencies.users.getUserById(userId);
      if (!user) {
        throw new AppError('The sign-in expired, enter the password again', {
          code: 'AUTH_MFA_EXPIRED',
          statusCode: 401,
        });
      }
      if (!(await dependencies.mfa.verifySecondFactor(numericUserId(user.id), code))) {
        throw new AppError('Invalid code', { code: 'AUTH_MFA_INVALID_CODE', statusCode: 401 });
      }
      return signedIn(user);
    },

    /** CloudCLI live: a verified passkey is a complete sign-in on its own. */
    loginWithPasskey(userId: number) {
      const user = dependencies.users.getUserById(userId);
      if (!user) {
        throw new AppError('Passkey sign-in failed', { code: 'AUTH_PASSKEY_INVALID', statusCode: 401 });
      }
      return signedIn(user);
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
