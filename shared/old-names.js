// Older names, kept only so what is already saved keeps working: settings in
// Render, data on phones, a folder on disk. Nothing new is ever written under them.
//
// This file holds names, frozen tables and small pure functions, and imports
// nothing. The server, the control centre and the phone app all read it. The
// /* @__PURE__ */ marks let a page that imports only OLD_STORAGE leave the
// settings table out of its bundle.

export const OLD_WORD = 'starbase';             // the guard test and the read-only finder import this

// new name -> old name: the 49 settings base.win reads
export const OLD_SETTINGS = /* @__PURE__ */ Object.freeze({
  BASE_ENV: 'STARBASE_ENV', BASE_BRAND: 'STARBASE_BRAND', BASE_ORG_NAME: 'STARBASE_ORG_NAME',
  BASE_PUBLIC_URL: 'STARBASE_PUBLIC_URL', BASE_OWN_URL: 'STARBASE_OWN_URL', BASE_TZ: 'STARBASE_TZ',
  BASE_CITY: 'STARBASE_CITY', BASE_JURISDICTION: 'STARBASE_JURISDICTION', BASE_PROVINCE: 'STARBASE_PROVINCE',
  BASE_SLATES: 'STARBASE_SLATES', BASE_GEO_BOUNDS: 'STARBASE_GEO_BOUNDS', BASE_CANDIDATES: 'STARBASE_CANDIDATES',
  BASE_OPEN_SIGNUP: 'STARBASE_OPEN_SIGNUP', BASE_DATA: 'STARBASE_DATA', BASE_EMBEDDED_DB: 'STARBASE_EMBEDDED_DB',
  BASE_JOBS: 'STARBASE_JOBS', BASE_JOBS_EVERY_MS: 'STARBASE_JOBS_EVERY_MS', BASE_SAMPLE: 'STARBASE_SAMPLE',
  BASE_SAMPLE_RESET: 'STARBASE_SAMPLE_RESET', BASE_DEMO_EMAIL: 'STARBASE_DEMO_EMAIL', BASE_FRAME_HOSTS: 'STARBASE_FRAME_HOSTS',
  BASE_SITE_DOMAIN: 'STARBASE_SITE_DOMAIN', BASE_SITE_FORMER_URL: 'STARBASE_SITE_FORMER_URL',
  BASE_WEBSITE_URL: 'STARBASE_WEBSITE_URL', BASE_WEBSITE_KEY: 'STARBASE_WEBSITE_KEY', BASE_TWO_STEP_KEY: 'STARBASE_TWO_STEP_KEY',
  BASE_TILE_URL: 'STARBASE_TILE_URL', BASE_TILE_ATTRIBUTION: 'STARBASE_TILE_ATTRIBUTION', BASE_TILE_MAX_ZOOM: 'STARBASE_TILE_MAX_ZOOM',
  BASE_TILE_PROVIDER: 'STARBASE_TILE_PROVIDER', BASE_TILE_KEY: 'STARBASE_TILE_KEY', BASE_TILE_CARTO_KEY: 'STARBASE_TILE_CARTO_KEY',
  BASE_TILE_CLEAN: 'STARBASE_TILE_CLEAN', BASE_MAP_ALL: 'STARBASE_MAP_ALL', BASE_MAP_VIEW: 'STARBASE_MAP_VIEW',
  BASE_MAP_DOTS: 'STARBASE_MAP_DOTS', BASE_TRUSTED_PROXIES: 'STARBASE_TRUSTED_PROXIES', BASE_SECURE_COOKIES: 'STARBASE_SECURE_COOKIES',
  BASE_EMAIL_TIMEOUT_MS: 'STARBASE_EMAIL_TIMEOUT_MS', BASE_LIST_COUNTS_MS: 'STARBASE_LIST_COUNTS_MS', BASE_PTW_CACHE_MS: 'STARBASE_PTW_CACHE_MS',
  BASE_SEND_PER_RUN: 'STARBASE_SEND_PER_RUN', BASE_AB_SEND_PER_RUN: 'STARBASE_AB_SEND_PER_RUN', BASE_SEND_INLINE_MS: 'STARBASE_SEND_INLINE_MS',
  BASE_GOTV_LOCK_MS: 'STARBASE_GOTV_LOCK_MS', BASE_GOTV_PING_MS: 'STARBASE_GOTV_PING_MS', BASE_RECEIPT_DELAY_S: 'STARBASE_RECEIPT_DELAY_S',
  BASE_CLOCK_SHIFT_MS: 'STARBASE_CLOCK_SHIFT_MS', BASE_E2E: 'STARBASE_E2E',
});

// Keys whose old and new values are joined into one list (new first), never one-or-the-other:
// every value sealed under the old key must still open.
export const JOINED = /* @__PURE__ */ Object.freeze(['BASE_TWO_STEP_KEY']);

// Never shown or logged with a value; never something the control centre may read.
export const SECRET = /* @__PURE__ */ Object.freeze(['BASE_TWO_STEP_KEY', 'BASE_WEBSITE_KEY', 'BASE_TILE_KEY', 'BASE_TILE_CARTO_KEY']);

const blank = (v) => v == null || String(v).trim() === '';
const envOf = (env) => env ?? globalThis.process?.env ?? {};
// A joined key's value as a list: commas or spaces between keys, as server/lib/twostep.js reads it.
const listOf = (v) => (blank(v) ? [] : String(v).split(/[\s,]+/).filter(Boolean));
// A key long enough to be used (server/lib/twostep.js KEY_MIN): a shorter one opens nothing.
const usable = (k) => k.length >= 32;

// Any spelling -> the new name (for saved job rows in the control centre).
// A new name stays new; an old name maps to its new one; any other name is unchanged.
export const newNameOf = (name) => {
  if (Object.hasOwn(OLD_SETTINGS, name)) return name;
  for (const now of Object.keys(OLD_SETTINGS)) if (OLD_SETTINGS[now] === name) return now;
  return name;
};

// [new, old] for a name in the table (either spelling), [name] otherwise
// (the control centre asks Render about both).
export const settingNames = (name) => {
  const now = newNameOf(name);
  return Object.hasOwn(OLD_SETTINGS, now) ? [now, OLD_SETTINGS[now]] : [name];
};
// The same list, for scripts and test harnesses that clear a setting: clear both names.
export const bothNames = settingNames;

// A setting's value: the new name, else the old one. Blank counts as unset.
// Joined keys: both values, new first, as one comma list (duplicates dropped).
// When neither has a value, the reader gets what is there (a blank string, or
// undefined), so a `?? fallback` reader behaves as it did before.
// The value comes back exactly as set; nothing is trimmed.
export const setting = (name, env) => {
  const e = envOf(env);
  const now = newNameOf(name);
  if (!Object.hasOwn(OLD_SETTINGS, now)) return e[name];
  const a = e[now];
  const b = e[OLD_SETTINGS[now]];
  if (JOINED.includes(now)) {
    const keys = [...new Set([...listOf(a), ...listOf(b)])];
    if (keys.length) return keys.join(',');
  } else {
    if (!blank(a)) return a;
    if (!blank(b)) return b;
  }
  return a ?? b;
};

// At start-up: copies each old value into its new name where the new one is blank,
// mutating env. A joined key is left as it is under both names (setting() joins
// them on every read), so what the owner put under its new name can still be
// checked later. Never removes or changes an old name. Returns names only, never
// values: { stillOld: ['BASE_TZ', …], differ: ['BASE_TZ', …] }.
// stillOld: every setting whose old name holds a value. differ: both names hold
// different values, so the new one is used; for a joined key, the new name is set
// but lacks a usable key the old name holds, so deleting the old name would lose that key.
export const adoptOldNames = (env) => {
  const e = envOf(env);
  const stillOld = [];
  const differ = [];
  for (const now of Object.keys(OLD_SETTINGS)) {
    const old = OLD_SETTINGS[now];
    if (blank(e[old])) continue;
    stillOld.push(now);
    if (JOINED.includes(now)) {
      if (!blank(e[now]) && !listOf(e[old]).filter(usable).every((k) => listOf(e[now]).includes(k))) differ.push(now);
    } else if (blank(e[now])) e[now] = e[old];
    else if (String(e[now]) !== String(e[old])) differ.push(now);
  }
  return { stillOld, differ };
};

// Saved on phones and in the service worker's caches. Read, carried over, never written.
export const OLD_STORAGE = /* @__PURE__ */ Object.freeze({
  prefix: 'starbase:',                // NS was `starbase:` / `starbase:<client>:`
  rootLock: 'starbase-outbox',        // the root's outbox lock (path clients used `${NS}outbox`)
  tilesMessage: 'starbase:tiles',
  callsChannel: 'starbase.calls.channel:', // a person's Phone/Text choice, kept in localStorage
});

// Built-in database folders: new default -> old default (used only if the old one exists and the new doesn't).
export const OLD_DATA_DIRS = /* @__PURE__ */ Object.freeze({ './data/base-win': './data/starbase', '/data/base-win': '/data/starbase' });

// Answers from a server on the older code during a rollout.
export const OLD_HEALTH_SERVICE = 'starbase';

// Backups already on people's computers (for any future importer).
export const OLD_EXPORT_FORMAT = 'starbase-export';
