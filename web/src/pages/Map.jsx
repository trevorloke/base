// Map — field mode. Houses as pins (one per address + unit), colored by the
// household's strongest signal; tap a pin for the door card. Every pin is a
// 48px tap target. Pins carry no numbers (a rated door has a white dot, the
// color says the band; a household's head-count is a small people badge on
// its corner) — the only number on the map is a group's door count: doors
// that would overlap at the current zoom merge into one white bubble with a
// house and the count — tap it to zoom in. Volunteers open on their own turf
// ("My turf"); on their first visit one slim line under the pill says "Tap a
// house to start" until they open a door or tap its ✕ (remembered per
// browser). The chrome is one row: the "Show: …" filter pill (its sheet:
// which doors, then — desk — the turf outlines switch, walk lists and
// "Draw turf"), then a volunteer's "Walk list" chip, or for desk roles the
// "Draw turf" control and the "Not on map" count chip, and two round
// buttons (Locate me, + Add door). No signal and no doors loaded: one line
// and the walk list kept on the phone. Place mode drops
// people who have an address but no pin, "add door" creates a person at a
// tapped spot, and ?person=<id> deep-links to (and selects) a door. Turfs are
// translucent polygons (the Turfs chip shows/hides them); tap one for its
// sheet (progress, canvassers, walk list), desk roles draw new ones point by
// point, and ?turf=<id> fits the map to (and selects) a turf. ?draw=1 opens
// straight into drawing. Plain Leaflet in a ref'd div; divIcon pins so no
// marker-image paths are involved.
// Offline: the doors are kept on the phone (components/OfflineCache.js) and
// shown with "Offline copy" when there's no signal; what the outbox still
// holds (src/offline.js) is laid over them — a person added here, a dropped
// pin, a sign request, a rating — so it shows at once, marked "Not sent yet".
// Pins go through the outbox too. Tiles come from GET /api/map/config
// (OpenStreetMap unless STARBASE_TILE_* say otherwise); the service worker
// keeps the ones already looked at, so a turf seen with signal still draws.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { apiGet, action } from '../api.js';
import { applyOutbox, queueAction, useOutbox } from '../offline.js';
import { phoneCopy, showingCopy, useKeepCopy } from '../components/OfflineCache.js';
import { queuedText } from '../components/queued.js';
import { bandOf, offTail, ratingByCode } from '@starbase/shared/scale';
import { SIGN_KINDS } from '@starbase/shared/canvass';
import DoorCard, { AddDoorForm, SIGN_LABEL, doorTitle, patchDoors } from '../components/DoorCard.jsx';
import { More, useScale } from '../components/RatingButtons.jsx';
import GeocodeButton from '../components/GeocodeButton.jsx';
import { DEFAULT_TILES, safeAttribution } from '../components/tiles.js';
import { DotLayer, DensityLayer, cellAt, nearest } from './mapDots.js';
import { DOT_ZOOM, LONE_PIN_ZOOM, PIN_ZOOM, MARK, TILE_WAIT_MS, css, cellOf, cellsFrom, dotsFrom, drawnFor, inBox, placingPoll, rowsBudget, streetMove, tileAt, tileHealth, viewBox } from './mapView.js';
import { useSharePref } from '../components/ShareLocation.js';
import { cachedWalkLists, useOnline } from './Turfs.jsx';
import './map.css';
import { pendingVoted, useVotedMode } from '../components/Voted.jsx';
import { NS } from '../base.js';
import { OWN_BUILD } from '../build.js';
import MapCheck from './MapCheck.jsx';

const SURREY = [49.1913, -122.849];
// "My turf" (volunteers with a turf) comes first and is where they start:
// their walk list's doors, not the whole city's.
const MINE = { key: 'mine', label: 'My turf' };
// Which doors to show (one at a time). "Yes (1–2)" says what the rating
// buttons say; "Has a sign" is a which-doors choice too (doors with a sign).
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'support', label: 'Yes (1–2)' },
  { key: 'undecided', label: 'Undecided' },
  { key: 'opposed', label: 'Opposed' },
  { key: 'unrated', label: 'Unrated' },
  { key: 'signs', label: 'Has a sign' },
];
// With Election day on (ext/voted): the pull list, and who has voted.
const VOTED_FILTERS = [
  { key: 'gotv', label: 'Yes, not voted' },
  { key: 'voted', label: 'Voted' },
];
const FILTER_LABEL = Object.fromEntries([MINE, ...FILTERS, ...VOTED_FILTERS].map((f) => [f.key, f.label]));
// What a closer look shows, for the filters only the people themselves can
// answer ("Zoom in to see signs").
const CLOSER = { signs: 'signs', voted: 'who has voted', gotv: 'supporters who haven’t voted' };
// The rating apart: 1s and 2s on their own ("Strong yes (1)"), and each
// opponent on the "Voting for?" list ("Voting Locke") — in the campaign's
// own words. A door shows when anyone there has that rating.
const ratingFilters = (scale) => [
  ...scale.steps.filter((st) => st.band === 'support').map((st) => ({ key: `r:${st.code}`, label: `${st.word} (${st.code})`, band: 'support' })),
];
const opponentFilters = (scale) => scale.candidates.map((c) => ({ key: `r:${c.code}`, label: `Voting ${c.name}`, short: c.name, band: 'opposed', group: 'Voting for', off: c.off }));

// Signs on the map: which statuses (up, requested) and kinds show — the
// flags on doors, the signs with no door, and "Has a sign". Kept per phone.
const SIGNS_PREF = `${NS}map:signs`;
const SIGN_SHOW_STATUS = [['installed', 'Up'], ['requested', 'Requested']];
const readSignsPref = () => {
  try {
    const v = JSON.parse(localStorage.getItem(SIGNS_PREF) || 'null');
    if (v && Array.isArray(v.status) && Array.isArray(v.kinds)) return v;
  } catch { /* storage blocked or bad JSON */ }
  return { status: SIGN_SHOW_STATUS.map(([k]) => k), kinds: SIGN_KINDS.map((k) => k.code) };
};
const writeSignsPref = (v) => { try { localStorage.setItem(SIGNS_PREF, JSON.stringify(v)); } catch { /* storage blocked */ } };

// The map's look, each person's own (kept per browser): the campaign's
// standard tiles; Muted (grey, so the pins stand out) and Dark (for night),
// drawn over any tiles; and, with Google Maps on, its other looks
// (Satellite, Terrain) from /api/map/config views.
const VIEW_PREF = `${NS}map:view`;
const SHADES = [{ key: 'standard', label: 'Standard' }, { key: 'muted', label: 'Muted' }, { key: 'dark', label: 'Dark' }];
// Clean by default (a light, quiet base map from the server's views — no
// shop icons, parking lots or house numbers), else Muted: the base map stays
// in the background, so the doors' colours (support, undecided, opposed)
// are what you see. Standard and Dark are a tap away (Show → Map), and a
// choice made is kept.
const readViewPref = () => { try { return localStorage.getItem(VIEW_PREF) || 'clean'; } catch { return 'clean'; } };
const writeViewPref = (v) => { try { localStorage.setItem(VIEW_PREF, v); } catch { /* storage blocked */ } };
// When the street map isn't loading, the map may go to its other provider by
// itself — once in a page's life ({ from: the look that was picked, to: the
// one it went to }; from is null once it is back on the pick); after that
// the switch is the person's tap. While their pick is still the one that
// failed, the map keeps to the other — until their pick's provider answers
// again, or the other isn't loading either.
let fellBack = null;
// Does a street map's provider answer now? One of its tiles, asked of the
// network itself — no-store, which the service worker passes through, so a
// tile it kept is no answer — within a few seconds. A probe the browser
// refuses (a provider without CORS headers, a blocker) is a no as well:
// the map then never goes there by itself, and its one tap is Try again
// (mapView.js streetMove).
const PROBE_MS = 4000;
// On a look the map went to by itself, how often it asks again whether the
// person's own pick answers (a provider's hiccup is often over in a minute).
const PICK_AGAIN_MS = 60_000;
const NOT_SEEN = { url: null, down: false, any: false, settled: false }; // a tile layer that hasn't said yet
const answers = (url) => {
  const stop = typeof AbortController === 'function' ? new AbortController() : null;
  const t = setTimeout(() => stop?.abort(), PROBE_MS);
  return fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: stop?.signal })
    .then((r) => r.ok, () => false)
    .finally(() => clearTimeout(t));
};
// Where a tile address points, in a word a person (or a screenshot) can
// read: its host — never the whole address, which may carry a key. '' for
// the server's own tiles.
const tileHost = (url) => {
  try { return /^https?:/i.test(url || '') ? new URL(url.replace(/\{s\}\./g, '').replace(/\{[^}]*\}/g, 'x')).hostname : ''; } catch { return ''; }
};

const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const norm = (s) => String(s || '').trim().toLowerCase();
// 300049 → "300,049" (a whole voter list's counts).
const num = (n) => (n == null ? '' : Number(n).toLocaleString('en-CA'));
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Leaflet hands back unwrapped longitudes after panning round the world; the
// server's zod schema wants lat ∈ [-90, 90], lng ∈ [-180, 180].
const wrapped = (latlng) => { const ll = L.latLng(latlng).wrap(); return { lat: ll.lat, lng: ll.lng }; };
// person.create is desk-only (manager/treasurer/staff); volunteers can rate,
// log, place pins and request signs, and add a housemate at a door inside a
// turf they walk (person.addAtDoor), but not add new doors.
const CREATE_ROLES = ['manager', 'treasurer', 'staff'];
const isTyping = (el) =>
  el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

// ── Turfs ──
// New turfs cycle through hues that never read as a rating band (no green,
// yellow or red), so a turf outline can't be mistaken for support/opposed.
const TURF_COLORS = ['#2b6cb0', '#7b3fa0', '#b5651d', '#1f7a6d', '#a0306a', '#4c5a8a'];
const MAX_TURF_POINTS = 500; // turf.create: polygon max(500)
const TURFS_PREF = `${NS}map:turfs`;
const EMPTY_LIST = [];
const EMPTY_DRAFT = { points: [], naming: false };
// The map's turfs. A volunteer's own (a few) come whole, counts and all, and
// stay on the phone: with no signal they still open on "My turf". Anyone
// else's map asks for names and outlines only (GET /turfs?outline=1) — a
// city cut into 158 turfs took seconds to count, and no outline showed
// until it had; a turf's counts are asked for when its sheet opens.
const TURFS_WHOLE = { key: ['turfs'], path: '/turfs', copy: 'turfs' };
const TURFS_OUTLINE = { key: ['turfs', 'outline'], path: '/turfs?outline=1', copy: 'turfOutlines' };
const turfCountsKey = (id) => ['turfs', 'counts', id];
// While it runs, what it has placed so far is drawn this often.
const PLACING_REFRESH_MS = 15_000;
const readTurfsPref = () => { try { return localStorage.getItem(TURFS_PREF) !== '0'; } catch { return true; } };
const writeTurfsPref = (on) => { try { localStorage.setItem(TURFS_PREF, on ? '1' : '0'); } catch { /* storage blocked */ } };
// A volunteer's first-visit hint, once per browser (blocked storage: once per visit).
const HINT_PREF = `${NS}map:hint-seen`;
const readHintSeen = () => { try { return localStorage.getItem(HINT_PREF) === '1'; } catch { return false; } };
const writeHintSeen = () => { try { localStorage.setItem(HINT_PREF, '1'); } catch { /* storage blocked */ } };

const hashIndex = (s, n) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; };
const isColor = (c) => typeof c === 'string' && c.length <= 20 && typeof CSS !== 'undefined' && CSS.supports?.('color', c);
const turfColor = (t) => (isColor(t?.color) ? t.color : TURF_COLORS[hashIndex(t?.id || t?.name || '', TURF_COLORS.length)]);
const validRing = (ring) => Array.isArray(ring) && ring.length >= 3
  && ring.every((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));

// Same ray-casting test the server uses for walk lists (server/lib/geo.js).
function pointInPolygon(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Doors + people inside a ring, from the map's own door model (an estimate
// for a turf that is still being drawn; the server's numbers replace it).
function countInside(doors, ring) {
  let n = 0;
  let people = 0;
  for (const d of doors) {
    if (pointInPolygon(d.lat, d.lng, ring)) { n += 1; people += d.persons.length; }
  }
  return { doors: n, people };
}

// One door per (address + unit); located people without an address group by spot.
const doorKey = (p) =>
  p.address ? `${norm(p.address)}|${norm(p.unit)}` : `@${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;

// Household signal: any opposed → opposed; else any support → support;
// else any undecided → undecided; else unrated.
function householdBand(persons) {
  let support = false;
  let undecided = false;
  for (const p of persons) {
    const band = bandOf(p.rating);
    if (band === 'opposed') return 'opposed';
    if (band === 'support') support = true;
    else if (band === 'undecided') undecided = true;
  }
  return support ? 'support' : undecided ? 'undecided' : 'unrated';
}

function buildDoors(data) {
  const byKey = new Map();
  for (const p of data.persons || []) {
    const key = doorKey(p);
    let door = byKey.get(key);
    if (!door) {
      door = { key, address: p.address, unit: p.unit, lat: Number(p.lat), lng: Number(p.lng), persons: [], signs: [] };
      byKey.set(key, door);
    }
    door.persons.push(p);
  }
  const byPerson = new Map();
  for (const door of byKey.values()) for (const p of door.persons) byPerson.set(p.id, door);
  const orphanSigns = [];
  for (const s of data.signs || []) {
    const door = (s.person_id && byPerson.get(s.person_id)) || (s.address && byKey.get(`${norm(s.address)}|`)) || null;
    if (door) door.signs.push(s);
    else if (s.lat != null && s.lng != null) orphanSigns.push(s);
  }
  const doors = [...byKey.values()];
  for (const door of doors) door.band = householdBand(door.persons);
  spreadStacked(doors);
  return { doors, byPerson, orphanSigns };
}

// Units in one building share a lat/lng, so their pins would stack exactly.
// Fan the extras out on a small sunflower spiral (pixel offsets, unit order)
// so every door stays tappable; the first unit keeps the true spot.
function spreadStacked(doors) {
  const spots = new Map();
  for (const door of doors) {
    door.offset = [0, 0];
    const k = `${door.lat.toFixed(5)},${door.lng.toFixed(5)}`;
    if (!spots.has(k)) spots.set(k, []);
    spots.get(k).push(door);
  }
  for (const group of spots.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.unit || '').localeCompare(String(b.unit || ''), undefined, { numeric: true }));
    group.forEach((door, i) => {
      const r = 36 * Math.sqrt(i); // ≥ CLUSTER_PX apart once zoomed all the way in
      const t = i * 2.39996; // golden angle
      door.offset = [Math.round(r * Math.cos(t)), Math.round(r * Math.sin(t))];
    });
  }
}

const EMPTY_MODEL = { doors: [], byPerson: new Map(), orphanSigns: [] };
// Two loads of /map/doors as one (each person and sign once).
function mergeDoorData(whole, view) {
  if (!view) return whole;
  if (!whole) return view;
  const ids = new Set(whole.persons.map((p) => p.id));
  const signIds = new Set(whole.signs.map((x) => x.id));
  return {
    ...whole,
    persons: [...whole.persons, ...view.persons.filter((p) => !ids.has(p.id))],
    signs: [...whole.signs, ...view.signs.filter((x) => !signIds.has(x.id))],
  };
}

// ── Pins, count bubbles, sign flags ──
// Every marker is a 48x48 transparent hit box (field rule) around the
// visible glyph. Doors closer than CLUSTER_PX on screen merge into one
// bubble, so a tap always lands on the door it looks like it lands on.
const CLUSTER_PX = 36;
// A volunteer's turf opens as close as its doors allow: just room for the
// edge pins (half a 48px hit box), so neighbours land far enough apart.
const PIN_INSET = 20;
const CLUSTER_OFF_ZOOM = 19; // everything apart (or the tiles' max zoom, if lower)
// From street zoom (PIN_ZOOM, mapView.js) every door is a full pin, with its
// household and sign flags; pins that would overlap (an apartment block)
// share a bubble until they come apart. One zoom further out
// (LONE_PIN_ZOOM) a door with LONE_PX of room around it — its whole 48px
// tap box clear of any other door — already has its pin. Further out, every
// door is a small dot in its band's colour, drawn on canvas tiles
// (mapDots.js) — no numbers, no piles. A list too big to load at once (the
// server says big) is asked for by the part of the map on screen from
// DOT_ZOOM, and further out still is drawn as a picture: shaded patches of
// people (GET /api/map/density).
const LONE_PX = 48;
// A tap on a dot opens its door from here; further out the dots sit too
// close to tell one from the next, so the tap goes closer first.
const TAP_OPENS_ZOOM = 15;
// The marks' colours, named (the line under the count).
const KEY = [['unrated', 'Not asked yet'], ['support', 'Yes'], ['undecided', 'Undecided'], ['opposed', 'Opposed']];
// Its height with its line of words: a big list is fitted before the key is
// on screen (there are no marks to explain yet), so the fit leaves it room.
const KEY_ROOM = 60;
// "Not asked yet" and undecided's darker edge for map.css (pins, bubbles,
// the filter's dot): the same as the canvas dots'.
const MARK_VARS = { '--door-unrated': css(MARK.unratedPin), '--door-undecided-edge': css(MARK.undecidedEdge.light) };

// The service worker keeps tiles from this provider once they've been seen
// (never fetched ahead — tile servers' rules).
function tellServiceWorker(url) {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (!sw) return;
  const msg = { type: 'starbase:tiles', url };
  sw.controller?.postMessage(msg);
  sw.ready?.then((reg) => reg.active?.postMessage(msg)).catch(() => {});
}
const SIGN_STATUS = { installed: 'Installed', requested: 'Requested', removed: 'Removed' };
const HOUSE_SVG = '<svg viewBox="0 0 12 10" aria-hidden="true"><path d="M6 0 0 5h1.6v5h3.2V7h2.4v3h3.2V5H12z"/></svg>';
const PEOPLE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="4.6" r="3.1"/><path d="M1.8 15.5c0-3.6 2.8-6.2 6.2-6.2s6.2 2.6 6.2 6.2z"/></svg>';

// "Rosa Delgado (4 · Locke)" for a pin's title (the campaign's scale).
function personTitle(scale, p) {
  const r = ratingByCode(scale, p.rating);
  if (!r) return p.name;
  return `${p.name} (${r.band === 'opposed' && r.code !== '4' ? `4 · ${r.name}${offTail(r)}` : r.short})`;
}

// A door pin; its signs fly as little flags at the top-right, inside the
// same hit box, so tapping a flag opens the door.
function pinIcon(door, selected, signOk = () => true) {
  const n = door.persons.length;
  const cls = ['map-pin', `map-pin--${door.band}`, n > 1 ? 'map-pin--multi' : '', selected ? 'map-pin--selected' : ''].filter(Boolean).join(' ');
  const household = n > 1 ? `<span class="map-pin__hh">${PEOPLE_SVG}${n}</span>` : '';
  const flags = door.signs.filter(signOk).slice(0, 3).map((s, i) =>
    `<i class="map-flag map-flag--${esc(s.status)} map-flag--k-${esc(s.kind)}" style="left:${34 + i * 10}px;top:-6px"><i class="map-flag__face"></i><i class="map-flag__post"></i></i>`).join('');
  return L.divIcon({
    className: 'map-pin-wrap',
    // No digit on a pin (a "3" would read as 3 doors next to a count bubble):
    // a rated door gets a white dot, the color says the band.
    html: `<div class="${cls}">${door.band === 'unrated' ? '' : '<span class="map-pin__dot"></span>'}${household}</div>${flags}`,
    iconSize: [48, 48],
    iconAnchor: [24 - door.offset[0], 42 - door.offset[1]],
  });
}

// A bubble for several nearby doors: the count, ringed by their bands.
function clusterIcon(doors, offset) {
  const c = { support: 0, undecided: 0, opposed: 0, unrated: 0 };
  for (const d of doors) c[d.band] += 1;
  const pct = (k) => `${((k / doors.length) * 100).toFixed(1)}%`;
  const a = c.support;
  const b = a + c.undecided;
  const o = b + c.opposed;
  // Bigger for more doors, so where the people are reads at a glance.
  const n = doors.length;
  const size = n < 10 ? 40 : n < 100 ? 48 : n < 1000 ? 58 : 68;
  const label = n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
  return L.divIcon({
    className: 'map-cluster-wrap',
    html: `<div class="map-cluster" style="--a:${pct(a)};--b:${pct(b)};--c:${pct(o)};--size:${size}px"><span class="map-cluster__n">${label}</span></div>`,
    iconSize: [size + 6, size + 6],
    iconAnchor: [(size + 6) / 2 - offset[0], (size + 6) / 2 - offset[1]],
  });
}

// A sign with no door: its own 48px tap target.
function signIcon(status, kind) {
  return L.divIcon({
    className: 'map-sign-wrap',
    html: `<i class="map-flag map-flag--${esc(status)} map-flag--k-${esc(kind)}"><i class="map-flag__face"></i><i class="map-flag__post"></i></i>`,
    iconSize: [48, 48],
    iconAnchor: [24, 34],
  });
}

// Group doors whose pins would sit closer than CLUSTER_PX at this zoom.
// Projection math only (no map instance needed); offsets are the stacked
// units' fan-out, in pixels.
// Only the doors on screen (and a margin, so a short pan doesn't show
// empty edges) are grouped and drawn: a whole voter list is tens of
// thousands of doors, and every marker is a page element.
function clusterDoors(doors, zoom, offZoom = CLUSTER_OFF_ZOOM, bounds = null, RADIUS = CLUSTER_PX) {
  if (zoom == null) return EMPTY_LIST;
  const inView = bounds ? doors.filter((d) => bounds.contains([d.lat, d.lng])) : doors;
  if (zoom >= offZoom) return inView.map((d) => [d]);
  const R2 = RADIUS * RADIUS;
  const cells = new Map();
  const groups = [];
  for (const d of inView) {
    const pt = L.CRS.EPSG3857.latLngToPoint(L.latLng(d.lat, d.lng), zoom);
    const x = pt.x + d.offset[0];
    const y = pt.y + d.offset[1];
    const cx = Math.floor(x / RADIUS);
    const cy = Math.floor(y / RADIUS);
    let hit = null;
    for (let i = -1; i <= 1 && !hit; i += 1) {
      for (let j = -1; j <= 1 && !hit; j += 1) {
        for (const g of cells.get(`${cx + i},${cy + j}`) || EMPTY_LIST) {
          if ((g.x - x) ** 2 + (g.y - y) ** 2 < R2) { hit = g; break; }
        }
      }
    }
    if (hit) { hit.doors.push(d); continue; }
    const g = { x, y, doors: [d] };
    groups.push(g);
    const k = `${cx},${cy}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(g);
  }
  return groups.map((g) => g.doors);
}

const newDoorIcon = () => L.divIcon({ className: 'map-new-wrap', html: '<div class="map-new-pin"></div>', iconSize: [26, 34], iconAnchor: [13, 32] });
const meIcon = () => L.divIcon({ className: 'map-me-wrap', html: '<div class="map-me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });

// Pan so a latlng is not hidden under the overlays: the filter strip on top
// and the drawer (right panel on desktop, bottom sheet on phones). Measures
// the real DOM, so it holds whatever the chrome wraps to.
function revealLatLng(map, ll, page) {
  const size = map.getSize();
  const box = map.getContainer().getBoundingClientRect();
  const topEl = page?.querySelector('.map-top');
  const sheet = page?.querySelector('.map-sheet');
  const top = topEl ? Math.max(0, topEl.getBoundingClientRect().bottom - box.top) + 8 : 96;
  let right = size.x;
  let bottom = size.y;
  if (sheet) {
    const r = sheet.getBoundingClientRect();
    if (isPhone()) bottom = Math.min(bottom, r.top - box.top);
    else right = Math.min(right, r.left - box.left);
  }
  if (bottom - top < 80) bottom = top + 80; // tiny viewports: best effort
  const pt = map.latLngToContainerPoint(ll);
  if (pt.x > 24 && pt.x < right - 24 && pt.y > top + 40 && pt.y < bottom - 12) return;
  map.setView(ll, Math.max(map.getZoom(), 16), { animate: false });
  // Put the pin (tip at ll, body ~38px above) in the middle of the free area.
  const cx = right / 2;
  const cy = (top + bottom) / 2 + 19;
  map.panBy([size.x / 2 - cx, size.y / 2 - cy], { animate: false });
}

// Fit a turf into the part of the map the overlays leave free (filter strip
// on top, the sheet on the right on desktop or along the bottom on phones).
// onlyIfHidden: leave the view alone when every corner is already in sight.
// inset: extra pixels on every side (room for the pins at the edges).
// more: extra pixels at the top (room for a line that isn't on screen yet).
function fitTurf(map, ring, page, { onlyIfHidden = false, maxZoom = 17, pad = 0, inset = 0, more = 0 } = {}) {
  const size = map.getSize();
  const box = map.getContainer().getBoundingClientRect();
  const topEl = page?.querySelector('.map-top');
  const sheet = page?.querySelector('.map-sheet');
  const gap = 16;
  let top = gap;
  let right = gap;
  let bottom = gap;
  if (topEl && topEl.offsetParent !== null) top = Math.max(gap, topEl.getBoundingClientRect().bottom - box.top + 8) + more;
  if (sheet) {
    const r = sheet.getBoundingClientRect();
    if (isPhone()) bottom = Math.max(gap, box.bottom - r.top + 8);
    else right = Math.max(gap, box.right - r.left + 8);
  }
  // Tiny viewports: keep at least a sliver of map to fit into.
  if (size.y - top - bottom < 120) bottom = Math.max(gap, size.y - top - 120);
  if (size.x - right - gap < 120) right = gap;
  if (onlyIfHidden && ring.every((ll) => {
    const pt = map.latLngToContainerPoint(ll);
    return pt.x >= gap && pt.x <= size.x - right && pt.y >= top && pt.y <= size.y - bottom;
  })) return;
  const bounds = pad ? L.latLngBounds(ring).pad(pad) : L.latLngBounds(ring);
  map.fitBounds(bounds, {
    paddingTopLeft: [gap + inset, top + inset],
    paddingBottomRight: [right + inset, bottom + inset],
    maxZoom,
    animate: false,
  });
}

// The first corner of a turf being drawn: a 44px tap target (tap it to close
// the shape once there are 3+ corners) around a visible dot.
const draftStartIcon = (closable) => L.divIcon({
  className: `map-draft-start${closable ? ' is-closable' : ''}`,
  html: '<span class="map-draft-dot"></span>',
  iconSize: [44, 44],
  iconAnchor: [22, 22],
});

function TurfGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-glyph">
      <path d="M5 7l8-3 7 6-3 9-11-2z" />
      <circle cx="5" cy="7" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="13" cy="4" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="20" cy="10" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="17" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="6" cy="17" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function FilterGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-glyph">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

// A walk list: a list with tick boxes.
function WalkGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-glyph">
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11" />
      <circle cx="5.5" cy="18" r="1.6" />
    </svg>
  );
}

function PinGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-glyph">
      <path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  );
}

function LocateGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  );
}

// People with an address but no pin yet. Server search, client filter.
function PlacePicker({ unlocated, onPick, onClose }) {
  const [q, setQ] = useState('');
  const persons = useQuery({
    queryKey: ['persons', 'unlocated', q],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(q)}&limit=500`),
    placeholderData: keepPreviousData,
  });
  const rows = (persons.data?.persons ?? []).filter((p) => p.lat == null && p.address);
  const partial = !q && persons.data && rows.length < unlocated;
  return (
    <aside className="map-sheet map-place-picker" aria-label="People not on the map yet">
      <header className="mapsheet-head">
        <h2 className="mapsheet-title">Drop pins by hand · {num(unlocated)}</h2>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="field">
        <label htmlFor="place-q" className="fk-sr">Search</label>
        <input
          id="place-q" className="input" type="search" autoFocus placeholder="Search name or street"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {persons.isError && <p className="error" style={{ padding: '0 16px' }}>{persons.error.message}</p>}
      <ul className="map-place-list">
        {rows.map((p) => (
          <li key={p.id}>
            <button type="button" className="map-place-row" onClick={() => onPick(p)}>
              <span className="map-place-row__name">{p.name}</span>
              <span className="map-place-row__addr muted">{p.unit ? `${p.unit} – ` : ''}{p.address}</span>
            </button>
          </li>
        ))}
        {partial && rows.length > 0 && (
          <li className="muted map-place-empty">{num(rows.length)} of {num(unlocated)} · search for more</li>
        )}
        {persons.isPending && persons.fetchStatus === 'paused' && (
          <li className="muted map-place-empty">Offline — loads with signal</li>
        )}
        {rows.length === 0 && !persons.isPending && (
          <li className="muted map-place-empty">{q ? 'No match' : 'Everyone is on the map'}</li>
        )}
      </ul>
    </aside>
  );
}

function TurfBar({ done, total }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <span
      className="turf-bar" role="progressbar" aria-label="Doors done"
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(done, total)}
    >
      <span className="turf-bar__fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

// The sheet for one turf: progress and the walk list up front; canvassers
// (desk roles assign/remove) and the rest (numbers, delete with an in-place
// confirm, all turfs) one tap away.
function TurfSheet({ turf, me, desk, onClose, onDeleted, toast }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pick, setPick] = useState('');
  const [confirming, setConfirming] = useState(false);
  // A turf nobody walks yet: open the canvassers straight away for desk roles.
  const [whoOpen, setWhoOpen] = useState(() => desk && turf.members.length === 0);
  const [moreOpen, setMoreOpen] = useState(false);
  const membersQ = useQuery({ queryKey: ['members'], queryFn: () => apiGet('/members'), enabled: desk, staleTime: 60_000 });
  const teamsQ = useQuery({ queryKey: ['teams'], queryFn: () => apiGet('/teams'), enabled: desk, staleTime: 60_000 });
  const assigned = new Set(turf.members.map((m) => m.id));
  const options = (membersQ.data?.members ?? []).filter((m) => !assigned.has(m.id));
  // A team with someone not on the turf yet.
  const teams = (teamsQ.data?.teams ?? []).filter((t) => t.members.some((m) => !assigned.has(m.id)));
  // Its counts: with the turf where it came whole (a volunteer's own), else
  // asked for now that its sheet is open — "Loading…" until they are here,
  // never a "No doors" or a 0 on the way.
  const whole = turf.doors != null;
  const countsQ = useQuery({ queryKey: turfCountsKey(turf.id), queryFn: () => apiGet(`/turfs/${turf.id}`), enabled: !whole });
  const counts = whole ? turf : countsQ.data?.turf || null;
  const left = counts ? Math.max(0, counts.doors - counts.doorsDone) : 0;
  const invite = me?.role === 'manager'; // the Team screen is manager-only

  // Assignment changes the turf list and Today's "my turfs".
  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    try {
      await action(name, input);
      await Promise.all(['turfs', 'brief'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      return true;
    } catch (err) {
      setError(err.message || 'Not saved — try again');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const assign = async (e) => {
    e.preventDefault();
    if (!pick) return;
    if (pick.startsWith('team:')) {
      const team = teams.find((t) => `team:${t.id}` === pick);
      if (await run('turf.assign', { turf_id: turf.id, team_id: pick.slice(5) })) {
        setPick('');
        toast(`${team?.name || 'The team'} added`);
      }
      return;
    }
    const who = options.find((m) => m.id === pick);
    if (await run('turf.assign', { turf_id: turf.id, user_id: pick })) {
      setPick('');
      toast(`${who?.name || 'They'} added`);
    }
  };

  const unassign = async (m) => {
    if (await run('turf.unassign', { turf_id: turf.id, user_id: m.id })) toast(`${m.name} removed`);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('turf.delete', { id: turf.id });
      onDeleted(turf); // close the sheet first so the URL never points at a missing turf
      queryClient.removeQueries({ queryKey: ['turf', turf.id] });
      queryClient.removeQueries({ queryKey: turfCountsKey(turf.id) });
      // Off every list of turfs in memory (whole, and the map's outlines).
      queryClient.setQueriesData({ queryKey: ['turfs'] }, (d) => (d?.turfs ? { ...d, turfs: d.turfs.filter((t) => t.id !== turf.id) } : d));
      for (const key of ['turfs', 'brief']) queryClient.invalidateQueries({ queryKey: [key] });
    } catch (err) {
      setError(err.message || 'Not deleted — try again');
      setBusy(false);
    }
  };

  return (
    <aside className="map-sheet turf-sheet" aria-label={`Turf: ${turf.name}`} style={{ '--turf': turfColor(turf) }}>
      <header className="mapsheet-head">
        <h2 className="mapsheet-title"><i className="turf-swatch" aria-hidden="true" />{turf.name}</h2>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close turf">✕</button>
      </header>

      <div className="turf-sheet__body">
        {/* One phrase everywhere (sheet, walk list, turf list, Today): "1 door left" + the bar. */}
        <div className="turf-progress">
          {counts ? (
            <>
              <span className={`turf-progress__text mono${counts.doors && !left ? ' is-done' : ''}`}>
                {counts.doors === 0 ? 'No doors' : left === 0 ? <>All done <span aria-hidden="true">✓</span></> : <><strong>{num(left)}</strong> {left === 1 ? 'door' : 'doors'} left</>}
              </span>
              <TurfBar done={counts.doorsDone} total={counts.doors} />
            </>
          ) : countsQ.isError ? (
            <button type="button" className="btn turf-act turf-retry" onClick={() => countsQ.refetch()}>Unavailable — Try again</button>
          ) : (
            <span className="turf-progress__text" role="status">{countsQ.fetchStatus === 'paused' ? 'No signal — its counts load when you’re back' : 'Loading…'}</span>
          )}
        </div>
        <Link className="btn btn-primary turf-act" to={`/turfs/${turf.id}`}>Open walk list</Link>

        {/* Assignment is desk work; a volunteer gets the names under More. */}
        {desk && (
        <More id="turf-who" label={`Canvassers · ${turf.members.length}`} open={whoOpen} onToggle={() => setWhoOpen((o) => !o)}>
          {turf.members.length === 0 ? (
            <p className="muted turf-none">No one yet</p>
          ) : (
            <ul className="turf-members">
              {turf.members.map((m) => (
                <li key={m.id} className="turf-member">
                  <span className="turf-member__name">
                    {m.name}{m.id === me?.user?.id && <span className="muted"> (you)</span>}
                  </span>
                  {desk && (
                    <button
                      type="button" className="btn btn-quiet turf-member__remove" disabled={busy}
                      aria-label={`Take ${m.name} off this turf`} title="Take off this turf"
                      onClick={() => unassign(m)}
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* Nobody left to add: no dead picker, just the line (and the invite). */}
          {membersQ.data && !options.length ? (
            <p className="turf-everyone">
              Everyone is on it
              {invite && <> · <Link className="turf-invite" to="/settings">Invite someone</Link></>}
            </p>
          ) : (
            <>
              <form className="turf-assign" onSubmit={assign}>
                <div className="field">
                  <label htmlFor="turf-assign" className="fk-sr">Add a canvasser</label>
                  <select
                    id="turf-assign" className="input" value={pick} disabled={busy || !options.length}
                    onChange={(e) => setPick(e.target.value)}
                  >
                    <option value="">
                      {/* isPending, not isLoading: offline the fetch is paused, and
                          "everyone is on it" would be a wrong answer. */}
                      {membersQ.isPending
                        ? (membersQ.fetchStatus === 'paused' ? 'Offline' : 'Loading…')
                        : membersQ.isError ? 'Couldn’t load the team' : 'Add a canvasser…'}
                    </option>
                    {options.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role}</option>)}
                    {teams.length > 0 && (
                      <optgroup label="Teams">
                        {teams.map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name} · {t.members.length} {t.members.length === 1 ? 'person' : 'people'}</option>)}
                      </optgroup>
                    )}
                  </select>
                </div>
                <button type="submit" className="btn turf-act" disabled={busy || !pick}>Add</button>
              </form>
              {/* A new campaign's team is just the manager: the way to more people is right here. */}
              {invite && <Link className="fk-link turf-invite-link" to="/settings">Invite someone</Link>}
            </>
          )}
          {membersQ.isError && <p className="error">{membersQ.error.message}</p>}
        </More>
        )}

        <More id="turf-more" open={moreOpen} onToggle={() => setMoreOpen((o) => !o)}>
          {counts && (
            <dl className="turf-stats">
              <div><dt>Left</dt><dd>{num(left)}</dd></div>
              <div><dt>People</dt><dd>{num(counts.people)}</dd></div>
              <div><dt>Rated</dt><dd>{num(counts.rated)}</dd></div>
            </dl>
          )}
          {!desk && turf.members.length > 0 && (
            <p className="turf-crew">
              {turf.members.map((m) => (m.id === me?.user?.id ? `${m.name} (you)` : m.name)).join(' · ')}
            </p>
          )}
          {desk && (
            confirming ? (
              <div className="turf-confirm" role="group" aria-label="Confirm delete">
                <p>Delete this turf? Knocks stay.</p>
                <div className="turf-confirm__btns">
                  <button type="button" className="btn turf-act turf-danger" disabled={busy} onClick={remove}>
                    {busy ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button type="button" className="btn turf-act" disabled={busy} autoFocus onClick={() => setConfirming(false)}>
                    No
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-quiet turf-act turf-delete" onClick={() => { setConfirming(true); setError(null); }}>
                Delete turf
              </button>
            )
          )}
          <Link className="btn btn-quiet turf-act" to="/turfs">All turfs</Link>
        </More>

        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </aside>
  );
}

// A sign that isn't at a known door: what it is, where, and (desk) the list.
function SignSheet({ sign, desk, onClose }) {
  return (
    <aside className="map-sheet sign-sheet" aria-label="Sign">
      <header className="mapsheet-head">
        <div className="door-head">
          <h2 className="mapsheet-title door-head__name">{SIGN_LABEL[sign.kind] || 'Sign'}</h2>
          {sign.address && <span className="door-head__addr">{sign.address}</span>}
        </div>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close sign">✕</button>
      </header>
      <div className="turf-sheet__body">
        <span className={`chip sign-sheet__chip ${sign.status === 'installed' ? 'chip-ok' : 'chip-warn'}`}>
          {SIGN_STATUS[sign.status] || sign.status}
        </span>
        {desk && <Link className="btn turf-act sign-sheet__act" to="/signs">All signs</Link>}
      </div>
    </aside>
  );
}

// A name to start from, so Save works on the first tap: the street(s) most
// of the doors inside are on ("72 Ave", "72 Ave & 128 St"), else "Turf 3";
// a number is added when another turf already has the name.
function suggestTurfName(doors, ring, taken) {
  const streets = new Map();
  for (const d of doors) {
    if (!d.address || !pointInPolygon(d.lat, d.lng, ring)) continue;
    const street = String(d.address).replace(/^\s*[\d-]+[A-Za-z]?\s+/, '').replace(/,.*$/, '').trim();
    if (street) streets.set(street, (streets.get(street) || 0) + 1);
  }
  const top = [...streets.entries()].sort((a, b) => b[1] - a[1]).map(([st]) => st);
  const used = new Set(taken.map((t) => norm(t)));
  let base = top.length ? top.slice(0, 2).join(' & ') : `Turf ${taken.length + 1}`;
  if (base.length > 120) base = base.slice(0, 120).trim();
  let name = base;
  for (let n = 2; used.has(norm(name)); n += 1) name = `${base} ${n}`;
  return name;
}

// After Finish: name the drawn shape. The draft stays on the map behind it.
// counted: the map has every door inside loaded (a list loaded whole) — on a
// big list it hasn't, so no count is claimed here; the saved turf's sheet
// has the server's.
function NameTurfForm({ points, doors, takenNames, busy, error, counted = true, onSave, onBack, onCancel }) {
  const [name, setName] = useState(() => suggestTurfName(doors, points, takenNames));
  const [localError, setLocalError] = useState(null);
  const inside = useMemo(() => countInside(doors, points), [doors, points]);
  const submit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setLocalError('Add a name'); return; }
    setLocalError(null);
    onSave(n);
  };
  const shown = localError || error;
  return (
    <form className="door-card door-form turf-name-form" onSubmit={submit} aria-label="Name this turf">
      <header className="mapsheet-head">
        <div>
          <h2 className="mapsheet-title">Name this turf</h2>
          {counted && <span className="door-head__addr">{plural(inside.doors, 'door', 'doors')} · {plural(inside.people, 'person', 'people')}</span>}
        </div>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onCancel} disabled={busy} aria-label="Discard this turf">✕</button>
      </header>
      <div className="door-form__body">
        <div className="field">
          <label htmlFor="turf-name" className="fk-sr">Turf name</label>
          {/* Prefilled and selected: Save works at once, typing replaces it. */}
          <input
            id="turf-name" className="input" autoFocus required maxLength={200} autoComplete="off"
            placeholder="e.g. Fleetwood East" value={name} onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </div>
        {shown && <p className="error turf-form-error" role="alert">{shown}</p>}
        <div className="door-form__actions">
          <button type="submit" className="btn btn-primary door-act" disabled={busy}>{busy ? 'Saving…' : 'Save turf'}</button>
          <button type="button" className="btn door-act" disabled={busy} onClick={onBack}>Keep drawing</button>
          <button type="button" className="btn btn-quiet door-act" disabled={busy} onClick={onCancel}>Discard</button>
        </div>
      </div>
    </form>
  );
}

// Desk: which tiles took (GET /api/map/config's setup) — "Map tiles:
// OpenStreetMap", "Map tiles: tiles.example", or a setting that didn't:
// "Map tiles: OpenStreetMap — custom address ignored".
const tilesLine = (setup) => {
  if (!setup?.source) return null;
  const ignored = Array.isArray(setup.ignored) ? setup.ignored : [];
  const off = [ignored.includes('url') && 'custom address ignored', ignored.includes('maxZoom') && 'max zoom ignored'].filter(Boolean);
  return `Map tiles: ${setup.source}${off.length ? ` — ${off.join(', ')}` : ''}`;
};

// The filter pill's sheet. "Show" — which doors, one at a time. "On the
// map" (desk) — the turf outlines switch. Then the turf tools (walk lists,
// "Draw turf"); a volunteer's walk list has its own chip on the map. Last,
// for desks, one quiet line naming the map tiles (tilesNote), and for
// managers "Map check".
function FilterOpt({ f, filter, onFilter, counts, autoFocus }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={filter === f.key}
      className={`map-fopt${filter === f.key ? ' is-on' : ''}`}
      data-band={f.band || f.key}
      autoFocus={autoFocus}
      onClick={() => onFilter(f.key)}
    >
      <span className="map-fopt__name">
        <span className="map-fopt__dot" aria-hidden="true" />
        <span className="map-fopt__label">{f.short || f.label}</span>
      </span>
      <span className="map-fopt__n mono">{counts[f.key] === null ? '' : num(counts[f.key] ?? 0)}</span>
    </button>
  );
}

// Signs: two rows of on/off chips — Up · Requested, then each kind.
function SignChips({ signShow, onSigns, signCounts }) {
  const flip = (field, code) => {
    const cur = new Set(signShow[field]);
    if (cur.has(code)) cur.delete(code); else cur.add(code);
    onSigns({ ...signShow, [field]: [...cur] });
  };
  const chip = (field, code, label, n) => (
    <button key={code} type="button" aria-pressed={signShow[field].includes(code)}
      className={`map-schip map-schip--${field === 'status' ? code : 'kind'}${signShow[field].includes(code) ? ' is-on' : ''}`}
      onClick={() => flip(field, code)}>
      {field === 'status' && <i className={`map-flag map-flag--${code}`} aria-hidden="true"><i className="map-flag__face" /></i>}
      <span>{label}</span> <span className="mono map-schip__n">{num(n)}</span>
    </button>
  );
  return (
    <div className="map-fsheet__layers">
      <h3 className="map-fsheet__sub">Signs</h3>
      <div className="map-schips" role="group" aria-label="Signs by status">
        {SIGN_SHOW_STATUS.map(([code, label]) => chip('status', code, label, signCounts[code] || 0))}
      </div>
      <div className="map-schips" role="group" aria-label="Signs by kind">
        {SIGN_KINDS.map((k) => chip('kinds', k.code, k.label, signCounts[`k:${k.code}`] || 0))}
      </div>
    </div>
  );
}

function FilterSheet({
  filters, filter, onFilter, counts, showTurfs, onTurfs, turfCount, desk, onDraw, unlocated, onPlace, onClose, tilesNote = null, countsNote = null,
  sharing = false, onShare = null, signShow = null, onSigns = null, signCounts = {},
  views = [], view = 'standard', onView = null, onCheck = null,
}) {
  const main = filters.filter((f) => !f.group);
  const opponents = filters.filter((f) => f.group === 'Voting for');
  const focusKey = filters.some((x) => x.key === filter) ? filter : filters[0]?.key;
  return (
    <>
      <button type="button" className="map-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div className="map-fsheet" role="dialog" aria-label="Show on the map">
        <header className="map-fsheet__head">
          <h2 className="mapsheet-title" id="map-fsheet-show">Show</h2>
          <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="map-fsheet__grid" role="radiogroup" aria-labelledby="map-fsheet-show">
          {main.map((f) => <FilterOpt key={f.key} f={f} filter={filter} onFilter={onFilter} counts={counts} autoFocus={f.key === focusKey} />)}
        </div>
        {opponents.length > 0 && (
          <>
            <h3 className="map-fsheet__sub" id="map-fsheet-opp">Voting for</h3>
            <div className="map-fsheet__grid" role="radiogroup" aria-labelledby="map-fsheet-opp">
              {opponents.map((f) => <FilterOpt key={f.key} f={f} filter={filter} onFilter={onFilter} counts={counts} autoFocus={f.key === focusKey} />)}
            </div>
          </>
        )}
        {signShow && <SignChips signShow={signShow} onSigns={onSigns} signCounts={signCounts} />}
        {onView && (
          <div className="map-fsheet__layers">
            <h3 className="map-fsheet__sub" id="map-fsheet-view">Map</h3>
            <div className="map-schips" role="radiogroup" aria-labelledby="map-fsheet-view">
              {[...SHADES, ...views].map((v) => (
                <button key={v.key} type="button" role="radio" aria-checked={view === v.key}
                  className={`map-schip map-vchip map-vchip--${v.key}${view === v.key ? ' is-on' : ''}`} onClick={() => onView(v.key)}>
                  <i className="map-vchip__swatch" aria-hidden="true" />{v.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {desk && (
          <div className="map-fsheet__layers">
            <h3 className="map-fsheet__sub">On the map</h3>
            <button
              type="button"
              role="switch"
              aria-checked={showTurfs}
              className={`map-fswitch${showTurfs ? ' is-on' : ''}`}
              onClick={() => onTurfs(!showTurfs)}
            >
              <span className="map-fswitch__label">Turfs <span className="mono map-fswitch__n">{num(turfCount)}</span></span>
              <span className="map-fswitch__track" aria-hidden="true"><span className="map-fswitch__knob" /></span>
            </button>
          </div>
        )}
        {onShare && (
          <div className="map-fsheet__layers">
            <h3 className="map-fsheet__sub">You</h3>
            <button
              type="button"
              role="switch"
              aria-checked={sharing}
              className={`map-fswitch${sharing ? ' is-on' : ''}`}
              onClick={() => onShare(!sharing)}
            >
              <span className="map-fswitch__label">Share my location while I’m out</span>
              <span className="map-fswitch__track" aria-hidden="true"><span className="map-fswitch__knob" /></span>
            </button>
            <p className="map-fsheet__note">{sharing
              ? 'Managers see where you are on their dashboard, about once a minute, while this is on. Turn it off when you’re done.'
              : 'Off. Turn it on while you canvass and managers see where you are on their dashboard.'}</p>
          </div>
        )}
        {(desk || unlocated > 0) && (
          <div className="map-fsheet__acts">
            {desk && turfCount > 0 && <Link className="btn map-fsheet__act" to="/turfs">Walk lists</Link>}
            {desk && (
              <button type="button" className="btn map-fsheet__act" onClick={onDraw}><TurfGlyph /> Draw turf</button>
            )}
            {!desk && unlocated > 0 && (
              <button type="button" className="btn map-fsheet__act" onClick={onPlace}>Place {num(unlocated)} on map</button>
            )}
          </div>
        )}
        {countsNote && <p className="map-fsheet__tiles">{countsNote}</p>}
        {desk && tilesNote && <p className="map-fsheet__tiles">{tilesNote}</p>}
        {/* Managers: what the map is drawn from, on one sheet (MapCheck.jsx). */}
        {onCheck && <button type="button" className="btn btn-quiet map-fsheet__check" onClick={onCheck}>Map check</button>}
      </div>
    </>
  );
}

// true once `on` has stayed on for a moment: a quick answer changes the
// number before anyone could read "Loading…", so it never flashes.
function useSlow(on, ms = 400) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!on) { setSlow(false); return undefined; }
    const t = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return slow && on;
}

// The line under the count: what the colours mean, and — where the marks
// aren't doors you can read off — what a mark is.
function MapKey({ squares, dark, words }) {
  const theme = dark ? 'dark' : 'light';
  // As on the map: its own colour, its white ring, undecided's darker edge.
  const mark = (band) => ({
    background: css(band === 'unrated' ? MARK.unrated[theme] : MARK[band]),
    boxShadow: `${band === 'undecided' ? `inset 0 0 0 1px ${css(MARK.undecidedEdge[theme])}, ` : ''}0 0 0 1.5px ${css(MARK.ring[theme])}`,
  });
  return (
    <div className={`map-key${squares ? ' map-key--squares' : ''}`}>
      <ul className="map-key__marks" aria-label="What the colours mean">
        {KEY.map(([band, label]) => (
          <li key={band}><i className="map-key__mark" style={mark(band)} aria-hidden="true" />{label}</li>
        ))}
      </ul>
      {words && <p className="map-key__words">{words}</p>}
    </div>
  );
}

export default function MapPage() {
  const { me } = useOutletContext();
  const queryClient = useQueryClient();
  const scale = useScale();
  const [params, setParams] = useSearchParams();
  const personParam = params.get('person');
  const turfParam = params.get('turf');
  const drawParam = params.get('draw');
  const showParam = params.get('show'); // ?show=gotv from Today's GOTV card

  const pageRef = useRef(null);
  const canvasRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const markersRef = useRef(new Map()); // door key → marker
  const fittedRef = useRef(false);
  const centeredOnRef = useRef(null);  // person id we last revealed
  const selectedKeyRef = useRef(null);
  const prevSelectedRef = useRef(null);
  const onMapClickRef = useRef(null);
  const onLongPressRef = useRef(null);
  const onPinClickRef = useRef(null);
  const onClusterClickRef = useRef(null);
  const onDotTapRef = useRef(null);    // a tap near a dot or patch (canvas: the map asks)
  const dotItemsRef = useRef({ doors: [], lean: [], cells: [] });
  const spotSeqRef = useRef(0);        // the last dot tapped whose door is being asked for
  const onSignClickRef = useRef(null);
  const setParamsRef = useRef(null);
  const onTurfClickRef = useRef(null);
  const onDraftStartRef = useRef(null);
  const onKeyRef = useRef(null);
  const focusedTurfRef = useRef(null); // turf id the map was last fitted to (or tapped)
  const drawShiftRef = useRef(0);      // px the map slid down for the draw strip
  const canCreate = CREATE_ROLES.includes(me?.role);

  const [filterPick, setFilter] = useState(null); // null: the role's default (below)
  const [showTurfs, setShowTurfs] = useState(readTurfsPref);
  const [sharing, setSharing] = useSharePref();
  const [hintSeen, setHintSeen] = useState(readHintSeen);
  const hideHint = useCallback(() => { setHintSeen(true); writeHintSeen(); }, []);
  const [draft, setDraft] = useState(EMPTY_DRAFT); // turf being drawn: [lat, lng] points
  const [turfBusy, setTurfBusy] = useState(false);
  const [turfError, setTurfError] = useState(null);
  const [mode, setMode] = useState(null);       // null | 'place' | 'add' | 'draw'
  const [placing, setPlacing] = useState(null); // person being dropped
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addAt, setAddAt] = useState(null);     // { lat, lng } for a brand-new door
  const [locating, setLocating] = useState(false);
  const [zoom, setZoom] = useState(null);        // drives the count bubbles
  const [viewBounds, setViewBounds] = useState(null); // what's on screen (padded): only that is drawn
  // What's on screen exactly: its middle, zoom, size in px and corners
  // ([south, west, north, east]) — what a big list asks for and counts by.
  const [seen, setSeen] = useState(null);
  const [fitted, setFitted] = useState(false);   // the map has opened on the list (then it asks by view)
  const [spotBusy, setSpotBusy] = useState(false); // a tapped dot's door is on its way
  const [signSel, setSignSel] = useState(null);  // an orphan sign's sheet
  const [filterOpen, setFilterOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false); // the map's check (managers)
  const filterBtnRef = useRef(null);
  // Closing the filter sheet hands focus back to the button that opened it.
  const closeFilter = useCallback(() => {
    setFilterOpen(false);
    requestAnimationFrame(() => filterBtnRef.current?.focus({ preventScroll: true }));
  }, []);
  // The check is the server's for managers (in the field app too, where a
  // manager is shown a volunteer's screens).
  const mayCheck = (me?.admin_role || me?.role) === 'manager';
  const closeCheck = useCallback(() => {
    setCheckOpen(false);
    requestAnimationFrame(() => filterBtnRef.current?.focus({ preventScroll: true }));
  }, []);
  const [unlocOpen, setUnlocOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null); // { text, act: { label, onClick } | null }
  const toastTimer = useRef(null);

  // toast(text, act?) — act is an optional { label, onClick } button
  // (the door card's "Change"). toast(null) clears it (the Note field got
  // focus — the toast must not sit on what they're typing).
  const toast = useCallback((text, act = null) => {
    clearTimeout(toastTimer.current);
    if (text == null) { setToastMsg(null); return; }
    setToastMsg({ text, act });
    toastTimer.current = setTimeout(() => setToastMsg(null), act ? 4000 : 3000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // A pin placed moves a person into (or out of) a turf: its counts and walk list change.
  const refresh = useCallback((personId) => {
    for (const key of ['doors', 'persons', 'signs', 'brief', 'turfs', 'turf']) queryClient.invalidateQueries({ queryKey: [key] });
    if (personId) queryClient.invalidateQueries({ queryKey: ['person', personId] });
  }, [queryClient]);
  const onGeocoded = useCallback(() => {
    for (const key of ['doors', 'brief', 'persons', 'turfs', 'turf', 'geocode']) queryClient.invalidateQueries({ queryKey: [key] });
  }, [queryClient]);

  // ── Data ──
  // The doors last loaded are kept on this phone; what the outbox still holds
  // is laid over them (new people, pins, sign requests, ratings).
  const doorsQ = useQuery({
    queryKey: ['doors'], queryFn: () => apiGet('/map/doors'), placeholderData: keepPreviousData, ...phoneCopy(me, 'doors'),
  });
  useKeepCopy(me, 'doors', doorsQ);
  // A list too big for one load is asked for by the part of the map on
  // screen (mapView.js viewBox) once the map has opened on the list: door by
  // door close in — the people themselves where they fit, else every door a
  // dot — and further out as a count per patch.
  const big = Boolean(doorsQ.data?.big);
  const askBox = useMemo(() => (big && fitted && seen ? viewBox(seen, seen, seen.zoom) : null), [big, fitted, seen]);
  const wantsDoors = Boolean(askBox && seen.zoom >= DOT_ZOOM);
  const askRows = seen ? rowsBudget(seen.zoom) : 0;
  // "Strong yes (1)", "Voting Locke": a dot knows its household's band, not
  // each rating, so the server keeps the dots to those doors.
  const askRating = /^r:/.test(filterPick || '') ? filterPick.slice(2) : '';
  const viewQ = useQuery({
    queryKey: ['doors', 'view', askBox?.join(','), askRows, askRating],
    queryFn: () => apiGet(`/map/doors?bbox=${askBox.join(',')}&dots=1&rows=${askRows}${askRating ? `&rating=${encodeURIComponent(askRating)}` : ''}`),
    enabled: wantsDoors,
    placeholderData: keepPreviousData,
    staleTime: 20_000,
  });
  // This view's own answer (not the one before, kept while it loads).
  const viewNow = wantsDoors && viewQ.data && !viewQ.isPlaceholderData ? viewQ.data : null;
  // Patches: further out, or where a view holds too many doors even for dots
  // (a dense part of the city on a big screen) — never part of them drawn
  // as if all.
  const wantsPatches = Boolean(askBox && (!wantsDoors || viewNow?.truncated));
  const zInt = seen ? Math.floor(seen.zoom) : null;
  const cell = seen ? cellOf(zInt, Math.round(seen.lat)) : null;
  const densQ = useQuery({
    queryKey: ['doors', 'density', zInt, askBox?.join(',')],
    queryFn: () => apiGet(`/map/density?bbox=${askBox.join(',')}&cell=${cell.join(',')}`),
    enabled: wantsPatches,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const densNow = wantsPatches && densQ.data && !densQ.isPlaceholderData ? densQ.data : null;
  // What is drawn: this view's answer once it is in, and until then what was
  // there — never an empty map or a "0" while an answer is on its way.
  const fresh = useMemo(() => {
    const d = big ? drawnFor({ doors: wantsDoors, view: viewNow, density: densNow }) : null;
    return d?.kind === 'dots' ? { ...d, rating: askRating } : d;
  }, [big, wantsDoors, viewNow, densNow, askRating]);
  const drawnRef = useRef(null);
  if (!big) drawnRef.current = null;
  else if (fresh) drawnRef.current = fresh;
  const drawn = big ? fresh || drawnRef.current : null;
  // The first read failed and a view's answer has come since: the signal is
  // back, though the phone never said it had gone — the first read is asked
  // again (nothing else would ask: "No signal — showing the doors already
  // loaded" stood until the page was loaded again).
  const answeredAt = Math.max(viewQ.dataUpdatedAt, densQ.dataUpdatedAt);
  useEffect(() => {
    if (doorsQ.isError && !doorsQ.isFetching && answeredAt > doorsQ.errorUpdatedAt) doorsQ.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answeredAt]);
  // On "My turf" no view is asked, so nothing above would ask again: while
  // the first read stands in error it is asked by itself every half minute
  // with the page in front, and the line goes once the signal is back.
  const doorsDown = doorsQ.isError;
  useEffect(() => {
    if (!doorsDown) return undefined;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') doorsQ.refetch({ cancelRefetch: false });
    }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doorsDown]);
  // Asked and not answered (the server's refusal, or no answer at all).
  const viewFailed = Boolean(big && !fresh && ((wantsDoors && !viewNow && viewQ.isError) || (wantsPatches && densQ.isError)));
  const outbox = useOutbox();
  // One person's door, wherever it is and however busy the place: a link to
  // them (/map?person=…), or a dot tapped where the people aren't loaded.
  const doorQ = useQuery({
    queryKey: ['doors', 'door', personParam],
    queryFn: () => apiGet(`/map/doors?person=${encodeURIComponent(personParam)}`),
    enabled: Boolean(big && personParam),
    staleTime: 20_000,
  });
  const oneDoor = big && personParam && doorQ.data?.scope === 'door' ? doorQ.data : null;
  const doorFailed = Boolean(big && personParam && doorQ.isError && !doorQ.data);
  // A big list: what came whole (a volunteer's own turfs, kept on the
  // phone), the people in view where they fit, and the open door — each
  // person once.
  const rowsData = drawn?.kind === 'rows' ? drawn.view : null;
  const baseDoors = useMemo(
    () => (big ? mergeDoorData(mergeDoorData(doorsQ.data, rowsData), oneDoor) : doorsQ.data),
    [big, doorsQ.data, rowsData, oneDoor],
  );
  // Doors answered as dots (a busy view): drawn, counted, opened by a tap.
  const leanAll = useMemo(() => (drawn?.kind === 'dots' ? dotsFrom(drawn.view.dots) : EMPTY_LIST), [drawn]);
  const doorsData = useMemo(() => applyOutbox(baseDoors, outbox.items), [baseDoors, outbox.items]);
  const { doors, byPerson, orphanSigns } = useMemo(() => (doorsData ? buildDoors(doorsData) : EMPTY_MODEL), [doorsData]);
  const unlocated = (big ? doorsQ.data?.unlocated : doorsData?.unlocated) ?? 0;
  const doorsCopy = showingCopy(doorsQ);

  // The placing run (desk), looked at while anyone waits for a pin: its
  // progress shows on the map without opening anything ("Placing addresses ·
  // 12,400 of 150,000" where "Not on map" was), and what it places is drawn
  // as it goes. A paused run tries again by itself; the map says so.
  const placingQ = useQuery({
    queryKey: ['geocode', 'status'], queryFn: () => apiGet('/geocode/status'),
    enabled: canCreate && unlocated > 0, refetchInterval: (q) => placingPoll(q.state.data), staleTime: 2000,
  });
  const lastRun = canCreate && unlocated > 0 ? placingQ.data || null : null;
  const placingRun = lastRun && (lastRun.state === 'running' || (lastRun.state === 'paused' && lastRun.retryAt)) ? lastRun : null;
  const placedSoFar = placingRun ? placingRun.located + placingRun.copied : 0;
  const placingWords = placingRun
    ? `Placing addresses${placingRun.state === 'paused' ? ' paused' : ''} · ${num(placedSoFar)} of ${num(placedSoFar + placingRun.missed + placingRun.remaining)}`
    : null;
  const seenRun = useRef({ state: null, placed: 0, at: 0 });
  useEffect(() => {
    const st = placingQ.data;
    if (!st) return;
    const was = seenRun.current;
    const placed = st.located + st.copied;
    const now = Date.now();
    // It started, paused or ended since the last look (a paused run may be
    // done by the next one): everything a new pin changes. Still going: the
    // doors it has placed so far.
    const turned = was.state !== null && was.state !== st.state;
    const moved = st.state === 'running' && placed !== was.placed && now - was.at > PLACING_REFRESH_MS;
    if (turned) onGeocoded();
    else if (moved) queryClient.invalidateQueries({ queryKey: ['doors'] });
    seenRun.current = { state: st.state, placed: turned || moved ? placed : was.placed, at: turned || moved ? now : was.at };
  }, [placingQ.data, onGeocoded, queryClient]);

  // Which tiles to draw (kept on the phone too, so offline asks for the same
  // tiles the service worker kept).
  const tilesQ = useQuery({
    queryKey: ['mapConfig'], queryFn: () => apiGet('/map/config'), staleTime: 10 * 60_000, retry: 1, ...phoneCopy(me, 'mapConfig'),
  });
  useKeepCopy(me, 'mapConfig', tilesQ);
  const baseTiles = tilesQ.data?.tiles || (tilesQ.isError || tilesQ.fetchStatus === 'paused' ? DEFAULT_TILES : null);
  const views = tilesQ.data?.views ?? EMPTY_LIST;
  const [viewPick, setViewPick] = useState(readViewPref);
  // The look the map went to by itself because the picked one's street map
  // wasn't loading (this visit only: the pick itself is not changed) — or
  // one tapped from "The street map isn’t loading" (tapped: theirs once its
  // streets come; not loading either, the map goes back to the pick).
  const [autoView, setAutoView] = useState(() => (fellBack?.from && fellBack.from === readViewPref() ? fellBack.to : null));
  const [tapped, setTapped] = useState(false);
  // With no signal the pick is drawn: its streets are the ones this phone
  // keeps. Signal back, it stays until it has been asked again (below).
  const online = useOnline();
  const [holdPick, setHoldPick] = useState(!online);
  const setView = (v) => { setViewPick(v); writeViewPref(v); setAutoView(null); setTapped(false); if (fellBack) fellBack.from = null; };
  const drawnAuto = autoView && online && !holdPick ? autoView : null;
  const lookPick = drawnAuto || viewPick;
  // A provider look this server no longer offers falls back to Standard.
  const providerView = views.find((v) => v.key === lookPick) || null;
  // Clean comes from the server; where it isn't offered (Google tiles, the
  // campaign's own provider), Muted.
  const view = providerView || SHADES.some((s) => s.key === lookPick) ? lookPick : lookPick === 'clean' ? 'muted' : 'standard';
  const tiles = providerView ? { url: providerView.url, attribution: providerView.attribution, maxZoom: providerView.maxZoom } : baseTiles;
  // Is the street map loading? (The tile layer's own events, below — the
  // layer drawn now: what the one before it said is no answer.)
  const [streetSeen, setStreet] = useState(NOT_SEEN);
  const street = streetSeen.url === tiles?.url ? streetSeen : NOT_SEEN;
  const streetRef = useRef({ loaded: 0, failed: 0, down: false }); // every tile since the layer was added
  const [tilesTry, setTilesTry] = useState(0); // "Try again": the layer is made afresh
  // The look whose street map comes from the other provider (the campaign's
  // base tiles ↔ a provider's look such as Clean), or null: a campaign's own
  // provider, or Google's, has no second one.
  const baseUrl = baseTiles?.url;
  const otherLook = useMemo(() => {
    const here = tileHost(tiles?.url);
    if (!here || !baseUrl) return null;
    if (providerView) return tileHost(baseUrl) && tileHost(baseUrl) !== here ? SHADES.find((x) => x.key === 'muted') : null;
    return views.find((v) => tileHost(v.url) && tileHost(v.url) !== here) || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles?.url, baseUrl, providerView, views]);
  const offZoom = Math.min(CLUSTER_OFF_ZOOM, tiles?.maxZoom || CLUSTER_OFF_ZOOM);
  const offZoomRef = useRef(offZoom);
  offZoomRef.current = offZoom;

  // On a big list, zooming out of what's loaded keeps the open door's card
  // (and its pin) — the door it was found at, until another is chosen.
  const lastDoorRef = useRef(null);
  const foundDoor = personParam ? byPerson.get(personParam) || null : null;
  if (foundDoor) lastDoorRef.current = foundDoor;
  const selectedDoor = foundDoor
    || (big && personParam && lastDoorRef.current?.persons.some((p) => p.id === personParam) ? lastDoorRef.current : null);
  const selectedKey = selectedDoor?.key || null;
  // Declared before the marker effects so Leaflet handlers see the current key.
  useEffect(() => { selectedKeyRef.current = selectedKey; }, [selectedKey]);

  // Turfs (volunteers get only the ones assigned to them, whole; anyone the
  // server answers as a desk role — a manager in the field app too — gets
  // every turf's outline, and counts when a sheet opens), kept on the phone
  // too: offline, a volunteer still opens on "My turf".
  const turfsFrom = (me?.admin_role || me?.role) === 'volunteer' ? TURFS_WHOLE : TURFS_OUTLINE;
  const turfsQ = useQuery({ queryKey: turfsFrom.key, queryFn: () => apiGet(turfsFrom.path), ...phoneCopy(me, turfsFrom.copy) });
  useKeepCopy(me, turfsFrom.copy, turfsQ);
  const turfs = turfsQ.data?.turfs ?? EMPTY_LIST;
  // A volunteer's own turf outline always shows (the switch is desk-only).
  const turfsOn = canCreate ? showTurfs : true;
  // A volunteer's walk list, one tap from the map.
  const myWalk = !canCreate && turfs.length > 0
    ? (turfs.length === 1 ? { to: `/turfs/${turfs[0].id}`, label: 'Walk list' } : { to: '/turfs', label: 'Walk lists' })
    : null;

  // No signal and no doors in memory: say so, and point at the walk list
  // kept on this phone (it opens offline). A server refusal is not this.
  const noSignal = !doorsQ.data && (doorsQ.fetchStatus === 'paused' || (doorsQ.isError && (!online || !doorsQ.error?.status)));

  // The street map isn't loading, and there is signal (mapView.js
  // streetMove): the map asks its other provider for one tile, and if it
  // answers goes there by itself, once, and says so (a line under the count
  // for a few seconds — not the toast, which is for what the person just
  // did). With weak signal it doesn't answer either (the phone says it is
  // online; the tile hosts don't answer), and going there would leave
  // undrawn the streets this phone kept, which are the pick's: the map
  // stays, and says "The street map isn’t loading · Try again". On a look it
  // went to by itself, not loading either is the signal: back to the pick.
  const otherUrl = otherLook ? otherLook.url || baseUrl : null;
  const [asked, setAsked] = useState(null); // the other provider asked for one tile: { url, answer: 'asking' | 'yes' | 'no' }
  const askNo = useRef(0); // (an answer to an ask made before the last change is no answer)
  const move = streetMove({
    down: street.down && online && !holdPick,
    onAuto: Boolean(drawnAuto),
    other: Boolean(otherUrl),
    asked: asked?.url === otherUrl ? asked.answer : null,
    switched: Boolean(fellBack),
  });
  const [switchedTo, setSwitchedTo] = useState(null);
  // Back on the person's own pick (for the rest of the visit: the map has
  // gone somewhere by itself once already).
  const backToPick = () => { if (fellBack) fellBack.from = null; setAutoView(null); setTapped(false); setSwitchedTo(null); };
  useEffect(() => {
    if (move === 'ask') {
      const n = ++askNo.current;
      const url = otherUrl;
      const map = mapRef.current;
      setAsked({ url, answer: 'asking' });
      (map ? answers(tileAt(url, map.getCenter(), map.getZoom(), otherLook.maxZoom || baseTiles?.maxZoom)) : Promise.resolve(false))
        .then((ok) => { if (askNo.current === n) setAsked({ url, answer: ok ? 'yes' : 'no' }); });
    } else if (move === 'switch') {
      fellBack = { from: viewPick, to: otherLook.key };
      setAutoView(otherLook.key);
      setSwitchedTo(otherLook.label);
    } else if (move === 'back') backToPick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [move]);
  // Loading again, or another layer: a later failure asks afresh.
  useEffect(() => { if (!street.down) { askNo.current += 1; setAsked(null); } }, [street.down]);
  // A look tapped from the note is theirs once its streets come: a whole
  // view of them, most loaded (one tile through a flicker is not that).
  const tappedCame = Boolean(tapped && drawnAuto && street.settled && street.any && !street.down);
  useEffect(() => {
    if (tappedCame) setView(drawnAuto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tappedCame]);
  useEffect(() => {
    if (!switchedTo) return undefined;
    const t = setTimeout(() => setSwitchedTo(null), 8000);
    return () => clearTimeout(t);
  }, [switchedTo]);
  // No signal: the pick is drawn (a look tapped and not yet loaded is let
  // go). Signal back: the street map is asked for again (the tiles that
  // failed without it would stay blank until the map moved) — and if the map
  // had gone to the other provider by itself, the pick is asked first, still
  // drawn meanwhile: answering, it is theirs again; not, the map goes back to
  // the one that answers. On that one, the pick is asked every minute too.
  const hadSignal = useRef(online);
  const signalNo = useRef(0);
  const pickTiles = views.find((v) => v.key === viewPick) || baseTiles;
  const pickAnswers = () => {
    const map = mapRef.current;
    return pickTiles?.url && map ? answers(tileAt(pickTiles.url, map.getCenter(), map.getZoom(), pickTiles.maxZoom)) : Promise.resolve(false);
  };
  useEffect(() => {
    const n = ++signalNo.current;
    if (!online) {
      if (tapped) { setAutoView(null); setTapped(false); } else if (autoView) setHoldPick(true);
    } else if (!hadSignal.current) {
      setTilesTry((k) => k + 1);
      askNo.current += 1;
      setAsked(null);
      if (autoView && !tapped) {
        pickAnswers().then((ok) => {
          if (signalNo.current !== n) return;
          if (ok) backToPick();
          setHoldPick(false);
        });
      } else setHoldPick(false);
    }
    hadSignal.current = online;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  useEffect(() => {
    if (!drawnAuto || tapped) return undefined;
    const t = setInterval(() => { pickAnswers().then((ok) => { if (ok) backToPick(); }); }, PICK_AGAIN_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawnAuto, tapped]);
  const offlineWalk = useMemo(() => (noSignal ? cachedWalkLists(me)[0] || null : null), [noSignal, me]);

  // A volunteer's own doors: inside any turf they walk (the walk list's doors).
  const mineKeys = useMemo(() => {
    if (canCreate) return null;
    const rings = turfs.filter((t) => validRing(t.polygon)).map((t) => t.polygon.map(([lat, lng]) => [Number(lat), Number(lng)]));
    if (!rings.length) return null;
    return new Set(doors.filter((d) => rings.some((r) => pointInPolygon(d.lat, d.lng, r))).map((d) => d.key));
  }, [canCreate, turfs, doors]);
  const voting = useVotedMode().on;
  const [signShow, setSignShowState] = useState(readSignsPref);
  const setSignShow = (v) => { setSignShowState(v); writeSignsPref(v); };
  const signOk = useCallback((sg) => signShow.status.includes(sg.status) && signShow.kinds.includes(sg.kind), [signShow]);
  // How many doors have anyone at each rating code (for 1s, 2s, each opponent).
  const byCode = useMemo(() => {
    const m = {};
    for (const d of doors) for (const code of new Set(d.persons.map((p) => p.rating).filter(Boolean))) m[code] = (m[code] || 0) + 1;
    return m;
  }, [doors]);
  // An opponent taken off the list still shows while doors carry it.
  const opponents = useMemo(() => opponentFilters(scale).filter((f) => !f.off || byCode[f.key.slice(2)]), [scale, byCode]);
  const filters = [...(mineKeys?.size ? [MINE] : []), FILTERS[0], FILTERS[1], ...ratingFilters(scale), ...FILTERS.slice(2), ...(voting ? VOTED_FILTERS : []), ...opponents];
  const labelOf = (key) => FILTER_LABEL[key] || filters.find((f) => f.key === key)?.label || key;
  // Voted: the server's mark, or a tap still on this phone.
  const votes = useMemo(() => pendingVoted(outbox.items), [outbox.items]);
  const hasVoted = useCallback((p) => (votes[p.id] ? votes[p.id].voted : Boolean(p.voted_at)), [votes]);
  // Volunteers start on their turf; everyone else on all doors.
  // GOTV mode on: the desk opens on who hasn't voted (a volunteer on their turf).
  const want = filterPick || (showParam && filters.some((f) => f.key === showParam) ? showParam : null);
  const filter = want && filters.some((f) => f.key === want) ? want : mineKeys?.size ? 'mine' : voting ? 'gotv' : 'all';

  const shows = useCallback((d) => (
    filter === 'all' ? true
      : filter === 'mine' ? Boolean(mineKeys?.has(d.key))
        : filter === 'signs' ? d.signs.some(signOk)
          : filter.startsWith('r:') ? d.persons.some((p) => p.rating === filter.slice(2))
          : filter === 'voted' ? d.persons.some(hasVoted)
            : filter === 'gotv' ? d.persons.some((p) => bandOf(p.rating) === 'support' && !hasVoted(p))
              : d.band === filter), [filter, mineKeys, hasVoted, signOk]);
  // The open door always keeps its pin, whatever the filter. (Only a door
  // the filter hides changes the list, so a tap doesn't rebuild every pin.)
  const extraKey = selectedDoor && !shows(selectedDoor) ? selectedDoor.key : null;
  const visible = useMemo(() => doors.filter((d) => d.key === extraKey || shows(d)), [doors, shows, extraKey]);
  // The dots a big list answered with, less any door the map has whole (the
  // open one, a volunteer's own: drawn from that) — and the ones the filter
  // keeps. Signs, voted and "my turf" need the people: a closer look.
  const leanFree = useMemo(() => {
    if (!leanAll.length) return EMPTY_LIST;
    const spot = (d) => `${Math.round(d.lat * 1e5)},${Math.round(d.lng * 1e5)}`;
    const whole = new Set(doors.map(spot));
    return whole.size ? leanAll.filter((d) => !whole.has(spot(d))) : leanAll;
  }, [leanAll, doors]);
  const leanShown = useMemo(() => {
    if (!leanFree.length || filter === 'mine') return EMPTY_LIST;
    const band = filter.startsWith('r:') ? (drawn?.rating === filter.slice(2) ? null : bandOf(filter.slice(2)))
      : ['support', 'undecided', 'opposed', 'unrated'].includes(filter) ? filter : null;
    return band ? leanFree.filter((d) => d.band === band) : leanFree;
  }, [leanFree, filter, drawn]);
  // The numbers for the pill and the filter sheet. A list loaded whole:
  // its doors. A big list: what is on screen — people from further out
  // (patches), doors closer in.
  const counts = useMemo(() => {
    if (drawn?.kind === 'density') {
      // By rating; signs, voted and the rest need a closer look.
      const p = { all: 0, mine: mineKeys?.size ?? null, support: 0, undecided: 0, opposed: 0, unrated: 0, signs: null, voted: null, gotv: null };
      const [dlat, dlng] = drawn.density.cell;
      for (const [y, x, r, n] of drawn.density.cells || EMPTY_LIST) {
        if (seen && !inBox(seen.box, { lat: (y + 0.5) * dlat, lng: (x + 0.5) * dlng })) continue;
        p.all += n;
        p[r ? bandOf(r) : 'unrated'] += n;
        if (r) p[`r:${r}`] = (p[`r:${r}`] || 0) + n;
      }
      return p;
    }
    const here = big && seen ? doors.filter((d) => inBox(seen.box, d)) : doors;
    const c = { all: here.length, mine: mineKeys?.size || 0, support: 0, undecided: 0, opposed: 0, unrated: 0, signs: 0, voted: 0, gotv: 0 };
    for (const d of here) {
      c[d.band] += 1;
      if (d.signs.some(signOk)) c.signs += 1;
      if (d.persons.some(hasVoted)) c.voted += 1;
      if (d.persons.some((p) => bandOf(p.rating) === 'support' && !hasVoted(p))) c.gotv += 1;
      if (here !== doors) for (const code of new Set(d.persons.map((p) => p.rating).filter(Boolean))) c[`r:${code}`] = (c[`r:${code}`] || 0) + 1;
    }
    if (here === doors) for (const [code, n] of Object.entries(byCode)) c[`r:${code}`] = n;
    if (drawn?.kind === 'dots') {
      // Doors as dots: the band is known; each rating, signs and votes are not.
      const dots = seen ? leanFree.filter((d) => inBox(seen.box, d)) : leanFree;
      const only = drawn.rating; // the answer holds one rating's doors only
      for (const key of ['signs', 'voted', 'gotv']) c[key] = null;
      for (const f of filters) if (f.key.startsWith('r:')) c[f.key] = only === f.key.slice(2) ? (c[f.key] || 0) + dots.length : null;
      if (only) for (const key of ['all', 'support', 'undecided', 'opposed', 'unrated']) c[key] = null;
      else for (const d of dots) { c.all += 1; c[d.band] += 1; }
    }
    return c;
    // filters: its keys follow the scale and the doors, both listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doors, mineKeys, hasVoted, signOk, byCode, big, drawn, seen, leanFree, scale, voting]);
  // A big list from far out: the patches the filter keeps (by rating only).
  const densityKeep = useMemo(() => {
    if (filter === 'all') return () => true;
    if (filter === 'unrated') return (r) => !r;
    if (filter === 'support' || filter === 'undecided' || filter === 'opposed') return (r) => Boolean(r) && bandOf(r) === filter;
    if (filter.startsWith('r:')) return (r) => r === filter.slice(2);
    return null; // mine, signs, voted, gotv: only doors close in can say
  }, [filter]);
  const densityCells = useMemo(
    () => (drawn?.kind === 'density' && filter !== 'mine' ? cellsFrom(drawn.density, bandOf, densityKeep || (() => true)) : EMPTY_LIST),
    [drawn, densityKeep, filter],
  );
  // What a big list's marks can't say from this far out. ("My turf" needs
  // no note: a volunteer's own doors are loaded whole.)
  const farFilter = filter === 'mine' ? false
    : drawn?.kind === 'density' ? !densityKeep
      : drawn?.kind === 'dots' ? ['signs', 'voted', 'gotv'].includes(filter) : false;
  const zoomInFor = farFilter ? CLOSER[filter] || labelOf(filter).toLowerCase() : null;
  const viewCut = Boolean(drawn?.kind === 'density' && drawn.cut && filter !== 'mine');
  const zoomNote = viewCut ? 'Zoom in to see each door' : zoomInFor ? `Zoom in to see ${zoomInFor}` : null;
  // Every sign on the map, by status and by kind (for the Signs chips).
  const signCounts = useMemo(() => {
    const c = {};
    for (const sg of [...doors.flatMap((d) => d.signs), ...orphanSigns]) {
      c[sg.status] = (c[sg.status] || 0) + 1;
      c[`k:${sg.kind}`] = (c[`k:${sg.kind}`] || 0) + 1;
    }
    return c;
  }, [doors, orphanSigns]);

  // Deep link to someone who has no pin yet → offer to place them.
  // (A big list has asked for their door by itself — doorQ: wait for that.)
  const wantsMissing = Boolean(personParam && doorsQ.data && !selectedDoor && !doorsQ.isFetching && !(big && (doorQ.isFetching || !doorQ.data)));
  const missingQ = useQuery({
    queryKey: ['person', personParam],
    queryFn: () => apiGet(`/persons/${personParam}`),
    enabled: wantsMissing,
  });
  const missingFetched = wantsMissing ? missingQ.data?.person || null : null;
  // (Placed a moment ago, on a big list: their door is on its way.)
  const missingPerson = missingFetched && !(big && missingFetched.lat != null) ? missingFetched : null;
  const missingGone = wantsMissing && missingQ.isError;

  const turfById = useMemo(() => new Map(turfs.map((t) => [t.id, t])), [turfs]);
  const selectedTurf = turfParam ? turfById.get(turfParam) || null : null;
  const turfMissing = Boolean(turfParam && turfsQ.data && !selectedTurf && !turfsQ.isFetching);

  // Selection lives in the URL: /map?person=<id> or /map?turf=<id> (one at a
  // time). react-router's setter changes identity with every search change,
  // so keep `select` stable via a ref — otherwise every tap would rebuild
  // every marker on the map.
  useLayoutEffect(() => { setParamsRef.current = setParams; });
  const select = useCallback((personId) => {
    setSignSel(null);
    setParamsRef.current(personId ? { person: personId } : {}, { replace: true });
  }, []);
  const selectTurf = useCallback((turfId) => {
    setSignSel(null);
    setParamsRef.current(turfId ? { turf: turfId } : {}, { replace: true });
  }, []);

  const cancelMode = () => { setMode(null); setPlacing(null); setAddAt(null); setDraft(EMPTY_DRAFT); setTurfError(null); };
  const toggleAdd = () => { setMode((m) => (m === 'add' ? null : 'add')); setAddAt(null); setPlacing(null); setPickerOpen(false); setFilterOpen(false); setDraft(EMPTY_DRAFT); select(null); };
  // The new door's address was picked: its pin, and the map goes there.
  const placeNew = (ll) => {
    setAddAt(ll);
    const map = mapRef.current;
    if (!ll || !map) return;
    // In the part of the map the form leaves free (above the sheet on a phone).
    map.setView([ll.lat, ll.lng], Math.max(map.getZoom(), 17), { animate: false });
    revealLatLng(map, L.latLng(ll.lat, ll.lng), pageRef.current);
  };
  const startPlacing = (person) => { setPlacing(person); setMode('place'); setPickerOpen(false); setAddAt(null); setDraft(EMPTY_DRAFT); };

  const setTurfsShown = (on) => { setShowTurfs(on); writeTurfsPref(on); };

  // ── Drawing a turf ──
  const startDraw = () => {
    setFilterOpen(false);
    setUnlocOpen(false);
    setMode('draw');
    setPlacing(null);
    setPickerOpen(false);
    setAddAt(null);
    setDraft(EMPTY_DRAFT);
    setTurfError(null);
    if (!showTurfs) setTurfsShown(true); // existing turfs are the reference for the new edge
    select(null);
  };
  const addPoint = (latlng) => {
    if (draft.naming) return;
    if (draft.points.length >= MAX_TURF_POINTS) { toast(`${MAX_TURF_POINTS} points max — tap Finish`); return; }
    const { lat, lng } = wrapped(latlng);
    const pt = [Number(lat.toFixed(6)), Number(lng.toFixed(6))];
    setDraft((d) => {
      const last = d.points[d.points.length - 1];
      if (d.naming || (last && last[0] === pt[0] && last[1] === pt[1])) return d;
      return { ...d, points: [...d.points, pt] };
    });
  };
  const undoPoint = () => setDraft((d) => (d.naming ? d : { ...d, points: d.points.slice(0, -1) }));
  const finishDraw = () => {
    if (draft.points.length < 3) return;
    setTurfError(null);
    setDraft((d) => ({ ...d, naming: true }));
  };
  const backToDrawing = () => { setTurfError(null); setDraft((d) => ({ ...d, naming: false })); };

  const saveTurf = async (name) => {
    const polygon = draft.points;
    const color = TURF_COLORS[turfs.length % TURF_COLORS.length];
    setTurfBusy(true);
    setTurfError(null);
    try {
      const res = await action('turf.create', { name, polygon, color });
      const id = res.turf.id;
      // Show it (and its sheet) now, on the map's own list of turfs; its
      // counts are the server's, asked for by its sheet.
      queryClient.cancelQueries({ queryKey: ['turfs'] });
      queryClient.setQueryData(turfsFrom.key, (d) => (d ? {
        ...d,
        turfs: [...d.turfs.filter((t) => t.id !== id), { id, name: res.turf.name || name, color, polygon, notes: null, members: [] }],
      } : d));
      for (const key of ['turfs', 'brief']) queryClient.invalidateQueries({ queryKey: [key] });
      drawShiftRef.current = 0; // the new turf stays where it was drawn
      cancelMode();
      focusedTurfRef.current = id; // it's already on screen — no refit
      selectTurf(id);
      toast(`Saved ${res.turf.name || name}`);
    } catch (err) {
      setTurfError(err.message || 'Not saved — try again');
    } finally {
      setTurfBusy(false);
    }
  };

  // /map?draw=1 (from the turf list) opens straight into drawing.
  useEffect(() => {
    if (drawParam !== '1') return;
    if (canCreate) startDraw();
    else select(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawParam]);

  const locatePerson = async (person, latlng) => {
    try {
      // Through the outbox: no signal, the pin waits on the phone (and shows).
      const r = await queueAction('person.locate', { id: person.id, lat: latlng.lat, lng: latlng.lng }, {
        who: person.name,
        person: {
          name: person.name, phone: person.phone ?? null, address: person.address ?? null, unit: person.unit ?? null,
          rating: person.rating ?? null, rated_at: person.rated_at ?? null, tags: person.tags || [],
        },
      });
      toast(r.queued ? queuedText(r, 'Pin') : `Placed ${person.name}`);
      // Saved on the phone: the outbox lays the pin over the map until it goes.
      if (r.queued) {
        cancelMode();
        centeredOnRef.current = person.id;
        select(person.id);
        return;
      }
      // Drop the pin now; the refetch below confirms it.
      patchDoors(queryClient, (d) => ({
        ...d,
        // The server counts only people WITH an address as unlocated.
        unlocated: person.address && !d.persons.some((p) => p.id === person.id)
          ? Math.max(0, (d.unlocated || 0) - 1)
          : d.unlocated,
        persons: [
          ...d.persons.filter((p) => p.id !== person.id),
          {
            id: person.id, name: person.name, phone: person.phone ?? null, email: person.email ?? null,
            address: person.address ?? null, unit: person.unit ?? null, lat: latlng.lat, lng: latlng.lng,
            rating: person.rating ?? null, rated_at: person.rated_at ?? null, tags: person.tags || [],
          },
        ],
      }));
      cancelMode();
      centeredOnRef.current = person.id; // they tapped the spot — no need to pan
      refresh(person.id);
      select(person.id);
    } catch (err) {
      toast(err.message || 'Not placed — try again');
    }
  };

  // A dot tapped where the people aren't loaded (a busy view): the people at
  // that spot are asked for, and the nearest one's door opens. More than a
  // building's worth there: closer first.
  const openSpot = async (dot) => {
    const mine = (spotSeqRef.current += 1);
    setSpotBusy(true);
    try {
      const e = 0.00002; // the dot's own spot (dots are placed to the metre)
      const box = [dot.lat - e, dot.lng - e, dot.lat + e, dot.lng + e].map((v) => v.toFixed(5)).join(',');
      const res = await queryClient.fetchQuery({
        queryKey: ['doors', 'spot', box], queryFn: () => apiGet(`/map/doors?bbox=${box}&rows=500`), staleTime: 20_000,
      });
      if (mine !== spotSeqRef.current) return; // another dot was tapped meanwhile
      const far = (p) => (Number(p.lat) - dot.lat) ** 2 + (Number(p.lng) - dot.lng) ** 2;
      const who = [...(res.persons || [])].sort((a, b) => far(a) - far(b))[0];
      const map = mapRef.current;
      if (!who) { map?.setView([dot.lat, dot.lng], Math.min(offZoomRef.current, map.getZoom() + 1)); return; }
      // Their door is here already: the card opens without asking again.
      queryClient.setQueryData(['doors', 'door', who.id], (was) => was || { persons: res.persons, signs: res.signs || [], scope: 'door' });
      select(who.id);
    } catch (err) {
      if (mine === spotSeqRef.current) toast(err.message || 'That door didn’t open — try again');
    } finally {
      if (mine === spotSeqRef.current) setSpotBusy(false);
    }
  };

  const locateMe = () => {
    const map = mapRef.current;
    if (!map) return;
    if (!navigator.geolocation) { toast('No location on this device'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        // The fix can land after the page unmounted (map.remove()d) — bail.
        if (mapRef.current !== map) return;
        const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
        const layer = layersRef.current?.me;
        if (layer) {
          layer.clearLayers();
          if (pos.coords.accuracy) L.circle(ll, { radius: pos.coords.accuracy, className: 'map-me-ring', interactive: false }).addTo(layer);
          L.marker(ll, { icon: meIcon(), interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(layer);
        }
        map.setView(ll, Math.max(map.getZoom(), 16));
      },
      (err) => {
        setLocating(false);
        toast(err.code === 1 ? 'Location is blocked' : 'Couldn’t find you');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  };

  // The new door's pin: where it will go, while its form is open.
  useEffect(() => {
    const layer = layersRef.current?.adding;
    if (!layer) return;
    layer.clearLayers();
    if (addAt && mode === 'add') {
      L.marker([addAt.lat, addAt.lng], { icon: newDoorIcon(), interactive: false, keyboard: false, zIndexOffset: 1500, title: 'The new door' }).addTo(layer);
    }
  }, [addAt, mode]);

  // Fresh closures for Leaflet's handlers.
  useEffect(() => {
    onMapClickRef.current = (latlng) => {
      if (mode === 'draw') { addPoint(latlng); return; }
      if (mode === 'place' && placing) { locatePerson(placing, wrapped(latlng)); return; }
      if (mode === 'add') { setAddAt(wrapped(latlng)); return; } // drop or move the new door's pin
      if (personParam || turfParam || signSel) select(null); // tap on empty map closes the card
    };
    onLongPressRef.current = (latlng) => {
      if (mode === 'draw' || (mode === 'place' && placing)) return;
      if (!canCreate) { toast('Only staff can add doors'); return; }
      setAddAt(wrapped(latlng));
      setMode('add');
      setPlacing(null);
      setPickerOpen(false);
    };
    // Pins swallow map clicks, so place mode has to handle them too: tapping
    // an existing door drops the person in that building. (While drawing,
    // pins are click-through — see .is-drawing in map.css.)
    onPinClickRef.current = (door) => {
      if (mode === 'draw') { addPoint(L.latLng(door.lat, door.lng)); return; }
      if (mode === 'place' && placing) { locatePerson(placing, { lat: door.lat, lng: door.lng }); return; }
      if (mode === 'add') cancelMode();
      if (selectedKeyRef.current === door.key) return;
      select(door.persons[0].id);
    };
    // A count bubble: zoom in until its doors come apart (any mode — the
    // person being placed or the new door needs a single pin to land on).
    onClusterClickRef.current = (group) => {
      const map = mapRef.current;
      if (!map) return;
      if (!mode && (personParam || turfParam || signSel)) select(null);
      const b = L.latLngBounds(group.map((d) => [d.lat, d.lng]));
      const z = Math.min(offZoomRef.current, Math.max(map.getZoom() + 2, map.getBoundsZoom(b.pad(0.5))));
      map.setView(b.getCenter(), z, { animate: !reducedMotion() });
    };
    // A tap near a dot or in a patch (they're drawn on canvas): true if it
    // was one. In a mode (drawing, placing, adding) the tap is the map's.
    // (Pins take their own taps; what is on the canvas here is dots.)
    onDotTapRef.current = (latlng) => {
      const map = mapRef.current;
      if (!map || mode) return false;
      const z = map.getZoom();
      const { doors: ds, lean, cells } = dotItemsRef.current;
      if (cells.length) {
        const c = cellAt(cells, latlng);
        if (!c) return false;
        if (personParam || turfParam || signSel) select(null);
        map.setView([c.lat, c.lng], Math.min(DOT_ZOOM + 2, z + 2), { animate: !reducedMotion() });
        return true;
      }
      const reach = isPhone() ? 16 : 10;
      const d = nearest(map, ds, latlng, reach) || nearest(map, lean, latlng, reach);
      if (!d) return false;
      if (z < TAP_OPENS_ZOOM) {
        if (personParam || turfParam || signSel) select(null);
        map.setView([d.lat, d.lng], Math.min(PIN_ZOOM, z + 2), { animate: !reducedMotion() });
        return true;
      }
      // A door the map has whole opens at once; a dot's people are asked for.
      if (d.persons) onPinClickRef.current?.(d);
      else openSpot(d);
      return true;
    };
    onSignClickRef.current = (sign) => {
      if (mode) { onMapClickRef.current?.(L.latLng(Number(sign.lat), Number(sign.lng))); return; }
      if (personParam || turfParam) select(null);
      setPickerOpen(false);
      setAddAt(null);
      setSignSel(sign);
    };
    // Turf polygons don't bubble to the map, so they mirror its rules: in a
    // mode the tap is a map tap; an open door card closes like on empty map.
    onTurfClickRef.current = (turf, latlng) => {
      if (mode) { onMapClickRef.current?.(latlng); return; }
      if (onDotTapRef.current?.(latlng)) return; // a dot inside the turf
      if (personParam) { select(null); return; }
      if (pickerOpen || addAt || turfParam === turf.id) return;
      focusedTurfRef.current = turf.id; // they're looking right at it — no refit
      selectTurf(turf.id);
    };
    onDraftStartRef.current = () => { if (draft.points.length >= 3) finishDraw(); };
    // Escape backs out of whatever is open; while drawing, Enter finishes and
    // Backspace / Ctrl+Z takes back the last point.
    onKeyRef.current = (e) => {
      if (mode === 'draw' && !draft.naming && !isTyping(e.target)) {
        if (e.key === 'Enter' && draft.points.length >= 3) { e.preventDefault(); finishDraw(); return; }
        if (e.key === 'Backspace' || (e.key === 'z' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); undoPoint(); return; }
      }
      if (e.key !== 'Escape') return;
      if (filterOpen) closeFilter();
      else if (checkOpen) closeCheck();
      else if (unlocOpen) setUnlocOpen(false);
      else if (mode === 'draw' && draft.naming) backToDrawing();
      else if (mode) cancelMode();
      else if (pickerOpen) setPickerOpen(false);
      else if (addAt) setAddAt(null);
      else if (personParam || turfParam || signSel) select(null);
    };
  });

  useEffect(() => {
    const onKey = (e) => onKeyRef.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Measure the app chrome so the map can fill the rest of the viewport.
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return undefined;
    // Ceil the real (fractional) heights: offsetHeight rounds down, which
    // left the sheet and map a fraction of a pixel under the tab bar.
    const h = (sel) => Math.ceil(document.querySelector(sel)?.getBoundingClientRect().height || 0);
    const measure = () => {
      // On desktop the nav is the sidebar beside the map, not above it.
      const side = window.matchMedia('(min-width: 721px)').matches;
      el.style.setProperty('--nav-h', `${side ? 0 : h('.nav')}px`);
      el.style.setProperty('--tabbar-h', `${h('.tabbar')}px`);
      mapRef.current?.invalidateSize();
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // ── Leaflet map ──
  useEffect(() => {
    // zoomSnap 0.25: a turf can fill the screen exactly, so its doors open
    // far enough apart that every 48px pin is its own tap.
    const map = L.map(canvasRef.current, { center: SURREY, zoom: 12, zoomSnap: 0.25, zoomControl: false, attributionControl: false });
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    // Tiles: added below once GET /api/map/config (or the phone's copy) says which.
    // A big list's far-out picture (filled patches) lies right on the base
    // map; turf polygons sit over it and under everything else; a turf being
    // drawn sits over the other vectors (pins and its corner dots are in the
    // marker pane).
    map.createPane('patches').style.zIndex = 340;
    map.getPane('patches').style.pointerEvents = 'none';
    map.createPane('turfs').style.zIndex = 350;
    // Dots above turf fills, under pins and the turf being drawn. Neither
    // dots nor patches take a tap themselves (the map asks onDotTapRef).
    map.createPane('dots').style.zIndex = 380;
    map.getPane('dots').style.pointerEvents = 'none';
    map.createPane('turfDraft').style.zIndex = 450;
    const layers = {
      turfs: L.layerGroup().addTo(map),
      draft: L.layerGroup().addTo(map),
      signs: L.layerGroup().addTo(map),
      doors: L.layerGroup().addTo(map),
      me: L.layerGroup().addTo(map),
      adding: L.layerGroup().addTo(map), // the new door's pin, while its form is open
      dots: new DotLayer().addTo(map),
      density: new DensityLayer().addTo(map),
      chosen: L.layerGroup().addTo(map), // the open door's pin while the rest are dots
    };
    map.on('click', (e) => { if (!onDotTapRef.current?.(e.latlng)) onMapClickRef.current?.(e.latlng); });
    // A pointer over a dot shows it's a tap (desktop).
    let hoverFrame = 0;
    map.on('mousemove', (e) => {
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        const { doors: ds, lean, cells } = dotItemsRef.current;
        const hit = cells.length ? cellAt(cells, e.latlng) : nearest(map, ds, e.latlng, 10) || nearest(map, lean, e.latlng, 10);
        map.getContainer().classList.toggle('is-over-dot', Boolean(hit));
      });
    });
    map.on('zoomend', () => setZoom(map.getZoom()));
    setZoom(map.getZoom());
    // What's on screen: with a margin, the doors that are drawn; exactly, what
    // a big list asks for and counts by.
    const seeBounds = () => {
      const b = map.getBounds();
      const box = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      map.getContainer().dataset.bounds = box.map((v) => v.toFixed(6)).join(',');
      setViewBounds(b.pad(0.35));
      const size = map.getSize();
      if (!size.x || !size.y) return; // not laid out yet: nothing to ask by
      const c = map.getCenter();
      setSeen({ lat: c.lat, lng: c.lng, zoom: map.getZoom(), x: size.x, y: size.y, box });
    };
    map.on('moveend', seeBounds);
    seeBounds();
    map.on('contextmenu', (e) => { e.originalEvent?.preventDefault?.(); onLongPressRef.current?.(e.latlng); });
    mapRef.current = map;
    layersRef.current = layers;
    const markers = markersRef.current;
    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
      markers.clear();
      // A remount (StrictMode, fast refresh) gets a fresh map: fit it again.
      fittedRef.current = false;
      setFitted(false);
      centeredOnRef.current = null;
      prevSelectedRef.current = null;
      focusedTurfRef.current = null;
    };
  }, []);

  // The tile layer, from the map settings. The service worker is told which
  // provider's tiles to keep (the ones already seen, never fetched ahead).
  const tileUrl = tiles?.url;
  const tileMax = tiles?.maxZoom;
  const tileCredit = tiles?.attribution;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tileUrl) return undefined;
    tellServiceWorker(tileUrl); // first, so the first tiles are kept too
    const layer = L.tileLayer(tileUrl, { maxZoom: tileMax || 19, attribution: safeAttribution(tileCredit) });
    // Is it loading? Its tiles' own loads and errors say (mapView.js
    // tileHealth) — listened to before the layer goes on the map, which is
    // when its first tiles are asked for. With no signal a failed tile says
    // nothing about the provider (the strip under the nav says "Offline").
    const health = tileHealth();
    let timer = null;
    let shown = '';
    let settled = false; // a whole view's tiles in (or failed)
    const tell = () => {
      const h = health.get();
      const down = h.down && navigator.onLine !== false;
      streetRef.current = { ...h, down };
      const next = `${down}|${h.loaded > 0}|${settled}`;
      if (next !== shown) { shown = next; setStreet({ url: tileUrl, down, any: h.loaded > 0, settled }); }
    };
    tell();
    layer.on('loading', () => {
      settled = false;
      health.batch(Date.now());
      clearTimeout(timer);
      timer = setTimeout(() => { health.late(Date.now()); tell(); }, TILE_WAIT_MS + 20);
    });
    layer.on('tileerror', () => { health.tile(false); });
    layer.on('load', () => { clearTimeout(timer); clearTimeout(moved); clearTimeout(soon); soon = null; health.done(); settled = true; tell(); });
    // The six-second look is each view's own, not only Leaflet's go of
    // asking: one tile that never answers keeps a go open ('loading' comes
    // again only once every tile asked for has loaded or failed), and the
    // views moved to meanwhile had no look at all — blank streets, nothing
    // said (weak signal: the hosts don't refuse, they never answer). So six
    // seconds after the map last moved, tiles still out and not one street
    // drawn on screen: it isn't loading. Streets this phone kept, drawn,
    // with their neighbours still out, are not that — back over them, the
    // look takes it back.
    // What it looks at: the screen's tiles at the zoom the map is at, and
    // the share of them drawn (0 to 1). The zoom before's tiles stay,
    // stretched, under the ones on their way (Leaflet's own level for this
    // zoom is the one to read): they are not this view's streets — counted,
    // a zoom into streets where nothing answers left them there, blurred,
    // and nothing said.
    let moved = null;
    const streetsOnScreen = () => {
      const box = map.getContainer().getBoundingClientRect();
      const here = [...((layer._level?.el || layer.getContainer())?.querySelectorAll('img.leaflet-tile') || [])].filter((img) => {
        const r = img.getBoundingClientRect();
        return r.right > box.left + 1 && r.left < box.right - 1 && r.bottom > box.top + 1 && r.top < box.bottom - 1;
      });
      return here.length ? here.filter((img) => img.classList.contains('leaflet-tile-loaded') && img.naturalWidth > 0).length / here.length : 0;
    };
    const look = () => { if (layer.isLoading()) { health.screen(streetsOnScreen()); tell(); } };
    const onMoved = () => { clearTimeout(moved); if (layer.isLoading()) moved = setTimeout(look, TILE_WAIT_MS + 20); };
    map.on('moveend zoomend', onMoved);
    // A slow signal: "not loading" is said at six seconds, then the tiles
    // come — all but one, so the view is never done and nothing looked
    // again (the note stood over streets drawn). A second after a tile
    // comes while it says so, a look that finds most of the screen's streets
    // drawn may take it back (one tile through is not that; and it never
    // says "not loading" itself: a tile has just come).
    let soon = null;
    const lookAgain = () => {
      soon = null;
      const share = layer.isLoading() ? streetsOnScreen() : 0;
      if (share > 0.5) { health.screen(share); tell(); }
    };
    layer.on('tileload', () => {
      health.tile(true);
      tell();
      if (health.get().down && !soon) soon = setTimeout(lookAgain, 1000);
    });
    layer.addTo(map);
    map.setMaxZoom(tileMax || 19);
    return () => { clearTimeout(timer); clearTimeout(moved); clearTimeout(soon); map.off('moveend zoomend', onMoved); layer.remove(); };
  }, [tileUrl, tileMax, tileCredit, tilesTry]);

  // Turf polygons. Hidden by the Turfs chip, except a selected turf always shows.
  useEffect(() => {
    const layer = layersRef.current?.turfs;
    if (!layer) return;
    layer.clearLayers();
    const list = (turfsOn ? turfs : turfs.filter((t) => t.id === turfParam))
      .filter((t) => validRing(t.polygon))
      .sort((a, b) => (a.id === turfParam) - (b.id === turfParam)); // selected on top
    for (const t of list) {
      const selected = t.id === turfParam;
      const color = turfColor(t);
      const poly = L.polygon(t.polygon.map(([lat, lng]) => [Number(lat), Number(lng)]), {
        pane: 'turfs',
        color,
        weight: selected ? 4 : 2,
        opacity: 0.95,
        fillColor: color,
        fillOpacity: selected ? 0.16 : 0.07,
        className: `map-turf${selected ? ' map-turf--selected' : ''}`,
        bubblingMouseEvents: false,
      });
      // String tooltip content is set as innerHTML — escape the name.
      poly.bindTooltip(esc(t.name), { sticky: true, direction: 'top', offset: [0, -10], className: 'map-turf-tip' });
      poly.on('click', (e) => onTurfClickRef.current?.(t, e.latlng));
      poly.addTo(layer);
    }
  }, [turfs, turfsOn, turfParam]);

  // The turf being drawn: dashed outline, corner dots, a tappable first corner.
  useEffect(() => {
    const layer = layersRef.current?.draft;
    if (!layer) return;
    layer.clearLayers();
    if (mode !== 'draw') return;
    const pts = draft.points;
    const line = { pane: 'turfDraft', color: '#161a2e', weight: 2.5, dashArray: '6 6', interactive: false };
    if (pts.length >= 3) L.polygon(pts, { ...line, fillColor: '#161a2e', fillOpacity: 0.1 }).addTo(layer);
    else if (pts.length === 2) L.polyline(pts, line).addTo(layer);
    pts.forEach((p, i) => {
      if (i === 0) {
        const closable = pts.length >= 3 && !draft.naming;
        L.marker(p, {
          icon: draftStartIcon(closable),
          interactive: closable,
          keyboard: false,
          title: closable ? 'Close the turf here' : '',
          zIndexOffset: 3000,
        }).on('click', () => onDraftStartRef.current?.()).addTo(layer);
      } else {
        L.circleMarker(p, {
          pane: 'turfDraft', radius: 5, color: '#161a2e', weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false,
        }).addTo(layer);
      }
    });
  }, [mode, draft]);

  // Drawing starts: slide the map down by the strip's height, so what was
  // under it can still take a corner. Cancel slides it back; a saved turf
  // stays where it was drawn.
  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode !== 'draw') {
      if (drawShiftRef.current) map.panBy([0, drawShiftRef.current], { animate: false });
      drawShiftRef.current = 0;
      return;
    }
    const bar = pageRef.current?.querySelector('.map-mode--draw');
    if (!bar) return;
    const h = Math.round(bar.getBoundingClientRect().bottom - map.getContainer().getBoundingClientRect().top);
    if (h > 0) { map.panBy([0, -h], { animate: false }); drawShiftRef.current = h; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // A double-tap while drawing is two points, not a zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode === 'draw') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [mode]);

  // Pins (or count bubbles) for the filtered doors, at this zoom. A selected
  // door inside a bubble is pulled out so its pin always shows.
  const pinsOn = zoom != null && zoom >= Math.min(PIN_ZOOM, offZoom);
  // One zoom further out, a door with room around it already has its pin
  // (and its names); the rest stay dots until they come apart.
  const loneOn = zoom != null && !pinsOn && zoom >= Math.min(LONE_PIN_ZOOM, offZoom);
  // (Which doors stand alone is worked out over every door loaded, on screen
  // or not, so a pan changes no dot; only the ones in view get a marker.)
  const lone = useMemo(
    () => (loneOn ? clusterDoors(visible, zoom, offZoom, null, LONE_PX).filter((g) => g.length === 1) : EMPTY_LIST),
    [loneOn, visible, zoom, offZoom],
  );
  const groups = useMemo(() => {
    if (pinsOn) return clusterDoors(visible, zoom, offZoom, viewBounds);
    // (The open door's pin is drawn by itself while the rest are dots.)
    return lone.filter((g) => g[0].key !== selectedKey && (!viewBounds || viewBounds.contains([g[0].lat, g[0].lng])));
  }, [pinsOn, lone, visible, zoom, offZoom, viewBounds, selectedKey]);
  // Below street zoom: every door a dot (the open one keeps its pin) — the
  // doors the map has whole and, on a big list, the ones answered as dots —
  // or a big list's patches further out.
  const dotDoors = useMemo(() => {
    if (pinsOn) return EMPTY_LIST;
    const pinned = lone.length ? new Set(lone.map((g) => g[0].key)) : null;
    return visible.filter((d) => d.key !== selectedKey && !pinned?.has(d.key));
  }, [pinsOn, lone, visible, selectedKey]);
  const dotItems = useMemo(() => (leanShown.length ? [...dotDoors, ...leanShown] : dotDoors), [dotDoors, leanShown]);
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    dotItemsRef.current = { doors: dotDoors, lean: leanShown, cells: densityCells };
    layers.dots.setItems(dotItems, { dark: view === 'dark', flagged: (d) => Boolean(d.signs?.some(signOk)) });
    layers.density.setItems(densityCells, { dark: view === 'dark' });
  }, [dotItems, dotDoors, leanShown, densityCells, view, signOk]);
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    layers.chosen.clearLayers();
    if (pinsOn || !selectedDoor) return;
    L.marker([selectedDoor.lat, selectedDoor.lng], {
      icon: pinIcon(selectedDoor, true, signOk),
      title: `${doorTitle(selectedDoor)} — ${selectedDoor.persons.map((p) => personTitle(scale, p)).join(', ')}`,
      zIndexOffset: 1000,
    }).on('click', () => onPinClickRef.current?.(selectedDoor)).addTo(layers.chosen);
  }, [pinsOn, selectedDoor, signOk, scale]);
  const pulledKey = useMemo(
    () => (selectedKey && groups.some((g) => g.length > 1 && g.some((d) => d.key === selectedKey)) ? selectedKey : null),
    [groups, selectedKey],
  );
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    layers.doors.clearLayers();
    layers.signs.clearLayers();
    markersRef.current.clear();
    const addPin = (door) => {
      const selected = door.key === selectedKeyRef.current;
      const marker = L.marker([door.lat, door.lng], {
        icon: pinIcon(door, selected, signOk),
        title: `${doorTitle(door)} — ${door.persons.map((p) => personTitle(scale, p)).join(', ')}`,
        riseOnHover: true,
        zIndexOffset: selected ? 1000 : 0,
      });
      marker.on('click', () => onPinClickRef.current?.(door));
      marker.addTo(layers.doors);
      markersRef.current.set(door.key, marker);
    };
    for (const group of groups) {
      const rest = pulledKey ? group.filter((d) => d.key !== pulledKey) : group;
      if (rest.length !== group.length) addPin(group.find((d) => d.key === pulledKey));
      if (rest.length === 1) addPin(rest[0]);
      else if (rest.length > 1) {
        const seed = rest[0];
        L.marker([seed.lat, seed.lng], {
          icon: clusterIcon(rest, seed.offset),
          title: `${plural(rest.length, 'door', 'doors')} — tap to zoom in`,
          riseOnHover: true,
          zIndexOffset: 200,
        })
          .on('click', () => onClusterClickRef.current?.(rest))
          .addTo(layers.doors);
      }
    }
    if (filter === 'all' || filter === 'signs') {
      for (const s of orphanSigns.filter(signOk)) {
        L.marker([Number(s.lat), Number(s.lng)], {
          icon: signIcon(s.status, s.kind),
          title: `${SIGN_LABEL[s.kind] || s.kind} · ${SIGN_STATUS[s.status] || s.status}${s.address ? ` · ${s.address}` : ''}`,
          zIndexOffset: 500,
        })
          .on('click', () => onSignClickRef.current?.(s))
          .addTo(layers.signs);
      }
    }
  }, [groups, pulledKey, orphanSigns, filter, scale, signOk, zoom]);

  // Highlight the selected pin without rebuilding every marker.
  useEffect(() => {
    const paint = (key, on) => {
      const marker = key ? markersRef.current.get(key) : null;
      if (!marker) return;
      const el = marker.getElement();
      el?.querySelector('.map-pin')?.classList.toggle('map-pin--selected', on);
      el?.querySelector('.map-dot')?.classList.toggle('map-dot--selected', on);
      marker.setZIndexOffset(on ? 1000 : 0);
    };
    paint(prevSelectedRef.current, false);
    paint(selectedKey, true);
    prevSelectedRef.current = selectedKey;
  }, [selectedKey, groups, pulledKey]);

  const naming = mode === 'draw' && draft.naming;
  const turfSheetOpen = Boolean(selectedTurf && !mode && !pickerOpen && !addAt && !selectedDoor);
  const signSheetOpen = Boolean(signSel && !mode && !pickerOpen && !addAt && !selectedDoor && !turfSheetOpen);
  // The check sits over a scrim, like the Show sheet it opens from: nothing
  // else opens under it, and a tap beside it closes it.
  const checkSheetOpen = Boolean(checkOpen && mayCheck && !mode);
  const hasSheet = Boolean(pickerOpen || addAt || mode === 'add' || naming || (selectedDoor && !mode) || turfSheetOpen || signSheetOpen || checkSheetOpen);
  // What only this page knows, for the check: its build, the street map in
  // use and whether its tiles came, the map's size on screen.
  const lookLabel = [...SHADES, ...views].find((v) => v.key === view)?.label || view;
  const checkFacts = useCallback(() => {
    const map = mapRef.current;
    const size = map?.getSize();
    return {
      build: OWN_BUILD, look: lookLabel, tilesFrom: tileHost(tileUrl), tiles: streetRef.current,
      size: { x: size?.x || 0, y: size?.y || 0 }, zoom: map ? map.getZoom() : null,
    };
  }, [lookLabel, tileUrl]);
  const showEmpty = doorsQ.data && !big && doors.length === 0 && !hasSheet && !mode;
  // A big list's number is what is on screen, so it says what it counts:
  // people from further out, doors closer in. A list loaded whole — or a
  // volunteer's own turf, which comes whole — counts its doors, as ever.
  const byView = big && filter !== 'mine';
  const unit = byView ? (drawn?.kind === 'density' ? ['person', 'people'] : ['door', 'doors']) : null;
  const shownN = counts[filter];
  // Nothing drawn yet — the first answer is on its way: "Loading…", never a 0.
  // (No signal: the strip under the nav says so; nothing is on its way.)
  const paused = viewQ.fetchStatus === 'paused' || densQ.fetchStatus === 'paused';
  const opening = doorsQ.isPending || (byView && !drawn && !viewFailed && !paused);
  const pillN = opening ? 'Loading…'
    : shownN === null || (byView && !drawn) ? ''
      : unit ? `${num(shownN ?? 0)} ${shownN === 1 ? unit[0] : unit[1]}` : num(shownN ?? 0);
  // A map request out for more than a moment says so beside the count; what
  // was drawn stays until its answer is in.
  const slow = useSlow(Boolean(byView && (viewQ.isFetching || densQ.isFetching)) || doorQ.isFetching || spotBusy);
  // A big list, and nobody on screen — this view's own answer in, nothing
  // on its way: say so, with the way back. (By the screen, as the count is:
  // the part asked for is the screen and some, and just past the list's
  // edge it still held the list's last squares — "0 people", and no note.)
  // With one rating picked the dots are that rating's doors only: none on
  // screen is "0 doors", not nobody on file — there the answer's own count
  // says (everyone in the part asked for, whatever their rating).
  const nobodyHere = Boolean(byView && fresh && seen && !viewQ.isFetching && !densQ.isFetching
    && (fresh.kind === 'density' ? counts.all === 0
      : fresh.rating ? fresh.view.count === 0
        : !doors.some((d) => inBox(seen.box, d)) && !leanFree.some((d) => inBox(seen.box, d))));
  // "No signal — showing the doors already loaded" is said over doors the
  // first read brought, in fact drawn (a list loaded whole, a volunteer's
  // own turf). A big list's doors come by the view — those are never kept
  // ones — and a manager's phone keeps none: there "Unavailable — Try
  // again" says it alone, not this over an empty map, nor over doors a
  // view has just brought.
  const keptDrawn = visible.length > 0 && (!big || Boolean(doorsQ.data?.persons?.length));
  // The key under the count, once there are marks to explain.
  const showKey = Boolean(doorsQ.data) && !noSignal && (big ? Boolean(drawn) : doors.length > 0);
  // (On "My turf" a volunteer sees their own doors, not the list's patches.)
  const patches = byView && drawn?.kind === 'density';
  const keyWords = nobodyHere || !byView ? null
    : patches ? 'Each square is a block — zoom in for doors'
      : drawn?.kind === 'dots' || (drawn && !pinsOn) ? 'Each dot is a door' : null;
  // First visit (volunteers): "Tap a house to start" under the pill, only on
  // the plain map with houses to tap — never over a card, sheet or mode bar.
  // Opening any door counts as having started.
  useEffect(() => { if (selectedKey && !hintSeen) hideHint(); }, [selectedKey, hintSeen, hideHint]);
  const showHint = !canCreate && !hintSeen && !hasSheet && !mode && !filterOpen && !noSignal
    && !personParam && !turfParam && visible.length > 0;

  // Fit a turf: desk roles see the whole shape; a volunteer sees its doors
  // close enough that each is its own pin (the shape runs past the edges).
  const fitTurfView = (map, turf) => {
    if (!canCreate) {
      const ring = turf.polygon.map(([lat, lng]) => [Number(lat), Number(lng)]);
      const inside = doors.filter((d) => pointInPolygon(d.lat, d.lng, ring));
      if (inside.length) { fitTurf(map, inside.map((d) => [d.lat, d.lng]), pageRef.current, { maxZoom: 18, inset: PIN_INSET }); return; }
    }
    fitTurf(map, turf.polygon, pageRef.current);
  };

  // Where the campaign's own list is: the server says (where its people are
  // inside the campaign's area, or the middle of the list — strays in another
  // city don't zoom the map out to the province); else every door loaded.
  const listBox = () => {
    const b = doorsQ.data?.bounds;
    if (Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(v))) return [[b[0], b[1]], [b[2], b[3]]];
    return doors.length ? doors.map((d) => [d.lat, d.lng]) : null;
  };
  // A volunteer's own doors (the "My turf" ones), close enough that each is
  // its own pin — or, with none on the map yet, their turfs' outlines.
  const fitMine = (map, list) => {
    const rings = list.map((t) => t.polygon.map(([lat, lng]) => [Number(lat), Number(lng)]));
    const inside = doors.filter((d) => rings.some((r) => pointInPolygon(d.lat, d.lng, r)));
    const pts = inside.length ? inside.map((d) => [d.lat, d.lng]) : rings.flat();
    fitTurf(map, pts, pageRef.current, { maxZoom: 18, inset: inside.length ? PIN_INSET : 0 });
  };
  // "Whole list" / "Back to your list" (a volunteer on their turf: "My
  // turf"): back to it, in the part of the map the controls leave free.
  const backToMine = filter === 'mine';
  const fitList = () => {
    const map = mapRef.current;
    if (!map) return;
    const own = backToMine ? turfs.filter((t) => validRing(t.polygon)) : EMPTY_LIST;
    if (own.length) { fitMine(map, own); return; }
    const box = listBox();
    const more = pageRef.current?.querySelector('.map-key') ? 0 : KEY_ROOM;
    if (box) fitTurf(map, box, pageRef.current, { maxZoom: 16, pad: big ? 0 : 0.15, more: big ? more : 0 });
  };

  // First data: fit the deep-linked turf, else center on the deep-linked
  // door, else (volunteers) fit the doors of their own turf, else the list.
  const ownTurf = !canCreate && !personParam && !turfParam;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current) return;
    // Wait to learn the turf shapes (unless offline — then go with the doors).
    if ((turfParam || ownTurf) && turfsQ.isPending && turfsQ.fetchStatus !== 'paused') return;
    if (selectedTurf && validRing(selectedTurf.polygon)) {
      // Volunteers get the turf's doors close up — wait for them (unless offline).
      if (!canCreate && !doorsQ.data && doorsQ.fetchStatus !== 'paused') return;
      fittedRef.current = true;
      setFitted(true);
      focusedTurfRef.current = turfParam;
      fitTurfView(map, selectedTurf);
      return;
    }
    if (!doorsQ.data) return;
    // A big list, linked to one person: their door first (it may be anywhere).
    if (big && personParam && doorQ.isPending && doorQ.fetchStatus !== 'paused') return;
    fittedRef.current = true;
    setFitted(true);
    const mine = ownTurf ? turfs.filter((t) => validRing(t.polygon)) : EMPTY_LIST;
    if (selectedDoor) {
      map.setView([selectedDoor.lat, selectedDoor.lng], 17, { animate: false });
      revealLatLng(map, L.latLng(selectedDoor.lat, selectedDoor.lng), pageRef.current);
      centeredOnRef.current = personParam;
    } else if (mine.length) {
      fitMine(map, mine);
    } else {
      fitList();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doorsQ.data, doorsQ.fetchStatus, doors, selectedDoor, personParam, turfParam, turfsQ.isPending, turfsQ.fetchStatus, selectedTurf, ownTurf, turfs, doorQ.isPending, doorQ.fetchStatus]);

  // A new selection that is off-screen or under the drawer → bring it into view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedDoor || centeredOnRef.current === personParam) return;
    centeredOnRef.current = personParam;
    revealLatLng(map, L.latLng(selectedDoor.lat, selectedDoor.lng), pageRef.current);
  }, [personParam, selectedDoor]);

  // A turf selected from outside (a link, a new turf elsewhere) → fit it.
  // Tapped turfs set focusedTurfRef first, so the map holds still for them.
  useEffect(() => {
    if (!turfParam) { focusedTurfRef.current = null; return; }
    const map = mapRef.current;
    if (!map || !fittedRef.current || !selectedTurf || focusedTurfRef.current === turfParam) return;
    focusedTurfRef.current = turfParam;
    if (validRing(selectedTurf.polygon)) fitTurfView(map, selectedTurf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turfParam, selectedTurf]);

  // Naming a new turf: if the sheet covers part of the shape, slide it into
  // view (never zooming in past where they drew it).
  useEffect(() => {
    const map = mapRef.current;
    if (!naming || !map || draft.points.length < 3) return;
    fitTurf(map, draft.points, pageRef.current, { onlyIfHidden: true, maxZoom: map.getZoom() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naming]);

  // Opening a turf's sheet: refresh its counts (doors knocked from the door
  // card or another phone since the list loaded). Where turfs come as
  // outlines the sheet asks for its own counts as it opens.
  useEffect(() => {
    if (!turfParam || turfsFrom !== TURFS_WHOLE) return;
    const state = queryClient.getQueryState(['turfs']);
    if (state?.dataUpdatedAt && Date.now() - state.dataUpdatedAt > 5000) {
      queryClient.invalidateQueries({ queryKey: ['turfs'] });
    }
  }, [turfParam, queryClient, turfsFrom]);

  const drawCount = draft.points.length;
  // The look's class sits on the page, never on Leaflet's own element: React
  // rewriting that element's classes would wipe the ones Leaflet added.
  const pageCls = ['map-page', `map-view--${view}`, hasSheet && 'has-sheet', mode && 'is-moded', mode === 'draw' && 'is-drawing'].filter(Boolean).join(' ');

  return (
    <div className={pageCls} ref={pageRef} style={MARK_VARS}>
      {/* For tests: how many doors are drawn (pins and dots), the zoom, what a
          big list is drawn as (density · dots · rows), and whether the street
          map's tiles are coming (ok · down). */}
      <div
        className="map-canvas" ref={canvasRef} role="application" aria-label="Canvass map"
        data-doors={visible.length + leanShown.length} data-zoom={zoom ?? ''} data-view={big ? drawn?.kind || '' : doorsQ.data ? 'all' : ''}
        data-tiles={street.down ? 'down' : street.any ? 'ok' : ''}
      />

      <div className="map-top">
        {mode === 'draw' ? (
          naming ? null : (
            // A slim strip, only as wide as it needs: the map under it stays
            // tappable, and the map slides down by its height when drawing starts.
            <div className="map-mode map-mode--draw">
              <span role="status" className="map-mode__count">
                {drawCount === 0 ? 'Tap a corner' : <><strong>{drawCount}</strong> {drawCount === 1 ? 'corner' : 'corners'}</>}
              </span>
              <span className="map-mode__btns">
                <button type="button" className="btn" onClick={undoPoint} disabled={!drawCount}>Undo</button>
                <button type="button" className={`btn${drawCount >= 3 ? ' map-mode__go' : ''}`} onClick={finishDraw} disabled={drawCount < 3}>Finish</button>
                <button type="button" className="btn map-mode__x" onClick={cancelMode} aria-label="Cancel drawing" title="Cancel">✕</button>
              </span>
            </div>
          )
        ) : mode === 'place' && placing ? (
          <div className="map-mode" role="status">
            <span>
              Tap where <strong>{placing.name}</strong> lives
              {placing.address ? <span className="map-mode__sub">{placing.unit ? `${placing.unit} – ` : ''}{placing.address}</span> : null}
            </span>
            <button type="button" className="btn" onClick={cancelMode}>Cancel</button>
          </div>
        ) : mode === 'add' ? (
          <div className="map-mode" role="status">
            <span>{addAt ? 'Tap the map to move the pin' : 'Type the address, or tap the new door'}</span>
            <button type="button" className="btn" onClick={cancelMode}>Cancel</button>
          </div>
        ) : missingPerson ? (
          <div className="map-mode" role="status">
            <span><strong>{missingPerson.name}</strong> isn’t on the map</span>
            <span className="map-mode__btns">
              <button type="button" className="btn" onClick={() => { startPlacing(missingPerson); select(null); }}>Place</button>
              <button type="button" className="btn" onClick={() => select(null)} aria-label="Dismiss">✕</button>
            </span>
          </div>
        ) : missingGone ? (
          <div className="map-mode" role="status">
            <span>Person not found</span>
            <button type="button" className="btn" onClick={() => select(null)} aria-label="Dismiss">✕</button>
          </div>
        ) : turfMissing ? (
          <div className="map-mode" role="status">
            <span>{canCreate ? 'Turf not found' : 'Not your turf — ask your organizer'}</span>
            <button type="button" className="btn" onClick={() => select(null)} aria-label="Dismiss">✕</button>
          </div>
        ) : (
          <div className="map-bar">
            {/* Nothing to filter with no doors loaded (no signal): the card below says so. */}
            {!noSignal && (
              <button
                type="button"
                ref={filterBtnRef}
                className={`map-filter-btn${filter !== 'all' ? ' is-filtered' : ''}`}
                data-band={filters.find((f) => f.key === filter)?.band || filter}
                aria-haspopup="dialog"
                aria-expanded={filterOpen}
                aria-label={`Show: ${labelOf(filter)}, ${opening ? 'loading' : shownN === null ? 'zoom in to count' : unit ? `${pillN} in view` : plural(shownN ?? 0, 'door', 'doors')}`}
                onClick={() => { setFilterOpen((o) => !o); setUnlocOpen(false); }}
              >
                <FilterGlyph />
                <span className="map-filter-btn__label"><span className="map-filter-btn__show">Show:</span> {labelOf(filter)}</span>
                <span className="map-filter-btn__n mono" aria-live="polite">{pillN}</span>
                {slow && !opening && <span className="map-filter-btn__busy" aria-live="polite">Loading…</span>}
              </button>
            )}
            {/* The part of the map on screen was asked for and not answered.
                (On "My turf" the list's answers aren't drawn — a volunteer's
                own doors come whole — so theirs is no "Unavailable".) */}
            {((viewFailed && byView) || doorFailed) && !noSignal && (
              <button
                type="button" className="map-chip map-retry"
                onClick={() => { if (doorFailed) doorQ.refetch(); if (viewFailed && byView) (wantsPatches ? densQ : viewQ).refetch(); if (doorsQ.isError) doorsQ.refetch(); }}
              >
                Unavailable — Try again
              </button>
            )}
            {myWalk && (
              <Link className="map-chip" to={myWalk.to}><WalkGlyph /> {myWalk.label}</Link>
            )}
            {canCreate && (
              <button type="button" className="map-chip" onClick={startDraw} aria-label="Draw a turf">
                <TurfGlyph /> Draw turf
              </button>
            )}
            {canCreate && unlocated > 0 && (
              <div className={`map-unloc${unlocOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="map-unloc__chip"
                  aria-expanded={unlocOpen}
                  aria-label={placingWords ? placingWords.replace(/ · /g, ', ') : `${plural(unlocated, 'person', 'people')} not on the map`}
                  onClick={() => { setUnlocOpen((o) => !o); setFilterOpen(false); }}
                >
                  <PinGlyph />
                  {placingWords
                    ? <span className="map-unloc__label">{placingWords}</span>
                    : <><span className="map-unloc__label">Not on map</span> <span className="map-unloc__n mono">{num(unlocated)}</span></>}
                </button>
                {/* Said once when the run starts, pauses or stops — not with every count. */}
                <span className="fk-sr" role="status">{placingRun ? (placingRun.state === 'paused' ? 'Placing addresses is paused' : 'Placing addresses on the map') : ''}</span>
                {unlocOpen && (
                  <span className="map-unloc__btns">
                    <button type="button" className="btn map-unloc__btn" onClick={() => { setPickerOpen(true); setAddAt(null); setUnlocOpen(false); cancelMode(); }}>
                      Drop pins by hand
                    </button>
                    <GeocodeButton compact onDone={onGeocoded} />
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {/* No signal: these are the doors this phone kept, not live ones. */}
        {doorsCopy && !mode && <span className="chip obx-copy map-copy" role="status">Offline copy</span>}
        {showHint && (
          <div className="map-hint" role="status">
            <span className="map-hint__text">Tap a house to start</span>
            <button type="button" className="btn map-hint__x" onClick={hideHint} aria-label="Dismiss" title="Dismiss">✕</button>
          </div>
        )}
        {/* The street map isn't loading (and the map isn't about to go to its
            other provider by itself): one line, one tap — to the other only
            if it has just answered, else to ask this one again. Or it has
            just switched by itself: said for a few seconds, while that look
            is the one drawn (not while the pick is, with no signal). */}
        {(move === 'try-other' || move === 'try-again') && !mode ? (
          <div className="map-tilenote" role="status">
            <span>The street map isn’t loading</span>
            {move === 'try-other'
              ? <button type="button" className="btn map-tilenote__btn" onClick={() => { setSwitchedTo(null); setAutoView(otherLook.key); setTapped(true); }}>Try {otherLook.label}</button>
              : <button type="button" className="btn map-tilenote__btn" onClick={() => setTilesTry((n) => n + 1)}>Try again</button>}
          </div>
        ) : switchedTo && drawnAuto && !mode ? (
          <div className="map-tilenote map-tilenote--done" role="status">The street map wasn’t loading — switched to {switchedTo}</div>
        ) : null}
        {showKey && !mode && <MapKey squares={patches} dark={view === 'dark'} words={keyWords} />}
      </div>

      {filterOpen && !mode && (
        <FilterSheet
          filters={filters}
          filter={filter}
          onFilter={(key) => { setFilter(key); closeFilter(); }}
          counts={counts}
          countsNote={drawn?.kind === 'density' ? `People in view, by how they’re rated — zoom in to see doors${zoomInFor ? `, and ${zoomInFor}` : ''}.` : big ? 'Doors in view.' : null}
          showTurfs={showTurfs}
          onTurfs={setTurfsShown}
          turfCount={turfs.length}
          desk={canCreate}
          onDraw={startDraw}
          unlocated={unlocated}
          onPlace={() => { setFilterOpen(false); setPickerOpen(true); setAddAt(null); cancelMode(); }}
          onClose={closeFilter}
          tilesNote={canCreate ? tilesLine(tilesQ.data?.setup) : null}
          sharing={sharing}
          onShare={setSharing}
          signShow={signShow}
          onSigns={setSignShow}
          signCounts={signCounts}
          views={views}
          view={view}
          onView={setView}
          onCheck={mayCheck ? () => { setFilterOpen(false); setPickerOpen(false); setAddAt(null); select(null); setCheckOpen(true); } : null}
        />
      )}

      <div className="map-fabs">
        <div className="map-fabs__row">
          {/* Back to the campaign's own list from wherever the map has got to. */}
          {doorsQ.data && (big || doors.length > 0) && mode !== 'draw' && (
            <button type="button" className="map-fab map-fab--list" onClick={fitList}>{backToMine ? 'My turf' : 'Whole list'}</button>
          )}
          <button type="button" className="map-fab" title="Locate me" aria-label="Locate me" onClick={locateMe} disabled={locating}>
            <LocateGlyph />
          </button>
        </div>
        {canCreate && mode !== 'draw' && (
          <button
            type="button"
            className={`map-fab map-fab--add${mode === 'add' ? ' is-on' : ''}`}
            title="Add a door (or long-press the map)"
            aria-label="Add a door"
            aria-pressed={mode === 'add'}
            onClick={toggleAdd}
          >
            <span className="map-fab__plus" aria-hidden="true">+</span> Door
          </button>
        )}
      </div>

      {noSignal ? (
        <div className="card map-empty map-offline" role="status">
          <p>{offlineWalk ? 'No signal — your walk list still works' : 'No signal — doors load when you’re back'}</p>
          {offlineWalk && (
            <Link className="btn btn-primary map-empty__btn" to={`/turfs/${offlineWalk.id}`}>Open walk list</Link>
          )}
        </div>
      ) : doorsQ.isError && (doorsQ.error?.status || keptDrawn) ? (
        <p className="error map-error">{doorsQ.error?.status ? doorsQ.error.message : 'No signal — showing the doors already loaded'}</p>
      ) : turfsQ.isError && !turfsQ.data ? (
        <p className="error map-error">Turfs didn’t load</p>
      ) : null}
      {zoomNote && !hasSheet && !mode && (
        <p className="map-zoomnote" role="status">{zoomNote}</p>
      )}
      {nobodyHere && !zoomNote && !hasSheet && !mode && (
        <div className="map-nobody" role="status">
          <span>Nobody on file here</span>
          <button type="button" className="btn map-nobody__btn" onClick={fitList}>Back to your list</button>
        </div>
      )}
      {showEmpty && (
        <div className="card map-empty">
          {doorsData?.scope === 'turfs' && !doorsData.turfs ? (
            <p>No turf yet — your organizer gives you one, and its doors show here</p>
          ) : doorsData?.scope === 'turfs' ? (
            <p>No doors in your turfs yet — ask your organizer</p>
          ) : unlocated > 0 ? (
            <>
              <p>{plural(unlocated, 'person needs', 'people need')} a pin</p>
              <button type="button" className="btn btn-primary map-empty__btn" onClick={() => { setPickerOpen(true); setAddAt(null); cancelMode(); }}>Place</button>
            </>
          ) : canCreate ? (
            <>
              <p>No doors yet</p>
              <button type="button" className="btn btn-primary map-empty__btn" onClick={toggleAdd}>+ Add door</button>
            </>
          ) : (
            <p>No doors yet — ask your organizer</p>
          )}
        </div>
      )}

      {pickerOpen && <PlacePicker unlocated={unlocated} onPick={startPlacing} onClose={() => setPickerOpen(false)} />}

      {mode === 'add' && !pickerOpen && (
        <div className="map-sheet">
          <AddDoorForm
            latlng={addAt}
            onPlace={placeNew}
            toast={toast}
            onCancel={cancelMode}
            onDone={(id) => { cancelMode(); centeredOnRef.current = id; select(id); }}
          />
        </div>
      )}

      {selectedDoor && !pickerOpen && !addAt && !mode && (
        <div className="map-sheet">
          <DoorCard
            key={selectedDoor.key}
            door={selectedDoor}
            selectedId={personParam}
            onSelect={select}
            onClose={() => select(null)}
            toast={toast}
            me={me}
            canCreate={canCreate}
            canAddHere={canCreate || Boolean(mineKeys?.has(selectedDoor.key))}
          />
        </div>
      )}

      {naming && (
        <div className="map-sheet">
          <NameTurfForm
            points={draft.points}
            doors={doors}
            counted={!big}
            takenNames={turfs.map((t) => t.name)}
            busy={turfBusy}
            error={turfError}
            onSave={saveTurf}
            onBack={backToDrawing}
            onCancel={cancelMode}
          />
        </div>
      )}

      {turfSheetOpen && (
        <TurfSheet
          key={selectedTurf.id}
          turf={selectedTurf}
          me={me}
          desk={canCreate}
          toast={toast}
          onClose={() => select(null)}
          onDeleted={(t) => { select(null); toast(`Deleted ${t.name}`); }}
        />
      )}

      {signSheetOpen && <SignSheet sign={signSel} desk={canCreate} onClose={() => setSignSel(null)} />}

      {checkSheetOpen && (
        <>
          <button type="button" className="map-scrim" aria-label="Close the map check" tabIndex={-1} onClick={closeCheck} />
          <MapCheck facts={checkFacts} onClose={closeCheck} />
        </>
      )}

      {toastMsg && (
        <div className="toast map-toast" role="status">
          <span>{toastMsg.text}</span>
          {toastMsg.act && (
            <button
              type="button"
              className="btn map-toast__btn"
              onClick={() => { const { onClick } = toastMsg.act; setToastMsg(null); clearTimeout(toastTimer.current); onClick(); }}
            >
              {toastMsg.act.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
