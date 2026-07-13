/**
 * TelepathologyDashboard — the whole application UI and state.
 * ---------------------------------------------------------------------------
 * It is a single component that renders ONE of three "pages" based on the
 * `page` state value (there is no router library — just conditional returns):
 *   'queue'   → the FNAC patient worklist.
 *   'slide'   → the WSI viewer (<WsiViewer/>) plus the annotation toolbar.
 *   'details' → the per-patient prescription / clinical notes.
 *
 * "Pro Workstation" theme: a dark navy navigation rail + indigo accent replace
 * the earlier blue/white look, and clinical figures (IDs, ages, dates) render
 * in a monospaced font. All state, effects, refs and handlers are unchanged.
 *
 * It owns all app state: which patient is selected, annotation tool/color, the
 * clinical text for each patient, and the saved annotated images. It talks to
 * the slide viewer through `viewerApiRef` (save / discard / export).
 */
import React, { useState, useRef, useEffect } from 'react';
// Icons used across the UI (tree-shaken from the lucide icon set).
import {
  Clock, Pencil, PencilOff, Square, Circle, Eraser, ArrowLeft, FileText, Download,
  Microscope, ChevronRight, ClipboardList, Stethoscope, Pill, ShieldCheck,
  Save, Eye, FileImage, Check, X, Loader2,
  ListChecks, Images, Search,
} from 'lucide-react';
import WsiViewer from './WsiViewer';
import { apiGet, apiPut, getCases, getCaseImage } from './api';

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
const Rail = ({ active, count, onNav, disabled, onToggle }) => (
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

const TelepathologyDashboard = () => {
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
  // Composited annotated image (slide + drawings) per patient, kept separate
  // from the live slide so the original is never altered.
  const [annotatedImages, setAnnotatedImages] = useState(() => loadLS('pv_annotatedImages'));
  const [savedFlash, setSavedFlash] = useState(null);   // which Save button just fired
  const [modal, setModal] = useState(null);             // viewer overlay {type,title,...}
  const [intakeCases, setIntakeCases] = useState([]);   // patients submitted from the CHC intake app
  const [loadingCases, setLoadingCases] = useState(true); // initial fetch of intake patients in flight

  // Mirror saved values into the local cache whenever they change.
  useEffect(() => { saveLS('pv_clinicalSaved', clinicalSaved); }, [clinicalSaved]);
  useEffect(() => { saveLS('pv_pathologistSaved', pathologistSaved); }, [pathologistSaved]);
  useEffect(() => { saveLS('pv_medicineSaved', medicineSaved); }, [medicineSaved]);
  useEffect(() => { saveLS('pv_annotatedImages', annotatedImages); }, [annotatedImages]);

  // On load, pull the latest data from the shared backend so notes / annotated
  // images saved on ANOTHER machine appear here too. If the backend is offline
  // we silently keep the local cache the state was seeded with.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, p, m, a] = await Promise.all([
          apiGet('pv_clinicalSaved'),
          apiGet('pv_pathologistSaved'),
          apiGet('pv_medicineSaved'),
          apiGet('pv_annotatedImages'),
        ]);
        if (cancelled) return;
        setClinicalSaved(c);
        setPathologistSaved(p);
        setMedicineSaved(m);
        setAnnotatedImages(a);
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
    const load = async (initial) => {
      try {
        const list = await getCases();
        if (cancelled || !Array.isArray(list)) return;
        setIntakeCases(prev => {
          const known = new Set(prev.map(c => c.id));
          const additions = list.filter(c => !known.has(c.id));
          return additions.length ? [...prev, ...additions] : prev; // unchanged ⇒ no re-render
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

  const openCase = (cid) => {
    setActiveCase(cid);
    setPage('slide');
    // Intake patients arrive without their image (kept out of the list for
    // speed); fetch it now so the WSI viewer can show the slide.
    const c = intakeCases.find(x => x.id === cid);
    if (c && c.hasImage && !c.image) {
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

  // Persist the current annotations as the full-resolution annotated image and
  // push to the backend. Shared by the instant Save and the save-on-close flow.
  const persistAnnotations = async () => {
    const png = await viewerApiRef.current?.save();
    if (png) {
      const next = { ...annotatedImages, [id]: png };
      setAnnotatedImages(next);
      apiPut('pv_annotatedImages', next);
    }
    return !!png;
  };

  // Instant Save — saves the work so far but STAYS in annotation mode so the
  // user can keep drawing. Gives a brief "Saved" confirmation on the button.
  const saveAnnotationsNow = async () => {
    if (await persistAnnotations()) flashSaved('annotation');
  };

  const saveAndClose = async () => {
    // save() builds a brand-new full-resolution annotated image; we keep it as
    // a separate artifact and push it to the shared backend. The live slide is
    // never altered.
    await persistAnnotations();
    setShowSaveModal(false);
    setIsDrawing(false);
  };

  const discardAndClose = async () => {
    await viewerApiRef.current?.discard();
    setShowSaveModal(false);
    setIsDrawing(false);
  };

  const exportAnnotations = async () => {
    const dataURL = annotatedImages[id] || await viewerApiRef.current?.exportPNG();
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
  const saveClinical = () => {
    const next = { ...clinicalSaved, [id]: clinicalDraft[id] ?? defaultClinical };
    setClinicalSaved(next);
    apiPut('pv_clinicalSaved', next);
    setClinicalDraft(prev => ({ ...prev, [id]: '' }));
    flashSaved('clinical');
  };
  const savePathologist = () => {
    const next = { ...pathologistSaved, [id]: pathologistDraft[id] ?? '' };
    setPathologistSaved(next);
    apiPut('pv_pathologistSaved', next);
    setPathologistDraft(prev => ({ ...prev, [id]: '' }));
    flashSaved('pathologist');
  };
  const saveMedicine = () => {
    const next = { ...medicineSaved, [id]: medicineDraft[id] ?? '' };
    setMedicineSaved(next);
    apiPut('pv_medicineSaved', next);
    setMedicineDraft(prev => ({ ...prev, [id]: '' }));
    flashSaved('medicine');
  };

  // Modal openers
  const viewAnnotatedImage = () => {
    const src = annotatedImages[id];
    if (src) setModal({ type: 'image', title: `Annotated slide — ${currentCase.patient}`, src });
    else setModal({ type: 'message', title: 'No annotated image', text: 'No annotated image has been saved for this patient yet. Open the slide, annotate it, and choose “Save Changes”.' });
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
  // A refined "icon-chip" secondary button (was a flat grey button before).
  const ChipButton = ({ icon: Icon, label, onClick }) => (
    <button onClick={onClick}
      className="inline-flex items-center gap-2.5 bg-white text-indigo-900 border border-[#e0e2f0] rounded-[10px] pl-[5px] pr-3.5 py-[5px] text-xs font-semibold shadow-sm hover:border-indigo-300 active:scale-95 transition-all">
      <span className="w-[26px] h-[26px] rounded-[7px] bg-indigo-50 text-indigo-600 flex items-center justify-center">
        <Icon className="w-3.5 h-3.5" />
      </span>
      {label}
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
    // search box (matches patient name or specimen site, case-insensitive).
    const q = queueSearch.trim().toLowerCase();
    const filteredCases = cases.filter((c) => {
      const matchesStatus = queueStatusFilter === 'All' || c.status === queueStatusFilter;
      const matchesSearch = !q || c.patient.toLowerCase().includes(q) || (c.site || '').toLowerCase().includes(q);
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
          ? <Rail active="queue" count={cases.length} onNav={navigateTo} disabled={isDrawing} onToggle={() => setRailOpen(false)} />
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
                placeholder="Search patients…"
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
                  return (
                    <button
                      key={c.id}
                      onClick={() => openCase(c.id)}
                      className={`group w-full grid ${gridCols} gap-3 sm:gap-3.5 items-center px-4 sm:px-6 py-4 sm:py-[15px] text-left transition-colors hover:bg-indigo-50/40`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`mono w-11 h-11 sm:w-[38px] sm:h-[38px] rounded-full sm:rounded-[9px] flex items-center justify-center text-sm sm:text-[13px] font-bold shrink-0 ${AVATAR_TINTS[tintIndex % AVATAR_TINTS.length]}`}>
                          {initialsOf(c.patient)}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 group-hover:text-indigo-700 transition-colors truncate">{c.patient}</div>
                          {/* NIKSHAY-style registration id, under the patient name. */}
                          <div className="mono text-[11px] text-slate-400 mt-0.5 truncate">NK-2026-{c.id}001</div>
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
                      <div><StatusPill status={c.status} /></div>
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition-all justify-self-end" />
                    </button>
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
        </div>
      </div>
    );
  }

  /* ============ PAGE 3 — PRESCRIPTION / DETAILS ============ */
  if (page === 'details') {
    return (
      <div className="h-[100dvh] rail-dark text-slate-900 overflow-hidden flex">
        {railOpen
          ? <Rail active="reports" count={cases.length} onNav={navigateTo} disabled={isDrawing} onToggle={() => setRailOpen(false)} />
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
          <div className="flex-1 min-h-0 w-full px-4 sm:px-8 py-6 grid grid-cols-1 lg:grid-cols-2 lg:auto-rows-fr gap-5">
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

            {/* 3. Pathologist Consultation — view annotated image + save notes */}
            <SectionCard icon={Stethoscope} title="3. Pathologist Consultation">
              <textarea
                className={taClass}
                placeholder="Enter microscopic findings…"
                value={pathologistDraft[id] ?? ''}
                onChange={(e) => setPathologistDraft(prev => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex flex-wrap gap-2 mt-4">
                <ChipButton icon={FileImage} label="View Annotated Image" onClick={viewAnnotatedImage} />
                <button onClick={savePathologist} className={btnPrimary}>
                  {savedFlash === 'pathologist'
                    ? <><Check className="w-3.5 h-3.5" /> Saved</>
                    : <><Save className="w-3.5 h-3.5" /> Save Notes</>}
                </button>
              </div>
            </SectionCard>

            {/* 4. Medicine Consultation — view image + view pathologist notes + save */}
            <SectionCard icon={Pill} title="4. Medicine Consultation">
              <textarea
                className={taClass}
                placeholder="Physician recommendations…"
                value={medicineDraft[id] ?? ''}
                onChange={(e) => setMedicineDraft(prev => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex flex-wrap gap-2 mt-4">
                <ChipButton icon={FileImage} label="View Annotated Image" onClick={viewAnnotatedImage} />
                <ChipButton icon={Eye} label="View Pathologist Notes" onClick={viewPathologistNotes} />
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
                  {modal.type === 'image' && (
                    <>
                      <img src={modal.src} alt="Annotated slide" className="w-full rounded-xl border border-gray-200" />
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
        ? <Rail active="slides" count={cases.length} onNav={navigateTo} disabled={isDrawing} onToggle={() => setRailOpen(false)} />
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
        <WsiViewer
          ref={viewerApiRef}
          caseData={currentCase}
          annotationMode={isDrawing}
          annotationColor={annotationColor}
          annotationTool={annotationTool}
        />
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

      {/* Save-changes dialog shown when leaving annotation mode */}
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
