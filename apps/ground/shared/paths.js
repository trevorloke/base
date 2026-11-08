// Where Base Ground lives under its address (SUITE.md, "BASE_PATH"): the
// same rules for the server and the browser, so they can't disagree.
//
//   cleanBase(raw)        '/imaginesurrey' from ' imaginesurrey/ ', '' for
//                         nothing or '/'; null when it isn't a plain path
//                         (letters, digits, - _ . ~ between slashes), so a
//                         typo can't end up inside the HTML or a redirect.
//   underBase(path, base) true when `path` is the base itself or below it.
//   safeNext(next, base)  the path to go to after signing in, or null:
//                         only this app's own addresses (same origin, under
//                         the base), never another site — `next` comes from
//                         the address bar, so anyone can write it.
export const cleanBase = (raw) => {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  const p = s.startsWith('/') ? s : `/${s}`;
  return /^(\/[A-Za-z0-9._~-]+)+$/.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p) ? p : null;
};

export const underBase = (path, base) => !base || path === base || String(path).startsWith(`${base}/`);

export const safeNext = (next, base = '') => {
  const s = String(next ?? '');
  // A path, and only a path: one leading slash (not // or /\, which browsers
  // read as another host), no control characters or backslashes anywhere.
  if (!s.startsWith('/') || s.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(s) || s.length > 2000) return null;
  let u;
  try { u = new URL(s, 'http://base.invalid'); } catch { return null; }
  if (u.origin !== 'http://base.invalid') return null;
  // Dot segments are resolved by URL(): '/x/../evil' is checked as '/evil'.
  // Encoded ones (%2e%2e) are refused outright rather than trusted to stay
  // encoded on the way.
  if (/%2e|%2f|%5c/i.test(u.pathname)) return null;
  if (!underBase(u.pathname, base)) return null;
  return `${u.pathname}${u.search}${u.hash}`;
};
