// The map's own rules, as the page applies them (web/src/pages/mapView.js —
// no browser needed): which part of the map it asks for, how many people it
// will take whole, what it draws while an answer is on its way, and how its
// marks are coloured — "not asked yet" and undecided readable on every base
// map, a patch of the far-out picture darker the more people live there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewBox, rowsBudget, DOT_ZOOM, LONE_PIN_ZOOM, PIN_ZOOM,
  dotsFrom, dotRadius, dotOnScreen, ringedAt, MARK, cellOf, cellsFrom, cellFill, drawnFor, inBox,
} from '../../web/src/pages/mapView.js';
import { bandOf } from '@starbase/shared/scale';

// ── Which part of the map is asked for ──
// A 1158 × 850 map (a 1440 × 900 window) and a phone's 390 × 722.
const DESK = { x: 1158, y: 850 };
const PHONE = { x: 390, y: 722 };
const degPerPx = (z) => 360 / (256 * 2 ** z);
// What is on screen, in degrees, around a centre.
const screenOf = (c, size, z) => {
  const dLng = (size.x / 2) * degPerPx(z);
  const dLat = (size.y / 2) * degPerPx(z) * Math.cos((c.lat * Math.PI) / 180);
  return [c.lat - dLat, c.lng - dLng, c.lat + dLat, c.lng + dLng];
};
const area = ([s, w, n, e]) => (n - s) * (e - w);
const pad = ([s, w, n, e], by) => [s - (n - s) * by, w - (e - w) * by, n + (n - s) * by, e + (e - w) * by];
const holds = (box, [s, w, n, e]) => box[0] <= s && box[1] <= w && box[2] >= n && box[3] >= e;

test('it asks for the screen and 15% more, never many screens’ worth', () => {
  for (const size of [DESK, PHONE]) {
    for (const z of [12, 13.25, 14, 15, 16, 17, 18, 19]) {
      for (const c of [{ lat: 49.1335, lng: -122.848 }, { lat: 49.19131, lng: -122.84907 }, { lat: 49.0312, lng: -122.7011 }]) {
        const box = viewBox(c, size, z);
        const screen = screenOf(c, size, z);
        assert.ok(holds(box, pad(screen, 0.15)), `zoom ${z}: the screen and 15% are inside ${box}`);
        const times = area(box) / area(screen);
        assert.ok(times < 2.7, `zoom ${z}: ${times.toFixed(2)} screens asked for (it was 8 to 11)`);
        assert.ok(box.every((v) => Number.isFinite(v) && String(v).length <= 10), `short numbers: ${box}`);
      }
    }
  }
});

test('a short pan asks for the same box; a screen’s worth of panning asks about four times', () => {
  const z = 16;
  const c = { lat: 49.1335, lng: -122.848 };
  const tall = (DESK.y * degPerPx(z) * Math.cos((49 * Math.PI) / 180));
  const boxes = new Set();
  for (let i = 0; i <= 80; i += 1) boxes.add(viewBox({ lat: c.lat + (tall * i) / 80, lng: c.lng }, DESK, z).join(','));
  assert.ok(boxes.size >= 4 && boxes.size <= 5, `${boxes.size} boxes over one screen of panning`);
  // Still on the same spot of the grid: the same box, so nothing is asked again.
  const a = viewBox({ lat: 49.13350, lng: -122.84800 }, DESK, z).join(',');
  const b = viewBox({ lat: 49.13351, lng: -122.84801 }, DESK, z).join(',');
  assert.equal(a, b);
});

test('how many people it takes whole: about 600 KB of them, more only at street level', () => {
  assert.deepEqual([DOT_ZOOM, LONE_PIN_ZOOM, PIN_ZOOM], [14, 17, 18]);
  for (const z of [14, 15, 16, 17, 17.75]) assert.equal(rowsBudget(z), 2400, `zoom ${z}`);
  for (const z of [18, 18.25, 19, 20]) assert.equal(rowsBudget(z), 8000, `zoom ${z}`);
});

// ── What is drawn, and what stays while an answer is on its way ──
test('what a big list draws: patches far out, doors as dots, the people where they fit — and nothing new until the answer is in', () => {
  const density = { cell: [0.001, 0.001], cells: [[49130, -122850, '', 3]] };
  // Far out: the patches, once they have arrived.
  assert.equal(drawnFor({ doors: false, view: null, density: null }), null, 'on its way: the map keeps what it had');
  assert.deepEqual(drawnFor({ doors: false, view: null, density }), { kind: 'density', density, cut: false });
  // Close in: the answer decides.
  assert.equal(drawnFor({ doors: true, view: null, density }), null, 'doors asked for, not here yet: the patches stay — never an empty map');
  const dots = { dots: [[49.13, -122.85, 0, 2]], signs: [], count: 2, truncated: false };
  assert.deepEqual(drawnFor({ doors: true, view: dots, density: null }), { kind: 'dots', view: dots });
  const rows = { persons: [{ id: 'p1' }], signs: [], count: 1, truncated: false };
  assert.deepEqual(drawnFor({ doors: true, view: rows, density: null }), { kind: 'rows', view: rows });
  // Too many doors even for dots: patches again, and it says so — once they are here.
  const cut = { persons: [], signs: [], truncated: true, count: 90000 };
  assert.equal(drawnFor({ doors: true, view: cut, density: null }), null);
  assert.deepEqual(drawnFor({ doors: true, view: cut, density }), { kind: 'density', density, cut: true });
});

test('a door answered as a dot: where it is, its band, how many people', () => {
  const d = dotsFrom([[49.13351, -122.84801, 0, 1], [49.1336, -122.8481, 1, 2], [49.1337, -122.8482, 2, 3], [49.1338, -122.8483, 3, 4]]);
  assert.deepEqual(d.map((x) => [x.band, x.n]), [['unrated', 1], ['undecided', 2], ['support', 3], ['opposed', 4]]);
  assert.deepEqual([d[0].lat, d[0].lng], [49.13351, -122.84801]);
  assert.deepEqual(dotsFrom(undefined), []);
  // Counted from what is on screen.
  const screen = [49.1335, -122.8482, 49.13365, -122.848];
  assert.deepEqual(d.filter((x) => inBox(screen, x)).map((x) => x.n), [1, 2]);
});

// ── Marks anyone can see ──
// WCAG contrast of a mark on the ground it sits on (3:1 is the least for a graphic).
const lum = ([r, g, b]) => {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const on = ([r, g, b, a = 1], ground) => [r, g, b].map((v, i) => v * a + ground[i] * (1 - a));
const contrast = (mark, ground) => {
  const [hi, lo] = [lum(on(mark, ground)), lum(ground)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// The grounds the research measured: CARTO's land, OpenStreetMap's land and
// its residential grey, and Leaflet's grey when no tile has come.
const LIGHT_GROUNDS = { clean: [250, 250, 248], standard: [242, 239, 233], residential: [224, 223, 223], noTiles: [221, 221, 221] };
const DARK_GROUND = [26, 28, 34];

test('“not asked yet” reads on every base map: 3 to 1 or better, from the smallest dot up', () => {
  for (const [name, ground] of Object.entries(LIGHT_GROUNDS)) {
    assert.ok(contrast(MARK.unrated.light, ground) >= 3, `not asked yet on ${name}: ${contrast(MARK.unrated.light, ground).toFixed(2)}`);
    // Undecided keeps its ochre (rating colours never change); its darker edge is what reads.
    assert.ok(contrast(MARK.undecidedEdge.light, ground) >= 3, `undecided’s edge on ${name}: ${contrast(MARK.undecidedEdge.light, ground).toFixed(2)}`);
  }
  assert.ok(contrast(MARK.unrated.dark, DARK_GROUND) >= 3);
  assert.ok(contrast(MARK.undecidedEdge.dark, DARK_GROUND) >= 3);
  assert.deepEqual([MARK.support, MARK.undecided, MARK.opposed], [[19, 138, 82], [232, 150, 12], [212, 60, 60]], 'the rating colours are what they were');
  // On screen, at the zoom the map is really at: it stops at quarter zooms,
  // where the nearest whole zoom's tiles are stretched or shrunk.
  for (let z = 8; z <= 20; z += 0.25) assert.ok(dotOnScreen(z) >= 2.5, `zoom ${z}: a dot of ${dotOnScreen(z).toFixed(2)} px`);
  assert.ok(Math.abs(dotOnScreen(12.5) - dotRadius(13) / Math.SQRT2) < 1e-9 && dotOnScreen(16) === dotRadius(16));
  assert.ok(dotRadius(17) > dotRadius(15) && dotRadius(15) > dotRadius(11));
  assert.deepEqual([13, 14, 15, 19].map(ringedAt), [false, true, true, true], 'a white ring on every dot from zoom 14');
  // A pin, a bubble's ring and the filter's dot wear the same slate, solid.
  for (const [name, ground] of Object.entries(LIGHT_GROUNDS)) {
    assert.ok(contrast(MARK.unratedPin, ground) >= 3, `a “not asked yet” pin on ${name}: ${contrast(MARK.unratedPin, ground).toFixed(2)}`);
  }
});

test('far out, a patch is darker the more people live there — the lightest still 3 to 1', () => {
  const [dlat, dlng] = cellOf(12, 49);
  // About 12 px a side at zoom 12: a block or two.
  const px = dlng / degPerPx(12);
  assert.ok(px > 11.9 && px < 12.1, `${px} px`);
  const cells = cellsFrom({ cell: [dlat, dlng], cells: [[1000, -2000, '', 1], [1000, -1999, '', 40], [1000, -1998, '', 400], [1001, -2000, '', 4000]] }, bandOf);
  assert.equal(cells.length, 4);
  const fills = cells.map((c) => cellFill(c, false));
  for (const [name, ground] of Object.entries(LIGHT_GROUNDS)) {
    assert.ok(contrast(fills[0], ground) >= 3, `one person in a patch, on ${name}: ${contrast(fills[0], ground).toFixed(2)}`);
    const steps = fills.map((f) => contrast(f, ground));
    assert.ok(steps[0] < steps[1] && steps[1] < steps[2] && steps[2] <= steps[3], `stronger with more people on ${name}: ${steps.map((s) => s.toFixed(1))}`);
  }
  // On the Dark look it runs the other way: more people, lighter.
  const night = cells.map((c) => contrast(cellFill(c, true), DARK_GROUND));
  assert.ok(night[0] >= 3 && night[0] < night[2], `${night.map((s) => s.toFixed(1))}`);
  // Each patch is a square of the map: its corners, to draw it edge to edge.
  const c = cells[0];
  assert.ok(Math.abs((c.n2 - c.s) - dlat) < 1e-9 && Math.abs((c.e - c.w) - dlng) < 1e-9 && c.lat > c.s && c.lat < c.n2 && c.lng > c.w && c.lng < c.e);
});

test('a patch takes the colour of support only as far as people there are rated', () => {
  const cell = cellOf(12, 49);
  const one = (rows) => cellsFrom({ cell, cells: rows.map(([r, n]) => [1000, -2000, r, n]) }, bandOf)[0];
  const hue = ([r, g, b]) => ({ green: g - Math.max(r, b), red: r - Math.max(g, b) });
  const fresh = cellFill(one([['', 200]]), false);
  const some = cellFill(one([['', 150], ['1', 50]]), false);
  const most = cellFill(one([['', 20], ['1', 100], ['2', 80]]), false);
  const against = cellFill(one([['', 20], ['4B', 180]]), false);
  assert.ok(Math.abs(hue(fresh).green) < 30 && hue(fresh).red < 0, `nobody asked: a clear neutral, not a rating colour (${fresh})`);
  assert.ok(hue(some).green > hue(fresh).green && hue(some).green < hue(most).green, `a quarter rated: a quarter of the way (${some})`);
  assert.ok(hue(most).green > 25, `mostly supporters: green (${most})`);
  assert.ok(hue(against).red > 40, `mostly opposed: red (${against})`);
  // Split between yes and no, it says neither loudly; and one answer doesn't colour a block.
  const split = cellFill(one([['', 20], ['1', 95], ['4B', 85]]), false);
  assert.ok(hue(split).green < hue(most).green && hue(split).red < hue(against).red, `half yes, half no (${split})`);
  const oneAnswer = cellFill(one([['', 3], ['4', 1]]), false);
  const fourAnswers = cellFill(one([['4', 4]]), false);
  assert.ok(hue(oneAnswer).red < 30 && hue(fourAnswers).red > 60, `one of four asked (${oneAnswer}) beside all four opposed (${fourAnswers})`);
  // The filter's own patches (only one rating kept) count only those people.
  const kept = cellsFrom({ cell, cells: [[1000, -2000, '', 150], [1000, -2000, '1', 50]] }, bandOf, (r) => r === '1');
  assert.deepEqual([kept[0].n, kept[0].rated, kept[0].band], [50, 50, 'support']);
});
