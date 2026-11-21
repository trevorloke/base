// The voter guide's logic, shared by the server's renderer, the website's
// island and the field app (VG). Pure: no I/O, and no time-zone arithmetic.
// Every moment comes from the server as epoch ms (server/lib/tzrule.js made
// it by B.C.'s current rule); hours and days are put into words from the
// stored 'HH:MM' and 'YYYY-MM-DD' strings, read as UTC, so neither the
// reader's zone nor its copy of the time-zone rules ever enters.
//
//   times  { status, today, todayEndsAt, bannerFrom,
//            days: [{ day, kind, opens, closes, startsAt, opensAt, closesAt, endsAt }] }
//   place  { id, name, address, city, area, lat, lng, accessible, curbside, note,
//            closed_on, closed_note, changed_day, changed_hm, position,
//            days: [{ day, opens, closes, opensAt, closesAt, own }] }
//
//   guideState(times, now, places?) → { state, day, next, opensAt, closesAt, boundary }
//   openNow(place, now) · placesOpen(places, now, day)
//   nearest(places, { lat, lng }, n, times, now) · nearVotingPlace(places, at, now, metres)
//   metresBetween(a, b) · distanceWords(m) · hoursWords(opens, closes, lang)
//   timeWords(hm, lang) · dayWords(day, lang) · dayParts(day, lang)
//   dateWordsFor(guide, lang) · seedDateWords(lang, words)
//   parsePlaces(text, guideDays) · normWords(s) · normAddress(s)

const HOUR = 3600 * 1000;
const DAY_MS = 24 * HOUR;
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// ── The guide's state ──
// not_out: not published, or no days · before: ahead of the first day's
// opening · open: inside a day's hours · between: after a close and before
// the next opening (the morning of a voting day too) · over: after the
// last close. boundary: the next moment anything drawn can change (a
// state, today, a place's own hours, the banner's window), at most 24 h on.
export function guideState(times, now, places = []) {
  const days = arr(times?.days).filter((d) => num(d?.opensAt) !== null && num(d?.closesAt) !== null);
  if (times?.status !== 'published' || !days.length) {
    return { state: 'not_out', day: null, next: null, opensAt: null, closesAt: null, boundary: null };
  }
  const last = days[days.length - 1];
  const cur = days.find((d) => d.opensAt <= now && now < d.closesAt) || null;
  const todays = days.find((d) => d.startsAt <= now && now < d.endsAt) || null;
  const coming = days.find((d) => d.opensAt > now) || null;
  let state = 'between';
  if (cur) state = 'open';
  else if (now < days[0].opensAt) state = 'before';
  else if (now >= last.closesAt) state = 'over';
  const day = todays ? todays.day : (times.today && num(times.todayEndsAt) !== null && now < times.todayEndsAt ? times.today : null);
  const next = cur || coming;
  const marks = [num(times.bannerFrom), num(times.todayEndsAt)];
  for (const d of days) marks.push(d.startsAt, d.opensAt, d.closesAt, d.endsAt);
  for (const p of arr(places)) for (const e of arr(p?.days)) marks.push(num(e?.opensAt), num(e?.closesAt));
  const after = marks.filter((t) => t !== null && t > now);
  const boundary = Math.min(now + DAY_MS, ...after);
  return { state, day, next, opensAt: next?.opensAt ?? null, closesAt: next?.closesAt ?? null, boundary };
}

// A place is open at a moment inside one of its days' hours, unless it is
// closed that day (closed_on: the one campaign day the desk closed it).
export const openNow = (p, now) => arr(p?.days).some((e) => e.opensAt <= now && now < e.closesAt && p.closed_on !== e.day);

// Each place with how it stands on the day drawn: its entry for that day
// (own hours or the day's), closed on it, open right now.
export const placesOpen = (places, now, day) => arr(places).map((p) => ({
  ...p,
  today: arr(p.days).find((e) => e.day === day) || null,
  closedToday: Boolean(day) && p.closed_on === day,
  openNow: openNow(p, now),
}));

// ── Distance ──
const RAD = Math.PI / 180;
export const metresBetween = (a, b) => {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
};
const pinned = (p) => num(p?.lat) !== null && num(p?.lng) !== null;

// "350 m", "1.2 km", "14 km".
export const distanceWords = (m) => {
  const v = Math.max(0, Number(m) || 0);
  if (v < 999.5) return `${Math.round(v)} m`;
  if (v < 9950) return `${(v / 1000).toFixed(1)} km`;
  return `${Math.round(v / 1000)} km`;
};

// The places nearest a point, with their distance: only places with a pin;
// open today first (not closed today, not yet closed), then those open on
// the next voting day, then the rest; nearer first; ties by position.
export function nearest(places, at, n = 3, times = null, now = Date.now()) {
  if (!pinned(at)) return [];
  const st = guideState(times, now);
  const day = st.day;
  const coming = arr(times?.days).find((d) => d.opensAt > now && d.day !== day)?.day || null;
  const rank = (p) => {
    const e = day ? arr(p.days).find((x) => x.day === day) : null;
    if (e && p.closed_on !== day && now < e.closesAt) return 0;
    if (coming && arr(p.days).some((x) => x.day === coming)) return 1;
    return 2;
  };
  return arr(places).filter(pinned)
    .map((p) => ({ ...p, distance: metresBetween(at, { lat: Number(p.lat), lng: Number(p.lng) }), rank: rank(p) }))
    .sort((a, b) => a.rank - b.rank || a.distance - b.distance || (a.position ?? 0) - (b.position ?? 0))
    .slice(0, n);
}

// The nearest place open now within `metres` of a point, or null: no
// campaigning near an open voting place (the field app's warning). A place
// with no pin can't be checked; one closed today isn't open.
export function nearVotingPlace(places, at, now, metres = 150) {
  if (!pinned(at)) return null;
  let best = null;
  for (const p of arr(places)) {
    if (!pinned(p) || !openNow(p, now)) continue;
    const d = metresBetween(at, { lat: Number(p.lat), lng: Number(p.lng) });
    if (d <= metres && (!best || d < best.distance)) best = { ...p, distance: d };
  }
  return best;
}

// ── Words for hours and days ──
const localeOf = (lang) => (!lang || lang === 'en' ? 'en-CA' : lang);
const fmts = new Map();
const fmt = (lang, opts) => {
  const k = `${lang}|${JSON.stringify(opts)}`;
  if (!fmts.has(k)) {
    let f;
    try { f = new Intl.DateTimeFormat(localeOf(lang), { ...opts, timeZone: 'UTC' }); } catch { f = new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' }); }
    fmts.set(k, f);
  }
  return fmts.get(k);
};
const HM = /^(\d\d):(\d\d)$/;
const DAY = /^(\d{4})-(\d\d)-(\d\d)$/;
// "8 a.m.", "8:30 p.m." (":00" dropped).
// A person's Language field (Pick several, or one choice) → the guide's
// language: Punjabi → pa, Mandarin → zh-Hans, Cantonese → zh-Hant, else en.
const GUIDE_LANGS = { punjabi: 'pa', mandarin: 'zh-Hans', cantonese: 'zh-Hant' };
export const guideLangOf = (value) => {
  for (const v of Array.isArray(value) ? value : [value]) {
    const code = GUIDE_LANGS[String(v ?? '').trim().toLowerCase()];
    if (code) return code;
  }
  return 'en';
};

// The words the server drew, keyed by language and kind: a browser whose
// copy of Intl lacks a language (desktop Chromium often has no Punjabi
// dates, and gives "M11 20") uses the server's words instead of its own,
// so the island hydrates to exactly what the server sent.
const drawn = new Map();
const said = (lang, key) => drawn.get(`${lang}|${key}`);
export const seedDateWords = (lang, words) => {
  if (!words || typeof words !== 'object') return;
  for (const [k, v] of Object.entries(words)) if (typeof v === 'string' && v) drawn.set(`${lang}|${k}`, v);
};

export const timeWords = (hm, lang = 'en') => {
  const known = said(lang, `t:${hm}`);
  if (known) return known;
  const m = HM.exec(String(hm ?? ''));
  if (!m) return '';
  const d = new Date(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2])));
  return fmt(lang, Number(m[2]) ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' }).format(d);
};
// "8 a.m.–8 p.m."
export const hoursWords = (opens, closes, lang = 'en') => `${timeWords(opens, lang)}–${timeWords(closes, lang)}`;
const dateOf = (day) => {
  const m = DAY.exec(String(day ?? ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
};
// "Sat, Oct 19"
export const dayWords = (day, lang = 'en') => {
  const known = said(lang, `dw:${day}`);
  if (known) return known;
  const d = dateOf(day);
  return d ? fmt(lang, { weekday: 'short', month: 'short', day: 'numeric' }).format(d) : '';
};
// { weekday: "Sat", date: "Oct 19" } for a day's tile.
export const dayParts = (day, lang = 'en') => {
  const d = dateOf(day);
  if (!d) return { weekday: '', date: '' };
  return {
    weekday: said(lang, `w:${day}`) || fmt(lang, { weekday: 'short' }).format(d),
    date: said(lang, `d:${day}`) || fmt(lang, { month: 'short', day: 'numeric' }).format(d),
  };
};
// Every day and hour word a guide can draw, made here (the server, with
// full ICU) for the island's props: seedDateWords(lang, these) in the browser.
export const dateWordsFor = (guide, lang = 'en') => {
  const days = new Set();
  const hms = new Set();
  const times = guide?.times || {};
  for (const d of arr(times.days)) { days.add(d.day); hms.add(d.opens); hms.add(d.closes); }
  for (const p of arr(guide?.places)) {
    for (const e of arr(p?.days)) { days.add(e.day); hms.add(e.opens); hms.add(e.closes); }
    if (p?.changed_hm) hms.add(p.changed_hm);
  }
  if (guide?.mail?.request_by) days.add(guide.mail.request_by);
  if (guide?.checkedOn) days.add(guide.checkedOn);
  const out = {};
  for (const day of days) {
    const d = dateOf(day);
    if (!d) continue;
    out[`w:${day}`] = fmt(lang, { weekday: 'short' }).format(d);
    out[`d:${day}`] = fmt(lang, { month: 'short', day: 'numeric' }).format(d);
    out[`dw:${day}`] = fmt(lang, { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  }
  for (const hm of hms) {
    const m = HM.exec(String(hm ?? ''));
    if (m) out[`t:${hm}`] = fmt(lang, Number(m[2]) ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' }).format(new Date(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2]))));
  }
  return out;
};

// ── Matching names and addresses ──
// Lowercase, accents and punctuation dropped, spaces collapsed.
export const normWords = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const STREET = { avenue: 'ave', av: 'ave', street: 'st', road: 'rd', boulevard: 'blvd', drive: 'dr', highway: 'hwy', place: 'pl', crescent: 'cres', court: 'ct', lane: 'ln', way: 'way', north: 'n', south: 's', east: 'e', west: 'w' };
// An address's words with the usual street words shortened ("Avenue" → "ave").
export const normAddress = (s) => normWords(s).split(' ').map((w) => STREET[w] || w).join(' ');

// ── Reading a pasted list of places (the import, decision 7) ──
export const MAX_IMPORT_ROWS = 300;
export const DAYS_PROBLEM = 'Use dates like YYYY-MM-DD or Oct 19, or Advance, Election day or All';
const COLUMNS = {
  name: ['name', 'location', 'facility', 'voting place', 'place', 'voting location'],
  address: ['address', 'street', 'street address', 'location address'],
  city: ['city', 'municipality', 'town'],
  days: ['days', 'day', 'dates', 'date', 'voting days', 'open'],
  accessible: ['accessible', 'accessibility', 'wheelchair accessible'],
  curbside: ['curbside', 'curbside voting', 'curb side'],
  area: ['area', 'neighbourhood', 'neighborhood', 'community', 'town centre'],
  note: ['note', 'notes', 'comment'],
  external_id: ['id', 'external id', 'location id', 'place id'],
};
const MONTHS = Object.fromEntries(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  .flatMap((m, i) => [[m, i], [m.slice(0, 3), i]]).concat([['sept', 8]]));

// Rows of cells: tabs when the paste has any (a spreadsheet), else CSV with
// quotes (a comma inside quotes stays in its cell; "" is a quote).
const rowsOf = (text) => {
  const t = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const delim = t.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && !cell.trim()) { quoted = true; cell = ''; } else if (ch === delim) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
};

const yesNo = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'x', '1', 'true', '✓'].includes(s)) return true;
  if (['no', 'n', '0', 'false'].includes(s)) return false;
  return null;
};

const validDay = (s) => {
  const d = dateOf(s);
  return Boolean(d) && d.toISOString().slice(0, 10) === s;
};

// A Days cell → the days, null for every listed day, or { problem }.
export const daysOf = (cell, guideDays = []) => {
  const listed = arr(guideDays).filter((d) => d && DAY.test(d.day));
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const out = new Set();
  for (const raw of s.split(/[;,]/)) {
    const tok = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!tok) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) {
      if (!validDay(tok)) return { problem: DAYS_PROBLEM };
      out.add(tok);
      continue;
    }
    if (tok === 'all' || tok === 'all days') { for (const d of listed) out.add(d.day); if (!listed.length) return { problem: DAYS_PROBLEM }; continue; }
    if (tok === 'advance' || tok === 'advance days') {
      const a = listed.filter((d) => d.kind === 'advance');
      if (!a.length) return { problem: DAYS_PROBLEM };
      for (const d of a) out.add(d.day);
      continue;
    }
    if (tok === 'election day' || tok === 'general' || tok === 'general voting day') {
      const g = listed.filter((d) => d.kind === 'general');
      if (!g.length) return { problem: DAYS_PROBLEM };
      for (const d of g) out.add(d.day);
      continue;
    }
    const m = /^([a-z]{3,9})\.? (\d{1,2})$/.exec(tok);
    const month = m ? MONTHS[m[1]] : undefined;
    if (month === undefined) return { problem: DAYS_PROBLEM };
    const want = `-${String(month + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    const hits = listed.filter((d) => d.day.endsWith(want));
    if (!hits.length) return { problem: DAYS_PROBLEM };
    for (const d of hits) out.add(d.day);
  }
  return out.size ? [...out].sort() : null;
};

// → { rows: [{ line, name, address, city, days, accessible, curbside, area,
// note, external_id, problem }], header, error? }. A row's days null: every
// listed day. More than 300 rows: { error } and no rows.
export function parsePlaces(text, guideDays = []) {
  const all = rowsOf(text);
  const first = (all[0] || []).map((c) => c.toLowerCase());
  const has = (key) => first.findIndex((c) => COLUMNS[key].includes(c));
  const header = has('name') >= 0 && has('address') >= 0;
  const at = header
    ? Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, has(k)]))
    : { name: 0, address: 1, days: 2, accessible: 3, city: -1, curbside: -1, area: -1, note: -1, external_id: -1 };
  const body = header ? all.slice(1) : all;
  if (body.length > MAX_IMPORT_ROWS) return { rows: [], header, error: `${MAX_IMPORT_ROWS} places is the most — split the list` };
  const rows = body.map((cells, i) => {
    const get = (k) => (at[k] >= 0 ? String(cells[at[k]] ?? '').trim() : '');
    const row = {
      line: i + 1,
      name: get('name'),
      address: get('address'),
      city: get('city'),
      area: get('area'),
      note: get('note'),
      external_id: get('external_id') || null,
      accessible: yesNo(get('accessible')),
      curbside: yesNo(get('curbside')),
      days: null,
      problem: null,
    };
    const days = daysOf(get('days'), guideDays);
    if (days && days.problem) row.problem = days.problem; else row.days = days;
    if (!row.name) row.problem = 'No name';
    else if (!row.address) row.problem = 'No address';
    else if (row.name.length > 120) row.problem = 'Name too long';
    else if (row.address.length > 200) row.problem = 'Address too long';
    else if (row.note.length > 200) row.problem = 'Note too long';
    else if (row.area.length > 60) row.problem = 'Area too long';
    return row;
  });
  return { rows, header };
}
