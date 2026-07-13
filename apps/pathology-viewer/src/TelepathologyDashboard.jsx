/**
 * TelepathologyDashboard — the whole application UI and state.
 * ---------------------------------------------------------------------------
 * It is a single component that renders ONE of three "pages" based on the
 * `page` state value (there is no router library — just conditional returns):
 *   'queue'   → the FNAC patient worklist.
 *   'slide'   → the WSI viewer (<WsiViewer/>) plus the annotation toolbar.
 *   'details' → the per-patient prescription / clinical notes.
 *
 * It owns all app state: which patient is selected, annotation tool/color, the
 * clinical text for each patient, and the saved annotated images. It talks to
 * the slide viewer through `viewerApiRef` (save / discard / export).
 */
import React, { useState, useRef, useEffect } from 'react';
// Icons used across the UI (tree-shaken from the lucide icon set).
import {
  Clock, Pencil, Square, Circle, Eraser, ArrowLeft, FileText, Download,
  Microscope, ChevronRight, ClipboardList, Stethoscope, Pill, ShieldCheck,
  Save, Eye, FileImage, Check, X, Loader2,
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
  'bg-blue-100 text-blue-700',
  'bg-violet-100 text-violet-700',
  'bg-teal-100 text-teal-700',
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

// A white card with an icon-badge header, used for each section on the details
// page. `children` is the card body. (Destructuring `icon: Icon` lets us use it
// as a JSX component, which must be capitalised.)
const SectionCard = ({ icon: Icon, title, children }) => (
  // `h-full flex flex-col` lets the card fill its grid cell so cards sitting in
  // the same row share one height (no ragged, scattered edges). The body wrapper
  // flexes, so a textarea inside can grow and pin its buttons to the card bottom.
  <section className="bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-sm p-5 sm:p-6 h-full flex flex-col">
    <div className="flex items-center gap-2.5 mb-4 shrink-0">
      <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5 text-blue-600" />
      </div>
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">{title}</h3>
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

  /* ============ PAGE 1 — FNAC QUEUE ============ */
  if (page === 'queue') {
    // Quick at-a-glance counts shown in the summary tiles below the header.
    const pendingCount = cases.filter(c => c.status === 'Pending').length;
    const stats = [
      { label: 'Total',    value: cases.length,                icon: ClipboardList, tint: 'bg-blue-50 text-blue-600' },
      { label: 'Pending',  value: pendingCount,                icon: Clock,         tint: 'bg-amber-50 text-amber-600' },
      { label: 'Reported', value: cases.length - pendingCount, icon: ShieldCheck,   tint: 'bg-emerald-50 text-emerald-600' },
    ];

    return (
      <div className="h-[100dvh] bg-slate-100 clinical-bg text-slate-900 overflow-hidden flex flex-col">
        {/* App header */}
        <header className="shrink-0 bg-white border-b border-slate-200/80 px-4 sm:px-8 py-4 shadow-sm">
          <div className="max-w-6xl mx-auto w-full flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-sm shrink-0">
              <Microscope className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-bold tracking-tight text-slate-900 leading-tight">Telepathology Console</h1>
              <p className="text-xs text-slate-500 font-medium">FNAC review queue</p>
            </div>
            <span className="ml-auto text-xs font-semibold text-slate-500 bg-slate-100 rounded-full px-3 py-1 ring-1 ring-slate-200 shrink-0">
              {cases.length} cases
            </span>
          </div>
        </header>

        {/* Main work area — fills all the space between header and footer so the
            page never looks half-empty on a large screen. */}
        <main className="flex-1 min-h-0 px-4 sm:px-8 py-5 sm:py-6 flex flex-col">
          <div className="max-w-6xl mx-auto w-full flex-1 min-h-0 flex flex-col">
            {/* Summary tiles */}
            <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-4 sm:mb-5 shrink-0">
              {stats.map((s) => {
                const Icon = s.icon;
                return (
                  <div key={s.label} className="bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-sm px-3.5 sm:px-5 py-3.5 sm:py-4 flex items-center gap-3 sm:gap-4">
                    <div className={`w-9 h-9 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center shrink-0 ${s.tint}`}>
                      <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xl sm:text-2xl font-bold text-slate-900 leading-none">{s.value}</p>
                      <p className="text-[11px] sm:text-xs text-slate-500 font-medium mt-1 truncate">{s.label}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Worklist panel — a single framed surface that stretches to fill the
                remaining height, so spare space reads as part of the worklist
                rather than as empty backdrop. Rows scroll inside it. */}
            <div className="flex-1 min-h-0 flex flex-col bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-sm overflow-hidden">
              <div className="shrink-0 flex items-center justify-between gap-2 px-4 sm:px-6 py-3.5 border-b border-slate-100">
                <h2 className="text-sm font-bold text-slate-800">Patient Worklist</h2>
                <span className="text-[11px] sm:text-xs text-slate-400 font-medium">Select a patient to open the slide</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-100">
                {cases.map((c, i) => (
                  <button
                    key={c.id}
                    onClick={() => openCase(c.id)}
                    className="group w-full flex items-center gap-3 sm:gap-4 px-4 sm:px-6 py-4 text-left transition-colors hover:bg-blue-50/50"
                  >
                    <div className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${AVATAR_TINTS[i % AVATAR_TINTS.length]}`}>
                      {initialsOf(c.patient)}
                    </div>
                    <div className="min-w-0">
                      <span className="font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">{c.patient}</span>
                      <p className="text-xs text-slate-500 font-medium mt-0.5 truncate">
                        {c.site} &nbsp;·&nbsp; {c.age} yrs / {c.gender}
                      </p>
                      {/* Who submitted it, from which CHC — shown for cases sent
                          in from the intake app (demo patients don't have these). */}
                      {(c.chcName || c.attendant) && (
                        <p className="text-[11px] text-slate-400 font-medium mt-0.5 truncate">
                          {[c.chcName, c.attendant].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                    {/* Pushed to the right edge so the wide row reads like a table */}
                    <div className="ml-auto flex items-center gap-3 sm:gap-6 shrink-0">
                      <span className="hidden sm:block text-xs font-medium text-slate-400 tabular-nums">{c.date}</span>
                      <StatusPill status={c.status} />
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-500 group-hover:translate-x-0.5 transition-all" />
                    </div>
                  </button>
                ))}
                {/* Loading indicator while submitted patients are being fetched */}
                {loadingCases && (
                  <div className="flex items-center justify-center gap-2 px-4 sm:px-6 py-4 text-sm text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading patients…
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Footer status bar — anchors the bottom of the page */}
        <footer className="shrink-0 border-t border-slate-200/70 bg-white/70 backdrop-blur-sm px-4 sm:px-8 py-2.5">
          <div className="max-w-6xl mx-auto w-full flex items-center justify-between text-[11px] font-medium text-slate-400">
            <span>Telepathology Console · EPTB Hub</span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live · synced
            </span>
          </div>
        </footer>
      </div>
    );
  }

  /* ============ PAGE 3 — PRESCRIPTION / DETAILS ============ */
  if (page === 'details') {
    // Shared Tailwind class strings, kept in variables so the markup below
    // stays readable and the buttons/textareas look identical.
    const taClass = "w-full flex-1 min-h-[8rem] resize-none p-3.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50 placeholder:text-slate-400";
    const btnSecondary = "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-700 bg-slate-100 ring-1 ring-slate-200 hover:bg-slate-200 active:scale-95 transition-all";
    const btnPrimary = "inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm active:scale-95 transition-all";

    return (
      <div className="h-[100dvh] bg-slate-100 clinical-bg text-slate-900 overflow-y-auto flex flex-col">
        <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-slate-200/80 px-4 sm:px-8 py-3.5 shadow-sm flex items-center gap-3 z-10">
          <button
            onClick={() => setPage('slide')}
            title="Back to slide"
            className="p-2.5 rounded-xl text-slate-600 bg-slate-100 hover:bg-slate-200 ring-1 ring-slate-200 transition-all shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-bold shrink-0">
            {initialsOf(currentCase.patient)}
          </div>
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 truncate leading-tight">{currentCase.patient}</h2>
            <p className="text-xs text-slate-500 font-medium">{currentCase.age} years · {currentCase.gender} · {currentCase.site}</p>
          </div>
          <div className="ml-auto shrink-0"><StatusPill status={currentCase.status} /></div>
        </div>

        <div className="max-w-5xl mx-auto my-auto w-full px-4 sm:px-8 py-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* 1. NIKSAY Patient Information — read-only facts shown as a 2-col grid */}
          <SectionCard icon={ClipboardList} title="1. NIKSAY Patient Information">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-slate-100 rounded-xl overflow-hidden ring-1 ring-slate-200/70 flex-1 auto-rows-fr">
              {[
                ['Patient Name', currentCase.patient],
                ['Age / Gender', `${currentCase.age} yrs · ${currentCase.gender}`],
                ['Registration ID', `NK-2026-${currentCase.id}001`],
                ['Specimen Site', currentCase.site],
                ['Status', currentCase.status],
                ['Collected', currentCase.date],
              ].map(([k, v]) => (
                <div key={k} className="bg-slate-50/80 px-4 py-3 flex flex-col justify-center">
                  <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{k}</dt>
                  <dd className={`text-sm font-semibold mt-0.5 ${k === 'Status' ? 'text-emerald-600' : 'text-slate-800'}`}>{v}</dd>
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
              <button onClick={viewAnnotatedImage} className={btnSecondary}>
                <FileImage className="w-3.5 h-3.5" /> View Annotated Image
              </button>
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
              <button onClick={viewAnnotatedImage} className={btnSecondary}>
                <FileImage className="w-3.5 h-3.5" /> View Annotated Image
              </button>
              <button onClick={viewPathologistNotes} className={btnSecondary}>
                <Eye className="w-3.5 h-3.5" /> View Pathologist Notes
              </button>
              <button onClick={saveMedicine} className={btnPrimary}>
                {savedFlash === 'medicine'
                  ? <><Check className="w-3.5 h-3.5" /> Saved</>
                  : <><Save className="w-3.5 h-3.5" /> Save Notes</>}
              </button>
            </div>
            <button className="w-full mt-5 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm tracking-wide hover:bg-blue-700 active:scale-[0.99] shadow-md shadow-blue-600/20 transition-all">
              Sign &amp; Submit Report
            </button>
          </SectionCard>
        </div>

        {/* Footer status bar — anchored to the bottom (mt-auto) so a short report
            still fills the screen instead of leaving a large empty gap. */}
        <footer className="shrink-0 border-t border-slate-200/70 bg-white/70 backdrop-blur-sm px-4 sm:px-8 py-2.5">
          <div className="max-w-5xl mx-auto w-full flex items-center justify-between text-[11px] font-medium text-slate-400">
            <span>Telepathology Console · EPTB Hub</span>
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
              className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col ring-1 ring-slate-200 overflow-hidden"
            >
              <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-900 truncate">{modal.title}</h3>
                <button onClick={() => setModal(null)} className="ml-auto p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 transition-all shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-5 overflow-y-auto">
                {modal.type === 'image' && (
                  <>
                    <img src={modal.src} alt="Annotated slide" className="w-full rounded-xl ring-1 ring-slate-200" />
                    <a
                      href={modal.src}
                      download={`annotation-${currentCase.patient}.png`}
                      className="mt-4 w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition-all"
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
    );
  }

  /* ============ PAGE 2 — SLIDE VIEWER ============ */
  // (This is the default return — reached when page is neither 'queue' nor 'details'.)
  return (
    <div className="h-[100dvh] bg-slate-950 text-slate-900 overflow-hidden flex flex-col relative">
      {/* Top header bar */}
      <div className="flex items-center justify-between gap-2 px-3 sm:px-5 bg-slate-950 border-b border-slate-800/80" style={{ minHeight: '4rem' }}>
        <div className="flex items-center gap-3 min-w-0">
          {/* Back to queue — disabled while annotating so you can't leave with
              unsaved drawings (the save dialog is the only exit then). */}
          <button
            onClick={() => setPage('queue')}
            title="Back to queue"
            disabled={isDrawing}
            className="p-2.5 rounded-xl text-slate-300 bg-slate-800/80 hover:bg-slate-700 ring-1 ring-slate-700/50 transition-all shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate leading-tight">{currentCase.patient}</p>
            <p className="text-[11px] text-slate-400 font-medium truncate">
              {currentCase.site} · WSI viewer
              {/* If this case came from a CHC intake, show the source CHC + attendant */}
              {(currentCase.chcName || currentCase.attendant) &&
                ` · ${[currentCase.chcName, currentCase.attendant].filter(Boolean).join(' · ')}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={exportAnnotations}
            title="Export annotated image"
            className="p-2.5 rounded-xl text-slate-300 bg-slate-800/80 hover:bg-slate-700 ring-1 ring-slate-700/50 transition-all"
          >
            <Download className="w-4 h-4" />
          </button>
          {/* The Annotate toggle: when off it enters annotation mode; when on it
              opens the save/discard dialog (which then exits). */}
          <button
            onClick={() => (isDrawing ? setShowSaveModal(true) : enableAnnotation())}
            className={`px-3.5 sm:px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide transition-all ring-1 ${
              isDrawing
                ? 'bg-red-600 text-white ring-red-500 hover:bg-red-700 shadow-md shadow-red-900/40'
                : 'bg-blue-600 text-white ring-blue-500 hover:bg-blue-500 shadow-md shadow-blue-900/40'
            }`}
          >
            <span className="hidden sm:inline">{isDrawing ? 'Disable Annotation' : 'Enable Annotation'}</span>
            <span className="sm:hidden">{isDrawing ? 'Disable' : 'Annotate'}</span>
          </button>
        </div>
      </div>

      {/* Annotation toolbar — color and tool must both be picked each session */}
      {isDrawing && (
        <div className="flex items-center gap-3 px-3 sm:px-5 py-2.5 bg-slate-900 border-b border-slate-800/80 overflow-x-auto">
          {/* Color swatches — not applicable to the eraser, so they grey out
              and stop responding while it is selected */}
          <div className={`flex items-center gap-1.5 shrink-0 transition-opacity ${annotationTool === 'eraser' ? 'opacity-30 pointer-events-none' : ''}`}>
            <span className="text-[11px] text-slate-400 mr-1 uppercase tracking-widest font-semibold hidden md:inline">Color</span>
            {COLORS.map((c) => (
              <button
                key={c.value}
                title={c.label}
                disabled={annotationTool === 'eraser'}
                onClick={() => setAnnotationColor(c.value)}
                style={{ backgroundColor: c.value }}
                className={`w-5 h-5 sm:w-6 sm:h-6 rounded-full ring-2 ring-offset-2 ring-offset-slate-900 transition-transform hover:scale-110 ${
                  annotationColor === c.value && annotationTool !== 'eraser' ? 'ring-white scale-110' : 'ring-transparent'
                }`}
              />
            ))}
          </div>

          {/* Divider */}
          <div className="w-px h-6 bg-slate-700 shrink-0" />

          {/* Shape tools */}
          <div className="flex items-center gap-1 shrink-0 bg-slate-800/80 rounded-xl p-1 ring-1 ring-slate-700/50">
            {TOOLS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  title={t.label}
                  onClick={() => setAnnotationTool(t.id)}
                  className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    annotationTool === t.id ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-slate-700/70'
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide ring-1 bg-emerald-600 text-white ring-emerald-500 hover:bg-emerald-500 shadow-md shadow-emerald-900/40 transition-all"
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
          className="absolute bottom-5 right-5 z-[70] flex items-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-full font-semibold text-sm shadow-lg shadow-blue-950/50 ring-1 ring-blue-500 hover:bg-blue-500 hover:shadow-xl active:scale-95 transition-all"
        >
          <FileText className="w-4 h-4" />
          <span className="hidden sm:inline">Prescription &amp; Info</span>
        </button>
      )}

      {/* Save-changes dialog shown when leaving annotation mode */}
      {showSaveModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center ring-1 ring-slate-200">
            <div className="mx-auto w-12 h-12 rounded-full bg-blue-50 ring-8 ring-blue-50/50 flex items-center justify-center mb-4">
              <Pencil className="w-5 h-5 text-blue-600" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 tracking-tight">Save annotations?</h3>
            <p className="text-sm text-slate-500 mt-2 mb-6 leading-relaxed">
              Do you want to keep the annotations you made on {currentCase.patient}'s slide?
            </p>
            <div className="flex gap-3">
              <button
                onClick={discardAndClose}
                className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-slate-600 bg-slate-100 ring-1 ring-slate-200 hover:bg-slate-200 transition-all"
              >
                Don't Save
              </button>
              <button
                onClick={saveAndClose}
                className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-600/25 transition-all"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TelepathologyDashboard;
