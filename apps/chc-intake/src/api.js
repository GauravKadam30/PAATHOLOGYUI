/**
 * Client for the shared backend (apps/server). The CHC intake app uses it to
 * submit a new patient case, which then appears in the Pathology Viewer's queue.
 * Both apps must point at the same backend (default: http://localhost:3001).
 */
const RAW = import.meta.env.VITE_API_URL || 'http://localhost:3001';
export const API_BASE = RAW.replace(/\/+$/, '');

// Submit a new intake case. `payload` mirrors the viewer's case format, with
// `image` as a data-URL of the uploaded slide. Returns the saved case (with id).
export async function addCase(payload) {
  const res = await fetch(`${API_BASE}/api/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
  return res.json();
}
