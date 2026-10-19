import type { NextFunction, Request, Response } from 'express';

/**
 * Slows down and then blocks password guessing on POST /api/auth/login.
 *
 * Only failed attempts count, per client IP (`req.ip`, which honours the
 * app's `trust proxy` setting so a reverse proxy's X-Forwarded-For is used
 * only when that proxy is trusted). After MAX_FAILURES within WINDOW_MS the
 * IP gets 429 until the window passes; every failure is also delayed.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_DELAY_MS = 1000;

type Entry = { failures: number; windowStart: number };

const failuresByIp = new Map<string, Entry>();

function currentEntry(ip: string, now: number): Entry {
  const entry = failuresByIp.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    const fresh = { failures: 0, windowStart: now };
    failuresByIp.set(ip, fresh);
    return fresh;
  }
  return entry;
}

/** Used by server startup, mounted on /api/auth/login ahead of the auth routes. */
export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = currentEntry(ip, now);

  if (entry.failures >= MAX_FAILURES) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
    res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
    return;
  }

  // Hold the failure response back so guessing gets slow even under the cap.
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400) {
      entry.failures += 1;
      setTimeout(() => originalJson(body), FAILURE_DELAY_MS);
      return res;
    }
    failuresByIp.delete(ip);
    return originalJson(body);
  }) as Response['json'];

  next();
}

/** @internal */
export function resetLoginRateLimitForTests(): void {
  failuresByIp.clear();
}
