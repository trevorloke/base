// Where this base ground lives on its address (SUITE.md, "BASE_PATH").
//
//   BASE_PATH   /imaginesurrey on base.win (the front door passes the path
//               on as it is). Empty, as on a laptop: everything at the root,
//               exactly as before.
//
// withBasePath(fetch) wraps the Hono app's fetch: a request under the prefix
// is handled with the prefix taken off, as if the app were at the root, so
// no route needs to know about it. A request without it gets a 308 to the
// same address under the prefix — except the health check, which Render
// calls at /api/health whatever the prefix.
//
// basePath() is read on every call, not once at load: tests turn it on and
// off, and it costs a string trim.
import { cleanBase } from '@base-ground/shared/paths';

const HEALTH = new Set(['/api/health']);

let warnedBad = null;
export const basePath = () => {
  const raw = process.env.BASE_PATH;
  const base = cleanBase(raw);
  if (base === null) {
    // A BASE_PATH that isn't a plain path is ignored rather than written
    // into pages and redirects; said once per value so the log shows it.
    if (warnedBad !== raw) console.warn(`base: BASE_PATH "${raw}" isn't a plain path like /imaginesurrey — ignored`);
    warnedBad = raw;
    return '';
  }
  return base;
};

// The client's slug, for the apps signing in through base ground: BASE_CLIENT
// when it's set, else the last part of BASE_PATH (/imaginesurrey → imaginesurrey).
export const clientSlug = () => {
  const own = String(process.env.BASE_CLIENT || '').trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(own)) return own;
  const last = basePath().split('/').pop();
  return last ? last.toLowerCase() : null;
};

// This app's own public address: BASE_PUBLIC_URL, else the address the
// request came in on plus the prefix.
export const publicBaseFor = (c) => (process.env.BASE_PUBLIC_URL
  || `${new URL(c.req.url).origin}${basePath()}`).replace(/\/$/, '');

export const withBasePath = (fetch) => (req, ...rest) => {
  const base = basePath();
  if (!base) return fetch(req, ...rest);
  const url = new URL(req.url);
  if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
    url.pathname = url.pathname.slice(base.length) || '/';
    return fetch(new Request(url, req), ...rest);
  }
  if (HEALTH.has(url.pathname)) return fetch(req, ...rest);
  return new Response(null, { status: 308, headers: { Location: `${base}${url.pathname}${url.search}` } });
};

// At startup: BASE_PUBLIC_URL must end in the same prefix, or every link in
// an email points somewhere the app isn't. Said loudly; never a crash (the
// app still answers, and Settings → Services shows the same).
export const publicUrlMismatch = (env = process.env) => {
  const base = cleanBase(env.BASE_PATH) || '';
  const pub = String(env.BASE_PUBLIC_URL || '').trim();
  if (!pub) return null;
  let path;
  try { path = new URL(pub).pathname.replace(/\/+$/, ''); } catch { return `BASE_PUBLIC_URL "${pub}" isn't an address`; }
  if (path === base) return null;
  return `BASE_PUBLIC_URL ends in "${path || '/'}" but BASE_PATH is "${base || '(empty)'}" — links in emails and texts will point to the wrong place`;
};
