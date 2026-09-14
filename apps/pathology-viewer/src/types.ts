/**
 * types.ts — the shape of everything this app exchanges with the backend.
 * ---------------------------------------------------------------------------
 * These types are the whole reason for adopting TypeScript here. The backend
 * returns snake_case columns remapped to camelCase (see db.js `remapCase`), and
 * before this file existed nothing checked that the frontend agreed. A typo
 * like `c.chcid` instead of `c.chcId` silently produced `undefined` — which in
 * this app means a patient row rendering with no identifier at all, discovered
 * only by whoever was reading the worklist.
 *
 * Declared once here and imported everywhere, so the compiler catches that
 * class of mistake before the code ever runs.
 */

// `Role` and `User` come from @telepathology/shared, so this app and the CHC
// intake app cannot disagree about what they mean. They once each declared
// their own and had already drifted — intake's was missing 'physician'.
export type { Role, User } from '@telepathology/shared';

/**
 * What each role may edit on the report screen. The server enforces the same
 * rules; this exists so the UI can disable rather than let someone type into a
 * box whose save will be refused.
 */
export const CAN_EDIT: Record<string, { findings: boolean; prescription: boolean; annotate: boolean; sign: boolean }> = {
  pathologist: { findings: true, prescription: false, annotate: true, sign: false },
  physician: { findings: false, prescription: true, annotate: false, sign: true },
};

/** Review state of a case, shown as the coloured pill in the worklist. */
export type CaseStatus = 'Pending' | 'Reported';

/**
 * Progress of an uploaded whole-slide file.
 *   processing — bytes still arriving, or being validated
 *   ready      — openable in the viewer
 *   failed     — unreadable; `slideError` explains why
 * `null` on ordinary photo cases and the built-in demo patients, which have no
 * scanner slide at all.
 */
export type SlideStatus = 'processing' | 'ready' | 'failed' | null;

/**
 * One patient submission.
 *
 * Two quite different kinds of case share this shape, which is why several
 * fields are optional:
 *   • a scanner whole-slide image  → `dziUrl` is set, `image` is not
 *   • an ordinary photo of a slide → `image` is set, `dziUrl` is not
 *   • the built-in demo patients   → neither `chcId` nor `attendant`
 */
export interface Case {
  id: number;
  patient: string;
  age: string | number;
  gender: string;
  site: string;
  status: CaseStatus;
  /** Collection date, ISO yyyy-mm-dd. */
  date: string;

  /** Who submitted it, and from where. Absent on demo patients. */
  attendant?: string;
  chcName?: string;
  consultant?: string;
  notes?: string;
  /** The health centre's own patient identifier — unique per centre. */
  chcId?: string;
  abha?: string;
  nikshay?: string;

  /** Ordinary photo cases: the image itself, as a data-URL or /public filename. */
  image?: string | null;
  /** True when a photo exists server-side but hasn't been fetched yet. */
  hasImage?: boolean;

  /** Whole-slide cases: path to the Deep Zoom descriptor, e.g. /slides/105/slide.dzi?v=9f2c…
   *  The version is new for every uploaded slide; keep it on derived URLs (slideAssetUrl). */
  dziUrl?: string | null;
  slideStatus?: SlideStatus;
  slideError?: string | null;

  /** Archived cases are hidden from the worklist but not deleted. */
  archived?: boolean;
  /** When the server accepted the submission, ISO 8601 in UTC. Shown in the
   *  worklist's Received column, converted to the reader's local time. */
  createdAt?: string | null;
  updatedAt?: string | null;

  /** Set when a physician signs the report; null while the case is pending. */
  reportedAt?: string | null;
  /** Name of the physician who signed it. */
  reportedBy?: string | null;
  /** Account id of the signer — used to offer "withdraw" to them alone. */
  reportedById?: number | null;
}

/** The three independently-saved note sections on the report page. */
export type NoteKind = 'clinical' | 'pathologist' | 'medicine';

/** All three notes for one case. Any may be absent if never written. */
export type CaseNotes = Partial<Record<NoteKind, string>>;

/** Notes for every case, keyed by case id (as a string, since JSON keys are). */
export type NotesByCase = Record<string, CaseNotes>;

/**
 * Saved annotations for one case: fabric.js canvas JSON.
 *
 * Deliberately loose — this is fabric's own serialisation format and we never
 * hand-construct or destructure the objects, only hand them back to fabric.
 * Pinning an exact shape here would be a fiction that breaks on any fabric
 * upgrade; `objects.length` is the only part this app actually reads.
 */
export interface AnnotationData {
  version?: string;
  objects?: unknown[];
  [key: string]: unknown;
}

/** Annotations for every case, keyed by case id. */
export type AnnotationsByCase = Record<string, AnnotationData>;

/** Scanner calibration for a slide, from /slides/:id/info.json. */
export interface SlideInfo {
  width: number;
  height: number;
  levelCount: number;
  /**
   * Microns per pixel. `null` when the file carries no calibration — in which
   * case the viewer must show NO scale bar rather than an invented one.
   */
  mppX: number | null;
  mppY: number | null;
  vendor: string | null;
}

/** What the modal on the report page is currently displaying. */
export type Modal =
  | { type: 'image'; title: string; src: string | null; rawSrc?: string | null; showAnnotations?: boolean; loading?: boolean }
  | { type: 'text'; title: string; text: string }
  | { type: 'message'; title: string; text: string };
