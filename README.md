# Telepathology Console

A web-based telepathology viewer for reviewing FNAC (Fine Needle Aspiration
Cytology) whole-slide images, annotating them, and recording clinical notes.

This repository is an **npm workspace** (monorepo) with two apps under `apps/`:

| App | Purpose |
| --- | --- |
| [`pathology-viewer`](apps/pathology-viewer) | The main slide viewer + annotation + consultation UI (the focus of this project). |
| [`chc-intake`](apps/chc-intake) | A separate static patient-intake form mock-up (the upstream step where a case is registered). |

## Getting started

```bash
# from the repository root
npm install

# run the pathology viewer
cd apps/pathology-viewer
npm run dev          # starts Vite on http://localhost:5173
```

Other scripts (inside `apps/pathology-viewer`): `npm run build` (production
build into `dist/`), `npm run preview` (serve the build), `npm run lint`.

## The pathology-viewer app

A single-page app with **three screens** (no router — it switches on a `page`
state value in `TelepathologyDashboard.jsx`):

1. **FNAC Queue** — the patient worklist; click a patient to open their slide.
2. **Slide Viewer** — deep-zoom whole-slide image with annotation tools.
3. **Prescription & Info** — per-patient clinical notes and consultations.

### Annotation features

- Tools: **Freehand**, **Rectangle**, **Oval**, and an element **Eraser**.
- An 8-colour palette; a colour and tool must be chosen each session before drawing.
- Drawing is restricted to the slide image; the cursor reverts to normal off-image.
- Annotations are stored in **image coordinates**, so they stay anchored to the
  tissue when you zoom and pan.
- On **Save**, the slide + drawings are composited into a **separate** annotated
  PNG — the original slide is never altered. Saving offers a save/discard dialog.
- Custom zoom / reset / full-screen controls; a custom full-screen mode that
  exits via the Esc key or the browser Back button.

### Clinical notes

- Editable Clinical Notes, Pathologist Consultation, and Medicine Consultation
  fields, saved **per patient**.
- The Pathologist section can view the saved annotated image; the Medicine
  section can view both the annotated image and the saved pathologist notes.
- Saved notes and annotated images are persisted to the browser's
  `localStorage`, so they survive a page reload **on the same machine**.
  (Sharing data between two different machines would require a backend server,
  which this front-end-only prototype does not include.)

## Tech stack

- **React 18** + **Vite 5**
- **OpenSeadragon 6** — deep-zoom slide rendering
- **Fabric.js 7** — the annotation canvas
- **Tailwind CSS 4** — styling
- **lucide-react** — icons

### Source layout (`apps/pathology-viewer/src`)

| File | Responsibility |
| --- | --- |
| `main.jsx` | Entry point — mounts React into `index.html`'s `#root`. |
| `App.jsx` | Thin root wrapper around the dashboard. |
| `TelepathologyDashboard.jsx` | All app state and the three screens. |
| `WsiViewer.jsx` | The slide viewer, annotation engine, and export/save API. |
| `index.css` | Tailwind import + global styles. |

The slide images live in `apps/pathology-viewer/public` and are served from the
site root (e.g. `/IMG-20260525-WA0002.jpg`).
