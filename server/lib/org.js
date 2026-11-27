// What this base.win runs for: one organization per deployment. Each
// client gets its own services and database; the campaign's name, rules
// and place come from the environment, never from code:
//
//   STARBASE_ORG_NAME      the campaign ("Imagine Surrey"). Unset: the first
//                          sign-up names it. Once it's set up, screens say
//                          the campaign's own name, which a manager can
//                          change (Settings → Campaign; routes/auth.js)
//   STARBASE_JURISDICTION  bc-municipal (default) | bc-provincial | federal —
//                          which contribution-limit rules apply
//   STARBASE_TZ            the campaign's time zone (default America/Vancouver)
//   STARBASE_CITY          the city addresses default to. Unset: none
//   STARBASE_PROVINCE      two letters, for geocoding (default BC)
//   STARBASE_GEO_BOUNDS    "lat,lng|lat,lng", the campaign's map area: where
//                          maps open and what address lookups lean to.
//                          Unset: no area — maps open wide, lookups lean nowhere
//   STARBASE_SLATES        "code:Label,code:Label" — the slates a gift can go
//                          to, each its own annual limit (shared/canvass.js)
//   STARBASE_CANDIDATES    "4A:Hartwell:Opposed — Hartwell supporter;…"
//                          — the opposed candidates a new rating scale starts
//                          with (shared/scale.js); the desk edits them after.
//                          "none" or unset: nobody
//   STARBASE_ENV           production | staging — said on screen and at
//                          /api/health, so nobody mistakes one for the other
//   STARBASE_BRAND         base, or a preset's name — what the campaign
//                          starts from (lib/preset.js). Unset: base
// Where a setting above says "unset: none", a server with a preset
// (lib/preset.js) has the preset's own city, map area and starting list.
//
// The first sign-up sets up the one workspace; everyone after joins by
// invite. (Workspaces are still scoped by id underneath — tests and dev can
// open sign-up again with STARBASE_OPEN_SIGNUP=1.)
import { SLATES } from '@starbase/shared/canvass';
import { preset, brandHas } from './preset.js';

const str = (k) => String(process.env[k] || '').trim();

export const JURISDICTIONS = ['bc-municipal', 'bc-provincial', 'federal'];
export const orgName = () => str('STARBASE_ORG_NAME') || null;
export const jurisdiction = () => (JURISDICTIONS.includes(str('STARBASE_JURISDICTION')) ? str('STARBASE_JURISDICTION') : 'bc-municipal');
export const DEFAULT_TZ = 'America/Vancouver';
export const timeZone = () => {
  const tz = str('STARBASE_TZ') || DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
};
// "3:40 pm" on the campaign's clock (not the server's or the device's): the
// one way a Google pause's end time is said (ext/google, gmail, drive).
export const clockAt = (t) => new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: timeZone() })
  .replace(/\./g, '').replace(/\s+/g, ' ');
// '' when no city is set (and the server's preset names none).
export const city = () => str('STARBASE_CITY') || preset().org.city;
export const province = () => (str('STARBASE_PROVINCE') || 'BC').toUpperCase().slice(0, 2);
// The map area as typed in STARBASE_GEO_BOUNDS, or null when it is unset or
// can't be read.
export const geoBounds = () => (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?\|-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(str('STARBASE_GEO_BOUNDS'))
  ? str('STARBASE_GEO_BOUNDS') : null);
// The campaign's own area as numbers, [south, west, north, east], whichever
// corner was typed first (where the map opens; its check): the typed one,
// else the preset's, else null — a campaign with no area. Every caller
// takes null.
export const geoBox = () => {
  const typed = geoBounds();
  if (!typed) return preset().org.box ? [...preset().org.box] : null;
  const [a, b] = typed.split('|').map((pt) => pt.split(',').map(Number));
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
};
// Where the app's maps open: { centre: [lat, lng], zoom, bounds: [[south,
// west], [north, east]] } — worked out from a typed area, else the preset's
// own, else null (the app opens wide and asks for the area to be set).
export const mapHome = () => {
  if (geoBounds()) {
    const [s, w, n, e] = geoBox();
    const mid = (a, b) => Number(((a + b) / 2).toFixed(5));
    return { centre: [mid(s, n), mid(w, e)], zoom: 12, bounds: [[s, w], [n, e]] };
  }
  return preset().map || null;
};
// The name is read exactly ("production" or "staging"; spaces around it are
// dropped). Unset or misspelled, a hosted server is production — NODE_ENV is
// production (the Dockerfile sets it), or it runs on Render (RENDER is set on
// every service there) — so staging's powers (the demo sign-in, the sample
// campaign and its reset) stay off. Only a developer's machine is "local".
export const envName = (env = process.env) => {
  const named = String(env.STARBASE_ENV || '').trim();
  if (named === 'production' || named === 'staging') return named;
  return env.NODE_ENV === 'production' || env.RENDER ? 'production' : 'local';
};

// Sign-up past first run: only when this is set (tests, local dev).
export const openSignupForced = () => process.env.STARBASE_OPEN_SIGNUP === '1';

// Sign-up once the campaign is set up: name is the campaign's own, as it is
// called now (routes/auth.js reads it), not necessarily STARBASE_ORG_NAME.
export const setupClosedMessage = (name) => `base.win is already set up for ${name || orgName() || 'this campaign'} — ask a manager to invite you.`;

// What the app is told about this deployment (GET /api/auth/setup and /me).
// features: what this server's preset brings (the membership form, the
// sample data) — none for most campaigns. map: where maps open, or null.
const FEATURES = ['membership', 'sample'];
export const orgOut = () => ({
  name: orgName(), jurisdiction: jurisdiction(), tz: timeZone(), city: city(), province: province(),
  slates: SLATES, env: envName(), features: FEATURES.filter((f) => brandHas(f)), map: mapHome(),
});
