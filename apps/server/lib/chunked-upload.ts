/**
 * lib/chunked-upload.ts — resumable slide upload, in pieces.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS. A slide is uploaded as one HTTP request by the original
 * endpoint (POST /api/cases/:id/slide), which means the connection has to
 * survive from the first byte to the last — ten to thirty minutes for a real
 * scanner file on a CHC's uplink. Anything that interrupts it (wifi roaming
 * between access points, a mobile handover, a NAT timeout) aborts the request,
 * and multer then deletes the partial file, because a half-written file named
 * slide.tiff would look like a finished slide and that is the worst possible
 * outcome. So every failure costs the whole upload.
 *
 * Measured on the deployment server, a 766 MB upload aborted twice in a row
 * about four minutes in, leaving three empty case directories behind.
 *
 * The fix is to stop holding one connection open for the whole file. The
 * browser sends it in ~5 MB pieces, each its own short request, and THE SERVER
 * IS THE SOURCE OF TRUTH FOR HOW MUCH IT HAS — the client asks rather than
 * assuming. A dropped connection then costs one piece instead of the file, so
 * the client can simply retry and the attendant never sees an error.
 *
 * Bytes accumulate in `slide.part`. Only once the byte count is confirmed does
 * it become `slide.<ext>`, so a partial upload can never be mistaken for a
 * viewable slide — the same guarantee multer's cleanup was protecting, kept
 * without throwing the progress away.
 */
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { UPLOADS_DIR, isSlideFile, releaseSlide } from './tiles.ts';

/** Largest single piece the server will accept. The client sends 5 MB; the
 *  headroom lets a future client raise its chunk size without a server change. */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** What the client is told to use. Small enough that one retry is cheap, large
 *  enough that a 1.2 GB slide isn't 12,000 round trips. */
export const SUGGESTED_CHUNK_BYTES = 5 * 1024 * 1024;
/** Matches the ceiling on the original multer path, so neither route is the
 *  odd one out. */
export const MAX_SLIDE_BYTES = 20 * 1024 * 1024 * 1024;
/** A `.part` untouched for this long belongs to an upload nobody is coming
 *  back to finish. Generous on purpose: a CHC may well leave one running
 *  overnight on a slow line, and deleting live work would be far worse than
 *  keeping dead bytes a while longer. */
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

const PART_NAME = 'slide.part';

/* --- Typed failures ---------------------------------------------------------
 * The route layer maps these onto status codes. They carry the server's real
 * state with them, so the client can re-synchronise from the error rather than
 * having to make a second request to find out what went wrong.
 *
 * NOTE the long-hand fields. The obvious spelling is a parameter property —
 * `constructor(public readonly bytes: number)` — and it does not work here.
 * `npm start` runs this through tsx, which transpiles fully, but the test
 * harness spawns the server with plain `node`, and Node runs .ts files by
 * ERASING types rather than compiling them. A parameter property needs code
 * GENERATED (`this.bytes = bytes`), so Node rejects the file outright with
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX — and because it fails at parse time the
 * server dies before printing anything, which looks like it never started.
 *
 * Same reason there are no enums or namespaces anywhere in this package.
 */
export class OffsetMismatch extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`Upload offset does not match the server (it holds ${bytes} bytes).`);
    this.bytes = bytes;
  }
}
export class ChecksumMismatch extends Error {
  constructor() { super('Chunk failed its checksum — it arrived corrupted.'); }
}
export class SizeMismatch extends Error {
  readonly actual: number;
  readonly expected: number;
  constructor(actual: number, expected: number) {
    super(`Upload is ${actual} bytes but ${expected} were expected.`);
    this.actual = actual;
    this.expected = expected;
  }
}
export class UnsupportedFormat extends Error {
  constructor() { super('Unsupported slide format. Expected .tiff, .svs, .ndpi or similar.'); }
}
/**
 * The partial upload held for this case belongs to a DIFFERENT file, so it has
 * been discarded and the client must start from zero.
 *
 * See the note on `beginUpload` for why this matters: without it, resuming
 * would splice two different files together into something of exactly the
 * expected length and entirely unreadable.
 */
export class UploadReplaced extends Error {
  readonly bytes = 0;
  constructor() {
    super('A partial upload of a different file was held for this case and has been discarded. Starting again from the beginning.');
  }
}

/**
 * The directory for one case's slide.
 *
 * The id reaches here from a URL, and it is about to become a filesystem path,
 * so it is checked against a strict pattern rather than escaped. A value like
 * `../../etc` has no legitimate use and is rejected outright.
 */
function caseDir(caseId: string | number): string {
  const id = String(caseId);
  if (!/^[0-9]+$/.test(id)) throw new Error('Invalid case id.');
  return path.join(UPLOADS_DIR, id);
}

export function partPath(caseId: string | number): string {
  return path.join(caseDir(caseId), PART_NAME);
}

/** Bytes already received, or 0 when nothing has been. */
export async function partSize(caseId: string | number): Promise<number> {
  try {
    return (await fsp.stat(partPath(caseId))).size;
  } catch {
    return 0;   // no part file yet — a fresh upload
  }
}

/* --- Whose bytes are these? -------------------------------------------------
 * A `.part` on its own records only HOW MANY bytes a case holds, never WHICH
 * FILE they came from — and that gap is enough to corrupt a slide silently.
 *
 * Upload file A, get 50 MB in, and stop without cancelling (an error, a closed
 * tab). Later upload file B to the same case. The client asks for the offset,
 * the server truthfully answers 50 MB, and the client sends B FROM BYTE 50 MB
 * ONWARDS. The result is A's first 50 MB followed by B's remainder — and it is
 * exactly B's declared length, so the size check at completion passes. A file
 * of the right size, made of two different files, which no reader can open.
 *
 * So the identity of the file is recorded next to its bytes. The client derives
 * an id from the name, the byte length and a hash of the head of the file, and
 * every request carries it. A mismatch means these bytes are somebody else's:
 * they are thrown away and the upload restarts, which costs the transfer but
 * can never produce a corrupt slide.
 */
interface PartMeta {
  uploadId: string;
  name: string;
  size: number;
  startedAt: string;
}

const META_NAME = 'slide.part.json';

function metaPath(caseId: string | number): string {
  return path.join(caseDir(caseId), META_NAME);
}

async function readMeta(caseId: string | number): Promise<PartMeta | null> {
  try {
    return JSON.parse(await fsp.readFile(metaPath(caseId), 'utf8')) as PartMeta;
  } catch {
    return null;   // absent, or unreadable — treated the same, see below
  }
}

async function writeMeta(caseId: string | number, meta: PartMeta): Promise<void> {
  await fsp.mkdir(caseDir(caseId), { recursive: true });
  await fsp.writeFile(metaPath(caseId), JSON.stringify(meta));
}

/** Drop the partial upload and its metadata, leaving any finished slide alone. */
async function dropPart(caseId: string | number): Promise<void> {
  await fsp.rm(partPath(caseId), { force: true });
  await fsp.rm(metaPath(caseId), { force: true });
}

/**
 * Reconcile what the server holds against the file the client is about to send,
 * and report where to continue from.
 *
 * Returns the resumable byte count when the stored partial belongs to this same
 * file, and 0 otherwise — having first thrown the other file's bytes away.
 *
 * A `.part` with NO metadata is treated as a stranger's. That covers uploads
 * begun before this identity check existed, which are exactly the ones that
 * could splice.
 */
export function beginUpload(
  caseId: string | number,
  uploadId: string,
  name: string,
  size: number,
): Promise<number> {
  return withCaseLock(caseId, async () => {
    const held = await partSize(caseId);
    if (held > 0) {
      const meta = await readMeta(caseId);
      if (meta && meta.uploadId === uploadId) return held;   // same file: resume
      await dropPart(caseId);                                // different file: void
    }
    await writeMeta(caseId, { uploadId, name, size, startedAt: new Date().toISOString() });
    return 0;
  });
}

/* --- One writer at a time, per case -----------------------------------------
 * Two chunks for the same case arriving together would each read the current
 * size, each decide they are next, and both append — silently producing a file
 * with a duplicated section and the right length. Nothing downstream would
 * notice until a pathologist opened a corrupt slide.
 *
 * Serialising per case removes the race. Different cases still upload in
 * parallel, which is what actually matters: the lock is per patient, not
 * global.
 */
const chains = new Map<string, Promise<void>>();

function withCaseLock<T>(caseId: string | number, fn: () => Promise<T>): Promise<T> {
  const key = String(caseId);
  const prev = chains.get(key) ?? Promise.resolve();
  // `.then(fn, fn)` so a rejected predecessor still lets the next one run —
  // otherwise one failed chunk would wedge that case's queue permanently.
  const run = prev.then(fn, fn);
  const settled = run.then(() => {}, () => {});
  chains.set(key, settled);
  // Drop the entry once it is idle, so a long-lived server doesn't accumulate
  // one resolved promise per case it has ever seen.
  void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return run;
}

/**
 * Append one piece and report the new total.
 *
 * `offset` is what the client believes the server holds. It must match exactly:
 *
 *   offset  <  size   the client is behind — its previous chunk landed but the
 *                     response was lost, so this is a duplicate
 *   offset  >  size   the client is ahead — a chunk went missing and appending
 *                     would leave a hole in the middle of the file
 *
 * Both are answered with OffsetMismatch carrying the true size, and the client
 * simply continues from there. That one rule is what makes the whole scheme
 * safe against retries, duplicates and reordering alike.
 */
export function appendChunk(
  caseId: string | number,
  uploadId: string,
  offset: number,
  chunk: Buffer,
  sha256?: string,
): Promise<number> {
  return withCaseLock(caseId, async () => {
    await fsp.mkdir(caseDir(caseId), { recursive: true });

    // Checked on EVERY chunk, not just when the upload starts. Testing this
    // found the gap: once a second file had taken the case over, the partial was
    // back to zero bytes, so a size-based guard let the FIRST file's client keep
    // writing — into the second file's slot.
    //
    // So the claim decides, not the byte count.
    const meta = await readMeta(caseId);
    const current = await partSize(caseId);

    if (meta) {
      // Claimed. Only the owner may extend it — and note this does NOT discard,
      // because the bytes belong to whoever claimed them. A stray request from
      // some other upload must not be able to destroy their progress. Taking a
      // case over is a deliberate act, and it happens in beginUpload().
      if (meta.uploadId !== uploadId) throw new UploadReplaced();
    } else if (current > 0) {
      // Bytes with no recorded owner: written before this check existed, or the
      // metadata was lost. They cannot be shown to belong to this upload, so
      // they go rather than risk splicing two files together.
      await dropPart(caseId);
      throw new UploadReplaced();
    } else {
      // Nothing here at all — this upload claims the case.
      await writeMeta(caseId, { uploadId, name: '', size: 0, startedAt: new Date().toISOString() });
    }

    if (offset !== current) throw new OffsetMismatch(current);

    if (current + chunk.length > MAX_SLIDE_BYTES) {
      throw new Error(`Slide exceeds the ${MAX_SLIDE_BYTES / 1e9} GB limit.`);
    }

    // Verified BEFORE the write, so a corrupted piece never reaches the file.
    // TLS already protects the bytes in transit; this also catches a client
    // slicing the wrong range, which TLS cannot.
    if (sha256) {
      const actual = crypto.createHash('sha256').update(chunk).digest('hex');
      if (actual !== sha256.toLowerCase()) throw new ChecksumMismatch();
    }

    await fsp.appendFile(partPath(caseId), chunk);
    return current + chunk.length;
  });
}

/**
 * Turn a completed `.part` into the real slide file.
 *
 * The size is checked against what the client says it sent, which catches a
 * truncated upload that happened to end on a chunk boundary — the one failure
 * the per-chunk checksums cannot see, because every individual piece was
 * intact.
 */
export function finalizePart(
  caseId: string | number,
  uploadId: string,
  originalName: string,
  expectedSize: number,
): Promise<{ path: string; size: number }> {
  return withCaseLock(caseId, async () => {
    if (!isSlideFile(originalName)) throw new UnsupportedFormat();

    // The bytes must belong to the file being finished. Without this a client
    // could complete an upload over another file's partial that happened to
    // reach the same length.
    const meta = await readMeta(caseId);
    if (!meta || meta.uploadId !== uploadId) {
      await dropPart(caseId);
      throw new UploadReplaced();
    }

    const size = await partSize(caseId);
    if (size !== expectedSize) throw new SizeMismatch(size, expectedSize);

    const dir = caseDir(caseId);
    // Clear out any earlier slide for this case. Re-uploading after picking the
    // wrong file must not leave the previous one behind — with a different
    // extension it would still be there, and find_slide_file() in the tile
    // service takes the first file it sees.
    for (const name of await fsp.readdir(dir)) {
      if (name !== PART_NAME && name !== META_NAME) {
        await fsp.rm(path.join(dir, name), { force: true, recursive: true });
      }
    }

    const finalPath = path.join(dir, `slide${path.extname(originalName).toLowerCase()}`);
    await fsp.rename(partPath(caseId), finalPath);
    await fsp.rm(metaPath(caseId), { force: true });   // the upload is over
    return { path: finalPath, size };
  });
}

/**
 * How many bytes this case is occupying on disk, across every file it holds.
 *
 * Measured BEFORE a delete so the audit entry can record what was reclaimed —
 * afterwards there is nothing left to measure.
 */
export async function caseDiskUsage(caseId: string | number): Promise<number> {
  let total = 0;
  try {
    for (const name of await fsp.readdir(caseDir(caseId))) {
      try { total += (await fsp.stat(path.join(caseDir(caseId), name))).size; } catch { /* vanished */ }
    }
  } catch {
    return 0;   // no directory for this case
  }
  return total;
}

/**
 * Throw away everything on disk for a case's slide — the partial upload and
 * any finished file.
 *
 * Used by cancel, and by the failure paths, so a rejected upload never leaves
 * bytes lying around. Takes the same lock as the writers, so it cannot run
 * half-way through an append.
 */
export function discardUpload(caseId: string | number): Promise<void> {
  return withCaseLock(caseId, async () => {
    await fsp.rm(caseDir(caseId), { recursive: true, force: true });
    // Removing the file is not enough while the tile service still has it
    // open: the space stays in use, and the old slide stays on screen.
    await releaseSlide(caseId);
  });
}

/**
 * The case ids that currently have a directory under UPLOADS_DIR.
 *
 * Only numeric names are returned, because only those were created by this
 * server. Anything else a human has put there is left alone.
 */
export async function listStoredCases(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(UPLOADS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && /^[0-9]+$/.test(e.name)).map((e) => e.name);
  } catch {
    return [];   // uploads dir not created yet
  }
}

/**
 * Delete `.part` files nothing has written to in a long time.
 *
 * Without this, every abandoned upload keeps its bytes forever — and these are
 * gigabyte-scale files on the same disk as the slides that matter. Runs at
 * startup and then daily, next to the database backups.
 *
 * Deliberately keyed on mtime rather than age-since-creation: an upload that
 * is still receiving chunks has a recent mtime however long ago it started, so
 * a slow overnight transfer is never mistaken for a dead one.
 */
export async function sweepAbandonedParts(maxAgeMs = ABANDONED_AFTER_MS): Promise<number> {
  let entries;
  try {
    entries = await fsp.readdir(UPLOADS_DIR, { withFileTypes: true });
  } catch {
    return 0;   // uploads dir not created yet
  }

  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/.test(entry.name)) continue;
    const p = path.join(UPLOADS_DIR, entry.name, PART_NAME);
    try {
      const st = await fsp.stat(p);
      if (st.mtimeMs >= cutoff) continue;
      await fsp.rm(p, { force: true });
      await fsp.rm(path.join(UPLOADS_DIR, entry.name, META_NAME), { force: true });
      removed++;
    } catch {
      // No part file for this case, or it vanished between stat and rm.
    }
  }
  return removed;
}
