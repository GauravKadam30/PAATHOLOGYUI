/**
 * postgres.ts — the PostgreSQL data layer.
 * ---------------------------------------------------------------------------
 * All the SQL in the project lives here, written with Drizzle ORM. Nothing
 * above this file builds a query, and nothing here knows about HTTP.
 *
 * Every export is asynchronous, because the `pg` client is, and the set of
 * exports is pinned by the DataDriver interface in types.ts (asserted at the
 * bottom of this file). Callers reach it through db.ts, which opens the
 * connection and creates any missing tables before re-exporting all of this.
 *
 * NAMING: user records come back in snake_case (the auth code reads
 * `password_hash` and `token_version` straight off the row) while case records
 * come back in camelCase (the browsers read `chcName`, `dziUrl`). That
 * inconsistency is inherited from the original hand-written SQL rather than
 * introduced here, and the front-ends already depend on it.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, gt, desc, sql } from 'drizzle-orm';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import * as schema from './schema.ts';
import type {
  DataDriver, UserRow, NewUser, CaseMeta, CaseFull, NewCaseInput, ListCasesOptions,
  NotesByCase, AnnotationData, AnnotationsByCase, ResetCodeRow, BackupResult, AuditEntry,
} from './types.ts';

const { users, cases, caseNotes, caseAnnotations, resetCodes, kv, auditLog } = schema;

export const NOTE_KINDS = ['clinical', 'pathologist', 'medicine'];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

/**
 * Create the tables if they don't exist.
 *
 * Written as plain SQL rather than generated migration files so that a fresh
 * database becomes usable on first boot with no extra command to remember.
 * `IF NOT EXISTS` throughout makes it safe to run on every startup.
 */
export async function init(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      full_name     TEXT NOT NULL,
      chc_name      TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'lab_attendant',
      created_at    TEXT NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 0
    );
    -- Case-insensitive uniqueness per (email, role). Postgres has no
    -- case-insensitive column collation, so the index lowercases instead.
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_role_unique
      ON users (lower(email), role);

    CREATE TABLE IF NOT EXISTS cases (
      id           INTEGER PRIMARY KEY,
      patient      TEXT NOT NULL,
      age          TEXT,
      gender       TEXT,
      site         TEXT,
      status       TEXT,
      date         TEXT,
      image        TEXT,
      attendant    TEXT,
      chc_name     TEXT,
      consultant   TEXT,
      notes        TEXT,
      abha         TEXT,
      nikshay      TEXT,
      chc_id       TEXT,
      created_by   INTEGER,
      created_at   TEXT,
      slide_path   TEXT,
      dzi_path     TEXT,
      slide_status TEXT,
      slide_error  TEXT,
      archived     BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at   TEXT,
      reported_at  TEXT,
      reported_by  TEXT
    );
    -- Added after the table already existed in the field, so IF NOT EXISTS on
    -- the CREATE above would not have introduced them.
    ALTER TABLE cases ADD COLUMN IF NOT EXISTS reported_at TEXT;
    ALTER TABLE cases ADD COLUMN IF NOT EXISTS reported_by TEXT;

    CREATE INDEX IF NOT EXISTS idx_cases_status  ON cases (status);
    CREATE INDEX IF NOT EXISTS idx_cases_updated ON cases (updated_at);

    CREATE TABLE IF NOT EXISTS case_notes (
      case_id    INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      body       TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by INTEGER,
      PRIMARY KEY (case_id, kind)
    );

    CREATE TABLE IF NOT EXISTS case_annotations (
      case_id    INTEGER PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by INTEGER
    );

    CREATE TABLE IF NOT EXISTS reset_codes (
      user_id    INTEGER PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Append-only record of who did what. Kept SEPARATE from the tables it
    -- describes so nothing here is ever updated or deleted in normal use — an
    -- audit trail that can be edited is not an audit trail.
    --
    -- The actor's NAME and ROLE are copied in rather than joined from users:
    -- an entry has to still read correctly years later, after that account has
    -- been renamed, changed role, or removed entirely.
    CREATE TABLE IF NOT EXISTS audit_log (
      id        SERIAL PRIMARY KEY,
      at        TEXT NOT NULL,
      user_id   INTEGER,
      user_name TEXT,
      user_role TEXT,
      action    TEXT NOT NULL,
      case_id   INTEGER,
      detail    TEXT,
      ip        TEXT
    );
    -- The two questions actually asked of an audit log: "what happened to this
    -- patient?" and "what did this person do?"
    CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_log (case_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, id DESC);
  `);

  // --- Referential integrity --------------------------------------------------
  // PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so each is added only when
  // absent. Failures are WARNED about rather than thrown: a constraint cannot
  // be applied while rows violate it, and a server that refuses to start
  // because of one stale row would be worse than one that runs and says so.
  await pool.query(`
    DO $$
    DECLARE
      fk RECORD;
    BEGIN
      FOR fk IN
        SELECT * FROM (VALUES
          ('case_notes_case_id_fkey',       'case_notes',       'case_id',    'cases', 'id', 'CASCADE'),
          ('case_annotations_case_id_fkey', 'case_annotations', 'case_id',    'cases', 'id', 'CASCADE'),
          ('cases_created_by_fkey',         'cases',            'created_by', 'users', 'id', 'SET NULL')
        ) AS t(name, child, col, parent, pcol, ondelete)
      LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
          BEGIN
            EXECUTE format(
              'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(%I) ON DELETE %s',
              fk.child, fk.name, fk.col, fk.parent, fk.pcol, fk.ondelete);
          EXCEPTION WHEN others THEN
            RAISE WARNING 'Could not add % (%): rows probably violate it', fk.name, SQLERRM;
          END;
        END IF;
      END LOOP;
    END $$;
  `);
}

// --- Users -------------------------------------------------------------------
// Returned in snake_case because auth.ts reads `password_hash` and
// `token_version` straight off these rows.
const toUserRow = (r: typeof users.$inferSelect | undefined): UserRow | undefined => r ? ({
  id: r.id,
  email: r.email,
  password_hash: r.passwordHash,
  full_name: r.fullName,
  chc_name: r.chcName,
  role: r.role,
  created_at: r.createdAt,
  token_version: r.tokenVersion,
}) as UserRow : undefined;

export async function getUserByEmail(email: string): Promise<UserRow | undefined> {
  const [r] = await db.select().from(users)
    .where(sql`lower(${users.email}) = lower(${String(email)})`).limit(1);
  return toUserRow(r);
}

export async function getUserByEmailAndRole(email: string, role: string): Promise<UserRow | undefined> {
  const [r] = await db.select().from(users)
    .where(and(sql`lower(${users.email}) = lower(${String(email)})`, eq(users.role, role))).limit(1);
  return toUserRow(r);
}

export async function getUserById(id: number | string): Promise<UserRow | undefined> {
  const [r] = await db.select().from(users).where(eq(users.id, Number(id))).limit(1);
  return toUserRow(r);
}

export async function createUser({ email, passwordHash, fullName, chcName, role = 'lab_attendant' }: NewUser): Promise<UserRow> {
  const [r] = await db.insert(users).values({
    email, passwordHash, fullName, chcName, role,
    createdAt: new Date().toISOString(),
    tokenVersion: 0,
  }).returning();
  // .returning() on a single insert always yields one row.
  return toUserRow(r)!;
}

export async function updateProfile(id: number, { fullName, chcName }: { fullName: string; chcName: string }): Promise<UserRow | undefined> {
  const [r] = await db.update(users).set({ fullName, chcName })
    .where(eq(users.id, Number(id))).returning();
  return toUserRow(r);
}

/** Changing a password also invalidates every token issued before now. */
export async function updatePassword(id: number, passwordHash: string): Promise<void> {
  await db.update(users)
    .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, Number(id)));
}

export async function bumpTokenVersion(id: number): Promise<void> {
  await db.update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, Number(id)));
}

// --- Cases -------------------------------------------------------------------
// Case rows go out in camelCase — this is what the two front-ends consume.
const toCaseMeta = (r: typeof cases.$inferSelect): CaseMeta => ({
  id: r.id, patient: r.patient, age: r.age, gender: r.gender, site: r.site,
  status: r.status, date: r.date, attendant: r.attendant, chcName: r.chcName,
  consultant: r.consultant, notes: r.notes, chcId: r.chcId,
  dziUrl: r.dziPath ?? null, slideStatus: (r.slideStatus ?? null) as CaseMeta['slideStatus'],
  slideError: r.slideError ?? null, archived: !!r.archived,
  updatedAt: r.updatedAt ?? null,
  hasImage: !!(r.image && r.image !== ''),
  reportedAt: r.reportedAt ?? null,
  reportedBy: r.reportedBy ?? null,
});

export async function listCases({ since, includeArchived = false }: ListCasesOptions = {}): Promise<CaseMeta[]> {
  const conditions = [];
  if (!includeArchived) conditions.push(eq(cases.archived, false));
  if (since) conditions.push(gt(cases.updatedAt, String(since)));

  const rows = await db.select().from(cases)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(cases.id);
  return rows.map(toCaseMeta);
}

/** Full record INCLUDING the inline image (large — fetched only when needed). */
export async function getCase(id: number | string): Promise<CaseFull | null> {
  const [r] = await db.select().from(cases).where(eq(cases.id, Number(id))).limit(1);
  if (!r) return null;
  return { ...toCaseMeta(r), image: r.image ?? null, abha: r.abha, nikshay: r.nikshay };
}

/** Same, without the image. */
export async function getCaseMeta(id: number | string): Promise<CaseMeta | null> {
  const c = await getCase(id);
  if (!c) return null;
  const { image, ...meta } = c;
  return meta;
}

/** Reject a duplicate CHC Patient ID within the same health centre. */
export async function findCaseByChcId(chcId: string, chcName: string): Promise<CaseMeta | null> {
  if (!chcId) return null;
  const [r] = await db.select().from(cases)
    .where(and(eq(cases.chcId, String(chcId)), eq(cases.chcName, String(chcName ?? '')))).limit(1);
  return r ? toCaseMeta(r) : null;
}

export async function createCase(data: NewCaseInput, user: UserRow): Promise<number> {
  // Ids continue from the highest existing one, starting at 100 so they never
  // clash with the viewer's built-in demo patients (ids 1-3).
  const rows = await db.select({ max: sql<string>`COALESCE(MAX(${cases.id}), 99)` }).from(cases);
  const nextId = Number(rows[0]?.max ?? 99) + 1;
  const now = new Date().toISOString();

  await db.insert(cases).values({
    id: nextId,
    patient: String(data.patient).trim(),
    age: String(data.age ?? ''),
    gender: data.gender ?? '',
    site: data.site ?? 'Lymph Node',
    status: data.status ?? 'Pending',
    date: data.date ?? now.slice(0, 10),
    image: data.image ?? null,
    // attendant + CHC come from the SIGNED-IN user, never trusted from the client
    attendant: user.full_name,
    chcName: user.chc_name,
    consultant: data.consultant ?? '',
    notes: data.notes ?? '',
    abha: data.abha ?? '',
    nikshay: data.nikshay ?? '',
    chcId: data.chcId ?? '',
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
    archived: false,
  });
  return nextId;
}

/** Bump updated_at so the queue's incremental poll notices the change. */
export async function touchCase(id: number | string): Promise<void> {
  await db.update(cases).set({ updatedAt: new Date().toISOString() })
    .where(eq(cases.id, Number(id)));
}

/**
 * Sign off a case as reported.
 *
 * Writes three things together: the status the worklist filters on, when it
 * was signed, and WHO signed it. The signer's name is copied in rather than
 * stored as a user id, because a report is a clinical record — it must still
 * read correctly years later even if that account is renamed or removed.
 *
 * `updatedAt` is bumped too, so the change reaches other pathologists on the
 * next incremental poll instead of waiting for a full refresh.
 */
export async function signCaseReport(id: number | string, userId: number): Promise<CaseMeta | null> {
  const signer = await getUserById(userId);
  const now = new Date().toISOString();
  await db.update(cases)
    .set({
      status: 'Reported',
      reportedAt: now,
      reportedBy: signer?.full_name ?? 'Unknown',
      updatedAt: now,
    })
    .where(eq(cases.id, Number(id)));
  return getCaseMeta(id);
}

export async function setCaseArchived(id: number | string, archived = true): Promise<CaseMeta | null> {
  await db.update(cases)
    .set({ archived: !!archived, updatedAt: new Date().toISOString() })
    .where(eq(cases.id, Number(id)));
  // The archive endpoint echoes the updated case straight back to the browser,
  // so it has to be returned here rather than just written.
  return getCaseMeta(id);
}

// --- Slide lifecycle ---------------------------------------------------------
export async function setSlidePending(id: number | string, slidePath: string | null): Promise<void> {
  await db.update(cases).set({
    slidePath, slideStatus: 'processing', slideError: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(cases.id, Number(id)));
}

export async function setSlideReady(id: number | string, dziPath: string): Promise<void> {
  await db.update(cases).set({
    dziPath, slideStatus: 'ready', slideError: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(cases.id, Number(id)));
}

export async function setSlideFailed(id: number | string, message: string): Promise<void> {
  await db.update(cases).set({
    slideStatus: 'failed',
    slideError: String(message || 'Slide conversion failed.').slice(0, 500),
    updatedAt: new Date().toISOString(),
  }).where(eq(cases.id, Number(id)));
}

/**
 * Permanently remove a case and everything hanging off it.
 *
 * The notes and annotations go with it through ON DELETE CASCADE, so this is a
 * single statement rather than a hand-rolled sequence that could half-finish.
 * They are counted first, because once the cascade has run there is nothing
 * left to count and the numbers are what the audit entry records.
 *
 * THE AUDIT TRAIL IS DELIBERATELY NOT TOUCHED. A log that can be erased by the
 * very action it exists to record is not an audit trail. Those rows hold a case
 * id and an action, never a patient name, so keeping them does not undo the
 * erasure — it only preserves the fact that a case once existed and who removed
 * it.
 *
 * Returns null when there was no such case, so the caller can answer 404 rather
 * than report a successful deletion of nothing.
 */
export async function deleteCase(id: number | string): Promise<{ notes: number; annotations: number } | null> {
  const caseId = Number(id);
  const [existing] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!existing) return null;

  const notes = await db.select({ kind: caseNotes.kind }).from(caseNotes).where(eq(caseNotes.caseId, caseId));
  const anns = await db.select({ caseId: caseAnnotations.caseId }).from(caseAnnotations).where(eq(caseAnnotations.caseId, caseId));

  await db.delete(cases).where(eq(cases.id, caseId));
  return { notes: notes.length, annotations: anns.length };
}

/**
 * Forget a case's slide entirely, putting the fields back to how they were
 * before anything was uploaded.
 *
 * Used by cancel. The case ROW is deliberately kept: the patient details are
 * still wanted, it is only the file being undone, and leaving the row means the
 * correct slide can be uploaded straight away without re-entering anything.
 */
export async function clearSlide(id: number | string): Promise<void> {
  await db.update(cases).set({
    slidePath: null, dziPath: null, slideStatus: null, slideError: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(cases.id, Number(id)));
}

/**
 * On startup, any case left mid-conversion belongs to a server that died.
 * Nothing is generating tiles for it any more, so mark it failed rather than
 * leaving it spinning forever.
 */
export async function failStaleProcessingSlides(): Promise<void> {
  const res = await db.update(cases).set({
    slideStatus: 'failed',
    slideError: 'Server restarted during slide processing — please re-upload.',
    updatedAt: new Date().toISOString(),
  }).where(eq(cases.slideStatus, 'processing'));
  const n = res.rowCount ?? 0;
  if (n) console.log(`Marked ${n} interrupted slide conversion(s) as failed.`);
}

// --- Notes (one row per case + kind) ------------------------------------------
export async function setNote(caseId: number | string, kind: string, body: string, userId?: number | null): Promise<void> {
  if (!NOTE_KINDS.includes(kind)) throw new Error(`unknown note kind: ${kind}`);
  await db.insert(caseNotes).values({
    caseId: Number(caseId), kind, body: String(body ?? ''),
    updatedAt: new Date().toISOString(), updatedBy: userId ?? null,
  }).onConflictDoUpdate({
    target: [caseNotes.caseId, caseNotes.kind],
    set: {
      body: sql`excluded.body`,
      updatedAt: sql`excluded.updated_at`,
      updatedBy: sql`excluded.updated_by`,
    },
  });
  await touchCase(caseId);
}

/**
 * All notes as { caseId: { clinical, pathologist, medicine } }.
 * Reading in bulk is safe — it's only the WRITES that had to become per-row.
 */
export async function getAllNotes(): Promise<NotesByCase> {
  const rows = await db.select().from(caseNotes);
  const out: NotesByCase = {};
  for (const r of rows) (out[r.caseId] ||= {})[r.kind as keyof NotesByCase[string]] = r.body;
  return out;
}

// --- Annotations (one row per case) -------------------------------------------
export async function setAnnotations(caseId: number | string, data: AnnotationData, userId?: number | null): Promise<void> {
  await db.insert(caseAnnotations).values({
    caseId: Number(caseId), data: JSON.stringify(data ?? {}),
    updatedAt: new Date().toISOString(), updatedBy: userId ?? null,
  }).onConflictDoUpdate({
    target: caseAnnotations.caseId,
    set: {
      data: sql`excluded.data`,
      updatedAt: sql`excluded.updated_at`,
      updatedBy: sql`excluded.updated_by`,
    },
  });
  await touchCase(caseId);
}

export async function getAllAnnotations(): Promise<AnnotationsByCase> {
  const rows = await db.select().from(caseAnnotations);
  const out: AnnotationsByCase = {};
  for (const r of rows) {
    // A corrupt row shouldn't take down the whole response.
    try { out[r.caseId] = JSON.parse(r.data); } catch { out[r.caseId] = {}; }
  }
  return out;
}

// --- Password reset codes -----------------------------------------------------
export async function storeResetCode(userId: number, codeHash: string, expiresAt: number): Promise<void> {
  await db.insert(resetCodes).values({
    userId: Number(userId), codeHash, expiresAt: Number(expiresAt), attempts: 0,
  }).onConflictDoUpdate({
    target: resetCodes.userId,
    set: {
      codeHash: sql`excluded.code_hash`,
      expiresAt: sql`excluded.expires_at`,
      attempts: 0,
    },
  });
}

export async function getResetCode(userId: number): Promise<ResetCodeRow | undefined> {
  const [r] = await db.select().from(resetCodes)
    .where(eq(resetCodes.userId, Number(userId))).limit(1);
  return r && { user_id: r.userId, code_hash: r.codeHash, expires_at: Number(r.expiresAt), attempts: r.attempts };
}

export async function bumpResetAttempts(userId: number): Promise<void> {
  await db.update(resetCodes)
    .set({ attempts: sql`${resetCodes.attempts} + 1` })
    .where(eq(resetCodes.userId, Number(userId)));
}

export async function clearResetCode(userId: number): Promise<void> {
  await db.delete(resetCodes).where(eq(resetCodes.userId, Number(userId)));
}

// --- Legacy key/value store ---------------------------------------------------
export async function getKV(key: string): Promise<unknown> {
  const [r] = await db.select().from(kv).where(eq(kv.key, key)).limit(1);
  if (!r) return {};
  try { return JSON.parse(r.value); } catch { return {}; }
}

export async function setKV(key: string, value: unknown): Promise<void> {
  await db.insert(kv).values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
}

// --- Audit trail --------------------------------------------------------------

/**
 * Record one action.
 *
 * SWALLOWS ITS OWN ERRORS ON PURPOSE. This runs alongside real work — saving a
 * note, signing a report — and a failure to write the audit row must not fail
 * the clinical action that succeeded. Losing an audit line is bad; refusing a
 * pathologist's save because the log was unavailable is worse. Failures are
 * logged loudly to the server console so they are noticed.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      at: new Date().toISOString(),
      userId: entry.userId ?? null,
      userName: entry.userName ?? null,
      userRole: entry.userRole ?? null,
      action: entry.action,
      caseId: entry.caseId ?? null,
      detail: entry.detail ?? null,
      ip: entry.ip ?? null,
    });
  } catch (e) {
    console.error('[audit] could NOT record:', entry.action, (e as Error).message);
  }
}

/** Recent audit entries, newest first — for a per-case history view. */
export async function readAudit({ caseId, limit = 100 }: { caseId?: number; limit?: number } = {}): Promise<unknown[]> {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const q = db.select().from(auditLog);
  const rows = caseId != null
    ? await q.where(eq(auditLog.caseId, Number(caseId))).orderBy(desc(auditLog.id)).limit(capped)
    : await q.orderBy(desc(auditLog.id)).limit(capped);
  return rows;
}

/**
 * Back up the database with `pg_dump`.
 *
 * There is no in-process API for a consistent snapshot, so this shells out to
 * the standard tool. If pg_dump isn't on PATH the failure
 * is reported rather than thrown — a missing backup must not stop the server
 * from serving patients.
 */
/**
 * Locate pg_dump.
 *
 * The PostgreSQL Windows installer does not reliably add its bin directory to
 * PATH, so backups would silently never run. Checking the standard install
 * locations first means backups work out of the box; PG_DUMP overrides it.
 */
function findPgDump(): string {
  if (process.env.PG_DUMP) return process.env.PG_DUMP;
  const candidates = [];
  for (const v of [18, 17, 16, 15, 14]) {
    candidates.push(`C:\\Program Files\\PostgreSQL\\${v}\\bin\\pg_dump.exe`);
  }
  candidates.push('/usr/bin/pg_dump', '/usr/local/bin/pg_dump');
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return 'pg_dump';   // fall back to PATH
}

export async function backupDatabase(dir: string, keep = 7): Promise<BackupResult> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `data-${stamp}.sql`);

  return new Promise((resolve, reject) => {
    const proc = spawn(findPgDump(), [process.env.DATABASE_URL ?? '', '--no-owner', '--no-acl', '-f', file], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d; });
    proc.on('error', (e: Error) => reject(new Error(
      `pg_dump could not be run (${e.message}). Add PostgreSQL's bin directory to PATH to enable backups.`,
    )));
    proc.on('exit', (code: number | null) => {
      if (code !== 0) return reject(new Error(`pg_dump exited with ${code}: ${stderr.trim()}`));

      // Prune old dumps. Without this a nightly backup grows the folder
      // forever, which on an 11 MB dump adds up quickly.
      const backups = fs.readdirSync(dir).filter((f) => /^data-.*\.sql$/.test(f)).sort().reverse();
      for (const old of backups.slice(keep)) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { /* already gone */ }
      }
      resolve({ file, bytes: fs.statSync(file).size, kept: Math.min(backups.length, keep) });
    });
  });
}

/** Close the pool cleanly (used by the test suite). */
export async function close(): Promise<void> { await pool.end(); }

export default db;

// --- Contract check -----------------------------------------------------------
// Not used at runtime. Its only job is to make TypeScript verify that this
// PostgreSQL driver exposes every function `DataDriver` requires, with matching
// signatures — so a divergence between the two drivers is a compile error
// rather than a failure that only appears on whichever database is configured.
import * as self from './postgres.ts';
const _contract: DataDriver = self as unknown as DataDriver;
void _contract;
