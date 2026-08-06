/**
 * Thin client for the shared backend (apps/server).
 *
 * These functions mirror localStorage's get/set so the dashboard can use the
 * server as the source of truth while keeping the browser cache as a fallback.
 */

// Work out where the backend lives. Priority:
//   1. VITE_API_URL if you set it (a LAN IP, hosted URL, etc.).
//   2. Auto-detect on browser sandboxes like StackBlitz / WebContainers, where
//      the app runs at a "…--5173…" address and the backend is the matching
//      "…--3001…" address — so two PCs can share with zero setup.
//   3. http://localhost:3001 for a normal single-PC run.
function resolveApiBase() {
  const explicit = import.meta.env.VITE_API_URL;
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

export const API_BASE = resolveApiBase().replace(/\/+$/, ''); // strip any trailing slash

// --- Authentication -----------------------------------------------------------
// The pathologist's sign-in token, kept separately from the CHC intake app's
// own token (different key name, and — since each app runs on its own
// origin/port — a separate localStorage anyway). `role: 'pathologist'` is
// stamped on every signup/login so the shared backend can tell this app's
// accounts apart from CHC lab-attendant accounts on the same server.
const TOKEN_KEY = 'pv_token';
const ROLE = 'pathologist';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

// One small helper that does every auth request: attaches the token,
// sends/receives JSON, and turns any server error into a readable message.
async function authRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Create a pathologist account (name + email + password — no CHC).
export async function signup(payload) {
  const data = await authRequest('/api/auth/signup', { method: 'POST', body: JSON.stringify({ ...payload, role: ROLE }) });
  setToken(data.token);
  return data.user;
}
// Sign in to an existing pathologist account.
export async function login(payload) {
  const data = await authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ ...payload, role: ROLE }) });
  setToken(data.token);
  return data.user;
}
// Ask the server "who am I?" using the saved token — restores the session
// when the console is reopened.
export async function getMe() {
  const data = await authRequest('/api/auth/me');
  return data.user;
}
// Sign out: just forget the token.
export function logout() {
  setToken(null);
}

// Read a stored value by key. Throws if the server is unreachable, so callers
// can fall back to the local cache.
export async function apiGet(key) {
  const res = await fetch(`${API_BASE}/api/store/${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
  return res.json();
}

// Read the list of patients submitted from the CHC intake app (metadata only —
// no image — so the queue loads fast). Throws if the server is unreachable.
// Passing `since` (the newest updatedAt already held) returns ONLY cases that
// changed after it, so routine polling transfers almost nothing instead of the
// whole list every few seconds.
export async function getCases(since) {
  const url = since
    ? `${API_BASE}/api/cases?since=${encodeURIComponent(since)}`
    : `${API_BASE}/api/cases`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET cases failed: ${res.status}`);
  return res.json();
}

// --- Notes & annotations ------------------------------------------------------
// Reads are bulk (one request for everything); writes are per-case, which is
// the point: the old scheme wrote every patient's notes back as a single blob,
// so two people saving at once silently lost one of the two saves.
export async function getAllNotes() {
  const res = await fetch(`${API_BASE}/api/notes`);
  if (!res.ok) throw new Error(`GET notes failed: ${res.status}`);
  return res.json();
}
export async function getAllAnnotations() {
  const res = await fetch(`${API_BASE}/api/annotations`);
  if (!res.ok) throw new Error(`GET annotations failed: ${res.status}`);
  return res.json();
}

// Save ONE note on ONE case. Requires sign-in (the server records who saved it).
export async function saveNote(caseId, kind, body) {
  return authRequest(`/api/cases/${encodeURIComponent(caseId)}/notes/${encodeURIComponent(kind)}`, {
    method: 'PUT',
    body: JSON.stringify({ body }),
  });
}

// Save the vector annotations for ONE case.
export async function saveAnnotations(caseId, data) {
  return authRequest(`/api/cases/${encodeURIComponent(caseId)}/annotations`, {
    method: 'PUT',
    body: JSON.stringify(data ?? {}),
  });
}

// Hide a case from the worklist without destroying it (soft delete).
export async function setCaseArchived(caseId, archived = true) {
  return authRequest(`/api/cases/${encodeURIComponent(caseId)}/archived`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  });
}

// Fetch one submitted case's slide image (data-URL), loaded lazily when the
// patient's slide is opened.
export async function getCaseImage(id) {
  const res = await fetch(`${API_BASE}/api/cases/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET case ${id} failed: ${res.status}`);
  const full = await res.json();
  return full.image || null;
}

// Slide metadata for a whole-slide case: pixel dimensions plus the scanner's
// microns-per-pixel calibration. `mppX` is null when the file carries no
// calibration, in which case the viewer must NOT show a scale bar or a
// magnification figure — an invented scale on a diagnostic image is worse
// than no scale at all. Returns null if the slide or service is unavailable.
export async function fetchSlideInfo(caseId) {
  try {
    const res = await fetch(`${API_BASE}/slides/${encodeURIComponent(caseId)}/info.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Save a value by key. Fire-and-forget: never throws — if the backend is down
// the change still lives in the local cache, so the app keeps working offline.
export async function apiPut(key, value) {
  try {
    await fetch(`${API_BASE}/api/store/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return true;
  } catch (e) {
    console.warn('Backend save failed (kept locally only):', e.message);
    return false;
  }
}
