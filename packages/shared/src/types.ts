/**
 * Domain types both front-ends need.
 * ---------------------------------------------------------------------------
 * ONLY what is genuinely shared lives here. Each app keeps its own types for
 * its own screens — the intake form, the slide viewer's modal — because
 * pulling those in would couple the apps together for no benefit.
 *
 * `Role` is the reason this file exists. It was declared separately in both
 * apps and they had already drifted: the console knew about physicians and the
 * intake app did not, so the same string meant different things depending on
 * which bundle you were in. One definition makes that impossible.
 */

/**
 * Which portal an account belongs to. One email may hold one of each.
 *
 * Must match `Role` in apps/server/types.ts — the server is the authority, and
 * these strings travel in every signup and login request.
 */
export type Role = 'lab_attendant' | 'pathologist' | 'physician';

/** The signed-in account, as the server returns it. Never includes secrets. */
export interface User {
  id: number;
  email: string;
  fullName: string;
  /** Empty for pathologists and physicians — they aren't tied to a centre. */
  chcName: string;
  role: Role;
}

/** Credentials accepted by signup and login. `fullName` only matters on signup. */
export interface Credentials {
  email: string;
  password: string;
  fullName?: string;
  /** CHC name, collected at intake signup only. */
  chcName?: string;
}

/** What the server sends back on a successful signup or login. */
export interface AuthResponse {
  token: string;
  user: User;
}
