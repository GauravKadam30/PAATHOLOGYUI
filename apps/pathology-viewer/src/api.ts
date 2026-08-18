/**
 * Thin typed client for the shared backend (apps/server).
 *
 * Every function here declares what the backend actually returns, so a
 * mismatch between this app and the API is a compile error rather than an
 * `undefined` discovered at runtime. See types.ts for the domain shapes.
 */
import type {
  User, Case, NotesByCase, AnnotationsByCase, AnnotationData, NoteKind, SlideInfo,
} from './types';

// Work out where the backend lives. Priority:
//   1. VITE_API_URL if you set it (a LAN IP, hosted URL, etc.).
//   2. Auto-detect on browser sandboxes like StackBlitz / WebContainers, where
//      the app runs at a "…--5173…" address and the backend is the matching
//      "…--3001…" address — so two PCs can share with zero setup.
//   3. http://localhost:3001 for a normal single-PC run.
function resolveApiBase(): string {
  const explicit = import.meta.env.VITE_API_URL as string | undefined;
  if (explicit) return explicit;

  if (typeof window !== 'undefined') {
    const { protocol, hostname, host } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:3001';
    }
    // StackBlitz / WebContainer addresses encode the port as "--5173";
    // the backend is the same address with "--3001".
    if (host.includes('--5173')) {
      return `${protocol}//${host.replace('--5173', '--3001')}`;
    }
  }
  return 'http://localhost:3001';
}

export const API_BASE: string = resolveApiBase().replace(/\/+$/, ''); // strip any trailing slash

// --- Authentication -----------------------------------------------------------
// The pathologist's sign-in token, kept separately from the CHC intake app's
// own token (different key name, and — since each app runs on its own
// origin/port — a separate localStorage anyway). `role: 'pathologist'` is
// stamped on every signup/login so the shared backend can tell this app's
// accounts apart from CHC lab-attendant accounts on the same server.
const TOKEN_KEY = 'pv_token';
const ROLE = 'pathologist';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null): void => {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
};

/** What every auth endpoint sends back. */
interface AuthResponse {
  token: string;
  user: User;
}

/** Credentials accepted by signup/login. `fullName` only matters for signup. */
export interface Credentials {
  email: string;
  password: string;
  fullName?: string;
}

// One small helper that does every auth request: attaches the token,
// sends/receives JSON, and turns any server error into a readable message.
// Generic over the response shape so callers get a real type, not `any`.
async function authRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

/** Create a pathologist account (name + email + password — no CHC). */
export async function signup(payload: Credentials): Promise<User> {
  const data = await authRequest<AuthResponse>('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ ...payload, role: ROLE }),
  });
  setToken(data.token);
  return data.user;
}

/** Sign in to an existing pathologist account. */
export async function login(payload: Credentials): Promise<User> {
  const data = await authRequest<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ ...payload, role: ROLE }),
  });
  setToken(data.token);
  return data.user;
}

/** "Who am I?" using the saved token — restores the session on reopen. */
export async function getMe(): Promise<User> {
  const data = await authRequest<{ user: User }>('/api/auth/me');
  return data.user;
}

/** Sign out: just forget the token. */
export function logout(): void {
  setToken(null);
}

/**
 * Read a value from the legacy key/value store.
 *
 * Only one caller remains: the read-only fallback that still displays
 * annotations saved under the old flattened-image scheme, before they became
 * vector shapes. Nothing writes to that store any more — which is why there is
 * no matching `apiPut` here.
 */
export async function apiGet<T = unknown>(key: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api/store/${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Read the patient worklist (metadata only — no images — so it loads fast).
 * Passing `since` (the newest updatedAt already held) returns ONLY cases that
 * changed after it, so routine polling transfers almost nothing instead of the
 * whole list every few seconds.
 */
export async function getCases(since?: string | null): Promise<Case[]> {
  const url = since
    ? `${API_BASE}/api/cases?since=${encodeURIComponent(since)}`
    : `${API_BASE}/api/cases`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET cases failed: ${res.status}`);
  return res.json() as Promise<Case[]>;
}

// --- Notes & annotations ------------------------------------------------------
// Reads are bulk (one request for everything); writes are per-case, which is
// the point: the old scheme wrote every patient's notes back as a single blob,
// so two people saving at once silently lost one of the two saves.

export async function getAllNotes(): Promise<NotesByCase> {
  const res = await fetch(`${API_BASE}/api/notes`);
  if (!res.ok) throw new Error(`GET notes failed: ${res.status}`);
  return res.json() as Promise<NotesByCase>;
}

export async function getAllAnnotations(): Promise<AnnotationsByCase> {
  const res = await fetch(`${API_BASE}/api/annotations`);
  if (!res.ok) throw new Error(`GET annotations failed: ${res.status}`);
  return res.json() as Promise<AnnotationsByCase>;
}

/** Save ONE note on ONE case. Requires sign-in (the server records who saved it). */
export async function saveNote(caseId: number | string, kind: NoteKind, body: string): Promise<{ ok: true }> {
  return authRequest(`/api/cases/${encodeURIComponent(caseId)}/notes/${encodeURIComponent(kind)}`, {
    method: 'PUT',
    body: JSON.stringify({ body }),
  });
}

/** Save the vector annotations for ONE case. */
export async function saveAnnotations(caseId: number | string, data: AnnotationData | null): Promise<{ ok: true }> {
  return authRequest(`/api/cases/${encodeURIComponent(caseId)}/annotations`, {
    method: 'PUT',
    body: JSON.stringify(data ?? {}),
  });
}

/** Hide a case from the worklist without destroying it (soft delete). */
export async function setCaseArchived(caseId: number | string, archived = true): Promise<{ ok: true }> {
  return authRequest(`/api/cases/${encodeURIComponent(caseId)}/archived`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  });
}

/**
 * Fetch one submitted case's slide image (data-URL), loaded lazily when the
 * patient's slide is opened. Null when the case has no inline image.
 */
export async function getCaseImage(id: number | string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/cases/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET case ${id} failed: ${res.status}`);
  const full = (await res.json()) as Case;
  return full.image || null;
}

/**
 * Slide metadata for a whole-slide case: pixel dimensions plus the scanner's
 * microns-per-pixel calibration. `mppX` is null when the file carries no
 * calibration, in which case the viewer must NOT show a scale bar or a
 * magnification figure — an invented scale on a diagnostic image is worse
 * than no scale at all. Returns null if the slide or service is unavailable.
 */
export async function fetchSlideInfo(caseId: number | string): Promise<SlideInfo | null> {
  try {
    const res = await fetch(`${API_BASE}/slides/${encodeURIComponent(caseId)}/info.json`);
    if (!res.ok) return null;
    return (await res.json()) as SlideInfo;
  } catch {
    return null;
  }
}
