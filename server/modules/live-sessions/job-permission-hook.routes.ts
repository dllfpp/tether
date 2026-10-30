import crypto from 'node:crypto';

import express from 'express';
import type { Request, Response } from 'express';

import { ensureJobPermissionToken, requestJobPermission } from '@/modules/live-sessions/services/job-permissions.service.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const router = express.Router();

/**
 * CloudCLI live: called by deploy/live/permission-hook.sh (Claude Code's
 * PermissionRequest hook) from this machine, with the token in
 * job-permission-hook.token. Body: the hook's own input. Answers with the
 * hook output to print: a decision, or {} when nobody answered in the chat.
 */
router.post('/permission', express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '') || !sameToken(req.get('x-tether-hook-token'), ensureJobPermissionToken())) {
    res.status(403).json({});
    return;
  }
  const body = (req.body ?? {}) as { session_id?: unknown; tool_name?: unknown; tool_input?: unknown };
  if (typeof body.session_id !== 'string' || typeof body.tool_name !== 'string') {
    res.json({});
    return;
  }
  const allow = await requestJobPermission({
    providerSessionId: body.session_id,
    toolName: body.tool_name,
    toolInput: body.tool_input ?? {},
  });
  if (allow === null) {
    res.json({});
    return;
  }
  res.json({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied from Tether.' },
    },
  });
});

/** Mounted by server startup under /api/live-hook, outside the user login (see the token check). */
export default router;
