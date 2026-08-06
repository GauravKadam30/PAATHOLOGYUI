/*
 * api.js — the bridge between the CHC intake app and the backend.
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

// Where the backend lives. VITE_API_URL lets you point at another computer;
// otherwise it's this same computer on port 3001.
const RAW = import.meta.env.VITE_API_URL || 'http://localhost:3001';
export const API_BASE = RAW.replace(/\/+$/, '');

// The login token is kept in the browser's localStorage so you stay signed in
// even after a page refresh.
const TOKEN_KEY = 'chc_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

// One small helper that does every request: attaches the token, sends/receives
// JSON, and turns any server error into a readable message.
async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));       // some errors have no body
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- Authentication ---
// `role: 'lab_attendant'` is stamped on every request from this app (fixed,
// not user-chosen) so the shared backend can tell a CHC account apart from a
// Pathology Console account — same server, same users table, two account
// types that can't sign into each other's portal.
const ROLE = 'lab_attendant';

// Create an account (lab attendant name + CHC name + email + password).
export async function signup(payload) {
  const data = await request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ ...payload, role: ROLE }) });
  setToken(data.token);
  return data.user;
}
// Sign in to an existing account.
export async function login(payload) {
  const data = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ ...payload, role: ROLE }) });
  setToken(data.token);
  return data.user;
}
// Ask the server "who am I?" using the saved token — used to restore the
// session when the page is reopened.
export async function getMe() {
  const data = await request('/api/auth/me');
  return data.user;
}
// Sign out: just forget the token.
export function logout() {
  setToken(null);
}
// Edit profile: update the signed-in attendant's name + CHC. Returns the updated user.
export async function updateProfile(payload) {
  const data = await request('/api/auth/profile', { method: 'PATCH', body: JSON.stringify(payload) });
  return data.user;
}
// Forgot password, step 1: ask the server to issue a one-time code. The code
// is NOT returned here — it's printed on the server console, so the person
// resetting has to get it from whoever runs the backend. The old flow accepted
// email + name + CHC as proof of identity, all of which a colleague knows.
export async function requestReset(email) {
  return request('/api/auth/request-reset', {
    method: 'POST',
    body: JSON.stringify({ email, role: ROLE }),
  });
}

// Forgot password, step 2: exchange the code for a new password.
export async function resetPassword({ email, code, newPassword }) {
  return request('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email, code, newPassword, role: ROLE }),
  });
}

// --- Cases ---
// Submit a new patient case. The attendant name and CHC are added by the server
// from your logged-in account, so we don't send them here.
export async function addCase(payload) {
  return request('/api/cases', { method: 'POST', body: JSON.stringify(payload) });
}

// File extensions the backend can read as a whole-slide image. Anything else
// (an ordinary phone photo of a slide, say) keeps using the original path:
// shrink it in the browser and send it inline with the case.
const SLIDE_EXTENSIONS = ['.tiff', '.tif', '.svs', '.ndpi', '.scn', '.mrxs', '.vms', '.vmu', '.bif'];
export const isSlideFile = (name = '') =>
  SLIDE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

// Upload a scanner slide file to an already-created case.
//
// Uses XMLHttpRequest rather than fetch() purely because it reports upload
// progress — a scanner slide can be over a gigabyte, so the attendant needs a
// real progress bar instead of a spinner that looks frozen for minutes.
// `onProgress` is called with a 0-100 percentage.
export function uploadSlide(caseId, file, onProgress) {
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
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — is the backend running?'));
    xhr.send(form);
  });
}
