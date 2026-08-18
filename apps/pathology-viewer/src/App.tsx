import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import TelepathologyDashboard from './TelepathologyDashboard';
import Login from './Login';
import { getMe, getToken, logout } from './api';
import type { User } from './types';

/*
 * App.tsx — the root of the pathology console.
 *
 * Three responsibilities, in order:
 *   1. Provide TanStack Query to the whole tree (server data, caching, polling).
 *   2. Decide WHICH screen to show — sign-in page or dashboard.
 *   3. Map URLs onto the dashboard's three views via React Router.
 *
 * On (2) there are three distinct states, and collapsing the first two would
 * flash the login page at someone already signed in on every refresh:
 *   checking   — a token exists, we're asking the server who it belongs to
 *   signed out — no valid session; show Login
 *   signed in  — show the dashboard
 *
 * On (3): the dashboard used to switch views with a `page` state variable, so
 * the whole app lived at one URL. Real routes mean a pathologist can bookmark
 * a case or send "look at this one" to a colleague as a link, the browser Back
 * button works, and a refresh returns to the same place instead of the queue.
 */

// One QueryClient for the app's lifetime. Defaults are set here rather than at
// each call site so caching behaviour is consistent everywhere.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Clinical data changes rarely within a session; 30s avoids refetching
      // the worklist every time a component happens to remount.
      staleTime: 30_000,
      // Refetching whenever the window regains focus is a sensible default for
      // a shared worklist — a pathologist returning to the tab sees new cases.
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

/**
 * Reads the :caseId from the URL and hands it to the dashboard as a number.
 *
 * Route params are always strings, and an invalid one (someone editing the URL
 * by hand) must not become NaN silently — it redirects to the queue instead.
 */
function CaseRoute({ user, onLogout, view }: {
  user: User;
  onLogout: () => void;
  view: 'slide' | 'details';
}) {
  const { caseId } = useParams<{ caseId: string }>();
  const parsed = Number(caseId);
  if (!caseId || !Number.isFinite(parsed)) return <Navigate to="/queue" replace />;
  return <TelepathologyDashboard user={user} onLogout={onLogout} view={view} caseId={parsed} />;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  // Starts true: on a cold load we don't yet know whether the saved token is
  // still good, and must not assume "signed out" before finding out.
  const [authChecking, setAuthChecking] = useState(true);

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
  const handleLogout = () => {
    logout();
    setUser(null);
    // Drop any cached patient data — the next person to sign in on this
    // machine must not see the previous user's worklist from cache.
    queryClient.clear();
  };

  if (authChecking) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#0b1120] text-slate-400">
        <span className="flex items-center gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </span>
      </div>
    );
  }

  // Signed out: no routes at all, just the login screen. This is what keeps
  // every route below implicitly authenticated — there is no way to reach them
  // without a user, so no per-route auth guard is needed.
  if (!user) {
    return (
      <QueryClientProvider client={queryClient}>
        <Login onAuth={setUser} />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/queue" element={<TelepathologyDashboard user={user} onLogout={handleLogout} view="queue" />} />
          <Route path="/case/:caseId/slide" element={<CaseRoute user={user} onLogout={handleLogout} view="slide" />} />
          <Route path="/case/:caseId/report" element={<CaseRoute user={user} onLogout={handleLogout} view="details" />} />
          {/* Anything unrecognised (including "/") lands on the worklist. */}
          <Route path="*" element={<Navigate to="/queue" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
