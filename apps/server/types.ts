/**
 * types.ts — the backend's domain types, and the contract the data layer
 * must satisfy.
 * ---------------------------------------------------------------------------
 * THE POINT OF THIS FILE is `DataDriver` at the bottom. It is the single
 * written definition of everything the server may ask of the database, and
 * postgres.ts asserts itself against it. That turns "this query exists and
 * returns the shape callers expect" from something you hope is true into
 * something the compiler checks.
 *
 * This contract earned its place. The data layer was once implemented twice,
 * for SQLite and for PostgreSQL, and the interface is what caught the two
 * implementations quietly diverging: an endpoint that returned the updated
 * case on one and an empty body on the other, and backup pruning that ran on
 * one but not the other. Both were invisible at runtime until you happened to
 * be on the other database.
 *
 * It also documents why every function is async — see the note on the
 * interface itself.
 *
 * NAMING NOTE: user rows come back in snake_case and case rows in camelCase.
 * That is inherited from the original hand-written SQL — auth.ts reads
 * `password_hash`, while the front-ends read `chcName`. It is inconsistent,
 * but it is the EXISTING contract that the browsers already depend on.
 */

// --- Users --------------------------------------------------------------------

/**
 * Which portal an account belongs to. One email may hold one of each.
 *
 * The three map onto the three people in a consultation:
 *   lab_attendant — CHC staff who register the patient and upload the slide
 *   pathologist   — examines the slide, annotates it, writes the findings
 *   physician     — reads the findings and prescribes, then signs the report
 *
 * Keeping physician separate from pathologist is not bookkeeping. One account
 * writing BOTH the microscopic findings and the prescription removes the
 * second opinion that the workflow exists to provide, and makes an audit
 * unable to say who did which half.
 */
export type Role = 'lab_attendant' | 'pathologist' | 'physician';

/**
 * A user row exactly as the drivers return it — snake_case, including the
 * password hash. Never send this to a browser; use `publicUser()` in auth.ts.
 */
export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  full_name: string;
  /** Empty string for pathologists — they aren't tied to a health centre. */
  chc_name: string;
  role: Role | string;
  created_at: string;
  /** Raised to invalidate every token issued before now. */
  token_version: number;
}

/**
 * Which note kind each role may WRITE.
 *
 * Enforced on the server, not just hidden in the UI — a disabled textarea is a
 * courtesy, but anyone can send the request directly with curl.
 */
export const NOTE_WRITERS: Record<string, Role[]> = {
  clinical: ['pathologist', 'physician'],
  pathologist: ['pathologist'],
  medicine: ['physician'],
};

/** The safe subset sent to the browser. */
export interface PublicUser {
  id: number;
  email: string;
  fullName: string;
  chcName: string;
  role: string;
}

export interface NewUser {
  email: string;
  passwordHash: string;
  fullName: string;
  chcName: string;
  role?: string;
}

// --- Cases --------------------------------------------------------------------

/** Progress of an uploaded whole-slide file. Null for ordinary photo cases. */
export type SlideStatus = 'processing' | 'ready' | 'failed' | null;

/** A case WITHOUT its inline image — what the worklist endpoint returns. */
export interface CaseMeta {
  id: number;
  patient: string;
  age: string | null;
  gender: string | null;
  site: string | null;
  status: string | null;
  date: string | null;
  attendant: string | null;
  chcName: string | null;
  consultant: string | null;
  notes: string | null;
  chcId: string | null;
  /** Web path to the Deep Zoom descriptor, e.g. /slides/105/slide.dzi */
  dziUrl: string | null;
  slideStatus: SlideStatus;
  slideError: string | null;
  archived: boolean;
  updatedAt: string | null;
  hasImage: boolean;
  /** When a physician signed the report. Null while the case is pending. */
  reportedAt: string | null;
  /** Display name of the physician who signed it. */
  reportedBy: string | null;
}

/** A case WITH its inline image — fetched only when a slide is opened. */
export interface CaseFull extends CaseMeta {
  image: string | null;
  abha?: string | null;
  nikshay?: string | null;
}

/** The payload accepted when submitting a new case. */
export interface NewCaseInput {
  patient: string;
  age?: string | number;
  gender?: string;
  site?: string;
  status?: string;
  date?: string;
  image?: string | null;
  consultant?: string;
  notes?: string;
  abha?: string;
  nikshay?: string;
  chcId?: string;
}

export interface ListCasesOptions {
  /** Return only cases changed after this ISO timestamp. */
  since?: string | null;
  includeArchived?: boolean;
}

// --- Notes & annotations -------------------------------------------------------

export type NoteKind = 'clinical' | 'pathologist' | 'medicine';

/** All notes, as { caseId: { clinical, pathologist, medicine } }. */
export type NotesByCase = Record<string, Partial<Record<NoteKind, string>>>;

/** Saved fabric.js canvas JSON. Deliberately loose — fabric owns this shape. */
export type AnnotationData = Record<string, unknown>;

export type AnnotationsByCase = Record<string, AnnotationData>;

// --- Password reset ------------------------------------------------------------

export interface ResetCodeRow {
  user_id: number;
  code_hash: string;
  /** Milliseconds since epoch. */
  expires_at: number;
  attempts: number;
}

// --- Audit trail ---------------------------------------------------------------

/** One thing that happened, as recorded for the audit trail. */
export interface AuditEntry {
  userId?: number | null;
  userName?: string | null;
  userRole?: string | null;
  /** Dotted verb: 'login', 'case.view', 'note.save', 'report.sign', … */
  action: string;
  caseId?: number | null;
  /** Anything worth knowing beyond the action itself, e.g. the note kind. */
  detail?: string | null;
  ip?: string | null;
}

// --- Backups -------------------------------------------------------------------

export interface BackupResult {
  file: string;
  bytes: number;
  /** How many older backups were retained after pruning. */
  kept: number;
}

// --- The driver contract --------------------------------------------------------

/**
 * Every function the rest of the server may call on the data layer.
 *
 * All of them return promises, because the `pg` client is asynchronous. That
 * matters more than it looks: a missed `await` leaves you holding a pending
 * Promise, which is truthy, so a guard like `if (!user)` passes for a user who
 * does not exist. That is exactly what happened in `authRequired` once, where
 * a deleted account would have been treated as signed in. Declaring the whole
 * contract async is what lets the compiler catch it.
 */
export interface DataDriver {
  // Users
  getUserByEmail(email: string): Promise<UserRow | undefined>;
  getUserByEmailAndRole(email: string, role: string): Promise<UserRow | undefined>;
  getUserById(id: number | string): Promise<UserRow | undefined>;
  createUser(user: NewUser): Promise<UserRow>;
  updateProfile(id: number, patch: { fullName: string; chcName: string }): Promise<UserRow | undefined>;
  updatePassword(id: number, passwordHash: string): Promise<void>;
  bumpTokenVersion(id: number): Promise<void>;

  // Cases
  listCases(options?: ListCasesOptions): Promise<CaseMeta[]>;
  getCase(id: number | string): Promise<CaseFull | null>;
  getCaseMeta(id: number | string): Promise<CaseMeta | null>;
  findCaseByChcId(chcId: string, chcName: string): Promise<CaseMeta | null>;
  createCase(data: NewCaseInput, user: UserRow): Promise<number>;
  /**
   * Mark a case reported and record who signed it. This is what moves a case
   * out of the pending worklist, so it is the end of the clinical workflow.
   */
  signCaseReport(id: number | string, userId: number): Promise<CaseMeta | null>;
  touchCase(id: number | string): Promise<void>;
  /**
   * Returns the updated case, because the archive endpoint echoes it straight
   * back to the browser. Declaring that here is not decoration: an earlier
   * implementation wrote the row and returned nothing, so the endpoint replied
   * with an empty body. The return type is what makes that a compile error.
   */
  setCaseArchived(id: number | string, archived?: boolean): Promise<CaseMeta | null>;
  /** Permanently remove a case; cascades to its notes and annotations. */
  deleteCase(id: number | string): Promise<{ notes: number; annotations: number } | null>;

  // Slide lifecycle
  setSlidePending(id: number | string, slidePath: string | null): Promise<void>;
  setSlideReady(id: number | string, dziPath: string): Promise<void>;
  setSlideFailed(id: number | string, message: string): Promise<void>;
  /** Undo a slide: clears path, status and error, leaving the case itself. */
  clearSlide(id: number | string): Promise<void>;
  failStaleProcessingSlides(): Promise<void>;

  // Notes & annotations
  readonly NOTE_KINDS: readonly string[];
  setNote(caseId: number | string, kind: string, body: string, userId?: number | null): Promise<void>;
  getAllNotes(): Promise<NotesByCase>;
  setAnnotations(caseId: number | string, data: AnnotationData, userId?: number | null): Promise<void>;
  getAllAnnotations(): Promise<AnnotationsByCase>;

  // Password reset codes
  storeResetCode(userId: number, codeHash: string, expiresAt: number): Promise<void>;
  getResetCode(userId: number): Promise<ResetCodeRow | undefined>;
  bumpResetAttempts(userId: number): Promise<void>;
  clearResetCode(userId: number): Promise<void>;

  // Legacy key/value store (read-only in practice)
  getKV(key: string): Promise<unknown>;
  setKV(key: string, value: unknown): Promise<void>;

  // Audit trail
  /**
   * Record one action. Deliberately returns void and never throws — see the
   * implementation for why an audit write must not be able to fail a request.
   */
  writeAudit(entry: AuditEntry): Promise<void>;
  /** Recent entries, newest first. For a case history view. */
  readAudit(options?: { caseId?: number; limit?: number }): Promise<unknown[]>;

  // Maintenance
  backupDatabase(dir: string, keep?: number): Promise<BackupResult>;
}

// --- Express augmentation --------------------------------------------------

/**
 * `authRequired` attaches the signed-in account to the request, and every
 * protected handler reads it back off. Declaring it here is what makes
 * `req.user.id` a typed `number` instead of an error — and it deliberately
 * stays OPTIONAL, because on an unauthenticated route there genuinely is no
 * user. Handlers behind `authRequired` assert it with `req.user!`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}
