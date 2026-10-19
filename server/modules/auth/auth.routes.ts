import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';
import type { createMfaService, RelyingParty } from './mfa.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/** The signed-in user, as the token middleware attached it. */
function sessionUser(req: express.Request): { id: number; username: string } {
  const user = (req as AuthenticatedRequest).user as { id?: unknown; username?: unknown } | undefined;
  return { id: Number(user?.id), username: String(user?.username ?? '') };
}

/**
 * CloudCLI live: where passkeys are bound. WEBAUTHN_ORIGIN pins it (for
 * example https://tether.example); without it the page's own Origin is used.
 * The browser itself refuses a passkey of another site, so the Origin header
 * cannot borrow one.
 */
function relyingParty(req: express.Request): RelyingParty {
  const origin = process.env.WEBAUTHN_ORIGIN || req.get('origin') || '';
  let rpId = '';
  try {
    rpId = new URL(origin).hostname;
  } catch {
    rpId = '';
  }
  return { rpId: process.env.WEBAUTHN_RP_ID || rpId, origin };
}

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  mfa: ReturnType<typeof createMfaService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  // CloudCLI live: second factors. The /login/... paths share the login rate limit.
  router.post('/login/code', async (req, res, next) => {
    try {
      const body = req.body as { mfaToken?: unknown; code?: unknown };
      res.json(await service.loginWithCode(body.mfaToken, body.code));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login/passkey/options', async (req, res, next) => {
    try {
      res.json(await mfa.passkeyLoginOptions(relyingParty(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login/passkey', async (req, res, next) => {
    try {
      const body = req.body as { response?: unknown };
      const userId = await mfa.verifyPasskeyLogin(body.response as never, relyingParty(req));
      res.json(service.loginWithPasskey(userId));
    } catch (error) {
      next(error);
    }
  });

  router.get('/mfa', authenticateToken, (req, res) => {
    res.json(mfa.getFactors(sessionUser(req).id));
  });

  router.post('/mfa/totp/setup', authenticateToken, async (req, res, next) => {
    try {
      const user = sessionUser(req);
      res.json(await mfa.startTotpSetup(user.id, user.username));
    } catch (error) {
      next(error);
    }
  });

  router.post('/mfa/totp/enable', authenticateToken, async (req, res, next) => {
    try {
      res.json(await mfa.enableTotp(sessionUser(req).id, (req.body as { code?: unknown }).code));
    } catch (error) {
      next(error);
    }
  });

  router.post('/mfa/totp/disable', authenticateToken, async (req, res, next) => {
    try {
      res.json(await mfa.disableTotp(sessionUser(req).id, (req.body as { code?: unknown }).code));
    } catch (error) {
      next(error);
    }
  });

  router.post('/mfa/recovery-codes', authenticateToken, async (req, res, next) => {
    try {
      res.json(await mfa.regenerateRecoveryCodes(sessionUser(req).id, (req.body as { code?: unknown }).code));
    } catch (error) {
      next(error);
    }
  });

  router.post('/mfa/passkeys/options', authenticateToken, async (req, res, next) => {
    try {
      res.json(await mfa.passkeyRegistrationOptions(sessionUser(req), relyingParty(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/mfa/passkeys', authenticateToken, async (req, res, next) => {
    try {
      const body = req.body as { response?: unknown; name?: unknown };
      res.json(await mfa.verifyPasskeyRegistration(
        sessionUser(req).id,
        body.response as never,
        relyingParty(req),
        body.name,
      ));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/mfa/passkeys/:id', authenticateToken, (req, res, next) => {
    try {
      res.json(mfa.deletePasskey(sessionUser(req).id, Number(req.params.id)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
