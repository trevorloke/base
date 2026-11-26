// Where this base.win runs: '' at a site's root (a client's own address,
// <client>.base.win, is one), or the client's path on a shared domain —
// '/imaginesurrey' (BASE_PATH on the server, which writes window.__BASE__
// into the page; server/lib/mount.js).
//   at(path)     a path the server knows ('/api/…', '/learn/…') → where the
//                browser finds it; one already under the client's path is
//                left as it is
//   NS           the start of every key this app keeps on the phone, so two
//                campaigns on one domain never read each other's copies
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

export const NS = BASE ? `starbase:${BASE.slice(1)}:` : 'starbase:';
