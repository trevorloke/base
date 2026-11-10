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
  return [lat - reach * stepLat, lng - reach * stepLng, lat + reach * stepLat, lng + reach * stepLng]
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
// of single answers reads as confetti). → [r, g, b, alpha]
const SHADE = {
  light: { few: [100, 110, 134], many: [22, 26, 46] },
  dark: { few: [128, 138, 165], many: [232, 237, 247] },
};
const FULL_PER_KM2 = 8000; // as strong as it gets: a block of towers
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
export const cellFill = (c, dark) => {
  const ramp = SHADE[dark ? 'dark' : 'light'];
  const s = Math.min(1, Math.sqrt(c.per / FULL_PER_KM2));
  const neutral = mix(ramp.few, ramp.many, s);
  const lead = c.rated ? c[c.band] : 0;
  if (!lead) return [...neutral, 0.92];
  const band = mix(MARK[c.band], ramp.many, s * 0.35);
  return [...mix(neutral, band, (lead / c.n) ** 0.75 * Math.min(1, lead / 3)), 0.92];
};
