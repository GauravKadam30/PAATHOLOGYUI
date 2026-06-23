/*
 * api.js — the bridge to the "backend" (the small server in apps/server).
 *
 * The backend is a shared storage that both apps talk to. When this intake app
 * submits a new patient, it sends the details here; the Pathology Viewer then
 * reads them from the same place. That is how a patient added here shows up there.
 */

// The web address of the backend.
// - If a special setting (VITE_API_URL) is provided, we use that (handy when the
//   backend is on a different computer).
// - Otherwise we use this same computer ("localhost") on port 3001, which is
//   where the backend runs by default.
const RAW = import.meta.env.VITE_API_URL || 'http://localhost:3001';
export const API_BASE = RAW.replace(/\/+$/, ''); // remove any trailing "/" so the address is tidy

// Send a new patient case to the backend so it gets saved and shared.
// `payload` is an object holding the patient's details and the slide image.
// `async`/`await` just means "do this, and wait for the server to answer".
export async function addCase(payload) {
  const res = await fetch(`${API_BASE}/api/cases`, {   // contact the server
    method: 'POST',                                    // "POST" = "here is something new to save"
    headers: { 'Content-Type': 'application/json' },   // tell the server the data is in JSON format
    body: JSON.stringify(payload),                     // turn our object into text the server can read
  });
  if (!res.ok) throw new Error(`Submit failed: ${res.status}`); // server refused → raise an error
  return res.json();                                   // hand back the saved case (now with an id)
}
