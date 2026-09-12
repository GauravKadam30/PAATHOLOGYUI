/**
 * schema.ts — the database shape, declared once.
 * ---------------------------------------------------------------------------
 * Drizzle table definitions for every table the server uses. These give the
 * queries in postgres.ts their column types, so a typo in a column name or a
 * comparison against the wrong type is a compile error rather than a runtime
 * one.
 *
 * The tables themselves are created by `init()` in postgres.ts, which runs
 * plain `CREATE TABLE IF NOT EXISTS` on every startup. This file describes
 * that shape to TypeScript; it does not create anything on its own.
 */
import {
  pgTable, serial, integer, text, boolean, bigint,
  primaryKey, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

/**
 * Accounts for BOTH front-ends.
 *
 * The unique constraint is on (email, role), not email alone — that is what
 * lets one person hold a lab-attendant account and a pathologist account under
 * the same address, which the two portals rely on.
 */
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name').notNull(),
  // Empty string for pathologists — they aren't tied to a health centre.
  chcName: text('chc_name').notNull(),
  role: text('role').notNull().default('lab_attendant'),
  createdAt: text('created_at').notNull(),
  // Bumped on password change / "sign out everywhere". Tokens carry the value
  // they were minted with, so raising it invalidates every existing token.
  tokenVersion: integer('token_version').notNull().default(0),
}, (t) => ({
  // Postgres has no case-insensitive column collation built in, so
  // case-insensitivity is enforced by indexing lower(email) instead.
  emailRoleUnique: uniqueIndex('users_email_role_unique').on(t.email, t.role),
}));

/**
 * One patient submission.
 *
 * `id` is a plain integer rather than a serial: ids are assigned by the
 * application starting at 100, so they never collide with the viewer's
 * built-in demo patients (1-3), which exist only in the frontend.
 */
export const cases = pgTable('cases', {
  id: integer('id').primaryKey(),
  patient: text('patient').notNull(),
  age: text('age'),
  gender: text('gender'),
  site: text('site'),
  status: text('status'),
  date: text('date'),
  // An ordinary photo, inline as a data-URL. Scanner slides are NOT stored
  // here — they live on disk and only their path is recorded below.
  image: text('image'),
  attendant: text('attendant'),
  chcName: text('chc_name'),
  consultant: text('consultant'),
  notes: text('notes'),
  abha: text('abha'),
  nikshay: text('nikshay'),
  chcId: text('chc_id'),
  // SET NULL, not CASCADE: a case must outlive the account that
  // submitted it. Deleting a departed attendant must never delete patients.
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at'),
  // Whole-slide image support — see db.js for the full explanation.
  slidePath: text('slide_path'),
  dziPath: text('dzi_path'),
  slideStatus: text('slide_status'),
  slideError: text('slide_error'),
  // Soft delete: archived cases leave the worklist but are never destroyed.
  archived: boolean('archived').notNull().default(false),
  // Drives the queue's incremental `?since=` polling.
  updatedAt: text('updated_at'),
  // Report sign-off. Set together when a physician signs, and what moves the
  // case from Pending to Reported in the worklist. Null while pending.
  reportedAt: text('reported_at'),
  reportedBy: text('reported_by'),
  // The signer's account id. Deliberately no foreign key: a report must keep
  // its sign-off history even if the account is later removed, and a dangling
  // id simply means nobody can withdraw it — the safe failure.
  reportedById: integer('reported_by_id'),
}, (t) => ({
  statusIdx: index('idx_cases_status').on(t.status),
  updatedIdx: index('idx_cases_updated').on(t.updatedAt),
}));

/**
 * Clinical / pathologist / medicine notes — ONE ROW PER (case, kind).
 *
 * This shape is the whole point: an earlier design kept every patient's notes
 * in a single JSON blob, so two people saving different patients at the same
 * moment silently overwrote each other. A composite primary key makes each
 * save touch exactly one row, and the conflict disappears.
 */
export const caseNotes = pgTable('case_notes', {
  // CASCADE: a note has no meaning without its case. Before this constraint
  // existed the database already held a note pointing at a case that was never
  // there, and it was served to every client on every /api/notes call.
  caseId: integer('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),          // 'clinical' | 'pathologist' | 'medicine'
  body: text('body').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: integer('updated_by'),
}, (t) => ({
  pk: primaryKey({ columns: [t.caseId, t.kind] }),
}));

/** A case's annotations, as fabric.js vector JSON (a few KB, not an image). */
export const caseAnnotations = pgTable('case_annotations', {
  caseId: integer('case_id').primaryKey().references(() => cases.id, { onDelete: 'cascade' }),
  data: text('data').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: integer('updated_by'),
});

/** Short-lived, single-use, hashed password-reset codes. */
export const resetCodes = pgTable('reset_codes', {
  userId: integer('user_id').primaryKey(),
  codeHash: text('code_hash').notNull(),
  // Milliseconds since epoch — beyond a 32-bit integer, hence bigint.
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
});

/**
 * Legacy key/value store.
 *
 * Nothing writes to this any more. It is kept read-only so annotations saved
 * under the old flattened-image scheme still display instead of vanishing.
 */
export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Append-only record of who did what.
 *
 * Separate from the tables it describes, and never updated or deleted in
 * normal operation — an audit trail that can be edited is not an audit trail.
 *
 * `userName` and `userRole` are COPIES, not joins. An entry must still read
 * correctly years later even if that account has since been renamed, changed
 * role, or removed — the same reasoning as `reportedBy` on a signed case.
 */
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  at: text('at').notNull(),
  userId: integer('user_id'),
  userName: text('user_name'),
  userRole: text('user_role'),
  /** e.g. 'login', 'case.view', 'note.save', 'report.sign'. */
  action: text('action').notNull(),
  caseId: integer('case_id'),
  detail: text('detail'),
  ip: text('ip'),
}, (t) => ({
  caseIdx: index('idx_audit_case').on(t.caseId, t.id),
  userIdx: index('idx_audit_user').on(t.userId, t.id),
}));
