// shared/buildings.js (HR-1): the unit written inside an address, one
// spelling of a civic address, floors and unit order, grouping doors into
// buildings, one row per unit, and the next door — the rule the walk list's
// "Next door" always had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitUnit, normAddr, civicOf, unitOf, floorOf, unitCompare, floorsShown,
  groupBuildings, buildingOf, unitRows, unitStops, nextDoor, BUILDING_MIN,
} from '@starbase/shared/buildings';

const LAT = 49.19;
const LNG = -122.85;
const door = (address, unit, extra = {}) => ({
  address, unit, lat: LAT, lng: LNG, persons: [{ id: `${address}|${unit}`, name: 'Ana Example' }], ...extra,
});

test('splitUnit reads every form of a unit written inside the address', () => {
  const want = { unit: '1203', civic: '13450 104 Ave' };
  for (const s of [
    '1203-13450 104 Ave', '1203 - 13450 104 Ave', '#1203 13450 104 Ave', '#1203-13450 104 Ave',
    'Unit 1203, 13450 104 Ave', 'unit 1203 13450 104 Ave', 'APT 1203, 13450 104 Ave', 'Suite 1203 13450 104 Ave',
    '13450 104 Ave #1203', '13450 104 Ave Unit 1203', '13450 104 Ave, apt 1203', '13450 104 Ave suite 1203',
  ]) assert.deepEqual(splitUnit(s), want, s);
  assert.deepEqual(splitUnit('1203B-13450 104 Ave'), { unit: '1203B', civic: '13450 104 Ave' });
  assert.deepEqual(splitUnit('12-1345 King George Blvd'), { unit: '12', civic: '1345 King George Blvd' });
  // One letter, a hyphen and a civic of 4 or more digits is a letter unit (UNITS D5; it was refused before).
  assert.deepEqual(splitUnit('B-13450 104 Ave'), { unit: 'B', civic: '13450 104 Ave' });
});

test('splitUnit never splits the ambiguous forms', () => {
  for (const s of ['1203 13450 104 Ave', '12345-12347 King George Blvd', '13450 104 Ave',
    '1234-5678 King George Blvd', '#5 Main St', 'Unit 4, Main St', '', null, 'General delivery',
    '13450A 104 Ave', '123 Upper Rd']) {
    assert.equal(splitUnit(s), null, String(s));
  }
});

test('normAddr: one spelling of a civic address', () => {
  assert.equal(normAddr('100 Avenue'), normAddr('100 Ave.'));
  assert.equal(normAddr('  13450,  104   Avenue. '), '13450 104 ave');
  assert.equal(normAddr('5 King George Boulevard'), '5 king george blvd');
  for (const [a, b] of [['Street', 'st'], ['Road', 'rd'], ['Drive', 'dr'], ['Crescent', 'cres'], ['Place', 'pl'], ['Court', 'ct'], ['Highway', 'hwy']]) {
    assert.equal(normAddr(`1 Oak ${a}`), `1 oak ${b}`);
  }
  assert.equal(civicOf({ address: '1203-13450 104 Avenue' }), '13450 104 ave');
  assert.equal(unitOf({ address: '1203-13450 104 Ave' }), '1203');
  assert.equal(unitOf({ address: '13450 104 Ave', unit: ' #ph2 ' }), 'PH2');
  assert.equal(unitOf({ address: '13450 104 Ave', unit: null }), '');
});

test('floors: all but the last two digits, Penthouse, Other units', () => {
  assert.equal(floorOf('1203'), 12);
  assert.equal(floorOf('305'), 3);
  assert.equal(floorOf('1203B'), 12);
  assert.equal(floorOf('PH2'), 'PH');
  for (const u of ['2', '12', 'TH3', 'B', 'BSMT', '', '12345']) assert.equal(floorOf(u), null, u);
});

test('unitCompare: floors from the lowest up, Penthouse after, Other units last', () => {
  const units = ['1203', '305', 'PH2', '1702', '201', '1001', 'TH3', '2'];
  assert.deepEqual([...units].sort(unitCompare), ['201', '305', '1001', '1203', '1702', 'PH2', '2', 'TH3']);
});

test('unitCompare: in Other units, the blank and the suites come first by rank, then the rest', () => {
  const units = ['Side door', '2', 'Coach house', 'Bsmt', '', 'Upper', '201', 'B', 'TH3'];
  assert.deepEqual([...units].sort(unitCompare), ['201', '', 'Upper', 'Bsmt', 'Coach house', '2', 'B', 'Side door', 'TH3']);
  for (const u of ['Bsmt', 'Basement suite', 'Coach house', 'Upper']) assert.equal(floorOf(u), null, u);
});

test('floorsShown: at least 2 floors and 60% of units on one', () => {
  assert.equal(floorsShown(['201', '202', '301', '1', '2']), true, '3 of 5 is 60%');
  assert.equal(floorsShown(['201', '202', '1', '2', '3']), false, 'one floor only');
  assert.equal(floorsShown(['201', '301', '1', '2', '3']), false, '2 of 5 is under 60%');
  assert.equal(floorsShown(Array.from({ length: 60 }, (_, i) => String(i + 1))), false, 'a townhouse complex numbered 1–60');
  assert.equal(floorsShown([]), false);
});

// UNITS D1 (decision U1): 3 or more numbered or lettered units make a
// building (it was 4); 2 are a house with suites, and suite words never count.
test('groupBuildings: 2 units stay loose, 3 group; suite words never count; no-address doors never group', () => {
  const two = ['1', '2'].map((u) => door('100 Oak St', u));
  assert.equal(groupBuildings(two).buildings.length, 0);
  assert.equal(groupBuildings(two).loose.length, 2);
  const three = [...two, door('100 Oak St', '3')];
  const { buildings, loose } = groupBuildings(three);
  assert.equal(BUILDING_MIN, 3);
  assert.equal(buildings.length, 1);
  assert.equal(loose.length, 0);
  assert.equal(buildings[0].units, 3);
  assert.equal(buildings[0].people, 3);
  assert.equal(buildings[0].key, `100 oak st@${LAT.toFixed(5)},${LNG.toFixed(5)}`);
  const suites = [null, 'Bsmt', 'Coach house', 'Upper', 'Garden suite'].map((u) => door('102 Oak St', u));
  assert.equal(groupBuildings(suites).buildings.length, 0, 'a house with four suites is not a building');
  const spots = ['1', '2', '3', '4'].map((u) => ({ address: null, unit: u, lat: LAT, lng: LNG, persons: [] }));
  assert.equal(groupBuildings(spots).buildings.length, 0);
});

test('groupBuildings: the same civic 1 km apart is two; a 0.0003° re-geocode stays one', () => {
  const units = ['101', '102', '201', '202'];
  const here = units.map((u) => door('13450 104 Ave', u));
  const there = units.map((u) => door('13450 104 Ave', u, { lat: LAT + 0.009 }));
  assert.equal(groupBuildings([...here, ...there]).buildings.length, 2);
  const moved = [...here, door('13450 104 Ave', '301', { lat: LAT + 0.0003, lng: LNG - 0.0003 })];
  const b = groupBuildings(moved).buildings;
  assert.equal(b.length, 1);
  assert.equal(b[0].units, 5);
  assert.equal(b[0].lat, Number(LAT.toFixed(5)), 'the pin most doors share');
});

test('groupBuildings: hyphen-form and Unit-column rows of one tower are one building', () => {
  const doors = [
    door('13450 104 Ave', '201'), door('13450 104 Avenue', '202'),
    door('203-13450 104 Ave', null), door('#204 13450 104 Ave.', null),
  ];
  const { buildings } = groupBuildings(doors);
  assert.equal(buildings.length, 1);
  assert.equal(buildings[0].units, 4);
  assert.equal(buildings[0].address, '13450 104 Ave', 'the title never carries a unit');
});

test('buildingOf finds the anchor when the majority pin moves', () => {
  const old = ['101', '102'].map((u) => door('13450 104 Ave', u));
  const anchor = old[0];
  const before = buildingOf([...old, door('13450 104 Ave', '103')], anchor);
  // Six more units re-geocoded 0.0004° north: the group's pin is now theirs.
  const shifted = ['201', '202', '203', '204', '205', '206'].map((u) => door('13450 104 Ave', u, { lat: LAT + 0.0004 }));
  const after = buildingOf([...old, ...shifted], anchor);
  assert.ok(before && after);
  assert.notEqual(before.key, after.key);
  assert.equal(after.units, 8);
  assert.ok(after.doors.includes(anchor));
  assert.equal(buildingOf(old, anchor), null, 'two units: not a building (a house with suites)');
  assert.equal(buildingOf(old, { address: null, lat: LAT, lng: LNG }), null);
});

test('unitRows: one unit written two ways is one row, done only when both doors are', () => {
  const a = door('13450 104 Ave', '1203', { state: 'done' });
  const b = door('1203-13450 104 Ave', null, { state: 'open' });
  const others = ['201', 'PH1', '305'].map((u) => door('13450 104 Ave', u, { state: 'done' }));
  const [bld] = groupBuildings([a, b, ...others]).buildings;
  assert.equal(bld.units, 4, 'units counts 1203 once');
  const rows = unitRows(bld);
  assert.deepEqual(rows.map((r) => r.unit), ['201', '305', '1203', 'PH1']);
  const r1203 = rows.find((r) => r.unit === '1203');
  assert.equal(r1203.doors.length, 2);
  assert.equal(r1203.persons.length, 2);
  assert.equal(r1203.floor, 12);
  assert.equal(r1203.state, 'open');
  b.state = 'again';
  assert.equal(unitRows(bld).find((r) => r.unit === '1203').state, 'again');
  b.state = 'done';
  assert.equal(unitRows(bld).find((r) => r.unit === '1203').state, 'done');
  // A door off this round doesn't hold its unit open.
  b.state = 'open';
  b.in_round = false;
  const r = unitRows(bld).find((x) => x.unit === '1203');
  assert.equal(r.state, 'done');
  assert.equal(r.in_round, true);
});

test('unitStops: Next unit walks every door of a unit written two ways, then moves on', () => {
  const hana = door('13450 104 Ave', '1203', { state: 'open', persons: [{ id: 'hana', name: 'Hana Example' }] });
  const zed = door('1203-13450 104 Ave', null, { state: 'open', persons: [{ id: 'zed', name: 'Zed Example' }] });
  const off = door('13450 104 Ave', '1205', { state: 'open', in_round: false });
  const others = ['1201', '1202', '1204'].map((u) => door('13450 104 Ave', u, { state: 'done' }));
  const [bld] = groupBuildings([zed, hana, off, ...others]).buildings;
  const stops = () => unitStops(unitRows(bld));
  // Off this round: never a stop. Every other door is one, in unit order.
  assert.deepEqual(stops().map((s) => s.unit), ['1201', '1202', '1203', '1203', '1204']);
  assert.equal(stops()[nextDoor(stops(), -1)].door, hana, 'the Unit-column door of 1203 first, whatever the read order');
  hana.state = 'done';
  const s = stops();
  const at = s.findIndex((x) => x.door === hana);
  assert.equal(s[nextDoor(s, at)].door, zed, 'after Hana: Zed, at the same unit');
  assert.equal(s[nextDoor(s, at)].floor, 12);
  zed.state = 'done';
  assert.equal(nextDoor(stops(), stops().findIndex((x) => x.door === zed)), -1, 'then every unit is done');
  assert.equal(unitRows(bld).find((r) => r.unit === '1203').state, 'done');
});

// The walk list's pickNext as it was (Turfs.jsx), to hold nextDoor to it.
const pickNextOld = (doors, show, from) => {
  const n = doors.length;
  for (const want of (show === 'again' ? ['again', 'open'] : ['open', 'again'])) {
    for (let k = 1; k <= n; k += 1) {
      const i = (from + k) % n;
      if (i === from && from >= 0) continue;
      if (doors[i].state === want) return i;
    }
  }
  return -1;
};

test('nextDoor gives exactly the old pickNext order on a recorded walk list', () => {
  const states = ['done', 'open', 'again', 'done', 'open', 'again', 'again', 'done', 'open', 'done'];
  const list = states.map((state) => ({ state }));
  for (const show of ['all', 'open', 'again']) {
    for (let from = -1; from < list.length; from += 1) {
      assert.equal(nextDoor(list, from, { prefer: show === 'again' ? 'again' : 'open' }), pickNextOld(list, show, from), `${show} ${from}`);
    }
  }
  assert.equal(nextDoor([{ state: 'done' }, { state: 'done' }], 0), -1);
  assert.equal(nextDoor([{ state: 'open' }], 0), -1, 'never from itself');
  assert.equal(nextDoor([], -1), -1);
});
