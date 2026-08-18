/*
 * api.ts — the bridge between the CHC intake app and the backend.
 *
 * Covers three things:
 *   • Accounts — sign-up, login, profile edits, the two-step password reset.
 *     Logging in returns a token (a signed pass) which is kept in the browser
 *     and sent with every later request so the server knows who is calling.
 *   • Cases — submitting a patient.
 *   • Slides — uploading a scanner file, which needs a completely different
 *     mechanism from everything else here (see `uploadSlide`).
 *
 * Every auth request carries role 'lab_attendant'. That is what separates
 * these accounts from the pathology console's, and is why the same email can
 * hold one account in each app.
 */
import type { User, IntakeForm, CreatedCase } from './types';

// Where the backend lives. VITE_API_URL lets you point at another computer;
// otherwise it's this same computer on port 3001.
const RAW = import.meta.env.VITE_API_URL || 'http://localhost:3001';
export const API_BASE: string = RAW.replace(/\/+$/, '');

// The login token is kept in the browser's localStorage so you stay signed in
// even after a page refresh.
const TOKEN_KEY = 'chc_token';
export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null): void => {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
};

// One small helper that does every request: attaches the token, sends/receives
// JSON, and turns any server error into a readable message. Generic over the
// response shape so callers get a real type instead of `any`.
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));       // some errors have no body
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

// --- Authentication ---
// `role: 'lab_attendant'` is stamped on every request from this app (fixed,
// not user-chosen) so the shared backend can tell a CHC account apart from a
// Pathology Console account — same server, same users table, two account
// types that can't sign into each other's portal.
const ROLE = 'lab_attendant';

/** What every auth endpoint sends back. */
interface AuthResponse {
  token: string;
  user: User;
}

/** Fields accepted by signup. */
export interface SignupPayload {
  fullName: string;
  chcName: string;
  email: string;
  password: string;
}

/** Create an account (user name + CHC name + email + password). */
export async function signup(payload: SignupPayload): Promise<User> {
  const data = await request<AuthResponse>('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ ...payload, role: ROLE }),
  });
  setToken(data.token);
  return data.user;
}

/** Sign in to an existing account. */
export async function login(payload: { email: string; password: string }): Promise<User> {
  const data = await request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ ...payload, role: ROLE }),
  });
  setToken(data.token);
  return data.user;
}

/** "Who am I?" using the saved token — restores the session on reopen. */
export async function getMe(): Promise<User> {
  const data = await request<{ user: User }>('/api/auth/me');
  return data.user;
}

/** Sign out: just forget the token. */
export function logout(): void {
  setToken(null);
}

/** Edit profile: update the signed-in attendant's name + CHC. */
export async function updateProfile(payload: { fullName: string; chcName: string }): Promise<User> {
  const data = await request<{ user: User }>('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return data.user;
}

/**
 * Forgot password, step 1: ask the server to issue a one-time code.
 *
 * The code is NOT returned here. It is emailed to the account, or — if the
 * backend has no mail server configured — printed on the server console for
 * the operator to hand over. Either way it's a real second factor, unlike the
 * previous flow which accepted email + name + CHC, all of which a colleague
 * already knows. The returned `message` describes whichever route was used,
 * so the UI can show something accurate without guessing.
 */
export async function requestReset(email: string): Promise<{ ok: true; message: string }> {
  return request('/api/auth/request-reset', {
    method: 'POST',
    body: JSON.stringify({ email, role: ROLE }),
  });
}

/** Forgot password, step 2: exchange the code for a new password. */
export async function resetPassword(
  payload: { email: string; code: string; newPassword: string },
): Promise<{ ok: true }> {
  return request('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ ...payload, role: ROLE }),
  });
}

// --- Cases ---

/** Everything sent when submitting a patient. */
export interface NewCasePayload extends Partial<IntakeForm> {
  patient: string;
  age: string;
  gender: string;
  site: string;
  status: string;
  date: string;
  /** A shrunk photo as a data-URL. Null for scanner slides, which upload separately. */
  image: string | null;
}

/**
 * Submit a new patient case. The attendant name and CHC are added by the
 * server from your logged-in account, so they aren't sent here.
 */
export async function addCase(payload: NewCasePayload): Promise<CreatedCase> {
  return request<CreatedCase>('/api/cases', { method: 'POST', body: JSON.stringify(payload) });
}

// File extensions the backend can read as a whole-slide image. Anything else
// (an ordinary phone photo of a slide, say) keeps using the original path:
// shrink it in the browser and send it inline with the case.
const SLIDE_EXTENSIONS = ['.tiff', '.tif', '.svs', '.ndpi', '.scn', '.mrxs', '.vms', '.vmu', '.bif'];
export const isSlideFile = (name = ''): boolean =>
  SLIDE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

/**
 * Upload a scanner slide file to an already-created case.
 *
 * Uses XMLHttpRequest rather than fetch() purely because it reports upload
 * progress — a scanner slide can be over a gigabyte, so the attendant needs a
 * real progress bar instead of a spinner that looks frozen for minutes.
 * `onProgress` is called with a 0-100 percentage.
 */
export function uploadSlide(
  caseId: number | string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('slide', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/cases/${caseId}/slide`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: { error?: string } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — is the backend running?'));
    xhr.send(form);
  });
}
