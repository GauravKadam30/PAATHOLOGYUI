/**
 * The half of the API client both front-ends share: where the backend is, how
 * a token is stored, and every account-related call.
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE: anything about cases, slides, notes or annotations. Those
 * belong to the console alone, and the intake app's uploads belong to it. Only
 * the pieces that were genuinely written twice moved.
 *
 * A FACTORY, NOT MODULE-LEVEL STATE, and that is the important design choice.
 * The two apps deliberately store their tokens under DIFFERENT keys — the
 * intake app uses `chc_token`, the console `pv_token` — and because each runs
 * on its own origin they get separate localStorage anyway. That separation is
 * a real boundary: an XSS in one app cannot read the other's session. A shared
 * module with one hard-coded key would have quietly destroyed it, so the key
 * is configuration and each app passes its own.
 */
import type { AuthResponse, Credentials, Role, User } from './types.ts';

export interface ApiClientConfig {
  /** localStorage key for this app's token. MUST differ per app. */
  tokenKey: string;
  /** Override the resolved backend origin. Mostly for tests. */
  baseUrl?: string;
}

/**
 * Work out where the backend lives, in priority order:
 *   1. VITE_API_URL when set — a LAN IP, a hosted URL, anything.
 *   2. Auto-detect on browser sandboxes such as StackBlitz, where the app runs
 *      at a "…--5173…" address and the backend is the matching "…--3001…" one,
 *      so two machines can share with no configuration at all.
 *   3. http://localhost:3001 for an ordinary single-machine run.
 */
function resolveApiBase(): string {
  const explicit = import.meta.env?.VITE_API_URL as string | undefined;
  if (explicit) return explicit;

  if (typeof window !== 'undefined') {
    const { protocol, hostname, host } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:3001';
    if (host.includes('--5173')) return `${protocol}//${host.replace('--5173', '--3001')}`;
  }
  return 'http://localhost:3001';
}

export function createApiClient({ tokenKey, baseUrl }: ApiClientConfig) {
  const API_BASE = (baseUrl ?? resolveApiBase()).replace(/\/+$/, '');

  const getToken = (): string | null => localStorage.getItem(tokenKey);
  const setToken = (t: string | null): void => {
    if (t) localStorage.setItem(tokenKey, t);
    else localStorage.removeItem(tokenKey);
  };

  /**
   * Authorization header for the signed-in user, or {} when signed out.
   *
   * Every request that touches patient data needs this. Some read helpers once
   * used a bare fetch() with no headers, and the server left those routes open
   * to match — so the whole worklist could be fetched by anyone who knew the
   * URL. Having one place that produces the header is what stops that
   * happening again.
   */
  const authHeaders = (): Record<string, string> => {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  /**
   * One request against the API: attaches the token, sends and receives JSON,
   * and turns any server error into a readable message rather than a status
   * code. Generic over the response so callers get a real type, not `any`.
   */
  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers as Record<string, string> | undefined),
    };
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));   // some errors have no body
    if (!res.ok) {
      throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
    }
    return data as T;
  }

  /**
   * Create an account and sign in.
   *
   * `role` is explicit rather than baked in, because the console serves two of
   * them — a pathologist and a physician sign in through the same screens and
   * the toggle decides which. The intake app passes its fixed role.
   */
  async function signup(payload: Credentials, role: Role): Promise<User> {
    const data = await request<AuthResponse>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ ...payload, role }),
    });
    setToken(data.token);
    return data.user;
  }

  async function login(payload: Credentials, role: Role): Promise<User> {
    const data = await request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ ...payload, role }),
    });
    setToken(data.token);
    return data.user;
  }

  /** Who does the saved token belong to? Used to restore a session on reload. */
  async function getMe(): Promise<User> {
    const data = await request<{ user: User }>('/api/auth/me');
    return data.user;
  }

  /** Forget the token locally. /api/auth/logout-all ends other devices too. */
  function logout(): void {
    setToken(null);
  }

  async function updateProfile(payload: { fullName: string; chcName: string }): Promise<User> {
    const data = await request<{ user: User }>('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return data.user;
  }

  /**
   * Step 1 of a password reset: ask for a code.
   *
   * The role travels with it because one email can hold an account on more
   * than one portal — resetting the console password must not touch a CHC
   * account on the same address. The reply is identical whether or not the
   * account exists, so this cannot be used to discover registered emails.
   */
  async function requestReset(email: string, role: Role): Promise<{ ok: true; message: string }> {
    return request('/api/auth/request-reset', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
  }

  /** Step 2: exchange the emailed code for a new password. */
  async function resetPassword(
    payload: { email: string; code: string; newPassword: string },
    role: Role,
  ): Promise<{ ok: true }> {
    return request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ ...payload, role }),
    });
  }

  return {
    API_BASE,
    getToken, setToken, authHeaders, request,
    signup, login, getMe, logout, updateProfile, requestReset, resetPassword,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
