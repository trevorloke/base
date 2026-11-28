// Buildings and houses with suites, worked out when the data is read. The
// server (walk order, the building read) and the phone (the map's square,
// the building sheet) use this one module, so they agree.
//
// A building is an address with BUILDING_MIN (3) or more numbered or
// lettered units (a tower, a walk-up, a townhouse complex); suite words
// never count. A house with suites is any other address with 2 or more
// doors. The parsing (the unit inside an address, a unit's key, a door's
// parts and place) is shared/units.js; this module groups doors.
//
// A door stays address + unit everywhere (passes, the outbox): a building
// or a house is only a way of grouping doors for the eye and for walking
// them. A unit or a suite is a door in every count.
//
//   splitUnit, normAddr, BUILDING_MIN   from shared/units.js
//   normUnit(u)              a unit's key (units.js unitKey)
//   civicOf(door) / unitOf(door)        doorParts(door).civic / .unit
//   groupPlaces(doors)       { buildings, houses, loose }
//   groupBuildings(doors)    { buildings, loose } (a house's doors are loose)
//   buildingOf(doors, anchor) the building that holds a person (or null)
//   floorOf, floorLabel, unitCompare, floorsShown, unitRows, nextDoor
import {
  BUILDING_MIN, splitUnit, normAddr, unitKey, unitKind, doorParts, placeOf, houseCompare, SUITES,
} from './units.js';

export { BUILDING_MIN, splitUnit, normAddr };
// Floors from the lowest up (true: from the top down, Penthouse first).
export const FLOORS_DOWN = false;
// Doors within this of a building's pin belong to it (about 50 m; the reach
// the server's doorOf uses for one door).
export const REACH = 0.0005;

// A unit's key: "Unit #5" → '5', "Bsmt" and "Basement" → 'BSMT', "Main" → ''.
export const normUnit = unitKey;

// City is not part of it: a city’s name and a neighbourhood’s on one tower are one tower.
export const civicOf = (door) => doorParts(door).civic;
export const unitOf = (door) => doorParts(door).unit;

// A floor number, 'PH' (Penthouse) or null (Other units): 3–4 digit units
// are on "all but the last two digits" (1203 → 12, 305 → 3). Suites and
// other words are on no floor.
export const floorOf = (unit) => {
  const u = normUnit(unit);
  if (/^PH(\d{1,4}[A-Z]?)?$/.test(u)) return 'PH';
  if (unitKind(u) !== 'unit') return null;
  const m = u.match(/^(\d{1,2})\d{2}[A-Z]?$/);
  return m ? Number(m[1]) : null;
};
export const floorLabel = (f) => (f === 'PH' ? 'Penthouse' : f == null ? 'Other units' : `Floor ${f}`);

// Floors in walking order, then the units inside a floor in natural order.
const floorRank = (f) => {
  if (typeof f === 'number') return [1, FLOORS_DOWN ? -f : f];
  if (f === 'PH') return [FLOORS_DOWN ? 0 : 2, 0];
  return [3, 0];
};
export const floorCompare = (a, b) => {
  const [ra, na] = floorRank(a);
  const [rb, nb] = floorRank(b);
  return ra - rb || na - nb;
};
// In Other units: the blank and the suites first by rank (Main, Upper,
// Lower, Basement …), then the rest in natural order.
const suiteRank = (u) => (Object.prototype.hasOwnProperty.call(SUITES, u) ? SUITES[u].rank : Infinity);
export const unitCompare = (a, b) => {
  const fa = floorOf(a);
  const fb = floorOf(b);
  const byFloor = floorCompare(fa, fb);
  if (byFloor) return byFloor;
  const ua = normUnit(a);
  const ub = normUnit(b);
  if (fa == null) {
    const ra = suiteRank(ua);
    const rb = suiteRank(ub);
    if (ra !== rb) return ra === Infinity ? 1 : rb === Infinity ? -1 : ra - rb;
  }
  return ua.localeCompare(ub, 'en', { numeric: true });
};

// Floors are worth showing when at least 2 parse and most units (60%) sit on one.
export const floorsShown = (units) => {
  const list = [...new Set((units || []).map(normUnit))];
  if (!list.length) return false;
  const floors = list.map(floorOf).filter((f) => f != null);
  return new Set(floors).size >= 2 && floors.length >= 0.6 * list.length;
};

const pinKey = (lat, lng) => `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
const near = (a, lat, lng) => Math.abs(Number(a.lat) - lat) <= REACH && Math.abs(Number(a.lng) - lng) <= REACH;

// Every civic group (buildings or not): doors with one civic address, near
// the pin most of them share. The same civic 1 km away is another group.
// min: how many numbered or lettered units make a building (placeOf).
const civicGroups = (doors, min = BUILDING_MIN) => {
  const byCivic = new Map();
  const loose = [];
  for (const d of doors || []) {
    const civic = d.address && String(d.address).trim() && d.lat != null && d.lng != null ? civicOf(d) : '';
    if (!civic) { loose.push(d); continue; }
    if (!byCivic.has(civic)) byCivic.set(civic, []);
    byCivic.get(civic).push(d);
  }
  const groups = [];
  for (const [civic, list] of byCivic) {
    let left = list;
    while (left.length) {
      const count = new Map();
      for (const d of left) {
        const k = pinKey(d.lat, d.lng);
        count.set(k, (count.get(k) || 0) + 1);
      }
      const [lat, lng] = [...count.entries()]
        .map(([k, n]) => [...k.split(',').map(Number), n])
        .sort((a, b) => b[2] - a[2] || a[0] - b[0] || a[1] - b[1])[0];
      const mine = left.filter((d) => near(d, lat, lng));
      left = left.filter((d) => !near(d, lat, lng));
      const units = new Set(mine.map(unitOf)).size;
      const place = placeOf(mine, min);
      // The address as most of its doors write it, never with a unit inside.
      const spelled = new Map();
      for (const d of mine) {
        const a = doorParts(d).shown;
        spelled.set(a, (spelled.get(a) || 0) + 1);
      }
      const shown = [...spelled.entries()].sort((x, y) => y[1] - x[1])[0][0];
      groups.push({
        key: `${civic}@${pinKey(lat, lng)}`, civic, address: shown, city: mine.find((d) => d.city)?.city ?? null,
        lat, lng, doors: mine, units, place, people: mine.reduce((n, d) => n + (d.persons?.length || 0), 0),
      });
    }
  }
  return { groups, loose };
};

// Every civic group as a building, a house with suites (its doors in house
// order: Main, then suites by rank, then the rest) or lone doors.
export const groupPlaces = (doors, min = BUILDING_MIN) => {
  const { groups, loose } = civicGroups(doors, min);
  const buildings = [];
  const houses = [];
  for (const g of groups) {
    if (g.place === 'building') buildings.push(g);
    else if (g.place === 'house') {
      const order = g.doors.map((d, i) => [unitOf(d), i, d]);
      order.sort((x, y) => houseCompare(x[0], y[0]) || x[1] - y[1]);
      houses.push({ ...g, doors: order.map((x) => x[2]) });
    } else loose.push(...g.doors);
  }
  return { buildings, houses, loose };
};

// Buildings only: a house's doors are loose, as they always were.
export const groupBuildings = (doors, min = BUILDING_MIN) => {
  const { buildings, houses, loose } = groupPlaces(doors, min);
  return { buildings, loose: [...houses.flatMap((h) => h.doors), ...loose] };
};

// The building that holds this person (or door): their own civic address,
// and a group pin within REACH of theirs — never key equality, so a group
// whose majority pin shifts still finds its anchor. null: not a building.
export const buildingOf = (doors, anchor, min = BUILDING_MIN) => {
  if (!anchor?.address || anchor.lat == null || anchor.lng == null) return null;
  const civic = civicOf(anchor);
  const lat = Number(anchor.lat);
  const lng = Number(anchor.lng);
  const g = civicGroups(doors, min).groups
    .filter((x) => x.civic === civic && near(x, lat, lng))
    .sort((a, b) => (Math.abs(a.lat - lat) + Math.abs(a.lng - lng)) - (Math.abs(b.lat - lat) + Math.abs(b.lng - lng)))[0];
  return g && g.place === 'building' ? g : null;
};

// One row per unit: the doors with that unit (one unit written two ways —
// a Unit column, or inside the address — is one row). Its state counts the
// doors on this round: done only when all are, try again when any is and
// none is open. in_round: any door on this round (in_round false: a pass
// that doesn't want anyone there).
export const unitRows = (building) => {
  const byUnit = new Map();
  for (const d of building?.doors || []) {
    const u = unitOf(d);
    if (!byUnit.has(u)) byUnit.set(u, []);
    byUnit.get(u).push(d);
  }
  return [...byUnit.entries()].map(([unit, list]) => {
    // (Its doors in one order whatever order they were read in: the one
    // with its own Unit column first, then by address.)
    const doors = list.length < 2 ? list : [...list].sort((x, y) => (x.unit ? 0 : 1) - (y.unit ? 0 : 1)
      || String(x.address || '').localeCompare(String(y.address || '')));
    const inRound = doors.filter((d) => d.in_round !== false);
    const counted = (inRound.length ? inRound : doors).map((d) => d.state || 'open');
    const state = counted.every((s) => s === 'done') ? 'done'
      : counted.includes('open') ? 'open'
        : counted.includes('again') ? 'again' : 'open';
    return {
      unit, floor: floorOf(unit), doors, persons: doors.flatMap((d) => d.persons || []),
      state, in_round: inRound.length > 0,
    };
  }).sort((a, b) => unitCompare(a.unit, b.unit));
};

// The doors "Next unit" walks: every door on this round of every row on
// this round, in unit order — so a unit written two ways (two doors, one
// row) is two stops, and the second door's people are reached too. Each
// stop carries its row's unit and floor and its own door's state.
export const unitStops = (rows) => rows.flatMap((row) => (row.in_round === false ? [] : row.doors
  .filter((d) => d.in_round !== false)
  .map((door) => ({ row, door, unit: row.unit, floor: row.floor, state: door.state || 'open' }))));

// The next row from index `from` round the list (never `from` itself; -1:
// from the top): not knocked first, then the ones to try again (the other
// way round with prefer 'again'). -1 when none is left. The walk list's
// "Next door" and the building's "Next unit" are this one rule.
export const nextDoor = (rows, from = -1, { prefer = 'open' } = {}) => {
  const n = rows.length;
  for (const want of (prefer === 'again' ? ['again', 'open'] : ['open', 'again'])) {
    for (let k = 1; k <= n; k += 1) {
      const i = (from + k) % n;
      if (i === from && from >= 0) continue;
      if (rows[i].state === want) return i;
    }
  }
  return -1;
};
