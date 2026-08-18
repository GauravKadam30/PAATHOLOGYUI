/**
 * db.js — picks a database driver, then re-exports it.
 * ---------------------------------------------------------------------------
 * The rest of the server imports from this file and never knows which database
 * it is talking to:
 *
 *   DATABASE_URL set    → drivers/postgres.js  (Drizzle ORM + PostgreSQL)
 *   DATABASE_URL absent → drivers/sqlite.js    (a single file, zero setup)
 *
 * WHY BOTH, rather than simply moving to PostgreSQL?
 *
 * PostgreSQL is the right choice for real deployment — several machines can
 * share one database, and concurrent writes are properly handled. But it has
 * to be installed and running before the server will start at all. Keeping
 * SQLite as the fallback means the project still runs anywhere with just
 * `npm install`: on a fresh clone, on a demo laptop, in CI. Neither option
 * alone gives you both.
 *
 * HOW ONE SET OF CALL SITES SERVES BOTH: the PostgreSQL driver is genuinely
 * asynchronous (the `pg` client returns promises), while the SQLite driver is
 * synchronous. Callers `await` everything — and awaiting a synchronous value
 * is harmless — so identical code works against either. That is the whole
 * trick that keeps this from being two parallel implementations of server.js.
 *
 * Adding a query means adding it to BOTH drivers with the same name and the
 * same return shape. The test suite runs against whichever is configured, so
 * running it once with DATABASE_URL and once without covers both paths.
 */
import type { DataDriver } from './types.ts';

const usePostgres = !!process.env.DATABASE_URL;

// Both modules satisfy DataDriver (each asserts it at the bottom of its own
// file), so the union is narrowed to the shared contract here. `init` is
// PostgreSQL-only — SQLite creates its tables at import time — so it is looked
// up separately rather than being forced into the shared interface.
const loaded = usePostgres
  ? await import('./drivers/postgres.ts')
  : await import('./drivers/sqlite.ts');

const driver = loaded as unknown as DataDriver;
const init = (loaded as { init?: () => Promise<void> }).init;
if (usePostgres && init) await init();

console.log(usePostgres
  ? `Database: PostgreSQL (${maskUrl(process.env.DATABASE_URL)})`
  : 'Database: SQLite (local file). Set DATABASE_URL to use PostgreSQL instead.');

/** Hide the password when echoing the connection string to the console. */
function maskUrl(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return 'invalid DATABASE_URL';
  }
}

/** True when running on PostgreSQL — used where behaviour genuinely differs. */
export const isPostgres = usePostgres;

// --- The shared data API ------------------------------------------------------
// Every name below exists in both drivers with matching behaviour.

// Users
export const getUserByEmail = driver.getUserByEmail;
export const getUserByEmailAndRole = driver.getUserByEmailAndRole;
export const getUserById = driver.getUserById;
export const createUser = driver.createUser;
export const updateProfile = driver.updateProfile;
export const updatePassword = driver.updatePassword;
export const bumpTokenVersion = driver.bumpTokenVersion;

// Cases
export const listCases = driver.listCases;
export const getCase = driver.getCase;
export const getCaseMeta = driver.getCaseMeta;
export const findCaseByChcId = driver.findCaseByChcId;
export const createCase = driver.createCase;
export const touchCase = driver.touchCase;
export const setCaseArchived = driver.setCaseArchived;

// Slide lifecycle
export const setSlidePending = driver.setSlidePending;
export const setSlideReady = driver.setSlideReady;
export const setSlideFailed = driver.setSlideFailed;
export const failStaleProcessingSlides = driver.failStaleProcessingSlides;

// Notes & annotations
export const NOTE_KINDS = driver.NOTE_KINDS;
export const setNote = driver.setNote;
export const getAllNotes = driver.getAllNotes;
export const setAnnotations = driver.setAnnotations;
export const getAllAnnotations = driver.getAllAnnotations;

// Password reset codes
export const storeResetCode = driver.storeResetCode;
export const getResetCode = driver.getResetCode;
export const bumpResetAttempts = driver.bumpResetAttempts;
export const clearResetCode = driver.clearResetCode;

// Legacy key/value store (read-only in practice)
export const getKV = driver.getKV;
export const setKV = driver.setKV;

// Maintenance
export const backupDatabase = driver.backupDatabase;
export const migrateLegacyJson = driver.migrateLegacyJson;

/** The raw handle, for the few maintenance scripts that need direct access. */
export default (loaded as { default?: unknown }).default;
