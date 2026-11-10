// Which build this page is, and whether the server has moved on.
//
// Every /api answer names the web build the server hands out (X-Build: the
// page's entry file — server/lib/build.js). A page left open across a deploy,
// or one the phone kept from before it, sees a name that is not its own:
//   · just opened and not touched yet (the service worker showed the page it
//     kept, because the server was slow to hand over the new one): it takes
//     the new page at once;
//   · otherwise the strip under the nav says "A new version is ready ·
//     Reload" (components/NewVersion.jsx) and the next link is a full page
//     load, so the new build arrives with it.
// A screen whose file is gone — the old build's, after a deploy — takes the
// new page too (main.jsx). Each of these reloads by itself at most once in
// five minutes (reloadOnce), so nothing can go round and round: after that
// the page says what happened and leaves the reload to the person.
import { useSyncExternalStore } from 'react';
import { NS } from './base.js';

// 'index-DoXy12ab.js', read from the page the way the server reads it
// (lib/build.js buildOf). null in development: nothing is compared.
const ownBuild = () => {
  if (typeof document === 'undefined') return null;
  for (const s of document.scripts) {
    if (s.type !== 'module') continue;
    const m = /\/assets\/([A-Za-z0-9._-]+\.js)$/.exec(String(s.src).split(/[?#]/)[0]);
    if (m) return m[1];
  }
  return null;
};
export const OWN_BUILD = ownBuild();

// Has anyone tapped or typed since the page opened? (A reload under their
// fingers would lose it; a page nobody has touched loses nothing.)
let touched = false;
if (typeof window !== 'undefined') {
  const touch = () => { touched = true; };
  window.addEventListener('pointerdown', touch, { capture: true, once: true });
  window.addEventListener('keydown', touch, { capture: true, once: true });
}

const RELOADED = `${NS}reloaded-at`;
const AGAIN_AFTER_MS = 5 * 60_000;
let leaving = false;
// The page is on its way out (the screen shows "Loading…", not an error).
export const reloading = () => leaving;
// Reload now — unless this tab already did within five minutes. true: it is
// reloading. With nowhere to remember it (storage blocked), never by itself.
export const reloadOnce = () => {
  try {
    const last = Number(sessionStorage.getItem(RELOADED)) || 0;
    if (Date.now() - last < AGAIN_AFTER_MS) return false;
    sessionStorage.setItem(RELOADED, String(Date.now()));
  } catch { return false; }
  leaving = true;
  window.location.reload();
  return true;
};

let newer = false;
const listeners = new Set();
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const JUST_OPENED_MS = 20_000;

// The build an /api answer named (api.js, on every answer).
export const sawServerBuild = (name) => {
  if (!name || !OWN_BUILD || name === OWN_BUILD || newer) return;
  newer = true;
  const justOpened = !touched && performance.now() < JUST_OPENED_MS;
  if (justOpened && navigator.onLine !== false && reloadOnce()) return;
  for (const fn of listeners) fn();
};

// true once the server has named a build that is not this page's.
export const useNewVersion = () => useSyncExternalStore(subscribe, () => newer, () => false);
