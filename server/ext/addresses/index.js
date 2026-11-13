// Addresses that find their own place on the map.
//
//   GET /api/address/suggest?q=13450 104   any role. Up to 5 doors as
//       someone types: the campaign's own doors that match first (they are on
//       the map already, and need no outside service), then the geocoder's
//       (lib/geocode.js suggestAddresses). → { suggestions: [{ house_number,
//       street, address, unit, city, postal, lat, lng, label, source }],
//       lookup: 'ok' | 'unavailable' | 'off', by }. source 'map' is a door on
//       file; 'lookup' is the address service's; 'google' is Google's (only
//       with ADDRESS_SUGGEST=google, lib/places.js): { place_id, label, sub }
//       with no address parts and no pin. by: who gave the outside rows
//       ('google' | 'bc' | 'nominatim' | null) — never Google's and another's
//       in one answer, so Google's logo speaks for all of them or none.
//       &session=<uuid> (the box's, for Google) and &nogoogle=1 (rows that
//       carry a pin). Google and the B.C. service are asked at the same time,
//       within one 4 s budget; B.C.'s rows when Google errs, pauses, or
//       offers no door.
//
//   GET /api/address/place?id=<place_id>&session=<uuid>   any role. A
//       Google pick in words (Place Details, which ends Google's session),
//       placed by the B.C. service with what is left of 4 s → { address,
//       house_number, street, unit, city, postal, label, lat, lng, placed,
//       source: 'google' } — lat null when B.C. couldn't place it in time.
//       502 only when Google refused, didn't answer, or is paused. Writes
//       nothing: the words go into the form, saved as today.
//
//   Saved with an address and no pin (person.create, person.update, an
//   address changed by hand): the person is looked up once, just after the
//   save — a pin copied from someone already on the map at that address, or
//   the geocoder's — and placed (action person.geocode, on the event log
//   like every pin). An address it can't place is marked as the background
//   run marks it (nomatch / weak), for a pin by hand; an outage leaves the
//   person waiting for the desk's run. A changed address also clears the
//   old lookup's mark, so a fixed address is looked up again.
//     GEOCODE_ON_SAVE=off   no lookup on save (the tests' default; the
//                           desk's background run still places them).
//   A write of more than five people with addresses (an import) is left
//   to the background run.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { runAction } from '../../lib/events.js';
import { geocodeAddress, suggestAddresses } from '../../lib/geocode.js';
import { civic } from '../../lib/address.js';
import { makeLimiter } from '../../lib/guard.js';
import { addressSuggester, placesFor, placesSuggest, placeDetails, isSession, isPlaceId, SESSION_WORDS } from '../../lib/places.js';

export { sql } from './sql.js';

const LIMIT = 5;
const LOOKUP_MS = 4000;
const HAND_SIZED = 5;
// What reaches the address service from here: lookups after a save, 60 a
// minute for the whole server; suggestions, 60 a minute per person typing.
const LOOKUPS_PER_MIN = 60;
const lookups = makeLimiter({ windowMs: 60_000, max: LOOKUPS_PER_MIN });
const lookupsBusy = (k) => lookups(k);
const typing = makeLimiter({ windowMs: 60_000, max: 60 });
const ADDRESS_KEYS = ['address', 'house_number', 'unit', 'city', 'postal'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const keyOf = (s) => `${norm(s.address)}|${norm(s.unit)}`;
const within = (p, ms) => {
  let timer;
  return Promise.race([p, new Promise((r) => { timer = setTimeout(() => r({ error: 'timeout' }), Math.max(0, ms)); })]).finally(() => clearTimeout(timer));
};
const lookupOff = () => (process.env.GEOCODER || '').toLowerCase() === 'off';
// Who GEOCODER names for suggestions and pins (google is retired: B.C.).
const geoSuggester = () => ((process.env.GEOCODER || 'bc').trim().toLowerCase() === 'nominatim' ? 'nominatim' : 'bc');
const PLACE_WORDS = 'Couldn’t get that address — type it in full';
const PLACE_MS = 4000;
const PIN_MIN_MS = 1500;

export const api = new Hono();

api.get('/address/suggest', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const q = String(c.req.query('q') || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (q.length < 3) return c.json({ suggestions: [], lookup: 'ok' });
  const like = `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const mine = (await db.query(
    `select distinct on (lower(address), lower(coalesce(unit, ''))) address, house_number, unit, city, postal, lat, lng
       from persons where workspace_id = $1 and deleted_at is null and lat is not null and address is not null
        and lower(address) like $2
      order by lower(address), lower(coalesce(unit, '')), created_at limit $3`,
    [ctx.workspaceId, like, LIMIT],
  )).rows.map((r) => {
    const { house_number, address } = civic({ house_number: r.house_number, address: r.address });
    const street = house_number && address.startsWith(house_number) ? address.slice(house_number.length).trim() : address;
    return {
      house_number: house_number || null, street, address, unit: r.unit || null, city: r.city || null, postal: r.postal || null,
      lat: Number(r.lat), lng: Number(r.lng),
      label: [r.unit ? `${r.unit} – ${address}` : address, r.city].filter(Boolean).join(', '),
      source: 'map',
    };
  });
  let lookup = 'ok';
  let found = [];
  let by = null;
  const suggester = addressSuggester();
  const google = suggester === 'google';
  // GEOCODER=off: no outside lookups, unless Google's were turned on by name.
  if ((lookupOff() && !google) || suggester === 'off') lookup = 'off';
  else if (typing(ctx.user.id)) lookup = 'unavailable'; // the doors on file still come
  else if (mine.length < LIMIT) {
    const session = c.req.query('session');
    const askGoogle = google && isSession(session) && c.req.query('nogoogle') !== '1' && placesFor(ctx.user.id) === true;
    // Who else is asked (never Google): ADDRESS_SUGGEST=bc|nominatim, else
    // GEOCODER's; nobody with GEOCODER=off.
    const other = lookupOff() ? null : google ? geoSuggester() : suggester;
    const end = Date.now() + LOOKUP_MS;
    // Both at once (B.C. as often as before: whenever fewer than 5 doors).
    const fromOther = other ? suggestAddresses(q, { limit: LIMIT, provider: other }) : null;
    let googleAnswered = false;
    if (askGoogle) {
      const g = await within(placesSuggest(q, { session, limit: LIMIT, user: ctx.user.id }), end - Date.now());
      googleAnswered = Array.isArray(g);
      if (googleAnswered && g.length) { found = g; by = 'google'; }
    }
    if (!by && fromOther) {
      const r = await within(fromOther, end - Date.now());
      if (Array.isArray(r)) { found = r; by = other; } else lookup = 'unavailable';
    } else if (!by) lookup = googleAnswered ? 'ok' : askGoogle ? 'unavailable' : 'off';
  }
  const seen = new Set(mine.map(keyOf));
  const theirs = found.map((s) => {
    if (s.source === 'google') return { ...s, address: s.label };
    const { address } = civic({ house_number: s.house_number, address: s.street });
    return { ...s, address, source: 'lookup' };
  }).filter((s) => {
    const k = keyOf(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const suggestions = [...mine, ...theirs].slice(0, LIMIT);
  return c.json({ suggestions, lookup, by: suggestions.some((s) => s.source !== 'map') ? by : null });
});

// A Google pick: its words, then a pin from the B.C. service in what is left
// of 4 s. Never 502 once Google answered.
api.get('/address/place', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.query('id');
  const session = c.req.query('session');
  if (!isPlaceId(id) || !isSession(session)) return c.json({ error: SESSION_WORDS }, 400);
  if (typing(ctx.user.id)) return c.json({ error: PLACE_WORDS }, 429);
  if (addressSuggester() !== 'google' || ['no-key', 'no-logo'].includes(placesFor(ctx.user.id))) return c.json({ error: PLACE_WORDS }, 502);
  const began = Date.now();
  const d = await placeDetails(id, { session, user: ctx.user.id });
  if (d.error) return c.json({ error: PLACE_WORDS }, 502);
  let pin = null;
  if (d.address && !lookupOff()) {
    const r = await within(geocodeAddress({ address: d.address, unit: d.unit, city: d.city, postal: d.postal }), Math.max(PIN_MIN_MS, PLACE_MS - (Date.now() - began)));
    if (r && !r.error && !r.weak && Number.isFinite(r.lat)) pin = r;
  }
  return c.json({
    ...d,
    lat: pin ? pin.lat : null,
    lng: pin ? pin.lng : null,
    placed: pin ? geoSuggester() : null,
    source: 'google',
  });
});

// ── Placed on save ──
// Who to look up: people whose address this write set or changed, still
// without a pin once it is done.
const placeOnSave = async (tx, meta, events) => {
  const ids = [...new Set(events
    .filter((e) => e.entityType === 'person' && (e.op === 'create' || e.op === 'update')
      && ADDRESS_KEYS.some((k) => k in (e.payload || {})) && !('lat' in (e.payload || {})))
    .map((e) => e.entityId))];
  if (!ids.length) return;
  // A fixed address is a new question: the old answer (nomatch, weak,
  // failed) no longer stands, for this lookup or the desk's background run.
  const waiting = (await tx.query(
    `update persons set attrs = attrs - 'geocode'
      where workspace_id = $1 and id = any($2::uuid[]) and lat is null and address is not null and deleted_at is null
      returning id`,
    [meta.workspaceId, ids],
  )).rows.map((r) => r.id);
  if (!waiting.length || process.env.GEOCODE_ON_SAVE === 'off' || lookupOff()) return;
  // A person or two typed in by hand; a file of thousands is the desk's
  // background run (ext/geocoding), not a lookup each.
  if (waiting.length > HAND_SIZED) return;
  // After the write is in (the hook runs inside its transaction).
  setTimeout(() => { placeSoon(meta.workspaceId, meta.actorId, waiting).catch(() => {}); }, 30);
};

const sameDoor = (p) => [norm(p.address), norm(p.city)];

export const placeSoon = async (workspaceId, actorId, ids) => {
  const db = await getDb();
  for (const id of ids) {
    let p = null;
    // The write may still be finishing: a few short waits.
    for (let i = 0; i < 5 && !p; i += 1) {
      p = (await db.query(
        `select id, address, unit, city, postal, lat from persons where id = $1 and workspace_id = $2 and deleted_at is null`,
        [id, workspaceId],
      )).rows[0];
      if (!p) await new Promise((r) => { setTimeout(r, 100); });
    }
    if (!p || p.lat != null || !p.address) continue;
    const [addr, city] = sameDoor(p);
    const known = (await db.query(
      `select lat, lng from persons where workspace_id = $1 and deleted_at is null and lat is not null
         and lower(trim(address)) = $2 and lower(trim(coalesce(city, ''))) = $3 limit 1`,
      [workspaceId, addr, city],
    )).rows[0];
    // The geocoder is asked at most LOOKUPS_PER_MIN times a minute from
    // here (a busy website feed, say); past that the person waits for the
    // desk's background run, which paces itself.
    if (!known && lookupsBusy('save')) continue;
    const r = known ? { lat: Number(known.lat), lng: Number(known.lng), copied: true }
      : await within(geocodeAddress({ address: p.address, city: p.city, postal: p.postal }), LOOKUP_MS * 2);
    if (r?.error || r === undefined) continue; // the service is down: the desk's run will try again
    const at = new Date().toISOString();
    await runAction(db, { workspaceId, actorId, action: 'person.geocode' }, async (tx, emit) => {
      // Only if nothing moved meanwhile: still no pin, still this address,
      // city and postal code (an edit during the lookup looks again itself).
      const same = `lat is null and address = $3 and coalesce(city, '') = coalesce($4, '') and coalesce(postal, '') = coalesce($5, '')`;
      if (r && !r.weak) {
        const geo = r.copied ? { status: 'ok', at, copied: true } : { status: 'ok', at, matched: r.matched, score: r.score ?? null };
        const { rows } = await tx.query(
          `update persons set lat = $6, lng = $7, attrs = jsonb_set(attrs, '{geocode}', $8::jsonb), updated_at = now()
            where id = $1 and workspace_id = $2 and ${same} returning id`,
          [id, workspaceId, p.address, p.city, p.postal, r.lat, r.lng, JSON.stringify(geo)],
        );
        if (rows.length) emit('person', id, 'update', { lat: r.lat, lng: r.lng, geocoded: r.matched || null });
      } else {
        await tx.query(
          `update persons set attrs = jsonb_set(attrs, '{geocode}', $6::jsonb) where id = $1 and workspace_id = $2 and ${same}`,
          [id, workspaceId, p.address, p.city, p.postal, JSON.stringify({ status: r?.weak ? 'weak' : 'nomatch', at, matched: r?.matched || null })],
        );
      }
    }).catch(() => {});
  }
};

export const hooks = { events: placeOnSave };
