// Where this base.win runs: '' at a site's root, or the client's path on a
// shared domain — '/imaginesurrey' on base.win (BASE_PATH on the server,
// which writes window.__BASE__ into the page; server/lib/mount.js).
//   at(path)     a path the server knows ('/api/…', '/learn/…') → where the
//                browser finds it; one already under the client's path is
//                left as it is
//   NS           the start of every key this app keeps on the phone, so two
//                campaigns on base.win never read each other's copies
//   OLD_NS       the same start under the app's older name (shared/old-names.js):
//                what a phone kept before is read from it and carried over
//                (oldStorage.js, offline.js), never written
import { OLD_STORAGE } from '@starbase/shared/old-names';

export const BASE = (() => {
  if (typeof window === 'undefined') return '';
  const b = window.__BASE__;
  return typeof b === 'string' && /^\/[a-z0-9][a-z0-9-]*$/i.test(b) ? b : '';
})();

export const at = (path) => {
  const p = String(path ?? '');
  if (!BASE || !p.startsWith('/') || p.startsWith('//')) return p;
  if (p === BASE || p.startsWith(`${BASE}/`) || p.startsWith(`${BASE}?`)) return p;
  return `${BASE}${p}`;
};

export const NS = BASE ? `base-win:${BASE.slice(1)}:` : 'base-win:';
export const OLD_NS = BASE ? `${OLD_STORAGE.prefix}${BASE.slice(1)}:` : OLD_STORAGE.prefix;
