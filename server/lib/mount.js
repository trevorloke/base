// Ground under a client's path on a shared domain — base.win/imaginesurrey/…
// (BASE_PATH=/imaginesurrey). Unset, Ground answers at the site's root as it
// always has, and nothing here runs.
//
// One client's Ground per deployment (its own server and database); the
// front door at base.win (apps/door) sends /<client>/field, /<client>/desk,
// /<client>/api… here with the path as it came. On the way in the client's
// path is taken off, so every route inside is the same as at a root; on the
// way out it is put back where a browser will read it:
//   Location     a redirect to /x goes to /imaginesurrey/x
//   Set-Cookie   the sign-in cookie's Path is the client's, so two
//                campaigns on base.win never see each other's sign-in
//   HTML / CSS   href, src, action and url(…) that start with / (the page
//                itself, the server's own pages); the app's page also gets
//                window.__BASE__, which the app reads for everything it
//                builds itself (web/src/base.js)
//   manifest     id, scope, icons and start_url (the field app's /map)
// Addresses: /field is the volunteers' app, /desk the office's (/admin
// before; still taken, and sent on); the client's path alone opens /field.
// c.env.base tells a route where it is (here(c, path)) for paths it hands
// out in JSON (the map's tiles, a lesson's page).

export const basePath = (raw = process.env.BASE_PATH) => {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  const p = s.startsWith('/') ? s : `/${s}`;
  return /^\/[a-z0-9][a-z0-9-]{0,62}$/i.test(p) ? p : '';
};

// A path inside Ground → where a browser finds it.
export const here = (c, path) => `${c?.env?.base || ''}${path}`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Is this a path the browser opens the app at (not a file, not the API, not
// one of the server's own pages)? Those go to /field when they're elsewhere.
const APP_PATH = /^\/(?:field|desk)(?:\/|$)/;

export const rewriters = (base) => {
  const name = escapeRe(base.slice(1));
  // A root path not already under the client's: "/x" (not "//x", not "/imaginesurrey/…").
  const root = `\\/(?!\\/|${name}(?:[\\/"'?#)]|$))`;
  const attr = new RegExp(`(\\s(?:href|src|action|poster)=["'])${root}`, 'gi');
  const cssUrl = new RegExp(`(url\\(\\s*["']?)${root}`, 'gi');
  const loc = (l) => (l.startsWith('/') && !l.startsWith('//') && !(l === base || l.startsWith(`${base}/`) || l.startsWith(`${base}?`)) ? `${base}${l}` : l);
  return {
    location: loc,
    html: (t) => {
      let out = t.replace(attr, `$1${base}/`);
      if (out.includes('id="root"')) out = out.replace(/<head>/i, `<head><script>window.__BASE__=${JSON.stringify(base)}</script>`);
      return out;
    },
    css: (t) => t.replace(cssUrl, `$1${base}/`),
    cookie: (c) => c.replace(/;\s*Path=([^;]*)/i, (m, p) => {
      const path = p.trim();
      if (path === base || path.startsWith(`${base}/`)) return m;
      return `; Path=${path === '/' || !path ? base : `${base}${path}`}`;
    }),
    manifest: (m) => ({
      ...m,
      id: `${base}/`,
      scope: `${base}/`,
      start_url: `${base}/field${m.start_url && m.start_url !== '/' ? m.start_url : '/'}`,
      icons: (m.icons || []).map((i) => ({ ...i, src: loc(i.src) })),
    }),
  };
};

const rewriteResponse = async (res, base, rw) => {
  const headers = new Headers(res.headers);
  let changed = false;
  const location = headers.get('location');
  if (location) { headers.set('location', rw.location(location)); changed = true; }
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (cookies.length) {
    headers.delete('set-cookie');
    for (const c of cookies) headers.append('set-cookie', rw.cookie(c));
    changed = true;
  }
  const type = (headers.get('content-type') || '').toLowerCase();
  const kind = type.includes('text/html') ? 'html' : type.includes('text/css') ? 'css' : type.includes('manifest+json') ? 'manifest' : null;
  if (!kind || !res.body) return changed ? new Response(res.body, { status: res.status, statusText: res.statusText, headers }) : res;
  const text = await res.text();
  let out = text;
  if (kind === 'html') out = rw.html(text);
  else if (kind === 'css') out = rw.css(text);
  else { try { out = JSON.stringify(rw.manifest(JSON.parse(text))); } catch { out = text; } }
  headers.delete('content-length');
  headers.delete('etag'); // the bytes are not the file's any more
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
};

// → fetch(req, env) for the server: the app at base (or as is, base '').
export const mountAt = (app, base) => {
  if (!base) return (req, env) => app.fetch(req, env);
  const rw = rewriters(base);
  return async (req, env) => {
    const url = new URL(req.url);
    const p = url.pathname;
    // The host's own health check may ask without the client's path.
    if (p === '/api/health') return app.fetch(req, { ...(env || {}), base });
    if (!(p === base || p.startsWith(`${base}/`))) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    let inner = p.slice(base.length) || '/';
    // The client's path alone, or an address from before (/admin, /login…):
    // the volunteers' app, or the office's for /admin.
    if (inner === '/') return Response.redirect(new URL(`${base}/field/${url.search}`, url), 302);
    if (inner === '/admin' || inner.startsWith('/admin/')) {
      return Response.redirect(new URL(`${base}/desk${inner.slice('/admin'.length) || '/'}${url.search}`, url), 302);
    }
    url.pathname = inner;
    const init = { method: req.method, headers: req.headers, redirect: 'manual', signal: req.signal };
    if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = req.body; init.duplex = 'half'; }
    const res = await app.fetch(new Request(url, init), { ...(env || {}), base });
    return rewriteResponse(res, base, rw);
  };
};

// For the SPA fallback: under a client's path, an address that isn't the
// app's goes to the volunteers' app (/join/…, /login from an old link).
export const appRedirect = (c) => {
  const base = c.env?.base;
  if (!base) return null;
  const { pathname, search } = new URL(c.req.url);
  if (APP_PATH.test(pathname)) return null;
  if (/\.[a-z0-9]{2,5}$/i.test(pathname)) return null; // a missing file stays missing
  return c.redirect(`/field${pathname}${search}`, 302);
};
