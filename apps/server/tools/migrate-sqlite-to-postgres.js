/**
 * migrate-sqlite-to-postgres.js — copy existing data into PostgreSQL.
 * ---------------------------------------------------------------------------
 * One-off helper for moving a working SQLite database across after switching
 * DATABASE_URL on. Reads the SQLite file directly and writes through the
 * PostgreSQL driver, so both stay intact — the SQLite file is never modified
 * and remains a usable fallback.
 *
 * Safe to re-run: every insert is ON CONFLICT DO NOTHING, so rows already in
 * PostgreSQL are left exactly as they are rather than being overwritten.
 *
 * Usage (from apps/server):
 *   node tools/migrate-sqlite-to-postgres.js
 *   node tools/migrate-sqlite-to-postgres.js --dry-run
 */
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data.db');
const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — nothing to migrate into.');
  console.error('Set it in apps/server/.env first.');
  process.exit(1);
}
if (!fs.existsSync(SQLITE_FILE)) {
  console.error(`No SQLite database at ${SQLITE_FILE} — nothing to migrate.`);
  process.exit(1);
}

const sqlite = new DatabaseSync(SQLITE_FILE);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Read every row of a table, tolerating one that doesn't exist yet. */
const readAll = (table) => {
  try { return sqlite.prepare(`SELECT * FROM ${table}`).all(); }
  catch { return []; }
};

/** Insert rows one at a time, skipping any that already exist. */
async function copy(label, rows, sql, toParams) {
  if (!rows.length) { console.log(`  ${label.padEnd(18)} 0 rows`); return 0; }
  if (DRY_RUN) { console.log(`  ${label.padEnd(18)} ${rows.length} rows (dry run — nothing written)`); return 0; }

  let written = 0;
  for (const r of rows) {
    const res = await pool.query(sql, toParams(r));
    written += res.rowCount ?? 0;
  }
  const skipped = rows.length - written;
  console.log(`  ${label.padEnd(18)} ${written} copied${skipped ? `, ${skipped} already present` : ''}`);
  return written;
}

console.log(`\nMigrating ${SQLITE_FILE}`);
console.log(`        -> ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}\n`);

// Tables must be created before anything can be written into them.
const { init } = await import('../drivers/postgres.ts');
await init();

await copy('users', readAll('users'), `
  INSERT INTO users (id, email, password_hash, full_name, chc_name, role, created_at, token_version)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
  (r) => [r.id, r.email, r.password_hash, r.full_name, r.chc_name, r.role, r.created_at, r.token_version ?? 0]);

await copy('cases', readAll('cases'), `
  INSERT INTO cases (id, patient, age, gender, site, status, date, image, attendant, chc_name,
                     consultant, notes, abha, nikshay, chc_id, created_by, created_at,
                     slide_path, dzi_path, slide_status, slide_error, archived, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
  ON CONFLICT DO NOTHING`,
  (r) => [r.id, r.patient, r.age, r.gender, r.site, r.status, r.date, r.image, r.attendant, r.chc_name,
          r.consultant, r.notes, r.abha, r.nikshay, r.chc_id, r.created_by, r.created_at,
          r.slide_path, r.dzi_path, r.slide_status, r.slide_error, !!r.archived, r.updated_at]);

await copy('case_notes', readAll('case_notes'), `
  INSERT INTO case_notes (case_id, kind, body, updated_at, updated_by)
  VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
  (r) => [r.case_id, r.kind, r.body, r.updated_at, r.updated_by]);

await copy('case_annotations', readAll('case_annotations'), `
  INSERT INTO case_annotations (case_id, data, updated_at, updated_by)
  VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
  (r) => [r.case_id, r.data, r.updated_at, r.updated_by]);

await copy('kv', readAll('kv'), `
  INSERT INTO kv (key, value) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
  (r) => [r.key, r.value]);

// Reset codes are short-lived by design; copying them across would be pointless.
console.log('  reset_codes        skipped (short-lived by design)');

if (!DRY_RUN) {
  // `users.id` is a SERIAL. Rows inserted with explicit ids don't advance its
  // sequence, so without this the next signup would collide with an existing id.
  await pool.query(`
    SELECT setval(pg_get_serial_sequence('users','id'),
                  COALESCE((SELECT MAX(id) FROM users), 1), true)`);
  console.log('\n  users id sequence realigned past the imported rows');
}

console.log(DRY_RUN ? '\nDry run complete — nothing was written.\n' : '\nMigration complete.\n');
sqlite.close();
await pool.end();
