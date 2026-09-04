/**
 * types.ts — the shapes only THIS app uses.
 * ---------------------------------------------------------------------------
 * `Role` and `User` are not here any more: they were declared separately in
 * both front-ends and had already drifted apart — this file's `Role` was
 * missing 'physician' long after the server and the console had gained it, so
 * the same string meant different things depending on the bundle. They now
 * come from @telepathology/shared, which has one definition matching the
 * server's.
 *
 * Everything below is genuinely local: the intake form, its upload state, and
 * the toast. Pulling those into the shared package would couple the two apps
 * together for no benefit.
 */
export type { Role, User } from '@telepathology/shared';

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
