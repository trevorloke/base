// Buildings — an address with BUILDING_MIN or more units (a tower, a
// walk-up, a townhouse complex) worked out when the data is read, never
// stored. The server (walk order, the building read) and the phone (the
// map's square, the building sheet) use this one module, so they agree.
//
// A door stays address + unit everywhere (doorKey, groupDoors, passes, the
// outbox): a building is only a way of grouping doors for the eye and for
// walking them floor by floor. A unit is a door in every count.
//
//   splitUnit(address)       "1203-123 Main St" → { unit: '1203', civic: '123 Main St' };
//                            null for anything else. Read only: nothing writes it back.
//   normAddr(s)              one spelling for a civic address ("1st Avenue." → "1st ave")
//   civicOf(door) / unitOf(door)
//   groupBuildings(doors)    { buildings, loose }
//   buildingOf(doors, anchor) the building that holds a person (or null)
//   floorOf, floorLabel, unitCompare, floorsShown, unitRows, nextDoor

// How many distinct units make an address a building. One constant: the
// real list's numbers may tune it.
export const BUILDING_MIN = 4;
// Floors from the lowest up (true: from the top down, Penthouse first).
export const FLOORS_DOWN = false;
// Doors within this of a building's pin belong to it (about 50 m; the reach
// the server's doorOf uses for one door).
export const REACH = 0.0005;

const UNIT = '([a-z]{0,2}\\d{1,4}[a-z]?)';
const CIVIC_RE = /^\d+[a-z]?\s+[a-z0-9]/i;
const civicOk = (s) => CIVIC_RE.test(s);

// The unit written inside the address, in the forms lists and typing use.
// The ambiguous ones ("B-13450 …", a bare "1203 13450 …") are never split,
// nor a range like "12345-12347" (the right part must be longer).
export const splitUnit = (address) => {
  const s = String(address ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let m = s.match(/^#?\s*(\d{1,4}[a-z]?)\s*-\s*(\d{4,})(\s.*)$/i);
  if (m) {
    const left = m[1].replace(/[a-z]$/i, '');
    const civic = `${m[2]}${m[3]}`.trim();
    return m[2].length > left.length && civicOk(civic) ? { unit: m[1], civic } : null;
  }
  m = s.match(new RegExp(`^#\\s*${UNIT}[\\s,]+(.*)$`, 'i'))
    || s.match(new RegExp(`^(?:unit|apt|suite)\\.?\\s*#?\\s*${UNIT}\\s*,?\\s+(.*)$`, 'i'));
  if (m) return civicOk(m[2].trim()) ? { unit: m[1], civic: m[2].trim() } : null;
  m = s.match(new RegExp(`^(.*?)\\s*,?\\s*#\\s*${UNIT}$`, 'i'))
    || s.match(new RegExp(`^(.*?)\\s*,?\\s+(?:unit|apt|suite)\\.?\\s*#?\\s*${UNIT}$`, 'i'));
  if (m) return civicOk(m[1].trim()) ? { unit: m[2], civic: m[1].trim() } : null;
  return null;
};

const FOLD = {
  avenue: 'ave', street: 'st', road: 'rd', drive: 'dr', boulevard: 'blvd',
  crescent: 'cres', place: 'pl', court: 'ct', highway: 'hwy',
};
export const normAddr = (s) => String(s ?? '').toLowerCase().replace(/[.,#]/g, ' ').trim().split(/\s+/)
  .map((w) => FOLD[w] || w).join(' ');

export const normUnit = (u) => String(u ?? '').trim().toUpperCase().replace(/^#\s*/, '').trim();

// City is not part of it: a city’s name and a neighbourhood’s on one tower are one tower.
export const civicOf = (door) => normAddr(splitUnit(door?.address)?.civic ?? door?.address ?? '');
export const unitOf = (door) => normUnit(door?.unit || splitUnit(door?.address)?.unit || '');

// A floor number, 'PH' (Penthouse) or null (Other units): 3–4 digit units
// are on "all but the last two digits" (1203 → 12, 305 → 3).
export const floorOf = (unit) => {
  const u = normUnit(unit);
  if (/^PH/.test(u)) return 'PH';
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
export const unitCompare = (a, b) => floorCompare(floorOf(a), floorOf(b))
  || normUnit(a).localeCompare(normUnit(b), 'en', { numeric: true });

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
const civicGroups = (doors) => {
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
      // The address as most of its doors write it, never with a unit inside.
      const spelled = new Map();
      for (const d of mine) {
        const a = String(splitUnit(d.address)?.civic ?? d.address).trim();
        spelled.set(a, (spelled.get(a) || 0) + 1);
      }
      const shown = [...spelled.entries()].sort((x, y) => y[1] - x[1])[0][0];
      groups.push({
        key: `${civic}@${pinKey(lat, lng)}`, civic, address: shown, city: mine.find((d) => d.city)?.city ?? null,
        lat, lng, doors: mine, units, people: mine.reduce((n, d) => n + (d.persons?.length || 0), 0),
      });
    }
  }
  return { groups, loose };
};

export const groupBuildings = (doors, min = BUILDING_MIN) => {
  const { groups, loose } = civicGroups(doors);
  const buildings = [];
  for (const g of groups) {
    if (g.units >= min) buildings.push(g);
    else loose.push(...g.doors);
  }
  return { buildings, loose };
};

// The building that holds this person (or door): their own civic address,
// and a group pin within REACH of theirs — never key equality, so a group
// whose majority pin shifts still finds its anchor. null: not a building.
export const buildingOf = (doors, anchor, min = BUILDING_MIN) => {
  if (!anchor?.address || anchor.lat == null || anchor.lng == null) return null;
  const civic = civicOf(anchor);
  const lat = Number(anchor.lat);
  const lng = Number(anchor.lng);
  const g = civicGroups(doors).groups
    .filter((x) => x.civic === civic && near(x, lat, lng))
    .sort((a, b) => (Math.abs(a.lat - lat) + Math.abs(a.lng - lng)) - (Math.abs(b.lat - lat) + Math.abs(b.lng - lng)))[0];
  return g && g.units >= min ? g : null;
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
