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
 *   • Every patient shown comes from the server. There were once three demo
 *     patients hard-coded here, which looked like real rows but could not be
 *     archived, had no CHC ID, and left orphaned notes in the database when
 *     someone wrote against them.
 *
 * Theme: dark navy navigation rail + indigo accent, with clinical figures
 * (IDs, ages, dates) in a monospaced font.
 */
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
import type { WsiViewerHandle } from './WsiViewer';
import { resolveImageUrl, renderAnnotatedImage, hasAnnotations } from './annotations';
// All server state lives in queries.ts as TanStack Query hooks — see that file
// for why reads are bulk but writes are per-case.
import {
  useCases, useNotes, useAnnotations, useLegacyAnnotatedImages,
  useSaveNote, useSaveAnnotations, useArchiveCase, useDeleteCase, useSignReport,
} from './queries';
import { CAN_EDIT } from './types';
import type { User, Case, CaseStatus, Modal, NoteKind, AnnotationData } from './types';
import type { LucideIcon } from 'lucide-react';

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

// Avatar background tints, chosen per patient by index so each row's circle
// has a stable colour.
const AVATAR_TINTS = [
  'bg-indigo-50 text-indigo-600',
  'bg-violet-50 text-violet-600',
  'bg-teal-50 text-teal-600',
];
// "Patient A" -> "PA": first letter of each word, for the avatar circle.
const initialsOf = (name: string): string =>
  name.split(' ').map((w) => w[0] ?? '').join('').toUpperCase();

// The worklist's own unique patient identifier — shown under the name and
// matched by the search box. Names alone aren't unique (several patients can
// share one), so this is what actually disambiguates them: the SAME "CHC
// Patient ID" the lab attendant typed in at intake (PatientForm.jsx's "CHC
// Patient ID" field, stored as cases.chc_id) — not this app's own internal
// database id, and not the clinical Nikshay/registration id shown elsewhere
// on the Reports page. The built-in demo patients were never submitted
// through intake, so they have none — shown as a muted dash, same as the
// Lab Attendant / CHC columns.
const patientIdLabel = (c: Case): string => (c.chcId ? `CHC ID: ${c.chcId}` : '—');

// Note: the localStorage helpers that used to live here are gone. TanStack
// Query now owns caching (see queries.ts), so mirroring server data into
// localStorage by hand would just be a second, staler copy of the same thing.

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
interface RailProps {
  /** Which nav item to highlight. */
  active: 'queue' | 'slides' | 'reports';
  /** Badge count beside "Patient List". */
  count?: number;
  onNav?: (id: string) => void;
  /** True while drawing — navigation is blocked so marks can't be lost. */
  disabled?: boolean;
  onToggle: () => void;
  user?: User;
  onLogout?: () => void;
}

const Rail = ({ active, count, onNav, disabled, onToggle, user, onLogout }: RailProps) => (
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
const RailCollapsed = ({ onToggle }: { onToggle: () => void }) => (
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
interface SectionCardProps {
  /** Any lucide icon — they all share this props shape. */
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}

const SectionCard = ({ icon: Icon, title, children }: SectionCardProps) => (
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
const StatusPill = ({ status }: { status: CaseStatus }) => (
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

/** Which of the three views this instance is rendering. */
export type DashboardView = 'queue' | 'slide' | 'details';

interface DashboardProps {
  user: User;
  onLogout: () => void;
  /** Chosen by the route, not by internal state — see App.tsx. */
  view: DashboardView;
  /** The :caseId from the URL. Absent on the queue route. */
  caseId?: number;
}

const TelepathologyDashboard = ({ user, onLogout, view, caseId }: DashboardProps) => {
  // Navigation is now the URL's job, not a state variable. `page` used to hold
  // 'queue' | 'slide' | 'details'; it's replaced by the `view` prop, which the
  // router derives from the address. That is what makes a case linkable and
  // the browser Back button work.
  const navigate = useNavigate();
  const page = view;
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
    const applyToViewport = (e: MediaQueryListEvent) => setRailOpen(e.matches);
    mq.addEventListener('change', applyToViewport);
    return () => mq.removeEventListener('change', applyToViewport);
  }, []);
  // Queue worklist controls: free-text search (matches patient name, specimen
  // site or CHC patient ID) and a status filter tab. Both are plain
  // client-side filters over the loaded case list — no extra request needed.
  const [queueSearch, setQueueSearch] = useState('');
  const [queueStatusFilter, setQueueStatusFilter] = useState<'All' | 'Pending' | 'Reported'>('All');
  // Both start null when annotation mode is enabled: the user must pick a
  // color and a tool every session before they can draw.
  const [annotationColor, setAnnotationColor] = useState<string | null>(null);
  const [annotationTool, setAnnotationTool] = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);

  // --- Server state, via TanStack Query (see queries.ts) ---------------------
  // These four replace what used to be a tangle of useState + useEffect +
  // setInterval inside this component: fetching, polling, caching and merging
  // are all handled there now.
  const casesQuery = useCases();
  const notesQuery = useNotes();
  const annotationsQuery = useAnnotations();
  const legacyImagesQuery = useLegacyAnnotatedImages();

  const saveNoteMutation = useSaveNote();
  const saveAnnotationsMutation = useSaveAnnotations();
  const archiveMutation = useArchiveCase();
  const deleteMutation = useDeleteCase();
  const signMutation = useSignReport();

  // What this account may edit. The server enforces the same rules — this only
  // decides what the screen offers, so nobody types a paragraph into a box
  // whose save will be refused.
  const can = CAN_EDIT[user.role] ?? { findings: false, prescription: false, annotate: false, sign: false };

  const intakeCases = useMemo(() => casesQuery.data ?? [], [casesQuery.data]);
  const loadingCases = casesQuery.isLoading;
  const notesByCase = notesQuery.data ?? {};
  const annotations = annotationsQuery.data ?? {};
  const legacyAnnotatedImages = legacyImagesQuery.data ?? {};

  // Per-patient DRAFT text, held here while the user types. Only the saved
  // copies live on the server; a draft is local until its Save button is hit.
  const [clinicalDraft, setClinicalDraft] = useState<Record<string, string>>({});
  const [pathologistDraft, setPathologistDraft] = useState<Record<string, string>>({});
  const [medicineDraft, setMedicineDraft] = useState<Record<string, string>>({});

  const [showAnnotations, setShowAnnotations] = useState(true);  // slide-page toggle
  const [savedFlash, setSavedFlash] = useState<string | null>(null);   // which Save button just fired
  const [modal, setModal] = useState<Modal | null>(null);              // viewer overlay
  // The case awaiting delete confirmation, or null. Removing a patient is
  // destructive enough to always ask first.
  const [confirmDelete, setConfirmDelete] = useState<Case | null>(null);
  // Permanent deletion is a second, separate step inside the same dialog. It
  // cannot be reached by the click that opened it, so the destructive action is
  // never where the reversible one was a moment ago.
  const [purgeStep, setPurgeStep] = useState(false);
  const deleting = archiveMutation.isPending || deleteMutation.isPending;
  const closeConfirm = () => { setConfirmDelete(null); setPurgeStep(false); };

  // Notes arrive from the server as { caseId: { clinical, pathologist,
  // medicine } }. The three text areas each want a { caseId: body } map, so
  // pivot once here rather than at every read site.
  const savedByKind = useMemo(() => {
    const byKind: Record<NoteKind, Record<string, string>> = {
      clinical: {}, pathologist: {}, medicine: {},
    };
    for (const [cid, kinds] of Object.entries(notesByCase)) {
      for (const [kind, body] of Object.entries(kinds ?? {})) {
        const k = kind as NoteKind;
        if (byKind[k] && typeof body === 'string') byKind[k][cid] = body;
      }
    }
    return byKind;
  }, [notesByCase]);

  const clinicalSaved = savedByKind.clinical;
  const pathologistSaved = savedByKind.pathologist;
  const medicineSaved = savedByKind.medicine;

  const viewerApiRef = useRef<WsiViewerHandle | null>(null);

  // Every patient in the queue comes from the server.
  const cases = intakeCases;

  // Which case the URL points at, falling back to the first available one so a
  // stale id (a case archived in another tab) still shows something.
  //
  // POSSIBLY UNDEFINED, and that is the honest type: with the demo patients
  // gone the worklist really can be empty — a fresh install, or every case
  // archived. It used to be asserted non-null with `!`, which was safe only
  // because three hard-coded patients guaranteed the list was never empty.
  // Removing them turned that assertion into a crash waiting to happen, so
  // the screens below guard for it instead.
  const currentCase: Case | undefined = cases.find((c) => c.id === caseId) ?? cases[0];
  const id = currentCase?.id ?? 0;      // unused when there is no case to show
  const defaultClinical = currentCase
    ? `Palpable nodule identified in the ${String(currentCase.site ?? 'specimen').toLowerCase()}.`
    : '';
  // Which cases can be archived. Every case now comes from the server, so this
  // is all of them — it stays as a set because the row still asks per case.
  const intakeIds = useMemo(() => new Set(intakeCases.map((c) => c.id)), [intakeCases]);

  // Remove a patient from the worklist. This ARCHIVES rather than destroys:
  // the record and its slide stay on disk and can be restored, which is the
  // right default for clinical data — a mis-click shouldn't be unrecoverable.
  /**
   * Erase a patient outright — the record, its notes and annotations, and the
   * slide file on disk.
   *
   * Unlike archiving there is nothing to restore afterwards, which is why it
   * sits behind its own confirmation. The server refuses it for a case that has
   * been signed off, and that refusal is shown as-is rather than reworded: the
   * reason matters more than the failure.
   */
  const purgePatient = async (c: Case) => {
    try {
      await deleteMutation.mutateAsync({ caseId: c.id });
      if (caseId === c.id) navigate('/queue');
      closeConfirm();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not delete this patient.');
    }
  };

  const deletePatient = async (c: Case) => {
    try {
      // The mutation drops it from the cached list itself, so the row
      // disappears the moment the action is confirmed rather than on the
      // next poll — see useArchiveCase in queries.ts.
      await archiveMutation.mutateAsync({ caseId: c.id, archived: true });
      // If the removed patient was the one open, its URL is now dead — send
      // the pathologist back to the worklist rather than leaving them on a
      // case that no longer exists.
      if (caseId === c.id) navigate('/queue');
      closeConfirm();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not remove this patient. Is the backend running?');
    }
  };

  const openCase = (cid: number) => {
    const c = intakeCases.find((x) => x.id === cid);
    // A scanned slide still uploading or converting has nothing to show yet,
    // and a failed one never will — leave the pathologist in the queue rather
    // than opening an empty viewer. The row itself explains the state.
    if (c && (c.slideStatus === 'processing' || c.slideStatus === 'failed')) return;

    // Navigating by URL rather than by state is what makes this case linkable.
    // The route's loader fetches the patient's photo, so there is nothing to
    // trigger here — and doing it here as well would download it twice, since
    // both requests would start before either could see the other's result.
    navigate(`/case/${cid}/slide`);
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
  const navigateTo = (target: string) => {
    if (isDrawing) return;
    if (target === 'queue') navigate('/queue');
    else if (target === 'slides') navigate(`/case/${id}/slide`);
    else if (target === 'reports') navigate(`/case/${id}/report`);
  };

  // Persist the current marks as vector JSON and push to the backend. Shared
  // by the instant Save and the save-on-close flow. This is a few KB per case
  // rather than the ~16 MB flattened PNG the old scheme stored.
  const persistAnnotations = async (): Promise<boolean> => {
    const json = viewerApiRef.current?.save() ?? null;
    if (!json) return false;
    // Writes only THIS case's row, so a colleague saving a different case at
    // the same moment cannot overwrite it. The mutation also updates the
    // cached annotations, so the UI reflects the save immediately.
    await saveAnnotationsMutation.mutateAsync({ caseId: id, data: json as AnnotationData });
    return true;
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
    if (!currentCase) return;
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
  const flashSaved = (key: string) => {
    setSavedFlash(key);
    setTimeout(() => setSavedFlash((f) => (f === key ? null : f)), 1800);
  };

  // Each Save commits the draft to the persisted copy, pushes it to the shared
  // backend (so other machines see it), then clears the textarea.
  //
  // The backend write targets ONE case and ONE note kind. Previously every
  // save re-uploaded a map of every patient's notes, so two people saving
  // different patients at the same moment would silently discard one of the
  // two sets of notes — a real way to lose clinical text. The mutation
  // updates the cached notes on success, so the saved copy appears at once.
  const saveNoteOfKind = (
    kind: NoteKind,
    body: string,
    clearDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  ) => {
    saveNoteMutation.mutate({ caseId: id, kind, body });
    // DELETE the draft rather than blanking it. The textareas fall back to the
    // saved copy when no draft exists, so removing the key makes the just-saved
    // text stay on screen. Setting it to '' (as this did previously) left the
    // box empty and made saved clinical/medicine notes impossible to read back
    // — they were on the server but nothing ever displayed them.
    clearDraft((prev) => {
      const next = { ...prev };
      delete next[String(id)];
      return next;
    });
    flashSaved(kind);
  };

  const saveClinical = () =>
    saveNoteOfKind('clinical', clinicalDraft[String(id)] ?? defaultClinical, setClinicalDraft);
  const savePathologist = () =>
    saveNoteOfKind('pathologist', pathologistDraft[String(id)] ?? '', setPathologistDraft);
  const saveMedicine = () =>
    saveNoteOfKind('medicine', medicineDraft[String(id)] ?? '', setMedicineDraft);

  /** Sign the report. Asks first — it records a name against a diagnosis. */
  const handleSignReport = async () => {
    if (!currentCase) return;
    const ok = window.confirm(
      `Sign and submit the report for ${currentCase.patient}?`
      + ' This records your name against the diagnosis and marks the case as reported.',
    );
    if (!ok) return;
    try {
      await signMutation.mutateAsync({ caseId: id });
    } catch (e) {
      setModal({ type: 'message', title: 'Could not sign the report', text: (e as Error).message });
    }
  };

  // Modal openers
  // The annotated picture is BUILT HERE, on demand, from the saved vector
  // marks — it isn't stored anywhere. Async, so the modal opens immediately in
  // a loading state rather than freezing the page while the slide overview
  // downloads and composites.
  const viewAnnotatedImage = async () => {
    if (!currentCase) return;
    const marks = annotations[String(id)] ?? null;
    const legacy = legacyAnnotatedImages[String(id)] ?? null;

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

    // Built explicitly rather than spread from the previous modal: `Modal` is a
    // discriminated union, and spreading it widens the type so TypeScript can
    // no longer tell which variant this is.
    const ready: Modal = { type: 'image', title, src: src ?? null, rawSrc, showAnnotations: true, loading: false };
    setModal((m) => (m && m.title === title ? ready : m));   // a different modal opened meanwhile — don't clobber it
  };
  const viewPathologistNotes = () => {
    if (!currentCase) return;
    const text = pathologistSaved[String(id)];
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
  const ReviewTile = ({ icon: Icon, label, caption, onClick }: {
    icon: LucideIcon;
    label: string;
    caption: string;
    onClick: () => void;
  }) => (
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
    const pad2 = (n: number) => String(n).padStart(2, "0");
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
                  {(['All', 'Pending', 'Reported'] as const).map((f) => (
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
              onClick={() => !deleting && closeConfirm()}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center border border-gray-200"
              >
                <div className="mx-auto w-12 h-12 rounded-full bg-red-50 ring-8 ring-red-50/50 flex items-center justify-center mb-4">
                  <Trash2 className="w-5 h-5 text-red-600" />
                </div>

                {/* Two steps, deliberately. Archiving is the default because it
                    is the reversible one; erasing has to be chosen, and then
                    confirmed on a screen that says exactly what it destroys. */}
                {!purgeStep ? (
                  <>
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
                        onClick={closeConfirm}
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
                    <button
                      onClick={() => setPurgeStep(true)}
                      disabled={deleting}
                      className="mt-4 text-xs font-semibold text-slate-400 hover:text-red-600 underline underline-offset-4 transition-colors disabled:opacity-60"
                    >
                      Delete permanently instead
                    </button>
                  </>
                ) : (
                  <>
                    <h3 className="text-lg font-bold text-slate-900 tracking-tight">
                      Permanently delete {confirmDelete.patient}?
                    </h3>
                    <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                      This erases the patient record, the slide file, and every
                      note and annotation. The disk space is freed on the server.
                      <span className="block mt-2 font-semibold text-red-600">
                        There is no restore. This cannot be undone.
                      </span>
                    </p>
                    {confirmDelete.chcId && (
                      <p className="mono text-[11px] text-slate-400 mt-3">CHC ID: {confirmDelete.chcId}</p>
                    )}
                    <div className="flex gap-3 mt-6">
                      <button
                        onClick={() => setPurgeStep(false)}
                        disabled={deleting}
                        className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-slate-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition-all disabled:opacity-60"
                      >
                        Back
                      </button>
                      <button
                        onClick={() => purgePatient(confirmDelete)}
                        disabled={deleting}
                        className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-sm text-white bg-red-700 hover:bg-red-800 shadow-md shadow-red-700/30 transition-all disabled:opacity-60"
                      >
                        {deleting
                          ? <><Loader2 className="w-4 h-4 animate-spin" /> Deleting…</>
                          : <><Trash2 className="w-4 h-4" /> Delete permanently</>}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ============ PAGE 3 — PRESCRIPTION / DETAILS ============ */
  // Past this point every screen is about ONE patient, so with none to show
  // there is nothing to render. This replaces an `!` assertion that was only
  // ever safe because three hard-coded demo patients kept the list non-empty.
  if (!currentCase) {
    return (
      <div className="h-[100dvh] rail-dark text-slate-900 overflow-hidden flex">
        {railOpen
          ? <Rail active="reports" count={cases.length} onNav={navigateTo} disabled={false} onToggle={() => setRailOpen(false)} user={user} onLogout={onLogout} />
          : <RailCollapsed onToggle={() => setRailOpen(true)} />}
        <div className="flex-1 min-w-0 clinical-bg flex flex-col items-center justify-center gap-3 text-slate-500">
          <FileText className="w-8 h-8 text-slate-300" />
          <p className="text-sm font-medium">That patient is no longer in the worklist.</p>
          <button
            onClick={() => navigate('/queue')}
            className="mt-1 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold tracking-wide hover:bg-indigo-500 transition-all"
          >
            Back to worklist
          </button>
        </div>
      </div>
    );
  }

  if (page === 'details') {
    return (
      <div className="h-[100dvh] rail-dark text-slate-900 overflow-hidden flex">
        {railOpen
          ? <Rail active="reports" count={cases.length} onNav={navigateTo} disabled={isDrawing} onToggle={() => setRailOpen(false)} user={user} onLogout={onLogout} />
          : <RailCollapsed onToggle={() => setRailOpen(true)} />}
        <div className="flex-1 min-w-0 clinical-bg overflow-y-auto flex flex-col">
          <div className="sticky top-0 bg-white border-b border-gray-200 px-4 sm:px-8 py-3.5 flex items-center gap-3 z-10">
            <button
              onClick={() => navigate(`/case/${id}/slide`)}
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
              header and the footer, at any window size. Rows then split that
              height evenly, and each row's two cards share it evenly across
              columns — so the four cards fill the screen instead of floating
              in the middle of it. On phones (single column) rows fall back to
              their natural content height and the page scrolls if needed.

              WHY `minmax(20rem, 1fr)` RATHER THAN PLAIN `1fr`: a bare `1fr`
              divides the window height no matter how little that leaves, so on
              a laptop under roughly 950px tall the cards were shorter than
              their own contents. The Medicine card — which carries an extra
              Sign & Submit button — overflowed by 76px, and its buttons drew
              on top of the footer. The floor guarantees every card at least
              enough room for its tallest content, `1fr` still stretches them
              equally when the window is tall, and `overflow-y-auto` lets the
              area scroll on short screens instead of spilling.

              THE FIRST ROW'S FLOOR IS HIGHER: 30rem. Patient Information now
              carries the CHC consultant and OPD notes beneath its facts, and at
              20rem the six fact cells alone already filled the whole card — the
              notes would have been left about 30px, or spilled out of the card.
              30rem is the facts at natural height, an 11rem CHC block, and the
              card's own padding and header. An 8rem block was tried first and
              measured at 1440x900 it left the prescription 47px tall — two
              lines — which is too little to read; 11rem gives about four. Only that row is raised: Clinical
              Notes beside it just gets a taller textarea, and the bottom row
              keeps its 20rem. */}
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

            <div className="flex-1 min-h-0 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 lg:grid-rows-[minmax(30rem,1fr)_minmax(20rem,1fr)] lg:auto-rows-[minmax(20rem,1fr)] gap-5">
            {/* 1. NIKSAY Patient Information — read-only facts, then what the CHC
                wrote about the visit. */}
            <SectionCard icon={ClipboardList} title="1. NIKSAY Patient Information">
              {/* `shrink-0`, no longer `flex-1`: the facts keep their natural
                  height and any spare room in the card goes to the CHC notes
                  below, which is the part that actually benefits from it. */}
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-gray-100 rounded-xl overflow-hidden border border-gray-100 shrink-0 auto-rows-fr">
                {/* Typed as a tuple array so `k` is known to be a string and
                    can be used as a React key — an untyped array literal
                    widens every element to `string | boolean`. */}
                {([
                  ['Patient Name', currentCase.patient, false],
                  ['Age / Gender', `${currentCase.age} yrs · ${currentCase.gender}`, true],
                  ['Registration ID', `NK-2026-${currentCase.id}001`, true],
                  ['Specimen Site', currentCase.site, false],
                  ['Status', currentCase.status, false],
                  ['Collected', currentCase.date, true],
                ] as [string, string, boolean][]).map(([k, v, mono]) => (
                  <div key={k} className="bg-neutral-50 px-4 py-3 flex flex-col justify-center">
                    <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{k}</dt>
                    <dd className={`${mono ? 'mono ' : ''}text-sm font-semibold mt-0.5 ${k === 'Status' ? 'text-amber-700' : 'text-slate-900'}`}>{v}</dd>
                  </div>
                ))}
              </dl>

              {/* From the CHC portal: who the patient saw, and what was
                  prescribed at the OPD. Uses the exact cell styling of the facts
                  above, so it reads as the same record continuing rather than a
                  panel bolted on.

                  The notes scroll INSIDE this block and never grow the card —
                  that is what keeps it level with Clinical Notes beside it. It is
                  bounded two different ways because the layout differs:
                    lg and up  the grid row fixes the card height; this block
                               fills what the facts leave and scrolls within it
                    below lg   cards size to their content, so without `max-h` a
                               long prescription would stretch the card and
                               never scroll at all */}
              <dl className="mt-3 flex-1 min-h-[11rem] max-h-[16rem] lg:max-h-none flex flex-col gap-px bg-gray-100 rounded-xl overflow-hidden border border-gray-100">
                <div className="bg-neutral-50 px-4 py-2.5 flex items-baseline gap-3 shrink-0">
                  <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide shrink-0">Consultant Name</dt>
                  <dd
                    title={currentCase.consultant || undefined}
                    className={`min-w-0 truncate text-sm ${currentCase.consultant ? 'font-semibold text-slate-900' : 'font-medium text-slate-400'}`}
                  >
                    {currentCase.consultant || 'Not recorded'}
                  </dd>
                </div>
                <div className="bg-neutral-50 px-4 pt-2.5 pb-3 flex-1 min-h-0 flex flex-col">
                  <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide shrink-0">OPD Prescription &amp; Notes</dt>
                  {/* pre-wrap keeps the line breaks the attendant typed —
                      prescriptions are usually one drug per line.
                      overscroll-contain stops reaching the end of the notes
                      from scrolling the whole page along with it. */}
                  <dd className={`mt-1.5 flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 text-sm leading-relaxed whitespace-pre-wrap break-words [scrollbar-width:thin] ${currentCase.notes ? 'text-slate-700' : 'text-slate-400'}`}>
                    {currentCase.notes || 'No prescription or notes were entered at the CHC.'}
                  </dd>
                </div>
              </dl>
            </SectionCard>

            {/* 2. Clinical Notes — editable, with its own Save button */}
            <SectionCard icon={FileText} title="2. Clinical Notes">
              <textarea
                className={taClass}
                placeholder="Enter clinical notes…"
                value={clinicalDraft[String(id)] ?? clinicalSaved[String(id)] ?? defaultClinical}
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
                placeholder={can.findings ? 'Enter microscopic findings…' : 'Written by the pathologist'}
                readOnly={!can.findings}
                value={pathologistDraft[String(id)] ?? pathologistSaved[String(id)] ?? ''}
                onChange={(e) => setPathologistDraft(prev => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex flex-wrap gap-2 mt-4">
                <button onClick={savePathologist} disabled={!can.findings} className={btnPrimary}>
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
                placeholder={can.prescription ? 'Physician recommendations…' : 'Written by the physician'}
                readOnly={!can.prescription}
                value={medicineDraft[String(id)] ?? medicineSaved[String(id)] ?? ''}
                onChange={(e) => setMedicineDraft(prev => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex flex-wrap gap-2 mt-4">
                <button onClick={saveMedicine} disabled={!can.prescription} className={btnPrimary}>
                  {savedFlash === 'medicine'
                    ? <><Check className="w-3.5 h-3.5" /> Saved</>
                    : <><Save className="w-3.5 h-3.5" /> Save Notes</>}
                </button>
              </div>
              {currentCase.reportedAt ? (
                <div className="w-full mt-5 py-3 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-xl font-bold text-sm tracking-wide inline-flex items-center justify-center gap-2">
                  <ShieldCheck className="w-4 h-4" /> Signed by {currentCase.reportedBy ?? 'physician'}
                </div>
              ) : (
                <button
                  onClick={handleSignReport}
                  disabled={!can.sign || signMutation.isPending}
                  title={can.sign ? undefined : 'Only a physician can sign a report'}
                  className="w-full mt-5 py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm tracking-wide hover:bg-emerald-700 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-emerald-600 shadow-md shadow-emerald-600/25 transition-all inline-flex items-center justify-center gap-2"
                >
                  <ShieldCheck className="w-4 h-4" /> {signMutation.isPending ? 'Submitting…' : 'Sign & Submit Report'}
                </button>
              )}
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
                          {/* Spreading `m` directly would widen the discriminated
                              union and lose the 'image' variant, so the toggle
                              narrows on `type` before rebuilding it. */}
                          <button
                            onClick={() => setModal((m) => (m?.type === 'image' ? { ...m, showAnnotations: true } : m))}
                            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                              modal.showAnnotations !== false ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                            }`}
                          >
                            Annotated
                          </button>
                          <button
                            onClick={() => setModal((m) => (m?.type === 'image' ? { ...m, showAnnotations: false } : m))}
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
            onClick={() => navigate('/queue')}
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
          {can.annotate && (
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
          )}
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
          onClick={() => navigate(`/case/${id}/report`)}
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
