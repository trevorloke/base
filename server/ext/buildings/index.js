// Buildings (HR-1): an address with 3 or more numbered or lettered units —
// a tower, a walk-up, a townhouse complex, a triplex — read as one thing
// (suite words never count: a house with a basement suite and a coach
// house is a house, shared/units.js placeOf), so the map can draw it as one
// square and its sheet can list its floors and units. Worked out when it is
// read (shared/buildings.js), never stored: a door stays address + unit.
//
//   GET /api/buildings/of/:personId   the building that person lives in
//       ?was=lat,lng                  the pin of the building the sheet
//                                     showed: if the person is no longer
//                                     in it (moved), it isn't here any more
//   GET /api/buildings/at?lat=&lng=   the building at a dot (the busy map):
//                                     the person nearest the point, within
//                                     the dot's own spot
//
// Answer: { building: { key, place: 'building', address, city, lat, lng,
// units, people, open, again, done, floors }, doors, pass } — doors shaped
// as the walk list's (routes/api.js shapeDoors), each with unit, unit_label
// (the unit's key), unit_words ("Unit 1203", "No unit number"), floor and
// in_round, in floor order. Who is in the building is decided before the pass: a door the open
// pass doesn't want stays, in_round false, and isn't counted in open/again/
// done (unit rows on this round), so a pass never shrinks a building.
// { building: null }: not a building — the map opens the door as before.
// 404 { gone: true }: the person is deleted, merged away, or not there now.
//
// Who may read: as the map (/map/doors) — no area of its own. A volunteer
// kept to their turfs gets a building only inside one (a tower is one point).
import { Hono } from 'hono';
import { openPass, listedWhere } from '../passes/rule.js';
import { inPass } from '@base-win/shared/passes';
import { groupDoors } from '../../lib/geo.js';
import { inMyTurf } from '../core/index.js';
import { scopeOf } from '../voted/state.js';
import {
  buildingOf, unitRows, unitOf, floorOf, unitCompare, floorsShown, REACH,
} from '@base-win/shared/buildings';
import { unitWords } from '../../../shared/units.js';

// Routes import the extensions, so the walk list's own read is imported
// when asked for, not at load (ext.js: features never import routes/*).
const walkRoute = () => import('../../routes/api.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// More people than this around one point: too big to list on a phone.
export const BUILDING_PEOPLE_MAX = 3000;
// A dot is one spot to five decimals (routes/api.js doorDots).
const SPOT = 0.00002;

const GONE = { error: 'This building isn’t here any more', gone: true };
const NOT_MINE = { error: 'Not on your turfs' };

const square = (lat, lng, r = REACH) => [lat - r, lng - r, lat + r, lng + r];
const passOut = (pass) => (pass
  ? { id: pass.id, name: pass.name, kind: pass.kind, who: pass.who, list_id: pass.list_id || null, tries: pass.tries, started_at: pass.started_at }
  : null);

// The building around one person (the anchor). null: not a building.
const readBuilding = async (db, ctx, anchor) => {
  const { loadLocated, shapeDoors } = await walkRoute();
  const lat = Number(anchor.lat);
  const lng = Number(anchor.lng);
  const count = (await db.query(
    `select count(*)::int as n from persons
     where workspace_id = $1 and deleted_at is null and lat between $2 and $4 and lng between $3 and $5`,
    [ctx.workspaceId, ...square(lat, lng)],
  )).rows[0].n;
  if (count > BUILDING_PEOPLE_MAX) {
    return { building: { address: anchor.address, units: null }, truncated: true, doors: [], pass: null };
  }
  const pass = await openPass(db, ctx.workspaceId);
  const onList = await listedWhere(db, ctx, pass);
  const read = async (la, ln) => groupDoors(await loadLocated(db, ctx, pass, square(la, ln), onList));
  let b = buildingOf(await read(lat, lng), anchor);
  // Most of the building is pinned a little way off the anchor: read
  // around the building's own pin, so none of it is left outside the square.
  if (b && (b.lat.toFixed(5) !== lat.toFixed(5) || b.lng.toFixed(5) !== lng.toFixed(5))) {
    b = buildingOf(await read(b.lat, b.lng), anchor);
  }
  if (!b) return { building: null };
  // in_round from the rows as read (the viewer's copy may leave out what
  // the pass looks at); unit_label: the unit as the sheet shows it, also
  // when it is written inside the address (unit stays as on file: the door).
  const shaped = (await shapeDoors(db, ctx, b.doors, pass)).map((d, i) => {
    const unit = unitOf(d);
    return { ...d, unit_label: unit, unit_words: unitWords(unit, 'building'), place: 'building', floor: floorOf(unit), in_round: inPass(b.doors[i], pass) };
  }).sort((x, y) => unitCompare(x.unit_label, y.unit_label));
  // A building can reach past a turf's edge: while GOTV keeps a volunteer
  // to their turfs and phone banks, its people outside them carry no voted
  // state at all (as GET /persons/:id), never a false "not voted".
  if (ctx.gotv?.limited) {
    const { ids } = await scopeOf(db, ctx);
    for (const d of shaped) d.persons = d.persons.map((p) => (ids.has(p.id) ? p : (({ voted_at, ...r }) => ({ ...r, voted_hidden: true }))(p)));
  }
  const rows = unitRows({ doors: shaped }).filter((r) => r.in_round);
  const n = (state) => rows.filter((r) => r.state === state).length;
  return {
    building: {
      key: b.key, place: 'building', address: b.address, city: b.city, lat: b.lat, lng: b.lng, units: b.units, people: b.people,
      open: n('open'), again: n('again'), done: n('done'), floors: floorsShown(shaped.map((d) => d.unit_label)),
    },
    doors: shaped,
    pass: passOut(pass),
  };
};

// The person, if they are still somewhere on the map at an address.
const anchorOf = async (db, ctx, id) => (await db.query(
  `select id, address, unit, city, lat, lng from persons
   where id = $1 and workspace_id = $2 and deleted_at is null`,
  [id, ctx.workspaceId],
)).rows[0];
const placed = (p) => p && String(p.address || '').trim() && p.lat != null && p.lng != null;

const answer = async (c, anchor) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const { turfsOnly } = await walkRoute();
  if (turfsOnly(ctx) && !(await inMyTurf(db, ctx, anchor.lat, anchor.lng))) return c.json(NOT_MINE, 404);
  return c.json(await readBuilding(db, ctx, anchor));
};

export const api = new Hono();

api.get('/buildings/of/:personId', async (c) => {
  const id = c.req.param('personId');
  if (!UUID_RE.test(id)) return c.json(GONE, 404);
  const anchor = await anchorOf(c.get('db'), c.get('ctx'), id);
  if (!placed(anchor)) return c.json(GONE, 404);
  // The sheet knew the building's pin: a person who has moved away from it
  // no longer opens it (the building they live in now is another one).
  const was = String(c.req.query('was') || '').split(',').map(Number);
  if (was.length === 2 && was.every(Number.isFinite)
    && (Math.abs(Number(anchor.lat) - was[0]) > REACH || Math.abs(Number(anchor.lng) - was[1]) > REACH)) {
    return c.json(GONE, 404);
  }
  return answer(c, anchor);
});

api.get('/buildings/at', async (c) => {
  const lat = Number(c.req.query('lat'));
  const lng = Number(c.req.query('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return c.json({ error: 'lat and lng, please' }, 400);
  }
  const ctx = c.get('ctx');
  // The person nearest the point within the dot's own spot (the geo
  // index finds them); someone with an address before someone without.
  const anchor = (await c.get('db').query(
    `select id, address, unit, city, lat, lng from persons
     where workspace_id = $1 and deleted_at is null and lat between $2 and $4 and lng between $3 and $5
     order by (coalesce(btrim(address), '') = ''), abs(lat - $6) + abs(lng - $7), id limit 1`,
    [ctx.workspaceId, ...square(lat, lng, SPOT), lat, lng],
  )).rows[0];
  if (!placed(anchor)) return c.json({ building: null });
  return answer(c, anchor);
});
