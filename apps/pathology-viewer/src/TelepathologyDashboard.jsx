/**
 * TelepathologyDashboard — the whole pathology console UI and its state.
 * ---------------------------------------------------------------------------
 * One component renders ONE of three "pages", chosen by the `page` state value
 * (there is no router library — just conditional returns):
 *
 *   'queue'   → the FNAC patient worklist (search, filter, open, remove).
 *   'slide'   → the whole-slide viewer plus the annotation toolbar.
 *   'details' → the per-patient report: clinical, pathologist and medicine notes.
 *
 * WHAT THIS COMPONENT OWNS
 *   • which patient is selected, and which page is showing
 *   • the annotation session (tool, colour, drawing on/off, visibility)
 *   • per-patient notes — a draft copy while typing, plus the saved copy
 *   • per-patient annotations, as VECTOR SHAPES rather than flattened images
 *
 * HOW IT TALKS TO THE BACKEND
 *   Reads are bulk and cheap (`getAllNotes`, `getAllAnnotations`) — one request
 *   fetches everything. WRITES are deliberately per-case (`saveNote`,
 *   `saveAnnotations`): each one touches a single database row, so two people
 *   saving different patients at the same moment can't overwrite each other.
 *   An earlier version wrote every patient's notes back as one blob and could
 *   silently lose a colleague's work.
 *
 *   The worklist polls every 4s but passes a `since` timestamp, so an idle
 *   queue transfers an empty array rather than the whole case list.
 *
 * NOTES ON STRUCTURE
 *   • <WsiViewer/> is lazy-loaded: it pulls in OpenSeadragon and fabric.js,
 *     which are most of the JavaScript here and aren't needed for the queue.
 *   • `viewerApiRef` is the handle onto the viewer — save / discard / export.
 *   • Demo patients (BASE_CASES) are hard-coded here and exist only in the
 *     browser; everything else comes from the server. That's why they can't
 *     be deleted and have no CHC ID.
 *
 * Theme: dark navy navigation rail + indigo accent, with clinical figures
 * (IDs, ages, dates) in a monospaced font.
 */
import React, { useState, useRef, useEffect } from 'react';
// Icons used across the UI (tree-shaken from the lucide icon set).
import {
  Clock, Pencil, PencilOff, Square, Circle, Eraser, ArrowLeft, FileText, Download,
  Microscope, ChevronRight, ClipboardList, Stethoscope, Pill, ShieldCheck,
  Save, Eye, FileImage, Check, X, Loader2,
  ListChecks, Images, Search, LogOut, AlertCircle, EyeOff, Trash2,
} from 'lucide-react';
// Loaded on demand rather than up front. WsiViewer pulls in OpenSeadragon and
// fabric.js, which together are the bulk of the JavaScript here — and neither
// is needed to show the patient worklist, which is the first thing everyone
// sees. Splitting them out means the queue paints without waiting for them.
const WsiViewer = React.lazy(() => import('./WsiViewer'));
import { resolveImageUrl, renderAnnotatedImage, hasAnnotations } from './annotations';
import {
  apiGet, getCases, getCaseImage,
  getAllNotes, getAllAnnotations, saveNote, saveAnnotations, setCaseArchived,
} from './api';

// The annotation colour palette shown in the slide toolbar (label + CSS hex).
const COLORS = [
  { label: 'Red',    value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green',  value: '#22c55e' },
  { label: 'Blue',   value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'White',  value: '#ffffff' },
  { label: 'Black',  value: '#000000' },
];

// The annotation tools. `id` is matched in WsiViewer's handleMouseDown to pick
// the drawing behaviour; `icon`/`label` drive the toolbar button.
const TOOLS = [
  { id: 'freehand', icon: Pencil, label: 'Freehand' },
  { id: 'rect',     icon: Square,  label: 'Rectangle' },
  { id: 'oval',     icon: Circle,  label: 'Oval' },
  { id: 'eraser',   icon: Eraser,  label: 'Eraser' },
];

// The built-in demo patients. Kept outside the component for stable identity.
// Patients submitted from the CHC intake app are fetched from the backend and
// appended to these at runtime (see `cases` inside the component).
const BASE_CASES = [
  { id: 1, patient: 'Patient A', age: 45, gender: 'F', site: 'Lymph Node', status: 'Pending', date: '2026-05-23', image: 'IMG-20260525-WA0002.jpg' },
  { id: 2, patient: 'Patient B', age: 62, gender: 'M', site: 'Lymph Node', status: 'Pending', date: '2026-05-23', image: 'IMG-20260525-WA0003.jpg' },
  { id: 3, patient: 'Patient C', age: 29, gender: 'F', site: 'Lymph Node', status: 'Pending', date: '2026-05-22', image: 'IMG-20260525-WA0005.jpg' },
];

// Avatar background tints, chosen per patient by index so each row's circle
// has a stable colour.
const AVATAR_TINTS = [
  'bg-indigo-50 text-indigo-600',
  'bg-violet-50 text-violet-600',
  'bg-teal-50 text-teal-600',
];
// "Patient A" -> "PA": first letter of each word, for the avatar circle.
const initialsOf = (name) => name.split(' ').map(w => w[0]).join('').toUpperCase();

// The worklist's own unique patient identifier — shown under the name and
// matched by the search box. Names alone aren't unique (several patients can
// share one), so this is what actually disambiguates them: the SAME "CHC
// Patient ID" the lab attendant typed in at intake (PatientForm.jsx's "CHC
// Patient ID" field, stored as cases.chc_id) — not this app's own internal
// database id, and not the clinical Nikshay/registration id shown elsewhere
// on the Reports page. The built-in demo patients were never submitted
// through intake, so they have none — shown as a muted dash, same as the
// Lab Attendant / CHC columns.
const patientIdLabel = (c) => c.chcId ? `CHC ID: ${c.chcId}` : '—';

// Local browser cache. The shared backend (see ./api) is the source of truth
// across machines; this cache makes the UI instant and keeps things working
// when the backend is offline.
const loadLS = (key) => {
  try { return JSON.parse(localStorage.getItem(key)) || {}; }
  catch { return {}; }
};
const saveLS = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* quota exceeded (large images) — keep in memory for this session */ }
};

// The dark navigation rail — now shown on ALL THREE pages (queue, slide
// viewer, details), so once a patient is open you can still jump straight to
// the patient list, the slide, or the report without losing your place.
// `active` highlights the current section; `onNav(id)` does the actual page
// switch; `disabled` (true while mid-annotation) blocks navigation so you
// can't accidentally lose an unsaved drawing — the save/discard dialog is the
// only way out of that state, same as the existing "Back" button.
const RAIL_NAV = [
  { id: 'queue',   icon: ListChecks, label: 'Patient List' },
  { id: 'slides',  icon: Images,     label: 'Slides' },
  { id: 'reports', icon: FileText,   label: 'Reports' },
];
// The EPTB Hub brand mark itself IS the sidebar's open/close control — no
// separate toggle button duplicated in each page's header. Clicking the logo
// at the top of the open rail collapses it (`onToggle`); when collapsed, the
// same logo reappears alone in a slim strip (see RailCollapsed below) and
// clicking it there reopens the full rail. Only one logo is ever on screen.
const Rail = ({ active, count, onNav, disabled, onToggle, user, onLogout }) => (
  <div className="w-[210px] shrink-0 rail-dark border-r border-slate-800 flex flex-col gap-6 px-4 py-5">
    <button onClick={onToggle} title="Hide sidebar" className="flex items-center gap-2.5 px-1.5 self-start hover:opacity-80 transition-opacity">
      <div className="w-9 h-9 rounded-[10px] bg-indigo-600 flex items-center justify-center shrink-0">
        <Microscope className="w-[18px] h-[18px] text-white" />
      </div>
      <div className="text-left">
        <div className="text-sm font-bold text-white leading-tight">EPTB Hub</div>
        <div className="mono text-[10px] text-slate-500">console</div>
      </div>
    </button>
    {/* The three destinations, generated from RAIL_NAV so adding one is a
        single line there rather than a new block of markup here. `disabled`
        is true while a drawing session is open: navigating away mid-annotation
        would abandon unsaved marks, so the save/discard dialog is made the
        only way out (the title explains why the buttons look inert). */}
    <nav className="flex flex-col gap-0.5">
      {RAIL_NAV.map(({ id, icon: Icon, label }) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            onClick={() => onNav?.(id)}
            disabled={disabled}
            title={disabled ? 'Finish or discard your annotation first' : undefined}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-[9px] text-[13px] transition-colors ${
              isActive ? 'bg-indigo-950 text-indigo-200 font-semibold' : 'text-slate-400 font-medium hover:bg-slate-800/60'
            } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <Icon className="w-4 h-4" />
            {label}
            {id === 'queue' && count != null && (
              <span className="mono ml-auto text-[10px] bg-indigo-600 text-white rounded-[5px] px-1.5 py-px">{count}</span>
            )}
          </button>
        );
      })}
    </nav>
    {/* Signed-in pathologist + sign out, pinned to the bottom of the rail
        (`mt-auto` on the last child pushes it down) so it's always reachable
        without competing with the nav items above it for space. */}
    {user && (
      <div className="mt-auto pt-4 border-t border-slate-800 flex items-center gap-2.5 px-0.5">
        <div className="mono w-8 h-8 rounded-lg bg-indigo-950 text-indigo-300 flex items-center justify-center text-[11px] font-bold shrink-0">
          {initialsOf(user.fullName || 'U')}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-slate-200 truncate">{user.fullName}</div>
          <div className="mono text-[10px] text-slate-500">Pathologist</div>
        </div>
        <button onClick={onLogout} title="Log out" className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-slate-800/60 transition-colors shrink-0">
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    )}
  </div>
);

// The collapsed state: a slim strip holding just the same brand mark, so
// there's still exactly one logo on screen (not zero, not two) once the full
// rail is hidden. Clicking it brings the full rail back.
const RailCollapsed = ({ onToggle }) => (
  <div className="w-[64px] shrink-0 rail-dark border-r border-slate-800 flex flex-col items-center py-5">
    <button
      onClick={onToggle}
      title="Show sidebar"
      className="w-9 h-9 rounded-[10px] bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center shrink-0 transition-colors active:scale-95"
    >
      <Microscope className="w-[18px] h-[18px] text-white" />
    </button>
  </div>
);

// A white card with an icon-badge header, used for each section on the details
// page. `children` is the card body. (Destructuring `icon: Icon` lets us use it
// as a JSX component, which must be capitalised.)
const SectionCard = ({ icon: Icon, title, children }) => (
  // `h-full flex flex-col` lets the card fill its grid cell so cards sitting in
  // the same row share one height (no ragged, scattered edges). The body wrapper
  // flexes, so a textarea inside can grow and pin its buttons to the card bottom.
  <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 sm:p-6 h-full flex flex-col">
    <div className="flex items-center gap-2.5 mb-4 shrink-0">
      <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5 text-indigo-600" />
      </div>
      <h3 className="mono text-xs font-bold text-slate-500 uppercase tracking-widest">{title}</h3>
    </div>
    <div className="flex-1 flex flex-col min-h-0">{children}</div>
  </section>
);

// The little status badge: amber "Pending" or green "Reported".
const StatusPill = ({ status }) => (
  status === 'Pending' ? (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 ring-1 ring-amber-200">
      <Clock className="w-3 h-3" /> Pending
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
      <ShieldCheck className="w-3 h-3" /> Reported
    </span>
  )
);

const TelepathologyDashboard = ({ user, onLogout }) => {
  // Three-page flow (all screen sizes):
  // 'queue'   — FNAC patient list
  // 'slide'   — the whole-slide image viewer with annotation tools
  // 'details' — prescription / clinical information
  const [page, setPage] = useState('queue');
  const [activeCase, setActiveCase] = useState(1);
  const [isDrawing, setIsDrawing] = useState(false);
  // Whether the dark navigation rail is shown. A toggle button on every page
  // flips this, so a pathologist can reclaim the rail's width for the slide
  // viewer, then bring it back to jump to another patient/report.
  const [railOpen, setRailOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches
  );
  // The rail is a fixed 210px block, which leaves too little room for the
  // queue table / prescription cards on a phone. So it auto-collapses the
  // moment the window narrows below a "tablet-ish" width, and auto-reopens
  // above it — the toggle button still overrides this manually at any size.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const applyToViewport = (e) => setRailOpen(e.matches);
    mq.addEventListener('change', applyToViewport);
    return () => mq.removeEventListener('change', applyToViewport);
  }, []);
  // Queue worklist controls: free-text search (matches patient name or
  // specimen site) and a status filter tab. Both are plain client-side
  // filters over the in-memory case list — no extra request needed.
  const [queueSearch, setQueueSearch] = useState('');
  const [queueStatusFilter, setQueueStatusFilter] = useState('All');
  // Both start null when annotation mode is enabled: the user must pick a
  // color and a tool every session before they can draw.
  const [annotationColor, setAnnotationColor] = useState(null);
  const [annotationTool, setAnnotationTool] = useState(null);
  const [showSaveModal, setShowSaveModal] = useState(false);

  // Per-patient clinical text, keyed by case id. Drafts live here as the user
  // types and are cleared on save; the "saved" copies persist (and are what
  // other sections / machines read back).
  const [clinicalDraft, setClinicalDraft] = useState({});
  const [clinicalSaved, setClinicalSaved] = useState(() => loadLS('pv_clinicalSaved'));
  const [pathologistDraft, setPathologistDraft] = useState({});
  const [pathologistSaved, setPathologistSaved] = useState(() => loadLS('pv_pathologistSaved'));
  const [medicineDraft, setMedicineDraft] = useState({});
  const [medicineSaved, setMedicineSaved] = useState(() => loadLS('pv_medicineSaved'));
  // Per-patient annotations, stored as VECTOR SHAPES (fabric JSON in image
  // coordinates) — a few KB each. They used to be saved as a flattened PNG of
  // the whole slide, which ran to ~16 MB per case inside SQLite, couldn't be
  // edited afterwards, and had to be downscaled to 4096px to composite at all.
  // See annotations.js for the full reasoning.
  const [annotations, setAnnotations] = useState(() => loadLS('pv_annotations'));
  // Read-only fallback: annotations saved by the OLD flattened-image scheme.
  // Nothing writes to this any more, but keeping it means work saved before
  // the change still displays instead of silently vanishing.
  const [legacyAnnotatedImages, setLegacyAnnotatedImages] = useState(() => loadLS('pv_annotatedImages'));
  const [showAnnotations, setShowAnnotations] = useState(true);  // slide-page toggle
  const [savedFlash, setSavedFlash] = useState(null);   // which Save button just fired
  const [modal, setModal] = useState(null);             // viewer overlay {type,title,...}
  // The case awaiting delete confirmation, or null. Removing a patient is
  // destructive enough to always ask first.
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [intakeCases, setIntakeCases] = useState([]);   // patients submitted from the CHC intake app
  const [loadingCases, setLoadingCases] = useState(true); // initial fetch of intake patients in flight

  // Mirror saved values into the local cache whenever they change.
  useEffect(() => { saveLS('pv_clinicalSaved', clinicalSaved); }, [clinicalSaved]);
  useEffect(() => { saveLS('pv_pathologistSaved', pathologistSaved); }, [pathologistSaved]);
  useEffect(() => { saveLS('pv_medicineSaved', medicineSaved); }, [medicineSaved]);
  useEffect(() => { saveLS('pv_annotations', annotations); }, [annotations]);

  // On load, pull the latest data from the shared backend so notes and
  // annotations saved on ANOTHER machine appear here too. If the backend is
  // offline we silently keep the local cache the state was seeded with.
  // Notes now come from per-case rows (see /api/notes) rather than one blob
  // per kind; the shape handed to the UI is unchanged.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [notes, anns, legacy] = await Promise.all([
          getAllNotes(),
          getAllAnnotations(),
          apiGet('pv_annotatedImages'),   // old flattened images, read-only
        ]);
        if (cancelled) return;
        // { caseId: { clinical, pathologist, medicine } } -> one map per kind,
        // which is what the three text areas already expect.
        const byKind = { clinical: {}, pathologist: {}, medicine: {} };
        for (const [caseId, kinds] of Object.entries(notes || {})) {
          for (const [kind, body] of Object.entries(kinds || {})) {
            if (byKind[kind]) byKind[kind][caseId] = body;
          }
        }
        setClinicalSaved(byKind.clinical);
        setPathologistSaved(byKind.pathologist);
        setMedicineSaved(byKind.medicine);
        setAnnotations(anns || {});
        setLegacyAnnotatedImages(legacy);
      } catch {
        /* backend not reachable — keep using the local cache */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep the queue in sync with patients submitted from the CHC intake app.
  // Polls every few seconds so a newly submitted patient appears LIVE, without
  // a refresh. It only appends genuinely new cases (by id) and keeps existing
  // case objects as-is, so a slide you're viewing/annotating is never disturbed.
  useEffect(() => {
    let cancelled = false;
    // Newest `updatedAt` already seen. After the first full load, each poll
    // asks only for cases changed since this, so an idle queue transfers an
    // empty array instead of every case, every four seconds.
    let since = null;

    const load = async (initial) => {
      try {
        const list = await getCases(initial ? undefined : since);
        if (cancelled || !Array.isArray(list)) return;

        // Advance the watermark past the newest change received.
        for (const c of list) {
          if (c.updatedAt && (!since || c.updatedAt > since)) since = c.updatedAt;
        }
        if (!list.length) return;                 // nothing changed — done

        setIntakeCases(prev => {
          const known = new Map(prev.map(c => [c.id, c]));
          const additions = list.filter(c => !known.has(c.id) && !c.archived);

          // Refresh cases we already hold: a slide may have finished
          // converting, or the case may have been archived. Everything else
          // about the existing object is preserved — notably a lazily-fetched
          // `image` that the list response doesn't carry.
          let changed = false;
          const merged = prev.map((old) => {
            const fresh = list.find(c => c.id === old.id);
            if (!fresh) return old;
            if (fresh.slideStatus === old.slideStatus && !fresh.archived) return old;
            changed = true;
            return {
              ...old,
              slideStatus: fresh.slideStatus,
              dziUrl: fresh.dziUrl,
              slideError: fresh.slideError,
              archived: fresh.archived,
            };
          }).filter((c) => !c.archived);          // archived cases leave the worklist

          if (!additions.length && !changed && merged.length === prev.length) return prev;
          return [...merged, ...additions];
        });
      } catch {
        /* backend offline — keep the built-in demo cases */
      } finally {
        if (initial && !cancelled) setLoadingCases(false);
      }
    };
    load(true);
    const timer = setInterval(() => load(false), 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const viewerApiRef = useRef(null);

  // The queue = built-in demo patients + ones submitted from CHC intake. The
  // element objects stay stable, so an open case keeps its identity.
  const cases = [...BASE_CASES, ...intakeCases];
  const currentCase = cases.find(c => c.id === activeCase) || cases[0];
  const id = activeCase;
  const defaultClinical = `Palpable nodule identified in the ${currentCase.site.toLowerCase()}.`;
  // Which cases exist on the server (and so can be removed). The demo patients
  // are hard-coded here, not stored anywhere, so they aren't deletable.
  const intakeIds = new Set(intakeCases.map(c => c.id));

  // Remove a patient from the worklist. This ARCHIVES rather than destroys:
  // the record and its slide stay on disk and can be restored, which is the
  // right default for clinical data — a mis-click shouldn't be unrecoverable.
  const deletePatient = async (c) => {
    setDeleting(true);
    try {
      await setCaseArchived(c.id, true);
      // Drop it locally straight away rather than waiting for the next poll,
      // so the row disappears the moment the action is confirmed.
      setIntakeCases(prev => prev.filter(x => x.id !== c.id));
      // If the removed patient was open, fall back to the first remaining case.
      if (activeCase === c.id) {
        const fallback = [...BASE_CASES, ...intakeCases.filter(x => x.id !== c.id)][0];
        if (fallback) setActiveCase(fallback.id);
        setPage('queue');
      }
      setConfirmDelete(null);
    } catch (err) {
      alert(err?.message || 'Could not remove this patient. Is the backend running?');
    } finally {
      setDeleting(false);
    }
  };

  const openCase = (cid) => {
    const c = intakeCases.find(x => x.id === cid);
    // A scanned slide still uploading or converting has nothing to show yet,
    // and a failed one never will — leave the pathologist in the queue rather
    // than opening an empty viewer. The row itself explains the state.
    if (c && (c.slideStatus === 'processing' || c.slideStatus === 'failed')) return;

    setActiveCase(cid);
    setPage('slide');
    // Intake patients arrive without their image (kept out of the list for
    // speed); fetch it now so the WSI viewer can show the slide. Whole-slide
    // cases have no `image` at all — they stream tiles from `dziUrl` instead.
    if (c && c.hasImage && !c.image && !c.dziUrl) {
      getCaseImage(cid)
        .then(img => setIntakeCases(prev => prev.map(x => (x.id === cid ? { ...x, image: img } : x))))
        .catch(() => {});
    }
  };

  const enableAnnotation = () => {
    setAnnotationColor('#000000'); // default to black; user only needs to pick a tool
    setAnnotationTool(null);
    setIsDrawing(true);
  };

  // Shared handler for the navigation rail, used on all three pages: jump
  // straight to the patient list, the current patient's slide, or their
  // report. Blocked while mid-annotation (isDrawing) so a rail click can't
  // silently discard unsaved drawings — same rule as the "Back" button.
  const navigateTo = (id) => {
    if (isDrawing) return;
    if (id === 'queue') setPage('queue');
    else if (id === 'slides') setPage('slide');
    else if (id === 'reports') setPage('details');
  };

  // Persist the current marks as vector JSON and push to the backend. Shared
  // by the instant Save and the save-on-close flow. This is a few KB per case
  // rather than the ~16 MB flattened PNG the old scheme stored.
  const persistAnnotations = async () => {
    const json = await viewerApiRef.current?.save();
    if (json) {
      setAnnotations(prev => ({ ...prev, [id]: json }));
      // Writes only THIS case's row, so a colleague saving a different case at
      // the same moment cannot overwrite it.
      saveAnnotations(id, json);
    }
    return !!json;
  };

  // Instant Save — saves the work so far but STAYS in annotation mode so the
  // user can keep drawing. Gives a brief "Saved" confirmation on the button.
  const saveAnnotationsNow = async () => {
    if (await persistAnnotations()) flashSaved('annotation');
  };

  const saveAndClose = async () => {
    await persistAnnotations();
    setShowSaveModal(false);
    setIsDrawing(false);
  };

  const discardAndClose = async () => {
    await viewerApiRef.current?.discard();
    setShowSaveModal(false);
    setIsDrawing(false);
  };

  // Download a flattened picture. Built ON DEMAND from the live canvas — the
  // flattened form is never stored, only generated when actually wanted.
  const exportAnnotations = async () => {
    const dataURL = (await viewerApiRef.current?.exportPNG()) || legacyAnnotatedImages[id];
    if (dataURL) {
      const link = document.createElement('a');
      link.download = `annotation-${currentCase.patient}.png`;
      link.href = dataURL;
      link.click();
    } else {
      alert("No annotated image yet — annotate the slide and save changes first.");
    }
  };

  // Brief "Saved ✓" feedback on the text Save buttons
  const flashSaved = (key) => {
    setSavedFlash(key);
    setTimeout(() => setSavedFlash(f => (f === key ? null : f)), 1800);
  };
  // Each Save commits the draft to the persisted "saved" copy, pushes it to the
  // shared backend (so other machines see it), then clears the textarea.
  //
  // The backend write targets ONE case and ONE note kind. Previously every
  // save re-uploaded a map of every patient's notes, so two people saving
  // different patients at the same moment would silently discard one of the
  // two sets of notes — a real way to lose clinical text.
  const saveClinical = () => {
    const body = clinicalDraft[id] ?? defaultClinical;
    setClinicalSaved(prev => ({ ...prev, [id]: body }));
    saveNote(id, 'clinical', body);
    setClinicalDraft(prev => ({ ...prev, [id]: '' }));
    flashSaved('clinical');
  };
  const savePathologist = () => {
    const body = pathologistDraft[id] ?? '';
    setPathologistSaved(prev => ({ ...prev, [id]: body }));
    saveNote(id, 'pathologist', body);
    setPathologistDraft(prev => ({ ...prev, [id]: '' }));
    flashSaved('pathologist');
  };
  const saveMedicine = () => {
    const body = medicineDraft[id] ?? '';
    setMedicineSaved(prev => ({ ...prev, [id]: body }));
    saveNote(id, 'medicine', body);
    setMedicineDraft(prev => ({ ...prev, [id]: '' }));
    flashSaved('medicine');
  };

  // Modal openers
  // The annotated picture is BUILT HERE, on demand, from the saved vector
  // marks — it isn't stored anywhere. Async, so the modal opens immediately in
  // a loading state rather than freezing the page while the slide overview
  // downloads and composites.
  const viewAnnotatedImage = async () => {
    const marks = annotations[id];
    const legacy = legacyAnnotatedImages[id];

    if (!hasAnnotations(marks) && !legacy) {
      setModal({ type: 'message', title: 'No annotated image', text: 'No annotations have been saved for this patient yet. Open the slide, annotate it, and choose “Save Changes”.' });
      return;
    }

    const title = `Annotated slide — ${currentCase.patient}`;
    setModal({ type: 'image', title, src: null, loading: true });

    // Marks saved under the old scheme are already a flattened picture; there
    // are no shapes to re-render, so show that image as-is.
    const src = hasAnnotations(marks)
      ? await renderAnnotatedImage(currentCase, marks)
      : legacy;

    // The clean slide, for the modal's annotated/original toggle. Whole-slide
    // cases use the same downscaled overview so both views line up exactly.
    const rawSrc = currentCase.dziUrl
      ? await renderAnnotatedImage(currentCase, null)
      : (currentCase.image ? resolveImageUrl(currentCase.image) : null);

    setModal((m) => (m && m.title === title
      ? { type: 'image', title, src, rawSrc, showAnnotations: true, loading: false }
      : m));   // a different modal was opened meanwhile — don't clobber it
  };
  const viewPathologistNotes = () => {
    const text = pathologistSaved[id];
    setModal({
      type: 'text',
      title: `Pathologist consultation — ${currentCase.patient}`,
      text: text && text.trim() ? text : 'No pathologist consultation has been saved for this patient yet.',
    });
  };

  // Shared styling for the details page.
  const taClass = "w-full flex-1 min-h-[8rem] resize-none p-3.5 border border-gray-200 rounded-xl text-sm bg-neutral-50 placeholder:text-slate-400 text-slate-700 leading-relaxed";
  const btnPrimary = "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm active:scale-95 transition-all";
  // A bigger, tile-style action button for the standalone "Case Review" bar —
  // viewing the annotated slide / the pathologist's notes used to be small
  // chip buttons duplicated inside the Pathologist and Medicine consultation
  // cards; they now live once, in their own dedicated spot, sized to be the
  // clear first stop on this page.
  const ReviewTile = ({ icon: Icon, label, caption, onClick }) => (
    <button onClick={onClick}
      className="flex-1 min-w-[240px] flex items-center gap-3.5 bg-neutral-50 border border-gray-200 rounded-xl px-4 py-3.5 text-left hover:bg-white hover:border-indigo-300 hover:shadow-md active:scale-[0.98] transition-all">
      <span className="w-11 h-11 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0 shadow-sm shadow-indigo-600/25">
        <Icon className="w-5 h-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-slate-900">{label}</span>
        <span className="block text-[11.5px] text-slate-500 mt-0.5">{caption}</span>
      </span>
    </button>
  );

  /* ============ PAGE 1 — FNAC QUEUE ============ */
  if (page === 'queue') {
    // Quick at-a-glance counts shown in the summary tiles below the header.
    // These always reflect the FULL list — the search/filter below only
    // affects which rows the worklist shows, not these totals.
    const pendingCount = cases.filter(c => c.status === 'Pending').length;
    const pad2 = (n) => String(n).padStart(2, '0');
    const stats = [
      { label: 'Total',    value: pad2(cases.length),                icon: ClipboardList, tint: 'bg-indigo-50 text-indigo-600',   num: 'text-slate-900' },
      { label: 'Pending',  value: pad2(pendingCount),                icon: Clock,         tint: 'bg-amber-50 text-amber-600',     num: 'text-amber-700' },
      { label: 'Reported', value: pad2(cases.length - pendingCount), icon: ShieldCheck,   tint: 'bg-emerald-50 text-emerald-600', num: 'text-emerald-600' },
    ];

    // The worklist rows actually shown: filtered by the status tab and the
    // search box. Matches patient name, specimen site, OR the CHC Patient ID
    // — the id is what actually pins down ONE patient when several share the
    // same (or a similar) name, so it has to be searchable too, not just the
    // name. Matches the raw id ("123456789012") as well as the "CHC ID: …"
    // label so either form finds the row.
    const q = queueSearch.trim().toLowerCase();
    const filteredCases = cases.filter((c) => {
      const matchesStatus = queueStatusFilter === 'All' || c.status === queueStatusFilter;
      const matchesSearch = !q
        || c.patient.toLowerCase().includes(q)
        || (c.site || '').toLowerCase().includes(q)
        || (c.chcId || '').toLowerCase().includes(q)
        || patientIdLabel(c).toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });

    // Shared grid template for the table-style worklist: Patient | Specimen |
    // Age/Sex | Lab Attendant | CHC | Received | Status | chevron. On phones
    // the middle columns are hidden (see `hidden sm:block` below), so the row
    // naturally collapses to Patient | Status | chevron without a separate
    // mobile layout.
    const gridCols = 'grid-cols-[1fr_auto_20px] sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_1fr_36px]';

    return (
      <div className="h-[100dvh] rail-dark text-slate-900 overflow-hidden flex">
        {railOpen
          ? <Rail active="queue" count={cases.length} onNav={navigateTo} disabled={isDrawing} onToggle={() => setRailOpen(false)} user={user} onLogout={onLogout} />
          : <RailCollapsed onToggle={() => setRailOpen(true)} />}
        <div className="flex-1 min-w-0 clinical-bg flex flex-col">
          {/* App header */}
          <header className="shrink-0 bg-white border-b border-gray-200 px-4 sm:px-8 py-4 flex items-center gap-4">
            <div className="mr-auto min-w-0">
              <h1 className="text-base sm:text-lg font-extrabold tracking-tight text-slate-900 leading-tight">FNAC Review Queue</h1>
              <p className="mono text-[11px] text-slate-500">telepathology console</p>
            </div>
            {/* A real, working search box — typing filters the worklist below. */}
            <div className="hidden sm:flex items-center gap-2 bg-gray-100 border border-gray-200 rounded-[9px] px-3 py-2 w-[220px] text-slate-400 focus-within:bg-white focus-within:border-indigo-400 transition-colors">
              <Search className="w-[15px] h-[15px] shrink-0" />
              <input
                value={queueSearch}
                onChange={(e) => setQueueSearch(e.target.value)}
                placeholder="Search name or patient ID…"
                className="bg-transparent outline-none text-[12.5px] text-slate-700 placeholder:text-slate-400 w-full"
              />
            </div>
          </header>

          {/* Main work area — fills all the space between header and footer so the
              page never looks half-empty on a large screen. */}
          <main className="flex-1 min-h-0 px-4 sm:px-8 py-5 sm:py-6 flex flex-col">
            {/* Summary tiles */}
            <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-4 sm:mb-5 shrink-0">
              {stats.map((s) => {
                const Icon = s.icon;
                return (
                  <div key={s.label} className="bg-white rounded-xl border border-gray-200 px-3.5 sm:px-[18px] py-3.5 sm:py-[15px] flex items-center justify-between">
                    <div>
                      <div className={`mono text-2xl sm:text-[26px] font-semibold leading-none ${s.num}`}>{s.value}</div>
                      <div className="text-[11px] sm:text-[11.5px] text-slate-500 font-medium mt-1.5">{s.label}</div>
                    </div>
                    <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-[10px] flex items-center justify-center shrink-0 ${s.tint}`}>
                      <Icon className="w-[18px] h-[18px] sm:w-[19px] sm:h-[19px]" />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Worklist panel — a single framed surface that stretches to fill the
                remaining height, so spare space reads as part of the worklist
                rather than as empty backdrop. Rows scroll inside it. */}
            <div className="flex-1 min-h-0 flex flex-col bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="shrink-0 flex items-center gap-2.5 px-4 sm:px-6 py-3.5 border-b border-gray-100">
                <h2 className="text-sm font-bold text-slate-900 mr-auto">Patient Worklist</h2>
                {/* Status filter tabs — a real filter over the rows below, not
                    just decoration; "All" is the default so nothing is hidden
                    until the pathologist actually narrows it down. */}
                <div className="flex bg-gray-100 rounded-[9px] p-[3px] gap-0.5">
                  {['All', 'Pending', 'Reported'].map((f) => (
                    <button
                      key={f}
                      onClick={() => setQueueStatusFilter(f)}
                      className={`text-[11.5px] font-semibold rounded-[7px] px-3 py-[5px] transition-colors ${
                        queueStatusFilter === f ? 'text-white bg-indigo-600' : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {/* Column headers — hidden on phones, where the row itself
                  collapses to just Patient | Status | chevron. */}
              <div className={`hidden sm:grid ${gridCols} gap-3.5 px-4 sm:px-6 py-2.5 bg-neutral-50 border-b border-gray-100 text-[10px] font-bold text-slate-400 uppercase tracking-wide shrink-0`}>
                <div>Patient</div>
                <div>Specimen</div>
                <div>Age / Sex</div>
                <div>Lab Attendant</div>
                <div>CHC</div>
                <div>Received</div>
                <div>Status</div>
                <div />
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-100">
                {filteredCases.map((c) => {
                  // Keep each patient's avatar tint stable by their position in
                  // the FULL list, not the filtered one, so it never changes
                  // colour as the search/filter narrows the results.
                  const tintIndex = cases.findIndex((x) => x.id === c.id);
                  // A scanned slide that isn't viewable yet: either still
                  // uploading/converting, or it failed. The row stays visible
                  // (the case exists) but reads as not-yet-openable.
                  const slidePending = c.slideStatus === 'processing';
                  const slideFailed = c.slideStatus === 'failed';
                  const notOpenable = slidePending || slideFailed;
                  // Only cases that actually exist on the server can be
                  // removed. The built-in demo patients are hard-coded in this
                  // file, so there is nothing to delete for them.
                  const isRemovable = intakeIds.has(c.id);
                  return (
                    // A wrapper is needed because the delete control has to be
                    // a SIBLING of the row button — a <button> inside a
                    // <button> is invalid HTML and browsers handle it badly.
                    <div key={c.id} className="group relative">
                    <button
                      onClick={() => openCase(c.id)}
                      disabled={notOpenable}
                      title={slidePending ? 'The scanned slide is still uploading' : slideFailed ? (c.slideError || 'This slide could not be processed') : undefined}
                      className={`w-full grid ${gridCols} gap-3 sm:gap-3.5 items-center px-4 sm:px-6 py-4 sm:py-[15px] text-left transition-colors ${
                        notOpenable ? 'cursor-not-allowed opacity-70' : 'hover:bg-indigo-50/40'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`mono w-11 h-11 sm:w-[38px] sm:h-[38px] rounded-full sm:rounded-[9px] flex items-center justify-center text-sm sm:text-[13px] font-bold shrink-0 ${AVATAR_TINTS[tintIndex % AVATAR_TINTS.length]}`}>
                          {initialsOf(c.patient)}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 group-hover:text-indigo-700 transition-colors truncate">{c.patient}</div>
                          {/* The worklist's own unique patient id, under the name —
                              names repeat across patients, this doesn't. */}
                          <div className="mono text-[11px] text-slate-400 mt-0.5 truncate">{patientIdLabel(c)}</div>
                        </div>
                      </div>
                      <div className="hidden sm:block text-[13px] text-slate-600 truncate">{c.site}</div>
                      <div className="hidden sm:block mono text-[12.5px] text-slate-500">{c.age} · {c.gender}</div>
                      {/* Who submitted the case, and from which CHC — their own
                          columns now, instead of a subtext line. Demo patients
                          have neither, so these show a muted dash. */}
                      <div className="hidden sm:block text-[13px] text-slate-600 truncate">{c.attendant || '—'}</div>
                      <div className="hidden sm:block text-[13px] text-slate-600 truncate">{c.chcName || '—'}</div>
                      <div className="hidden sm:block mono text-[12.5px] text-slate-500 tabular-nums">{c.date}</div>
                      {/* While a scanned slide is still arriving (or if it
                          failed), that matters more than Pending/Reported —
                          it's the reason the row can't be opened yet. */}
                      <div>
                        {slidePending ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 text-sky-700 ring-1 ring-sky-200">
                            <Loader2 className="w-3 h-3 animate-spin" /> Uploading
                          </span>
                        ) : slideFailed ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700 ring-1 ring-red-200">
                            <AlertCircle className="w-3 h-3" /> Slide failed
                          </span>
                        ) : (
                          <StatusPill status={c.status} />
                        )}
                      </div>
                      {!notOpenable && (
                        <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition-all justify-self-end" />
                      )}
                    </button>

                    {/* Remove-from-worklist control. Kept faint rather than
                        fully hidden: a hover-only control is invisible on a
                        tablet or phone, which have no hover state at all, so
                        the option would simply not exist there. Low opacity
                        keeps it out of the way while still being findable, and
                        it solidifies on hover/focus. */}
                    {isRemovable && (
                      <button
                        onClick={() => setConfirmDelete(c)}
                        title={`Remove ${c.patient} from the worklist`}
                        aria-label={`Remove ${c.patient} from the worklist`}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-slate-300 bg-white/80 backdrop-blur-sm opacity-50 group-hover:opacity-100 focus:opacity-100 hover:text-red-600 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-200 transition-all"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    </div>
                  );
                })}
                {/* Loading indicator while submitted patients are being fetched */}
                {loadingCases && (
                  <div className="flex items-center justify-center gap-2 px-4 sm:px-6 py-4 text-sm text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading patients…
                  </div>
                )}
                {/* Nothing matched the search/filter — explicit empty state so
                    a narrowed-down worklist never looks like a blank error. */}
                {!loadingCases && filteredCases.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-sm text-slate-400">
                    <Search className="w-5 h-5" />
                    No patients match{queueStatusFilter !== 'All' ? ` "${queueStatusFilter}"` : ''}{q ? ` “${queueSearch}”` : ''}.
                  </div>
                )}
              </div>
            </div>
          </main>

          {/* Footer status bar — anchors the bottom of the page */}
          <footer className="shrink-0 border-t border-gray-200 bg-white px-4 sm:px-8 py-2.5">
            <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
              <span className="mono">Telepathology Console · EPTB Hub</span>
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live · synced
              </span>
            </div>
          </footer>

          {/* Confirm before removing a patient. The wording is deliberate:
              this archives rather than destroys, and saying so stops people
              hesitating over a mis-typed entry they're right to clear out. */}
          {confirmDelete && (
            <div
              onClick={() => !deleting && setConfirmDelete(null)}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center border border-gray-200"
              >
                <div className="mx-auto w-12 h-12 rounded-full bg-red-50 ring-8 ring-red-50/50 flex items-center justify-center mb-4">
                  <Trash2 className="w-5 h-5 text-red-600" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 tracking-tight">
                  Remove {confirmDelete.patient}?
                </h3>
                <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                  This takes the case off the worklist. The patient record,
                  slide and any notes are kept and can be restored — nothing is
                  permanently erased.
                </p>
                {confirmDelete.chcId && (
                  <p className="mono text-[11px] text-slate-400 mt-3">CHC ID: {confirmDelete.chcId}</p>
                )}
                <div className="flex gap-3 mt-6">
                  <button
                    onClick={() => setConfirmDelete(null)}
                    disabled={deleting}
                    className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-slate-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition-all disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => deletePatient(confirmDelete)}
                    disabled={deleting}
                    className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-sm text-white bg-red-600 hover:bg-red-700 shadow-md shadow-red-600/25 transition-all disabled:opacity-60"
                  >
                    {deleting
                      ? <><Loader2 className="w-4 h-4 animate-spin" /> Removing…</>
                      : <><Trash2 className="w-4 h-4" /> Remove</>}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ============ PAGE 3 — PRESCRIPTION / DETAILS ============ */
  if (page === 'details') {
    return (
      <div className="h-[100dvh] rail-dark text-slate-900 overflow-hidden flex">
        {railOpen
          ? <Rail active="reports" count={cases.length} onNav={navigateTo} disabled={isDrawing} onToggle={() => setRailOpen(false)} user={user} onLogout={onLogout} />
          : <RailCollapsed onToggle={() => setRailOpen(true)} />}
        <div className="flex-1 min-w-0 clinical-bg overflow-y-auto flex flex-col">
          <div className="sticky top-0 bg-white border-b border-gray-200 px-4 sm:px-8 py-3.5 flex items-center gap-3 z-10">
            <button
              onClick={() => setPage('slide')}
              title="Back to slide"
              className="p-2.5 rounded-[10px] text-slate-600 bg-gray-100 hover:bg-gray-200 border border-gray-200 transition-all shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="mono w-10 h-10 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-sm font-bold shrink-0">
              {initialsOf(currentCase.patient)}
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-bold text-slate-900 truncate leading-tight">{currentCase.patient}</h2>
              <p className="mono text-xs text-slate-500 font-medium">{currentCase.age} years · {currentCase.gender} · {currentCase.site}</p>
            </div>
            <div className="ml-auto shrink-0"><StatusPill status={currentCase.status} /></div>
          </div>

          {/* `flex-1 min-h-0` (instead of a capped max-width + auto margins)
              lets this grid stretch to fill all the space between the sticky
              header and the footer, at any window size. `auto-rows-fr` then
              splits that height evenly between the two card rows, and each
              row's two cards share it evenly across columns — so the four
              cards always fill the screen instead of floating in the middle
              of it. On phones (single column) rows fall back to their natural
              content height and the page scrolls if needed. */}
          {/* `lg:auto-rows-fr` only forces equal row heights once we're
              actually in the 2-column layout (2 cards per row, sensible to
              match). Left on for the single-column mobile layout, it would
              squeeze all 4 cards into equal slices of the screen regardless
              of how much each one needs — clipping the taller Patient
              Information card. Below `lg:`, rows keep their natural height
              and the page scrolls if the four cards don't all fit. */}
          <div className="flex-1 min-h-0 w-full px-4 sm:px-8 py-6 flex flex-col gap-5">
            {/* Case Review — the two "view" actions (annotated slide, saved
                pathologist notes) used to be small chip buttons duplicated
                inside both the Pathologist and Medicine consultation cards
                below. They now live once, in their own dedicated bar, so
                there's a single obvious place to check the slide or notes
                from instead of hunting through each card. */}
            <section className="shrink-0 bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-5">
              <div className="flex items-center gap-2.5 mb-3.5">
                <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
                  <Images className="w-3.5 h-3.5 text-indigo-600" />
                </div>
                <h3 className="mono text-xs font-bold text-slate-500 uppercase tracking-widest">Case Review</h3>
              </div>
              <div className="flex flex-wrap gap-3">
                <ReviewTile icon={FileImage} label="View Annotated Slide" caption="Slide image with pathologist's markup" onClick={viewAnnotatedImage} />
                <ReviewTile icon={Eye} label="View Pathologist Notes" caption="Saved microscopic findings" onClick={viewPathologistNotes} />
              </div>
            </section>

            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 lg:auto-rows-fr gap-5">
            {/* 1. NIKSAY Patient Information — read-only facts shown as a 2-col grid */}
            <SectionCard icon={ClipboardList} title="1. NIKSAY Patient Information">
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-gray-100 rounded-xl overflow-hidden border border-gray-100 flex-1 auto-rows-fr">
                {[
                  ['Patient Name', currentCase.patient, false],
                  ['Age / Gender', `${currentCase.age} yrs · ${currentCase.gender}`, true],
                  ['Registration ID', `NK-2026-${currentCase.id}001`, true],
                  ['Specimen Site', currentCase.site, false],
                  ['Status', currentCase.status, false],
                  ['Collected', currentCase.date, true],
                ].map(([k, v, mono]) => (
                  <div key={k} className="bg-neutral-50 px-4 py-3 flex flex-col justify-center">
                    <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{k}</dt>
                    <dd className={`${mono ? 'mono ' : ''}text-sm font-semibold mt-0.5 ${k === 'Status' ? 'text-amber-700' : 'text-slate-900'}`}>{v}</dd>
                  </div>
                ))}
              </dl>
            </SectionCard>

            {/* 2. Clinical Notes — editable, with its own Save button */}
            <SectionCard icon={FileText} title="2. Clinical Notes">
              <textarea
                className={taClass}
                placeholder="Enter clinical notes…"
                value={clinicalDraft[id] ?? defaultClinical}
                onChange={(e) => setClinicalDraft(prev => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex flex-wrap gap-2 mt-4">
                <button onClick={saveClinical} className={btnPrimary}>
                  {savedFlash === 'clinical'
                    ? <><Check className="w-3.5 h-3.5" /> Saved</>
                    : <><Save className="w-3.5 h-3.5" /> Save Notes</>}
                </button>
              </div>
            </SectionCard>

            {/* 3. Pathologist Consultation — findings + save (viewing the slide
                now happens from the Case Review bar above, not a chip here) */}
            <SectionCard icon={Stethoscope} title="3. Pathologist Consultation">
              <textarea
                className={taClass}
                placeholder="Enter microscopic findings…"
                value={pathologistDraft[id] ?? ''}
                onChange={(e) => setPathologistDraft(prev => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex flex-wrap gap-2 mt-4">
                <button onClick={savePathologist} className={btnPrimary}>
                  {savedFlash === 'pathologist'
                    ? <><Check className="w-3.5 h-3.5" /> Saved</>
                    : <><Save className="w-3.5 h-3.5" /> Save Notes</>}
                </button>
              </div>
            </SectionCard>

            {/* 4. Medicine Consultation — recommendations + save + sign-off */}
            <SectionCard icon={Pill} title="4. Medicine Consultation">
              <textarea
                className={taClass}
                placeholder="Physician recommendations…"
                value={medicineDraft[id] ?? ''}
                onChange={(e) => setMedicineDraft(prev => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex flex-wrap gap-2 mt-4">
                <button onClick={saveMedicine} className={btnPrimary}>
                  {savedFlash === 'medicine'
                    ? <><Check className="w-3.5 h-3.5" /> Saved</>
                    : <><Save className="w-3.5 h-3.5" /> Save Notes</>}
                </button>
              </div>
              <button className="w-full mt-5 py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm tracking-wide hover:bg-emerald-700 active:scale-[0.99] shadow-md shadow-emerald-600/25 transition-all inline-flex items-center justify-center gap-2">
                <ShieldCheck className="w-4 h-4" /> Sign &amp; Submit Report
              </button>
            </SectionCard>
            </div>
          </div>

          {/* Footer status bar — anchored to the bottom (mt-auto) so a short report
              still fills the screen instead of leaving a large empty gap. */}
          <footer className="shrink-0 border-t border-gray-200 bg-white px-4 sm:px-8 py-2.5">
            <div className="w-full flex items-center justify-between text-[11px] font-medium text-slate-400">
              <span className="mono">Telepathology Console · EPTB Hub</span>
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-3 h-3" /> Patient record · confidential
              </span>
            </div>
          </footer>

          {/* Shared viewer modal — annotated image, saved notes, or a message */}
          {modal && (
            <div
              onClick={() => setModal(null)}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col border border-gray-200 overflow-hidden"
              >
                <div className="flex items-center gap-3 px-5 py-3.5 border-b border-gray-100">
                  <h3 className="text-sm font-bold text-slate-900 truncate">{modal.title}</h3>
                  <button onClick={() => setModal(null)} className="ml-auto p-1.5 rounded-lg text-slate-500 hover:bg-gray-100 transition-all shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-5 overflow-y-auto">
                  {/* The picture is composited on demand from the saved vector
                      marks, which means fetching a slide overview first — show
                      a spinner rather than an empty box while that happens. */}
                  {modal.type === 'image' && modal.loading && (
                    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400">
                      <Loader2 className="w-4 h-4 animate-spin" /> Building annotated image…
                    </div>
                  )}
                  {modal.type === 'image' && !modal.loading && !modal.src && (
                    <p className="text-sm text-slate-500 leading-relaxed py-6">
                      Could not build the annotated image — the slide may still be processing.
                    </p>
                  )}
                  {modal.type === 'image' && !modal.loading && modal.src && (
                    <>
                      {/* On/off toggle for the markup overlay — only shown when we
                          actually have the clean, un-annotated slide to fall back
                          to (the raw image loaded lazily for intake patients may
                          not have arrived yet). Switches between the composited
                          annotated PNG and the original slide image, no re-fetch. */}
                      {modal.rawSrc && (
                        <div className="inline-flex items-center gap-1 bg-neutral-100 rounded-lg p-1 mb-3">
                          <button
                            onClick={() => setModal((m) => ({ ...m, showAnnotations: true }))}
                            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                              modal.showAnnotations !== false ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                            }`}
                          >
                            Annotated
                          </button>
                          <button
                            onClick={() => setModal((m) => ({ ...m, showAnnotations: false }))}
                            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                              modal.showAnnotations === false ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                            }`}
                          >
                            Original
                          </button>
                        </div>
                      )}
                      <img
                        src={modal.showAnnotations === false && modal.rawSrc ? modal.rawSrc : modal.src}
                        alt={modal.showAnnotations === false ? 'Original slide' : 'Annotated slide'}
                        className="w-full rounded-xl border border-gray-200"
                      />
                      <a
                        href={modal.src}
                        download={`annotation-${currentCase.patient}.png`}
                        className="mt-4 w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-all"
                      >
                        <Download className="w-4 h-4" /> Download Image
                      </a>
                    </>
                  )}
                  {modal.type === 'text' && (
                    <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{modal.text}</p>
                  )}
                  {modal.type === 'message' && (
                    <p className="text-sm text-slate-500 leading-relaxed">{modal.text}</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ============ PAGE 2 — SLIDE VIEWER ============ */
  // (This is the default return — reached when page is neither 'queue' nor 'details'.
  // The rail now appears here too, so a pathologist can jump straight to the
  // patient list or the report without losing the slide they have open.)
  return (
    <div className="h-[100dvh] rail-dark flex">
      {railOpen
        ? <Rail active="slides" count={cases.length} onNav={navigateTo} disabled={isDrawing} onToggle={() => setRailOpen(false)} user={user} onLogout={onLogout} />
        : <RailCollapsed onToggle={() => setRailOpen(true)} />}
      <div className="flex-1 min-w-0 bg-[#0b1120] text-slate-900 overflow-hidden flex flex-col relative">
      {/* Top header bar */}
      <div className="flex items-center justify-between gap-2 px-3 sm:px-5 bg-[#0b1120] border-b border-slate-800" style={{ minHeight: '4rem' }}>
        <div className="flex items-center gap-3 min-w-0">
          {/* Back to queue — disabled while annotating so you can't leave with
              unsaved drawings (the save dialog is the only exit then). */}
          <button
            onClick={() => setPage('queue')}
            title="Back to queue"
            disabled={isDrawing}
            className="p-2.5 rounded-[10px] text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-all shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <p className="text-sm font-bold text-white truncate leading-tight">{currentCase.patient}</p>
            <p className="mono text-[11px] text-slate-500 truncate">
              {currentCase.site.toLowerCase()} · wsi viewer
              {/* If this case came from a CHC intake, show the source CHC + attendant */}
              {(currentCase.chcName || currentCase.attendant) &&
                ` · ${[currentCase.chcName, currentCase.attendant].filter(Boolean).join(' · ')}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {/* Saved marks are now drawn live over the slide, so offer a way to
              see the clean original. Hidden while annotating (you obviously
              need to see what you're drawing) and when there's nothing saved. */}
          {!isDrawing && hasAnnotations(annotations[id]) && (
            <button
              onClick={() => setShowAnnotations((s) => !s)}
              title={showAnnotations ? 'Hide annotations' : 'Show annotations'}
              className={`p-2.5 rounded-[10px] border transition-all ${
                showAnnotations
                  ? 'text-indigo-200 bg-indigo-950 border-indigo-800 hover:bg-indigo-900'
                  : 'text-slate-300 bg-slate-800 border-slate-700 hover:bg-slate-700'
              }`}
            >
              {showAnnotations ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          )}
          <button
            onClick={exportAnnotations}
            title="Export annotated image"
            className="p-2.5 rounded-[10px] text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-all"
          >
            <Download className="w-4 h-4" />
          </button>
          {/* The Annotate toggle: when off it enters annotation mode; when on it
              opens the save/discard dialog (which then exits). */}
          <button
            onClick={() => (isDrawing ? setShowSaveModal(true) : enableAnnotation())}
            className={`inline-flex items-center gap-2 px-3.5 sm:px-4 py-2.5 rounded-[10px] text-[11px] font-bold uppercase tracking-wide transition-all border ${
              isDrawing
                ? 'bg-red-600 text-white border-red-500 hover:bg-red-700 shadow-md shadow-red-900/40'
                : 'bg-indigo-600 text-white border-indigo-500 hover:bg-indigo-500 shadow-md shadow-indigo-900/40'
            }`}
          >
            {isDrawing ? <PencilOff className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{isDrawing ? 'Disable Annotation' : 'Enable Annotation'}</span>
            <span className="sm:hidden">{isDrawing ? 'Disable' : 'Annotate'}</span>
          </button>
        </div>
      </div>

      {/* Annotation toolbar — color and tool must both be picked each session */}
      {isDrawing && (
        <div className="flex items-center gap-3 px-3 sm:px-5 py-2.5 bg-slate-900 border-b border-slate-800 overflow-x-auto">
          {/* Color swatches — not applicable to the eraser, so they grey out
              and stop responding while it is selected */}
          <div className={`flex items-center gap-2 shrink-0 transition-opacity ${annotationTool === 'eraser' ? 'opacity-30 pointer-events-none' : ''}`}>
            <span className="mono text-[10px] text-slate-500 uppercase tracking-widest font-bold hidden md:inline">Color</span>
            {COLORS.map((c) => (
              <button
                key={c.value}
                title={c.label}
                disabled={annotationTool === 'eraser'}
                onClick={() => setAnnotationColor(c.value)}
                style={{ backgroundColor: c.value }}
                className={`w-5 h-5 sm:w-[22px] sm:h-[22px] rounded-full transition-transform hover:scale-110 ${
                  annotationColor === c.value && annotationTool !== 'eraser'
                    ? 'outline outline-2 outline-white outline-offset-2 scale-110'
                    : c.value === '#000000' ? 'border border-slate-700' : ''
                }`}
              />
            ))}
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-slate-700 shrink-0" />

          {/* Shape tools */}
          <div className="flex items-center gap-1 shrink-0 bg-slate-800 rounded-[11px] p-1 border border-slate-700">
            {TOOLS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  title={t.label}
                  onClick={() => setAnnotationTool(t.id)}
                  className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-[7px] rounded-lg text-xs font-semibold transition-all ${
                    annotationTool === t.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-700/70'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden lg:inline">{t.label}</span>
                </button>
              );
            })}
          </div>

          {/* Right side: the "pick a tool" hint (until one is chosen) and an
              instant Save button that saves the work so far WITHOUT leaving
              annotation mode — so you can keep drawing. */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {!annotationTool && (
              <span className="flex items-center gap-1.5 text-[11px] text-amber-300 font-semibold bg-amber-400/10 px-3 py-1.5 rounded-full ring-1 ring-amber-400/20">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                Select a tool to start
              </span>
            )}
            <button
              onClick={saveAnnotationsNow}
              title="Save annotations now and keep editing"
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[11px] font-bold uppercase tracking-wide border bg-emerald-600 text-white border-emerald-500 hover:bg-emerald-500 shadow-md shadow-emerald-900/40 transition-all"
            >
              {savedFlash === 'annotation'
                ? <><Check className="w-3.5 h-3.5" /> Saved</>
                : <><Save className="w-3.5 h-3.5" /> Save</>}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 relative">
        {/* The viewer chunk downloads the first time a slide is opened; this
            fallback covers that brief gap. */}
        <React.Suspense fallback={
          <div className="absolute inset-0 flex items-center justify-center text-slate-400">
            <span className="flex items-center gap-2 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading viewer…
            </span>
          </div>
        }>
          <WsiViewer
            ref={viewerApiRef}
            caseData={currentCase}
            annotationMode={isDrawing}
            annotationColor={annotationColor}
            annotationTool={annotationTool}
            savedAnnotations={annotations[id]}
            showAnnotations={showAnnotations || isDrawing}
          />
        </React.Suspense>
      </div>

      {/* Floating button to the prescription page — hidden while annotating */}
      {!isDrawing && (
        <button
          onClick={() => setPage('details')}
          className="absolute bottom-5 right-5 z-[70] flex items-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-full font-semibold text-sm shadow-lg shadow-indigo-950/50 border border-indigo-500 hover:bg-indigo-500 hover:shadow-xl active:scale-95 transition-all"
        >
          <FileText className="w-4 h-4" />
          <span className="hidden sm:inline">Prescription &amp; Info</span>
        </button>
      )}

      {/* Save-changes dialog, shown when leaving annotation mode.
          There is no way out of annotation mode that skips this — the rail,
          the Back button and the Annotate toggle are all blocked while
          drawing — so unsaved marks can't be lost by navigating away.
          "Don't Save" reverts to the state this SESSION began in, which
          includes any previously saved marks; it doesn't wipe the case. */}
      {showSaveModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center border border-gray-200">
            <div className="mx-auto w-12 h-12 rounded-full bg-indigo-50 ring-8 ring-indigo-50/50 flex items-center justify-center mb-4">
              <Pencil className="w-5 h-5 text-indigo-600" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 tracking-tight">Save annotations?</h3>
            <p className="text-sm text-slate-500 mt-2 mb-6 leading-relaxed">
              Do you want to keep the annotations you made on {currentCase.patient}'s slide?
            </p>
            <div className="flex gap-3">
              <button
                onClick={discardAndClose}
                className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-slate-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition-all"
              >
                Don't Save
              </button>
              <button
                onClick={saveAndClose}
                className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white bg-indigo-600 hover:bg-indigo-700 shadow-md shadow-indigo-600/25 transition-all"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};

export default TelepathologyDashboard;
