/**
 * routes/auth.ts — accounts: sign-up, sign-in, profile, password reset.
 * ---------------------------------------------------------------------------
 * Mounted at /api/auth. Everything about WHO someone is lives here; what they
 * are allowed to do afterwards is decided per-route in the other files.
 */
import { Router } from 'express';
import * as db from '../db.ts';
import type { Role } from '../types.ts';
import {
  hashPassword, verifyPassword, signToken, authRequired, publicUser,
  generateResetCode, hashResetCode, verifyResetCode,
} from '../auth.ts';
import { isMailConfigured, sendResetCodeEmail } from '../mailer.ts';
import { authLimiter, resetLimiter } from '../lib/rate-limit.ts';

export const authRoutes = Router();

// Both the CHC intake portal and the pathology console share this same
// users table and these same routes — `role` is what keeps the two account
// types apart. `chcName` only makes sense for a lab attendant (it's their
// health centre); a pathologist isn't tied to one, so it's just stored empty.
const ROLES: Role[] = ['lab_attendant', 'pathologist', 'physician'];

// Sign up: creates an account. Lab attendants also give their CHC name;
// pathologists just give a name, email and password.
authRoutes.post('/signup', authLimiter, async (req, res) => {
  const { email, password, fullName, chcName, role = 'lab_attendant' } = req.body || {};
  if (!ROLES.includes(role))
    return res.status(400).json({ error: 'Unknown account type.' });
  const needsChc = role === 'lab_attendant';
  if (!email || !password || !fullName || (needsChc && !chcName))
    return res.status(400).json({ error: needsChc ? 'Name, CHC, email and password are all required.' : 'Name, email and password are all required.' });
  if (String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  // Scoped to THIS role: the same email may already have an account under
  // the OTHER role (e.g. this person also uses the CHC intake portal) — that
  // doesn't block a new account here, only a duplicate within this role does.
  if (await db.getUserByEmailAndRole(String(email).trim(), role))
    return res.status(409).json({ error: 'An account with this email already exists.' });

  const user = await db.createUser({
    email: String(email).trim(),
    passwordHash: hashPassword(password),
    fullName: String(fullName).trim(),
    chcName: needsChc ? String(chcName).trim() : '',
    role,
  });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Log in: the same email can now have TWO accounts (one lab-attendant, one
// pathologist), so `role` — which portal is asking — is what picks the
// right one, not just email + password on its own.
authRoutes.post('/login', authLimiter, async (req, res) => {
  const { email, password, role } = req.body || {};
  const trimmedEmail = String(email || '').trim();

  const user = role ? await db.getUserByEmailAndRole(trimmedEmail, role) : await db.getUserByEmail(trimmedEmail);
  if (user && verifyPassword(password || '', user.password_hash)) {
    // Recorded before responding so a successful sign-in is on the record even
    // if the response never reaches the client.
    void db.writeAudit({
      userId: user.id, userName: user.full_name, userRole: user.role,
      action: 'login', ip: req.ip ?? null,
    });
    return res.json({ token: signToken(user), user: publicUser(user) });
  }

  // No account under THIS role (or the password was wrong there) — if the
  // same email + password is valid under the OTHER role, say so instead of
  // a generic error, so they know to use the other portal.
  if (role) {
    // Check EVERY other role, not just one. With three portals, testing a
    // single arbitrary alternative would miss the account and fall through to
    // "wrong password", which sends the user hunting for a typo that isn't
    // there. The password is verified before revealing anything, so this
    // cannot be used to discover which portals an email is registered on.
    for (const otherRole of ROLES.filter((r) => r !== role)) {
      const other = await db.getUserByEmailAndRole(trimmedEmail, otherRole);
      if (other && verifyPassword(password || '', other.password_hash)) {
        return res.status(403).json({
          error: `This account is registered for the ${PORTAL_NAMES[otherRole]} portal, not here.`,
        });
      }
    }
  }
  return res.status(401).json({ error: 'Wrong email or password.' });
});

// Who am I? Lets the app restore the session on reload from its saved token.
authRoutes.get('/me', authRequired, async (req, res) => res.json({ user: publicUser(req.user!) }));

// Edit profile: update the signed-in attendant's name and CHC.
authRoutes.patch('/profile', authRequired, async (req, res) => {
  const { fullName, chcName } = req.body || {};
  if (!fullName || !String(fullName).trim() || !chcName || !String(chcName).trim())
    return res.status(400).json({ error: 'Name and CHC are required.' });
  const user = await db.updateProfile(req.user!.id, {
    fullName: String(fullName).trim(), chcName: String(chcName).trim(),
  });
  res.json({ user: publicUser(user) });
});

// --- Forgot password: two steps, with a one-time code -----------------------
// The previous flow accepted email + name + CHC as proof of identity, but a
// colleague knows all three — it was effectively no check at all. Instead a
// short-lived, single-use code is generated and delivered through exactly ONE
// channel, chosen by whether SMTP is configured:
//   • configured   → emailed to the account's own address (mailer.js).
//   • unconfigured → printed to this server's console, so local development
//                    keeps working with zero setup. The operator running the
//                    backend then has to hand the code over — a real, if
//                    inconvenient, second factor.
// Either way, the code is never returned in the HTTP response itself.
const RESET_CODE_TTL_MS = 15 * 60_000;
const RESET_CODE_TTL_MIN = RESET_CODE_TTL_MS / 60_000;
const RESET_MAX_ATTEMPTS = 5;
const PORTAL_NAMES: Record<Role, string> = {
  lab_attendant: 'EPTB Hub — CHC Intake',
  pathologist: 'EPTB Hub — Pathology Console',
  physician: 'EPTB Hub — Physician Review',
};

authRoutes.post('/request-reset', resetLimiter, async (req, res) => {
  const { email, role = 'lab_attendant' } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const user = await db.getUserByEmailAndRole(String(email).trim(), role);

  // Always answer the same way, whether or not the account exists — otherwise
  // this endpoint becomes a way to discover which emails are registered. The
  // wording adapts to how a real code would actually reach someone, but is
  // shown REGARDLESS of whether `user` was found, so it reveals nothing.
  const generic = {
    ok: true,
    message: isMailConfigured
      ? 'If that account exists, a reset code has been sent to it.'
      : 'If that account exists, a reset code has been issued. Ask your system operator for it.',
  };
  if (!user) return res.json(generic);

  const code = generateResetCode();
  await db.storeResetCode(user.id, hashResetCode(code), Date.now() + RESET_CODE_TTL_MS);

  if (isMailConfigured) {
    // Deliberately NOT awaited: the response above must go out at the same
    // speed whether or not the account existed, or the delay of a real
    // network email send becomes a timing side-channel that leaks it.
    sendResetCodeEmail({
      to: user.email,
      code,
      expiresInMinutes: RESET_CODE_TTL_MIN,
      portalName: PORTAL_NAMES[user.role as Role] || 'EPTB Hub',
    }).catch((e: Error) => console.error(`Email: failed to send reset code to ${user.email}:`, e.message));
  } else {
    console.log('');
    console.log('==================== PASSWORD RESET CODE ====================');
    console.log(`  account : ${user.email} (${user.role})`);
    console.log(`  code    : ${code}`);
    console.log(`  expires : ${new Date(Date.now() + RESET_CODE_TTL_MS).toLocaleTimeString()}`);
    console.log('=============================================================');
    console.log('');
  }
  res.json(generic);
});

authRoutes.post('/reset-password', resetLimiter, async (req, res) => {
  const { email, code, newPassword, role = 'lab_attendant' } = req.body || {};
  if (!email || !code || !newPassword)
    return res.status(400).json({ error: 'Email, reset code and a new password are all required.' });
  if (String(newPassword).length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });

  const user = await db.getUserByEmailAndRole(String(email).trim(), role);
  const invalid = { error: 'That reset code is not valid or has expired.' };
  if (!user) return res.status(400).json(invalid);

  const record = await db.getResetCode(user.id);
  if (!record) return res.status(400).json(invalid);
  if (Date.now() > record.expires_at) { await db.clearResetCode(user.id); return res.status(400).json(invalid); }
  if (record.attempts >= RESET_MAX_ATTEMPTS) {
    await db.clearResetCode(user.id);
    return res.status(429).json({ error: 'Too many incorrect codes. Request a new one.' });
  }
  if (!verifyResetCode(code, record.code_hash)) {
    await db.bumpResetAttempts(user.id);
    return res.status(400).json(invalid);
  }

  await db.updatePassword(user.id, hashPassword(newPassword));
  await db.clearResetCode(user.id);          // single use
  await db.bumpTokenVersion(user.id);        // sign out everywhere: old tokens die now
  res.json({ ok: true });
});

// Sign out of every device: invalidates all tokens issued so far.
authRoutes.post('/logout-all', authRequired, async (req, res) => {
  await db.bumpTokenVersion(req.user!.id);
  res.json({ ok: true });
});
