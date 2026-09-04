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
import { Router } from 'express';
import fs from 'fs';
import * as db from '../db.ts';
import { authRequired } from '../auth.ts';
import { audit } from '../lib/audit.ts';
import { uploadLimiter } from '../lib/rate-limit.ts';
import { TILE_BASE, upload, isSlideFile } from '../lib/tiles.ts';

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

