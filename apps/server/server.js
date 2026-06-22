/**
 * Telepathology Console — shared backend.
 * ---------------------------------------------------------------------------
 * A tiny key/value API so saved notes and annotated images are stored centrally
 * and therefore SHARED across machines (instead of each browser keeping its own
 * copy). Pure JavaScript — no native modules — so it runs anywhere Node runs.
 *
 * Storage is a single JSON file (data.json) next to this script. That's plenty
 * for a prototype; swap in a real database later without changing the API.
 *
 * API:
 *   GET  /api/store/:key   -> returns the stored JSON value for :key (or {})
 *   PUT  /api/store/:key   -> saves the JSON request body under :key
 *
 * The frontend uses keys: pv_clinicalSaved, pv_pathologistSaved,
 * pv_medicineSaved, pv_annotatedImages — each a { [patientId]: value } map.
 */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3001;

// --- JSON file storage helpers ---
const readAll = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }            // file missing or empty → start fresh
};
const writeAll = (obj) => fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));

const app = express();
app.use(cors());                                  // allow the browser app (any origin) to call this
app.use(express.json({ limit: '50mb' }));         // annotated images are large data-URLs

// Read one key
app.get('/api/store/:key', (req, res) => {
  const db = readAll();
  res.json(db[req.params.key] ?? {});
});

// Save one key (whole value replaced)
app.put('/api/store/:key', (req, res) => {
  const db = readAll();
  db[req.params.key] = req.body;
  writeAll(db);
  res.json({ ok: true });
});

// --- Intake cases ---
// Patients submitted from the CHC intake app, shown in the viewer's queue.
// Each case mirrors the viewer's format: { id, patient, age, gender, site,
// status, date, image } where `image` is a data-URL of the uploaded slide.
app.get('/api/cases', (_req, res) => {
  const db = readAll();
  res.json(db.__cases || []);
});
app.post('/api/cases', (req, res) => {
  const db = readAll();
  const list = db.__cases || [];
  // Assign a stable id (100+) so it never clashes with the viewer's demo cases.
  const newCase = { ...req.body, id: 100 + list.length };
  list.push(newCase);
  db.__cases = list;
  writeAll(db);
  res.json(newCase);
});

// Simple health/landing check
app.get('/', (_req, res) => res.send('Telepathology Console API is running.'));

app.listen(PORT, () => {
  console.log(`Telepathology API listening on http://localhost:${PORT}`);
});
