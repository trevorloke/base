// The canvass map's own rules, with no map library in them (so they can be
// tested as they are — server/test/mapview.test.js): which part of the map a
// big list asks for, how many people it takes whole, what it draws once an
// answer is in, and how its marks are coloured.

// A list too big to load at once (a city's voter file) is drawn three ways:
//   further out than DOT_ZOOM  a picture: people per patch of the map
//                              (GET /api/map/density), shaded squares;
//   from DOT_ZOOM              door by door (GET /api/map/doors?bbox&dots=1):
//                              the people themselves where they fit, else
//                              every door a dot;
//   from LONE_PIN_ZOOM         a door with room around it gets its pin, and
//   from PIN_ZOOM              every door does (18: where neighbouring houses
//                              on a street come apart, about 38 px).
export const DOT_ZOOM = 14;
export const LONE_PIN_ZOOM = 17;
export const PIN_ZOOM = 18;

// How many people one view takes whole; past it the server answers dots. At
// about 250 bytes a person, 2,400 keep an answer near 600 KB. At street
// level the pins and their names are the point: as many as the server gives.
export const rowsBudget = (zoom) => (zoom >= PIN_ZOOM ? 8000 : 2400);

// The part of the map to ask for: the screen and 15% more on every side, on
// a grid a quarter of the screen wide — a short pan asks for nothing new, and
// an answer is never many screens' worth of people (it was 8 to 11 screens,
// cut off and thrown away). center { lat, lng }; size { x, y }, the map in
// pixels; → [south, west, north, east], to the metre.
export const viewBox = (center, size, zoom) => {
  const perPx = 360 / (256 * 2 ** zoom); // degrees of longitude to a pixel
  const stepLng = (size.x / 4) * perPx;
  const stepLat = (size.y / 4) * perPx * Math.cos((Math.round(center.lat) * Math.PI) / 180);
  const lat = Math.round(center.lat / stepLat) * stepLat;
  const lng = Math.round(center.lng / stepLng) * stepLng;
  // In quarter-screens from the middle: half the screen (2), its 15% (0.6),
  // half a step for where the middle snapped to (0.5), and a hair.
  const reach = 3.2;
  // (Zoomed right out the screen is taller than the Earth: never a latitude
  // past a pole — the server refuses one.)
  return [Math.max(-90, lat - reach * stepLat), lng - reach * stepLng, Math.min(90, lat + reach * stepLat), lng + reach * stepLng]
    .map((v) => Number(v.toFixed(5)));
};
export const inBox = ([s, w, n, e], it) => it.lat >= s && it.lat <= n && it.lng >= w && it.lng <= e;

// What a big list draws for the view on screen, from the answers that have
// arrived for it — or null while one is still on its way: the map then keeps
// what it had (never an empty map, never "0", in between).
//   doors    this view asks door by door (zoom ≥ DOT_ZOOM)
//   view     /map/doors' answer for it, or null
//   density  /map/density's answer for it, or null
// → { kind: 'density', density, cut }  cut: too many doors here even for dots
//   { kind: 'dots' | 'rows', view }
export const drawnFor = ({ doors, view, density }) => {
  if (!doors) return density ? { kind: 'density', density, cut: false } : null;
  if (!view) return null;
  if (view.truncated) return density ? { kind: 'density', density, cut: true } : null;
  return { kind: view.dots ? 'dots' : 'rows', view };
};

// ── Doors as dots ──
// /map/doors?dots=1 answers one lean row per door, [lat, lng, band, people]
// (band: 0 not asked yet · 1 undecided · 2 support · 3 opposed — the
// household's, as a pin's colour is).
const BAND_NAME = ['unrated', 'undecided', 'support', 'opposed'];
export const dotsFrom = (rows) => (rows || []).map(([lat, lng, band, n]) => ({ lat, lng, band: BAND_NAME[band] || 'unrated', n }));

// ── Marks ──
// Colours are [r, g, b] or [r, g, b, alpha]; fixed values, not theme tokens:
// the base map is what it is in either scheme. Rating colours never change
// (support green, undecided ochre, opposed red). "Not asked yet" is every
// mark on a fresh voter file, so it has to read on any base map: slate at
// 85% (5 to 1 or better on the light ones), and from zoom 14 every dot wears
// a white ring. Undecided's ochre is too light to read by itself on a light
// map; its darker edge is what reads (3 to 1 or better).
export const MARK = {
  support: [19, 138, 82],
  undecided: [232, 150, 12],
  opposed: [212, 60, 60],
  unrated: { light: [45, 58, 84, 0.85], dark: [205, 216, 238, 0.55] },
  unratedPin: [77, 88, 110], // the same slate where it can't be see-through: a pin, a bubble's ring, the filter's dot
  undecidedEdge: { light: [160, 100, 0], dark: [232, 150, 12] },
  ring: { light: [255, 255, 255, 0.95], dark: [20, 26, 38, 0.9] },
};
export const css = ([r, g, b, a = 1]) => (a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`);

// A dot's radius (CSS px) as drawn on a tile of whole zoom z, big enough
// close in to aim a finger at. The map stops at quarter zooms too, and
// between whole zooms the nearest zoom's tiles are stretched: on screen a
// dot is 0.7 to 1.4 times this — never under 2.5 px (dotOnScreen).
export const dotRadius = (z) => (z <= 14 ? 3.6 : z <= 15 ? 4.2 : z <= 16 ? 5.4 : 7);
export const dotOnScreen = (zoom) => dotRadius(Math.round(zoom)) * 2 ** (zoom - Math.round(zoom));
// From zoom 14 every dot wears a white ring (a tile's whole zoom).
export const ringedAt = (z) => z >= 14;

// ── The far-out picture ──
// A patch of the map, in degrees, for a whole zoom: CELL_PX screen pixels a
// side near the given latitude (Web Mercator) — a block or two.
export const CELL_PX = 12;
export const cellOf = (z, lat) => {
  const dlng = (CELL_PX * 360) / (256 * 2 ** z);
  const dlat = dlng * Math.cos((lat * Math.PI) / 180);
  return [Number(dlat.toFixed(7)), Number(dlng.toFixed(7))];
};

// /map/density's rows → one item per patch, keeping only the ratings the
// filter wants (keep(code) — '' is not rated yet): its corners (s, w, n2, e)
// and middle, its people (n), how many of them are rated and the band most
// of those are in, and how thickly people live there (per km²).
const KM_PER_DEGREE = 111.32;
export function cellsFrom(data, bandOfCode, keep = () => true) {
  if (!data?.cells?.length) return [];
  const [dlat, dlng] = data.cell;
  const by = new Map();
  for (const [y, x, r, n] of data.cells) {
    if (!keep(r)) continue;
    const k = `${y}:${x}`;
    let c = by.get(k);
    if (!c) {
      c = { s: y * dlat, w: x * dlng, n2: (y + 1) * dlat, e: (x + 1) * dlng, lat: (y + 0.5) * dlat, lng: (x + 0.5) * dlng, n: 0, rated: 0, support: 0, undecided: 0, opposed: 0 };
      by.set(k, c);
    }
    c.n += n;
    const band = r ? bandOfCode(r) : null;
    if (band && band !== 'unrated') { c.rated += n; c[band] += n; }
  }
  const out = [...by.values()];
  for (const c of out) {
    c.band = c.support >= c.opposed && c.support >= c.undecided ? 'support' : c.opposed >= c.undecided ? 'opposed' : 'undecided';
    c.per = c.n / (dlat * KM_PER_DEGREE * dlng * KM_PER_DEGREE * Math.cos((c.lat * Math.PI) / 180));
  }
  return out;
}

// A patch's colour. More people, stronger shade: from a slate that still
// reads on any light map (3 to 1) to ink — on the Dark look the other way,
// lighter for more. Where people there are rated it takes the colour of the
// band most of them are in, as far as the people there are in that band: a
// patch where a tenth have said yes stays nearly neutral, one where nearly
// everyone has is green (or ochre, or red); a patch split between yes and no
// says neither loudly, and one or two answers don't colour a block (a map
// of single answers reads as confetti). → [r, g, b, alpha]; the alpha is
// the same for every patch (CELL_ALPHA: the picture is one see-through
// sheet — mapDots.js draws it solid and fades the sheet).
const SHADE = {
  light: { few: [100, 110, 134], many: [22, 26, 46] },
  dark: { few: [128, 138, 165], many: [232, 237, 247] },
};
const FULL_PER_KM2 = 8000; // as strong as it gets: a block of towers
export const CELL_ALPHA = 0.92;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
export const cellFill = (c, dark) => {
  const ramp = SHADE[dark ? 'dark' : 'light'];
  const s = Math.min(1, Math.sqrt(c.per / FULL_PER_KM2));
  const neutral = mix(ramp.few, ramp.many, s);
  const lead = c.rated ? c[c.band] : 0;
  if (!lead) return [...neutral, CELL_ALPHA];
  const band = mix(MARK[c.band], ramp.many, s * 0.35);
  return [...mix(neutral, band, (lead / c.n) ** 0.75 * Math.min(1, lead / 3)), CELL_ALPHA];
};

// ── Is the street map loading? ──
// Leaflet asks for a view's tiles in one go ('loading' … 'load'). When a view
// is done and most of its tiles failed, the street map isn't loading; so too
// when a view is six seconds old and not one tile has come (a host that never
// answers), or most of what has settled by then failed. A later view where
// most come says it is loading again. Map.jsx feeds it the layer's events;
// loaded and failed count every tile since the layer was added (the map's
// check shows them).
// One tile that never answers keeps Leaflet's go open, though, and the views
// moved to meanwhile are not asked about at all: so six seconds after each
// move Map.jsx looks at the screen itself, and with tiles still out and not
// one street drawn on it says so (blank).
export const TILE_WAIT_MS = 6000;
export const tileHealth = () => {
  let ok = 0; let bad = 0;         // this view's tiles
  let loaded = 0; let failed = 0;
  let since = null;                // when this view's tiles were asked for; null once they are all in
  let down = false;
  return {
    batch(now) { ok = 0; bad = 0; since = now; },
    tile(good) { if (good) { ok += 1; loaded += 1; } else { bad += 1; failed += 1; } },
    done() { if (ok + bad) down = bad > ok; since = null; },
    late(now) { if (since != null && now - since >= TILE_WAIT_MS) down = ok === 0 || bad > ok; },
    blank() { if (since != null) down = true; },
    get: () => ({ loaded, failed, down }),
  };
};

// One tile of a street map: the one under a point at a zoom (the nearest
// whole zoom, never past the provider's last), its address filled in as the
// map fills it ({s} its first host, {r} the plain one). Before the map goes
// to its other provider by itself it asks that one for this tile, and goes
// only if it answers: with weak signal neither does, and going would leave
// undrawn the streets this phone kept (Map.jsx).
export const tileAt = (template, { lat, lng }, zoom, maxZoom = 19) => {
  const z = Math.max(0, Math.min(Math.round(zoom), maxZoom));
  const n = 2 ** z;
  const whole = (v) => Math.min(n - 1, Math.max(0, Math.floor(v)));
  const sin = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  const x = whole(((((lng + 180) % 360) + 360) % 360 / 360) * n);
  const y = whole((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n);
  return String(template).replace(/\{s\}/g, 'a').replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y).replace(/\{r\}/g, '');
};

// What the map does when its street map isn't loading (Map.jsx), from:
//   down      this look's street map isn't loading, and the phone says it has signal
//   onAuto    the map is on a look it went to by itself (or one tapped from
//             the note whose streets haven't come yet), not the person's pick
//   other     there is a street map from another provider (a campaign's own
//             provider, or Google's, has none)
//   asked     that one, asked for one tile: null (not yet), 'asking', 'yes'
//             (it answered) or 'no' (not in a few seconds)
//   switched  the map has gone to the other by itself once already this visit
// The streets a phone keeps are its pick's. With weak signal the phone says
// it is online and no tile host answers: going to the other provider would
// leave those streets undrawn, so nothing goes there unless it has just
// answered — and on a look the map went to by itself, not loading either is
// the signal: back to the pick.
//   'back'       to the person's own pick
//   'ask'        ask the other provider for one tile first
//   'switch'     go to it, once, and say so
//   'try-other'  "The street map isn’t loading", one tap to the other (it just answered)
//   'try-again'  "The street map isn’t loading", one tap to ask this one again
//   null         nothing to do or say (loading, or still asking)
export const streetMove = ({ down, onAuto, other, asked, switched }) => {
  if (!down) return null;
  if (onAuto) return 'back';
  if (!other) return 'try-again';
  if (!asked) return 'ask';
  if (asked === 'asking') return null;
  if (asked === 'yes') return switched ? 'try-other' : 'switch';
  return 'try-again';
};

// "3:40 pm", on the reader's own clock: when a paused placing run tries
// again (always a time of day — it may be after midnight).
export const timeOfDay = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

// A paused run still paused a minute past the time it was to try again:
// that try didn't run (the server's job runner was off, or the try failed
// for good) — nothing is coming, and saying "tries again at" a time gone
// by would be untrue.
export const RETRY_LATE_MS = 60_000;
export const retryLate = (iso, now = Date.now()) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) && at < now - RETRY_LATE_MS;
};

// How often the map looks at the placing run (desk, while anyone waits for
// a pin): every few seconds while it runs; just after a paused run is due
// to try again; else now and then, to notice one started elsewhere (an
// import, another tab) — and a try that never came is no reason to ask
// every two seconds. → ms
export const placingPoll = (st, now = Date.now()) => {
  if (st?.state === 'running') return 4000;
  if (st?.state === 'paused' && st.retryAt && !retryLate(st.retryAt, now)) {
    return Math.min(60_000, Math.max(2000, Date.parse(st.retryAt) - now + 1500));
  }
  return 30_000;
};

// ── The map's check, for managers ──
// GET /api/map/check (ext/mapcheck) and what only the page knows, as lines to
// read — and to screenshot: each way a map can look empty has a line of its
// own, flagged (warn) when it applies.
//   c     the server's answer
//   page  { build, look, tilesFrom, tiles: { loaded, failed, down }, size: { x, y }, zoom }
//         tilesFrom: the host the street map's tiles come from ('' for the
//         server's own) — said by the provider's name where it has one
//   → [{ key, label, value, note, warn }]
const enCA = (n) => Number(n || 0).toLocaleString('en-CA');
const PROVIDER = { 'basemaps.cartocdn.com': 'CARTO', 'tile.openstreetmap.org': 'OpenStreetMap' };
export const checkLines = (c, page, { num = enCA, clock = (iso) => iso, now = Date.now() } = {}) => {
  const p = c.people;
  const g = c.placing;
  const lines = [];
  const add = (key, label, value, { note = null, warn = false } = {}) => lines.push({ key, label, value, note, warn: Boolean(warn) });

  add('file', 'On file', num(p.total));
  add('onmap', 'On the map', num(p.onMap));
  // Nobody is placed by guessing: no address, no pin — counted here.
  const why = [p.waiting ? `${num(p.waiting)} waiting for a pin` : null, p.noAddress ? `${num(p.noAddress)} with no address` : null].filter(Boolean);
  add('offmap', 'Not on map', `${num(p.waiting + p.noAddress)}${why.length ? ` — ${why.join(', ')}` : ''}`, { warn: p.waiting > 0 && p.waiting * 100 >= p.total });

  const placed = g.located + g.copied;
  const waiting = `${num(g.remaining)} ${g.remaining === 1 ? 'address' : 'addresses'} waiting`;
  let run;
  if (g.off) run = ['Turned off', { note: g.remaining ? `${waiting} — addresses are not looked up on this server; drop pins by hand` : null, warn: g.remaining > 0 }];
  else if (g.state === 'running') run = [`Running · ${num(placed)} of ${num(placed + g.missed + g.remaining)}`, {}];
  else if (g.state === 'paused') {
    // When it tries again by itself — or, long past that time, that it didn't
    // (and with no job runner on this server, nothing will).
    const why = `Address lookup isn’t answering${g.lastError ? ` (${g.lastError})` : ''}`;
    if (!g.jobs) run = ['Paused', { note: `${why} — background jobs are off on this server; “Look up addresses” works while its page stays open`, warn: true }];
    else if (g.retryAt && retryLate(g.retryAt, now)) run = [`Paused — was due to try again at ${clock(g.retryAt)}`, { note: `${why} — its try didn’t run: tap “Not on map”, then “Try now”`, warn: true }];
    else run = [`Paused${g.retryAt ? ` — tries again at ${clock(g.retryAt)}` : ''}`, { note: why, warn: true }];
  }
  else if (g.remaining > 0 && !g.jobs) run = ['Not running', { note: `${waiting} — background jobs are off on this server; “Look up addresses” works while its page stays open`, warn: true }];
  else if (g.remaining > 0) run = [g.state === 'stopped' ? 'Stopped' : 'Not running', { note: `${waiting} — tap “Not on map”, then “Look up addresses”`, warn: true }];
  else run = ['Nothing waiting', {}];
  if (g.unmatched > 0) run[1].note = [run[1].note, `${num(g.unmatched)} couldn’t be matched — they need a pin by hand`].filter(Boolean).join(' · ');
  add('placing', 'Placing addresses', run[0], run[1]);

  const elsewhere = p.onMap > 0 && c.area.inside * 2 <= p.onMap;
  add('area', 'Outside your area', `${num(c.area.outside)} of the ${num(p.onMap)} on the map`, {
    note: elsewhere ? 'Most of the list is outside the area this campaign is set to — the map opens on the middle of the list' : null, warn: elsewhere,
  });
  add('turfs', 'Turfs', num(c.turfs));

  const t = page.tiles || { loaded: 0, failed: 0, down: false };
  const from = [page.look, PROVIDER[page.tilesFrom] || page.tilesFrom || c.tiles.source].filter(Boolean).join(' · ');
  add('tiles', 'Street map', `${from} — ${t.down ? 'isn’t loading: ' : ''}${num(t.loaded)} loaded, ${num(t.failed)} failed`, {
    note: (c.tiles.ignored || []).includes('url') ? 'The street map address set on the server was ignored' : null, warn: t.down,
  });

  const known = Boolean(page.build && c.build);
  add('build', 'This page', !known ? 'Not compared' : page.build === c.build ? 'Up to date' : 'Older than the server — reload it', {
    note: c.commit ? `Version ${c.commit}` : null, warn: known && page.build !== c.build,
  });

  const { x = 0, y = 0 } = page.size || {};
  const cramped = x < 200 || y < 200;
  add('screen', 'Map on screen', `${num(x)} × ${num(y)} px · zoom ${page.zoom ?? '—'}`, { note: cramped ? 'The map has almost no room on this screen' : null, warn: cramped });
  return lines;
};
