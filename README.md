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

The backend needs PostgreSQL. Install it, then create the database once:

```bash
psql -U postgres -c "CREATE DATABASE telepathology"
```

Copy `apps/server/.env.example` to `apps/server/.env` and set `DATABASE_URL` to
point at it. Tables are created automatically on first boot, so there is no
migration step to run.

Then run the API and whichever front-end you need, each in its own terminal:

```bash
npm run dev -w apps/server              # API on http://localhost:3001
npm run dev -w apps/pathology-viewer    # viewer on http://localhost:5173
npm run dev -w apps/chc-intake          # intake — Vite takes the next free port
```

Whole-slide `.tiff` viewing additionally needs Python and OpenSlide — see
[Whole-slide images](#whole-slide-images) below. Everything else works without
it.

Root-level scripts run across every workspace:

```bash
npm run build       # production builds
npm run typecheck   # TypeScript across all three packages
npm test            # backend API test suite
```

`npm test` never touches your real data. It derives a separate `_test` database
from `DATABASE_URL`, creates it if missing, and refuses to run if the two ever
resolve to the same name.

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

### Database

**PostgreSQL**, accessed through **Drizzle ORM**. All the SQL lives in one file
(`apps/server/postgres.ts`) and nothing above it builds a query.

`DATABASE_URL` is required — the server exits with an explanatory message
rather than starting in a half-working state. Schema creation happens on every
boot with `CREATE TABLE IF NOT EXISTS`, so a fresh database is usable straight
away and an existing one is left alone.

The set of queries the rest of the server may call is declared once as a
TypeScript interface (`DataDriver` in `apps/server/types.ts`), which
`postgres.ts` asserts itself against. Adding a query means declaring it there
too, so the interface stays an accurate description of the data layer rather
than drifting out of date.

Backups run at startup and then daily, via `pg_dump`, keeping the newest seven.
Set `PG_DUMP` if it is not on PATH — the Windows installer does not add it.

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

Copy `apps/server/.env.example` to `apps/server/.env`. `DATABASE_URL` is the
only required value; the file documents the rest. Two worth knowing about:

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
- **PostgreSQL** with **Drizzle ORM**
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
| `types.ts` | Domain types and the `DataDriver` contract the data layer implements. |
| `db.ts` | Opens the database, creates missing tables, re-exports the data API. |
| `postgres.ts` | Every SQL query in the project, written with Drizzle. |
| `schema.ts` | Drizzle table definitions. |
| `mailer.ts` | Sending password-reset codes over SMTP. |
| `tools/tile_server.py` | On-demand Deep Zoom tiling of whole-slide files. |
| `test/api.test.ts` | API test suite; runs against a throwaway database it creates. |
