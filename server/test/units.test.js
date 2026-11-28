// shared/units.js (UNITS U1): one parser for suites and units, used by the
// server, the phone and the scripts. A unit's key, the unit written inside
// an address, a door's parts and key, building or house or lone door, and
// the words every screen uses. Every address and name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT_V, SUITES, SUITE_TYPED, unitKey, unitKind, splitUnit, doorParts, doorKey, placeOf,
  houseCompare, unitWords, doorLine, houseTag,
} from '../../shared/units.js';
import { groupPlaces, groupBuildings, buildingOf, BUILDING_MIN } from '../../shared/buildings.js';
import { walkOrder } from '../lib/geo.js';

const LAT = 49.19;
const LNG = -122.85;
const door = (address, unit = null, extra = {}) => ({
  address, unit, lat: LAT, lng: LNG, persons: [{ id: `${address}|${unit}`, name: 'Ana Example' }], ...extra,
});
const at = (address, units) => units.map((u) => door(address, u));

test('the module: a parser version, the suite words and the Unit field suggestions', () => {
  assert.equal(UNIT_V, 1);
  assert.equal(SUITES[''].words, 'Main');
  assert.equal(SUITES.BSMT.words, 'Basement suite');
  const ranks = Object.values(SUITES).map((s) => s.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'ranks in order');
  assert.deepEqual(SUITE_TYPED, ['Main', 'Basement suite', 'Upper suite', 'Lower suite', 'Rear suite', 'Coach house', 'Laneway house', 'Garden suite']);
});

test('unitKey: every way a suite or unit is typed comes to one key', () => {
  const want = {
    BSMT: ['Bsmt', 'BSMT.', 'basement', 'Basement Suite', 'bsmt ste', 'Bsmnt', 'bsm', 'Bsmt suite', ' basement  suite '],
    '': ['Main', 'main floor', 'Main house', 'main level', 'MN', '', null, undefined, '   '],
    5: ['Unit 5', '#5', 'Apt. 5', 'Suite 5', 'Ste 5', '5', 'unit #5', 'Apartment 5', 'No. 5', 'Rm 5', 'Room 5', 'UNIT5', '# 5'],
    SUITE: ['Suite', 'suite.'],
    COACH: ['Coach', 'coach house', 'Coachhouse', 'Carriage house'],
    LANE: ['Laneway house', 'laneway', 'Lane house', 'Laneway home'],
    LOWER: ['Lower', 'lwr', 'Lower suite', 'lower level', 'Lower floor', 'Downstairs'],
    UPPER: ['Upper', 'upr', 'Upper suite', 'Upper floor', 'upstairs'],
    REAR: ['Rear', 'back', 'Rear suite', 'Back suite', 'rear house'],
    GARDEN: ['Garden', 'garden suite'],
    B: ['b', 'B', 'Suite B', 'Unit B', '#b'],
    PH2: ['ph2', 'PH2', 'Unit PH2', ' #ph2 '],
    TH5: ['th5'],
    '105A': ['105a', 'Unit 105A'],
    12345: ['12345'],
    1203: ['1203', 'Unit 1203', 'Suite 1203', '#1203'],
    'SIDE DOOR': ['Side door', 'side  door'],
  };
  for (const [key, typed] of Object.entries(want)) {
    for (const t of typed) assert.equal(unitKey(t), key, JSON.stringify(t));
  }
  // en and em dashes and a no-break space read as a dash and a space.
  assert.equal(unitKey('Basement suite'), 'BSMT');
  // Leading zeros are kept: unit 01 is not unit 1.
  assert.equal(unitKey('01'), '01');
  assert.notEqual(unitKey('01'), unitKey('1'));
});

test('unitKey: a placeholder for "no unit" is the main door, and a prefix strips only as a whole word', () => {
  for (const t of ['N/A', 'n/a', 'NA', 'None', 'NIL', '-', '--', '.', '0', 'No unit number', 'no unit', '#', '–']) {
    assert.equal(unitKey(t), '', JSON.stringify(t));
  }
  // "NONE" is not "NO" + "NE"; "Northside" is not "NO" + "RTHSIDE"; "Roomy" keeps its letters.
  assert.equal(unitKey('Northside'), 'NORTHSIDE');
  assert.equal(unitKey('Stairs'), 'STAIRS');
  assert.equal(unitKey('Roomy loft'), 'ROOMY LOFT');
  assert.equal(unitKey('Unitary'), 'UNITARY');
});

test('unitKind: main, suite, unit, letter, other', () => {
  assert.equal(unitKind(''), 'main');
  for (const k of Object.keys(SUITES).filter(Boolean)) assert.equal(unitKind(k), 'suite', k);
  for (const k of ['1203', '105A', 'PH2', 'TH5', '12345', '5', '01']) assert.equal(unitKind(k), 'unit', k);
  for (const k of ['A', 'B', 'Z']) assert.equal(unitKind(k), 'letter', k);
  for (const k of ['SIDE DOOR', 'NORTHSIDE', '1/2', '123456']) assert.equal(unitKind(k), 'other', k);
});

test('splitUnit: every form a unit or suite is written inside the address', () => {
  const cases = [
    // hyphen, digits (as before, plus an en or em dash)
    ['1203-13450 104 Ave', '1203', '13450 104 Ave'],
    ['#1203 - 13450 104 Ave', '1203', '13450 104 Ave'],
    ['1203–13450 104 Ave', '1203', '13450 104 Ave'],
    ['1203 — 13450 104 Ave', '1203', '13450 104 Ave'],
    ['1203B-13450 104 Ave', '1203B', '13450 104 Ave'],
    ['12-1345 King George Blvd', '12', '1345 King George Blvd'],
    // hyphen, letters and digits
    ['PH1-13450 104 Ave', 'PH1', '13450 104 Ave'],
    ['TH5-10150 King George Blvd', 'TH5', '10150 King George Blvd'],
    // hyphen, one letter (D5)
    ['B-10388 134 St', 'B', '10388 134 St'],
    ['a-10500 134 St', 'a', '10500 134 St'],
    // hyphen, a suite word
    ['Bsmt-10388 134 St', 'Bsmt', '10388 134 St'],
    ['Coach house - 10388 134 St', 'Coach house', '10388 134 St'],
    // # or a word before
    ['#1203 13450 104 Ave', '1203', '13450 104 Ave'],
    ['Unit 5, 13450 104 Ave', '5', '13450 104 Ave'],
    ['Ste 210 13450 104 Ave', '210', '13450 104 Ave'],
    ['Apartment 3 13450 104 Ave', '3', '13450 104 Ave'],
    ['Unit 1203 - 13450 104 Ave', '1203', '13450 104 Ave'],
    ['Unit B 10388 134 St', 'B', '10388 134 St'],
    ['Unit Bsmt 10388 134 St', 'Bsmt', '10388 134 St'],
    ['Suite 12345 10150 King George Blvd', '12345', '10150 King George Blvd'],
    // a suite word before
    ['Bsmt 10388 134 St', 'Bsmt', '10388 134 St'],
    ['Basement suite, 10388 134 St', 'Basement suite', '10388 134 St'],
    ['Upper 10388 134 St', 'Upper', '10388 134 St'],
    ['Coach house, 10388 134 St', 'Coach house', '10388 134 St'],
    // # or a word after
    ['13450 104 Ave #1203', '1203', '13450 104 Ave'],
    ['13450 104 Ave Unit 12A', '12A', '13450 104 Ave'],
    ['13450 104 Ave Ste 210', '210', '13450 104 Ave'],
    ['13450 104 Ave, Suite 101', '101', '13450 104 Ave'],
    ['10388 134 St Unit B', 'B', '10388 134 St'],
    ['10388 134 St #Bsmt', 'Bsmt', '10388 134 St'],
    // a suite word after a street type, a direction, a comma, brackets or " - " (D6)
    ['10388 134 St Bsmt', 'Bsmt', '10388 134 St'],
    ['10388 134 St. Bsmt', 'Bsmt', '10388 134 St.'],
    ['10388 134 St, Basement', 'Basement', '10388 134 St'],
    ['10388 134 St (Bsmt)', 'Bsmt', '10388 134 St'],
    ['10388 134 St - Lower suite', 'Lower suite', '10388 134 St'],
    ['13450 104 Avenue Upper', 'Upper', '13450 104 Avenue'],
    ['10388 King George Blvd N Coach house', 'Coach house', '10388 King George Blvd N'],
    ['5520 Example Way Garden suite', 'Garden suite', '5520 Example Way'],
  ];
  for (const [s, unit, civic] of cases) assert.deepEqual(splitUnit(s), { unit, civic }, s);
});

test('splitUnit never splits the forms with another reading', () => {
  for (const s of [
    '1203 13450 104 Ave', '12345-12347 King George Blvd', '1234-5678 King George Blvd', '13450A 104 Ave',
    '#5 Main St', 'Unit 4, Main St', '123 Upper Rd', '555 Main', 'General delivery', '', null, undefined,
    '13450 104 Ave', '10388 134 St',
    // a suite word after a name word is part of the street (review 21)
    '12345 Park Garden', '12345 Hill Upper', '200 Oak Green Lower', '300 Elm Grove Rear', '400 Ash Walk Main',
    '500 Upper Lower', '600 Maple Point Back', '15 Bay Garden',
    // a suite word before a numbered street on its own is the street's name
    'Upper 104 Ave', 'Rear 1 St',
    // a lone letter before a hyphen needs a civic of 4 or more digits
    'B-123 Oak St', 'B-12 Oak St',
    // a house number written with '#', 'No.' or a unit word in front of a numbered street:
    // what is left would be a bare street, so it is the house number, not a unit
    '#12345 104 Ave', '# 12345 104 Ave', 'Ste 12345 104 Ave', 'Suite 12345 104 Ave', 'Unit 12345 104 Ave',
    'No. 10388 134 St', 'No 10388 134 St', '#5 104 Ave', '#10388 134 St', 'Apt 10388 134 St N',
    // …and after it: the street alone is no house
    '104 Ave #5', '134 St Unit 12', '104 Ave, Suite 101',
  ]) assert.equal(splitUnit(s), null, String(s));
});

test('doorParts: civic, shown, unit key, kind and house number', () => {
  assert.deepEqual(doorParts({ address: '10388 134 St Bsmt' }),
    { civic: '10388 134 st', shown: '10388 134 St', unit: 'BSMT', kind: 'suite', house: '10388' });
  assert.deepEqual(doorParts({ address: '1203-13450 104 Avenue' }),
    { civic: '13450 104 ave', shown: '13450 104 Avenue', unit: '1203', kind: 'unit', house: '13450' });
  assert.deepEqual(doorParts({ address: '13450A 104 Ave', unit: 'Main' }),
    { civic: '13450a 104 ave', shown: '13450A 104 Ave', unit: '', kind: 'main', house: '13450A' });
  // The Unit column wins when both are set; a placeholder in it doesn't.
  assert.equal(doorParts({ address: '1203-13450 104 Ave', unit: '1507' }).unit, '1507');
  assert.equal(doorParts({ address: '1203-13450 104 Ave', unit: 'N/A' }).unit, '1203');
  // A numbered street is not a house.
  assert.equal(doorParts({ address: '104 Ave' }).house, null);
  assert.deepEqual(doorParts({ address: '', unit: 'B' }), { civic: '', shown: '', unit: 'B', kind: 'letter', house: null });
  assert.deepEqual(doorParts({}), { civic: '', shown: '', unit: '', kind: 'main', house: null });
  assert.deepEqual(doorParts(null), { civic: '', shown: '', unit: '', kind: 'main', house: null });
  // The same door object, changed: its parts follow the change; a copy handed out can't change them.
  const d = { address: '10388 134 St', unit: null };
  doorParts(d).unit = 'X';
  assert.equal(doorParts(d).unit, '');
  d.unit = 'Bsmt';
  assert.equal(doorParts(d).unit, 'BSMT');
  d.address = '1203-13450 104 Ave';
  d.unit = null;
  assert.deepEqual([doorParts(d).civic, doorParts(d).unit], ['13450 104 ave', '1203']);
});

test('doorKey: one door written two ways is one key; two doors never are', () => {
  const k = (address, unit) => doorKey({ id: 'p1', address, unit });
  // Equal.
  assert.equal(k('10388 134 St', null), k('10388 134 St', 'Main'), 'blank is Main');
  assert.equal(k('1203-13450 104 Ave', null), k('13450 104 Ave', '1203'), '1203 written both ways');
  assert.equal(k('10388 134 St', 'Bsmt'), k('10388 134 St', 'Basement'));
  assert.equal(k('10388 134 St Bsmt', null), k('10388 134 St', 'Basement suite'));
  assert.equal(k('13450 104 Avenue', '5'), k('13450 104 Ave.', 'Unit 5'));
  assert.equal(k('10388 134 St', 'N/A'), k('10388 134 St', ''));
  // Not equal.
  assert.notEqual(k('10388 134 St', 'Main'), k('10388 134 St', 'Bsmt'));
  assert.notEqual(k('13450 104 Ave', null), k('13450A 104 Ave', null));
  assert.notEqual(k('13450 104 Ave', '1'), k('13450 104 Ave', '01'));
  assert.notEqual(k('10500 134 St', 'A'), k('10500 134 St', 'B'));
  // No address: the caller's own key, kept so nothing else moves.
  assert.equal(doorKey({ id: 'p9', address: '  ', lat: 1, lng: 2 }, { none: (p) => `person:${p.id}` }), 'person:p9');
  assert.equal(doorKey({ id: 'p9', address: null, lat: 49.1, lng: -122.8 }, { none: (p) => `@${p.lat},${p.lng}` }), '@49.1,-122.8');
  assert.notEqual(doorKey({ id: 'p1', address: null }), doorKey({ id: 'p2', address: null }), 'by default each person is their own door');
  // The same civic 1 km apart has one key, but two places.
  const here = door('10388 134 St', null);
  const there = door('10388 134 St', null, { lat: LAT + 0.009 });
  assert.equal(doorKey(here), doorKey(there));
  const { loose } = groupPlaces([here, door('10388 134 St', 'Bsmt'), there]);
  assert.deepEqual(loose, [there], 'the far one is its own lone door, not part of the house');
});

test('placeOf: three or more numbered or lettered units make a building; suite words never do (decision U1)', () => {
  const place = (units) => placeOf(at('10388 134 St', units));
  assert.equal(place(['', 'BSMT']), 'house');
  assert.equal(place(['', 'BSMT', 'COACH', 'UPPER']), 'house', 'three suites: still a house');
  assert.equal(place(['', 'Bsmt', 'Basement', 'Coach house', 'Upper', 'Lower', 'Rear', 'Garden', 'Laneway']), 'house');
  assert.equal(place(['', 'B']), 'house');
  assert.equal(place(['A', 'B']), 'house', 'two letters and no main door: a house with suites');
  assert.equal(place(['1', '2']), 'house', 'two numbers and no main door: a house with suites');
  assert.equal(place(['', '1', '2']), 'house');
  assert.equal(place(['1', '2', '3']), 'building');
  assert.equal(place(['', 'A', 'B', 'C']), 'building');
  assert.equal(placeOf(['1', '2', '3', '4'].map((u) => door(`${u}-10500 134 St`))), 'building', 'a house made into 4 units');
  assert.equal(place(['1203']), 'door');
  assert.equal(place(['']), 'door');
  assert.equal(place([null, 'Main', 'N/A']), 'door', 'blank, Main and a placeholder are one main door');
  assert.equal(placeOf([door('1203-13450 104 Ave'), door('13450 104 Ave', '1203')]), 'door', 'one unit written two ways');
  // Text that is not a unit never counts toward a building (review 8).
  assert.equal(place(['Side door', 'Back door', 'Front door']), 'house');
  assert.equal(place(['', '1', 'Side door', 'Front door']), 'house');
  assert.equal(place(['', '1', '2', 'BSMT', 'COACH']), 'house', 'suite words never count');
  assert.equal(placeOf([]), 'door');
  assert.equal(BUILDING_MIN, 3);
});

test('groupPlaces: buildings, houses and lone doors; groupBuildings keeps its old shape', () => {
  const house = at('10388 134 St', ['Bsmt', null, 'Coach house', 'Upper']);
  const pair = [door('A-10500 134 St'), door('B-10500 134 St')];
  const walkup = at('13520 104 Ave', ['101', '102', '103']);
  const lone = [door('13450A 104 Ave'), door('13450 104 Ave'), door(null, '5')];
  const { buildings, houses, loose } = groupPlaces([...house, ...pair, ...walkup, ...lone]);
  assert.deepEqual(buildings.map((b) => [b.address, b.units, b.place]), [['13520 104 Ave', 3, 'building']]);
  assert.deepEqual(houses.map((h) => [h.address, h.units, h.place]), [['10388 134 St', 4, 'house'], ['10500 134 St', 2, 'house']]);
  for (const h of houses) for (const k of ['key', 'civic', 'address', 'lat', 'lng', 'doors']) assert.ok(k in h, k);
  // A house's doors in house order: Main, then suites by rank.
  assert.deepEqual(houses[0].doors.map((d) => d.unit), [null, 'Upper', 'Bsmt', 'Coach house']);
  assert.deepEqual(houses[1].doors.map((d) => d.address), ['A-10500 134 St', 'B-10500 134 St']);
  assert.equal(loose.length, 3, '13450A, 13450 and the door with no address');
  // groupBuildings: the same buildings, and every other door loose.
  const old = groupBuildings([...house, ...pair, ...walkup, ...lone]);
  assert.deepEqual(old.buildings.map((b) => b.address), ['13520 104 Ave']);
  assert.equal(old.loose.length, house.length + pair.length + lone.length);
  // buildingOf answers only for a building (review 7).
  assert.equal(buildingOf(pair, pair[0]), null, 'A and B with no main door: a house');
  assert.equal(buildingOf(house, house[0]), null);
  assert.equal(buildingOf(walkup, walkup[0]).units, 3);
});

test('unitWords and doorLine: one way for every key in every place', () => {
  const words = [
    // [key, place, words]
    ['', 'house', 'Main'], ['', 'door', ''], ['', 'building', 'No unit number'],
    ['BSMT', 'house', 'Basement suite'], ['UPPER', 'house', 'Upper suite'], ['LOWER', 'house', 'Lower suite'],
    ['REAR', 'house', 'Rear suite'], ['GARDEN', 'house', 'Garden suite'], ['COACH', 'house', 'Coach house'],
    ['LANE', 'house', 'Laneway house'], ['SUITE', 'house', 'Suite'],
    ['BSMT', 'door', 'Basement suite'], ['BSMT', 'building', 'Basement suite'],
    ['2', 'house', 'Suite 2'], ['B', 'house', 'Suite B'],
    ['1203', 'building', 'Unit 1203'], ['B', 'building', 'Unit B'], ['PH2', 'building', 'Unit PH2'], ['TH5', 'building', 'Unit TH5'],
    ['1203', 'door', 'Unit 1203'], ['B', 'door', 'Unit B'],
    ['SIDE DOOR', 'house', 'Side door'], ['SIDE DOOR', 'building', 'Side door'], ['SIDE DOOR', 'door', 'Side door'],
  ];
  for (const [key, place, want] of words) assert.equal(unitWords(key, place), want, `${key} ${place}`);
  // The words read back as the same key, so a prefilled Unit field is the same door (review 9).
  for (const [key, place] of words) assert.equal(unitKey(unitWords(key, place)), key, `${key} ${place}`);
  for (const key of Object.keys(SUITES)) {
    for (const place of ['house', 'building', 'door']) assert.equal(unitKey(unitWords(key, place)), key);
  }
  for (const t of SUITE_TYPED) assert.equal(unitWords(unitKey(t), 'house'), t === 'Main' ? 'Main' : t);
  // Never the shown words these screens must not use.
  for (const [key, place] of words) assert.doesNotMatch(unitWords(key, place), /Bsmt|—|hi-?rise/i);

  assert.equal(doorLine({ address: '10388 134 St', unit: 'Bsmt' }, 'house'), 'Basement suite · 10388 134 St');
  assert.equal(doorLine({ address: '10388 134 St Bsmt' }, 'door'), 'Basement suite · 10388 134 St');
  assert.equal(doorLine({ address: '10388 134 St', unit: null }, 'house'), 'Main · 10388 134 St');
  assert.equal(doorLine({ address: '10388 134 St', unit: 'Main' }, 'door'), '10388 134 St');
  assert.equal(doorLine({ address: '10388 134 St', unit: '' }), '10388 134 St');
  assert.equal(doorLine({ address: '1203-13450 104 Ave' }, 'building'), 'Unit 1203 · 13450 104 Ave');
  assert.equal(doorLine({ address: '13450 104 Ave', unit: '' }, 'building'), 'No unit number · 13450 104 Ave');
  assert.equal(doorLine({ address: 'B-10500 134 St' }, 'house'), 'Suite B · 10500 134 St');
  assert.equal(doorLine({ address: '10388 134 St', unit: 'Side door' }, 'door'), 'Side door · 10388 134 St');
  assert.equal(doorLine({ address: '10388 134 St', unit: 'Bsmt' }, 'house', { city: 'Surrey' }), 'Basement suite · 10388 134 St, Surrey');
  assert.equal(doorLine({ address: '', unit: 'B' }, 'door'), 'Unit B');
  assert.equal(doorLine({ address: null, unit: null }), '');
  // A door that carries its place (from the server) is worded by it.
  assert.equal(doorLine({ address: 'B-10500 134 St', place: 'house' }), 'Suite B · 10500 134 St');
});

test('houseTag: the map tag names the suite, or counts them', () => {
  assert.equal(houseTag(at('10388 134 St', [null, 'Bsmt'])), '+ Basement suite');
  assert.equal(houseTag(at('10420 134 St', ['Coach house', null, 'Upper'])), '+ 2 suites');
  assert.equal(houseTag(at('10500 134 St', ['B', 'A'])), '+ Suite B');
  assert.equal(houseTag(at('10500 134 St', [null, 'Main'])), '', 'one door written two ways');
  assert.equal(houseTag(at('10388 134 St', [null])), '');
  assert.equal(houseTag([]), '');
});

test('houseCompare: Main first, then suites by rank, then units naturally, then other text', () => {
  const keys = ['10', 'SIDE DOOR', 'COACH', '2', 'B', 'BSMT', '', 'UPPER', 'SUITE', 'LOWER'];
  assert.deepEqual([...keys].sort(houseCompare), ['', 'UPPER', 'LOWER', 'BSMT', 'COACH', 'SUITE', '2', '10', 'B', 'SIDE DOOR']);
});

test('walkOrder: a suite written in the address walks right after its house, Main, Upper, Basement, Coach', () => {
  const d = (address, unit = null) => ({ address, unit, lat: LAT, lng: LNG, persons: [] });
  const label = (x) => `${x.address}${x.unit ? ` / ${x.unit}` : ''}`;
  const out = walkOrder([
    d('10390 134 St'), d('10388 134 St Bsmt'), d('10386 134 St'), d('Bsmt 10388 134 St'),
    d('10388 134 St', 'Coach house'), d('10388 134 St'), d('10388 134 St', 'Upper'),
  ]);
  // Even numbers walk back down the street: 10390, then all of 10388, then 10386.
  assert.deepEqual(out.map(label), [
    '10390 134 St',
    '10388 134 St', '10388 134 St / Upper', '10388 134 St Bsmt', 'Bsmt 10388 134 St', '10388 134 St / Coach house',
    '10386 134 St',
  ]);
});
