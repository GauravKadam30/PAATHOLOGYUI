/*
 * api.ts — the bridge between the pathology console and the backend.
 *
 * Accounts, tokens and the password reset live in @telepathology/shared: the
 * CHC intake app needs identical calls, and the two hand-written copies had
 * already drifted. What stays HERE is what only this app does — the worklist,
 * notes, annotations, sign-off and slide metadata.
 *
 * WHICH ROLE this app signs in as is decided by the URL and a toggle on the
 * sign-in screen, because one console serves both pathologists and physicians.
 * See `portalRole` below.
 */
import { createApiClient } from '@telepathology/shared';
import type { User, Credentials } from '@telepathology/shared';
import type { Case, NoteKind, NotesByCase, AnnotationsByCase, AnnotationData, SlideInfo } from './types';

/** The two roles this console serves. The CHC intake app is a separate origin. */
export type ConsoleRole = 'pathologist' | 'physician';

/** URL prefix that pre-selects the physician role on the sign-in screen. */
export const PHYSICIAN_PATH = '/physician';

/**
 * Which role this browser tab signs in as, decided by the URL.
 *
 * One React app serves two of the three roles, because a physician and a
 * pathologist look at the SAME case screens — the difference is only which
 * parts they may edit. Rather than build a second app duplicating the viewer,
 * the worklist and the report layout, the portal is chosen by the address:
 *
 *   /physician…   -> physician
 *   anything else -> pathologist
 *
 * This only seeds SIGNUP and LOGIN. Once signed in the role is whatever the
 * server says it is, so a physician who navigates to /queue is still one.
 */
export function portalRole(): ConsoleRole {
  if (typeof window === 'undefined') return 'pathologist';
  return window.location.pathname.startsWith(PHYSICIAN_PATH) ? 'physician' : 'pathologist';
}

/**
 * This app's own client.
 *
 * `pv_token` is deliberately NOT the key the intake app uses. Separate origins
 * already mean separate localStorage; distinct keys keep the two sessions
 * isolated even if that ever stopped being true.
 */
const client = createApiClient({ tokenKey: 'pv_token' });

export const API_BASE = client.API_BASE;
export const {
  getToken, setToken, authHeaders, getMe, logout, updateProfile,
} = client;

// The console passes an explicit role, since the toggle decides it per sign-in.
export const signup = (payload: Credentials, role: ConsoleRole): Promise<User> => client.signup(payload, role);
export const login = (payload: Credentials, role: ConsoleRole): Promise<User> => client.login(payload, role);
export const requestReset = (email: string, role: ConsoleRole) => client.requestReset(email, role);
export const resetPassword = (
  payload: { email: string; code: string; newPassword: string }, role: ConsoleRole,
) => client.resetPassword(payload, role);

/** Authenticated JSON request — used by the case/slide calls below. */
const authRequest = client.request;

/**
 * Read a value from the legacy key/value store.
 *
 * Only one caller remains: the read-only fallback that still displays
 * annotations saved under the old flattened-image scheme, before they became
 * vector shapes. Nothing writes to that store any more — which is why there is
 * no matching `apiPut` here.
 */
export async function apiGet<T = unknown>(key: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api/store/${encodeURIComponent(key)}`, { headers: authHeaders() });
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
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET cases failed: ${res.status}`);
  return res.json() as Promise<Case[]>;
}

// --- Notes & annotations ------------------------------------------------------
// Reads are bulk (one request for everything); writes are per-case, which is
// the point: the old scheme wrote every patient's notes back as a single blob,
// so two people saving at once silently lost one of the two saves.

export async function getAllNotes(): Promise<NotesByCase> {
  const res = await fetch(`${API_BASE}/api/notes`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET notes failed: ${res.status}`);
  return res.json() as Promise<NotesByCase>;
}

export async function getAllAnnotations(): Promise<AnnotationsByCase> {
  const res = await fetch(`${API_BASE}/api/annotations`, { headers: authHeaders() });
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
 * Permanently delete a case: the record, its notes and annotations, and the
 * slide file on disk.
 *
 * Unlike `setCaseArchived` this cannot be undone. The server refuses it for a
 * case that has been signed off, and for physician accounts.
 */
export async function deleteCase(
  caseId: number | string,
): Promise<{ ok: true; freedBytes: number; notes: number; annotations: number }> {
  return authRequest(`/api/cases/${encodeURIComponent(caseId)}`, { method: 'DELETE' });
}

/** Sign off a report. Physician accounts only — the server enforces it. */
export async function signCaseReport(caseId: number | string): Promise<Case> {
  return authRequest(`/api/cases/${encodeURIComponent(caseId)}/sign`, { method: 'POST' });
}

/**
 * Fetch one submitted case's slide image (data-URL), loaded lazily when the
 * patient's slide is opened. Null when the case has no inline image.
 */
export async function getCaseImage(id: number | string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/cases/${encodeURIComponent(id)}`, { headers: authHeaders() });
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
    const res = await fetch(`${API_BASE}/slides/${encodeURIComponent(caseId)}/info.json`, { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as SlideInfo;
  } catch {
    return null;
  }
}
