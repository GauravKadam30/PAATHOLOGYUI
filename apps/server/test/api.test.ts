/**
 * api.test.js — automated checks for the paths where a bug would be expensive:
 * authentication, role separation, note saving under concurrency, duplicate
 * patient IDs, archiving, and token revocation.
 *
 * Uses node:test and node:assert (both built into Node) so there is no test
 * framework to install. The server is started as a real child process against
 * a THROWAWAY database and uploads directory, so nothing here can touch real
 * patient data — see `resolveTestDatabase()` below for how that is enforced.
 *
 * Run with:  npm test -w apps/server
 */
// Reads apps/server/.env so the suite can find PostgreSQL. It derives its own
// throwaway database name from that connection string — see resolveTestDatabase.
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import nodeCrypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.ts');
const PORT = 3199;                       // deliberately not 3001, so a running dev server is untouched
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess;
let tmpDir: string;

/**
 * One request against the running test server.
 *
 * The response body is deliberately `any`: these tests assert against the raw
 * JSON the API actually returns, and re-declaring every response shape here
 * would test the declarations rather than the server.
 */
interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Bearer token; omitted for the unauthenticated endpoints. */
  token?: string;
}

const api = async (
  pathname: string,
  { method = 'GET', body, token }: ApiOptions = {},
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* some responses have no body */ }
  return { status: res.status, body: json };
};

const uniqueEmail = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;

/**
 * Work out which database to test against, and make sure it exists.
 *
 * THE IMPORTANT PART is that this can never be the developer's real database.
 * apps/server/.env sets DATABASE_URL for normal development, and dotenv would
 * happily apply it here too — so these tests would create, archive and delete
 * rows in the actual patient database. Instead the name is derived with a
 * `_test` suffix (or taken from TEST_DATABASE_URL), and the assertion below
 * refuses to run if that somehow resolves back to the real one.
 */
async function resolveTestDatabase(): Promise<string> {
  const real = process.env.DATABASE_URL;
  if (!process.env.TEST_DATABASE_URL && !real) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set. Point one at PostgreSQL, '
      + 'for example postgresql://postgres:password@localhost:5432/telepathology',
    );
  }

  let testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    const u = new URL(real!);
    u.pathname = `${u.pathname.replace(/^\//, '')}_test`;
    testUrl = u.toString();
  }

  if (real) {
    const nameOf = (s: string) => new URL(s).pathname.replace(/^\//, '');
    assert.notEqual(nameOf(testUrl), nameOf(real),
      'refusing to run the suite against the real database');
  }

  // Create the throwaway database if it is not there yet, so `npm test` works
  // on a fresh checkout without a manual setup step. Connecting requires an
  // existing database, hence the detour via the default `postgres` one.
  const admin = new URL(testUrl);
  const dbName = admin.pathname.replace(/^\//, '');
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
  return testUrl;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-test-'));
  const testDatabaseUrl = await resolveTestDatabase();

  proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TILE_PORT: '3299',
      DATABASE_URL: testDatabaseUrl,
      // Point every piece of on-disk state at the throwaway directory.
      UPLOADS_DIR: path.join(tmpDir, 'uploads'),
      BACKUP_DIR: path.join(tmpDir, 'backups'),
      BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
      JWT_SECRET: 'test-secret-not-used-anywhere-real',
      // The suite signs up dozens of accounts in a few seconds. That is the
      // exact shape of the attack the rate limiter blocks, so it has to be
      // raised here or later tests fail with 429s that look like auth bugs.
      AUTH_RATE_MAX: '10000',
      RESET_RATE_MAX: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface the child's output when PV_TEST_DEBUG=1 — otherwise a server that
  // fails to boot just shows as a connection-refused with no explanation.
  const debug = process.env.PV_TEST_DEBUG === '1';
  proc.stdout?.on('data', (d: Buffer) => { if (debug) process.stdout.write(`[server] ${d}`); });
  proc.stderr?.on('data', (d: Buffer) => { if (debug) process.stderr.write(`[server!] ${d}`); });

  // Wait for it to answer rather than guessing at a fixed sleep.
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('test server did not start');
});

after(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// --- Authentication ----------------------------------------------------------

test('signup rejects a password under 6 characters', async () => {
  const { status } = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: uniqueEmail('short'), password: '12345', fullName: 'A', chcName: 'B', role: 'lab_attendant' },
  });
  assert.equal(status, 400);
});

test('the same email can hold both a lab-attendant and a pathologist account', async () => {
  const email = uniqueEmail('dual');
  const a = await api('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'secret123', fullName: 'Dual A', chcName: 'CHC', role: 'lab_attendant' },
  });
  const b = await api('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'secret123', fullName: 'Dual B', role: 'pathologist' },
  });
  assert.equal(a.status, 200, 'lab attendant signup should succeed');
  assert.equal(b.status, 200, 'pathologist signup with the same email should also succeed');
  assert.notEqual(a.body.user.id, b.body.user.id, 'they must be separate accounts');
});

test('a duplicate signup within the SAME role is rejected', async () => {
  const email = uniqueEmail('dupe');
  const body = { email, password: 'secret123', fullName: 'X', chcName: 'CHC', role: 'lab_attendant' };
  assert.equal((await api('/api/auth/signup', { method: 'POST', body })).status, 200);
  assert.equal((await api('/api/auth/signup', { method: 'POST', body })).status, 409);
});

test('logging in with the wrong portal is refused, not silently allowed', async () => {
  const email = uniqueEmail('portal');
  await api('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'secret123', fullName: 'P', chcName: 'CHC', role: 'lab_attendant' },
  });
  const wrong = await api('/api/auth/login', {
    method: 'POST', body: { email, password: 'secret123', role: 'pathologist' },
  });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error, /CHC Intake/);
});

// --- Token revocation --------------------------------------------------------

test('a token stops working once the account signs out everywhere', async () => {
  const email = uniqueEmail('revoke');
  const { body: signed } = await api('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'secret123', fullName: 'R', chcName: 'CHC', role: 'lab_attendant' },
  });
  const token = signed.token;
  assert.equal((await api('/api/auth/me', { token })).status, 200, 'token should work initially');

  await api('/api/auth/logout-all', { method: 'POST', token });
  assert.equal((await api('/api/auth/me', { token })).status, 401, 'the same token must now be rejected');
});

// --- Cases -------------------------------------------------------------------

/** Sign up an account of any role and return its token. */
async function makeUser(role: string, prefix: string) {
  const { body } = await api('/api/auth/signup', {
    method: 'POST',
    body: {
      email: uniqueEmail(prefix), password: 'secret123',
      fullName: `${prefix} user`, chcName: '', role,
    },
  });
  return body.token as string;
}
const makePathologist = () => makeUser('pathologist', 'path');
const makePhysician = () => makeUser('physician', 'phys');

async function makeAttendant() {
  const { body } = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: uniqueEmail('att'), password: 'secret123', fullName: 'Att', chcName: `CHC-${Math.random()}`, role: 'lab_attendant' },
  });
  return body.token;
}

test('a pathologist account cannot submit a case', async () => {
  const { body } = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: uniqueEmail('path'), password: 'secret123', fullName: 'Dr P', role: 'pathologist' },
  });
  const res = await api('/api/cases', { method: 'POST', token: body.token, body: { patient: 'Nope' } });
  assert.equal(res.status, 403);
});

test('a duplicate CHC Patient ID at the same centre is rejected', async () => {
  const token = await makeAttendant();
  const chcId = `ID-${Date.now()}`;
  const first = await api('/api/cases', { method: 'POST', token, body: { patient: 'First', chcId } });
  assert.equal(first.status, 200);

  const second = await api('/api/cases', { method: 'POST', token, body: { patient: 'Second', chcId } });
  assert.equal(second.status, 409, 'the second case must be refused');
  assert.match(second.body.error, /already used/);
});

test('archiving hides a case from the worklist and restoring brings it back', async () => {
  const token = await makeAttendant();
  const { body: created } = await api('/api/cases', { method: 'POST', token, body: { patient: 'Archive Me' } });

  const visible = async () => (await api('/api/cases', { token })).body.some((c: any) => c.id === created.id);
  assert.equal(await visible(), true);

  await api(`/api/cases/${created.id}/archived`, { method: 'PATCH', token, body: { archived: true } });
  assert.equal(await visible(), false, 'archived cases must not appear in the queue');

  await api(`/api/cases/${created.id}/archived`, { method: 'PATCH', token, body: { archived: false } });
  assert.equal(await visible(), true, 'restoring must bring it back');
});

// --- Notes: the concurrency bug this refactor existed to fix ------------------

test('simultaneous saves on DIFFERENT cases both survive', async () => {
  const token = await makeAttendant();
  const a = (await api('/api/cases', { method: 'POST', token, body: { patient: 'Race A' } })).body;
  const b = (await api('/api/cases', { method: 'POST', token, body: { patient: 'Race B' } })).body;
  const pathToken = await makePathologist();

  // Fired together, as two people saving at the same moment would. Under the
  // old blob-per-key storage, whichever landed second overwrote the other.
  await Promise.all([
    api(`/api/cases/${a.id}/notes/pathologist`, { method: 'PUT', token: pathToken, body: { body: 'findings for A' } }),
    api(`/api/cases/${b.id}/notes/pathologist`, { method: 'PUT', token: pathToken, body: { body: 'findings for B' } }),
  ]);

  const notes = (await api('/api/notes', { token: pathToken })).body;
  assert.equal(notes[a.id]?.pathologist, 'findings for A');
  assert.equal(notes[b.id]?.pathologist, 'findings for B');
});

test('the three note kinds on one case are independent', async () => {
  const token = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token, body: { patient: 'Kinds' } })).body;

  // Each kind is written by the role entitled to write it: a pathologist owns
  // the findings, a physician owns the prescription.
  const pathToken = await makePathologist();
  const physToken = await makePhysician();

  await Promise.all([
    api(`/api/cases/${c.id}/notes/clinical`, { method: 'PUT', token: pathToken, body: { body: 'clinical text' } }),
    api(`/api/cases/${c.id}/notes/pathologist`, { method: 'PUT', token: pathToken, body: { body: 'pathologist text' } }),
    api(`/api/cases/${c.id}/notes/medicine`, { method: 'PUT', token: physToken, body: { body: 'medicine text' } }),
  ]);

  const notes = (await api('/api/notes', { token: pathToken })).body[c.id];
  assert.equal(notes.clinical, 'clinical text');
  assert.equal(notes.pathologist, 'pathologist text');
  assert.equal(notes.medicine, 'medicine text');
});

test('an unknown note kind is rejected', async () => {
  const token = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token, body: { patient: 'Bad Kind' } })).body;
  const res = await api(`/api/cases/${c.id}/notes/nonsense`, { method: 'PUT', token, body: { body: 'x' } });
  assert.equal(res.status, 400);
});

test('saving a note requires sign-in', async () => {
  const token = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token, body: { patient: 'Anon' } })).body;
  const res = await api(`/api/cases/${c.id}/notes/clinical`, { method: 'PUT', body: { body: 'x' } });
  assert.equal(res.status, 401);
});

// --- Annotations -------------------------------------------------------------

test('annotations round-trip as vector data', async () => {
  const token = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token, body: { patient: 'Marks' } })).body;
  const marks = { version: '7.4.0', objects: [{ type: 'Ellipse', left: 100, top: 200, rx: 50, ry: 25 }] };
  const pathToken = await makePathologist();

  await api(`/api/cases/${c.id}/annotations`, { method: 'PUT', token: pathToken, body: marks });
  const stored = (await api('/api/annotations', { token: pathToken })).body[c.id];
  assert.equal(stored.objects.length, 1);
  assert.equal(stored.objects[0].left, 100);
});

// --- Incremental polling -----------------------------------------------------

test('?since= returns only cases changed after that moment', async () => {
  const token = await makeAttendant();
  await api('/api/cases', { method: 'POST', token, body: { patient: 'Before' } });

  const watermark = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 15));           // ensure a distinct timestamp

  const after = (await api('/api/cases', { method: 'POST', token, body: { patient: 'After' } })).body;
  const changed = (await api(`/api/cases?since=${encodeURIComponent(watermark)}`, { token })).body;

  assert.ok(changed.some((c: any) => c.id === after.id), 'the newer case must be included');
  assert.ok(changed.every((c: any) => c.updatedAt > watermark), 'nothing older should come back');
});

// --- Password reset ----------------------------------------------------------

// --- Access control ----------------------------------------------------------
// These lock in the fix for the worst defect this project has had: every read
// endpoint was open, so `curl /api/cases` returned the full patient list to
// anyone who could reach the server.

test('patient data cannot be read without signing in', async () => {
  for (const path of ['/api/cases', '/api/notes', '/api/annotations', '/api/store/anything']) {
    const res = await api(path);
    assert.equal(res.status, 401, `${path} must require a token`);
  }
});

test('an anonymous caller cannot write to the key/value store', async () => {
  const res = await api('/api/store/probe', { method: 'PUT', body: { hacked: true } });
  assert.equal(res.status, 401);
});

test('a pathologist cannot write the prescription, a physician cannot write the findings', async () => {
  const attToken = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token: attToken, body: { patient: 'Split' } })).body;
  const pathToken = await makePathologist();
  const physToken = await makePhysician();

  const pathWritesMedicine = await api(`/api/cases/${c.id}/notes/medicine`, {
    method: 'PUT', token: pathToken, body: { body: 'prescribing without a licence' },
  });
  assert.equal(pathWritesMedicine.status, 403);

  const physWritesFindings = await api(`/api/cases/${c.id}/notes/pathologist`, {
    method: 'PUT', token: physToken, body: { body: 'diagnosing without a microscope' },
  });
  assert.equal(physWritesFindings.status, 403);
});

test('only a pathologist may annotate a slide', async () => {
  const attToken = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token: attToken, body: { patient: 'NoDraw' } })).body;
  const physToken = await makePhysician();

  const res = await api(`/api/cases/${c.id}/annotations`, {
    method: 'PUT', token: physToken, body: { objects: [] },
  });
  assert.equal(res.status, 403);
});

test('only a physician can sign a report, and only once', async () => {
  const attToken = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token: attToken, body: { patient: 'Signable' } })).body;
  const pathToken = await makePathologist();
  const physToken = await makePhysician();

  assert.equal((await api(`/api/cases/${c.id}/sign`, { method: 'POST', token: pathToken })).status, 403,
    'a pathologist must not be able to sign');

  const signed = await api(`/api/cases/${c.id}/sign`, { method: 'POST', token: physToken });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.status, 'Reported');
  assert.ok(signed.body.reportedAt, 'the signing time must be recorded');
  assert.ok(signed.body.reportedBy, 'the signer must be recorded');

  assert.equal((await api(`/api/cases/${c.id}/sign`, { method: 'POST', token: physToken })).status, 409,
    'signing twice must be refused');
});

// --- Audit trail --------------------------------------------------------------

test('actions are recorded against the case with who did them', async () => {
  const attToken = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token: attToken, body: { patient: 'Audited' } })).body;
  const pathToken = await makePathologist();
  const physToken = await makePhysician();

  await api(`/api/cases/${c.id}`, { token: pathToken });                       // case.view
  await api(`/api/cases/${c.id}/notes/pathologist`, {
    method: 'PUT', token: pathToken, body: { body: 'findings' },
  });                                                                          // note.save
  await api(`/api/cases/${c.id}/sign`, { method: 'POST', token: physToken });  // report.sign

  const log = (await api(`/api/cases/${c.id}/audit`, { token: pathToken })).body;
  const actions = log.map((r: any) => r.action);
  assert.ok(actions.includes('case.view'), 'opening a record must be recorded');
  assert.ok(actions.includes('note.save'), 'saving a note must be recorded');
  assert.ok(actions.includes('report.sign'), 'signing must be recorded');

  // The actor is stored by NAME and ROLE, not only by id, so the entry still
  // reads correctly if that account is later renamed or removed.
  const signed = log.find((r: any) => r.action === 'report.sign');
  assert.ok(signed.userName, 'the actor name must be recorded');
  assert.equal(signed.userRole, 'physician');
});

test('polling the worklist is NOT audited', async () => {
  const attToken = await makeAttendant();
  const c = (await api('/api/cases', { method: 'POST', token: attToken, body: { patient: 'Poll' } })).body;
  const pathToken = await makePathologist();

  // One real open, so there is something in this case's log to compare against.
  await api(`/api/cases/${c.id}`, { token: pathToken });
  const before = (await api(`/api/cases/${c.id}/audit`, { token: pathToken })).body.length;

  // The worklist polls every four seconds. Recording that would add hundreds of
  // rows an hour per user and bury the entries that matter.
  for (let i = 0; i < 10; i++) await api('/api/cases', { token: pathToken });

  const after = (await api(`/api/cases/${c.id}/audit`, { token: pathToken })).body.length;
  assert.equal(after, before, 'listing the queue must not add audit entries');
});

test('requesting a reset never reveals whether the account exists', async () => {
  const real = uniqueEmail('reset');
  await api('/api/auth/signup', {
    method: 'POST',
    body: { email: real, password: 'secret123', fullName: 'Reset', chcName: 'CHC', role: 'lab_attendant' },
  });
  const known = await api('/api/auth/request-reset', { method: 'POST', body: { email: real } });
  const unknown = await api('/api/auth/request-reset', { method: 'POST', body: { email: uniqueEmail('ghost') } });

  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.body, unknown.body, 'both answers must be identical');
});

test('a wrong reset code does not change the password', async () => {
  const email = uniqueEmail('badcode');
  await api('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'secret123', fullName: 'Bad', chcName: 'CHC', role: 'lab_attendant' },
  });
  await api('/api/auth/request-reset', { method: 'POST', body: { email } });

  const res = await api('/api/auth/reset-password', {
    method: 'POST', body: { email, code: '000000', newPassword: 'brandnew123' },
  });
  assert.equal(res.status, 400);

  // The original password must still work.
  const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'secret123', role: 'lab_attendant' } });
  assert.equal(login.status, 200);
});

/* ===========================================================================
 * Resumable slide upload
 * ---------------------------------------------------------------------------
 * These are the paths where a bug is expensive and invisible: a file that ends
 * up the right LENGTH but the wrong CONTENT would be a corrupt slide nobody
 * notices until a pathologist is looking at it.
 *
 * The uploads directory here is the suite's throwaway one, and the bytes are
 * not a real scanner file, so `complete` legitimately fails its OpenSlide check
 * — which is itself worth asserting, since it proves an unreadable upload is
 * never marked ready.
 */

/** Send one chunk. Separate from `api` because the body is binary, not JSON. */
async function putChunk(
  caseId: number | string,
  offset: number,
  body: Buffer,
  token: string,
  checksum?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Upload-Offset': String(offset),
    Authorization: `Bearer ${token}`,
  };
  if (checksum !== undefined) headers['Upload-Checksum'] = checksum;
  const res = await fetch(`${BASE}/api/cases/${caseId}/slide/upload`, { method: 'PATCH', headers, body });
  let json: any = null;
  try { json = await res.json(); } catch { /* some responses have no body */ }
  return { status: res.status, body: json };
}

const sha256 = (b: Buffer) => nodeCrypto.createHash('sha256').update(b).digest('hex');
const bytesOf = (n: number, fill: number) => Buffer.alloc(n, fill);

/** A case owned by a fresh attendant, ready to receive a slide. */
async function caseForUpload(): Promise<{ token: string; id: number }> {
  const token = await makeAttendant();
  const { body } = await api('/api/cases', { method: 'POST', token, body: { patient: 'Slide Subject' } });
  return { token, id: body.id };
}

test('chunks accumulate and the server reports how much it holds', async () => {
  const { token, id } = await caseForUpload();

  const start = await api(`/api/cases/${id}/slide/upload?name=slide.tiff`, { token });
  assert.equal(start.status, 200);
  assert.equal(start.body.bytes, 0, 'a fresh case holds nothing');

  const a = bytesOf(1024, 0x41);
  const b = bytesOf(2048, 0x42);
  assert.equal((await putChunk(id, 0, a, token, sha256(a))).body.bytes, 1024);
  assert.equal((await putChunk(id, 1024, b, token, sha256(b))).body.bytes, 3072);

  const after = await api(`/api/cases/${id}/slide/upload`, { token });
  assert.equal(after.body.bytes, 3072, 'the offset survives between requests');
});

test('a chunk at the wrong offset is refused, and the reply says where the server really is', async () => {
  const { token, id } = await caseForUpload();
  const a = bytesOf(1024, 0x41);
  await putChunk(id, 0, a, token, sha256(a));

  // Ahead: a piece went missing, and appending would leave a hole.
  const ahead = await putChunk(id, 9999, bytesOf(512, 0x43), token);
  assert.equal(ahead.status, 409);
  assert.equal(ahead.body.bytes, 1024, 'the error carries the true offset so the client can re-sync');

  // Behind: the chunk landed but its reply was lost, so the client resent it.
  const behind = await putChunk(id, 0, a, token, sha256(a));
  assert.equal(behind.status, 409);
  assert.equal(behind.body.bytes, 1024, 'a duplicate must not be appended twice');
});

test('an interrupted upload resumes from where it stopped, not from zero', async () => {
  const { token, id } = await caseForUpload();
  const first = bytesOf(4096, 0x41);
  await putChunk(id, 0, first, token, sha256(first));

  // Stand in for a dropped connection and a fresh page load: the client knows
  // nothing, and asks.
  const resume = await api(`/api/cases/${id}/slide/upload`, { token });
  assert.equal(resume.body.bytes, 4096, 'the bytes already sent are still there');

  const rest = bytesOf(1024, 0x42);
  assert.equal((await putChunk(id, 4096, rest, token, sha256(rest))).body.bytes, 5120);
});

test('a corrupted chunk is rejected before it is written', async () => {
  const { token, id } = await caseForUpload();
  const good = bytesOf(1024, 0x41);
  await putChunk(id, 0, good, token, sha256(good));

  const bad = await putChunk(id, 1024, bytesOf(1024, 0x42), token, sha256(bytesOf(1024, 0x99)));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /checksum/i);

  const after = await api(`/api/cases/${id}/slide/upload`, { token });
  assert.equal(after.body.bytes, 1024, 'the bad chunk must not have been appended');
});

test('finishing with the wrong byte count is refused and the partial discarded', async () => {
  const { token, id } = await caseForUpload();
  const part = bytesOf(2048, 0x41);
  await putChunk(id, 0, part, token, sha256(part));

  // The size the client claims is the only way to catch an upload that stopped
  // cleanly on a chunk boundary — every individual piece was intact.
  const done = await api(`/api/cases/${id}/slide/upload/complete`, {
    method: 'POST', token, body: { size: 999999, name: 'slide.tiff' },
  });
  assert.equal(done.status, 400);

  const after = await api(`/api/cases/${id}/slide/upload`, { token });
  assert.equal(after.body.bytes, 0, 'bytes we cannot trust are thrown away, not left to confuse');
});

test('a file OpenSlide cannot read is never marked ready', async () => {
  const { token, id } = await caseForUpload();
  const fake = bytesOf(4096, 0x41);          // named .tiff, but not a slide
  await putChunk(id, 0, fake, token, sha256(fake));

  const done = await api(`/api/cases/${id}/slide/upload/complete`, {
    method: 'POST', token, body: { size: 4096, name: 'slide.tiff' },
  });
  assert.equal(done.status, 422, 'the size was right, but the content is not a slide');

  const meta = await api(`/api/cases/${id}`, { token });
  assert.notEqual(meta.body.slideStatus, 'ready');
});

test('cancelling discards the bytes and clears the slide, but keeps the patient', async () => {
  const { token, id } = await caseForUpload();
  const part = bytesOf(4096, 0x41);
  await putChunk(id, 0, part, token, sha256(part));

  const cancelled = await api(`/api/cases/${id}/slide`, { method: 'DELETE', token });
  assert.equal(cancelled.status, 200);

  const after = await api(`/api/cases/${id}/slide/upload`, { token });
  assert.equal(after.body.bytes, 0, 'the partial upload is gone');

  // The case itself must survive: the CHC Patient ID is unique per centre, so
  // deleting it would stop the same patient being submitted again.
  const meta = await api(`/api/cases/${id}`, { token });
  assert.equal(meta.status, 200);
  assert.equal(meta.body.patient, 'Slide Subject');
  assert.ok(!meta.body.slideStatus, 'the slide fields are cleared, ready for the correct file');
});

test('only a lab attendant can upload a slide', async () => {
  const { token, id } = await caseForUpload();
  const pathToken = await makePathologist();

  assert.equal((await api(`/api/cases/${id}/slide/upload`, { token: pathToken })).status, 403);
  assert.equal((await putChunk(id, 0, bytesOf(16, 0x41), pathToken)).status, 403);
  assert.equal((await api(`/api/cases/${id}/slide`, { method: 'DELETE', token: pathToken })).status, 403);

  const still = await api(`/api/cases/${id}/slide/upload`, { token });
  assert.equal(still.body.bytes, 0);
});

test('an unsupported format is refused before any bytes are sent', async () => {
  const { token, id } = await caseForUpload();
  const res = await api(`/api/cases/${id}/slide/upload?name=holiday.png`, { token });
  assert.equal(res.status, 400, 'told up front, not after twenty minutes of uploading');
  assert.match(res.body.error, /Unsupported slide format/);
});

test('uploading to a case that does not exist is refused', async () => {
  const token = await makeAttendant();
  assert.equal((await api('/api/cases/999999/slide/upload', { token })).status, 404);
  assert.equal((await putChunk(999999, 0, bytesOf(16, 0x41), token)).status, 404);
});
