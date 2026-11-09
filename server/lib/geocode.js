// Address geocoding. Default provider is the BC Address Geocoder (the BC
// government's free service, built for BC civic addresses). Google's
// Geocoding API and Nominatim (OSM) are the others. Plain fetch, no SDKs.
//   GEOCODER=bc (default) | google | nominatim | off
//   GEOCODER_FALLBACK=google|bc|nominatim   a second provider asked only for
//                     addresses the first can't place (no match or too vague)
//   BC_GEOCODER_KEY   optional api key for higher BC rate limits
//   BC_GEOCODER_URL   base URL (default the official service; set for a self-hosted mirror)
//   GEOCODE_MIN_SCORE minimum BC match score to accept (default 75)
//   GOOGLE_MAPS_SERVER_KEY  a Google Cloud key with the Geocoding API enabled
//                     (restrict it to that API and the server's IP — not the
//                     browser key). Lookups are biased to the campaign's box and only a
//                     rooftop or street-number match counts as a door.

import { city as defaultCity, province, geoBounds } from './org.js';

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
  const res = await fetch(url, { headers });
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

// Results are biased to the campaign's box (STARBASE_GEO_BOUNDS) and limited
// to Canada and the province.
const google = async (q) => {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) return { error: 'GOOGLE_MAPS_SERVER_KEY is not set' };
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', q);
  url.searchParams.set('region', 'ca');
  url.searchParams.set('components', `country:CA|administrative_area:${province()}`);
  url.searchParams.set('bounds', geoBounds());
  url.searchParams.set('key', key);
  const res = await fetch(url);
  if (!res.ok) return { error: `geocoder ${res.status}` };
  const body = await res.json();
  if (body.status === 'ZERO_RESULTS') return null;
  // OVER_QUERY_LIMIT reads as "busy" to the background run, which then backs off.
  if (body.status === 'OVER_QUERY_LIMIT') return { error: 'geocoder 429 too many requests (Google quota)' };
  if (body.status !== 'OK') return { error: `geocoder ${body.status}${body.error_message ? `: ${String(body.error_message).slice(0, 120)}` : ''}` };
  const hit = body.results?.[0];
  if (!hit) return null;
  const loc = hit.geometry?.location;
  const precise = ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(hit.geometry?.location_type)
    && (hit.types || []).some((t) => ['street_address', 'premise', 'subpremise'].includes(t));
  if (!loc || !precise) return { weak: true, score: null, matched: hit.formatted_address };
  return { lat: loc.lat, lng: loc.lng, score: null, matched: hit.formatted_address };
};

const nominatim = async (q) => {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q);
  url.searchParams.set('countrycodes', 'ca');
  url.searchParams.set('limit', '1');
  const res = await fetch(url, { headers: { 'User-Agent': 'base.win campaign app (geocoding voter addresses)' } });
  if (!res.ok) return { error: `geocoder ${res.status}` };
  const [hit] = await res.json();
  if (!hit) return null;
  if (!['house', 'building', 'residential'].includes(hit.addresstype) && hit.type !== 'house') {
    return { weak: true, matched: hit.display_name };
  }
  return { lat: Number(hit.lat), lng: Number(hit.lon), score: null, matched: hit.display_name };
};

const PROVIDERS = { bc, google, nominatim };

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
  const provider = (process.env.GEOCODER || 'bc').toLowerCase();
  if (provider === 'off') return { error: 'geocoding is turned off (GEOCODER=off)' };
  if (!parts?.address) return null;
  const q = formatAddress(parts);
  const first = await ask(provider, q);
  const fallback = (process.env.GEOCODER_FALLBACK || '').toLowerCase();
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
  const res = await fetch(url, { headers });
  if (!res.ok) return { error: `geocoder ${res.status}` };
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

const googleSuggest = async (q) => {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) return { error: 'GOOGLE_MAPS_SERVER_KEY is not set' };
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', q);
  url.searchParams.set('region', 'ca');
  url.searchParams.set('components', `country:CA|administrative_area:${province()}`);
  url.searchParams.set('bounds', geoBounds());
  url.searchParams.set('key', key);
  const res = await fetch(url);
  if (!res.ok) return { error: `geocoder ${res.status}` };
  const body = await res.json();
  if (body.status === 'ZERO_RESULTS') return [];
  if (body.status !== 'OK') return { error: `geocoder ${body.status}` };
  const part = (hit, type) => hit.address_components?.find((c) => c.types?.includes(type))?.long_name || '';
  return (body.results || [])
    .filter((hit) => (hit.types || []).some((t) => ['street_address', 'premise', 'subpremise'].includes(t)) && part(hit, 'street_number'))
    .map((hit) => ({
      house_number: part(hit, 'street_number'),
      street: part(hit, 'route'),
      unit: part(hit, 'subpremise') || null,
      city: part(hit, 'locality') || null,
      postal: part(hit, 'postal_code') || null,
      lat: hit.geometry.location.lat,
      lng: hit.geometry.location.lng,
      label: hit.formatted_address,
    }));
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
  const res = await fetch(url, { headers: { 'User-Agent': 'base.win campaign app (address suggestions)' } });
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

const SUGGESTERS = { bc: bcSuggest, google: googleSuggest, nominatim: nominatimSuggest };

export const suggestAddresses = async (q, { limit = 5 } = {}) => {
  const provider = (process.env.GEOCODER || 'bc').toLowerCase();
  if (provider === 'off') return { error: 'geocoding is turned off (GEOCODER=off)' };
  const fn = SUGGESTERS[provider] || bcSuggest;
  try {
    const out = await fn(String(q).trim(), limit);
    return Array.isArray(out) ? out.slice(0, limit) : out;
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  }
};
