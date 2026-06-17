/**
 * Thin client for the shared backend (apps/server).
 *
 * The base URL comes from VITE_API_URL (set it to your hosted/tunnelled server
 * for true cross-machine sharing); it defaults to localhost for single-machine
 * use. These functions mirror localStorage's get/set so the dashboard can use
 * the server as the source of truth while keeping the browser cache as a fallback.
 */
const RAW = import.meta.env.VITE_API_URL || 'http://localhost:3001';
export const API_BASE = RAW.replace(/\/+$/, ''); // strip any trailing slash

// Read a stored value by key. Throws if the server is unreachable, so callers
// can fall back to the local cache.
export async function apiGet(key) {
  const res = await fetch(`${API_BASE}/api/store/${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
  return res.json();
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
