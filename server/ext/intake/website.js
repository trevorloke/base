// Where base.win sends its own unsubscribes: the campaign's website, when it
// is hosted apart and keeps its own list. Two settings in the host's
// environment, like every other key — nothing is read from the database,
// and there is no default:
//
//   BASE_WEBSITE_URL   the website's address, https://…, no path
//   BASE_WEBSITE_KEY   the secret the website holds as its inbound key setting
//
// Each is read under its older name too, while that is the one set
// (shared/old-names.js): a server set up before the rename sends exactly as before.
//
// It is on only when both are set, the address is https (http only for this
// machine itself, for tests), it is not this server's own address and not a
// base.win address (one client's unsubscribes are never pointed at another
// client's base.win), not the campaign's own website now that base.win
// serves it (BASE_SITE_DOMAIN, SITE_HOSTS: the two settings come off
// after the move), and this is not staging: staging never sends.
import { setting } from '@base-win/shared/old-names';
import { envName } from '../../lib/org.js';
import { siteEnvHosts } from '../site/domain.js';

export const URL_ENV = 'BASE_WEBSITE_URL';
export const KEY_ENV = 'BASE_WEBSITE_KEY';
export const CONSENT_PATH = '/api/in/consent';
// How what the website itself said is marked here — a number's STOP row
// (its keyword) and the consent record (its source) — so the run that sends
// what was already off never sends the website its own words back.
export const WEBSITE_KEYWORD = 'WEBSITE SYNC';
export const WEBSITE_SOURCES = ['unsubscribe', 'stop', 'preference', 'deletion'].map((r) => `website-${r}`);
// A setting by its name, or its older name while that is the one set (shared/old-names.js); any other name as it is.
const env = (k) => String(setting(k) || '').trim();
const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

const hostOf = (v) => { try { return new URL(v).host.toLowerCase(); } catch { return ''; } };
// This server's own addresses, as it knows them.
const ownHosts = () => ['BASE_PUBLIC_URL', 'BASE_OWN_URL', 'RENDER_EXTERNAL_URL'].map((k) => hostOf(env(k))).filter(Boolean);

// → { on, host, target, missing: [setting…], problem }
//   problem: null | 'staging' | 'not-set' | 'half-set' | 'not-address' | 'not-https' | 'own' | 'base-win' | 'moved'
export const websiteState = () => {
  const url = env(URL_ENV);
  const missing = [URL_ENV, KEY_ENV].filter((k) => !env(k));
  const off = (problem, host = '') => ({ on: false, host, target: null, missing, problem });
  if (envName() === 'staging') return off('staging');
  if (missing.length === 2) return off('not-set');
  let u = null;
  try { u = new URL(url); } catch { /* said below */ }
  if (url && (!u || !u.hostname)) return off('not-address');
  if (u) {
    const host = u.host.toLowerCase();
    const name = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.includes(name))) return off('not-https', host);
    if (name === 'base.win' || name.endsWith('.base.win')) return off('base-win', host);
    if (siteEnvHosts().includes(name.replace(/\.+$/, ''))) return off('moved', host);
    if (ownHosts().includes(host)) return off('own', host);
    if (missing.length) return off('half-set', host);
    // The address as given, without a last slash (or the path itself, pasted whole).
    const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/in\/consent$/, '');
    return { on: true, host, target: `${u.origin}${path}${CONSENT_PATH}`, missing, problem: null };
  }
  return off('half-set');
};
export const websiteOn = () => websiteState().on;
export const websiteKey = () => env(KEY_ENV);
// The key never leaves in words: anything said about a call is passed through here.
export const withoutKey = (s) => {
  const key = websiteKey();
  const text = String(s ?? '');
  return key ? text.split(key).join('…') : text;
};
