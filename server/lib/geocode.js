// Address geocoding. Default provider is the BC Address Geocoder (the BC
// government's free service, built for BC civic addresses); Nominatim (OSM)
// is the other. Plain fetch, no SDKs.
//   GEOCODER=bc (default) | nominatim | off
//   GEOCODER_FALLBACK=bc|nominatim   a second provider asked only for
//                     addresses the first can't place (no match or too vague)
//   BC_GEOCODER_KEY   optional api key for higher BC rate limits
//   BC_GEOCODER_URL   base URL (default the official service; set for a self-hosted mirror)
//   GEOCODE_MIN_SCORE minimum BC match score to accept (default 75)
// Google no longer places pins: its terms let a Google pin be kept 30 days
// only, not shared between users and not drawn on another map, and base.win's
// pins are kept, shared and drawn on the free map. GEOCODER=google places
// with the B.C. service and GEOCODER_FALLBACK=google is ignored (each said
// once in the log, and on Settings → Services). Google's address
// suggestions, when turned on, are lib/places.js.
// Every call has a time limit: placing 8 s, suggesting 4 s.

import { city as defaultCity, province, geoBounds } from './org.js';

const PLACE_MS = 8000;
const SUGGEST_MS = 4000;

// GEOCODER=google or GEOCODER_FALLBACK=google: retired (above). → the words
// Services shows, or null.
export const RETIRED_WORDS = 'GEOCODER=google is no longer used for pins: Google’s terms let its pins be kept 30 days only and not on other maps · the B.C. service places them';
export const retiredGoogle = () => ['GEOCODER', 'GEOCODER_FALLBACK'].filter((k) => String(process.env[k] || '').trim().toLowerCase() === 'google');
let retiredSaid = false;
const sayRetired = () => {
  if (retiredSaid || !retiredGoogle().length) return;
  retiredSaid = true;
  console.warn(`geocoder: ${retiredGoogle().map((k) => `${k}=google`).join(' and ')} is no longer used for pins (Google’s terms) — the B.C. service places them`);
};
const providerOf = () => {
  const p = String(process.env.GEOCODER || 'bc').trim().toLowerCase();
  if (p === 'google') { sayRetired(); return 'bc'; }
  return p;
};

const formatAddress = ({ address, unit, city, postal }) => {
  const street = [unit ? `${unit} -` : null, address].filter(Boolean).join(' ');
  return [street, city || defaultCity(), province(), postal].filter(Boolean).join(', ');
};

const bc = async (q) => {
  const base = (process.env.BC_GEOCODER_URL || 'https://geocoder.api.gov.bc.ca').replace(/\/$/, '');
  const url = new URL(`${base}/addresses.json`);
  url.searchParams.set('addressString', q);
  url.searchParams.set('maxResults', '1');
  url.searchParams.set('outputSRS', '4326');
  url.searchParams.set('locationDescriptor', 'accessPoint');
  const headers = process.env.BC_GEOCODER_KEY ? { apikey: process.env.BC_GEOCODER_KEY } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(PLACE_MS) });
  if (!res.ok) return { error: `geocoder ${res.status}` };
  const body = await res.json();
  const f = body?.features?.[0];
  if (!f) return null;
  const score = Number(f.properties?.score ?? 0);
  const min = Number(process.env.GEOCODE_MIN_SCORE) || 75;
  // Precision CIVIC_NUMBER/BLOCK is a real door; LOCALITY means "somewhere in the city".
  const precise = ['CIVIC_NUMBER', 'BLOCK'].includes(f.properties?.matchPrecision);
  if (score < min || !precise) return { weak: true, score, matched: f.properties?.fullAddress };
  const [lng, lat] = f.geometry.coordinates;
  return { lat, lng, score, matched: f.properties?.fullAddress };
};

const nominatim = async (q) => {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q);
  url.searchParams.set('countrycodes', 'ca');
  url.searchParams.set('limit', '1');
  const res = await fetch(url, { headers: { 'User-Agent': 'base.win campaign app (geocoding voter addresses)' }, signal: AbortSignal.timeout(PLACE_MS) });
  if (!res.ok) return { error: `geocoder ${res.status}` };
  const [hit] = await res.json();
  if (!hit) return null;
  if (!['house', 'building', 'residential'].includes(hit.addresstype) && hit.type !== 'house') {
    return { weak: true, matched: hit.display_name };
  }
  return { lat: Number(hit.lat), lng: Number(hit.lon), score: null, matched: hit.display_name };
};

const PROVIDERS = { bc, nominatim };

const ask = async (name, q) => {
  const fn = PROVIDERS[name] || bc;
  try {
    return await fn(q);
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  }
};

// → { lat, lng, score, matched } | { weak, matched } | { error } | null (no match)
// With GEOCODER_FALLBACK set, an address the first provider can't place (no
// match or too vague) goes to the second; an error from the first is an
// error (the service is down), not a reason to ask elsewhere.
export const geocodeAddress = async (parts) => {
  const provider = providerOf();
  if (provider === 'off') return { error: 'geocoding is turned off (GEOCODER=off)' };
  if (!parts?.address) return null;
  const q = formatAddress(parts);
  const first = await ask(provider, q);
  const fallback = (process.env.GEOCODER_FALLBACK || '').trim().toLowerCase();
  if (fallback === 'google') sayRetired();
  if (!fallback || fallback === provider || !PROVIDERS[fallback]) return first;
  if (first?.error || (first && !first.weak)) return first;
  const second = await ask(fallback, q);
  // A fallback that errors or finds nothing leaves the first answer standing.
  if (second?.error || second === null) return first;
  return second;
};

// ── Suggestions as someone types (ext/addresses) ──
// suggestAddresses('13450 104') → [{ house_number, street, unit, city,
// postal, lat, lng, label }] — up to `limit` doors, each a real civic
// address with its pin (no street-only or city-only matches), in the
// campaign's box where the provider can be told one. → { error } when the
// service can't be reached; [] when nothing matches.
const boxOf = () => {
  const [[s, w], [n, e]] = geoBounds().split('|').map((pt) => pt.split(',').map(Number));
  return { s, w, n, e };
};
const clean = (v) => (v == null ? '' : String(v).trim());

const bcSuggest = async (q, limit) => {
  const base = (process.env.BC_GEOCODER_URL || 'https://geocoder.api.gov.bc.ca').replace(/\/$/, '');
  const url = new URL(`${base}/addresses.json`);
  const box = boxOf();
  url.searchParams.set('addressString', q);
  url.searchParams.set('autoComplete', 'true');
  url.searchParams.set('maxResults', String(limit * 2));
  url.searchParams.set('outputSRS', '4326');
  url.searchParams.set('locationDescriptor', 'accessPoint');
  url.searchParams.set('bbox', `${box.w},${box.s},${box.e},${box.n}`);
  const headers = process.env.BC_GEOCODER_KEY ? { apikey: process.env.BC_GEOCODER_KEY } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(SUGGEST_MS) });
  if (!res.ok) return { error: `geocoder ${res.status}`, status: res.status };
  const body = await res.json();
  return (body?.features || [])
    .filter((f) => f?.properties?.matchPrecision === 'CIVIC_NUMBER' && clean(f.properties.civicNumber))
    .map((f) => {
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      return {
        house_number: `${clean(p.civicNumber)}${clean(p.civicNumberSuffix)}`,
        street: [p.streetName, p.streetType, p.streetDirection].map(clean).filter(Boolean).join(' '),
        unit: clean(p.unitNumber) || null,
        city: clean(p.localityName) || null,
        postal: null,
        lat,
        lng,
        label: clean(p.fullAddress),
      };
    });
};

const nominatimSuggest = async (q, limit) => {
  const box = boxOf();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q);
  url.searchParams.set('countrycodes', 'ca');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('viewbox', `${box.w},${box.n},${box.e},${box.s}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'base.win campaign app (address suggestions)' }, signal: AbortSignal.timeout(SUGGEST_MS) });
  if (!res.ok) return { error: `geocoder ${res.status}` };
  return (await res.json())
    .filter((hit) => hit.address?.house_number && hit.address?.road)
    .map((hit) => ({
      house_number: hit.address.house_number,
      street: hit.address.road,
      unit: null,
      city: hit.address.city || hit.address.town || hit.address.village || null,
      postal: hit.address.postcode || null,
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      label: hit.display_name,
    }));
};

// ── A name for a point (ext/schedule: a place picked on the map) ──
// nearestCorner({ lat, lng }) → { name: 'King George Blvd & 88 Ave' } | null
//     the nearest intersection within 150 m (three roads or more meeting)
// nearestCivic({ lat, lng })  → { name: '8850 King George Blvd', address } | null
//     the nearest civic address within 100 m
// The BC Address Geocoder's /intersections/nearest and /sites/nearest, so
// only in B.C. and never with GEOCODER=off. null when there is none in
// reach — and also when the service is slow (4 s), down, or answers anything
// unexpected: the caller names the place by its next rule, so these never
// throw and never hold a save.
let nearestMs = 4000;
export const _setNearestMsForTest = (ms) => { nearestMs = ms || 4000; };
const bcNearest = async (path, { lat, lng }, params) => {
  if ((process.env.GEOCODER || 'bc').toLowerCase() === 'off' || province() !== 'BC') return null;
  try {
    const base = (process.env.BC_GEOCODER_URL || 'https://geocoder.api.gov.bc.ca').replace(/\/$/, '');
    const url = new URL(`${base}/${path}`);
    url.searchParams.set('point', `${lng},${lat}`);
    url.searchParams.set('outputSRS', '4326');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const headers = process.env.BC_GEOCODER_KEY ? { apikey: process.env.BC_GEOCODER_KEY } : {};
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(nearestMs) });
    if (!res.ok) return null;
    const body = await res.json();
    // One feature, or a list of them: the first.
    const f = body?.type === 'Feature' ? body : body?.features?.[0];
    return f?.properties && typeof f.properties === 'object' ? f.properties : null;
  } catch {
    return null;
  }
};
const beforeComma = (v) => clean(v).split(',')[0].trim();

export const nearestCorner = async (point) => {
  const p = await bcNearest('intersections/nearest.json', point, { maxDistance: 150, minDegree: 3 });
  // "King George Blvd and 88 Ave" → "King George Blvd & 88 Ave"; anything
  // that isn't two roads is not a corner's name.
  const roads = (clean(p?.intersectionName) || beforeComma(p?.fullAddress)).split(/\s+(?:and|&)\s+/i).map(clean).filter(Boolean);
  const name = roads.join(' & ');
  return roads.length >= 2 && name.length <= 200 ? { name } : null;
};

export const nearestCivic = async (point) => {
  const p = await bcNearest('sites/nearest.json', point, { maxDistance: 100, excludeUnits: true, onlyCivic: true });
  if (!p) return null;
  const number = `${clean(p.civicNumber)}${clean(p.civicNumberSuffix)}`;
  const street = [p.streetName, p.streetType, p.streetDirection].map(clean).filter(Boolean).join(' ');
  const line = number && street ? `${number} ${street}` : beforeComma(p.fullAddress);
  // A door has a number in front; "Surrey, BC" is not one.
  return /^\d/.test(line) && line.length <= 200 ? { name: line, address: clean(p.fullAddress) || line } : null;
};

const SUGGESTERS = { bc: bcSuggest, nominatim: nominatimSuggest };

// provider: who to ask (ADDRESS_SUGGEST=bc|nominatim, lib/places.js);
// GEOCODER's by default.
export const suggestAddresses = async (q, { limit = 5, provider: asked = null } = {}) => {
  const provider = asked || providerOf();
  if (provider === 'off') return { error: 'geocoding is turned off (GEOCODER=off)' };
  const fn = SUGGESTERS[provider] || bcSuggest;
  try {
    const out = await fn(String(q).trim(), limit);
    return Array.isArray(out) ? out.slice(0, limit) : out;
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  }
};

// ── One live check (Settings → Services; the Map check) ──
// Asks for "100" as someone typing would. → { ok, provider, code, plain,
// said, fix, example }: the B.C. service's (or Nominatim's) state in plain
// words. Cached 30 s per server, so repeated
// Checks spend one call at most every 30 s.
const LOOKUP_MS = 8000;
let looked = null; // { at, result } | { at, pending }
const lookupOnce = async () => {
  const provider = providerOf();
  if (provider === 'off') return { ok: false, provider, code: 'off', plain: 'Turned off (GEOCODER=off)', said: '', fix: null };
  let timer;
  const r = await Promise.race([
    suggestAddresses('100', { limit: 3 }),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'no answer in 8 s', slow: true }), LOOKUP_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (Array.isArray(r)) return { ok: true, provider, code: null, plain: 'Answering', said: '', fix: null, example: r[0]?.label || null };
  if (r.trouble) return { ok: false, provider, code: r.trouble.code, plain: r.trouble.plain, said: r.trouble.said, fix: r.trouble.step };
  if (provider === 'bc' || !SUGGESTERS[provider]) {
    const plain = r.status === 429 ? 'The B.C. address service is busy. It tries again by itself; a BC_GEOCODER_KEY raises the limit.'
      : !r.status || r.status >= 500 ? 'The B.C. address service isn’t answering.'
        : `The B.C. address service refused (${r.status}).`;
    return { ok: false, provider, code: r.status === 429 ? 'busy' : 'no-answer', plain, said: '', fix: null };
  }
  return { ok: false, provider, code: 'no-answer', plain: `The address service didn’t answer: ${r.error}`, said: '', fix: null };
};
export const probeLookup = async () => {
  if (looked && Date.now() - looked.at < 30_000) return looked.result ?? looked.pending;
  const pending = lookupOnce();
  looked = { at: Date.now(), pending };
  const result = await pending;
  if (looked?.pending === pending) looked = { at: looked.at, result };
  return result;
};
export const _resetLookupForTest = () => { looked = null; retiredSaid = false; };
