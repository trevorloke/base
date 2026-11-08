// The other base apps this base ground signs people in to (SUITE.md): which
// are set up, where they live, and the one check on where a sign-in may go
// back to. Used by ext/sso (the hand-off, the switcher) and ext/connections
// (Settings → Services).
export const DESK = ['manager', 'staff', 'treasurer'];
export const APPS = {
  air: { name: 'base air', url: 'BASE_AIR_URL', secret: 'BASE_AIR_SSO_SECRET' },
  web: { name: 'base web', url: 'BASE_WEB_URL', secret: 'BASE_WEB_SSO_SECRET' },
};

export const env = (k) => String(process.env[k] || '').trim();
// An app's address as set, without a trailing slash; null when unset or not
// an http(s) address with nothing after the path.
export const appUrl = (key) => {
  const raw = env(APPS[key]?.url).replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
};
export const appReady = (key) => Boolean(APPS[key] && appUrl(key) && env(APPS[key].secret));

// A volunteer with no area is not staff: the field app is theirs, nothing else.
export const isStaff = (role, areas) => DESK.includes(role) || areas.length > 0;

// redirect_uri must be the app's own address followed by "/": the same
// origin, a path under the app's, no dot segments, nothing hidden in it.
export const redirectOk = (key, uri) => {
  const base = appUrl(key);
  const s = String(uri || '');
  if (!base || !s || s.length > 2000 || !s.startsWith(`${base}/`)) return false;
  if (/[\s\\\u0000-\u001f\u007f#]/.test(s)) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  const b = new URL(base);
  if (u.origin !== b.origin || u.username || u.password) return false;
  // URL() resolved any ./ and ../ — the path it lands on must still be under
  // the app's, and an encoded one (%2e%2e, %2f) isn't let through to be
  // decoded later by someone else.
  if (!u.pathname.startsWith(`${b.pathname.replace(/\/$/, '')}/`)) return false;
  if (/%2e|%2f|%5c/i.test(u.pathname) || /(^|\/)\.\.?(\/|$)/.test(s.slice(b.origin.length).split('?')[0])) return false;
  return true;
};

