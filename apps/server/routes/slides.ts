/**
 * routes/slides.ts — whole-slide upload, conversion status, and tile serving.
 * ---------------------------------------------------------------------------
 * Two mount points, deliberately:
 *   /slides/*  the public tile path OpenSeadragon fetches from
 *   /api       upload and status, which belong with the rest of the API
 *
 * Tiles are proxied through this server rather than exposing the Python
 * helper's port, so the browser only ever talks to one origin.
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import fs from 'fs';
import * as db from '../db.ts';
import { authRequired } from '../auth.ts';
import { audit } from '../lib/audit.ts';
import { uploadLimiter } from '../lib/rate-limit.ts';
import { TILE_BASE, upload, isSlideFile } from '../lib/tiles.ts';
import {
  MAX_CHUNK_BYTES, SUGGESTED_CHUNK_BYTES, MAX_SLIDE_BYTES,
  partSize, beginUpload, appendChunk, finalizePart, discardUpload,
  OffsetMismatch, ChecksumMismatch, SizeMismatch, UnsupportedFormat, UploadReplaced,
} from '../lib/chunked-upload.ts';

/** Mounted at /slides — the path OpenSeadragon requests tiles from. */
export const tileRoutes = Router();
/** Mounted at /api — upload and status live with the rest of the API. */
export const slideRoutes = Router();

// Public tile routes — proxied straight through to the Python helper so the
// browser only ever talks to this server (no second port, no extra CORS).
tileRoutes.get('/:caseId/*', authRequired, async (req, res) => {
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

// Attach a whole-slide file (.tiff/.svs/...) to a case that was just created.
// Split out from POST /api/cases because the file is written straight to
// uploads/<caseId>/ as it streams in, so the case id has to exist first.
slideRoutes.post('/cases/:id/slide', authRequired, uploadLimiter, async (req, res, next) => {
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

  // Recorded once the file is safely on disk. Slides are the largest thing
  // anyone puts into this system and the only patient data stored outside the
  // database, so who uploaded which one is worth being able to answer.
  audit(req, 'slide.upload', id, `${file.filename}, ${(file.size / 1e6).toFixed(0)} MB`);

  res.json(await db.getCaseMeta(id));
});

// Poll target for the intake app + pathology queue: how far along is this
// case's slide? Cheap enough to call every few seconds.
slideRoutes.get('/cases/:id/slide-status', authRequired, async (req, res) => {
  const c = await db.getCaseMeta(String(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  res.json({ id: c.id, slideStatus: c.slideStatus, dziUrl: c.dziUrl, slideError: c.slideError });
});


/* ===========================================================================
 * RESUMABLE UPLOAD
 * ---------------------------------------------------------------------------
 * The endpoint above sends a slide as ONE request. On a CHC's uplink that is a
 * connection held open for ten to thirty minutes, and anything interrupting it
 * — wifi roaming, a mobile handover, a NAT timeout — loses the whole upload,
 * because multer deletes the partial file rather than leave something that
 * looks like a finished slide.
 *
 * These four endpoints send it in pieces instead. The rule that makes it safe
 * is that THE SERVER OWNS THE OFFSET: the client asks how many bytes are held
 * and continues from there, rather than assuming. Retries, duplicates and
 * out-of-order arrivals then all reduce to the same answer — "here is what I
 * actually have, carry on from this point".
 *
 *   GET    .../slide/upload           how many bytes do you have?
 *   PATCH  .../slide/upload           here is the next piece
 *   POST   .../slide/upload/complete  that was the last one
 *   DELETE .../slide                  forget it, I picked the wrong file
 *
 * See lib/chunked-upload.ts for the storage rules and the per-case lock.
 */

/**
 * Shared guard for every upload route: the caller must hold a lab-attendant
 * account, and the case must exist.
 *
 * Checked BEFORE any bytes are read, so a request that was never going to be
 * allowed cannot spend a gigabyte of the server's bandwidth first.
 */
async function uploaderOnly(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.user!.role !== 'lab_attendant') {
    res.status(403).json({ error: 'Only a CHC lab attendant account can upload a slide.' });
    return;
  }
  if (!await db.getCaseMeta(String(req.params.id))) {
    res.status(404).json({ error: 'Case not found.' });
    return;
  }
  next();
}

// How much does the server already hold, and how should the client chunk it?
// Called when an upload starts and again after any failure, which is what makes
// resuming possible at all — including from a different browser session, since
// the answer comes from the file on disk rather than from client state.
slideRoutes.get('/cases/:id/slide/upload', authRequired, uploadLimiter, uploaderOnly, async (req, res) => {
  // Rejecting an unreadable format here means the attendant is told before
  // spending twenty minutes uploading, rather than after.
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  if (name && !isSlideFile(name)) {
    return res.status(400).json({ error: 'Unsupported slide format. Expected .tiff, .svs, .ndpi or similar.' });
  }

  // The id identifies the FILE, not the request. It is what stops a partial
  // upload of one file being continued as another — see beginUpload().
  const uploadId = typeof req.query.uploadId === 'string' ? req.query.uploadId : '';
  if (!uploadId) {
    return res.status(400).json({ error: 'uploadId is required to start or resume an upload.' });
  }
  const size = Number(req.query.size);

  res.json({
    bytes: await beginUpload(String(req.params.id), uploadId, name, Number.isFinite(size) ? size : 0),
    chunkSize: SUGGESTED_CHUNK_BYTES,
    maxChunk: MAX_CHUNK_BYTES,
    maxSize: MAX_SLIDE_BYTES,
  });
});

// One piece of the file, as a raw body.
//
// Raw rather than multipart: there is exactly one thing in the request, so
// parsing form boundaries around it would be pure overhead.
//
// NOT rate limited, unlike the other routes here. A 1.2 GB slide is ~250 of
// these by design, and a limiter counting them would throttle a legitimate
// upload into failure. Abuse is bounded instead by MAX_SLIDE_BYTES, which caps
// what any single case can ever consume.
slideRoutes.patch(
  '/cases/:id/slide/upload',
  authRequired,
  uploaderOnly,
  express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }),
  async (req, res) => {
    const id = String(req.params.id);
    const offset = Number(req.get('Upload-Offset'));
    const checksum = req.get('Upload-Checksum') || undefined;
    const uploadId = req.get('Upload-Id') || '';
    const chunk = req.body as Buffer;

    if (!Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'Upload-Offset header is missing or not a whole number.' });
    }
    if (!uploadId) {
      return res.status(400).json({ error: 'Upload-Id header is missing.' });
    }
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      return res.status(400).json({ error: 'Chunk body was empty.' });
    }

    try {
      res.json({ bytes: await appendChunk(id, uploadId, offset, chunk, checksum) });
    } catch (e) {
      // 409 carries the server's real byte count, so the client re-synchronises
      // from the error itself rather than having to ask again. This is the path
      // taken whenever a response was lost in flight and the client resent a
      // chunk that had in fact already landed.
      // Another file's partial was sitting here. It has been discarded, and the
      // same 409 shape tells the client to begin again from zero.
      if (e instanceof UploadReplaced) {
        return res.status(409).json({ error: e.message, bytes: 0 });
      }
      if (e instanceof OffsetMismatch) {
        return res.status(409).json({ error: e.message, bytes: e.bytes });
      }
      if (e instanceof ChecksumMismatch) {
        return res.status(400).json({ error: e.message, bytes: await partSize(id) });
      }
      console.error(`[slide] chunk failed for case ${id}: ${(e as Error).message}`);
      res.status(500).json({ error: (e as Error).message });
    }
  },
);

// The last piece has landed. Verify, name the file properly, and only then let
// the case appear as having a slide.
slideRoutes.post('/cases/:id/slide/upload/complete', authRequired, uploadLimiter, uploaderOnly, async (req, res) => {
  const id = String(req.params.id);
  const { size, name, uploadId } = req.body as { size?: number; name?: string; uploadId?: string };

  if (!Number.isInteger(size) || (size as number) <= 0) {
    return res.status(400).json({ error: 'A whole-number byte size is required to finish an upload.' });
  }
  if (!name) return res.status(400).json({ error: 'The original filename is required to finish an upload.' });
  if (!uploadId) return res.status(400).json({ error: 'uploadId is required to finish an upload.' });

  let finalPath: string;
  try {
    // Size is checked against what the client says it sent. Per-chunk checksums
    // cannot catch a truncated upload that stopped cleanly on a boundary —
    // every piece was intact, there were simply fewer of them — so this is the
    // check that catches it.
    ({ path: finalPath } = await finalizePart(id, uploadId, name, size as number));
  } catch (e) {
    // Anything wrong here means the bytes on disk are not a slide we can trust,
    // so they go rather than linger as a confusing half-case.
    await discardUpload(id).catch(() => {});
    await db.clearSlide(id).catch(() => {});
    if (e instanceof UploadReplaced)    return res.status(409).json({ error: e.message, bytes: 0 });
    if (e instanceof SizeMismatch)      return res.status(400).json({ error: e.message, bytes: e.actual });
    if (e instanceof UnsupportedFormat) return res.status(400).json({ error: e.message });
    console.error(`[slide] finalize failed for case ${id}: ${(e as Error).message}`);
    return res.status(500).json({ error: (e as Error).message });
  }

  await db.setSlidePending(id, finalPath);

  // Confirm OpenSlide can actually open it before telling anyone it is ready.
  // Unlike the single-request endpoint this is AWAITED: the upload is already
  // finished, so there is nothing to keep waiting, and the attendant gets a
  // definitive answer instead of a success message for a file that turns out
  // to be unreadable.
  try {
    const probe = await fetch(`${TILE_BASE}/slides/${id}/slide.dzi`);
    // Deliberately specific about the two likely causes. The old wording ("could
    // not be read as a slide image") sent us looking for a corrupt upload when
    // the file was simply the wrong kind of TIFF, and vice versa.
    if (!probe.ok) {
      throw new Error(
        'The file uploaded completely, but OpenSlide could not open it. It is either '
        + 'an ordinary image rather than a tiled whole-slide scan, or the original file is damaged.',
      );
    }
  } catch (e) {
    const message = (e as Error).message.includes('OpenSlide could not open it')
      ? (e as Error).message
      : 'Slide tile service is unavailable.';
    await db.setSlideFailed(id, message);
    return res.status(422).json({ error: message });
  }

  await db.setSlideReady(id, `/slides/${id}/slide.dzi`);
  audit(req, 'slide.upload', id, `${name}, ${((size as number) / 1e6).toFixed(0)} MB, resumable`);
  console.log(`[slide] case ${id} ready (${name}, ${((size as number) / 1e9).toFixed(2)} GB, resumable)`);
  res.json(await db.getCaseMeta(id));
});

// Cancel: the attendant picked the wrong file, or wants to abandon a transfer.
//
// Removes BOTH a partial upload and a finished slide, so the same control works
// whether they notice the mistake after two chunks or after the whole thing
// uploaded. The case row itself is kept and its slide fields cleared, because
// the patient details are still wanted — what is being undone is the file, not
// the registration. That also leaves the case ready to accept the right slide
// immediately, with nothing to re-enter.
slideRoutes.delete('/cases/:id/slide', authRequired, uploaderOnly, async (req, res) => {
  const id = String(req.params.id);
  const held = await partSize(id);
  await discardUpload(id);
  await db.clearSlide(id);
  audit(req, 'slide.cancel', id, held ? `discarded ${(held / 1e6).toFixed(0)} MB partial` : 'discarded slide');
  res.json(await db.getCaseMeta(id));
});
