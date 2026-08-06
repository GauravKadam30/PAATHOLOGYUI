/**
 * db.js — the data layer. All SQL in the project lives here.
 * ---------------------------------------------------------------------------
 * SQLite, built into Node — no separate database server to install or run.
 * Everything lives in one file, data.db, beside this script (override with
 * DB_FILE; the test suite uses that to work on a throwaway copy).
 *
 * THE TABLES
 *   users            accounts for both apps. UNIQUE(email, role) — not
 *                    UNIQUE(email) — so one person can hold a lab-attendant
 *                    account AND a pathologist account under one address.
 *   cases            one patient submission. Ordinary photos are stored inline
 *                    as a data-URL in `image`; scanner slides are far too big
 *                    for that, so only their path on disk is kept here.
 *   case_notes       one row per (case, kind) — see WHY below.
 *   case_annotations one row per case, holding vector marks as JSON.
 *   reset_codes      short-lived, hashed, single-use password reset codes.
 *   kv               legacy key/value store, now only holding old flattened
 *                    annotation images that predate case_annotations.
 *
 * WHY NOTES GET THEIR OWN ROWS (the important design point): these were
 * originally kept as one JSON blob per note kind — every patient's clinical
 * notes in a single value. Saving one patient rewrote all of them, so two
 * people saving at the same moment silently destroyed one of the two sets of
 * notes. One row per case makes a save touch exactly one row, and the
 * conflict disappears. `migrateNotesToRows` moves any old blob data across.
 *
 * MIGRATIONS run automatically at startup and are all idempotent — safe to
 * run on every boot, whether the database is brand new or years old. SQLite
 * has no "ADD COLUMN IF NOT EXISTS", so they inspect the live schema first.
 *
 * The rest of the app never writes SQL; it calls the functions exported here.
 * That keeps a future move to PostgreSQL confined to this one file.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_FILE is overridable so the automated tests can run against a throwaway
// database instead of the real one — without it, a test run would write to
// live patient data.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.db');
const LEGACY_JSON = path.join(__dirname, 'data.json');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');   // write-ahead logging: safer + better concurrency

// --- Schema (created once; "IF NOT EXISTS" makes startup idempotent) ---------
// `UNIQUE(email, role)` — NOT a plain UNIQUE on email — is what lets the same
// person hold both a lab-attendant account (CHC intake) and a pathologist
// account (Pathology Console) under one email: two separate rows, one per
// role, only clashing if the SAME role tries to reuse that email twice.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL COLLATE NOCASE,          -- login id, case-insensitive
  password_hash TEXT NOT NULL,                          -- never the raw password
  full_name     TEXT NOT NULL,                          -- lab attendant's / pathologist's name
  chc_name      TEXT NOT NULL,                          -- health-centre name (empty for non-CHC roles)
  role          TEXT NOT NULL DEFAULT 'lab_attendant',
  created_at    TEXT NOT NULL,
  UNIQUE (email, role)
);

CREATE TABLE IF NOT EXISTS cases (
  id          INTEGER PRIMARY KEY,     -- stays in the 100+ range like before
  patient     TEXT NOT NULL,
  age         TEXT,
  gender      TEXT,
  site        TEXT,
  status      TEXT,
  date        TEXT,
  image       TEXT,                    -- the slide photo as a data-URL
  attendant   TEXT,                    -- who submitted it (copied from their account)
  chc_name    TEXT,                    -- which CHC it came from (copied from their account)
  consultant  TEXT,                    -- consultant name (from the intake form)
  notes       TEXT,                    -- OPD prescription & notes
  abha        TEXT,
  nikshay     TEXT,
  chc_id      TEXT,
  created_by  INTEGER,                 -- users.id of the submitter
  created_at  TEXT,
  -- Whole-slide image (WSI) support. A scanner .tiff/.svs is far too large to
  -- keep inline in the "image" column as a data-URL, so instead:
  --   slide_path   -> the original uploaded file on disk
  --   dzi_path     -> the Deep Zoom descriptor (web path, e.g.
  --                   /slides/102/slide.dzi) OpenSeadragon streams tiles from
  --   slide_status -> 'processing' while the upload/validation runs, then
  --                   'ready' or 'failed'. Plain PNG/JPG cases leave this NULL
  --                   and keep using the "image" column exactly as before.
  slide_path   TEXT,
  dzi_path     TEXT,
  slide_status TEXT,
  slide_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status);

-- Key/value table backing /api/store/:key. This USED to hold every patient's
-- notes and annotations as one giant JSON blob per key, which meant saving one
-- patient rewrote the whole blob — two people saving at once silently lost one
-- of the two saves. Notes and annotations now live in their own per-case
-- tables below; kv is kept only for the legacy annotated-image fallback.
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per (case, kind) instead of one blob for everybody. A save now
-- touches exactly one row, so concurrent saves on different cases — or even
-- different note kinds on the same case — cannot overwrite each other.
CREATE TABLE IF NOT EXISTS case_notes (
  case_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,          -- 'clinical' | 'pathologist' | 'medicine'
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER,                -- users.id of whoever saved it
  PRIMARY KEY (case_id, kind)
);

-- Same reasoning for annotations: one row per case, holding the vector marks.
CREATE TABLE IF NOT EXISTS case_annotations (
  case_id    INTEGER PRIMARY KEY,
  data       TEXT NOT NULL,          -- fabric JSON, in image coordinates
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);

-- Short-lived, single-use password reset codes. The code itself is stored
-- HASHED, exactly like a password, so a leaked database still doesn't hand
-- anyone a working reset.
CREATE TABLE IF NOT EXISTS reset_codes (
  user_id    INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,       -- epoch ms
  attempts   INTEGER NOT NULL DEFAULT 0
);
`);

// --- Users -------------------------------------------------------------------
// Any account with this email, regardless of role — used only where the
// caller doesn't yet know (or care) which portal's account it wants.
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email));
}
// The one account for this (email, role) pair. Since the same email can now
// have a separate account per role, this — not getUserByEmail — is what
// signup/login actually use to find "the" account for their own portal.
export function getUserByEmailAndRole(email, role) {
  return db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(String(email), role);
}
export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function createUser({ email, passwordHash, fullName, chcName, role = 'lab_attendant' }) {
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, full_name, chc_name, role, created_at) VALUES (?,?,?,?,?,?)'
  ).run(email, passwordHash, fullName, chcName, role, new Date().toISOString());
  return getUserById(info.lastInsertRowid);
}
// Update the attendant's name and CHC (from the "Edit profile" dialog).
export function updateProfile(id, { fullName, chcName }) {
  db.prepare('UPDATE users SET full_name = ?, chc_name = ? WHERE id = ?').run(fullName, chcName, id);
  return getUserById(id);
}
// Set a new password (used by the "Forgot password" reset flow).
export function updatePassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

// --- Cases -------------------------------------------------------------------
// The queue list is metadata only (NO image column) so it loads fast even with
// thousands of slides; the big image is fetched per-case when a slide is opened.
// `since` (an ISO timestamp) returns only cases changed after that moment, so
// the worklist can poll for changes instead of re-downloading everything.
// Archived cases are excluded unless explicitly asked for.
export function listCases({ since, includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (!includeArchived) where.push('archived = 0');
  if (since) { where.push('updated_at > ?'); params.push(String(since)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT id, patient, age, gender, site, status, date, attendant, chc_name, consultant, notes, chc_id,
           dzi_path, slide_status, slide_error, archived, updated_at,
           (image IS NOT NULL AND image != '') AS hasImage
    FROM cases ${clause} ORDER BY id
  `).all(...params).map((r) => ({
    id: r.id, patient: r.patient, age: r.age, gender: r.gender, site: r.site,
    status: r.status, date: r.date, attendant: r.attendant, chcName: r.chc_name,
    consultant: r.consultant, notes: r.notes, chcId: r.chc_id, hasImage: !!r.hasImage,
    // Whole-slide fields — null on ordinary PNG/JPG cases, so the viewer
    // falls back to its existing flat-image path for those.
    dziUrl: r.dzi_path ?? null, slideStatus: r.slide_status ?? null, slideError: r.slide_error ?? null,
    // `updatedAt` is what makes incremental polling possible: the client
    // remembers the newest value it has seen and asks only for later changes.
    archived: !!r.archived, updatedAt: r.updated_at ?? null,
  }));
}

function remapCase(r) {
  if (!r) return null;
  return {
    id: r.id, patient: r.patient, age: r.age, gender: r.gender, site: r.site,
    status: r.status, date: r.date, image: r.image ?? null,
    attendant: r.attendant, chcName: r.chc_name, consultant: r.consultant,
    notes: r.notes, abha: r.abha, nikshay: r.nikshay, chcId: r.chc_id,
    dziUrl: r.dzi_path ?? null, slideStatus: r.slide_status ?? null, slideError: r.slide_error ?? null,
    archived: !!r.archived, updatedAt: r.updated_at ?? null,
    hasImage: !!(r.image && r.image !== ''),
  };
}
export function getCase(id) {                       // full record, including the image
  return remapCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(id));
}
export function getCaseMeta(id) {                   // same but without the (large) image
  const c = getCase(id);
  if (!c) return null;
  const { image, ...meta } = c;
  return meta;
}
export function createCase(data, user) {
  // Next id continues from the highest existing one, starting at 100 so it never
  // clashes with the viewer's built-in demo patients (ids 1–3).
  const nextId = (db.prepare('SELECT MAX(id) AS m FROM cases').get().m || 99) + 1;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cases
      (id, patient, age, gender, site, status, date, image, attendant, chc_name,
       consultant, notes, abha, nikshay, chc_id, created_by, created_at, updated_at, archived)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
  `).run(
    nextId, String(data.patient).trim(), String(data.age ?? ''), data.gender ?? '',
    data.site ?? 'Lymph Node', data.status ?? 'Pending', data.date ?? now.slice(0, 10),
    data.image ?? null,
    // attendant + CHC come from the SIGNED-IN user, never trusted from the client
    user.full_name, user.chc_name,
    data.consultant ?? '', data.notes ?? '', data.abha ?? '', data.nikshay ?? '',
    data.chcId ?? '', user.id, now, now,
  );
  return nextId;
}

// Attach an uploaded whole-slide file to a case and mark it as processing.
// Called right after the upload lands, BEFORE tile generation starts — so the
// pathologist's queue immediately shows "Processing slide…" rather than an
// empty row that silently fills in later.
export function setSlidePending(id, slidePath) {
  db.prepare("UPDATE cases SET slide_path = ?, slide_status = 'processing', slide_error = NULL WHERE id = ?")
    .run(slidePath, id);
  touchCase(id);
}
// Tile generation finished: record where the .dzi lives and flip to 'ready'.
export function setSlideReady(id, dziPath) {
  db.prepare("UPDATE cases SET dzi_path = ?, slide_status = 'ready', slide_error = NULL WHERE id = ?")
    .run(dziPath, id);
  touchCase(id);
}
// Tile generation failed: keep the reason so the UI can show something useful
// instead of a case stuck on "processing" forever.
export function setSlideFailed(id, message) {
  db.prepare("UPDATE cases SET slide_status = 'failed', slide_error = ? WHERE id = ?")
    .run(String(message || 'Slide conversion failed.').slice(0, 500), id);
  touchCase(id);
}
// On startup, any case left mid-conversion belongs to a server that died
// (crash, Ctrl-C, restart during processing). Nothing is generating tiles for
// it any more, so mark it failed rather than leaving it spinning forever.
export function failStaleProcessingSlides() {
  const r = db.prepare("UPDATE cases SET slide_status = 'failed', slide_error = 'Server restarted during slide processing — please re-upload.' WHERE slide_status = 'processing'").run();
  if (r.changes) console.log(`Marked ${r.changes} interrupted slide conversion(s) as failed.`);
}

// --- Key/value store ---------------------------------------------------------
export function getKV(key) {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : {};
}
export function setKV(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// --- Notes (one row per case + kind) ----------------------------------------
export const NOTE_KINDS = ['clinical', 'pathologist', 'medicine'];

// Save ONE note. This is the whole point of the per-case table: the write
// touches a single row, so a colleague saving a different case (or a different
// note on the same case) at the same moment cannot overwrite it.
export function setNote(caseId, kind, body, userId) {
  if (!NOTE_KINDS.includes(kind)) throw new Error(`unknown note kind: ${kind}`);
  db.prepare(`
    INSERT INTO case_notes (case_id, kind, body, updated_at, updated_by)
    VALUES (?,?,?,?,?)
    ON CONFLICT(case_id, kind) DO UPDATE SET
      body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(Number(caseId), kind, String(body ?? ''), new Date().toISOString(), userId ?? null);
  touchCase(caseId);
}

// All notes, shaped as { caseId: { clinical, pathologist, medicine } }. Reading
// in bulk is safe — it's only the WRITES that had to become per-row — so the
// dashboard can still load everything in one request.
export function getAllNotes() {
  const out = {};
  for (const r of db.prepare('SELECT case_id, kind, body FROM case_notes').all()) {
    (out[r.case_id] ||= {})[r.kind] = r.body;
  }
  return out;
}

// --- Annotations (one row per case) -----------------------------------------
export function setAnnotations(caseId, data, userId) {
  db.prepare(`
    INSERT INTO case_annotations (case_id, data, updated_at, updated_by)
    VALUES (?,?,?,?)
    ON CONFLICT(case_id) DO UPDATE SET
      data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(Number(caseId), JSON.stringify(data ?? {}), new Date().toISOString(), userId ?? null);
  touchCase(caseId);
}

export function getAllAnnotations() {
  const out = {};
  for (const r of db.prepare('SELECT case_id, data FROM case_annotations').all()) {
    try { out[r.case_id] = JSON.parse(r.data); } catch { /* skip corrupt row */ }
  }
  return out;
}

// --- Case lifecycle ----------------------------------------------------------
// Mark a case as changed so incremental polling picks it up.
export function touchCase(caseId) {
  db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), Number(caseId));
}

// Soft delete. The row and its slide file stay on disk; the case just stops
// appearing in the worklist. Clinical records are rarely safe to destroy, and
// this keeps a mistaken archive recoverable.
export function setCaseArchived(caseId, archived) {
  db.prepare('UPDATE cases SET archived = ?, updated_at = ? WHERE id = ?')
    .run(archived ? 1 : 0, new Date().toISOString(), Number(caseId));
  return getCaseMeta(caseId);
}

// Is this CHC Patient ID already used at this health centre? The ID is meant
// to identify one patient, and the worklist search relies on that, so a
// duplicate is almost always a typo worth catching at submit time.
export function findCaseByChcId(chcId, chcName) {
  const id = String(chcId ?? '').trim();
  if (!id) return null;
  return db.prepare(
    'SELECT id, patient FROM cases WHERE chc_id = ? AND chc_name = ? AND archived = 0'
  ).get(id, String(chcName ?? ''));
}

// --- Token revocation --------------------------------------------------------
// Bumping the version invalidates every token already issued for that account.
export function bumpTokenVersion(userId) {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId);
  return getUserById(userId);
}

// --- Password reset codes ----------------------------------------------------
export function storeResetCode(userId, codeHash, expiresAt) {
  db.prepare(`
    INSERT INTO reset_codes (user_id, code_hash, expires_at, attempts) VALUES (?,?,?,0)
    ON CONFLICT(user_id) DO UPDATE SET
      code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0
  `).run(userId, codeHash, expiresAt);
}
export function getResetCode(userId) {
  return db.prepare('SELECT * FROM reset_codes WHERE user_id = ?').get(userId);
}
export function bumpResetAttempts(userId) {
  db.prepare('UPDATE reset_codes SET attempts = attempts + 1 WHERE user_id = ?').run(userId);
}
export function clearResetCode(userId) {
  db.prepare('DELETE FROM reset_codes WHERE user_id = ?').run(userId);
}

// --- Backups -----------------------------------------------------------------
// SQLite's own online backup: produces a consistent copy even while the server
// is mid-write, which a plain file copy of a WAL-mode database does not.
// Older backups beyond `keep` are pruned so this can run unattended.
export function backupDatabase(dir, keep = 7) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `data-${stamp}.db`);

  // VACUUM INTO writes a compact, fully-consistent snapshot in one statement.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  const backups = fs.readdirSync(dir)
    .filter((f) => /^data-.*\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of backups.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, old)); } catch { /* already gone */ }
  }
  return { file: target, bytes: fs.statSync(target).size, kept: Math.min(backups.length, keep) };
}

// --- One-time migration from the old data.json ------------------------------
// If the database is empty but an old data.json exists, import its patients and
// saved notes so no existing data is lost, then rename the file so it won't run
// again. Wrapped in a transaction: it's all-or-nothing.
export function migrateLegacyJson() {
  const caseCount = db.prepare('SELECT COUNT(*) AS c FROM cases').get().c;
  const kvCount = db.prepare('SELECT COUNT(*) AS c FROM kv').get().c;
  if (caseCount > 0 || kvCount > 0) return;      // already has data — nothing to do
  if (!fs.existsSync(LEGACY_JSON)) return;

  let data;
  try { data = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8')); }
  catch { return; }                              // unreadable/corrupt — skip safely

  const insCase = db.prepare(`
    INSERT INTO cases (id, patient, age, gender, site, status, date, image,
                       attendant, chc_name, consultant, notes, abha, nikshay, chc_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  db.exec('BEGIN');
  try {
    for (const c of (Array.isArray(data.__cases) ? data.__cases : [])) {
      insCase.run(
        c.id, c.patient, String(c.age ?? ''), c.gender ?? '', c.site ?? '',
        c.status ?? 'Pending', c.date ?? '', c.image ?? null,
        c.attendant ?? '', c.chcName ?? c.chc_name ?? '', c.consultant ?? '',
        c.notes ?? '', c.abha ?? '', c.nikshay ?? '', c.chcId ?? '', new Date().toISOString(),
      );
    }
    for (const [k, v] of Object.entries(data)) {
      if (k === '__cases') continue;
      setKV(k, v);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Migration failed, left data.json untouched:', e.message);
    return;
  }
  try { fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.migrated'); } catch { /* ignore */ }
  console.log('Migrated existing data.json into the SQLite database.');
}

// --- One-time migration: allow the same email under different roles --------
// A database created before this feature has the OLD single-column
// `UNIQUE(email)` constraint, which would still reject a pathologist signup
// reusing a CHC-intake email. SQLite can't just "drop a constraint" on an
// existing column, so this rebuilds the table — new schema, same rows —
// wrapped in a transaction so it's all-or-nothing. Detected by checking for
// a unique index that covers ONLY `email` (the old constraint); the new
// composite UNIQUE(email, role) index doesn't match that shape, so a
// database already migrated (or created fresh with the new schema) is left
// alone.
// --- One-time migration: add the whole-slide-image columns -----------------
// `CREATE TABLE IF NOT EXISTS` above only shapes a BRAND-NEW database, so an
// existing data.db (created before WSI support) still lacks these columns.
// SQLite has no "ADD COLUMN IF NOT EXISTS", so check the live column list
// first and add only what's missing — safe to run on every startup.
function migrateSlideColumns() {
  const existing = new Set(db.prepare("PRAGMA table_info('cases')").all().map((c) => c.name));
  const wanted = [
    ['slide_path', 'TEXT'],
    ['dzi_path', 'TEXT'],
    ['slide_status', 'TEXT'],
    ['slide_error', 'TEXT'],
    // Soft delete: a wrong upload or mis-typed patient can be hidden from the
    // worklist without destroying the record (clinical data is rarely safe to
    // hard-delete). 0 = live, 1 = archived.
    ['archived', 'INTEGER NOT NULL DEFAULT 0'],
    // Lets the queue ask "what changed since X?" instead of re-downloading the
    // whole case list every few seconds.
    ['updated_at', 'TEXT'],
  ];
  const missing = wanted.filter(([name]) => !existing.has(name));
  if (missing.length) {
    for (const [name, type] of missing) db.exec(`ALTER TABLE cases ADD COLUMN ${name} ${type};`);
    console.log(`Added columns to cases: ${missing.map(([n]) => n).join(', ')}`);
  }
  // Backfill updated_at so "changed since" works for rows that predate it.
  db.exec("UPDATE cases SET updated_at = COALESCE(updated_at, created_at, datetime('now')) WHERE updated_at IS NULL;");
  db.exec('CREATE INDEX IF NOT EXISTS idx_cases_updated ON cases (updated_at);');

  // token_version invalidates already-issued tokens: it is embedded in every
  // JWT and compared on each request, so bumping it logs that account out
  // everywhere at once (used on password change / "sign out all devices").
  const userCols = new Set(db.prepare("PRAGMA table_info('users')").all().map((c) => c.name));
  if (!userCols.has('token_version')) {
    db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;');
    console.log('Added token_version to users (enables token revocation)');
  }
}
migrateSlideColumns();

// --- One-time migration: blob-per-key notes -> one row per case -------------
// The old scheme kept every patient's notes in a single JSON blob per key, so
// saving one patient rewrote all of them and simultaneous saves clobbered each
// other. Move that data into case_notes / case_annotations, where a save
// touches exactly one row. Non-destructive: the original kv rows are left in
// place, and the migration only runs while the new tables are still empty.
function migrateNotesToRows() {
  const already = db.prepare('SELECT COUNT(*) AS c FROM case_notes').get().c
    + db.prepare('SELECT COUNT(*) AS c FROM case_annotations').get().c;
  if (already > 0) return;

  const readBlob = (key) => {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return {};
    try { return JSON.parse(row.value) || {}; } catch { return {}; }
  };
  const kinds = {
    clinical: readBlob('pv_clinicalSaved'),
    pathologist: readBlob('pv_pathologistSaved'),
    medicine: readBlob('pv_medicineSaved'),
  };
  const annotations = readBlob('pv_annotations');
  const now = new Date().toISOString();

  const insNote = db.prepare('INSERT OR IGNORE INTO case_notes (case_id, kind, body, updated_at) VALUES (?,?,?,?)');
  const insAnn = db.prepare('INSERT OR IGNORE INTO case_annotations (case_id, data, updated_at) VALUES (?,?,?)');

  let notes = 0, anns = 0;
  db.exec('BEGIN');
  try {
    for (const [kind, map] of Object.entries(kinds)) {
      for (const [caseId, body] of Object.entries(map)) {
        if (typeof body === 'string' && body.trim()) { insNote.run(Number(caseId), kind, body, now); notes++; }
      }
    }
    for (const [caseId, data] of Object.entries(annotations)) {
      if (data) { insAnn.run(Number(caseId), JSON.stringify(data), now); anns++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Notes migration failed, left kv blobs untouched:', e.message);
    return;
  }
  if (notes || anns) console.log(`Migrated ${notes} note(s) and ${anns} annotation set(s) into per-case rows.`);
}
migrateNotesToRows();

function migrateEmailUniqueness() {
  const indexes = db.prepare("PRAGMA index_list('users')").all();
  const hasOldEmailOnlyUnique = indexes.some((idx) => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all();
    return cols.length === 1 && cols[0].name === 'email';
  });
  if (!hasOldEmailOnlyUnique) return;

  console.log('Upgrading users table: same email can now have both a lab-attendant and a pathologist account…');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        full_name     TEXT NOT NULL,
        chc_name      TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'lab_attendant',
        created_at    TEXT NOT NULL,
        UNIQUE (email, role)
      );
    `);
    db.exec('INSERT INTO users_new (id, email, password_hash, full_name, chc_name, role, created_at) SELECT id, email, password_hash, full_name, chc_name, role, created_at FROM users;');
    db.exec('DROP TABLE users;');
    db.exec('ALTER TABLE users_new RENAME TO users;');
    db.exec('COMMIT');
    console.log('Users table upgraded.');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Email-uniqueness upgrade failed, users table left unchanged:', e.message);
  }
}
migrateEmailUniqueness();

export default db;
