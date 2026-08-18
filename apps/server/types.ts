/**
 * types.ts — the backend's domain types, and the contract both database
 * drivers must satisfy.
 * ---------------------------------------------------------------------------
 * THE POINT OF THIS FILE is `DataDriver` at the bottom. There are two
 * implementations of the data layer — SQLite and PostgreSQL — and db.js picks
 * between them at startup. Nothing previously guaranteed the two actually
 * matched: a function missing from one, or returning a subtly different shape,
 * would only surface at runtime, on whichever database happened to be
 * configured. Declaring both `satisfies DataDriver` turns that into a compile
 * error instead.
 *
 * That is not hypothetical. During the PostgreSQL migration `authRequired`
 * called `getUserById` without awaiting it — harmless on synchronous SQLite,
 * but on PostgreSQL it produced a pending Promise that passed a truthiness
 * check meant to confirm the account still existed. Types describing the
 * driver as async would have rejected that at compile time.
 *
 * NAMING NOTE: user rows come back in snake_case and case rows in camelCase.
 * That is inherited from the original SQLite queries — auth.js reads
 * `password_hash`, while the front-ends read `chcName`. It is inconsistent,
 * but it is the EXISTING contract, and both drivers must match it exactly.
 */

// --- Users --------------------------------------------------------------------

/** Which portal an account belongs to. One email may hold one of each. */
export type Role = 'lab_attendant' | 'pathologist';

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
 * All of them return promises. The SQLite driver is actually synchronous, but
 * declaring the contract as async is what lets one set of call sites serve
 * both databases — awaiting a synchronous value is harmless, whereas failing
 * to await a real promise is the bug described at the top of this file.
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
  touchCase(id: number | string): Promise<void>;
  /**
   * Returns the updated case so the archive endpoint can echo it back. Both
   * drivers must return it: the PostgreSQL one originally returned nothing,
   * which meant the same endpoint replied with a case on SQLite and with an
   * empty body on PostgreSQL. That is precisely the divergence this contract
   * exists to prevent.
   */
  setCaseArchived(id: number | string, archived?: boolean): Promise<CaseMeta | null>;

  // Slide lifecycle
  setSlidePending(id: number | string, slidePath: string | null): Promise<void>;
  setSlideReady(id: number | string, dziPath: string): Promise<void>;
  setSlideFailed(id: number | string, message: string): Promise<void>;
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

  // Maintenance
  backupDatabase(dir: string, keep?: number): Promise<BackupResult>;
  migrateLegacyJson(): Promise<void>;
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
