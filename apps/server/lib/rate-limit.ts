/**
 * lib/rate-limit.ts — a small in-memory request limiter.
 * ---------------------------------------------------------------------------
 * PER PROCESS, deliberately. It blunts password guessing and upload floods on
 * a single instance; it is not a distributed defence, and running two copies
 * of the API would double every limit. Moving the counters to Redis is the fix
 * when that day comes — see the note in the README.
 */
import type { RequestHandler } from 'express';

// A small fixed-window counter kept in memory — no extra dependency. It exists
// to blunt password guessing and upload floods; it is per-process, so it is a
// speed bump rather than a distributed defence.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit({ windowMs, max, key = 'ip' }: { windowMs: number; max: number; key?: string }): RequestHandler {
  return (req, res, next) => {
    const id = `${key}:${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = rateBuckets.get(id);
    if (!entry || now > entry.resetAt) {
      rateBuckets.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `Too many attempts. Try again in ${retry}s.` });
    }
    entry.count++;
    next();
  };
}
// Drop expired buckets occasionally so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
}, 60_000).unref();

// Overridable so the test suite is not throttled by a defence aimed at people.
// A run creates dozens of accounts in seconds, which is exactly the pattern the
// limiter exists to stop — the limits are real in every other environment.
const AUTH_RATE_MAX = Number(process.env.AUTH_RATE_MAX || 20);    // login/signup
const RESET_RATE_MAX = Number(process.env.RESET_RATE_MAX || 5);   // password reset
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: AUTH_RATE_MAX });
export const resetLimiter = rateLimit({ windowMs: 15 * 60_000, max: RESET_RATE_MAX });
export const uploadLimiter = rateLimit({ windowMs: 60 * 60_000, max: 30 }); // slide uploads
