/**
 * db.ts — opens the database, then re-exports the data API.
 * ---------------------------------------------------------------------------
 * The rest of the server imports everything data-related from this file. It
 * exists so that callers never deal with connection setup or table creation
 * themselves — importing it is enough to know the database is ready.
 *
 * The implementation lives in postgres.ts (Drizzle ORM over PostgreSQL) and
 * the shape of it is pinned by the DataDriver interface in types.ts, which
 * that file asserts against at its bottom. Adding a query means adding it
 * there and to the interface, so the two cannot drift.
 *
 * The whole data API is asynchronous, and every caller awaits it. That is not
 * incidental: forgetting an `await` on a promise-returning query yields a
 * pending Promise, which is truthy, so checks like `if (!user)` silently pass.
 * That exact bug reached `authRequired` once and is described in types.ts.
 *
 * DATABASE_URL is required. The server refuses to start without it rather than
 * guessing at a connection, so a misconfigured environment fails immediately
 * and loudly instead of part-way through the first request.
 */
import * as driver from './postgres.ts';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — the server needs a PostgreSQL connection string.');
  console.error('Copy apps/server/.env.example to apps/server/.env and set it, for example');
  console.error('  DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/telepathology');
  process.exit(1);
}

// Creates any missing tables and indexes. Safe on every start — everything is
// IF NOT EXISTS — so a fresh database needs no separate migration step.
await driver.init();

console.log(`Database: PostgreSQL (${maskUrl(process.env.DATABASE_URL)})`);

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

// Re-exported as live bindings, so `import * as db from './db.ts'` gives the
// full data API with the connection already open.
export * from './postgres.ts';
