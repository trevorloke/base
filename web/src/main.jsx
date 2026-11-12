import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// app.css first: page stylesheets (imported by App's pages) must load after
// the shared primitives so single-class page rules can override them.
import './app.css';
import App from './App.jsx';
import { ADMIN_BASE, FIELD_BASE, fieldHref, appMode } from './mode.js';
import { ME_KEY, NoSignalError, TWO_STEP_EVENT, noAnswer, savedSignIn } from './api.js';
import { keptPersister, watchKeptCopies } from './components/KeptCopies.js';
import { forgetPhoneCopies, keepOnlyMine } from './components/OfflineCache.js';
import { closeOutbox } from './offline.js';
import { at } from './base.js';
import { reloadOnce } from './build.js';

// Once more after a second — except a 401 / 404, or no signal at all (the
// browser says it's offline): then the screen says so straight away, and
// loads again by itself when the signal is back (below, and KeptCopies.js).
const noSignalNow = (error) => error instanceof NoSignalError && typeof navigator !== 'undefined' && navigator.onLine === false;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => (error?.status === 401 || error?.status === 404 || noSignalNow(error) ? false : failureCount < 1),
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      // Desk screens keep their last copy and show it with no signal
      // (components/KeptCopies.js). A persister would switch react-query to
      // "offlineFirst"; the field screens are built on "online" (a query
      // with no signal waits, paused), so it's said here.
      persister: keptPersister,
      networkMode: 'online',
    },
  },
});
watchKeptCopies(queryClient);

// ── Opening the app with no signal ──
// The auth gate needs ['me']; with no network that fetch fails and would bounce
// a volunteer to the login screen (which also needs the network), stranding
// any knocks saved on the phone. So remember the signed-in user (name, email,
// workspace, role — no voter data) and, only when the phone is offline at
// startup, seed it so the app opens. Back online, it refetches as usual and a
// dead session still lands on login. Sign-out (queryClient.clear) or a 401
// forgets it — and with it every copy kept for them (the server says the
// sign-in is over, so nothing of theirs stays on this computer). The same
// when the check gets no answer with signal (wifi with no internet, the
// server restarting): the app opens on the remembered sign-in, and asks
// again every 15 s (App.jsx) — no answer is never a sign-out.
const isMeKey = (key) => key.length === 1 && key[0] === 'me';
// Leaving because another tab signed out: this tab's own clear() must not
// forget what that tab saved (it may be the next person's sign-in).
let leaving = false;
const forgetMe = () => { if (leaving) return; try { localStorage.removeItem(ME_KEY); } catch { /* storage blocked */ } };

if (typeof navigator !== 'undefined' && navigator.onLine === false) {
  const saved = savedSignIn();
  if (saved) queryClient.setQueryData(['me'], saved);
  // react-query assumes it starts online and only refetches on an
  // offline→online *change*. Opened with no signal there is no such change,
  // so screens whose fetch failed would stay failed once signal returns.
  // On the first 'online', refetch them, and re-check the sign-in (a dead
  // session then lands on login).
  window.addEventListener('online', () => {
    queryClient.refetchQueries({
      type: 'active',
      predicate: (q) => isMeKey(q.queryKey) || q.state.status === 'error' || q.isStale(),
    });
  }, { once: true });
}

queryClient.getQueryCache().subscribe((event) => {
  if (!isMeKey(event.query.queryKey)) return;
  if (event.type === 'removed') { forgetMe(); return; }
  if (event.type !== 'updated') return;
  const { status, data, error } = event.query.state;
  if (status === 'success' && data?.user?.id) {
    try { localStorage.setItem(ME_KEY, JSON.stringify(data)); } catch { /* storage full or blocked */ }
  } else if (status === 'error' && (error?.status === 401 || error?.status === 403)) {
    forgetMe();
    forgetPhoneCopies();
  } else if (status === 'error' && data === undefined && noAnswer(error)) {
    // Opened with signal but no answer: as who signed in here last. Its time
    // is 0 — not an answer — so RequireAuth keeps asking.
    const saved = savedSignIn();
    if (saved) event.query.setData(saved, { updatedAt: 0 });
  }
});

// Signed out in another tab (or signed in there as someone else): this tab
// drops what it holds — its memory and the copies kept for this tab only —
// and opens again as whoever is signed in now (or on Sign in).
if (typeof window !== 'undefined') {
  let soon = null;
  window.addEventListener('storage', (e) => {
    if (e.key !== ME_KEY && e.key !== null) return;
    clearTimeout(soon);
    // A sign-in elsewhere forgets the old one and saves the new one: read what's there once both are done.
    soon = setTimeout(() => {
      const cur = queryClient.getQueryData(['me']);
      if (!cur?.user?.id || leaving) return;
      const next = savedSignIn();
      if (next && next.user.id === cur.user.id && next.workspace.id === cur.workspace?.id) return;
      leaving = true;
      closeOutbox(); // nothing more is saved here under the sign-in that ended
      queryClient.clear();
      if (next) keepOnlyMine(next); else forgetPhoneCopies();
      window.location.assign(appMode() === 'admin' ? (next ? `${ADMIN_BASE}/` : `${ADMIN_BASE}/login`) : fieldHref(next ? '/' : '/login'));
    }, 60);
  });
}

// Two-step sign-in became required for this person while the app was open
// (api.js): who they are is asked again, and the set-up takes over (App.jsx).
if (typeof window !== 'undefined') {
  window.addEventListener(TWO_STEP_EVENT, () => { queryClient.invalidateQueries({ queryKey: ['me'] }); });
}

// A screen's file is gone: this page is from before a deploy, and the server
// no longer has its build (a missing file is a 404 — server/index.js). Take
// the new page, once (build.js). Only when the server says the file is gone:
// a weak signal that dropped the file is not a deploy, and a reload then would
// throw away what is half done on the screen (an open sheet) for a page that
// would not come either. Not while someone is typing. Otherwise the screen
// says it didn't load, with Reload (components/ScreenBoundary.jsx).
if (typeof window !== 'undefined') {
  const typing = () => {
    const el = document.activeElement;
    return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
  };
  // The file the error names (".../assets/People-xxxx.js"); null if it names none.
  const fileOf = (err) => /(\S*\/assets\/[^\s'"]+\.(?:js|css))/.exec(String(err?.message || err || ''))?.[1] || null;
  const gone = async (file) => {
    if (!file) return true; // nothing to ask about: as before, a missing screen
    try { return (await fetch(file, { cache: 'no-store' })).status === 404; } catch { return false; }
  };
  window.addEventListener('vite:preloadError', async (e) => {
    if (navigator.onLine === false || typing()) return;
    if (await gone(fileOf(e.payload)) && !typing()) reloadOnce();
  });
}

// /admin/… is the admin (the desk), everything else the field app (mode.js).
const mode = appMode();
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter basename={mode === 'admin' ? ADMIN_BASE : (FIELD_BASE || undefined)}>
      <App mode={mode} />
    </BrowserRouter>
  </QueryClientProvider>,
);

// Service worker: app shell + map tiles for the field (public/sw.js). Only in
// production builds — in dev it would cache Vite's modules and fight HMR.
if (import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(at('/sw.js'), { scope: at('/') }).catch(() => { /* app still works online */ });
  });
}
