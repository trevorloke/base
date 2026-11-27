// Where the app answers, and the website's own domain (SITE.md "Where the
// site is served", "On its own domain"). Pure: settings only, no database,
// read each time they are asked (tests change them between cases).
//
//   STARBASE_SITE_DOMAIN       the website's own domain (imaginesurrey.ca),
//                              set per service in Render, never in
//                              render.yaml. Its pair (www. added, or taken
//                              off) answers too and sends pages on to it.
//                              Ignored where the app itself answers, so the
//                              desk can never be locked out of its address.
//   STARBASE_SITE_FORMER_URL   the website the domain had before, at its own
//                              address (https://…): its own links in emails
//                              it already sent go there (old-paths.js).
//   SITE_HOSTS, APP_HOSTS      the operator's lists (comma-separated).
import { hostOf } from './shape.js';

// Host names or addresses, comma-separated (127.0.0.1 for a test), a final dot or not.
export const hostList = (raw) => String(raw || '').split(',')
  .map((h) => h.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.+$/, ''))
  .filter((h) => /^[a-z0-9.-]{1,253}$/.test(h));

// Where the app itself answers — never a website domain (on one of those
// only the site answers: no sign-in, no app): base.win and its subdomains
// (the front door), this server's public address (STARBASE_PUBLIC_URL), its
// host's own name (RENDER_EXTERNAL_HOSTNAME) and its other addresses
// (APP_HOSTS: one people used before base.win, say).
const DOOR = 'base.win';
export const appHosts = (env = process.env) => {
  const out = [DOOR];
  try {
    const h = new URL(String(env.STARBASE_PUBLIC_URL || '').trim()).hostname.toLowerCase().replace(/\.+$/, '');
    if (h && !out.includes(h)) out.push(h);
  } catch { /* not set */ }
  const r = hostOf(env.RENDER_EXTERNAL_HOSTNAME);
  if (r && !out.includes(r)) out.push(r);
  for (const h of hostList(env.APP_HOSTS)) if (!out.includes(h)) out.push(h);
  return out;
};
export const isAppHost = (host, also = [], env = process.env) => {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return Boolean(h) && (h === DOOR || h.endsWith(`.${DOOR}`) || appHosts(env).includes(h) || also.includes(h));
};

// → { domain, problem }: the website's own domain as set, or why it is not
// taken ('not-domain' | 'app'), or nothing set.
export const siteDomainState = (env = process.env) => {
  const raw = String(env.STARBASE_SITE_DOMAIN || '').trim();
  if (!raw) return { domain: '', problem: null, raw };
  const h = hostOf(hostList(raw)[0] || '');
  if (!h) return { domain: '', problem: 'not-domain', raw };
  if (isAppHost(h, [], env)) return { domain: '', problem: 'app', raw: h };
  return { domain: h, problem: null, raw };
};
export const siteDomain = (env = process.env) => siteDomainState(env).domain;
// The domain and its pair: www.<domain>, or the bare name of a www. one.
export const siteDomainHosts = (env = process.env) => {
  const d = siteDomain(env);
  if (!d) return [];
  const pair = d.startsWith('www.') ? d.slice(4) : `www.${d}`;
  return hostOf(pair) && !isAppHost(pair, [], env) ? [d, pair] : [d];
};
// The website's own hosts the operator set: SITE_HOSTS, then the domain and its pair.
export const siteEnvHosts = (env = process.env) => [...new Set([...hostList(env.SITE_HOSTS), ...siteDomainHosts(env)])];

// The former website at its own address, without a last slash: https only
// (http for this machine itself, for tests), never the app's address and
// never one the website answers at here — '' when not set or not usable.
const LOCAL = ['localhost', '127.0.0.1'];
export const formerUrl = (env = process.env) => {
  const raw = String(env.STARBASE_SITE_FORMER_URL || '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  const h = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL.includes(h)))) return '';
  if (isAppHost(h, [], env) || siteEnvHosts(env).includes(h)) return '';
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
};
