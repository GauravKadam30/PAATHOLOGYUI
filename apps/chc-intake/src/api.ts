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
export const { getToken, setToken, request, getMe, logout, updateProfile } = client;

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
