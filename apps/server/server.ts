/**
 * Telepathology Console — backend entry point.
 * ---------------------------------------------------------------------------
 * One Express server shared by BOTH front-ends: the CHC intake portal (lab
 * attendants submitting patients) and the pathology console (pathologists and
 * physicians reviewing them).
 *
 * THIS FILE IS ONLY WIRING. It creates the app, installs the middleware every
 * request passes through, mounts the routers, and starts listening. The
 * endpoints themselves live next door:
 *
 *   routes/auth.ts    sign-up, login, profile, password reset   → /api/auth
 *   routes/cases.ts   patients, notes, annotations, sign-off    → /api
 *   routes/slides.ts  whole-slide upload and status             → /api
 *                     Deep Zoom tiles                           → /slides
 *
 * and the pieces they share live in lib/:
 *
 *   lib/tiles.ts      slide storage, multer, the Python tile service
 *   lib/rate-limit.ts the in-memory request limiter
 *   lib/audit.ts      the audit-trail writer
 *
 * MIDDLEWARE ORDER MATTERS and is the reason this file exists at all: CORS and
 * the JSON body parser must be installed BEFORE any router, or requests reach
 * handlers without a parsed body and browsers reject the responses. Keeping
 * that sequence in one short file makes it hard to break by accident.
 *
 * Layering: db.ts owns all SQL, auth.ts owns passwords and tokens, the routers
 * own "which URL does what, and who is allowed to".
 *
 * Environment variables (all optional unless noted):
 *   PORT, TILE_PORT      — ports for this server and the tile service
 *   DATABASE_URL         — PostgreSQL connection string; REQUIRED
 *   JWT_SECRET           — token signing key; REQUIRED when NODE_ENV=production
 *   ALLOWED_ORIGINS      — comma-separated CORS allow-list
 *   UPLOADS_DIR          — relocate uploaded slides (the test suite uses this)
 *   BACKUP_DIR, BACKUP_KEEP, BACKUP_INTERVAL_MS
 *   AUTH_RATE_MAX, RESET_RATE_MAX — raise the limits for automated tests
 *   PYTHON               — python executable name, if not "python"
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
 *                        — send real password-reset emails; omit them all and
 *                          reset codes print to this console instead.
 *
 * Reads apps/server/.env on startup, if one exists (gitignored — see
 * .env.example for the full list with explanations).
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.ts';
import { authRequired } from './auth.ts';
import { isMailConfigured, verifyMailer } from './mailer.ts';
import { authRoutes } from './routes/auth.ts';
import { caseRoutes } from './routes/cases.ts';
import { slideRoutes, tileRoutes } from './routes/slides.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await db.failStaleProcessingSlides();  // no one is converting slides left over from a previous run

const app = express();

// --- CORS -------------------------------------------------------------------
// Only the front-ends may call this API from a browser. Previously this was a
// bare cors() (any origin), which meant any website a signed-in user visited
// could issue requests against the API with their session.
// ALLOWED_ORIGINS overrides the defaults when the apps run somewhere else.
//
// Vite picks the next FREE port when its preferred one is taken, so a second
// dev server lands on 5174, a third on 5175, and so on. Listing only a couple
// of ports meant a front-end that had shifted up was blocked by CORS — which
// surfaces in the browser as a bare "Failed to fetch", with nothing in the
// server log, and looks for all the world like the backend being down.
// Covering the range removes a confusing failure that costs an hour to
// diagnose. It is development-only: set ALLOWED_ORIGINS anywhere real and
// this list is not consulted at all.
const DEFAULT_ORIGINS = Array.from({ length: 16 }, (_, i) => 5173 + i)
  .flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const originAllowList = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : DEFAULT_ORIGINS;
app.use(cors({
  origin(origin, cb) {
    // A missing Origin means a non-browser caller (curl, a health check, the
    // test suite) — those aren't subject to the same-origin policy anyway.
    if (!origin || originAllowList.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} is not allowed by CORS.`));
  },
}));
app.use(express.json({ limit: '50mb' }));   // slide images arrive as large data-URLs

// --- Routes -----------------------------------------------------------------
// Mounted AFTER the middleware above, which is the whole reason the order in
// this file is worth protecting.
app.use('/api/auth', authRoutes);
app.use('/api', caseRoutes);
app.use('/api', slideRoutes);
app.use('/slides', tileRoutes);

// Simple health/landing check.
app.get('/', async (_req, res) => res.send('Telepathology Console API is running.'));

// ===== Backups ==============================================================
// This database holds every patient record, and uploads/ holds every slide.
// Without a copy, one disk failure loses all of it. A snapshot is taken at
// startup and then daily, keeping the most recent few.
//
// NOTE: these backups sit on the SAME disk, so they protect against
// accidental deletion and corruption, not against that disk dying. Copying
// BACKUP_DIR to another machine or drive is still needed for real safety.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 7);
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000);

async function runBackup(reason: string): Promise<void> {
  try {
    const { file, bytes } = await db.backupDatabase(BACKUP_DIR, BACKUP_KEEP);
    console.log(`[backup] ${reason}: ${path.basename(file)} (${(bytes / 1e6).toFixed(1)} MB, keeping ${BACKUP_KEEP})`);
  } catch (e) {
    console.error(`[backup] failed: ${(e as Error).message}`);
  }
}
void runBackup('startup');
setInterval(() => void runBackup('scheduled'), BACKUP_INTERVAL_MS).unref();

// Manual trigger, so a backup can be taken before anything risky.
app.post('/api/admin/backup', authRequired, async (_req, res) => {
  try {
    const result = await db.backupDatabase(BACKUP_DIR, BACKUP_KEEP);
    res.json({ ok: true, file: path.basename(result.file), bytes: result.bytes });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Telepathology API listening on http://localhost:${PORT}`));

// Confirm the SMTP credentials actually work RIGHT NOW, at boot, rather than
// leaving that discovery for whoever first requests a password reset. This
// only checks the connection — it sends nothing.
if (isMailConfigured) {
  verifyMailer().then(async (r) => {
    console.log(r.ok
      ? `Email: connected (SMTP_HOST=${process.env.SMTP_HOST}) — reset codes will be emailed.`
      : `Email: SMTP_HOST is set but the connection failed (${r.error}). Reset codes will NOT be sent until this is fixed — see apps/server/.env.example.`);
  });
} else {
  console.log('Email: not configured — reset codes will print to this console instead. See apps/server/.env.example to send real emails.');
}
