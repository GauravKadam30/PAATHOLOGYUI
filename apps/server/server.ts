/**
 * Telepathology Console — backend API.
 * ---------------------------------------------------------------------------
 * One Express server shared by BOTH front-ends: the CHC intake portal (lab
 * attendants submitting patients) and the pathology console (pathologists
 * reviewing them). It handles:
 *
 *   • Accounts — sign-up, login, password reset, token revocation (auth.js).
 *     One users table serves both apps; `role` is what keeps them apart, so
 *     the same person can hold a lab-attendant AND a pathologist account.
 *   • Cases — the patients submitted from intake, including archive/restore.
 *   • Notes & annotations — one row per case, NOT one blob for everybody
 *     (see db.js for why that distinction matters).
 *   • Whole-slide images — large scanner files streamed to disk, then served
 *     as zoomable tiles by a supervised Python child process.
 *   • Backups — a consistent database snapshot at startup and daily.
 *
 * Layering: db.js owns all SQL, auth.js owns passwords/tokens, and this file
 * stays a readable list of "which URL does what, and who is allowed to".
 *
 * Environment variables (all optional, sensible defaults for local use):
 *   PORT, TILE_PORT      — ports for this server and the tile service
 *   JWT_SECRET           — token signing key; REQUIRED when NODE_ENV=production
 *   ALLOWED_ORIGINS      — comma-separated CORS allow-list
 *   DATABASE_URL         — PostgreSQL connection string; REQUIRED
 *   UPLOADS_DIR          — relocate uploaded slides (the test suite uses this)
 *   BACKUP_DIR, BACKUP_KEEP, BACKUP_INTERVAL_MS
 *   PYTHON               — python executable name, if not "python"
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM
 *                        — send real password-reset emails (see mailer.js and
 *                          .env.example); omit all of these and reset codes
 *                          print to this console instead, unchanged from before.
 *
 * Reads apps/server/.env on startup, if one exists (gitignored — see
 * .env.example for the template). Nothing about deployment depends on this;
 * it's just a convenient place to keep local SMTP credentials instead of
 * exporting them into the shell by hand every time.
 */
import 'dotenv/config';
import express, { type RequestHandler, type Request } from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import * as db from './db.ts';
import { NOTE_WRITERS, type Role } from './types.ts';
import {
  hashPassword, verifyPassword, signToken, authRequired, publicUser,
  generateResetCode, hashResetCode, verifyResetCode,
} from './auth.ts';
import { isMailConfigured, sendResetCodeEmail, verifyMailer } from './mailer.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await db.failStaleProcessingSlides();  // no one is converting slides left over from a previous run

const app = express();

// --- CORS -------------------------------------------------------------------
// Only the two front-ends may call this API from a browser. Previously this
// was a bare cors() (any origin), which meant any website a signed-in user
// visited could issue requests against the API with their session.
// ALLOWED_ORIGINS overrides the defaults when the apps run somewhere else.
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
    // No Origin header = same-origin, curl, or a native app — not a browser
    // cross-site request, so there's nothing for CORS to protect against.
    if (!origin) return cb(null, true);
    if (originAllowList.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  },
}));

app.use(express.json({ limit: '50mb' }));   // slide images arrive as large data-URLs

// --- Rate limiting ----------------------------------------------------------
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
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: AUTH_RATE_MAX });
const resetLimiter = rateLimit({ windowMs: 15 * 60_000, max: RESET_RATE_MAX });
const uploadLimiter = rateLimit({ windowMs: 60 * 60_000, max: 30 }); // slide uploads

// ===== Whole-slide images (WSI) =============================================
// Scanner slides (.tiff/.svs/...) are gigapixel-scale, so they are NOT stored
// in the database like ordinary PNG/JPG cases. Instead the uploaded file is
// kept on disk under uploads/<caseId>/, and a small Python helper
// (tools/tile_server.py) reads Deep Zoom tiles out of it on demand — see that
// file for why tiles are served live rather than pre-generated.
// Overridable so the automated tests write slides to a throwaway directory.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const TILE_PORT = Number(process.env.TILE_PORT || 3002);
const TILE_BASE = `http://127.0.0.1:${TILE_PORT}`;
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// File extensions OpenSlide can read. Anything else keeps using the old
// data-URL path (a plain photo of a slide, as before).
const SLIDE_EXTENSIONS = new Set(['.tiff', '.tif', '.svs', '.ndpi', '.scn', '.mrxs', '.vms', '.vmu', '.bif']);
export const isSlideFile = (filename: string) => SLIDE_EXTENSIONS.has(path.extname(String(filename)).toLowerCase());

// Start the tile server as a child process and keep it alive for as long as
// this server runs. It binds to 127.0.0.1 only; browsers reach it through the
// /slides/* proxy below, so there is just one public origin to configure.
// The tile service is supervised: if it dies (crash, OOM, killed) it is
// respawned automatically, because otherwise every whole-slide view stays
// broken until someone notices and restarts the whole backend. Restarts back
// off up to a ceiling so a genuinely broken install doesn't spin in a tight
// loop, and the counter resets once a process has stayed up a while.
let tileProc: ChildProcess | null = null;
let tileShuttingDown = false;
let tileRestarts = 0;
const TILE_RESTART_BASE_MS = 1000;
const TILE_RESTART_MAX_MS = 30_000;
const TILE_HEALTHY_MS = 60_000;   // uptime after which we treat it as stable

function startTileServer() {
  if (tileShuttingDown) return;
  const script = path.join(__dirname, 'tools', 'tile_server.py');
  const python = process.env.PYTHON || 'python';
  const startedAt = Date.now();

  tileProc = spawn(python, [script, UPLOADS_DIR, String(TILE_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  tileProc.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  tileProc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[tiles] ${d}`));

  tileProc.on('error', (e: Error) => {
    console.error(`[tiles] could not start Python tile server (${e.message}).`);
    console.error('[tiles] Whole-slide (.tiff) viewing is unavailable; ordinary image cases still work.');
  });

  tileProc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    tileProc = null;
    if (tileShuttingDown) return;                  // we killed it on purpose
    if (Date.now() - startedAt > TILE_HEALTHY_MS) tileRestarts = 0;

    const delay = Math.min(TILE_RESTART_BASE_MS * 2 ** tileRestarts, TILE_RESTART_MAX_MS);
    tileRestarts++;
    console.error(`[tiles] exited (code=${code} signal=${signal}); restarting in ${delay}ms (attempt ${tileRestarts})`);
    setTimeout(startTileServer, delay).unref();
  });
}
startTileServer();
// Don't leave an orphaned Python process behind when this server stops.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    tileShuttingDown = true;                       // stop the supervisor respawning it
    try { tileProc?.kill(); } catch { /* already gone */ }
    process.exit(0);
  });
}
process.on('exit', () => {
  tileShuttingDown = true;
  try { tileProc?.kill(); } catch { /* already gone */ }
});

// Public tile routes — proxied straight through to the Python helper so the
// browser only ever talks to this server (no second port, no extra CORS).
app.get('/slides/:caseId/*', authRequired, async (req, res) => {
  try {
    const upstream = await fetch(`${TILE_BASE}${req.originalUrl}`);
    res.status(upstream.status);
    const type = upstream.headers.get('content-type');
    const cache = upstream.headers.get('cache-control');
    if (type) res.set('Content-Type', type);
    if (cache) res.set('Cache-Control', cache);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(503).json({ error: 'Slide tile service is unavailable.' });
  }
});

// Multer writes the upload straight to disk in chunks. Sending a 1 GB+ slide
// as base64 JSON (the old path) would balloon it by ~33% and buffer the whole
// thing in memory; this streams it instead. The destination needs the case id,
// which is why uploading a slide is its own request against an already-created
// case (POST /api/cases/:id/slide) rather than one combined submission.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOADS_DIR, String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    // Keep only the extension — OpenSlide picks its reader from that, and it
    // avoids trusting a client-supplied filename as a path.
    filename: (_req, file, cb) => cb(null, `slide${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 * 1024 },   // 20 GB ceiling
});

// ===== Authentication =======================================================
// Both the CHC intake portal and the pathology console share this same
// users table and these same routes — `role` is what keeps the two account
// types apart. `chcName` only makes sense for a lab attendant (it's their
// health centre); a pathologist isn't tied to one, so it's just stored empty.
const ROLES: Role[] = ['lab_attendant', 'pathologist', 'physician'];

// Sign up: creates an account. Lab attendants also give their CHC name;
// pathologists just give a name, email and password.
app.post('/api/auth/signup', authLimiter, async (req, res) => {
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
app.post('/api/auth/login', authLimiter, async (req, res) => {
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
app.get('/api/auth/me', authRequired, async (req, res) => res.json({ user: publicUser(req.user!) }));

// Edit profile: update the signed-in attendant's name and CHC.
app.patch('/api/auth/profile', authRequired, async (req, res) => {
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

app.post('/api/auth/request-reset', resetLimiter, async (req, res) => {
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

app.post('/api/auth/reset-password', resetLimiter, async (req, res) => {
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
app.post('/api/auth/logout-all', authRequired, async (req, res) => {
  await db.bumpTokenVersion(req.user!.id);
  res.json({ ok: true });
});

// ===== Key/value store ======================================================
// Only still used for the legacy annotated-image fallback. Notes and
// annotations moved to their own per-case routes below, because writing them
// as one blob per key meant simultaneous saves overwrote each other.
app.get('/api/store/:key', authRequired, async (req, res) => res.json(await db.getKV(String(req.params.key))));
app.put('/api/store/:key', authRequired, async (req, res) => { await db.setKV(String(req.params.key), req.body); res.json({ ok: true }); });

// ===== Notes & annotations (per case) =======================================
// Reads stay bulk (cheap, and the dashboard wants everything at once); it is
// only the WRITES that had to become per-row to be safe under concurrency.
app.get('/api/notes', authRequired, async (_req, res) => res.json(await db.getAllNotes()));
app.get('/api/annotations', authRequired, async (_req, res) => res.json(await db.getAllAnnotations()));

// Save ONE note on ONE case. Touches a single row, so a colleague saving a
// different case at the same moment can't clobber it.
app.put('/api/cases/:id/notes/:kind', authRequired, async (req, res) => {
  const id = String(req.params.id);
  const kind = String(req.params.kind);
  if (!db.NOTE_KINDS.includes(kind))
    return res.status(400).json({ error: `Unknown note type "${kind}".` });

  // A pathologist writes the microscopic findings; a physician writes the
  // prescription. Splitting them is the point of having both roles, so it is
  // enforced HERE and not only by disabling a textarea — the UI is a courtesy,
  // this is the actual rule.
  const allowed = NOTE_WRITERS[kind] ?? [];
  if (!allowed.includes(req.user!.role as Role)) {
    return res.status(403).json({
      error: `A ${req.user!.role.replace('_', ' ')} account cannot write the ${kind} note.`,
    });
  }

  if (!await db.getCaseMeta(id)) return res.status(404).json({ error: 'Case not found.' });
  const body = typeof req.body?.body === 'string' ? req.body.body : '';
  await db.setNote(id, kind, body, req.user!.id);
  audit(req, 'note.save', id, kind);
  res.json({ ok: true });
});

app.put('/api/cases/:id/annotations', authRequired, async (req, res) => {
  const id = String(req.params.id);
  // Marking up the slide is the pathologist's examination. A physician reads
  // those marks to prescribe, but does not add their own.
  if (req.user!.role !== 'pathologist')
    return res.status(403).json({ error: 'Only a pathologist can annotate a slide.' });
  if (!await db.getCaseMeta(id)) return res.status(404).json({ error: 'Case not found.' });
  await db.setAnnotations(id, req.body ?? {}, req.user!.id);
  audit(req, 'annotation.save', id);
  res.json({ ok: true });
});

// --- Audit trail --------------------------------------------------------------
/**
 * Record one action against the audit log.
 *
 * WHAT IS AND IS NOT LOGGED. Every write is recorded, plus OPENING a specific
 * case. The worklist poll is NOT: it runs every four seconds per signed-in
 * user, which would add roughly 900 rows an hour of pure noise and bury the
 * entries that matter. "Who opened this patient's record" is answerable from
 * case.view; "who listed the queue" is not worth the volume.
 *
 * Fire-and-forget by design — writeAudit swallows its own failures, so a
 * clinical save never fails because the log was unavailable.
 */
function audit(req: Request, action: string, caseId?: number | string | null, detail?: string): void {
  void db.writeAudit({
    userId: req.user?.id ?? null,
    userName: req.user?.full_name ?? null,
    userRole: req.user?.role ?? null,
    action,
    caseId: caseId == null ? null : Number(caseId),
    detail: detail ?? null,
    // Behind a reverse proxy this is the proxy unless `trust proxy` is set.
    // Recorded as Express reports it rather than trusting a client header.
    ip: req.ip ?? null,
  });
}

// ===== Cases ================================================================
// List (metadata only — no images — so the queue loads fast).
// `?since=<iso>` returns only cases changed since then, so the worklist can
// poll for changes rather than re-downloading everything every few seconds.
// `?includeArchived=1` brings back soft-deleted cases.
app.get('/api/cases', authRequired, async (req, res) => res.json(await db.listCases({
  since: typeof req.query.since === 'string' ? req.query.since : null,
  includeArchived: req.query.includeArchived === '1',
})));

// One full case, including its slide image (fetched when a slide is opened).
app.get('/api/cases/:id', authRequired, async (req, res) => {
  const c = await db.getCase(String(req.params.id));
  if (!c) return res.status(404).json({ error: 'not found' });
  // Fetching ONE case is a person opening a patient's record — the read worth
  // recording. The worklist poll is not audited; see the note on `audit`.
  audit(req, 'case.view', c.id);
  res.json(c);
});

/**
 * The history of one case: who viewed, edited and signed it.
 *
 * Read-only, and there is no endpoint that edits or deletes audit rows — the
 * trail is append-only by design.
 */
app.get('/api/cases/:id/audit', authRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad case id.' });
  res.json(await db.readAudit({ caseId: id, limit: Number(req.query.limit) || 100 }));
});

// Submit a new case — SIGN-IN REQUIRED, and only a lab attendant account may
// do it (a pathologist has no CHC to stamp the case with). The attendant name
// and CHC are taken from the logged-in account (not trusted from the
// request), so every case is reliably stamped with who submitted it and from where.
app.post('/api/cases', authRequired, async (req, res) => {
  if (req.user!.role !== 'lab_attendant')
    return res.status(403).json({ error: 'Only a CHC lab attendant account can submit a case.' });
  const body = req.body || {};
  if (!body.patient || !String(body.patient).trim())
    return res.status(400).json({ error: 'Patient name is required.' });

  // The CHC Patient ID is meant to identify exactly one patient, and the
  // worklist's search relies on that. A repeat almost always means a typo or a
  // duplicate submission, so it's rejected here with the clashing patient
  // named — far easier to fix now than after two records have diverged.
  if (body.chcId && String(body.chcId).trim()) {
    const clash = await db.findCaseByChcId(body.chcId, req.user!.chc_name);
    if (clash) {
      return res.status(409).json({
        error: `CHC Patient ID "${String(body.chcId).trim()}" is already used by "${clash.patient}" (case ${clash.id}). Please check the ID.`,
      });
    }
  }

  const id = await db.createCase(body, req.user!);
  res.json(await db.getCaseMeta(id));
});

// Archive / restore a case (soft delete). The record and any slide file stay
// on disk — clinical data is rarely safe to destroy — the case simply stops
// appearing in the worklist, and can be brought back.
// Sign off the report. This is the end of the clinical workflow: the physician
// has read the pathologist's findings, recorded a prescription, and is now
// putting their name to it. The case leaves the pending worklist.
//
// Restricted to physicians for the same reason the note kinds are split — the
// person who prescribes is the person who signs.
app.post('/api/cases/:id/sign', authRequired, async (req, res) => {
  if (req.user!.role !== 'physician')
    return res.status(403).json({ error: 'Only a physician can sign and submit a report.' });

  const id = String(req.params.id);
  const existing = await db.getCaseMeta(id);
  if (!existing) return res.status(404).json({ error: 'Case not found.' });
  if (existing.reportedAt)
    return res.status(409).json({ error: 'This report has already been signed.' });

  audit(req, 'report.sign', id);
  res.json(await db.signCaseReport(id, req.user!.id));
});

app.patch('/api/cases/:id/archived', authRequired, async (req, res) => {
  const existing = await db.getCaseMeta(String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Case not found.' });
  const archived = req.body?.archived !== false;
  audit(req, archived ? 'case.archive' : 'case.restore', String(req.params.id));
  res.json(await db.setCaseArchived(String(req.params.id), archived));
});

// Attach a whole-slide file (.tiff/.svs/...) to a case that was just created.
// Split out from POST /api/cases because the file is written straight to
// uploads/<caseId>/ as it streams in, so the case id has to exist first.
app.post('/api/cases/:id/slide', authRequired, uploadLimiter, async (req, res, next) => {
  // Guard BEFORE multer runs, so a bad request never writes a large file to disk.
  if (req.user!.role !== 'lab_attendant')
    return res.status(403).json({ error: 'Only a CHC lab attendant account can upload a slide.' });
  const existing = await db.getCaseMeta(String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Case not found.' });
  await db.setSlidePending(String(req.params.id), null);   // queue shows "Processing slide…" while it uploads
  next();
}, upload.single('slide'), async (req, res) => {
  const id = String(req.params.id);
  if (!req.file) {
    await db.setSlideFailed(id, 'No slide file was received.');
    return res.status(400).json({ error: 'No slide file was received.' });
  }
  if (!isSlideFile(req.file.originalname)) {
    fs.rm(req.file.path, { force: true }, () => {});
    await db.setSlideFailed(id, 'Unsupported slide format.');
    return res.status(400).json({ error: 'Unsupported slide format. Expected .tiff, .svs, .ndpi or similar.' });
  }

  const file = req.file;
  await db.setSlidePending(id, file.path);

  // Confirm the tile service can actually open it before telling the
  // pathologist it's ready — a truncated or unreadable upload should surface
  // here, not as a broken viewer later. Fetching the .dzi forces OpenSlide to
  // parse the file's structure.
  fetch(`${TILE_BASE}/slides/${id}/slide.dzi`)
    .then(async (r) => {
      if (r.ok) {
        await db.setSlideReady(id, `/slides/${id}/slide.dzi`);
        console.log(`[slide] case ${id} ready (${file.filename}, ${(file.size / 1e9).toFixed(2)} GB)`);
      } else {
        await db.setSlideFailed(id, 'The uploaded file could not be read as a slide image.');
      }
    })
    .catch(() => db.setSlideFailed(id, 'Slide tile service is unavailable.'));

  res.json(await db.getCaseMeta(id));
});

// Poll target for the intake app + pathology queue: how far along is this
// case's slide? Cheap enough to call every few seconds.
app.get('/api/cases/:id/slide-status', authRequired, async (req, res) => {
  const c = await db.getCaseMeta(String(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  res.json({ id: c.id, slideStatus: c.slideStatus, dziUrl: c.dziUrl, slideError: c.slideError });
});

// Simple health/landing check
app.get('/', async (_req, res) => res.send('Telepathology Console API is running.'));

// ===== Backups ==============================================================
// This database holds every patient record, and uploads/ holds every slide.
// Without a copy, one disk failure loses all of it. A snapshot is taken at
// startup and then daily, keeping the most recent few.
//
// VACUUM INTO (see db.backupDatabase) is used rather than copying data.db,
// because in WAL mode the live file alone is not a consistent snapshot — some
// committed data may still be sitting in data.db-wal.
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
