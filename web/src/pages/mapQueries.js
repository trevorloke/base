// What the Map and the front page's map window (components/MapWindow.jsx)
// share, in a module of its own so Today never loads the Map page's chunk:
// the reads' query keys and paths (and the name each is kept under on the
// phone), the saved look, and the word to the service worker about tiles.
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { NS } from '../base.js';
import { phoneCopy, useKeepCopy } from '../components/OfflineCache.js';

// The map's turfs. A volunteer's own (a few) come whole, counts and all, and
// stay on the phone: with no signal they still open on "My turf". Anyone
// else's map asks for names and outlines only (GET /turfs?outline=1) — a
// city cut into 158 turfs took seconds to count, and no outline showed
// until it had; a turf's counts are asked for when its sheet opens.
export const TURFS_WHOLE = { key: ['turfs'], path: '/turfs', copy: 'turfs' };
export const TURFS_OUTLINE = { key: ['turfs', 'outline'], path: '/turfs?outline=1', copy: 'turfOutlines' };
// The front page's map window: the doors and outlines of the turfs the
// person walks, and nothing else (a lean read, any role). Under ['doors'],
// so whatever refreshes the Map's doors refreshes these too.
export const MY_DOORS = { key: ['doors', 'mine'], path: '/map/doors?mine=1', copy: 'myDoors' };

// The map's look, each person's own (kept per browser). The saved pick, or
// null: nothing picked. With none the map opens on Clean where the server
// offers it (a light, quiet base map — only with the campaign's CARTO key),
// else Standard (mapView.js defaultLook). Muted, Dark and the rest are a
// tap away (Show → Map), and only a tap is ever saved.
export const VIEW_PREF = `${NS}map:view`;
export const readViewPref = () => { try { return localStorage.getItem(VIEW_PREF) || null; } catch { return null; } };

// Tell the service worker which provider's tiles to keep (a provider the
// worker doesn't know by itself: OpenStreetMap's and CARTO's it always keeps).
export function tellServiceWorker(url) {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (!sw) return;
  const msg = { type: 'starbase:tiles', url };
  sw.controller?.postMessage(msg);
  sw.ready?.then((reg) => reg.active?.postMessage(msg)).catch(() => {});
}

// The desk band's outlines (MapWindow.jsx): names and shapes only, nobody
// read; its row's meta and the map inside share the one ask.
export function useBandTurfs(me, enabled = true) {
  const q = useQuery({
    queryKey: TURFS_OUTLINE.key, queryFn: () => apiGet(TURFS_OUTLINE.path), staleTime: 5 * 60_000, enabled, ...phoneCopy(me, TURFS_OUTLINE.copy),
  });
  useKeepCopy(me, TURFS_OUTLINE.copy, q);
  return q;
}
