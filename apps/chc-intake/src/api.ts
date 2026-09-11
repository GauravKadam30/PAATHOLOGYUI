/*
 * api.ts — the bridge between the CHC intake app and the backend.
 *
 * Accounts, tokens and the password reset live in @telepathology/shared,
 * because the pathology console needs exactly the same calls and the two
 * copies had already drifted apart. What stays HERE is what only this app
 * does: submitting a patient, and uploading a scanner slide.
 *
 * Every auth request from this app carries role 'lab_attendant'. That is what
 * separates these accounts from the console's, and is why the same email can
 * hold one account in each.
 */
import { createApiClient } from '@telepathology/shared';
import type { User, Credentials } from '@telepathology/shared';
import type { IntakeForm, CreatedCase } from './types';

/**
 * This app's own client.
 *
 * `chc_token` is deliberately NOT the key the console uses. The two apps run
 * on separate origins so they have separate localStorage anyway, and keeping
 * distinct keys means neither can read the other's session even if that ever
 * stopped being true.
 */
const client = createApiClient({ tokenKey: 'chc_token' });

export const API_BASE = client.API_BASE;
export const { getToken, setToken, request, authHeaders, getMe, logout, updateProfile } = client;

/** Every account created here is a CHC lab attendant. */
const ROLE = 'lab_attendant' as const;

export const signup = (payload: Credentials): Promise<User> => client.signup(payload, ROLE);
export const login = (payload: Credentials): Promise<User> => client.login(payload, ROLE);
export const requestReset = (email: string) => client.requestReset(email, ROLE);
export const resetPassword = (payload: { email: string; code: string; newPassword: string }) =>
  client.resetPassword(payload, ROLE);

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

/* --- Resumable slide upload --------------------------------------------------
 * `uploadSlide` above sends the file as ONE request, so the connection has to
 * survive the entire transfer — ten to thirty minutes for a scanner slide on a
 * CHC's uplink. When it doesn't, the server deletes the partial file and the
 * attendant starts again from zero. Measured on the live server, a 766 MB
 * upload aborted twice in a row about four minutes in.
 *
 * This sends the same file in ~5 MB pieces instead. Each piece is its own short
 * request, so a dropped connection costs one piece rather than the file, and
 * the client simply retries it. The server owns the byte count — the client
 * ASKS where to continue rather than assuming — which is what makes retries,
 * duplicates and reordering all safe.
 */

/** How many consecutive network failures on one piece before giving up.
 *  With the backoff below that is roughly 75 seconds of trying. */
const MAX_RETRIES = 8;
/** A stuck re-sync loop should stop rather than spin. This is generous enough
 *  that it will only ever trigger on a genuine bug. */
const MAX_RESYNCS = 50;

/** Raised when the caller aborts, so the UI can stay silent instead of showing
 *  an error for something the user did deliberately. */
export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled.');
    this.name = 'UploadCancelled';
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * SHA-256 of one chunk as lowercase hex, or undefined where WebCrypto is
 * unavailable.
 *
 * `crypto.subtle` only exists in a secure context, so a plain-http LAN address
 * has none. The server treats the checksum as optional for exactly that reason
 * — the upload still works, it just loses this one extra guard.
 */
async function sha256Hex(buf: ArrayBuffer): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
  let out = '';
  for (const b of new Uint8Array(digest)) out += HEX[b];
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Upload a scanner slide in resumable pieces.
 *
 * `onProgress` reports bytes the SERVER has confirmed, not bytes handed to the
 * operating system — so unlike the old progress bar it cannot race ahead and
 * then collapse when the connection drops.
 *
 * Pass an `AbortSignal` to stop it. Stopping leaves the partial file on the
 * server, which is deliberate: resuming later is the whole point. Call
 * `cancelSlideUpload` to actually throw those bytes away.
 */
export async function uploadSlideResumable(
  caseId: number | string,
  file: File,
  opts: {
    onProgress?: (pct: number, sent: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const { onProgress, signal } = opts;
  const url = `${API_BASE}/api/cases/${caseId}/slide/upload`;
  const stopIfCancelled = (): void => { if (signal?.aborted) throw new UploadCancelled(); };
  const report = (sent: number): void =>
    onProgress?.(file.size ? Math.round((sent / file.size) * 100) : 100, sent, file.size);

  stopIfCancelled();

  // Ask where to start. On a fresh upload this is 0; after an interruption it
  // is however far the server got — including from a previous browser session,
  // because the answer comes from the file on disk rather than anything the
  // client remembered.
  const start = await request<{ bytes: number; chunkSize: number }>(
    `/api/cases/${caseId}/slide/upload?name=${encodeURIComponent(file.name)}`,
  );
  let sent = Math.min(start.bytes, file.size);
  const chunkSize = start.chunkSize || 5 * 1024 * 1024;
  report(sent);

  let attempt = 0;
  let resyncs = 0;

  while (sent < file.size) {
    stopIfCancelled();

    // `slice` hands back a view of the file without reading it into memory, so
    // a 1.2 GB slide never has to fit in the tab's heap.
    const piece = file.slice(sent, Math.min(sent + chunkSize, file.size));
    const buf = await piece.arrayBuffer();
    const checksum = await sha256Hex(buf);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'PATCH',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/octet-stream',
          'Upload-Offset': String(sent),
          ...(checksum ? { 'Upload-Checksum': checksum } : {}),
        },
        body: buf,
        signal,
      });
    } catch {
      // The connection died mid-piece — precisely what this design exists to
      // absorb. Wait, then try the SAME offset again. If the piece had in fact
      // landed and only the reply was lost, the server answers 409 below with
      // its true position and we continue from there.
      if (signal?.aborted) throw new UploadCancelled();
      if (++attempt > MAX_RETRIES) {
        throw new Error(
          `Upload stalled after ${MAX_RETRIES} attempts. ${(sent / 1e6).toFixed(0)} MB is saved on the server — reselect the file to carry on from there.`,
        );
      }
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
      continue;
    }

    // The server and client disagree about the position. Its answer wins.
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}) as { bytes?: number });
      if (typeof body.bytes === 'number' && ++resyncs <= MAX_RESYNCS) {
        sent = Math.min(body.bytes, file.size);
        attempt = 0;
        report(sent);
        continue;
      }
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      throw new Error(body.error || `Upload failed (${res.status})`);
    }

    const body = (await res.json()) as { bytes: number };
    sent = body.bytes;
    attempt = 0;
    report(sent);
  }

  stopIfCancelled();

  // Nothing appears as a slide until this succeeds: the server checks the byte
  // count, renames the partial file, and confirms OpenSlide can open it before
  // the case is marked ready.
  await request(`/api/cases/${caseId}/slide/upload/complete`, {
    method: 'POST',
    body: JSON.stringify({ size: file.size, name: file.name }),
  });
}

/**
 * Throw away a case's slide — a partial upload or a finished one.
 *
 * This is what "wrong file, start again" calls. The case itself survives with
 * its slide fields cleared, so the patient details do not have to be re-entered
 * and the right slide can be uploaded immediately.
 */
export async function cancelSlideUpload(caseId: number | string): Promise<void> {
  await request(`/api/cases/${caseId}/slide`, { method: 'DELETE' });
}
