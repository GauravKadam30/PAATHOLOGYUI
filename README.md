# Telepathology Console

A web system for reviewing FNAC (Fine Needle Aspiration Cytology) slides
remotely: a CHC lab attendant registers a patient and uploads the slide, and a
pathologist opens it in a deep-zoom viewer, annotates it, and records their
consultation — with the two sides kept in sync through a shared backend.

This repository is an **npm workspace** (monorepo) with three packages under
`apps/`:

| App | Purpose |
| --- | --- |
| [`chc-intake`](apps/chc-intake) | The CHC portal — lab attendants register a patient and upload the slide image. |
| [`pathology-viewer`](apps/pathology-viewer) | The pathologist portal — worklist, deep-zoom slide viewer, annotation, and consultation notes. |
| [`server`](apps/server) | One Express API shared by both front-ends: accounts, cases, notes, annotations, and whole-slide tiling. |

## Getting started

```bash
npm install
```

Then run the API and whichever front-end you need, each in its own terminal:

```bash
npm run dev -w apps/server              # API on http://localhost:3001
npm run dev -w apps/pathology-viewer    # viewer on http://localhost:5173
npm run dev -w apps/chc-intake          # intake — Vite takes the next free port
```

Nothing else needs installing to get going — the backend defaults to a local
SQLite file, so there is no database to set up. (Whole-slide `.tiff` viewing is
the one exception; see [Whole-slide images](#whole-slide-images) below.)

Root-level scripts run across every workspace:

```bash
npm run build       # production builds
npm run typecheck   # TypeScript across all three packages
npm test            # backend API test suite
```

## The pathologist app

Three routes, served by React Router so every screen is linkable and the
browser Back button behaves:

| Route | Screen |
| --- | --- |
| `/queue` | The FNAC worklist — search by patient name or CHC Patient ID. |
| `/case/:caseId/slide` | The slide viewer with annotation tools. |
| `/case/:caseId/report` | Clinical notes and consultations for that patient. |

### Slide viewing

- **OpenSeadragon** deep zoom over either an ordinary uploaded photo or a
  gigapixel scanner slide.
- **Micron scale bar** and **magnification presets** (4×, 10×, 20×, 40×), based
  on the slide's own metadata, so on-screen size means something clinically.
- Custom zoom / reset / full-screen controls; full screen exits with Esc or the
  browser Back button.

### Annotation

- Tools: **Freehand**, **Rectangle**, **Oval**, and an element **Eraser**, with
  an 8-colour palette.
- Annotations are stored in **image coordinates**, so they stay anchored to the
  tissue through any amount of zooming and panning.
- They are saved as **vector data**, not a flattened picture — a two-shape
  annotation is about a kilobyte rather than the ~16 MB a composited PNG used
  to cost. That also means they remain editable after reloading, and the
  original slide is never altered.
- The report screen can show the slide with its annotations, and toggle them
  on and off for comparison against the untouched image.

### Clinical notes

Clinical Notes, Pathologist Consultation, and Medicine Consultation are saved
per patient, each as **its own row** — two people editing different cases (or
different sections of one case) cannot overwrite each other.

## The backend

`apps/server` is an Express API covering:

- **Accounts** — sign-up, login, password reset by emailed code, and token
  revocation. One users table serves both portals, separated by `role`, so the
  same person can hold a lab-attendant *and* a pathologist account.
- **Cases** — the patients submitted from intake, with archive/restore rather
  than deletion, and `?since=` polling so the worklist fetches only what
  changed.
- **Notes and annotations** — one row per case per kind.
- **Whole-slide images** — large scanner files streamed to disk and served as
  Deep Zoom tiles by a supervised Python child process.
- **Backups** — a database snapshot at startup and then daily.

### Database: SQLite by default, PostgreSQL when you want it

The data layer has two interchangeable drivers and picks between them at
startup based on one environment variable:

| `DATABASE_URL` | Driver |
| --- | --- |
| unset (default) | **SQLite** — a local `data.db` file, nothing to install. |
| set | **PostgreSQL** via Drizzle ORM. |

Both are first-class: the same test suite runs green against either. A shared
TypeScript interface (`apps/server/types.ts`) forces the two drivers to expose
identical functions and return shapes, so they cannot quietly drift apart.

To switch to PostgreSQL, create the database, set `DATABASE_URL` in
`apps/server/.env` (see `.env.example`), and copy any existing data across:

```bash
node tools/migrate-sqlite-to-postgres.js --dry-run   # preview
node tools/migrate-sqlite-to-postgres.js             # copy
```

The migration only ever reads the SQLite file, so it stays intact and usable as
a fallback.

### Whole-slide images

Scanner formats (`.tiff`, `.svs`, `.ndpi`, `.mrxs`, …) are tiled **on demand**
by a small Python service that the API starts and supervises. Pre-generating
tiles for one 1.2 GB slide took roughly 20 minutes and 2.2 GB of disk; tiling
on demand opens the same slide in seconds and stores nothing extra.

It needs Python with:

```bash
pip install openslide-bin pillow
```

Without it, everything else still works — ordinary uploaded photos are
unaffected, and only `.tiff` viewing is unavailable.

### Configuration

Copy `apps/server/.env.example` to `apps/server/.env`. Every value is optional;
the file documents what each one does. Two worth knowing about:

- `JWT_SECRET` — **required** when `NODE_ENV=production`; the server refuses to
  start without it rather than fall back to a key published in this repository.
- SMTP settings — unset means password-reset codes are printed to the server
  console instead of emailed, which is what you want locally.

### Pointing a front-end at a different API

Create `apps/pathology-viewer/.env` (or the same in `apps/chc-intake`):

```
VITE_API_URL=https://your-backend-host.example.com
```

Restart the dev server after changing it.

## Tech stack

- **TypeScript** across all three packages, in strict mode
- **React 18** + **Vite 7** + **Tailwind CSS 4**
- **React Router 7** — real routes and deep links
- **TanStack Query 5** — server state, caching, and background refetching
- **OpenSeadragon 6** — deep-zoom slide rendering
- **Fabric.js 7** — the annotation canvas
- **Express 4** on **Node 24**
- **SQLite** (`node:sqlite`) or **PostgreSQL** (**Drizzle ORM**)
- **OpenSlide** — reading gigapixel scanner formats
- **lucide-react** — icons

## Source layout

### `apps/pathology-viewer/src`

| File | Responsibility |
| --- | --- |
| `main.tsx` | Entry point — mounts React and the query client. |
| `App.tsx` | Routes, the auth gate, and the login screen switch. |
| `TelepathologyDashboard.tsx` | The three screens and the state they share. |
| `WsiViewer.tsx` | Slide viewer, annotation engine, scale bar, and save API. |
| `annotations.ts` | Converting fabric objects to and from image coordinates. |
| `queries.ts` | TanStack Query hooks — every server read and write. |
| `api.ts` | Thin fetch client for the backend. |
| `types.ts` | Shared domain types. |

### `apps/server`

| File | Responsibility |
| --- | --- |
| `server.ts` | The route table — which URL does what, and who may call it. |
| `auth.ts` | Password hashing, token issuing, and the `authRequired` guard. |
| `types.ts` | Domain types and the `DataDriver` contract both drivers implement. |
| `db.ts` | Picks a driver at startup based on `DATABASE_URL`. |
| `drivers/sqlite.ts` | The SQLite implementation, including schema migrations. |
| `drivers/postgres.ts` | The PostgreSQL implementation, via Drizzle. |
| `schema.ts` | Drizzle table definitions. |
| `mailer.ts` | Sending password-reset codes over SMTP. |
| `tools/tile_server.py` | On-demand Deep Zoom tiling of whole-slide files. |
| `test/api.test.ts` | API test suite; runs against either database. |
