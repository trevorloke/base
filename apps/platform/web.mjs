// What every console request goes through: the host split (only OPS_HOST
// answers, except /healthz), the headers on every answer, the Origin check
// on every POST, the cookie names, and reading a form.
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { cfg } from './config.mjs';

export const hostOf = (c) => {
  const host = new URL(c.req.url).host.toLowerCase();
  // Compared with the port only when OPS_HOST names one (tests run on a port).
  return cfg().host.includes(':') ? host : host.replace(/:\d+$/, '');
};

export const csp = () => {
  const formAction = ["'self'", 'https:'];
  if (cfg().allowLocal) formAction.push('http://127.0.0.1:*');
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action ${formAction.join(' ')}`;
};

export const headers = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('Content-Security-Policy', csp());
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
};

export const hostSplit = async (c, next) => {
  if (c.req.path === '/healthz') return next();
  if (hostOf(c) !== cfg().host) return c.text('Not found', 404);
  return next();
};

export const ownOrigin = () => `${cfg().insecureCookies ? 'http' : 'https'}://${cfg().host}`;

// Every POST is a form from this console: its Origin is the console's own,
// and its body is a form (never JSON from elsewhere).
// A form with rel="noreferrer" (Open desk and Invite, so nothing of this
// page reaches the campaign) is posted with "Origin: null"; the browser's
// own Sec-Fetch-Site, which no page can set, still says it came from here.
export const fromHere = (c) => {
  const origin = c.req.header('origin');
  if (origin === ownOrigin()) return true;
  return origin === 'null' && c.req.header('sec-fetch-site') === 'same-origin';
};
export const sameOrigin = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  if (!fromHere(c)) return c.text('Refused: this form must come from the control centre.', 403);
  const type = c.req.header('content-type') || '';
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) return c.text('Refused: send a form.', 415);
  return next();
};

export const form = async (c) => {
  const body = await c.req.parseBody();
  const out = {};
  for (const [k, v] of Object.entries(body)) out[k] = typeof v === 'string' ? v.slice(0, 2000) : '';
  return out;
};

const name = (base) => (cfg().insecureCookies ? base : `__Host-${base}`);
export const SESSION = 'ops';
export const SETUP = 'ops-setup';
export const readCookie = (c, base) => getCookie(c, name(base));
export const writeCookie = (c, base, value, maxAge) => setCookie(c, name(base), value, {
  path: '/', httpOnly: true, sameSite: 'Strict', secure: !cfg().insecureCookies, maxAge,
});
export const clearCookie = (c, base) => deleteCookie(c, name(base), { path: '/', secure: !cfg().insecureCookies });
