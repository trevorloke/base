// Places a shift happens at — the reads, and the name for a point picked on
// the map.
//
// nameFor(db, ws, { lat, lng }, { doors }) → { name, source, address? }, by
// the first rule that answers:
//   'corner'   the nearest intersection within ~150 m: "King George Blvd & 88 Ave"
//   'address'  the nearest civic address within ~100 m: "near 8850 King George Blvd"
//   'door'     the campaign's own nearest door on file within ~300 m (no
//              outside call): "near 13450 104 Ave" — for the desk only
//              (`doors`): a volunteer granted Shifts has their doors scoped
//              to their own turfs, so their point falls to its pin
//   'pin'      "Pin at 49.1630, −122.8447" — its coordinates, which the
//              screens say as "Pinned place" (shared/shiftkinds.js) until
//              someone names it
// The first two ask the address service (lib/geocode.js) — for at most 60
// points a minute from this server, each call given up on after a few
// seconds. Whatever goes wrong there, the next rule names the place: naming
// never fails.
//
// placesFor(db, ws, kind) → { places, words }: the chips for "Where". Saved
// places, the ones this kind used most first (kind_uses, then uses, then by
// name); then the words already on shifts that are no saved place's name
// (a shift whose place is its turf is left out: the turf is offered itself).
//
// The writes (desk; the Shifts area, lib/perms.js):
//   place.save { name?, lat?, lng?, address?, source? }   a place for the
//       list. A point with no name is named by nameFor before the write —
//       the address service is never asked inside it, and can't hold it up.
//       A name already on the list is that place (duplicate: true), which
//       gains the pin if it had none.
//   place.rename { id, name }   its name — and, on the shifts still to come
//       that say it, their words and their made names.
//   place.remove { id }         off the list; shifts keep their words and pin.
import { z } from 'zod';
import { kindOf, pinName } from '@starbase/shared/shiftkinds';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { nearestCivic, nearestCorner } from '../../lib/geocode.js';
import { makeLimiter } from '../../lib/guard.js';
import { titleFor } from './rules.js';

const lookups = makeLimiter({ windowMs: 60_000, max: 60 });

// About 300 m, in degrees of latitude.
const DOOR_REACH = 0.0027;
const nearestDoor = async (db, ws, { lat, lng }) => {
  const wide = DOOR_REACH / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const row = (await db.query(
    `select address from persons
      where workspace_id = $1 and deleted_at is null and lat is not null and lng is not null
        and nullif(trim(address), '') is not null
        and lat between $2::float8 - $4::float8 and $2::float8 + $4::float8
        and lng between $3::float8 - $5::float8 and $3::float8 + $5::float8
      order by power(lat - $2::float8, 2) + power((lng - $3::float8) * $6::float8, 2) limit 1`,
    [ws, lat, lng, DOOR_REACH, wide, DOOR_REACH / wide],
  )).rows[0];
  return row ? String(row.address).trim().slice(0, 180) : null;
};

export const nameFor = async (db, ws, { lat, lng }, { doors = false } = {}) => {
  if (!lookups('places')) {
    const corner = await nearestCorner({ lat, lng });
    if (corner) return { name: corner.name, source: 'corner' };
    const civic = await nearestCivic({ lat, lng });
    if (civic) return { name: `near ${civic.name}`, address: civic.address, source: 'address' };
  }
  const door = doors ? await nearestDoor(db, ws, { lat, lng }).catch(() => null) : null;
  if (door) return { name: `near ${door}`, source: 'door' };
  return { name: pinName(lat, lng), source: 'pin' };
};

// A point on Earth from two query values, or null.
export const pointOf = (lat, lng) => {
  const a = Number(lat); const b = Number(lng);
  const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  return given(lat) && given(lng) && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180
    ? { lat: a, lng: b } : null;
};

export const placeOut = (p) => ({
  id: p.id, name: p.name, lat: p.lat == null ? null : Number(p.lat), lng: p.lng == null ? null : Number(p.lng),
  address: p.address || null, source: p.source || null,
});

const MAX_PLACES = 200;
const MAX_WORDS = 30;
const byUse = (a, b) => b.kind_uses - a.kind_uses || b.uses - a.uses || a.name.toLowerCase().localeCompare(b.name.toLowerCase());

export const placesFor = async (db, ws, kind) => {
  const saved = (await db.query(
    `select id, name, lat, lng, address, source from places where workspace_id = $1 and deleted_at is null order by lower(name) limit ${MAX_PLACES}`, [ws],
  )).rows;
  // How often each place and each set of words was used, by what the shift
  // is — its kind, or what its role implies (a shift from before kinds).
  const used = (await db.query(
    `select s.place_id, case when s.place_id is null then lower(trim(s.location)) end as words, min(trim(s.location)) as name,
            s.kind, s.role, count(*)::int as n
       from shifts s
      where s.workspace_id = $1 and s.deleted_at is null
        and (s.place_id is not null or (nullif(trim(s.location), '') is not null
             and not exists (select 1 from shift_turfs st where st.shift_id = s.id)))
      group by 1, 2, s.kind, s.role`,
    [ws],
  )).rows;
  const tally = new Map();
  for (const u of used) {
    const key = u.place_id || `words:${u.words}`;
    const t = tally.get(key) || { name: u.name, uses: 0, kind_uses: 0 };
    t.uses += u.n;
    if (kind && kindOf(u).code === kind) t.kind_uses += u.n;
    tally.set(key, t);
  }
  const places = saved.map((p) => ({ ...placeOut(p), uses: tally.get(p.id)?.uses || 0, kind_uses: tally.get(p.id)?.kind_uses || 0 })).sort(byUse);
  const names = new Set(saved.map((p) => p.name.trim().toLowerCase()));
  const words = [...tally.entries()]
    .filter(([key]) => key.startsWith('words:') && !names.has(key.slice(6)))
    .map(([, t]) => t).sort(byUse).slice(0, MAX_WORDS);
  return { places, words };
};

// ── Writes ──
const DESK = ['manager', 'treasurer', 'staff'];
const nameInput = () => z.string().trim().min(1).max(200);
// A place on the list with this name, however it is capitalised.
const named = async (tx, ws, name, exceptId = null) => (await tx.query(
  `select * from places where workspace_id = $1 and deleted_at is null and lower(trim(name)) = lower($2)
     and ($3::uuid is null or id <> $3::uuid) order by created_at limit 1`,
  [ws, name, exceptId],
)).rows[0];

export const placeActions = {
  'place.save': {
    roles: DESK,
    input: z.object({
      name: nameInput().optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      address: z.string().trim().max(400).nullish(),
      source: z.enum(['map', 'typed', 'used']).optional(),
    }).refine((v) => (v.lat === undefined) === (v.lng === undefined), 'a point is a lat and a lng')
      .refine((v) => v.name !== undefined || v.lat !== undefined, 'a name, or a point on the map'),
    before: (db, ctx, input) => (input.name === undefined
      ? nameFor(db, ctx.workspaceId, { lat: input.lat, lng: input.lng }, { doors: ctx.role !== 'volunteer' }) : null),
    handler: async (tx, ctx, input, emit, suggested) => {
      const ws = ctx.workspaceId;
      const name = input.name ?? suggested?.name;
      if (!name) throw httpError(400, 'a name, or a point on the map');
      const pin = input.lat === undefined ? null : { lat: input.lat, lng: input.lng };
      const address = input.address || suggested?.address || null;
      const had = await named(tx, ws, name);
      if (had) {
        if (pin && had.lat == null) {
          await tx.query('update places set lat = $3, lng = $4, address = coalesce(address, $5) where id = $1 and workspace_id = $2',
            [had.id, ws, pin.lat, pin.lng, address]);
          emit('place', had.id, 'update', pin);
          Object.assign(had, pin, { address: had.address || address });
        }
        return { place: placeOut(had), duplicate: true };
      }
      const place = { id: newId(), name, lat: pin?.lat ?? null, lng: pin?.lng ?? null, address, source: input.source || (pin ? 'map' : 'typed') };
      await tx.query(
        `insert into places (id, workspace_id, name, lat, lng, address, source, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [place.id, ws, place.name, place.lat, place.lng, place.address, place.source, ctx.user?.id || null],
      );
      emit('place', place.id, 'create', place);
      return { place };
    },
  },

  'place.rename': {
    roles: DESK,
    input: z.object({ id: z.uuid(), name: nameInput() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const place = (await tx.query(
        'select * from places where id = $1 and workspace_id = $2 and deleted_at is null', [input.id, ws],
      )).rows[0];
      if (!place) throw httpError(404, 'place not found');
      if (await named(tx, ws, input.name, place.id)) throw httpError(409, 'another place has that name');
      await tx.query('update places set name = $3 where id = $1 and workspace_id = $2', [place.id, ws, input.name]);
      emit('place', place.id, 'update', { name: input.name });
      // The shifts still to come that say its name say the new one — in
      // their words and, where their name is made, in that too. What is
      // over stays as it was.
      const shifts = (await tx.query(
        `select * from shifts where workspace_id = $1 and place_id = $2 and deleted_at is null
           and coalesce(ends_at, starts_at) >= now() and lower(trim(location)) = lower(trim($3))`,
        [ws, place.id, place.name],
      )).rows;
      for (const s of shifts) {
        const patch = { location: input.name };
        if (s.title_custom === false) patch.title = titleFor({ ...s, location: input.name });
        await tx.query('update shifts set location = $3, title = $4 where id = $1 and workspace_id = $2',
          [s.id, ws, patch.location, patch.title ?? s.title]);
        emit('shift', s.id, 'update', patch);
      }
      return { place: placeOut({ ...place, name: input.name }), shifts: shifts.length };
    },
  },

  'place.remove': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const r = await tx.query(
        'update places set deleted_at = now() where id = $1 and workspace_id = $2 and deleted_at is null', [input.id, ctx.workspaceId],
      );
      if (!(r.affectedRows ?? r.rowCount)) throw httpError(404, 'place not found');
      emit('place', input.id, 'void', {});
      return { id: input.id };
    },
  },
};
