import React, { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import TelepathologyDashboard from './TelepathologyDashboard'
import Login from './Login'
import { getMe, getToken, logout } from './api'

/*
 * App.jsx — the root of the pathology console.
 *
 * Its only job is to decide WHICH screen to show: the sign-in page, or the
 * dashboard. Everything else lives in TelepathologyDashboard.
 *
 * There are three states, and they must be kept distinct — collapsing the
 * first two would flash the login page at someone who is already signed in,
 * every single time they refresh:
 *   1. checking   — a token exists, we're asking the server who it belongs to
 *   2. signed out — no valid session; show Login
 *   3. signed in  — show the dashboard
 */
function App() {
  const [user, setUser] = useState(null)
  // Starts true: on a cold load we don't yet know whether the saved token is
  // still good, and must not assume "signed out" before finding out.
  const [authChecking, setAuthChecking] = useState(true)

  // Restore the session across refreshes. If the token is missing there's
  // nothing to check; if the server rejects it (expired, or revoked via
  // "sign out everywhere") we discard it and fall through to the login screen.
  useEffect(() => {
    if (!getToken()) { setAuthChecking(false); return; }
    getMe()
      .then(setUser)
      .catch(() => logout())
      .finally(() => setAuthChecking(false));
  }, []);

  // Signing out only needs to forget the token locally. To end sessions on
  // OTHER devices too, the backend exposes /api/auth/logout-all.
  const handleLogout = () => { logout(); setUser(null); };

  if (authChecking) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#0b1120] text-slate-400">
        <span className="flex items-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</span>
      </div>
    );
  }
  if (!user) return <Login onAuth={setUser} />;

  return (
    <TelepathologyDashboard user={user} onLogout={handleLogout} />
  )
}

export default App