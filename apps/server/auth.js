/**
 * auth.js — sign-up / login security.
 * ---------------------------------------------------------------------------
 * Uses only Node's built-in "crypto" module — no extra packages to install.
 *   • Passwords are hashed with scrypt (a slow, memory-hard hash) + a random
 *     salt, so the database never stores the real password. Even we can't read it.
 *   • Login hands back a signed token (a mini "JWT"): the app stores it and
 *     sends it with every request to prove who it is. The signature means the
 *     token can't be forged or tampered with.
 */
import crypto from 'crypto';
import { getUserById } from './db.js';

// The secret used to sign tokens. A hardcoded fallback is fine while
// developing locally, but silently falling back in production would mean
// anyone who has read the source can forge tokens — so outside development
// the server refuses to start without JWT_SECRET rather than running in a
// state that merely LOOKS secure.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set when NODE_ENV=production.');
  console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set — using the built-in development secret. Do not use this in production.');
}
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // tokens last 7 days

// --- Password hashing --------------------------------------------------------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;   // stored as "salt:hash"
}
export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  // timingSafeEqual avoids leaking info via how long the comparison takes.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// --- Signed tokens -----------------------------------------------------------
const b64u = (s) => Buffer.from(s).toString('base64url');
export function signToken(user) {
  // `ver` carries the account's token_version. authRequired compares it with
  // the current value in the database, so bumping that column invalidates
  // every token already issued — the only way to actually revoke a stolen
  // token before its 7-day expiry.
  const payload = {
    sub: user.id,
    role: user.role,
    ver: user.token_version ?? 0,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || ''), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;   // bad signature
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;                 // expired
  return payload;
}

// --- Express middleware: require a valid signed-in user ----------------------
export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Please sign in.' });
  const user = getUserById(payload.sub);
  if (!user) return res.status(401).json({ error: 'Your session is no longer valid.' });
  // Revocation check: a token minted before the account's version was bumped
  // (password change, "sign out everywhere") is refused even though its
  // signature is valid and it hasn't expired yet.
  if ((payload.ver ?? 0) !== (user.token_version ?? 0)) {
    return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
  }
  req.user = user;
  next();
}

// --- One-time password reset codes ------------------------------------------
// Six digits, generated with a cryptographic RNG (not Math.random) and stored
// only as a hash, so the database never holds a usable code.
export function generateResetCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}
export const hashResetCode = (code) =>
  crypto.createHash('sha256').update(`${SECRET}:${code}`).digest('hex');
export function verifyResetCode(code, storedHash) {
  const a = Buffer.from(hashResetCode(String(code)));
  const b = Buffer.from(String(storedHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Shape a user record for sending to the browser (drops the password hash).
export const publicUser = (u) => u && ({
  id: u.id, email: u.email, fullName: u.full_name, chcName: u.chc_name, role: u.role,
});
