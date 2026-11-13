// Is a street map's provider sending a notice instead of streets? A picture
// that reads "API KEY REQUIRED" (CARTO with no key), a block notice or a
// lapsed account loads like any tile, so the map's own counts call it
// healthy. Two of the provider's tiles for one place, far apart in zoom
// (mapView.js noticeTiles): a real map never draws them the same, a notice
// is the same picture everywhere.
//   Only a provider the phone reaches itself (tileHost): never the server's
//   own /tiles/ (Google's — its errors already come as status codes, and a
//   probe would spend billed tiles).
//   cache 'default': the browser's own cache answers when it holds the tile
//   (what this phone actually gets), and no no-cache headers are sent
//   (OpenStreetMap's tile rules). The service worker lets a script's ask
//   through (sw.js).
//   Once per tile address per page life (shared by every map on the page);
//   forgetNotice() is the Map check's "Check again".
// → Promise of true (a notice), false (streets) or null (no verdict: a
//   failure, a refusal, no CORS, no signal — the map is never judged by a
//   probe that could not run).
import { noticeTiles, sameBytes, tileHost } from './mapView.js';

export const PROBE_MS = 4000;
const asked = new Map();

const bytes = (url) => {
  const stop = typeof AbortController === 'function' ? new AbortController() : null;
  const t = setTimeout(() => stop?.abort(), PROBE_MS);
  return fetch(url, { mode: 'cors', credentials: 'omit', cache: 'default', signal: stop?.signal })
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .finally(() => clearTimeout(t));
};

export const askNotice = (url, center, maxZoom) => {
  if (!tileHost(url) || !center) return Promise.resolve(null);
  if (asked.has(url)) return asked.get(url);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(null);
  const [far, near] = noticeTiles(url, center, maxZoom);
  const answer = Promise.all([bytes(far), bytes(near)])
    .then(([a, b]) => (a && b ? sameBytes(a, b) : null), () => null);
  asked.set(url, answer);
  return answer;
};

export const forgetNotice = (url) => { asked.delete(url); };
