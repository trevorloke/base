// Import people — three steps, one button each: choose a CSV (or paste it),
// match its columns to Starbase fields and check it (a dry run: nothing is
// saved), then import it in chunks of 1,000 and place everyone on the map.
// The CSV is parsed here in the browser; the server validates, dedupes against
// people already on file (email → name+phone → name+address; a row with none
// of those matches a person of the same name who has none either) and merges
// by filling blanks only — so importing the same file again adds no one twice.
// Desk roles only — volunteers are sent back to People.
import { useEffect, useMemo, useRef, useState } from 'react';
import { readXlsx, toCsv } from '../components/xlsx.js';
import { Link, Navigate, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { matchRating, offeredCandidates, offeredCodes } from '@starbase/shared/scale';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import { splitFirst } from '@starbase/shared/names';
import { apiPost } from '../api.js';
import GeocodeButton from '../components/GeocodeButton.jsx';
import { RatingChip, useScale } from '../components/RatingButtons.jsx';
import { invalidatePersonData, tagWord } from './People.jsx';
import { FIELD_KEY, fieldCell, useImportFields } from '../components/FieldsBits.jsx';
import './import.css';
import '../components/voter-number.css';

const DESK = ['manager', 'treasurer', 'staff'];
const CHECK_CHUNK = 2000; // server max per call
const IMPORT_CHUNK = 1000;
// A whole voter file (~500,000 rows, 250 MB) fits; the cap keeps the text
// well under what a browser can hold as one string (~512 million characters).
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const PARSE_SLICE = 20000; // rows parsed between breaths, so the page stays alive
const TAG_MAX = 40;

const fmtN = (n) => Number(n || 0).toLocaleString('en-CA');
const fmtMB = (bytes) => `${fmtN(Math.max(1, Math.round(bytes / (1024 * 1024))))} MB`;
// Let the browser paint (a progress line) before the next stretch of work.
const breathe = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
  else setTimeout(resolve, 0);
});
const plural = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : many}`;

// ─────────────────────────────────────────────────────────────────────────────
// CSV parsing
// ─────────────────────────────────────────────────────────────────────────────

const DELIMS = [',', ';', '\t'];
const DELIM_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

// Count each candidate delimiter outside quotes on the first non-blank line.
export function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  let seen = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') { if (seen) break; continue; }
    if (ch in counts) counts[ch] += 1;
    if (ch.trim()) seen = true;
  }
  let best = ',';
  for (const d of DELIMS) if (counts[d] > counts[best]) best = d;
  return best;
}

// RFC 4180-ish, forgiving: quoted fields with "" escapes, delimiters and
// newlines inside quotes, CRLF / LF / CR line ends, a leading BOM, spaces
// before an opening quote, and stray text after a closing quote.
// → { delimiter, rows: string[][] } (blank lines kept as [''] so row numbers
// match the spreadsheet).
export function parseCSV(input, forced) {
  const p = csvParser(input, forced);
  p.step(Infinity);
  return { delimiter: p.delimiter, rows: p.rows };
}

// The same parse a slice at a time: step(max) reads up to max more rows and
// says whether it reached the end; at() is how far through the text it is (0–1).
function csvParser(input, forced) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = forced || detectDelimiter(text);
  const rows = [];
  let row = [];
  const n = text.length;
  let i = 0;
  const endRow = () => { rows.push(row); row = []; };
  const step = (max) => {
    const stop = rows.length + max;
    while (i < n && rows.length < stop) {
      // Start of a field. Allow spaces before an opening quote.
      let j = i;
      while (j < n && (text[j] === ' ' || (text[j] === '\t' && delim !== '\t'))) j++;
      if (text[j] === '"') {
        let value = '';
        let k = j + 1;
        for (;;) {
          const q = text.indexOf('"', k);
          if (q === -1) { value += text.slice(k); k = n; break; } // unterminated: take the rest
          value += text.slice(k, q);
          if (text[q + 1] === '"') { value += '"'; k = q + 2; continue; }
          k = q + 1;
          break;
        }
        // Anything between the closing quote and the next delimiter/newline.
        let e = k;
        while (e < n && text[e] !== delim && text[e] !== '\n' && text[e] !== '\r') e++;
        value += text.slice(k, e).trim() ? text.slice(k, e) : '';
        row.push(value);
        i = e;
      } else {
        let e = i;
        while (e < n && text[e] !== delim && text[e] !== '\n' && text[e] !== '\r') e++;
        row.push(text.slice(i, e));
        i = e;
      }
      if (i >= n) { endRow(); break; }
      const ch = text[i];
      if (ch === delim) {
        i += 1;
        if (i >= n) { row.push(''); endRow(); }
      } else {
        // newline: \r\n, \n or \r
        i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        endRow();
      }
    }
    return i >= n;
  };
  return { delimiter: delim, rows, step, at: () => (n ? i / n : 1) };
}

const isBlankRow = (cells) => cells.every((c) => !String(c).trim());

// Bytes → text. UTF-8 first; UTF-16 when it has a BOM (Excel "Unicode text");
// otherwise Windows-1252, which is what older Excel saves as "CSV".
function decodeBytes(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

const isSpreadsheetBinary = (buf, name) => {
  const b = new Uint8Array(buf.slice(0, 4));
  const zip = b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; // .xlsx / .numbers
  const ole = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; // .xls
  return zip || ole || /\.(xlsx|xlsm|xls|numbers|ods)$/i.test(name || '');
};

// Does the first row hold a person rather than column names? People paste
// rows with no header line. Data: an email, a phone number, a postal code or
// a house number in it — and no cell that is a column name we know.
const HOUSE_RE = /^\d{1,6}[a-z]?\s+\S/i;
const isHeaderWord = (cell) => {
  const n = normHeader(cell);
  return Boolean(n) && EXACT.some(([, re]) => re.test(n));
};
export function looksLikeData(cells) {
  const vals = cells.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (!vals.length || vals.some(isHeaderWord)) return false;
  return vals.some((v) => EMAIL_RE.test(v) || PHONE_RE.test(v) || POSTAL_RE.test(v) || HOUSE_RE.test(v));
}

// Text → { delimiter, all: [{ cells, row }], header } or { error }.
// header: whether the first non-blank row is column names (a guess).
// A big file is parsed a slice at a time; progress(share) hears how far (0–1).
// what: what a row of the file is, for the words (the gift import's: gifts).
const PEOPLE = { one: 'person', many: 'people' };
async function readTable(text, progress, what = PEOPLE) {
  const empty = { error: `That file is empty. Choose a CSV with at least one ${what.one} in it.` };
  if (!text || !/\S/.test(text)) return empty;
  const parser = csvParser(text);
  while (!parser.step(PARSE_SLICE)) {
    progress?.(parser.at());
    await breathe();
  }
  const { delimiter, rows } = parser;
  const all = [];
  rows.forEach((cells, i) => { if (!isBlankRow(cells)) all.push({ cells, row: i + 1 }); }); // spreadsheet row numbers
  if (!all.length) return empty;
  return { delimiter, all, header: !looksLikeData(all[0].cells) };
}

// The rows, with or without the first as column names → { headers, records } or { error }.
function shapeTable(all, header, what = PEOPLE) {
  const head = header ? all[0].cells : [];
  const records = header ? all.slice(1) : all;
  if (records.length === 0) {
    return { error: `There’s a header row but no ${what.many} under it. Check you saved the whole sheet.` };
  }
  let width = Math.min(500, Math.max(head.length, ...records.slice(0, 500).map((r) => r.cells.length)));
  // Drop trailing columns with no header and nothing in them ("a,b," on every line).
  const emptyCol = (i) => !String(head[i] ?? '').trim() && records.every((r) => !String(r.cells[i] ?? '').trim());
  while (width > 1 && emptyCol(width - 1)) width -= 1;
  const headers = Array.from({ length: width }, (_, i) => String(head[i] ?? '').trim() || `Column ${i + 1}`);
  return { headers, records };
}

// ─────────────────────────────────────────────────────────────────────────────
// Column mapping
// ─────────────────────────────────────────────────────────────────────────────

const FIELDS = [
  { key: 'name', label: 'Full name' },
  { key: 'first', label: 'First name' },
  { key: 'middle', label: 'Middle name' },
  { key: 'last', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'house_number', label: 'House number' },
  { key: 'address', label: 'Street address' },
  { key: 'unit', label: 'Unit / apt' },
  { key: 'city', label: 'City' },
  { key: 'postal', label: 'Postal code' },
  { key: 'voter_number', label: 'Voter number' },
  { key: 'tags', label: 'Tags' },
  { key: 'rating', label: 'Rating (the scale)' },
  { key: 'lat', label: 'Latitude' },
  { key: 'lng', label: 'Longitude' },
  { key: 'volunteer', label: 'Volunteer (1/0 → tag)' },
  { key: 'donor', label: 'Donor (1/0 → tag)' },
  { key: 'voted', label: 'Voted (1/0 or a date)' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'x', label: 'X (Twitter)' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'reddit', label: 'Reddit' },
];
const SKIP = '';
const fieldLabel = (key) => FIELDS.find((f) => f.key === key)?.label || key;
const FIELD_WORD = { socials: 'social handles', email: 'email', phone: 'phone', address: 'address', house_number: 'house number', unit: 'unit', city: 'city', postal: 'postal code', voter_number: 'voter number', tags: 'tags', rating: 'rating', lat: 'latitude', lng: 'longitude', volunteer: 'volunteer tag', donor: 'donor tag', voted: 'voted', instagram: 'Instagram', x: 'X', tiktok: 'TikTok', reddit: 'Reddit' };
const MULTI = new Set(['tags']); // several columns can feed tags; every other field takes one column

const normHeader = (h) =>
  String(h || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// A profile field's name against a column's, in any script ("语言", "ਭਾਸ਼ਾ"):
// every language's letters, digits and vowel signs count, Latin accents
// fold as above; a name of only symbols is empty and matches nothing.
const fieldKey = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');

// Exact header names first, then looser "contains" rules, then the values.
const EXACT = [
  ['email', /^(e?mail|emailaddress|emailaddr|primaryemail|personalemail|homeemail|email\d|courriel)$/],
  ['first', /^(first|firstname|fname|given|givenname|forename|firstnames)$/],
  ['middle', /^(middle|middlename|middlenames|middleinitial|mi|mname|secondname)$/],
  ['last', /^(last|lastname|lname|surname|familyname)$/],
  ['name', /^(name|fullname|contactname|displayname|votername|membername|donorname|person|contact|names)$/],
  ['phone', /^(phone|phonenumber|phoneno|tel|telephone|mobile|mobilephone|mobilenumber|cell|cellphone|cellnumber|primaryphone|phone\d)$/],
  ['house_number', /^(housenumber|houseno|housenum|hsenum|civicnumber|civicno|streetnumber|streetno|stnum|number|no)$/],
  ['lat', /^(lat|latitude|ylat|y)$/],
  ['lng', /^(lng|lon|long|longitude|xlong|x)$/],
  ['volunteer', /^(volunteer|isvolunteer|volunteerflag|vol)$/],
  ['donor', /^(donor|isdonor|donorflag)$/],
  ['voted', /^(voted|hasvoted|didvote|votedyn|voted10)$/],
  ['unit', /^(unit|unitnumber|unitno|houseunit|apt|aptno|aptnumber|apartment|suite|suiteno|address2|addressline2|street2)$/],
  ['address', /^(address|streetaddress|streetaddress1|address1|addressline1|street|street1|streetname|civicaddress|homeaddress|residentialaddress|mailingaddress|addr)$/],
  ['city', /^(city|town|municipality|locality|cityname)$/],
  ['postal', /^(postal|postalcode|postcode|zip|zipcode|pc)$/],
  // The list of electors' own number for each voter (never a bare "ID": that is the rating's).
  ['voter_number', /^(voternumber|voterno|voternum|voterid|votersid|voteridnumber|electorid|electornumber|electorno)$/],
  ['tags', /^(tags?|groups?|labels?|lists?|segments?|categories|category)$/],
  ['rating', /^(rating|supportlevel|supportid|id|idlevel|supportscore|canvassid|canvassrating|doorrating)$/],
  ['instagram', /^(instagram|insta|ig|instagramhandle|instagramusername)$/],
  ['x', /^(twitter|xhandle|twitterhandle|twitterusername|xtwitter|twitterx)$/],
  ['tiktok', /^(tiktok|tiktokhandle|tiktokusername)$/],
  ['reddit', /^(reddit|reddithandle|redditusername|redditname)$/],
];
const CONTAINS = [
  ['email', /e?mail/],
  ['first', /firstname|givenname|forename/],
  ['middle', /middlename|middleinitial/],
  ['last', /lastname|surname|familyname/],
  ['phone', /^(?!home).*(phone|mobile|cellular)|^cell|^tel/],
  ['house_number', /housenumber|civicnumber|streetnumber/],
  ['lat', /latitude/],
  ['lng', /longitude/],
  ['postal', /postal|postcode|zip/],
  ['voter_number', /voterid|voternumber|electorid|electornumber/],
  ['unit', /^(unit|apt|suite)|(house|home|suite|apt)unit$/],
  ['address', /address|street/],
  ['city', /(^|home|mailing|mail|res|residential|billing|primary|registered)city|^town|municipal/],
  ['tags', /^tags?|tags?$|groups?$|labels?$|segments?$/],
  ['rating', /support|rating/],
  ['instagram', /instagram/],
  ['x', /twitter/],
  ['tiktok', /tiktok/],
  ['reddit', /reddit/],
  ['voted', /^voted/],
  ['name', /^(?!.*(user|file|middle|nick)).*name/],
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// With no column names, a column of "Mira Chen"s is the name (2–4 words, letters only).
const NAME_RE = /^\p{L}[\p{L}'’.-]*(?:\s+\p{L}[\p{L}'’.-]*){1,3}$/u;
const POSTAL_RE = /^[a-z]\d[a-z][ -]?\d[a-z]\d$/i;
const PHONE_RE = /^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(\s*(x|ext\.?)\s*\d+)?$/i;

// The campaign's scale (its codes and words, any case): "4d " → 4D, "4 D" →
// 4D, "1.0" → 1 (spreadsheets love a trailing .0), "Strong yes" → 1,
// "locke" → 4B. A new rating must be on the list (off it: comes in unrated).
// share: a "Support" column may hold the odd typo; a bare "ID" column must be all ratings.
const looksLikeRatings = (scale, values, share = 1) =>
  values.length > 0 && values.filter((v) => matchRating(scale, v)).length / values.length >= share;
const mostly = (values, re, share = 0.8) => values.length > 0 && values.filter((v) => re.test(v)).length / values.length >= share;
// Loose header guesses must also look right ("Email opt-in" holding yes/no is not an email column).
const COORD_RE = /^-?\d{1,3}(\.\d+)?$/;
const VALUE_CHECK = { email: EMAIL_RE, phone: PHONE_RE, postal: POSTAL_RE, lat: COORD_RE, lng: COORD_RE };

const columnValues = (records, i, limit = 200) => {
  const out = [];
  for (const r of records) {
    const v = String(r.cells[i] ?? '').trim();
    if (v) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
};

// custom: the campaign's profile fields ({ key, label }), matched by name.
function guessMapping(scale, headers, records, noHeader = false, custom = []) {
  const out = headers.map(() => SKIP);
  const taken = new Set();
  const values = headers.map((_, i) => columnValues(records, i));
  const claim = (i, key, loose = false) => {
    if (out[i] !== SKIP) return;
    if (!MULTI.has(key) && taken.has(key)) return;
    if (key === 'rating' && !looksLikeRatings(scale, values[i], /^(id|idlevel)$/.test(normHeader(headers[i])) ? 1 : 0.9)) return; // "ID" only if it holds 1/2/3/4/4D…
    if (loose && VALUE_CHECK[key] && values[i].length && !mostly(values[i], VALUE_CHECK[key], 0.6)) return;
    if (key === 'name' && mostly(values[i], EMAIL_RE)) return; // a "Contact" column of emails isn't a name
    // A voter's own number: different on every row, with digits. A "Voter ID
    // verified" column of yes/no (or any number that repeats) is not it —
    // read as one, everyone who shares a value would be made one person.
    if (key === 'voter_number' && values[i].length && (new Set(values[i].map((v) => v.toUpperCase())).size < values[i].length || !mostly(values[i], /\d/))) return;
    out[i] = key;
    taken.add(key);
  };
  const pass = (rules, loose) => headers.forEach((h, i) => {
    if (out[i] !== SKIP) return;
    const n = normHeader(h);
    const hit = rules.find(([, re]) => re.test(n));
    if (hit) claim(i, hit[0], loose);
  });
  pass(EXACT, false);
  headers.forEach((h, i) => {
    const k = fieldKey(h);
    const hit = k ? custom.find((x) => fieldKey(x.label) === k) : null;
    if (hit) claim(i, hit.key);
  });
  pass(CONTAINS, true);
  headers.forEach((_, i) => {
    if (out[i] !== SKIP || !values[i].length) return;
    if (mostly(values[i], EMAIL_RE)) claim(i, 'email');
    else if (mostly(values[i], POSTAL_RE)) claim(i, 'postal');
    else if (mostly(values[i], PHONE_RE)) claim(i, 'phone');
  });
  // No column names at all: guess the name and street from the values too.
  if (noHeader) {
    headers.forEach((_, i) => {
      if (out[i] !== SKIP || !values[i].length) return;
      if (mostly(values[i], HOUSE_RE)) claim(i, 'address');
      else if (!taken.has('first') && !taken.has('last') && mostly(values[i], NAME_RE)) claim(i, 'name');
    });
  }
  return out;
}

// What a value in the rating column means: what the person picked for it
// under "What each rating means" (ratingMap: the value, lower-cased → a
// code, or '' for unrated), else the scale's own reading, else nothing.
// A list's 5 can be this campaign's 1 — the scale has no way to know.
const resolveRating = (scale, ratingMap, v) => {
  const k = v.toLowerCase();
  if (ratingMap && Object.hasOwn(ratingMap, k)) return ratingMap[k] || null;
  const m = matchRating(scale, v);
  return m && !m.off ? m.code : null;
};
// The rating column's distinct values, most common first (capped: a column
// that is really free text would list thousands).
const RATING_VALUES_MAX = 40;
const ratingValuesOf = (records, col) => {
  const counts = new Map();
  if (col === -1) return { values: [], more: 0 };
  for (const r of records) {
    const v = String(r.cells[col] ?? '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    const cur = counts.get(k);
    if (cur) cur.n += 1; else counts.set(k, { value: v, n: 1 });
  }
  const all = [...counts.values()].sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
  return { values: all.slice(0, RATING_VALUES_MAX), more: Math.max(0, all.length - RATING_VALUES_MAX) };
};

// One CSV record → the server's row shape (only filled fields are sent).
// A rating that isn't on the scale is left off: the server rejects the whole
// row for it, and losing the person is worse than losing a bad rating.
// A phone number Excel turned into "1.6047E+10": its last digits are gone,
// so it is never imported as a number (the check step says which column).
export const SCI_RE = /^\d(\.\d+)?e\+?\d+$/i;
// Volunteer roles carried as tags: "Vol: Door Knocker", "Volunteer - GOTV",
// or any value of a Tags column whose heading says volunteer ("Volunteer
// Lists"). Each one found is offered under "Volunteer roles", where the
// person importing says which role it is (or keeps it a tag only); the
// tags themselves come in as they are.
const ROLE_TAG_RE = /^\s*vol(?:unteer)?\s*[:\-–]\s*(.+)$/i;
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
// A first reading of the words: "Door Knocker" → Doorknocking; nothing
// sure → a tag only.
const ROLE_WORDS = [
  [/door|knock|canvass/, 'doorknocking'], [/phon|call/, 'phoning'], [/driv|ride/, 'driver'],
  [/scrut/, 'scrutineer'], [/runner/, 'runner'], [/greet/, 'poll_greeter'], [/dataentry|data/, 'data_entry'],
  [/event|host/, 'event_hosting'], [/zone|housecaptain/, 'zone_house_captain'], [/hirise|highrise|building/, 'highrise_captain'],
  [/food|cook/, 'food'], [/transl|interpret/, 'translation'], [/burma/, 'burmashave'], [/committee/, 'community_committee'],
  [/aide|candidate/, 'candidate_aide'], [/social|instagram|tiktok/, 'social_media'], [/photo|video|camera/, 'photo_video'],
  [/policy/, 'policy'], [/admin|office/, 'administration'], [/mainstreet|street/, 'mainstreeting'],
];
export const guessRole = (word) => {
  const w = squash(word);
  if (!w) return '';
  const exact = VOLUNTEER_ROLES.find((r) => squash(r.label) === w || squash(r.code) === w);
  if (exact) return exact.code;
  return ROLE_WORDS.find(([re]) => re.test(w))?.[1] || '';
};
// The role words a tag carries, or null: from a "Vol:" tag, or any tag in a
// volunteer column (volCol).
const roleWord = (tag, volCol) => { const m = ROLE_TAG_RE.exec(tag); return m ? m[1].trim() : (volCol ? tag : null); };
const resolveRole = (roleMap, word) => (Object.hasOwn(roleMap || {}, word.toLowerCase()) ? roleMap[word.toLowerCase()] : guessRole(word));

// A list's own record of each person's last interaction (Interaction Status
// + Interaction Date) and its Sign column. Under "Past conversations" each
// status is read as a knock or a call ("Not Home" → at the door, not home)
// or left a profile field only; under "Signs" each Sign value as a lawn sign
// to put up, one that's up, or the field only. Read, they come in as that
// day's knock (or call) and a sign on the sign list (ext/importhistory).
const STATUS_HEADS = ['interactionstatus', 'contactstatus', 'canvassstatus', 'doorstatus', 'laststatus'];
const DATE_HEADS = ['interactiondate', 'contactdate', 'canvassdate', 'lastcontact', 'lastcontacted', 'lastinteraction'];
const SIGN_HEADS = ['sign', 'signs', 'lawnsign', 'signrequest', 'wantssign'];
export const HISTORY_CHOICES = [
  ['door', [['door:contacted', 'Talked'], ['door:no_answer', 'Not home'], ['door:refused', 'Refused'], ['door:moved', 'Moved'], ['door:inaccessible', 'Couldn’t get to the door'], ['door:left_lit', 'Left lit']]],
  ['phone', [['phone:contacted', 'Talked'], ['phone:no_answer', 'No answer'], ['phone:refused', 'Refused'], ['phone:left_message', 'Left a message'], ['phone:moved', 'Wrong number / moved']]],
];
export const guessHistory = (value) => {
  const w = squash(value);
  if (!w) return '';
  if (/nothome|notin|noanswer|^nh$|^na$|away/.test(w)) return 'door:no_answer';
  if (/refus|hostile|declin|slam|donotcall|dnc/.test(w)) return 'door:refused';
  if (/moved|deceased|wrongaddress|vacant/.test(w)) return 'door:moved';
  if (/inaccess|noaccess|locked|gated|nosolicit/.test(w)) return 'door:inaccessible';
  if (/lit|flyer|leaflet|literature|dropped/.test(w)) return 'door:left_lit';
  if (/voicemail|message|^vm$/.test(w)) return 'phone:left_message';
  if (/wrongnumber|badnumber/.test(w)) return 'phone:moved';
  if (/talk|spoke|contacted|reached|conversation|answered|home/.test(w)) return 'door:contacted';
  return '';
};
const NO_RE = /^(no|n|false|f|0|none|-)$/i;
export const guessSign = (value) => {
  const w = squash(value);
  if (/up|installed|placed|planted|has/.test(w)) return 'installed';
  if (/request|wants|deliver|pending|toputup/.test(w)) return 'requested';
  return '';
};
const resolveIn = (map, value, guess) => (Object.hasOwn(map || {}, value.toLowerCase()) ? map[value.toLowerCase()] : guess(value));
const headCol = (headers, names) => (headers ? headers.findIndex((h) => names.includes(normHeader(h))) : -1);

// homeCol: a Home Phone column — the number to call when the row has no
// other (it still fills the Home phone profile field too); not when the
// column is set to Don't import.
function toRow(scale, cells, mapping, ratingMap, homeCol = -1, roleMap = null, volCols = null, more = {}) {
  const row = {};
  const roles = new Set();
  mapping.forEach((key, i) => {
    if (!key) return;
    const v = String(cells[i] ?? '').trim();
    if (!v) return;
    if (key === 'tags') {
      for (const t of splitTags(v)) {
        const word = roleWord(t, volCols?.has(i));
        const code = word ? resolveRole(roleMap, word) : '';
        if (code) roles.add(code);
      }
    }
    if (key.startsWith(FIELD_KEY)) { fieldCell(row, key, SCI_RE.test(v) && i === homeCol ? '' : v); return; }
    if (key === 'tags') row.tags = row.tags ? `${row.tags};${v}` : v;
    else if (key === 'rating') { const code = resolveRating(scale, ratingMap, v); if (code) row.rating = code; }
    else if ((key === 'phone' || key === 'voter_number') && SCI_RE.test(v)) { /* digits lost in Excel */ }
    else row[key] = v;
  });
  if (!row.phone && homeCol >= 0 && mapping[homeCol]) {
    const h = String(cells[homeCol] ?? '').trim();
    if (h && !SCI_RE.test(h)) row.phone = h;
  }
  if (roles.size) row.roles = [...roles];
  const { statusCol = -1, dateCol = -1, signCol = -1, historyMap, signMap, splitFirsts = false } = more;
  // "Mary Anne" in First name, nothing in Middle: Mary · Anne (shared/names.js).
  const cut = splitFirsts && !row.middle ? splitFirst(row.first) : null;
  if (cut) { row.first = cut.first; row.middle = cut.middle; }
  // Only columns that are coming in (not set to Don't import).
  const st = statusCol >= 0 && mapping[statusCol] ? String(cells[statusCol] ?? '').trim() : '';
  const day = dateCol >= 0 && mapping[dateCol] ? String(cells[dateCol] ?? '').trim() : '';
  const how = st ? resolveIn(historyMap, st, guessHistory) : '';
  if (how && day) { const [channel, outcome] = how.split(':'); row.history = { channel, outcome, date: day }; }
  const sg = signCol >= 0 && mapping[signCol] ? String(cells[signCol] ?? '').trim() : '';
  const sign = sg && !NO_RE.test(sg) ? resolveIn(signMap, sg, guessSign) : '';
  if (sign) row.sign = sign;
  return row;
}

// fetch/ApiError → one plain sentence that says what to do.
function errText(e) {
  if (!e?.status) return 'Couldn’t reach base.win. Check your connection and try again.';
  if (e.status === 401) return 'You’ve been signed out. Sign in again in another tab, then try again.';
  if (e.status === 403) return 'Only campaign staff can import people.';
  const m = String(e.message || '').trim();
  return m ? `base.win said: ${m}.` : `Something went wrong (${e.status}). Try again.`;
}

const displayName = (r) => r.name || [r.first, r.middle, r.last].filter(Boolean).join(' ');
const displayAddress = (r) =>
  [[r.unit ? `${r.unit} –` : null, r.address].filter(Boolean).join(' '), r.city, r.postal].filter(Boolean).join(', ');
const splitTags = (s) => String(s || '').split(/[;,|]/).map((t) => t.trim()).filter(Boolean);

// Tag suggestion from the file name: "Voters List 2026.csv" → "voters-list-2026".
const slugTag = (fileName) => {
  const base = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug && slug.length <= TAG_MAX ? slug : '';
};

// ─────────────────────────────────────────────────────────────────────────────
// Server messages → spreadsheet row numbers and plain words
// ─────────────────────────────────────────────────────────────────────────────

// "1, 2, 3, 4, 4D, 4B, 4F, 4N, 4C" — what a rating column may hold (or the words).
const scaleCodes = (scale) => offeredCodes(scale).join(', ');

function friendly(text, scale) {
  const SCALE = scaleCodes(scale);
  const t = String(text || '').trim();
  if (t === 'no name') return 'No name. Fill in a full name, or a first and last name.';
  let m = /^invalid email “(.*)”$/.exec(t);
  if (m) return `“${m[1]}” doesn’t look like an email address.`;
  m = /^rating “(.*)” is not on the scale$/.exec(t);
  if (m) return `Rating “${m[1]}” isn’t on the scale (${SCALE}).`;
  m = /^rating “(.*)” is off the list$/.exec(t);
  if (m) return `Rating “${m[1]}” is off the list.`;
  m = /^([a-z]+)(?:\.\d+)?\s+(.*)$/.exec(t);
  if (m && FIELDS.some((f) => f.key === m[1])) {
    if (m[1] === 'rating') return `Rating isn’t on the scale (${SCALE}).`;
    const big = /Too big:.*?(\d+)\s*(characters|items)/i.exec(m[2]);
    if (big) return `${fieldLabel(m[1])} is too long (${big[1]} ${big[2]} max).`;
    return `${fieldLabel(m[1])}: ${m[2]}`;
  }
  return t ? t[0].toUpperCase() + t.slice(1) : 'Couldn’t read this row.';
}

// "row 3: no name" (3 = position in the chunk sent) → { row: 1042, text }.
function remapInvalid(msg, part, scale) {
  const m = /^row (\d+):\s*(.*)$/s.exec(String(msg));
  if (!m) return { row: null, text: friendly(msg, scale) };
  return { row: part[Number(m[1]) - 1]?.row ?? null, text: friendly(m[2], scale) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small pieces
// ─────────────────────────────────────────────────────────────────────────────

function Step({ n, title, line, state, children }) {
  // state: 'todo' | 'now' | 'done'. A step that isn't reached yet is just its title.
  return (
    <section className={`imp-step is-${state}`} aria-labelledby={`imp-step-${n}`}>
      <div className="imp-step__num" aria-hidden="true">{state === 'done' ? '✓' : n}</div>
      <div className="imp-step__body">
        <h2 id={`imp-step-${n}`}><span className="imp-sr">Step {n}: </span>{title}</h2>
        {state === 'now' && line && <p className="imp-line">{line}</p>}
        {state !== 'todo' && children}
      </div>
    </section>
  );
}

function Bar({ value, max, label }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="imp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="imp-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Counts({ items }) {
  return (
    <dl className="imp-counts">
      {items.map(([label, value, tone]) => (
        <div key={label} className={`imp-count${tone ? ` is-${tone}` : ''}`}>
          <dt className="eyebrow">{label}</dt>
          <dd><span className="imp-count__n mono">{fmtN(value)}</span></dd>
        </div>
      ))}
    </dl>
  );
}

// A quiet "Label +" toggle (the shared .disclose look); the body is only rendered when open.
function Reveal({ label, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="imp-reveal">
      <button type="button" className="imp-reveal__btn disclose disclose--inline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && <div className="imp-reveal__body">{children}</div>}
    </div>
  );
}

function InvalidList({ invalid, intro }) {
  const [all, setAll] = useState(false);
  if (!invalid.length) return null;
  const shown = all ? invalid : invalid.slice(0, 12);
  return (
    <div className="imp-invalid">
      <p className="imp-invalid__intro">{intro}</p>
      <ul className="imp-invalid__list">
        {shown.map((x, i) => (
          <li key={i}>
            {x.row != null && <span className="imp-invalid__row mono">Row {fmtN(x.row)}</span>}
            <span>{x.text}</span>
          </li>
        ))}
      </ul>
      {invalid.length > shown.length && (
        <button type="button" className="btn btn-quiet imp-tap" onClick={() => setAll(true)}>
          Show all {fmtN(invalid.length)}
        </button>
      )}
    </div>
  );
}

// Rows the check found (by email, or by name with phone or street) on someone
// with another voter number: a list numbered afresh, or a number typed wrong.
// The person says what they are; a new answer checks again — with the
// question left where it is, so an answer picked by keyboard keeps its place
// and the next arrow key goes on from it. A row with the same email is that
// person whatever the answer (routes/data.js).
const OTHER_ANSWERS = [
  ['keep', 'Yes — keep the numbers on file'],
  ['take', 'Yes — use this file’s numbers'],
  ['new', 'No — add them as new people'],
];
function OtherNumbers({ count, rows, answer, onAnswer }) {
  return (
    <fieldset className="vn-other">
      <legend className="vn-other__head">
        {plural(count, 'row matches', 'rows match')} someone on file with another voter number. {count === 1 ? 'The same person?' : 'The same people?'}
      </legend>
      {OTHER_ANSWERS.map(([v, words]) => (
        <label key={v} className={`vn-other__pick${answer === v ? ' is-on' : ''}`}>
          <input type="radio" name="vn-other" value={v} checked={answer === v} onChange={() => onAnswer(v)} />
          <span>{words}</span>
        </label>
      ))}
      {answer === 'new' && <p className="imp-hint imp-hint--sm">A row with the same email stays the same person.</p>}
      <Reveal label="See them">
        <ul className="imp-matches__list">
          {rows.map((x) => (
            <li key={x.row}>
              <span className="mono muted">Row {fmtN(x.row)}</span> {x.name}
              {x.person && x.person !== x.name ? <span className="muted"> · on file as {x.person}</span> : null}
              <span className="muted"> — <span className="mono vn-num">{x.on_file}</span> on file · <span className="mono vn-num">{x.in_file}</span> here</span>
            </li>
          ))}
        </ul>
        {count > rows.length && <p className="imp-hint imp-hint--sm">First {fmtN(rows.length)} of {fmtN(count)}.</p>}
      </Reveal>
    </fieldset>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen: 1 Choose a file · 2 Match columns (then check) · 3 Import
// ─────────────────────────────────────────────────────────────────────────────

export default function ImportPeople() {
  const { me } = useOutletContext() ?? {};
  if (!DESK.includes(me?.role)) return <Navigate to="/people" replace />;
  return <ImportFlow />;
}

const ZERO = { created: 0, merged: 0, unchanged: 0 };

function ImportFlow() {
  const queryClient = useQueryClient();
  const scale = useScale();
  const custom = useImportFields(); // the campaign's profile fields, as columns
  const allFields = [...FIELDS, ...custom];

  // Step 1 — the source
  const [source, setSource] = useState(null); // { name, headers, records, delimiter }
  const [loadError, setLoadError] = useState(null);
  const [reading, setReading] = useState(null); // what it's doing, e.g. Reading 182 MB… 40%
  const [dragOver, setDragOver] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  // Step 2 — mapping, then the check (a dry run). Any mapping/tag change throws the check away.
  const [mapping, setMapping] = useState([]);
  const [ratingMap, setRatingMap] = useState({}); // the rating column's values → codes ('' unrated), by choice
  const [roleMap, setRoleMap] = useState({}); // volunteer-role tags (lower-cased words) → role codes ('' a tag only), by choice
  const [historyMap, setHistoryMap] = useState({}); // Interaction Status values → 'door:no_answer'… ('' a field only), by choice
  const [signMap, setSignMap] = useState({}); // Sign values → 'requested' | 'installed' ('' a field only), by choice
  const [splitFirsts, setSplitFirsts] = useState(true); // a first name's second word or initial → Middle name
  // A list from a past election: its support, signs, voting and volunteering
  // come in as tags with the year ("Strong support 2022"), not as today's.
  const [past, setPast] = useState(false);
  const [pastYear, setPastYear] = useState(String(new Date().getFullYear()));
  const pastY = Number(pastYear);
  const pastOk = !past || (/^\d{4}$/.test(pastYear) && pastY >= 1950 && pastY <= 2100);
  // Profile fields from that election: each a year tag ("Support 5 2022",
  // "Sign 2022") or the field as it is. Yes/No, Number and Pick-one are tags
  // unless you say; text and dates (notes, a province) stay fields.
  const [fieldTagPick, setFieldTagPick] = useState({}); // field id → true | false, by choice
  const tagByDefault = (kind) => kind === 'yesno' || kind === 'number' || kind === 'choice' || kind === 'choices';
  const pastFieldCols = useMemo(() => (source ? mapping.map((k, i) => {
    if (!k || !k.startsWith(FIELD_KEY)) return null;
    const f = custom.find((c) => c.key === k);
    return { id: k.slice(FIELD_KEY.length), head: source.headers[i], name: f?.label || source.headers[i], kind: f?.kind };
  }).filter(Boolean) : []), [source, mapping, custom]);
  const tagsField = (c) => (Object.hasOwn(fieldTagPick, c.id) ? fieldTagPick[c.id] : tagByDefault(c.kind));
  const pastBody = past && pastOk ? { past: { year: pastY, field_tags: pastFieldCols.filter(tagsField).map((c) => c.id) } } : {};
  const [bumped, setBumped] = useState(null); // { col, key } — a column switched off by a pick
  const [tag, setTag] = useState('');
  const [check, setCheck] = useState(null); // { phase, done, total, created, merged, unchanged, invalid, matches, otherNumbers, others, parts, error, again }
  const checkRun = useRef(0); // the check under way: an older one, overtaken by a new answer, says nothing more
  // Rows found on someone with another voter number: 'keep' theirs, 'take'
  // the file's, or 'new' people (found by name only). Asked after the check.
  const [otherNumber, setOtherNumber] = useState('keep');
  // Step 3 — import (then place on the map)
  const [imp, setImp] = useState(null); // { phase, sent, total, created, merged, unchanged, invalid, error, resumeAt }

  const busy = Boolean(reading) || check?.phase === 'running' || Boolean(check?.again) || imp?.phase === 'running';
  const locked = busy || imp?.phase === 'done' || imp?.phase === 'error';

  // Don't lose a half-sent import to a stray tab close.
  useEffect(() => {
    if (imp?.phase !== 'running') return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [imp?.phase]);

  const resetAfterSource = () => { setCheck(null); setImp(null); setBumped(null); setOtherNumber('keep'); };

  const loadText = async (text, name, size = text.length) => {
    const what = `Reading ${fmtMB(size)}…`;
    let shown = -1;
    const t = await readTable(text, (share) => {
      const pct = Math.floor(share * 100);
      if (pct !== shown) { shown = pct; setReading(`${what} ${pct}%`); }
    });
    if (t.error) { setLoadError(t.error); return; }
    const shaped = shapeTable(t.all, t.header);
    if (shaped.error) { setLoadError(shaped.error); return; }
    setLoadError(null);
    setSource({ name, ...t, ...shaped });
    setMapping(guessMapping(scale, shaped.headers, shaped.records, !t.header, custom));
    setRatingMap({});
    setRoleMap({});
    setHistoryMap({});
    setSignMap({});
    setTag('');
    resetAfterSource();
  };
  // "First row is column names": on or off, then guess the columns again.
  const setHeader = (on) => {
    if (!source) return;
    const shaped = shapeTable(source.all, on);
    if (shaped.error) return;
    setSource({ ...source, header: on, ...shaped });
    setMapping(guessMapping(scale, shaped.headers, shaped.records, !on, custom));
    resetAfterSource();
  };

  const loadFile = async (file) => {
    if (!file) return;
    setLoadError(null);
    if (file.size > MAX_FILE_BYTES) {
      setLoadError(`That file is over ${fmtMB(MAX_FILE_BYTES)}. Split it into parts and import them one at a time.`);
      return;
    }
    // A big file takes a few seconds to read: say so before the work starts.
    setReading(`Reading ${fmtMB(file.size)}…`);
    await breathe();
    try {
      let buf = await file.arrayBuffer();
      if (isSpreadsheetBinary(buf, file.name)) {
        // An Excel workbook (.xlsx): its first sheet, read here. An old .xls,
        // Numbers or OpenDocument file still needs saving as CSV.
        if (!/\.(xlsx|xlsm)$/i.test(file.name) && new Uint8Array(buf.slice(0, 2))[0] !== 0x50) {
          setLoadError('That’s an older spreadsheet file. Save it as CSV or Excel (.xlsx), then choose that.');
          return;
        }
        let book;
        try {
          book = await readXlsx(buf);
        } catch (err) {
          setLoadError(err.message || 'Couldn’t read that workbook. Save it as CSV and choose that.');
          return;
        }
        buf = null;
        await loadText(toCsv(book.rows), `${file.name} · ${book.sheet}`, file.size);
        return;
      }
      const text = decodeBytes(buf);
      buf = null; // the bytes can go once they're text
      await loadText(text, file.name, file.size);
    } catch {
      setLoadError('Couldn’t read that file. Try saving it again as CSV.');
    } finally {
      setReading(null);
    }
  };

  const onPick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again still fires
    loadFile(file);
  };
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (locked) return;
    loadFile(e.dataTransfer?.files?.[0]);
  };
  const usePaste = async () => {
    if (!pasteText.trim()) { setLoadError('Paste some rows first.'); return; }
    setReading('Reading…');
    try {
      await loadText(pasteText, 'Pasted text');
    } finally {
      setReading(null);
    }
    setPasteOpen(false);
  };
  const startOver = () => {
    setSource(null);
    setMapping([]);
    setRatingMap({});
    setRoleMap({});
    setHistoryMap({});
    setSignMap({});
    setTag('');
    setLoadError(null);
    setPasteText('');
    resetAfterSource();
  };

  const setField = (col, key) => {
    let bump = null;
    const next = mapping.map((k, j) => {
      if (j === col) return key;
      if (key && !MULTI.has(key) && k === key) { bump = { col: j, key }; return SKIP; }
      return k;
    });
    setMapping(next);
    setBumped(bump);
    setCheck(null);
  };
  const onTag = (v) => { setTag(v.slice(0, TAG_MAX)); setCheck(null); };

  // ── Derived ──
  // Rows take the server's shape a chunk at a time, as they're sent: a voter
  // file is never held twice. The preview shapes only its first few.
  const records = source?.records || [];
  const total = records.length;
  // A Home Phone column (by its name): the number to call when there's no other.
  const homeCol = source ? source.headers.findIndex((h) => normHeader(h) === 'homephone') : -1;
  // Columns whose heading says volunteer ("Volunteer Lists"): mapped to
  // Tags, every value in them is a role to place.
  const statusCol = headCol(source?.headers, STATUS_HEADS);
  const dateCol = headCol(source?.headers, DATE_HEADS);
  const signCol = headCol(source?.headers, SIGN_HEADS);
  const more = useMemo(() => ({ statusCol, dateCol, signCol, historyMap, signMap, splitFirsts }), [statusCol, dateCol, signCol, historyMap, signMap, splitFirsts]);
  const volCols = useMemo(
    () => new Set(source ? source.headers.map((h, i) => (/volunteer/i.test(h) ? i : -1)).filter((i) => i >= 0) : []),
    [source],
  );
  const partAt = (start, size) => records.slice(start, start + size)
    .map((r) => ({ data: toRow(scale, r.cells, mapping, ratingMap, homeCol, roleMap, volCols, more), row: r.row }));
  const preview = useMemo(
    () => (source ? source.records.slice(0, 5).map((r) => ({ data: toRow(scale, r.cells, mapping, ratingMap, homeCol, roleMap, volCols, more), row: r.row, cells: r.cells })) : []),
    [source, mapping, scale, ratingMap, homeCol, roleMap, volCols, more],
  );
  // Phone columns Excel cut short ("1.6047E+10"), by column: how many.
  const sciByCol = useMemo(() => {
    const out = {};
    if (!source) return out;
    source.headers.forEach((_, i) => {
      if (mapping[i] !== 'phone' && mapping[i] !== 'voter_number' && i !== homeCol) return;
      const n = source.records.reduce((m, r) => m + (SCI_RE.test(String(r.cells[i] ?? '').trim()) ? 1 : 0), 0);
      if (n) out[i] = n;
    });
    return out;
  }, [source, mapping, homeCol]);
  // Rows whose voter number another row of the file has: the same number
  // is the same person, so a column that isn't each voter's own would fold
  // people together — said under the column before anything is checked.
  const voterCol = mapping.indexOf('voter_number');
  const sharedVoters = useMemo(() => {
    if (!source || voterCol < 0) return 0;
    const seen = new Set();
    let n = 0;
    for (const r of source.records) {
      const v = String(r.cells[voterCol] ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
      if (v.length < 3 || !/\d/.test(v)) continue;
      if (seen.has(v)) n += 1; else seen.add(v);
    }
    return n;
  }, [source, voterCol]);
  const ratingCol = mapping.indexOf('rating');
  const hasName = mapping.some((k) => k === 'name' || k === 'first' || k === 'middle' || k === 'last');
  const usedCount = mapping.filter(Boolean).length;
  const usedFields = allFields.filter((f) => mapping.includes(f.key)).map((f) => f.label);
  const tagClean = tag.trim();
  const fileTag = source && source.name !== 'Pasted text' ? slugTag(source.name) : '';

  const examples = useMemo(
    () => (source ? source.headers.map((_, i) => columnValues(source.records, i, 3)) : []),
    [source],
  );
  // A column mapped to Rating whose values aren't on the scale (or are off
  // the list): those people come in unrated. Which values, said once each.
  const ratingValues = useMemo(() => ratingValuesOf(source?.records || [], ratingCol), [source, ratingCol]);
  const { badRatings, badValues } = useMemo(() => {
    const col = ratingCol;
    const seen = new Map();
    let n = 0;
    if (source && col !== -1) {
      for (const r of source.records) {
        const v = String(r.cells[col] ?? '').trim();
        if (!v || resolveRating(scale, ratingMap, v)) continue;
        n += 1;
        if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), `“${v}”${matchRating(scale, v)?.off ? ' (off the list)' : ''}`);
      }
    }
    const vals = [...seen.values()];
    return { badRatings: n, badValues: vals.length > 3 ? `${vals.slice(0, 3).join(', ')}…` : vals.join(', ') };
  }, [source, ratingCol, scale, ratingMap]);
  // Volunteer-role tags in the Tags columns, most common first.
  const roleWords = useMemo(() => {
    const seen = new Map();
    if (source) {
      mapping.forEach((key, i) => {
        if (key !== 'tags') return;
        for (const r of source.records) {
          for (const t of splitTags(r.cells[i])) {
            const word = roleWord(t, volCols.has(i));
            if (!word) continue;
            const k = word.toLowerCase();
            const cur = seen.get(k) || { word, tag: t, n: 0 };
            cur.n += 1;
            seen.set(k, cur);
          }
        }
      });
    }
    return [...seen.values()].sort((a, b) => b.n - a.n || a.word.localeCompare(b.word)).slice(0, 40);
  }, [source, mapping, volCols]);
  // A column's values, most common first: [{ value, n }] (and how many
  // rows have no day, for the statuses).
  const valuesIn = (col, keep = () => true) => {
    const seen = new Map();
    if (source && col >= 0 && mapping[col]) {
      for (const r of source.records) {
        const v = String(r.cells[col] ?? '').trim();
        if (!v || !keep(v)) continue;
        const k = v.toLowerCase();
        const cur = seen.get(k) || { value: v, n: 0 };
        cur.n += 1;
        seen.set(k, cur);
      }
    }
    return [...seen.values()].sort((a, b) => b.n - a.n || a.value.localeCompare(b.value)).slice(0, 40);
  };
  const statusValues = useMemo(() => valuesIn(statusCol), [source, mapping, statusCol]); // eslint-disable-line react-hooks/exhaustive-deps
  const signValues = useMemo(() => valuesIn(signCol, (v) => !NO_RE.test(v)), [source, mapping, signCol]); // eslint-disable-line react-hooks/exhaustive-deps
  const undated = useMemo(() => {
    if (!source || statusCol < 0 || !mapping[statusCol]) return 0;
    return source.records.filter((r) => String(r.cells[statusCol] ?? '').trim()
      && !(dateCol >= 0 && mapping[dateCol] && String(r.cells[dateCol] ?? '').trim())).length;
  }, [source, mapping, statusCol, dateCol]);
  // First names with a second word or an initial (no Middle name column
  // value beside them): how many, and one for the example.
  const firstSplits = useMemo(() => {
    const fc = mapping.indexOf('first');
    const mc = mapping.indexOf('middle');
    if (!source || fc < 0) return { n: 0, example: null };
    let n = 0; let example = null;
    for (const r of source.records) {
      if (mc >= 0 && String(r.cells[mc] ?? '').trim()) continue;
      const c = splitFirst(r.cells[fc]);
      if (c) { n += 1; if (!example) example = { from: String(r.cells[fc]).trim(), ...c }; }
    }
    return { n, example };
  }, [source, mapping]);
  const setHistoryMeaning = (value, code) => { setHistoryMap((m) => ({ ...m, [value.toLowerCase()]: code })); setCheck(null); };
  const setSignMeaning = (value, code) => { setSignMap((m) => ({ ...m, [value.toLowerCase()]: code })); setCheck(null); };
  const setRoleMeaning = (word, code) => {
    setRoleMap((m) => ({ ...m, [word.toLowerCase()]: code }));
    setCheck(null);
  };
  const setRatingMeaning = (value, code) => {
    setRatingMap((m) => ({ ...m, [value.toLowerCase()]: code }));
    setCheck(null);
  };

  const previewCols = [
    hasName && ['name', 'Name'],
    mapping.includes('email') && ['email', 'Email'],
    mapping.includes('phone') && ['phone', 'Phone'],
    mapping.some((k) => ['address', 'unit', 'city', 'postal'].includes(k)) && ['address', 'Address'],
    (mapping.includes('tags') || tagClean) && ['tags', 'Tags'],
    mapping.includes('rating') && ['rating', 'Rating'],
  ].filter(Boolean);

  // ── Check (dry run: nothing is saved) ──
  // numbers: the answer about other voter numbers. A new answer checks again
  // (again): the last check stays on screen, its counts giving way to
  // "Checking…", so the question — and the keyboard's place in it — stays put.
  const runCheck = async (numbers = otherNumber, { again = false } = {}) => {
    const acc = { ...ZERO, invalid: [], matches: [], otherNumbers: 0, others: [] };
    const parts = Math.ceil(total / CHECK_CHUNK);
    const run = (checkRun.current += 1);
    const show = (next) => { if (run === checkRun.current) setCheck(next); };
    const going = (done) => show(again ? (c) => c && { ...c, again: { done, total } } : { phase: 'running', done, total, parts, ...acc });
    going(0);
    try {
      for (let start = 0; start < total; start += CHECK_CHUNK) {
        if (run !== checkRun.current) return; // a newer answer is being checked
        const part = partAt(start, CHECK_CHUNK);
        const r = await apiPost('/data/import', { rows: part.map((x) => x.data), tag: tagClean || undefined, dryRun: true, otherNumber: numbers, ...pastBody });
        acc.created += r.created || 0;
        acc.merged += r.merged || 0;
        acc.unchanged += r.unchanged || 0;
        for (const msg of r.invalid || []) acc.invalid.push(remapInvalid(msg, part, scale));
        for (const d of r.decisions || []) {
          if (d.action === 'merged' && acc.matches.length < 50) {
            acc.matches.push({ ...d, row: part[d.row - 1]?.row ?? d.row });
          }
        }
        acc.otherNumbers += r.other_numbers || 0;
        for (const x of r.other_number_rows || []) {
          if (acc.others.length < 50) acc.others.push({ ...x, row: part[x.row - 1]?.row ?? x.row });
        }
        going(start + part.length);
      }
      show({ phase: 'done', done: total, total, parts, ...acc });
    } catch (e) {
      show({ phase: 'error', done: 0, total, parts, ...acc, error: errText(e) });
    }
  };

  // ── Import, 1,000 rows a call; each call is its own transaction ──
  const accRef = useRef(null);
  const runImport = async (from = 0) => {
    if (from === 0) accRef.current = { ...ZERO, invalid: [] };
    const acc = accRef.current;
    setImp({ phase: 'running', sent: from, total, ...acc });
    let start = from;
    try {
      for (; start < total; start += IMPORT_CHUNK) {
        const part = partAt(start, IMPORT_CHUNK);
        const r = await apiPost('/data/import', { rows: part.map((x) => x.data), tag: tagClean || undefined, otherNumber, ...pastBody });
        acc.created += r.created || 0;
        acc.merged += r.merged || 0;
        acc.unchanged += r.unchanged || 0;
        for (const msg of r.invalid || []) acc.invalid.push(remapInvalid(msg, part, scale));
        setImp({ phase: 'running', sent: start + part.length, total, ...acc });
      }
      setImp({ phase: 'done', sent: total, total, ...acc });
    } catch (e) {
      setImp({ phase: 'error', sent: start, total, ...acc, error: errText(e), resumeAt: start });
    } finally {
      invalidatePersonData(queryClient);
      // Merges can fill a rating or phone on people already inside a turf.
      queryClient.invalidateQueries({ queryKey: ['turfs'] });
      queryClient.invalidateQueries({ queryKey: ['turf'] });
    }
  };

  const checked = check?.phase === 'done';
  const willWrite = checked ? check.created + check.merged : 0;
  const nothingNew = checked && willWrite === 0;
  // Nothing to write because everyone is already on file (vs. every row failed).
  const nothingToDo = nothingNew && check.unchanged > 0;
  const nothingValid = nothingNew && check.unchanged === 0;
  const hasAddress = mapping.includes('address');
  const imported = imp?.phase === 'done';
  const peopleLink = tagClean ? `/people?tag=${encodeURIComponent(tagClean)}` : '/people';

  const at = !source ? 1 : !checked ? 2 : 3;
  const stepState = (n) => (n < at ? 'done' : n === at ? 'now' : 'todo');

  return (
    <div className="imp-page">
      <div className="page-head imp-head">
        <div>
          <Link to="/people" className="eyebrow imp-back">← People</Link>
          <h1>Import people</h1>
        </div>
      </div>

      {/* ── 1. Choose ── */}
      <Step n={1} title="Choose a file" line="A CSV or an Excel workbook (.xlsx) — its first sheet." state={stepState(1)}>
        {source ? (
          <div className="imp-source">
            <p>
              <strong>{source.name}</strong>
              <span className="muted"> · {plural(source.records.length, 'row', 'rows')}</span>
            </p>
            <button type="button" className="btn btn-quiet imp-tap" onClick={startOver} disabled={busy}
              title={`${plural(source.headers.length, 'column', 'columns')}, ${DELIM_NAMES[source.delimiter]}-separated`}>
              {imported ? 'Import another' : 'Change file'}
            </button>
          </div>
        ) : (
          <>
            <label
              htmlFor="imp-file"
              className={`imp-drop${dragOver ? ' is-over' : ''}${reading ? ' is-busy' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <input
                id="imp-file"
                className="imp-file-input"
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={onPick}
                disabled={Boolean(reading)}
              />
              {/* The paste box's "Use this text" is the yellow button while it's open. */}
              <span className={`btn ${pasteOpen ? 'btn-quiet' : 'btn-primary'} imp-tap imp-drop__btn`}>
                {reading || 'Choose a file'}
              </span>
              <span className="imp-drop__or">or drop it here</span>
            </label>
            {!pasteOpen ? (
              <button type="button" className="btn btn-quiet imp-tap" onClick={() => setPasteOpen(true)}>
                Paste text
              </button>
            ) : (
              <div className="imp-paste">
                <div className="field">
                  <label htmlFor="imp-paste">One person per line</label>
                  <textarea
                    id="imp-paste"
                    className="input mono imp-paste__text"
                    rows={7}
                    spellCheck={false}
                    placeholder={'Jane Doe, jane@example.com, 604-555-0101\nSam Lee, sam@example.com, 604-555-0102'}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                  />
                </div>
                <div className="imp-actions">
                  <button type="button" className="btn btn-primary imp-tap" onClick={usePaste} disabled={busy}>Use this text</button>
                  <button type="button" className="btn btn-quiet imp-tap" onClick={() => setPasteOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
        {loadError && <p className="error" role="alert">{loadError}</p>}
      </Step>

      {/* ── 2. Match columns, then check ── */}
      <Step n={2} title="Match columns" line="Check where each column goes." state={stepState(2)}>
        {source && (checked ? (
          <div className="imp-source">
            <p className="imp-summary">
              {usedFields.join(' · ')}
              {tagClean ? <> · <span className="chip imp-chip">{tagWord(tagClean)}</span></> : null}
            </p>
            {!imp && (
              <button type="button" className="btn btn-quiet imp-tap" onClick={() => { checkRun.current += 1; setCheck(null); }}>Change</button>
            )}
          </div>
        ) : (
          <>
            <label className="imp-headrow">
              <input
                type="checkbox"
                checked={source.header}
                disabled={locked || (!source.header && source.all.length < 2)}
                onChange={(e) => setHeader(e.target.checked)}
              />
              First row is column names
            </label>
            <ul className="imp-map">
              {source.headers.map((h, i) => {
                const id = `imp-col-${i}`;
                const ex = examples[i] || [];
                return (
                  <li key={i} className={`imp-map__row${mapping[i] ? ' is-used' : ''}`}>
                    <div className="imp-map__src">
                      <label htmlFor={id} className="imp-map__head">{h}</label>
                      <span className="imp-map__ex">{ex.length ? ex.join(' · ') : 'empty'}</span>
                    </div>
                    <span className="imp-map__arrow" aria-hidden="true">→</span>
                    <select
                      id={id}
                      className="input imp-map__select"
                      value={mapping[i] || SKIP}
                      disabled={locked}
                      onChange={(e) => setField(i, e.target.value)}
                    >
                      <option value={SKIP}>Don’t import</option>
                      {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      {custom.length > 0 && (
                        <optgroup label="Profile fields">
                          {custom.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </optgroup>
                      )}
                    </select>
                    {bumped?.col === i && (
                      <p className="imp-map__note" role="status">
                        Now “Don’t import” — {allFields.find((f) => f.key === bumped.key)?.label} comes from one column.
                      </p>
                    )}
                    {sciByCol[i] > 0 && (
                      <p className="imp-map__note is-warn">
                        {plural(sciByCol[i], 'number has', 'numbers have')} lost {sciByCol[i] === 1 ? 'its' : 'their'} last digits in Excel (like 1.6047E+10), so {sciByCol[i] === 1 ? 'it' : 'they'} won’t be imported. In the spreadsheet, format this column as Text (or Number with no decimals), save again, and choose the file again.
                      </p>
                    )}
                    {mapping[i] === 'voter_number' && sharedVoters > 0 && (
                      <p className="imp-map__note is-warn">
                        {plural(sharedVoters, 'row has', 'rows have')} a number another row has, and the same number is read as the same person. Not each voter’s own number? Set this column to Don’t import.
                      </p>
                    )}
                    {i === homeCol && mapping[i] !== 'phone' && mapping[i] && !sciByCol[i] && (
                      <p className="imp-map__note">Also the number to call for anyone with no mobile.</p>
                    )}
                    {mapping[i] === 'rating' && badRatings > 0 && (
                      <p className="imp-map__note is-warn">
                        {plural(badRatings, 'rating isn’t', 'ratings aren’t')} on the scale ({badValues}) — {badRatings === 1 ? 'comes' : 'they come'} in unrated unless you say what {badRatings === 1 ? 'it means' : 'they mean'} below.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {ratingCol !== -1 && ratingValues.values.length > 0 && (
              <section className="imp-rmap" aria-labelledby="imp-rmap-h">
                <h3 id="imp-rmap-h" className="imp-rmap__h">What each rating means on your scale</h3>
                <p className="imp-hint imp-hint--sm">
                  The list’s own values, most common first, read as your scale reads them. Change any — a 5 on the list can be a 1 here — or leave it unrated.
                </p>
                <ul className="imp-rmap__list">
                  {ratingValues.values.map(({ value, n }) => {
                    const cur = resolveRating(scale, ratingMap, value) || '';
                    const own = Object.hasOwn(ratingMap, value.toLowerCase());
                    return (
                      <li key={value.toLowerCase()} className={`imp-rmap__row${cur ? ' is-used' : ''}`}>
                        <span className="imp-rmap__val"><span className="imp-rmap__word">{value}</span> <span className="mono muted">{plural(n, 'row', 'rows')}</span></span>
                        <span className="imp-map__arrow" aria-hidden="true">→</span>
                        <select className="input imp-rmap__select" value={cur} disabled={locked}
                          aria-label={`What “${value}” means`} onChange={(e) => setRatingMeaning(value, e.target.value)}>
                          <option value="">Leave unrated</option>
                          <optgroup label="Steps">
                            {scale.steps.map((st) => <option key={st.code} value={st.code}>{st.code} · {st.word}</option>)}
                          </optgroup>
                          {offeredCandidates(scale).length > 0 && (
                            <optgroup label="Voting for">
                              {offeredCandidates(scale).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                            </optgroup>
                          )}
                        </select>
                        {own && <span className="imp-rmap__own mono" aria-hidden="true">yours</span>}
                      </li>
                    );
                  })}
                </ul>
                {ratingValues.more > 0 && (
                  <p className="imp-hint imp-hint--sm">…and {plural(ratingValues.more, 'rarer value', 'rarer values')}, read as the scale reads them (unrated otherwise).</p>
                )}
                {Object.keys(ratingMap).length > 0 && !locked && (
                  <button type="button" className="btn btn-quiet imp-rmap__reset" onClick={() => { setRatingMap({}); setCheck(null); }}>Back to the scale’s own reading</button>
                )}
              </section>
            )}
            {firstSplits.n > 0 && (
              <label className="imp-split">
                <input type="checkbox" checked={splitFirsts} disabled={locked}
                  onChange={(e) => { setSplitFirsts(e.target.checked); setCheck(null); }} />
                <span>
                  <strong>Second first names to Middle name</strong> — {plural(firstSplits.n, 'first name has', 'first names have')} a second word or an initial
                  {' '}(“{firstSplits.example.from}” → {firstSplits.example.first} · <em>{firstSplits.example.middle}</em>). Hyphenated names (Mary-Anne) stay whole.
                </span>
              </label>
            )}
            {roleWords.length > 0 && (
              <section className="imp-rmap" aria-labelledby="imp-roles-h">
                <h3 id="imp-roles-h" className="imp-rmap__h">Volunteer roles</h3>
                <p className="imp-hint imp-hint--sm">
                  Tags in the list that name a volunteer role. Choose the role each one is, and those people get it (as if added on their profile) — so you can pick them by role when staffing shifts. The tags still come in as they are.
                </p>
                <ul className="imp-rmap__list">
                  {roleWords.map(({ word, tag: t, n }) => {
                    const cur = resolveRole(roleMap, word);
                    const own = Object.hasOwn(roleMap, word.toLowerCase());
                    return (
                      <li key={word.toLowerCase()} className={`imp-rmap__row${cur ? ' is-used' : ''}`}>
                        <span className="imp-rmap__val"><span className="imp-rmap__word">{t}</span> <span className="mono muted">{plural(n, 'row', 'rows')}</span></span>
                        <span className="imp-map__arrow" aria-hidden="true">→</span>
                        <select className="input imp-rmap__select" value={cur} disabled={locked}
                          aria-label={`The role “${t}” is`} onChange={(e) => setRoleMeaning(word, e.target.value)}>
                          <option value="">A tag only</option>
                          {VOLUNTEER_ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                        </select>
                        {own && <span className="imp-rmap__own mono" aria-hidden="true">yours</span>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {statusValues.length > 0 && (
              <section className="imp-rmap" aria-labelledby="imp-hist-h">
                <h3 id="imp-hist-h" className="imp-rmap__h">Past conversations</h3>
                <p className="imp-hint imp-hint--sm">
                  Each person’s last interaction in the list ({source.headers[statusCol]}{dateCol >= 0 ? ` on ${source.headers[dateCol]}` : ''}). Say what each status was, and it comes in as a knock or a call on that day — on the map, the field report and their history, marked as from this list. Left as a profile field, it stays just that.{past && ' From a past election: a talk, a refusal or a move is a tag with the year instead.'}
                </p>
                <ul className="imp-rmap__list">
                  {statusValues.map(({ value, n }) => {
                    const cur = resolveIn(historyMap, value, guessHistory);
                    const own = Object.hasOwn(historyMap, value.toLowerCase());
                    return (
                      <li key={value.toLowerCase()} className={`imp-rmap__row${cur ? ' is-used' : ''}`}>
                        <span className="imp-rmap__val"><span className="imp-rmap__word">{value}</span> <span className="mono muted">{plural(n, 'row', 'rows')}</span></span>
                        <span className="imp-map__arrow" aria-hidden="true">→</span>
                        <select className="input imp-rmap__select" value={cur} disabled={locked}
                          aria-label={`What “${value}” was`} onChange={(e) => setHistoryMeaning(value, e.target.value)}>
                          <option value="">A profile field only</option>
                          {HISTORY_CHOICES.map(([ch, opts]) => (
                            <optgroup key={ch} label={ch === 'door' ? 'At the door' : 'On the phone'}>
                              {opts.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                            </optgroup>
                          ))}
                        </select>
                        {own && <span className="imp-rmap__own mono" aria-hidden="true">yours</span>}
                      </li>
                    );
                  })}
                </ul>
                {undated > 0 && (
                  <p className="imp-hint imp-hint--sm">{plural(undated, 'row has', 'rows have')} a status but no date — {undated === 1 ? 'it stays' : 'they stay'} a profile field only.</p>
                )}
              </section>
            )}
            {signValues.length > 0 && (
              <section className="imp-rmap" aria-labelledby="imp-sign-h">
                <h3 id="imp-sign-h" className="imp-rmap__h">Signs</h3>
                <p className="imp-hint imp-hint--sm">
                  What the list’s {source.headers[signCol]} column means. A lawn sign to put up (or one that’s up) goes on the sign list at their address — never a second one for someone who has a sign.{past && ' From a past election: a tag with the year instead (Lawn sign, Lawn sign request).'}
                </p>
                <ul className="imp-rmap__list">
                  {signValues.map(({ value, n }) => {
                    const cur = resolveIn(signMap, value, guessSign);
                    const own = Object.hasOwn(signMap, value.toLowerCase());
                    return (
                      <li key={value.toLowerCase()} className={`imp-rmap__row${cur ? ' is-used' : ''}`}>
                        <span className="imp-rmap__val"><span className="imp-rmap__word">{value}</span> <span className="mono muted">{plural(n, 'row', 'rows')}</span></span>
                        <span className="imp-map__arrow" aria-hidden="true">→</span>
                        <select className="input imp-rmap__select" value={cur} disabled={locked}
                          aria-label={`What a sign “${value}” means`} onChange={(e) => setSignMeaning(value, e.target.value)}>
                          <option value="">A profile field only</option>
                          <option value="requested">A lawn sign to put up</option>
                          <option value="installed">A lawn sign that’s up</option>
                        </select>
                        {own && <span className="imp-rmap__own mono" aria-hidden="true">yours</span>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {!hasName && (
              <p className="imp-need" role="alert">
                Match a column to <strong>Full name</strong>, or <strong>First</strong> + <strong>Last name</strong>.
              </p>
            )}

            <section className={`imp-past${past ? ' is-on' : ''}`} aria-labelledby="imp-past-h">
              <label className="imp-past__toggle">
                <input type="checkbox" checked={past} disabled={locked} onChange={(e) => { setPast(e.target.checked); setCheck(null); }} />
                <span id="imp-past-h"><strong>From a past election</strong></span>
                {past && (
                  <input className="input mono imp-past__year" inputMode="numeric" maxLength={4} aria-label="Which election’s year"
                    value={pastYear} disabled={locked} onChange={(e) => { setPastYear(e.target.value.replace(/\D/g, '')); setCheck(null); }} />
                )}
              </label>
              <p className="imp-hint imp-hint--sm">
                {past
                  ? <>Nothing here becomes today’s. Ratings, signs, voted, volunteer and donor, roles and conversations come in as tags with the year — <em>Strong support {pastOk ? pastY : '…'}</em>, <em>Voting Locke {pastOk ? pastY : '…'}</em>, <em>Lawn sign {pastOk ? pastY : '…'}</em>, <em>Voted {pastOk ? pastY : '…'}</em> — and someone already on file keeps their rating. Names, phones, emails and addresses come in as usual.</>
                  : <>An old list (a past campaign’s)? Tick this and its ratings, signs and voted marks come in as tags with that year, not as today’s.</>}
              </p>
              {past && pastFieldCols.length > 0 && (
                <div className="imp-past__fields">
                  <p className="imp-hint imp-hint--sm">Your profile fields from that election — ticked ones come in as a tag with the year, the rest as the field:</p>
                  <ul className="imp-past__list">
                    {pastFieldCols.map((c) => (
                      <li key={c.id}>
                        <label>
                          <input type="checkbox" checked={tagsField(c)} disabled={locked}
                            onChange={(e) => { setFieldTagPick((m) => ({ ...m, [c.id]: e.target.checked })); setCheck(null); }} />
                          <span>{c.head}</span>
                          <span className="mono muted">{tagsField(c) ? `→ ${c.kind === 'yesno' ? `${c.name} ${pastOk ? pastY : '…'}` : `${c.name} … ${pastOk ? pastY : '…'}`}` : '→ the field'}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!pastOk && <p className="imp-need" role="alert">A year like 2022.</p>}
            </section>

            <Reveal label={tagClean ? `Tag: ${tagWord(tagClean)}` : 'Tag everyone'} defaultOpen={Boolean(tagClean)}>
              <div className="field imp-tagfield">
                <label htmlFor="imp-tag">Tag (optional)</label>
                <div className="imp-tagrow">
                  <input
                    id="imp-tag"
                    className="input"
                    maxLength={TAG_MAX}
                    placeholder="e.g. Voters list"
                    value={tag}
                    disabled={locked}
                    onChange={(e) => onTag(e.target.value)}
                  />
                  {fileTag && tagClean !== fileTag && !locked && (
                    <button type="button" className="btn btn-quiet imp-tap" onClick={() => onTag(fileTag)}>
                      Use “{tagWord(fileTag)}”
                    </button>
                  )}
                </div>
              </div>
            </Reveal>

            {hasName && preview.length > 0 && (
              <Reveal label="Preview">
                <div className="imp-preview__scroll">
                  <table className="table imp-preview__table">
                    <thead>
                      <tr>
                        <th className="mono">Row</th>
                        {previewCols.map(([k, label]) => <th key={k}>{label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map(({ data, row, cells }) => {
                        const tags = [...new Set([...splitTags(data.tags), ...(tagClean ? [tagClean] : [])])];
                        const rawRating = ratingCol === -1 ? '' : String(cells[ratingCol] ?? '').trim();
                        return (
                          <tr key={row}>
                            <td className="mono muted">{row}</td>
                            {previewCols.map(([k]) => (
                              <td key={k}>
                                {k === 'name' ? (displayName(data) || <span className="danger-text">no name</span>)
                                  : k === 'address' ? (displayAddress(data) || <span className="muted">—</span>)
                                  : k === 'tags' ? (tags.length
                                    ? <span className="imp-tags">{tags.map((t) => <span key={t} className="chip">{tagWord(t)}</span>)}</span>
                                    : <span className="muted">—</span>)
                                  : k === 'rating' ? (data.rating
                                    ? <RatingChip code={data.rating} who />
                                    : rawRating
                                      ? <span className="muted" title="Not on the scale — comes in without a rating"><s>{rawRating}</s> unrated</span>
                                      : <span className="muted">—</span>)
                                  : (data[k] || <span className="muted">—</span>)}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Reveal>
            )}

            {check?.phase === 'running' ? (
              <div className="imp-running" role="status" aria-live="polite">
                <Bar value={check.done} max={check.total} label="Checking" />
                <p className="imp-line mono">Checking {fmtN(check.done)} of {fmtN(check.total)}…</p>
              </div>
            ) : (
              <div className="imp-actions">
                <button type="button" className="btn btn-primary imp-tap" onClick={() => runCheck()} disabled={!hasName || !pastOk || busy || locked}>
                  Check {plural(total, 'row', 'rows')}
                </button>
                <span className="imp-line imp-line--inline">{fmtN(usedCount)} of {fmtN(source.headers.length)} columns</span>
              </div>
            )}
            {check?.phase === 'error' && <p className="error" role="alert">The check didn’t finish. {check.error}</p>}
          </>
        ))}
      </Step>

      {/* ── 3. Import, then place on the map ── */}
      <Step n={3} title={imported ? 'Done' : 'Import'} line={!imp && !nothingNew ? 'Nothing is saved until you tap Import.' : null} state={imported ? 'done' : stepState(3)}>
        {checked && (
          <>
            {!imp && (
              <div className="imp-result" role="status">
                {check.again ? (
                  <p className="imp-line mono">Checking {fmtN(check.again.done)} of {fmtN(check.again.total)}…</p>
                ) : (
                  <Counts
                    items={[
                      ['New', check.created, 'ok'],
                      ['Update', check.merged],
                      ['Same', check.unchanged],
                      ['Can’t import', check.invalid.length, check.invalid.length ? 'danger' : null],
                    ]}
                  />
                )}
                {check.parts > 1 && <p className="imp-hint imp-hint--sm">Checked in parts — a few far-apart repeats may count as new.</p>}
                {check.otherNumbers > 0 && (
                  <OtherNumbers count={check.otherNumbers} rows={check.others} answer={otherNumber}
                    onAnswer={(v) => { setOtherNumber(v); runCheck(v, { again: true }); }} />
                )}
                {!check.again && check.matches.length > 0 && (
                  <Reveal label="See matches">
                    <p className="imp-hint imp-hint--sm">
                      {otherNumber === 'take' && check.otherNumbers > 0
                        ? 'Blanks get filled and voter numbers replaced. Nothing else is overwritten.'
                        : 'Blanks get filled. Nothing is overwritten.'}
                    </p>
                    {check.merged > check.matches.length && (
                      <p className="imp-hint imp-hint--sm">First {fmtN(check.matches.length)} of {fmtN(check.merged)}.</p>
                    )}
                    <ul className="imp-matches__list">
                      {check.matches.map((d) => (
                        <li key={`${d.row}-${d.id}`}>
                          <span className="mono muted">Row {fmtN(d.row)}</span> {d.name}
                          {d.fields?.length ? <span className="muted"> — adds {d.fields.map((f) => FIELD_WORD[f] || f).join(', ')}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </Reveal>
                )}
                {!check.again && (
                  <InvalidList
                    invalid={check.invalid}
                    intro={`${plural(check.invalid.length, 'row', 'rows')} can’t be imported. Fix ${check.invalid.length === 1 ? 'it' : 'them'} in the spreadsheet.`}
                  />
                )}
                {!check.again && nothingToDo && <p className="imp-line">Everyone is already up to date.</p>}
                {!check.again && nothingValid && <p className="imp-line">Nothing to import yet. Fix the rows above, or change a column.</p>}
                {!check.again && !nothingNew && (
                  <div className="imp-actions">
                    <button type="button" className="btn btn-primary imp-tap" onClick={() => runImport(0)}>
                      Import {plural(willWrite, 'person', 'people')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {imp && (
              <div className="imp-running" role="status" aria-live="polite">
                {imp.phase !== 'done' && <Bar value={imp.sent} max={imp.total} label="Importing" />}
                {imp.phase === 'running' && (
                  <p className="imp-line mono">{fmtN(imp.sent)} of {fmtN(imp.total)} · keep this page open</p>
                )}
                {imp.phase === 'error' && (
                  <>
                    <p className="error" role="alert">
                      Stopped at row {fmtN(source.records[imp.resumeAt]?.row ?? imp.resumeAt + 1)}. {imp.error}
                      {imp.sent > 0 ? (imp.invalid.length
                        ? ` Rows before it are saved, except ${plural(imp.invalid.length, 'bad row', 'bad rows')}.`
                        : ' Rows before it are saved.') : ''}
                    </p>
                    <div className="imp-actions">
                      <button type="button" className="btn btn-primary imp-tap" onClick={() => runImport(imp.resumeAt)}>
                        Try the rest again
                      </button>
                    </div>
                  </>
                )}
                {imp.phase === 'done' && (
                  <>
                    <Counts
                      items={[
                        ['Added', imp.created, 'ok'],
                        ['Updated', imp.merged],
                        ['Same', imp.unchanged],
                      ]}
                    />
                    <InvalidList
                      invalid={imp.invalid}
                      intro={`${plural(imp.invalid.length, 'row', 'rows')} skipped. Fix ${imp.invalid.length === 1 ? 'it' : 'them'} and import the file again — no one is added twice.`}
                    />
                  </>
                )}
              </div>
            )}

            {(imported || (nothingToDo && !imp)) && (
              <div className="imp-place">
                <h3 className="imp-place__title">Place them on the map</h3>
                {hasAddress
                  ? <GeocodeButton />
                  : <p className="imp-line">No street addresses in this file.</p>}
              </div>
            )}

            {/* Two ways on: place them (above) and see them. Map and Turfs are in the nav. */}
            {(imported || imp?.phase === 'error') && (imp?.created || 0) + (imp?.merged || 0) > 0 && (
              <div className="imp-actions imp-next">
                <Link className="btn imp-tap" to={peopleLink}>{tagClean ? `See “${tagWord(tagClean)}”` : 'See them'}</Link>
              </div>
            )}
          </>
        )}
      </Step>
    </div>
  );
}

// The pieces Donations → Import donations shares (pages/ImportGifts.jsx): how a
// file is read, and the steps’ small parts. (Which column is what is its
// own: components/GiftColumns.js.)
export {
  readTable, shapeTable, decodeBytes, isSpreadsheetBinary,
  fmtN, fmtMB, plural, breathe, DELIM_NAMES, MAX_FILE_BYTES,
  Step, Bar, Reveal, InvalidList,
};
