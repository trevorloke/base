// Kinds of shift — what a shift IS (a canvass, a Burma Shave), one
// catalogue for the server's checks and every screen. A kind brings what a
// manager would otherwise type or pick each time:
//   label   the words on screen and at the front of a made name
//   icon    the mark on a card (the screens draw it by this name)
//   color   a CSS variable the app already has (web/src/app.css), never
//           a hex. The coloured kinds have their own fixed hues (--kind-*),
//           apart from the brand and the status colours: a campaign's
//           colour never makes two kinds look alike
//   slots   its usual hours, the first one offered already chosen
//   minutes how long one usually runs, for a start picked by hand
//   role    the volunteer role it prefers (shared/canvass.js), which floats
//           those people up where someone is picked
//   turfs   whether it carries walk lists (the turf is then its place)
//   site    where the website lists it when it's public: with the
//           volunteer openings, or with the events
//   need    how many people it usually wants — only ever a suggestion: the
//           first number offered under "We need". No shift gets a target
//           unless someone taps one
// The codes are fixed (reports and ladders can count on them); a shift made
// before kinds has none and shows as its role implies (kindOf).
import { addDays } from './dayparts.js';

const slot = (start, end) => ({ start, end });

export const SHIFT_KINDS = [
  { code: 'canvass', label: 'Canvass', icon: 'door', color: '--kind-canvass', slots: [slot('10:00', '13:00'), slot('14:00', '17:00'), slot('18:00', '20:00')], minutes: 180, role: 'doorknocking', turfs: true, site: 'opening' },
  { code: 'phone_bank', label: 'Phone bank', icon: 'phone', color: '--kind-phone', slots: [slot('18:00', '20:00')], minutes: 120, role: 'phoning', turfs: false, site: 'opening' },
  { code: 'mainstreet', label: 'Mainstreet', icon: 'storefront', color: '--ok', slots: [slot('07:00', '09:00'), slot('16:30', '18:30')], minutes: 120, role: 'mainstreeting', turfs: false, site: 'opening', need: 2 },
  { code: 'burma_shave', label: 'Burma Shave', icon: 'wave', color: '--warn', slots: [slot('06:30', '08:30'), slot('16:00', '18:00')], minutes: 120, role: 'burmashave', turfs: false, site: 'opening', need: 4 },
  { code: 'lit_drop', label: 'Lit drop', icon: 'leaflet', color: '--text-2', slots: [slot('10:00', '12:00')], minutes: 120, role: 'doorknocking', turfs: true, site: 'opening' },
  { code: 'signs', label: 'Signs', icon: 'sign', color: '--text-3', slots: [slot('09:00', '12:00')], minutes: 180, role: null, turfs: false, site: 'opening' },
  { code: 'event', label: 'Event', icon: 'calendar', color: '--kind-event', slots: [], minutes: 120, role: 'event_hosting', turfs: false, site: 'event' },
  { code: 'office', label: 'Office', icon: 'desk', color: '--text-3', slots: [slot('09:00', '12:00'), slot('13:00', '16:00')], minutes: 180, role: 'administration', turfs: false, site: 'opening' },
  // "Other" names nothing, so a made name starts "Shift".
  { code: 'other', label: 'Other', name: 'Shift', icon: 'dot', color: '--text-4', slots: [], minutes: 120, role: null, turfs: false, site: 'opening' },
];
export const SHIFT_KIND_CODES = SHIFT_KINDS.map((k) => k.code);
export const shiftKind = (code) => SHIFT_KINDS.find((k) => k.code === code) || null;

// A shift with no kind shows as its role implies, else Other. Nothing is
// written back: old shifts stay as they were made.
const ROLE_KIND = {
  doorknocking: 'canvass', phoning: 'phone_bank', mainstreeting: 'mainstreet', burmashave: 'burma_shave', event_hosting: 'event',
};
export const kindOf = (shift) => shiftKind(shift?.kind) || shiftKind(ROLE_KIND[shift?.role]) || shiftKind('other');

// A point on the map that nothing could name (no corner, address or door
// near it) is saved by its coordinates: "Pin at 49.1630, −122.8447". Those
// stay in the place's details and behind its map link; wherever a shift's
// place is shown it is said as "Pinned place" until someone names it, and
// a message read away from the app (an email, a text) gives its map.
const coord = (n) => Number(n).toFixed(4).replace('-', '−'); // a real minus sign, as people write coordinates
export const PINNED_PLACE = 'Pinned place';
export const pinName = (lat, lng) => `Pin at ${coord(lat)}, ${coord(lng)}`;
export const isPinName = (name) => /^Pin at [−-]?\d{1,3}\.\d{4}, [−-]?\d{1,3}\.\d{4}$/.test(String(name ?? '').trim());
export const placeLabel = (name) => (isPinName(name) ? PINNED_PLACE : String(name ?? '').trim());
// Where a pin's words say it is: { lat, lng }, or null for any other words.
export const pinPoint = (name) => {
  if (!isPinName(name)) return null;
  const [lat, lng] = String(name).trim().slice('Pin at '.length).split(', ').map((x) => Number(x.replace('−', '-')));
  return { lat, lng };
};
// A shift's place in a message: its words, or for a pin nobody has named a
// map to tap (the one the app's own map links open).
export const mapUrl = ({ lat, lng }) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
export const whereWords = (name) => {
  const pin = pinPoint(name);
  return pin ? `see the map — ${mapUrl(pin)}` : String(name ?? '').trim();
};

// The name a shift is given when nobody types one: "Burma Shave — King
// George Blvd & 88 Ave", or just "Phone bank" with no place. No weekday in
// it — the date is always beside it.
export const madeTitle = (kind, place) => {
  const k = shiftKind(kind) || shiftKind('other');
  const where = placeLabel(place);
  return (where ? `${k.name || k.label} — ${where}` : (k.name || k.label)).slice(0, 300);
};

// Where the website lists a public shift: 'event', 'opening', or 'both' for
// a shift made before kinds (it shows in both, as it always did).
export const siteListOf = (shift) => (shiftKind(shift?.kind) ? shiftKind(shift.kind).site : 'both');
// The kinds the website lists under each heading (the server's query).
export const SITE_KINDS = {
  event: SHIFT_KINDS.filter((k) => k.site === 'event').map((k) => k.code),
  opening: SHIFT_KINDS.filter((k) => k.site === 'opening').map((k) => k.code),
};

// How many more people a shift wants: by its target (need) — a number that
// never refuses anyone — or, on a shift from before targets, by its limit.
// 0 when it has enough, or wants no number. `filled`: those holding a spot.
export const shortBy = (shift) => {
  const want = Number(shift?.need ?? shift?.capacity) || 0;
  return Math.max(0, want - (Number(shift?.filled) || 0));
};

// ── Many at once ──
// One "Add" makes every chosen day, and each of them again every week:
// `{ weeks: n }` — n weeks in all, the first included — or `{ until: day }`
// — while the day is on or before it. A chosen day is always made itself,
// and each day is in the list once (two chosen days a week apart repeat
// onto the same days). The screen's count ("Add 5 shifts") and the server
// use this same list.
export const MAX_SHIFTS = 200;
export const MAX_WEEKS = 26;
export const repeatDays = (days, repeat) => {
  const out = new Set();
  for (const day of [...new Set(days)].sort()) {
    out.add(day);
    for (let k = 1; k < MAX_WEEKS; k += 1) {
      const next = addDays(day, 7 * k);
      const more = repeat?.weeks ? k < repeat.weeks : Boolean(repeat?.until) && next <= repeat.until;
      if (!more) break;
      out.add(next);
    }
  }
  return [...out].sort();
};
