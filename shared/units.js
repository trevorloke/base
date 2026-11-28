// Units and suites: one parser, used by the server, the phone and the
// scripts, so every screen and every count reads a door the same way.
//
// Nothing here rewrites what a list says: address and unit stay exactly as
// typed. These functions only work out a copy alongside them.
//
//   unitKey(raw)              a Unit column value (or a unit read off the address) → its key:
//                             '' (the main door) | 'BSMT' … (a suite) | '1203' | 'PH2' | 'B' | 'SIDE DOOR'
//   unitKind(key)             'main' | 'suite' | 'unit' | 'letter' | 'other'
//   splitUnit(address)        "1203-13450 104 Ave" → { unit: '1203', civic: '13450 104 Ave' }; null when
//                             nothing is written inside it (or the form has another reading)
//   normAddr(s)               one spelling for a civic address ("1st Avenue." → "1st ave")
//   doorParts({address,unit}) { civic, shown, unit, kind, house }
//   doorKey(p, { none })      'civic|unit', or the caller's own key when there is no address
//   placeOf(doors)            'building' | 'house' | 'door' for the doors of one civic group
//   houseCompare(a, b)        unit keys: Main, then suites by rank, then units, then other text
//   unitWords(key, place)     'Main' | 'Basement suite' | 'Suite B' | 'Unit 1203' | 'No unit number' | ''
//   doorLine(door, place)     'Basement suite · 10388 134 St'
//   houseTag(doors)           '+ Basement suite' | '+ 2 suites' (the map's tag for a house)
//
// The rules (UNITS.md §2):
//   - a building is 3 or more numbered or lettered units at one civic address;
//     suite words (Main, Basement suite, Upper suite…) and other text never count;
//   - a house with suites is any other address with 2 or more doors (two
//     lettered or numbered doors and no main door, A-/B-, are Suite A and Suite B);
//   - "13450A 104 Ave" (a letter after the number) is its own address, never a suite;
//   - "B-13450 104 Ave" (one letter, a hyphen, a civic of 4 or more digits) is unit B;
//   - a suite word after the street counts only after a short street type, a
//     direction, a comma, brackets or " - ": "123 Upper Rd" and "12345 Park Garden" are streets.

// The parser version: bump it and the server works every row out again.
export const UNIT_V = 1;

// Suite words: the stored key (uppercase ASCII), the words shown, the order at a house.
export const SUITES = {
  '': { words: 'Main', rank: 0 },
  UPPER: { words: 'Upper suite', rank: 1 },
  LOWER: { words: 'Lower suite', rank: 2 },
  BSMT: { words: 'Basement suite', rank: 3 },
  REAR: { words: 'Rear suite', rank: 4 },
  GARDEN: { words: 'Garden suite', rank: 5 },
  COACH: { words: 'Coach house', rank: 6 },
  LANE: { words: 'Laneway house', rank: 7 },
  SUITE: { words: 'Suite', rank: 8 },
};

// The Unit field's suggestions (a datalist); people can still type anything.
export const SUITE_TYPED = ['Main', 'Basement suite', 'Upper suite', 'Lower suite', 'Rear suite', 'Coach house', 'Laneway house', 'Garden suite'];

// What people type → key. A stem may take one tail ("Bsmt suite", "Main
// floor", "Coach house"); a stem marked tail-only needs one ("Carriage house").
const STEMS = {
  BASEMENT: 'BSMT', BSMT: 'BSMT', BSMNT: 'BSMT', BSM: 'BSMT',
  LOWER: 'LOWER', LWR: 'LOWER', DOWNSTAIRS: 'LOWER',
  UPPER: 'UPPER', UPR: 'UPPER', UPSTAIRS: 'UPPER',
  MAIN: '', MN: '',
  REAR: 'REAR', BACK: 'REAR',
  COACH: 'COACH', COACHHOUSE: 'COACH',
  LANEWAY: 'LANE', LANE: 'LANE',
  GARDEN: 'GARDEN',
};
const TAIL_ONLY = { CARRIAGE: 'COACH' };
const TAILS = ['SUITE', 'STE', 'HOUSE', 'HOME', 'LEVEL', 'FLOOR', 'UNIT'];
// Words that mean "no unit": the main door.
const NO_UNIT = new Set(['', 'N/A', 'NA', 'NONE', 'NIL', '-', '--', '0', '#', 'NO UNIT', 'NO UNIT NUMBER']);

// The suite words as a pattern for reading them inside an address.
const SUITE_WORD = `(?:(?:${[...Object.keys(STEMS), ...Object.keys(TAIL_ONLY)].sort((a, b) => b.length - a.length).join('|')})\\.?(?:\\s+(?:${TAILS.join('|')})\\.?)?|suite\\.?)`;
// A unit token inside an address. In the bare hyphen form a unit has 1–4
// digits (splitUnit checks); after an explicit word or '#', 1–5.
const UNIT5 = '[a-z]{0,2}\\d{1,5}[a-z]?';
// The same with a space or hyphen after its letters ("TH 5", "PH-1"): unitKey
// reads it as the compact form (TH5, PH1).
const UNIT5S = '[a-z]{1,2}(?:\\s?-\\s?|\\s)\\d{1,5}[a-z]?';
// The words that say "a unit follows" (a whole word, never "Northside" → "rthside").
// Not "No.": in front of a number it is the house number ("No. 10388 134 St").
const UNIT_WORD = '(?:unit|apt|apartment|suite|ste|rm|room)\\.?';

const UNIT_RE = /^[A-Z]{0,2}\d{1,5}[A-Z]?$/;
const LETTER_RE = /^[A-Z]$/;
const CIVIC_RE = /^\d+[a-z]?\s+[a-z0-9]/i;
const civicOk = (s) => CIVIC_RE.test(s);

// Street types and directions (as server/lib/address.js reads a house number).
export const STREET_TYPES = new Set(['ave', 'avenue', 'st', 'street', 'blvd', 'boulevard', 'rd', 'road', 'dr', 'drive', 'cres', 'crescent',
  'pl', 'place', 'way', 'lane', 'ln', 'crt', 'court', 'ct', 'hwy', 'highway', 'pkwy', 'parkway', 'cir', 'circle', 'terr', 'terrace',
  'close', 'gate', 'mews', 'row', 'trail', 'diversion', 'div', 'connector', 'loop', 'link', 'grove', 'green', 'bay', 'cove', 'rise',
  'ridge', 'hill', 'park', 'square', 'sq', 'walk', 'wynd', 'pt', 'point', 'pathway', 'path', 'alley', 'byway']);
export const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
// A bare suite word may follow only these: none of them is also a common
// word in a street's name ("Park", "Green", "Hill" are; review 21).
const SUFFIX_AFTER = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'blvd', 'boulevard', 'cres', 'crescent',
  'pl', 'place', 'ct', 'court', 'way', 'hwy', 'highway']);

// Dashes, no-break spaces and runs of space, as one form.
const tidy = (s) => String(s ?? '').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u00a0\u2007\u202f]/g, ' ')
  .replace(/\s+/g, ' ').trim();

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const suiteOf = (text) => {
  if (has(STEMS, text)) return STEMS[text];
  if (text === 'SUITE') return 'SUITE';
  const m = text.match(/^(\S+) (\S+)$/);
  if (m && TAILS.includes(m[2])) {
    if (has(STEMS, m[1])) return STEMS[m[1]];
    if (has(TAIL_ONLY, m[1])) return TAIL_ONLY[m[1]];
  }
  return undefined;
};

// A Unit column value (or a unit found in the address) → its key.
export const unitKey = (raw) => {
  let s = tidy(raw).toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  if (NO_UNIT.has(s)) return '';
  // One leading prefix, as a whole word ("SUITE" only when something follows).
  s = s.replace(/^(?:#|(?:NO|UNIT|APT|APARTMENT|STE|RM|ROOM)(?=[\s#\d]|$)|SUITE(?=\s*\S))\s*#?\s*/, '').trim();
  if (NO_UNIT.has(s)) return '';
  const suite = suiteOf(s);
  if (suite !== undefined) return suite;
  // Letters, a space or hyphen, digits: one unit however it is typed ("TH 5", "TH-5" → TH5).
  const spaced = s.match(/^([A-Z]{1,2})\s?-?\s?(\d{1,5}[A-Z]?)$/);
  if (spaced) return `${spaced[1]}${spaced[2]}`;
  return s;
};

export const unitKind = (key) => {
  const k = String(key ?? '');
  if (k === '') return 'main';
  if (has(SUITES, k)) return 'suite';
  if (UNIT_RE.test(k)) return 'unit';
  if (LETTER_RE.test(k)) return 'letter';
  return 'other';
};

// Each form splitUnit reads, made once.
const TOKEN = `(${SUITE_WORD}|${UNIT5}|[a-z])`;
// At the end of the address a unit may have a space or hyphen after its letters.
const TOKEN_END = `(${SUITE_WORD}|${UNIT5}|${UNIT5S}|[a-z])`;
const BEFORE = `^(?:#|${UNIT_WORD}(?=[\\s#\\d]))\\s*#?\\s*`;
const RE = {
  hyphen: new RegExp(`^(#\\s*)?(${UNIT5}|${UNIT5S}|[a-z]|${SUITE_WORD})\\s*-\\s*(\\d{4,})(\\s.*)$`, 'i'),
  wordBeforeSpaced: new RegExp(`${BEFORE}(${UNIT5S})\\s*(?:,|\\s-)?\\s+(.*)$`, 'i'),
  wordBefore: new RegExp(`${BEFORE}${TOKEN}\\s*(?:,|\\s-)?\\s+(.*)$`, 'i'),
  suiteBefore: new RegExp(`^(${SUITE_WORD})\\s*(?:,|-)?\\s*(\\d.*)$`, 'i'),
  hashAfter: new RegExp(`^(.*?)\\s*,?\\s*#\\s*${TOKEN_END}$`, 'i'),
  wordAfter: new RegExp(`^(.*?)\\s*,?\\s+${UNIT_WORD}\\s*#?\\s*${TOKEN_END}$`, 'i'),
  suiteAfterMark: new RegExp(`^(.*?\\S)\\s*(?:,|\\s-)\\s*(${SUITE_WORD})$`, 'i'),
  suiteInBrackets: new RegExp(`^(.*?\\S)\\s*\\(\\s*(${SUITE_WORD})\\s*\\)$`, 'i'),
  suiteAfter: new RegExp(`^(.*?\\S)\\s+(${SUITE_WORD})$`, 'i'),
};

const isSuiteWord = (s) => unitKind(unitKey(s)) === 'suite' || unitKey(s) === '';

// The unit written inside the address, in the forms lists and typing use.
// Read only: nothing writes it back. Never split: "1203 13450 104 Ave" (two
// numbers and a space), "13450A 104 Ave" (a letter after the number), a
// range like "12345-12347" (the right part must be longer), a suite word
// after a name word ("123 Upper Rd"), and any form that would leave a
// numbered street with no house ("#12345 104 Ave" is house 12345, not unit
// 12345 of "104 Ave").
export const splitUnit = (address) => {
  const s = tidy(address);
  if (!s) return null;
  // What is left must be a house number and its street.
  const out = (unit, civic) => {
    const c = String(civic).replace(/^[\s,\-]+|[\s,]+$/g, '');
    return civicOk(c) && houseOf(c) ? { unit: unit.trim(), civic: c } : null;
  };
  // Hyphen: unit-CIVIC (Canada Post's own form), the civic 4 or more digits
  // and longer than the unit's digits.
  let m = s.match(RE.hyphen);
  if (m) {
    const [, hash, unit, num, rest] = m;
    const digits = (unit.match(/\d+/) || [''])[0];
    const word = !digits && unit.length > 1;
    if (word && !isSuiteWord(unit)) return null;
    if (digits && digits.length > (hash ? 5 : 4)) return null;
    return num.length > digits.length ? out(unit, `${num}${rest}`) : null;
  }
  // '#' or a word before: "#1203 13450 …", "Unit 5, 13450 …", "Unit B 10388 …", "Unit Bsmt 10388 …".
  // ("Unit TH 5 10150 …" first, kept only when a house follows: "Unit B 10388 134 St" is unit B.)
  m = s.match(RE.wordBeforeSpaced);
  const spaced = m ? out(m[1], m[2]) : null;
  if (spaced) return spaced;
  m = s.match(RE.wordBefore);
  if (m && (/\d/.test(m[1]) || m[1].length === 1 || isSuiteWord(m[1]))) return out(m[1], m[2]);
  if (m) return null;
  // A suite word before: "Bsmt 10388 134 St", "Basement suite, 10388 …", "Upper 10388 …".
  // (What follows must be a house, not a numbered street: "Upper 104 Ave" stays.)
  m = s.match(RE.suiteBefore);
  if (m && isSuiteWord(m[1])) return out(m[1], m[2]);
  // '#' or a word after: "13450 104 Ave #1203", "… Unit 12A", "… Ste 210", "… Unit B", "… #Bsmt".
  m = s.match(RE.hashAfter) || s.match(RE.wordAfter);
  if (m && (/\d/.test(m[2]) || m[2].length === 1 || isSuiteWord(m[2]))) return out(m[2], m[1]);
  // A suite word after the street: after a comma, in brackets, after " - ",
  // or bare after a short street type (and an optional direction).
  m = s.match(RE.suiteAfterMark) || s.match(RE.suiteInBrackets);
  if (m && isSuiteWord(m[2])) return out(m[2], m[1]);
  // (The shortest street, so the suite word is the longest: "… St Basement suite".)
  m = s.match(RE.suiteAfter);
  if (m && isSuiteWord(m[2])) {
    const words = m[1].toLowerCase().replace(/[.,]/g, '').split(' ');
    let last = words.length - 1;
    if (DIRECTIONS.has(words[last]) && last > 1) last -= 1;
    // The street type must follow a street's name or number, not be the whole street.
    if (last >= 2 && SUFFIX_AFTER.has(words[last])) return out(m[2], m[1]);
  }
  return null;
};

const FOLD = {
  avenue: 'ave', street: 'st', road: 'rd', drive: 'dr', boulevard: 'blvd',
  crescent: 'cres', place: 'pl', court: 'ct', highway: 'hwy',
};
export const normAddr = (s) => String(s ?? '').toLowerCase().replace(/[.,#]/g, ' ').trim().split(/\s+/)
  .map((w) => FOLD[w] || w).join(' ');

// The leading house number of a civic line ("13450A"), or null for a
// numbered street on its own ("104 Ave").
const houseOf = (shown) => {
  const m = /^(\d+[A-Za-z]?)\s+(.+)$/.exec(shown);
  if (!m) return null;
  const rest = m[2].toLowerCase().replace(/[.,]/g, '').split(' ').filter((w) => !DIRECTIONS.has(w));
  if (rest.length === 1 && STREET_TYPES.has(rest[0])) return null;
  return m[1];
};

// One door's parts. The Unit column wins when both are set (and says
// something: blank, "Main" or "N/A" there leaves the address's unit).
const partsOf = (address, unit) => {
  const a = tidy(address);
  const split = a ? splitUnit(a) : null;
  const shown = split ? split.civic : a;
  const key = unitKey(unit) || (split ? unitKey(split.unit) : '');
  return {
    civic: shown ? normAddr(shown) : '',
    shown,
    unit: key,
    kind: unitKind(key),
    house: shown ? houseOf(shown) : null,
  };
};
// Grouping asks for one door's parts several times: they are kept per door
// object while its address and unit stay the same (a copy is handed out).
const kept = new WeakMap();
export const doorParts = (door) => {
  if (!door || typeof door !== 'object') return partsOf(null, null);
  const { address, unit } = door;
  let k = kept.get(door);
  if (!k || k.address !== address || k.unit !== unit) {
    k = { address, unit, parts: partsOf(address, unit) };
    kept.set(door, k);
  }
  return { ...k.parts };
};

// The door key: 'civic|unit'. With no address, the caller's own key
// (person:<id>, @lat,lng …), so nothing else moves; by default the person.
export const doorKey = (p, { none } = {}) => {
  if (!tidy(p?.address)) return none ? none(p) : `person:${p?.id ?? ''}`;
  const { civic, unit } = doorParts(p);
  return `${civic}|${unit}`;
};

const rankOf = (key) => (has(SUITES, key) ? SUITES[key].rank : null);
const kindRank = { main: 0, suite: 1, unit: 2, letter: 2, other: 3 };

// Unit keys at a house: Main first, then suites by rank, then units and
// letters naturally, then any other text.
export const houseCompare = (a, b) => {
  const ka = String(a ?? '');
  const kb = String(b ?? '');
  const ra = kindRank[unitKind(ka)];
  const rb = kindRank[unitKind(kb)];
  if (ra !== rb) return ra - rb;
  if (ra <= 1) return rankOf(ka) - rankOf(kb);
  return ka.localeCompare(kb, 'en', { numeric: true });
};

// How many numbered or lettered units make an address a building.
export const BUILDING_MIN = 3;

// The doors of one civic group (as buildings.js groups them: one civic
// address, near one pin). min: how many numbered or lettered units make a building.
export const placeOf = (doors, min = BUILDING_MIN) => {
  const keys = new Set((doors || []).map((d) => doorParts(d).unit));
  let units = 0;
  for (const k of keys) {
    const kind = unitKind(k);
    if (kind === 'unit' || kind === 'letter') units += 1;
  }
  if (units >= min) return 'building';
  return keys.size >= 2 ? 'house' : 'door';
};

const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

// The words for a unit key in a place ('building' | 'house' | 'door').
export const unitWords = (key, place = 'door') => {
  const k = String(key ?? '');
  const kind = unitKind(k);
  if (kind === 'main') return place === 'house' ? 'Main' : place === 'building' ? 'No unit number' : '';
  if (kind === 'suite') return SUITES[k].words;
  if (kind === 'unit' || kind === 'letter') return place === 'house' ? `Suite ${k}` : `Unit ${k}`;
  return sentence(k);
};

// '<words> · <address>', always this order and this separator. The place
// is the caller's, or the door's own (as the server sends it), else 'door'.
export const doorLine = (door, place, { city } = {}) => {
  const parts = doorParts(door || {});
  const words = unitWords(parts.unit, place || door?.place || 'door');
  const addr = parts.shown ? (city ? `${parts.shown}, ${city}` : parts.shown) : '';
  return [words, addr].filter(Boolean).join(' · ');
};

// The map's tag under a house: the one other door's words, or how many.
export const houseTag = (doorsAtHouse) => {
  const keys = [...new Set((doorsAtHouse || []).map((d) => doorParts(d).unit))].sort(houseCompare);
  const others = keys.slice(1);
  if (!others.length) return '';
  return others.length === 1 ? `+ ${unitWords(others[0], 'house')}` : `+ ${others.length} suites`;
};
