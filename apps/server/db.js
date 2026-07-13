/**
 * db.js — the data layer.
 * ---------------------------------------------------------------------------
 * Replaces the old single "data.json" file with a real relational database
 * (SQLite, built into Node — no server, no Docker, no extra install). SQLite
 * gives us the three things the JSON file could not:
 *   • transactions      → two people saving at once can't corrupt each other,
 *   • per-row writes     → saving one note touches one row, not the whole file,
 *   • indexes & rules    → stays fast and rejects bad data even at lakhs of rows.
 *
 * Everything is stored in one managed file, data.db, next to this script.
 * The rest of the app never touches SQL directly — it calls the small set of
 * functions exported at the bottom (a "repository"), so swapping SQLite for a
 * cloud PostgreSQL later means changing only this one file.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'data.db');
const LEGACY_JSON = path.join(__dirname, 'data.json');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');   // write-ahead logging: safer + better concurrency

// --- Schema (created once; "IF NOT EXISTS" makes startup idempotent) ---------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- login id, case-insensitive
  password_hash TEXT NOT NULL,                          -- never the raw password
  full_name     TEXT NOT NULL,                          -- lab attendant's name
  chc_name      TEXT NOT NULL,                          -- their health-centre name
  role          TEXT NOT NULL DEFAULT 'lab_attendant',
  created_at    TEXT NOT NULL
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
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status);

-- Key/value table backing /api/store/:key — the Pathology Viewer keeps its
-- saved notes and annotated images here, one JSON blob per key.
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// --- Users -------------------------------------------------------------------
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email));
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
export function listCases() {
  return db.prepare(`
    SELECT id, patient, age, gender, site, status, date, attendant, chc_name, consultant, notes,
           (image IS NOT NULL AND image != '') AS hasImage
    FROM cases ORDER BY id
  `).all().map((r) => ({
    id: r.id, patient: r.patient, age: r.age, gender: r.gender, site: r.site,
    status: r.status, date: r.date, attendant: r.attendant, chcName: r.chc_name,
    consultant: r.consultant, notes: r.notes, hasImage: !!r.hasImage,
  }));
}

function remapCase(r) {
  if (!r) return null;
  return {
    id: r.id, patient: r.patient, age: r.age, gender: r.gender, site: r.site,
    status: r.status, date: r.date, image: r.image ?? null,
    attendant: r.attendant, chcName: r.chc_name, consultant: r.consultant,
    notes: r.notes, abha: r.abha, nikshay: r.nikshay,
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
       consultant, notes, abha, nikshay, chc_id, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    nextId, String(data.patient).trim(), String(data.age ?? ''), data.gender ?? '',
    data.site ?? 'Lymph Node', data.status ?? 'Pending', data.date ?? now.slice(0, 10),
    data.image ?? null,
    // attendant + CHC come from the SIGNED-IN user, never trusted from the client
    user.full_name, user.chc_name,
    data.consultant ?? '', data.notes ?? '', data.abha ?? '', data.nikshay ?? '',
    data.chcId ?? '', user.id, now,
  );
  return nextId;
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

export default db;
