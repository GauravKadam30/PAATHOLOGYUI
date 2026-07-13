/*
 * api.js — the bridge to the backend (apps/server).
 *
 * Besides submitting patient cases, this now also handles sign-up / login. When
 * you log in, the backend gives back a "token" (a signed pass). We keep it in
 * the browser and send it with every request so the server knows who you are.
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
// Create an account (lab attendant name + CHC name + email + password).
export async function signup(payload) {
  const data = await request('/api/auth/signup', { method: 'POST', body: JSON.stringify(payload) });
  setToken(data.token);
  return data.user;
}
// Sign in to an existing account.
export async function login(payload) {
  const data = await request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
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
// Forgot password: verify identity (email + name + CHC) and set a new password.
export async function resetPassword(payload) {
  return request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify(payload) });
}

// --- Cases ---
// Submit a new patient case. The attendant name and CHC are added by the server
// from your logged-in account, so we don't send them here.
export async function addCase(payload) {
  return request('/api/cases', { method: 'POST', body: JSON.stringify(payload) });
}
