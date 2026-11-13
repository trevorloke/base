// Google's address suggestions (Places API (New): Autocomplete and Place
// Details), through this server, only when the owner turns them on.
//
//   ADDRESS_SUGGEST   unset (default) | google | bc | nominatim | off
//     unset      today's behaviour: the suggester GEOCODER names (B.C. by
//                default); Google is never asked, with or without a key
//     google     Google Places, while a key is set, Google's logo file is in
//                the build, Places isn't paused after a refusal and today's
//                ceilings aren't reached (lib/gusage.js); otherwise the
//                suggester GEOCODER names
//     bc, nominatim  that service, never Google;  off  no outside service
//   GOOGLE_PLACES_URL  a stand-in for Google (tests, local checks) — not for use.
//
// Why off by default: a person picks Google's words and saves them as the
// record (kept, shared, in the event log). Whether Google's terms allow that
// is for counsel or Google to confirm in writing first (GOING-LIVE §5).
// Pins never come from Google: a pick's words are placed by the B.C.
// service (ext/addresses /address/place), and `location` is never asked for.
//
// placesSuggest(q, { session, limit, signal, user }) → [{ place_id, label,
//   sub, source: 'google' }] | { error, trouble? }
// placeDetails(id, { session, user }) → { address, house_number, street,
//   unit, city, postal, label } | { error, trouble? }
// probePlaces() → { ok, code, plain, said, fix, example } (Services' Check)
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { googleKey } from './gtiles.js';
import { googleTrouble, scrub } from './googleerr.js';
import { geoBox } from './org.js';
import { civic } from './address.js';
import { count, placesLeft, personLeft } from './gusage.js';

const api = () => String(process.env.GOOGLE_PLACES_URL || 'https://places.googleapis.com/v1').trim().replace(/\/$/, '');
const AUTOCOMPLETE_MS = 3000;
const DETAILS_MS = 2500;
const PROBE_MS = 8000;

export const SESSION_WORDS = 'That address box needs to start again — type the address once more';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isSession = (v) => UUID.test(String(v || ''));
export const isPlaceId = (v) => /^[A-Za-z0-9_-]{1,300}$/.test(String(v || ''));

// ── The setting ──
const SUGGESTERS = ['google', 'bc', 'nominatim', 'off'];
const warned = new Set();
// → 'google' | 'bc' | 'nominatim' | 'off': who suggests addresses.
export const addressSuggester = (env = process.env) => {
  const v = String(env.ADDRESS_SUGGEST ?? '').trim().toLowerCase();
  if (SUGGESTERS.includes(v)) return v;
  if (v && !warned.has(v)) { warned.add(v); console.warn(`address suggestions: ADDRESS_SUGGEST=${v.slice(0, 40)} isn’t known — use google, bc, nominatim or off`); }
  const geo = String(env.GEOCODER || 'bc').trim().toLowerCase();
  return geo === 'off' ? 'off' : geo === 'nominatim' ? 'nominatim' : 'bc';
};

// ── Google's logo: no Google rows without it (its display rules) ──
const LOGO = new URL('../../web/dist/google/google-maps-logo.svg', import.meta.url);
let logo = existsSync(LOGO);
export const placesLogo = () => logo;
export const _setPlacesLogoForTest = (v) => { logo = v == null ? existsSync(LOGO) : Boolean(v); };

// ── Refusals: plain words, and no hammering ──
// A key, API or billing refusal: no Places call for 10 minutes (Places may
// simply not be turned on while tiles are; asking again for every typist
// helps nobody). Quota, or one we can't place: 60 s.
let trouble = null;
let lastTrouble = null;
let lastOkAt = null;
const LONG = ['key-invalid', 'referrer', 'ip', 'api-blocked', 'api-off', 'billing'];
const pauseMs = (code) => (LONG.includes(code) ? 600_000 : 60_000);
const pausedFor = () => (trouble && Date.now() < trouble.until ? trouble.until - Date.now() : 0);
export const placesPaused = () => pausedFor() > 0;
const refused = (status, said) => {
  const t = googleTrouble(status, said);
  const at = Date.now();
  const already = pausedFor() > 0;
  trouble = { at, until: at + pauseMs(t.code), status, ...t };
  lastTrouble = trouble;
  if (!already) console.warn(`address suggestions: Google refused (${status} ${t.code}) — no calls to Google Places for ${pauseMs(t.code) / 1000} s`);
  return { error: `places ${t.code}: ${t.plain}`, trouble: t };
};
const ok = () => { trouble = null; lastOkAt = Date.now(); };
export const placesHealth = () => ({
  last: lastTrouble ? { ...lastTrouble } : null,
  lastOkAt,
  paused: pausedFor() > 0 ? { until: new Date(trouble.until).toISOString(), code: trouble.code, plain: trouble.plain, said: trouble.said, step: trouble.step } : null,
});

// Whether a person's box gets Google's rows now: turned on, a key, the
// logo, no pause, and today's ceilings not reached. → true | the reason not.
export const placesFor = (user) => {
  if (addressSuggester() !== 'google') return 'off';
  if (!googleKey()) return 'no-key';
  if (!placesLogo()) return 'no-logo';
  if (placesPaused()) return 'paused';
  if (!placesLeft()) return 'ceiling';
  if (!personLeft(user)) return 'share';
  return true;
};

const headers = (extra = {}) => ({ 'X-Goog-Api-Key': googleKey(), ...extra });
const failed = (e, what) => {
  const slow = e?.name === 'TimeoutError' || e?.name === 'AbortError';
  return { error: slow ? `places: no answer in ${what}` : `places: ${scrub(String(e?.message || e)).slice(0, 160)}`, slow };
};

// ── Autocomplete ──
const box = () => {
  const [s, w, n, e] = geoBox();
  return { low: { latitude: s, longitude: w }, high: { latitude: n, longitude: e } };
};
const STREET_TYPES = ['street_address', 'premise', 'subpremise'];
const autocomplete = (q, session, signal) => fetch(`${api()}/places:autocomplete`, {
  method: 'POST',
  headers: headers({ 'Content-Type': 'application/json' }),
  body: JSON.stringify({
    input: q,
    sessionToken: session,
    includedRegionCodes: ['ca'],
    languageCode: 'en-CA',
    regionCode: 'ca',
    locationRestriction: { rectangle: box() },
  }),
  signal,
});
// A door: a street address, a building or a unit — or words that start with
// a number (Google doesn't always type a house), unless Google says it is a
// street or an area ("104 Ave" starts with a number in Surrey, and is no door).
const NOT_DOORS = ['route', 'intersection', 'locality', 'sublocality', 'neighborhood', 'postal_code', 'administrative_area_level_1', 'administrative_area_level_2', 'country'];
const isDoor = (p) => {
  const types = p.types || [];
  if (types.some((t) => STREET_TYPES.includes(t))) return true;
  if (types.some((t) => NOT_DOORS.includes(t))) return false;
  return /^\d/.test(String(p.structuredFormat?.mainText?.text || '').trim());
};
const rowsOf = (body, limit) => (body?.suggestions || [])
  .map((s) => s?.placePrediction)
  .filter((p) => p?.placeId && isDoor(p))
  .slice(0, limit)
  .map((p) => ({
    place_id: p.placeId,
    label: String(p.structuredFormat?.mainText?.text || p.text?.text || '').trim().slice(0, 200),
    sub: String(p.structuredFormat?.secondaryText?.text || '').trim().slice(0, 200),
    source: 'google',
  }));

export const placesSuggest = async (q, { session, limit = 5, signal, user = null } = {}) => {
  if (!isSession(session)) return { error: SESSION_WORDS, status: 400 };
  if (pausedFor()) return { error: 'places: paused', paused: true };
  count('autocomplete', 1, user);
  try {
    const res = await autocomplete(String(q).trim().slice(0, 200), session, signal || AbortSignal.timeout(AUTOCOMPLETE_MS));
    if (!res.ok) return refused(res.status, await res.text().catch(() => ''));
    const body = await res.json();
    ok();
    return rowsOf(body, limit);
  } catch (e) {
    return failed(e, '3 s');
  }
};

// ── Place Details: the words of one pick (this ends Google's session) ──
// Only the address: never `location` (a Google pin may not go on another
// map, nor into turfs).
const part = (comps, type, short = false) => {
  const c = (comps || []).find((x) => (x?.types || []).includes(type));
  return String((short ? c?.shortText : c?.longText) || c?.longText || '').trim();
};
export const placeDetails = async (id, { session, user = null, signal } = {}) => {
  if (!isSession(session) || !isPlaceId(id)) return { error: SESSION_WORDS, status: 400 };
  if (pausedFor()) return { error: 'places: paused', paused: true };
  count('details', 1, user);
  try {
    const q = new URLSearchParams({ sessionToken: session, languageCode: 'en-CA', regionCode: 'ca' });
    const res = await fetch(`${api()}/places/${encodeURIComponent(id)}?${q}`, {
      headers: headers({ 'X-Goog-FieldMask': 'addressComponents,formattedAddress' }),
      signal: signal || AbortSignal.timeout(DETAILS_MS),
    });
    if (!res.ok) return refused(res.status, await res.text().catch(() => ''));
    const body = await res.json();
    ok();
    const comps = body?.addressComponents;
    const number = part(comps, 'street_number');
    const route = part(comps, 'route', true);
    const { house_number, address } = civic({ house_number: number, address: route });
    return {
      address: address || null,
      house_number: house_number || null,
      street: route || null,
      unit: part(comps, 'subpremise') || null,
      city: part(comps, 'locality') || null,
      postal: part(comps, 'postal_code') || null,
      label: String(body?.formattedAddress || '').trim().slice(0, 300) || null,
    };
  } catch (e) {
    return failed(e, '2.5 s');
  }
};

// ── One live check (Settings → Services; the Map check) ──
// One autocomplete for "100" with a fresh session, ignoring the pause, in
// 8 s at most; a good answer lifts the pause. Counted under `probe`, never
// against the campaign's ceiling or anyone's share. Cached 30 s per server.
// Runs whenever a key is set, even with suggestions off, so the owner can
// test the key before turning Google's rows on.
let probed = null;
const probeOnce = async () => {
  if (!googleKey()) return { ok: false, code: 'no-key', plain: 'GOOGLE_MAPS_SERVER_KEY isn’t set.', said: '', fix: 'Recipe B step 6' };
  count('probe');
  try {
    const res = await autocomplete('100', randomUUID(), AbortSignal.timeout(PROBE_MS));
    if (!res.ok) {
      const t = googleTrouble(res.status, await res.text().catch(() => ''));
      return { ok: false, code: t.code, plain: t.plain, said: t.said, fix: t.step };
    }
    const rows = rowsOf(await res.json(), 3);
    ok();
    return { ok: true, code: null, plain: 'Google Places answering', said: '', fix: null, example: rows[0]?.label || null };
  } catch (e) {
    const slow = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, code: slow ? 'timeout' : 'no-answer', plain: slow ? 'Google didn’t answer in 8 s.' : 'Google couldn’t be reached from this server.', said: '', fix: null };
  }
};
export const probePlaces = async () => {
  if (probed && Date.now() - probed.at < 30_000) return probed.result ?? probed.pending;
  const pending = probeOnce();
  probed = { at: Date.now(), pending };
  const result = await pending;
  if (probed?.pending === pending) probed = { at: probed.at, result };
  return result;
};

// Tests: forget the pause and the probe.
export const _resetPlacesForTest = () => { trouble = null; lastTrouble = null; lastOkAt = null; probed = null; warned.clear(); };
