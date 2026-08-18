/**
 * types.ts — the shape of everything this app exchanges with the backend.
 * ---------------------------------------------------------------------------
 * Deliberately a mirror of the pathology console's types.ts. The two apps talk
 * to the SAME backend, so a `User` here must mean exactly what a `User` means
 * there; keeping the definitions aligned is what stops the two drifting apart
 * as the API changes.
 */

/** Which portal an account belongs to. The same email may hold one of each. */
export type Role = 'lab_attendant' | 'pathologist';

/** A signed-in account, as returned by /api/auth/* (never includes the hash). */
export interface User {
  id: number;
  email: string;
  fullName: string;
  /** The lab attendant's health centre. Empty for pathologist accounts. */
  chcName: string;
  role: Role;
}

/**
 * The intake form's fields, all held as strings because they come straight
 * from text inputs. `age` is converted by the backend, not here.
 */
export interface IntakeForm {
  /** The health centre's own patient identifier — must be unique per centre. */
  chcId: string;
  name: string;
  abha: string;
  age: string;
  nikshay: string;
  gender: string;
  consultant: string;
  notes: string;
}

/** What a submitted case looks like coming back from the server. */
export interface CreatedCase {
  id: number;
  patient: string;
}

/** The success/error banner shown above the form. */
export interface Toast {
  type: 'success' | 'error';
  text: string;
}

/** A chosen file's name and size, for the upload card's summary line. */
export interface FileInfo {
  name: string;
  size: number;
}
