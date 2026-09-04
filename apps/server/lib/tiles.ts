/**
 * lib/tiles.ts — whole-slide storage and the Deep Zoom tile service.
 * ---------------------------------------------------------------------------
 * Owns everything about slides ON DISK: where they live, which extensions are
 * treated as scanner slides, the multer upload, and the Python child process
 * that serves tiles out of them.
 *
 * Lifted out of server.ts so the route files can stay about routing. The
 * supervision logic in particular is the kind of thing that gets accidentally
 * broken when it sits between unrelated endpoints.
 */
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

// Resolves to apps/server/ — this file lives one level down in lib/.
const __dirname = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Scanner slides (.tiff/.svs/...) are gigapixel-scale, so they are NOT stored
// in the database like ordinary PNG/JPG cases. Instead the uploaded file is
// kept on disk under uploads/<caseId>/, and a small Python helper
// (tools/tile_server.py) reads Deep Zoom tiles out of it on demand — see that
// file for why tiles are served live rather than pre-generated.
// Overridable so the automated tests write slides to a throwaway directory.
export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const TILE_PORT = Number(process.env.TILE_PORT || 3002);
export const TILE_BASE = `http://127.0.0.1:${TILE_PORT}`;
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// File extensions OpenSlide can read. Anything else keeps using the old
// data-URL path (a plain photo of a slide, as before).
const SLIDE_EXTENSIONS = new Set(['.tiff', '.tif', '.svs', '.ndpi', '.scn', '.mrxs', '.vms', '.vmu', '.bif']);
export const isSlideFile = (filename: string) => SLIDE_EXTENSIONS.has(path.extname(String(filename)).toLowerCase());

// Start the tile server as a child process and keep it alive for as long as
// this server runs. It binds to 127.0.0.1 only; browsers reach it through the
// /slides/* proxy below, so there is just one public origin to configure.
// The tile service is supervised: if it dies (crash, OOM, killed) it is
// respawned automatically, because otherwise every whole-slide view stays
// broken until someone notices and restarts the whole backend. Restarts back
// off up to a ceiling so a genuinely broken install doesn't spin in a tight
// loop, and the counter resets once a process has stayed up a while.
let tileProc: ChildProcess | null = null;
let tileShuttingDown = false;
let tileRestarts = 0;
const TILE_RESTART_BASE_MS = 1000;
const TILE_RESTART_MAX_MS = 30_000;
const TILE_HEALTHY_MS = 60_000;   // uptime after which we treat it as stable

export function startTileServer() {
  if (tileShuttingDown) return;
  const script = path.join(__dirname, 'tools', 'tile_server.py');
  const python = process.env.PYTHON || 'python';
  const startedAt = Date.now();

  tileProc = spawn(python, [script, UPLOADS_DIR, String(TILE_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  tileProc.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  tileProc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[tiles] ${d}`));

  tileProc.on('error', (e: Error) => {
    console.error(`[tiles] could not start Python tile server (${e.message}).`);
    console.error('[tiles] Whole-slide (.tiff) viewing is unavailable; ordinary image cases still work.');
  });

  tileProc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    tileProc = null;
    if (tileShuttingDown) return;                  // we killed it on purpose
    if (Date.now() - startedAt > TILE_HEALTHY_MS) tileRestarts = 0;

    const delay = Math.min(TILE_RESTART_BASE_MS * 2 ** tileRestarts, TILE_RESTART_MAX_MS);
    tileRestarts++;
    console.error(`[tiles] exited (code=${code} signal=${signal}); restarting in ${delay}ms (attempt ${tileRestarts})`);
    setTimeout(startTileServer, delay).unref();
  });
}
startTileServer();
// Don't leave an orphaned Python process behind when this server stops.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    tileShuttingDown = true;                       // stop the supervisor respawning it
    try { tileProc?.kill(); } catch { /* already gone */ }
    process.exit(0);
  });
}
process.on('exit', () => {
  tileShuttingDown = true;
  try { tileProc?.kill(); } catch { /* already gone */ }
});

// Multer writes the upload straight to disk in chunks. Sending a 1 GB+ slide
// as base64 JSON (the old path) would balloon it by ~33% and buffer the whole
// thing in memory; this streams it instead. The destination needs the case id,
// which is why uploading a slide is its own request against an already-created
// case (POST /api/cases/:id/slide) rather than one combined submission.
export const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOADS_DIR, String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    // Keep only the extension — OpenSlide picks its reader from that, and it
    // avoids trusting a client-supplied filename as a path.
    filename: (_req, file, cb) => cb(null, `slide${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 * 1024 },   // 20 GB ceiling
});
