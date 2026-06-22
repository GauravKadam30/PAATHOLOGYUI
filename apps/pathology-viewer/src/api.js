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

// Read a stored value by key. Throws if the server is unreachable, so callers
// can fall back to the local cache.
export async function apiGet(key) {
  const res = await fetch(`${API_BASE}/api/store/${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
  return res.json();
}

// Read the list of patients submitted from the CHC intake app (metadata only —
// no image — so the queue loads fast). Throws if the server is unreachable.
export async function getCases() {
  const res = await fetch(`${API_BASE}/api/cases`);
  if (!res.ok) throw new Error(`GET cases failed: ${res.status}`);
  return res.json();
}

// Fetch one submitted case's slide image (data-URL), loaded lazily when the
// patient's slide is opened.
export async function getCaseImage(id) {
  const res = await fetch(`${API_BASE}/api/cases/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET case ${id} failed: ${res.status}`);
  const full = await res.json();
  return full.image || null;
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
