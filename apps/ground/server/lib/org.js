// What this Base Ground runs for: one organization per deployment. Each
// client gets its own services and database; the campaign's name, rules
// and place come from the environment, never from code:
//
//   BASE_ORG_NAME      the campaign ("Imagine Surrey"). Unset: the first
//                          sign-up names it.
//   BASE_JURISDICTION  bc-municipal (default) | bc-provincial | federal —
//                          which contribution-limit rules apply
//   BASE_TZ            the campaign's time zone (default America/Vancouver)
//   BASE_CITY          the city addresses default to (default Surrey)
//   BASE_PROVINCE      two letters, for geocoding (default BC)
//   BASE_GEO_BOUNDS    "lat,lng|lat,lng", the box geocoding is biased to
//   BASE_SLATES        "code:Label,code:Label" — the slates a gift can go
//                          to, each its own annual limit (shared/canvass.js)
//   BASE_CANDIDATES    "4D:McCallum:Opposed — Doug McCallum supporter;…"
//                          — the opposed candidates a new rating scale starts
//                          with (shared/scale.js); the desk edits them after
//   BASE_ENV           production | staging — said on screen and at
//                          /api/health, so nobody mistakes one for the other
//
// The first sign-up sets up the one workspace; everyone after joins by
// invite. (Workspaces are still scoped by id underneath — tests and dev can
// open sign-up again with BASE_OPEN_SIGNUP=1.)
import { SLATES } from '@base-ground/shared/canvass';

const str = (k) => String(process.env[k] || '').trim();

export const JURISDICTIONS = ['bc-municipal', 'bc-provincial', 'federal'];
export const orgName = () => str('BASE_ORG_NAME') || null;
export const jurisdiction = () => (JURISDICTIONS.includes(str('BASE_JURISDICTION')) ? str('BASE_JURISDICTION') : 'bc-municipal');
export const DEFAULT_TZ = 'America/Vancouver';
export const timeZone = () => {
  const tz = str('BASE_TZ') || DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
};
export const city = () => str('BASE_CITY') || 'Surrey';
export const province = () => (str('BASE_PROVINCE') || 'BC').toUpperCase().slice(0, 2);
export const geoBounds = () => (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?\|-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(str('BASE_GEO_BOUNDS'))
  ? str('BASE_GEO_BOUNDS') : '49.002,-122.92|49.222,-122.67');
export const envName = () => (['production', 'staging'].includes(str('BASE_ENV')) ? str('BASE_ENV')
  : process.env.NODE_ENV === 'production' ? 'production' : 'local');

// Sign-up past first run: only when this is set (tests, local dev).
export const openSignupForced = () => process.env.BASE_OPEN_SIGNUP === '1';

export const setupClosedMessage = () => `Base Ground is already set up for ${orgName() || 'this campaign'} — ask a manager to invite you.`;

// What the app is told about this deployment (GET /api/auth/setup and /me).
export const orgOut = () => ({
  name: orgName(), jurisdiction: jurisdiction(), tz: timeZone(), city: city(), province: province(),
  slates: SLATES, env: envName(),
});
