/**
 * Telepathology Console — backend API.
 * ---------------------------------------------------------------------------
 * A small Express server, now backed by a real SQLite database (see db.js)
 * instead of a single JSON file. It handles:
 *   • sign-up / login for CHC lab attendants (see auth.js),
 *   • the patient "cases" submitted from the intake app,
 *   • a key/value store the Pathology Viewer uses for saved notes & annotations.
 *
 * Data layer (db.js) and security (auth.js) are kept in separate files so this
 * file stays a clean list of "which URL does what".
 */
import express from 'express';
import cors from 'cors';
import * as db from './db.js';
import { hashPassword, verifyPassword, signToken, authRequired, publicUser } from './auth.js';

db.migrateLegacyJson();   // bring across any existing data.json on first run

const app = express();
app.use(cors());                            // allow the browser apps to call this
app.use(express.json({ limit: '50mb' }));   // slide images arrive as large data-URLs

// ===== Authentication =======================================================
// Sign up: creates a lab-attendant account (name + CHC + email + password).
app.post('/api/auth/signup', (req, res) => {
  const { email, password, fullName, chcName } = req.body || {};
  if (!email || !password || !fullName || !chcName)
    return res.status(400).json({ error: 'Name, CHC, email and password are all required.' });
  if (String(password).length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.getUserByEmail(email))
    return res.status(409).json({ error: 'An account with this email already exists.' });

  const user = db.createUser({
    email: String(email).trim(),
    passwordHash: hashPassword(password),
    fullName: String(fullName).trim(),
    chcName: String(chcName).trim(),
  });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Log in: check the password, hand back a fresh token.
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.getUserByEmail(String(email || '').trim());
  if (!user || !verifyPassword(password || '', user.password_hash))
    return res.status(401).json({ error: 'Wrong email or password.' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Who am I? Lets the app restore the session on reload from its saved token.
app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: publicUser(req.user) }));

// Edit profile: update the signed-in attendant's name and CHC.
app.patch('/api/auth/profile', authRequired, (req, res) => {
  const { fullName, chcName } = req.body || {};
  if (!fullName || !String(fullName).trim() || !chcName || !String(chcName).trim())
    return res.status(400).json({ error: 'Name and CHC are required.' });
  const user = db.updateProfile(req.user.id, {
    fullName: String(fullName).trim(), chcName: String(chcName).trim(),
  });
  res.json({ user: publicUser(user) });
});

// Forgot password: with no email server available, we verify identity by
// matching the email + attendant name + CHC on the account, then set a new
// password. (A production system would instead email a one-time reset link.)
app.post('/api/auth/reset-password', (req, res) => {
  const { email, fullName, chcName, newPassword } = req.body || {};
  if (!email || !fullName || !chcName || !newPassword)
    return res.status(400).json({ error: 'All fields are required.' });
  if (String(newPassword).length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const user = db.getUserByEmail(String(email).trim());
  const norm = (s) => String(s).trim().toLowerCase();
  const matches = user
    && norm(user.full_name) === norm(fullName)
    && norm(user.chc_name) === norm(chcName);
  if (!matches)
    return res.status(400).json({ error: 'Those details do not match any account.' });
  db.updatePassword(user.id, hashPassword(newPassword));
  res.json({ ok: true });
});

// ===== Key/value store (Pathology Viewer notes & annotated images) ==========
app.get('/api/store/:key', (req, res) => res.json(db.getKV(req.params.key)));
app.put('/api/store/:key', (req, res) => { db.setKV(req.params.key, req.body); res.json({ ok: true }); });

// ===== Cases ================================================================
// List (metadata only — no images — so the queue loads fast).
app.get('/api/cases', (_req, res) => res.json(db.listCases()));

// One full case, including its slide image (fetched when a slide is opened).
app.get('/api/cases/:id', (req, res) => {
  const c = db.getCase(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

// Submit a new case — SIGN-IN REQUIRED. The attendant name and CHC are taken
// from the logged-in account (not trusted from the request), so every case is
// reliably stamped with who submitted it and from where.
app.post('/api/cases', authRequired, (req, res) => {
  const body = req.body || {};
  if (!body.patient || !String(body.patient).trim())
    return res.status(400).json({ error: 'Patient name is required.' });
  const id = db.createCase(body, req.user);
  res.json(db.getCaseMeta(id));
});

// Simple health/landing check
app.get('/', (_req, res) => res.send('Telepathology Console API is running.'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Telepathology API (SQLite) listening on http://localhost:${PORT}`));
