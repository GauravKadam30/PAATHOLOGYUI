import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  createBrowserRouter, RouterProvider, redirect, useLoaderData,
  type LoaderFunctionArgs,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import TelepathologyDashboard from './TelepathologyDashboard';
import Login from './Login';
import { getMe, getToken, logout } from './api';
import {
  casesQueryOptions, notesQueryOptions, annotationsQueryOptions,
  legacyImagesQueryOptions, loadCaseImage, resetCasesWatermark,
} from './queries';
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
 *
 * ROUTES CARRY LOADERS, which is why this uses createBrowserRouter rather than
 * <BrowserRouter>. A loader runs BEFORE its route renders, and — the part that
 * matters — it runs however the route was reached: clicked from the worklist,
 * opened from a bookmark, or reloaded after a refresh. Fetching from inside the
 * component only covered the first of those. Opening /case/103/slide directly
 * used to leave the viewer on "Loading slide..." indefinitely, because the code
 * that fetched the photo lived in the worklist's click handler and never ran.
 *
 * The loaders do NOT replace TanStack Query, they fill its cache ahead of the
 * render. `ensureQueryData` resolves immediately when the data is already
 * cached, so moving between cases stays instant and only a cold entry pays for
 * the fetch.
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

/** Shown while a loader is still running on a cold page load. */
function RouteFallback() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-[#0b1120] text-slate-400">
      <span className="flex items-center gap-2 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </span>
    </div>
  );
}

/**
 * Warm the caches every screen reads, in parallel.
 *
 * `ensureQueryData` is the loader-side counterpart to `useQuery`: it returns
 * cached data when present and fetches only when it is missing, so this costs
 * nothing on repeat visits.
 */
function loadSharedData(client: QueryClient) {
  return Promise.all([
    client.ensureQueryData(casesQueryOptions(client)),
    client.ensureQueryData(notesQueryOptions),
    client.ensureQueryData(annotationsQueryOptions),
    client.ensureQueryData(legacyImagesQueryOptions),
  ]);
}

/**
 * Loader for both case routes.
 *
 * The shared data is awaited, because the screen cannot show a patient without
 * it. The case photo is deliberately NOT awaited: it can run to several
 * megabytes, and blocking on it would freeze the worklist while it downloads.
 * Starting it here is enough — it is on its way before the viewer mounts, and
 * the viewer shows its own progress state until it lands.
 */
function caseLoader(client: QueryClient) {
  return async ({ params }: LoaderFunctionArgs) => {
    const caseId = Number(params.caseId);
    // A hand-edited URL must not become NaN and silently select some other case.
    if (!params.caseId || !Number.isFinite(caseId)) throw redirect('/queue');

    await loadSharedData(client);
    void loadCaseImage(client, caseId);
    return { caseId };
  };
}

/**
 * Renders a case screen with the id its loader already validated, so the
 * component never has to defend against a malformed URL.
 */
function CaseScreen({ user, onLogout, view }: {
  user: User;
  onLogout: () => void;
  view: 'slide' | 'details';
}) {
  const { caseId } = useLoaderData() as { caseId: number };
  return <TelepathologyDashboard user={user} onLogout={onLogout} view={view} caseId={caseId} />;
}

/**
 * The route table.
 *
 * Built inside a component because the routes close over `user`, and memoised
 * so it is created once per session rather than on every render — rebuilding a
 * data router throws away its navigation state. Both dependencies are stable:
 * `user` is set once at sign-in, and `onLogout` is wrapped in useCallback.
 */
function Router({ user, onLogout }: { user: User; onLogout: () => void }) {
  const router = useMemo(() => createBrowserRouter([
    {
      path: '/queue',
      loader: async () => { await loadSharedData(queryClient); return null; },
      element: <TelepathologyDashboard user={user} onLogout={onLogout} view="queue" />,
      HydrateFallback: RouteFallback,
    },
    {
      path: '/case/:caseId/slide',
      loader: caseLoader(queryClient),
      element: <CaseScreen user={user} onLogout={onLogout} view="slide" />,
      HydrateFallback: RouteFallback,
    },
    {
      path: '/case/:caseId/report',
      loader: caseLoader(queryClient),
      element: <CaseScreen user={user} onLogout={onLogout} view="details" />,
      HydrateFallback: RouteFallback,
    },
    // Anything unrecognised (including "/") lands on the worklist.
    { path: '*', loader: () => redirect('/queue'), element: null },
  ]), [user, onLogout]);

  return <RouterProvider router={router} />;
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
  // Stable identity matters: the router below is memoised on this, and a fresh
  // function each render would rebuild the route table — discarding the
  // router's navigation state — every time App re-renders.
  const handleLogout = useCallback(() => {
    logout();
    setUser(null);
    // Drop any cached patient data — the next person to sign in on this
    // machine must not see the previous user's worklist from cache. The
    // incremental-poll position goes with it, or the next account would ask
    // for changes since the previous one's watermark and receive nothing.
    queryClient.clear();
    resetCasesWatermark();
  }, []);

  if (authChecking) return <RouteFallback />;

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
      <Router user={user} onLogout={handleLogout} />
    </QueryClientProvider>
  );
}

export default App;
