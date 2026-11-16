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
  tileHealth, TILE_WAIT_MS, checkLines, timeOfDay, placingPoll, retryLate, tileAt, streetMove, pickLook, tileHost, mapLooks,
  defaultLook, noticeTiles, sameBytes, frontTiles, NOTICE_CARTO, NOTICE_OTHER, PICTURE,
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

test('zoomed right out it still asks for a part of the Earth (the server refuses a latitude past a pole)', () => {
  for (const size of [DESK, PHONE]) {
    for (const z of [0, 1, 2, 3, 4, 5]) {
      const [s, w, n, e] = viewBox({ lat: 49.1335, lng: -122.848 }, size, z);
      assert.ok(s >= -90 && n <= 90 && s < n && w < e, `zoom ${z}: ${[s, w, n, e]}`);
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
// its residential grey, Leaflet's grey — and the app's paper, which is what
// now shows where no tile has come (map.css).
const LIGHT_GROUNDS = { clean: [250, 250, 248], standard: [242, 239, 233], residential: [224, 223, 223], leafletGrey: [221, 221, 221], paper: [232, 235, 243] };
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

// ── Is the street map loading? ──
test('the street map isn’t loading: most of a view’s tiles failed, or not one came in six seconds', () => {
  const h = tileHealth();
  assert.deepEqual(h.get(), { loaded: 0, failed: 0, down: false, why: null }, 'nothing asked for: nothing claimed');
  // A view's tiles all come.
  h.batch(0);
  for (let i = 0; i < 20; i += 1) h.tile(true);
  h.done();
  assert.deepEqual(h.get(), { loaded: 20, failed: 0, down: false, why: null });
  // The next view: the host refuses every one. Said once the view is done —
  // a few quick failures among slow tiles are not yet "most".
  h.batch(1000);
  for (let i = 0; i < 12; i += 1) h.tile(false);
  assert.equal(h.get().down, false);
  h.done();
  assert.deepEqual(h.get(), { loaded: 20, failed: 12, down: true, why: 'failing' }, 'counted since the layer was added; this view failed');
  // One tile in four failing (one of four hosts down): most came.
  h.batch(2000);
  for (let i = 0; i < 12; i += 1) h.tile(i % 4 !== 0);
  h.done();
  assert.equal(h.get().down, false, 'loading again');
  // A view with nothing new to ask for says nothing either way.
  h.batch(3000);
  h.done();
  assert.equal(h.get().down, false);

  // A host that never answers: six seconds and not one tile.
  const slow = tileHealth();
  slow.batch(0);
  slow.late(TILE_WAIT_MS - 1);
  assert.equal(slow.get().down, false, 'not before six seconds');
  slow.late(TILE_WAIT_MS);
  assert.equal(slow.get().down, true);
  // …and when its tiles come after all, it is loading.
  for (let i = 0; i < 6; i += 1) slow.tile(true);
  slow.done();
  assert.equal(slow.get().down, false);
  // Six seconds in with some here and none failed: still loading. With most of what has settled failed: not.
  const some = tileHealth();
  some.batch(0);
  some.tile(true);
  some.late(TILE_WAIT_MS + 5);
  assert.equal(some.get().down, false);
  some.tile(false);
  some.tile(false);
  some.late(TILE_WAIT_MS + 900);
  assert.equal(some.get().down, true, 'one tile hanging must not hide that the rest failed');
  // A view done in time: the six-second look has nothing to say.
  const quick = tileHealth();
  quick.batch(0);
  quick.tile(true);
  quick.done();
  quick.late(TILE_WAIT_MS + 5);
  assert.equal(quick.get().down, false);
  assert.equal(TILE_WAIT_MS, 6000);

  // The signal goes while a view is loading: three of its tiles come, the
  // rest never answer — so the view is never "done", and six seconds in
  // some had come and none had failed.
  const hung = tileHealth();
  hung.batch(0);
  for (let i = 0; i < 3; i += 1) hung.tile(true);
  hung.late(TILE_WAIT_MS + 5);
  assert.equal(hung.get().down, false);
  // The map is moved on, into streets where nothing answers: six seconds
  // there with tiles still out and not one street on screen (Map.jsx looks)
  // is the street map not loading, whatever came for the view before.
  hung.screen(0);
  assert.deepEqual(hung.get(), { loaded: 3, failed: 0, down: true, why: 'failing' });
  // Back over streets the phone kept, drawn: the next look takes it back
  // (the note goes by itself, as it does when the hosts refuse)…
  hung.screen(0.5);
  assert.equal(hung.get().down, false);
  // …and away again, it is said again; when they all answer after all, it is loading.
  hung.screen(0);
  assert.equal(hung.get().down, true);
  for (let i = 0; i < 9; i += 1) hung.tile(true);
  hung.done();
  assert.equal(hung.get().down, false);
  // With no tiles out (the view done), a blank screen says nothing about the provider.
  hung.screen(0);
  assert.equal(hung.get().down, false);
  // Streets on screen take back only what a look at the screen said: a view
  // most of whose tiles failed so far stays "not loading" over kept streets
  // (it is the view's own count, and ends with the view).
  const most = tileHealth();
  most.batch(0);
  most.tile(true);
  most.tile(false);
  most.tile(false);
  most.late(TILE_WAIT_MS + 5);
  assert.equal(most.get().down, true);
  most.screen(1);
  assert.equal(most.get().down, true);

  // A slow signal: six seconds and not one tile, so it isn't loading — then
  // they come, all but one that never answers (the view is never "done").
  // A look that finds most of the screen's streets drawn takes it back (the
  // note stood over streets drawn until the map's next whole view).
  const late = tileHealth();
  late.batch(0);
  late.late(TILE_WAIT_MS + 5);
  assert.equal(late.get().down, true);
  // (Streets on screen with none come since — the ones there before, beside
  // the new ones still out — take nothing back: the new ones aren't loading.)
  late.screen(0.6);
  assert.equal(late.get().down, true, 'nothing has come: still not loading');
  for (let i = 0; i < 11; i += 1) late.tile(true);
  late.screen(0.4);
  assert.equal(late.get().down, true, 'most of the screen is still bare');
  late.screen(11 / 12);
  assert.equal(late.get().down, false, 'most of the screen’s streets are drawn: loading');
  // …but not when most of what settled failed, whatever is on screen.
  const worse = tileHealth();
  worse.batch(0);
  worse.late(TILE_WAIT_MS + 5);
  worse.tile(true);
  worse.tile(false);
  worse.tile(false);
  worse.screen(1);
  assert.equal(worse.get().down, true);
});

// Before the map goes to its other provider by itself, it asks that one for
// one tile — the one under the middle of the view — and goes only if it
// answers (with weak signal neither answers, and going would leave the
// streets this phone kept undrawn).
test('one tile of a street map, the one under a point, its address filled in as the map fills it', () => {
  const osm = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const carto = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
  const hall = { lat: 49.1913, lng: -122.849 };
  assert.equal(tileAt(osm, hall, 15), 'https://tile.openstreetmap.org/15/5202/11226.png');
  assert.equal(tileAt(carto, hall, 15), 'https://a.basemaps.cartocdn.com/light_all/15/5202/11226.png');
  // A quarter zoom draws the nearest whole zoom's tiles; never past the provider's last zoom.
  assert.deepEqual([tileAt(osm, hall, 15.25), tileAt(osm, hall, 14.75)], [tileAt(osm, hall, 15), tileAt(osm, hall, 15)]);
  assert.equal(tileAt(osm, hall, 20.5, 19), 'https://tile.openstreetmap.org/19/83232/179626.png');
  // Round the world and past the poles: still a tile that exists.
  assert.equal(tileAt(osm, { lat: hall.lat, lng: hall.lng + 360 }, 15), tileAt(osm, hall, 15));
  assert.deepEqual([tileAt(osm, { lat: 85.5, lng: 179.9999 }, 3), tileAt(osm, { lat: -86, lng: -180 }, 3)],
    ['https://tile.openstreetmap.org/3/7/0.png', 'https://tile.openstreetmap.org/3/0/7.png']);
});

// What the map does when its street map isn't loading. The streets a phone
// keeps are those of the look the person picked: whatever the map does by
// itself, it must not leave them undrawn on a turf in weak signal.
test('the street map isn’t loading: the other provider is asked first, and a switch is offered only to one that answered', () => {
  const pick = { down: true, onAuto: false, other: true, switched: false };
  assert.equal(streetMove({ ...pick, down: false }), null, 'loading: nothing to do or say');
  // A provider down, the other fine: asked, then gone to once by itself.
  assert.equal(streetMove({ ...pick, asked: null }), 'ask');
  assert.equal(streetMove({ ...pick, asked: 'asking' }), null, 'nothing said while it is asked');
  assert.equal(streetMove({ ...pick, asked: 'yes' }), 'switch');
  // Weak signal: the other didn't answer either. Going to it would leave the
  // kept streets undrawn — so neither the map nor its one tap goes there.
  assert.equal(streetMove({ ...pick, asked: 'no' }), 'try-again', 'one tap to ask this one again, never “Try Muted”');
  // A campaign's own provider has no other.
  assert.equal(streetMove({ ...pick, other: false, asked: null }), 'try-again');
  // The map has gone somewhere by itself once already: the person's tap after that.
  assert.equal(streetMove({ ...pick, switched: true, asked: 'yes' }), 'try-other');
  assert.equal(streetMove({ ...pick, switched: true, asked: 'no' }), 'try-again');
});

test('on the look the map went to by itself, its streets not loading either is the signal: back to the person’s pick', () => {
  // A flicker let the other provider's one tile through; then the signal
  // went. The pick's streets are the ones this phone kept.
  assert.equal(streetMove({ down: true, onAuto: true, other: true, asked: null, switched: true }), 'back');
  assert.equal(streetMove({ down: true, onAuto: true, other: true, asked: 'yes', switched: true }), 'back', 'whatever was asked before');
  assert.equal(streetMove({ down: false, onAuto: true, other: true, asked: null, switched: true }), null, 'loading there: it stays');
});

// ── The map's check, for managers ──
const CHECK = {
  people: { total: 300052, onMap: 300049, waiting: 0, noAddress: 3 },
  area: { box: [49.002, -122.92, 49.222, -122.67], inside: 294037, outside: 6012 },
  turfs: 158,
  placing: { state: 'done', located: 150000, copied: 150049, missed: 0, errors: 0, lastError: null, retryAt: null, remaining: 0, unmatched: 0, jobs: true, off: false },
  tiles: { source: 'OpenStreetMap', custom: false, ignored: [], clean: true },
  build: 'index-NEWbuild2.js',
  commit: '04ab25f',
};
const PAGE = { build: 'index-NEWbuild2.js', look: 'Clean', tilesFrom: 'basemaps.cartocdn.com', tiles: { loaded: 24, failed: 0, down: false }, size: { x: 1158, y: 844 }, zoom: 12.25 };
const said = (lines) => Object.fromEntries(lines.map((l) => [l.key, l]));
const flagged = (lines) => lines.filter((l) => l.warn).map((l) => l.key).sort();

test('the map’s check: one line for each way a map can look empty; nothing flagged when nothing is wrong', () => {
  const lines = checkLines(CHECK, PAGE);
  assert.deepEqual(lines.map((l) => l.key), ['file', 'onmap', 'offmap', 'placing', 'area', 'turfs', 'tiles', 'build', 'screen']);
  const l = said(lines);
  assert.deepEqual([l.file.value, l.onmap.value, l.turfs.value], ['300,052', '300,049', '158'], 'numbers wear their separators');
  // Nobody is placed by guessing: no address, no pin — and counted.
  assert.equal(l.offmap.value, '3 — 3 with no address');
  assert.equal(l.placing.value, 'Nothing waiting');
  assert.equal(l.area.value, '6,012 of the 300,049 on the map');
  assert.equal(l.tiles.value, 'Clean · CARTO — 24 loaded, 0 failed');
  assert.deepEqual([l.build.value, l.build.note], ['Up to date', 'Version 04ab25f']);
  assert.equal(l.screen.value, '1,158 × 844 px · zoom 12.25');
  assert.deepEqual(flagged(lines), []);
});

test('…and each trouble is flagged in its own line, so one screenshot says which', () => {
  const clock = () => '3:40 pm';
  // An old page: the server hands out another build.
  let l = checkLines(CHECK, { ...PAGE, build: 'index-OLDbuild1.js' });
  assert.deepEqual([flagged(l), said(l).build.value], [['build'], 'Older than the server — reload it']);
  // No web build to compare (a server without one): said, not flagged.
  assert.deepEqual(flagged(checkLines({ ...CHECK, build: null }, PAGE)), []);
  assert.equal(said(checkLines({ ...CHECK, build: null }, PAGE)).build.value, 'Not compared');

  // Most of the list never placed, and nothing placing it.
  const unplaced = { ...CHECK, people: { total: 300052, onMap: 22424, waiting: 277625, noAddress: 3 }, placing: { ...CHECK.placing, state: 'idle', located: 0, copied: 0, remaining: 277625 } };
  l = checkLines(unplaced, PAGE);
  assert.deepEqual(flagged(l), ['offmap', 'placing']);
  assert.equal(said(l).offmap.value, '277,628 — 277,625 waiting for a pin, 3 with no address');
  assert.deepEqual([said(l).placing.value, said(l).placing.note], ['Not running', '277,625 addresses waiting — tap “Not on map”, then “Look up addresses”']);
  // The run going: its progress, not a trouble.
  l = checkLines({ ...unplaced, placing: { ...unplaced.placing, state: 'running', located: 12000, copied: 400, remaining: 137600 } }, PAGE);
  assert.equal(said(l).placing.value, 'Running · 12,400 of 150,000');
  assert.deepEqual(flagged(l), ['offmap']);
  // Paused because lookups aren't answering: why, and when it tries again by itself.
  l = checkLines({ ...unplaced, placing: { ...unplaced.placing, state: 'paused', lastError: 'geocoder 503', retryAt: '2026-11-10T23:40:00.000Z' } }, PAGE, { clock, now: Date.parse('2026-11-10T23:25:00.000Z') });
  assert.deepEqual([said(l).placing.value, said(l).placing.note, said(l).placing.warn], ['Paused — tries again at 3:40 pm', 'Address lookup isn’t answering (geocoder 503)', true]);
  // (The time is a time of day on the reader's own clock, whatever the day.)
  const at = new Date(2026, 10, 11, 0, 5);
  assert.deepEqual([timeOfDay(at.toISOString()), timeOfDay(new Date(2026, 10, 10, 15, 40).toISOString()), timeOfDay('nonsense')], ['12:05 am', '3:40 pm', '']);
  // Stopped by someone; lookups turned off; no background jobs on this server.
  assert.equal(said(checkLines({ ...unplaced, placing: { ...unplaced.placing, state: 'stopped' } }, PAGE)).placing.value, 'Stopped');
  l = checkLines({ ...unplaced, placing: { ...unplaced.placing, off: true } }, PAGE);
  assert.deepEqual([said(l).placing.value, said(l).placing.warn], ['Turned off', true]);
  assert.match(said(checkLines({ ...unplaced, placing: { ...unplaced.placing, jobs: false } }, PAGE)).placing.note, /background jobs are off on this server/);
  // A handful that couldn't be matched is said, and is no alarm on a list of 300,000.
  l = checkLines({ ...CHECK, people: { ...CHECK.people, waiting: 12 }, placing: { ...CHECK.placing, unmatched: 12 } }, PAGE);
  assert.deepEqual([flagged(l), said(l).placing.note], [[], '12 couldn’t be matched — they need a pin by hand']);

  // The street map isn't loading.
  l = checkLines(CHECK, { ...PAGE, look: 'Muted', tilesFrom: 'tile.openstreetmap.org', tiles: { loaded: 0, failed: 18, down: true } });
  assert.deepEqual([flagged(l), said(l).tiles.value], [['tiles'], 'Muted · OpenStreetMap — isn’t loading: 0 loaded, 18 failed']);
  // A campaign's own provider is named by its host (never its whole address); the server's own tiles by what the server says they are.
  assert.match(said(checkLines({ ...CHECK, tiles: { ...CHECK.tiles, source: 'tiles.example', custom: true } }, { ...PAGE, look: 'Muted', tilesFrom: 'tiles.example' })).tiles.value, /^Muted · tiles\.example — /);
  // Stadia (STARBASE_TILE_PROVIDER=stadia) by its name, as Going live §5 says.
  assert.match(said(checkLines({ ...CHECK, tiles: { ...CHECK.tiles, source: 'Stadia Maps', custom: true } }, { ...PAGE, look: 'Standard', tilesFrom: 'tiles.stadiamaps.com' })).tiles.value, /^Standard · Stadia Maps — /);
  assert.match(said(checkLines({ ...CHECK, tiles: { ...CHECK.tiles, source: 'Google Maps', custom: true } }, { ...PAGE, look: 'Standard', tilesFrom: '' })).tiles.value, /^Standard · Google Maps — /);
  // A street map address the server ignored is said on the same line.
  assert.match(said(checkLines({ ...CHECK, tiles: { ...CHECK.tiles, ignored: ['url'] } }, PAGE)).tiles.note, /was ignored/);

  // Most of the list lives outside the area the campaign is set to.
  l = checkLines({ ...CHECK, area: { ...CHECK.area, inside: 9000, outside: 291049 } }, PAGE);
  assert.deepEqual(flagged(l), ['area']);
  // A map with no room on screen (a browser that gave it no height).
  l = checkLines(CHECK, { ...PAGE, size: { x: 390, y: 0 } });
  assert.deepEqual([flagged(l), said(l).screen.value], [['screen'], '390 × 0 px · zoom 12.25']);
});

test('a paused run long past its time to try again — that try never ran — says so, and is looked at now and then', () => {
  const at = '2026-11-10T23:40:00.000Z';
  const t = Date.parse(at);
  // Before its time the map looks just after it; a minute past, still looking for it…
  assert.equal(placingPoll({ state: 'paused', retryAt: at }, t - 10 * 60_000), 60_000);
  assert.equal(placingPoll({ state: 'paused', retryAt: at }, t - 30_000), 31_500);
  assert.equal(placingPoll({ state: 'paused', retryAt: at }, t + 20_000), 2000);
  // …long past it, now and then — every open desk map asked every 2 seconds.
  assert.equal(placingPoll({ state: 'paused', retryAt: at }, t + 2 * 60_000), 30_000);
  assert.deepEqual([placingPoll({ state: 'running' }, t), placingPoll({ state: 'paused', retryAt: null }, t), placingPoll(null, t)], [4000, 30_000, 30_000]);
  assert.deepEqual([retryLate(at, t + 59_000), retryLate(at, t + 61_000), retryLate(null, t), retryLate('nonsense', t)], [false, true, false, false]);
  // The check says when it was due, and what to do — not a time gone by as if to come.
  const clock = () => '3:40 pm';
  const paused = { ...CHECK, people: { total: 300052, onMap: 22424, waiting: 277625, noAddress: 3 },
    placing: { ...CHECK.placing, state: 'paused', located: 0, copied: 0, lastError: 'geocoder 503', retryAt: at, remaining: 277625 } };
  let l = said(checkLines(paused, PAGE, { clock, now: t + 2 * 3600_000 }));
  assert.deepEqual([l.placing.value, l.placing.note, l.placing.warn],
    ['Paused — was due to try again at 3:40 pm', 'Address lookup isn’t answering (geocoder 503) — its try didn’t run: tap “Not on map”, then “Try now”', true]);
  // With no background jobs on this server nothing will try by itself: said so.
  l = said(checkLines({ ...paused, placing: { ...paused.placing, jobs: false } }, PAGE, { clock, now: t - 60_000 }));
  assert.equal(l.placing.value, 'Paused');
  assert.match(l.placing.note, /background jobs are off on this server/);
});

// ── Google failing: the free map, never a pick ──
const G = '/tiles/{z}/{x}/{y}.png';
const GVIEWS = [
  { key: 'satellite', label: 'Satellite', url: `${G}?t=satellite` },
  { key: 'terrain', label: 'Terrain', url: `${G}?t=terrain` },
  { key: 'free', label: 'Free map', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', fallback: true },
];
const MUTED = { key: 'muted', label: 'Muted' };

test('with Google on, a saved Clean, no pick or an old Free map pick draws Google; the free map is what it turns to', () => {
  for (const viewPick of ['clean', undefined, 'free', 'muted']) {
    const r = pickLook({ views: GVIEWS, viewPick, baseUrl: G, muted: MUTED });
    assert.equal(r.providerView, null, `${viewPick}: Google’s own tiles are drawn`);
    assert.equal(r.otherLook?.key, 'free', `${viewPick}: the free map is the other look`);
  }
  // Satellite picked: Satellite drawn, the free map behind it too.
  const sat = pickLook({ views: GVIEWS, viewPick: 'satellite', baseUrl: G, muted: MUTED });
  assert.deepEqual([sat.providerView.key, sat.otherLook.key], ['satellite', 'free']);
  // Gone there by itself: the free map is drawn (and on it, no other).
  const auto = pickLook({ views: GVIEWS, viewPick: 'clean', drawnAuto: 'free', baseUrl: G, muted: MUTED });
  assert.deepEqual([auto.providerView.key, auto.otherLook], ['free', null]);
  // Without the free map (STARBASE_TILE_CLEAN=off): Google has no other look, as before.
  assert.equal(pickLook({ views: GVIEWS.slice(0, 2), viewPick: 'clean', baseUrl: G, muted: MUTED }).otherLook, null);
});

test('on the free tiles, as before: Clean ↔ Muted over OpenStreetMap; a campaign’s own provider has no other', () => {
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const CLEAN = { key: 'clean', label: 'Clean', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' };
  const onClean = pickLook({ views: [CLEAN], viewPick: 'clean', baseUrl: OSM, muted: MUTED });
  assert.deepEqual([onClean.providerView.key, onClean.otherLook.key], ['clean', 'muted']);
  const onMuted = pickLook({ views: [CLEAN], viewPick: 'muted', baseUrl: OSM, muted: MUTED });
  assert.deepEqual([onMuted.providerView, onMuted.otherLook.key], [null, 'clean']);
  assert.deepEqual(pickLook({ views: [], viewPick: 'clean', baseUrl: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png', muted: MUTED }),
    { providerView: null, otherLook: null, shadeAllowed: true, look: 'clean' });
  assert.equal(tileHost('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'), 'basemaps.cartocdn.com');
  assert.equal(tileHost(G), '');
});

test('the services behind the map: one line each, after the street map — waiting, working, not working with Google’s words and the step', () => {
  const clock = () => '3:40 pm';
  const now = Date.parse('2026-11-10T23:45:00.000Z');
  const keys = (l) => l.map((x) => x.key);
  // Not asked (an old caller): no service lines.
  assert.ok(!keys(checkLines(CHECK, PAGE)).includes('tilesvc'));
  // While it waits on Google, after it failed, with no signal.
  for (const [state, words] of [['pending', 'Checking…'], ['offline', 'No signal — the check needs it']]) {
    const l = checkLines(CHECK, PAGE, { services: { state } });
    assert.deepEqual(keys(l).slice(6, 9), ['tiles', 'tilesvc', 'lookupsvc']);
    assert.deepEqual([said(l).tilesvc.value, said(l).lookupsvc.value, flagged(l)], [words, words, []]);
    assert.deepEqual(l.filter((x) => x.key.endsWith('svc')).map((x) => x.label), ['Street map service', 'Map pins']);
  }
  // The read failed: flagged, and says the one way to ask again.
  const failed = checkLines(CHECK, PAGE, { services: { state: 'error' } });
  assert.deepEqual([said(failed).tilesvc.value, flagged(failed)], ['Unavailable — tap Check again', ['lookupsvc', 'tilesvc']]);
  const GOOD = { tiles: { provider: 'Google Maps', viaServer: true, probe: { ok: true }, last: null, lastOkAt: '2026-11-10T23:44:00.000Z' },
    lookup: { provider: 'BC Address Geocoder', fallback: null, probe: { ok: true } } };
  let l = checkLines(CHECK, PAGE, { clock, now, services: { state: 'ok', data: GOOD } });
  assert.deepEqual([said(l).tilesvc.value, said(l).tilesvc.note, said(l).lookupsvc.value, flagged(l)], ['Working · Google Maps', null, 'Working · BC Address Geocoder', []]);
  // Billing off: flagged, plain words, Google's own, and the step.
  const billing = { ok: false, code: 'billing', plain: 'Billing isn’t turned on for this Google Cloud project.', said: 'This API method requires billing to be enabled.', fix: 'Recipe B step 2' };
  l = checkLines(CHECK, PAGE, { clock, now, services: { state: 'ok', data: { ...GOOD, tiles: { ...GOOD.tiles, probe: billing } } } });
  assert.deepEqual(flagged(l), ['tilesvc']);
  assert.equal(said(l).tilesvc.value, 'Not working · Google Maps');
  assert.equal(said(l).tilesvc.note, 'Billing isn’t turned on for this Google Cloud project.\nGoogle said: “This API method requires billing to be enabled.”\nSee Going live §5, Recipe B step 2.');
  // Working now, but it failed under an hour ago: when, and why.
  const last = { at: '2026-11-10T23:40:00.000Z', plain: billing.plain };
  l = checkLines(CHECK, PAGE, { clock, now, services: { state: 'ok', data: { ...GOOD, tiles: { ...GOOD.tiles, last } } } });
  assert.deepEqual([said(l).tilesvc.value, said(l).tilesvc.note, said(l).tilesvc.warn], ['Working · Google Maps', `Failed at 3:40 pm: ${billing.plain}`, false]);
  l = checkLines(CHECK, PAGE, { clock, now: now + 2 * 3_600_000, services: { state: 'ok', data: { ...GOOD, tiles: { ...GOOD.tiles, last } } } });
  assert.equal(said(l).tilesvc.note, null, 'an hour on, no longer said');
  // A provider the phones reach straight: named, nothing asked.
  const STADIA = { ...PAGE, look: 'Standard', tilesFrom: 'tiles.stadiamaps.com' };
  l = checkLines(CHECK, STADIA, { services: { state: 'ok', data: { ...GOOD, tiles: { provider: 'Stadia Maps', viaServer: false, probe: null, last: null } } } });
  assert.deepEqual([said(l).tilesvc.value, said(l).tilesvc.warn], ['Stadia Maps · straight to the phones', false]);
  // The free default, drawn by CARTO's Clean look: the line names CARTO, as
  // the Street map line does — and is flagged with it when it isn't loading.
  const FREE = { ...GOOD, tiles: { provider: 'OpenStreetMap', viaServer: false, probe: null, last: null } };
  l = checkLines(CHECK, PAGE, { services: { state: 'ok', data: FREE } });
  assert.deepEqual([said(l).tilesvc.value, said(l).tilesvc.warn], ['CARTO (Clean) · straight to the phones', false]);
  l = checkLines(CHECK, { ...PAGE, tiles: { loaded: 0, failed: 9, down: true } }, { services: { state: 'ok', data: FREE } });
  assert.deepEqual(flagged(l), ['tiles', 'tilesvc']);
  // A Google or provider setting the map couldn't use: flagged, with what to set.
  l = checkLines({ ...CHECK, tiles: { ...CHECK.tiles, ignored: ['google', 'provider'] } }, PAGE, { services: { state: 'ok', data: FREE } });
  assert.deepEqual([said(l).tilesvc.warn, said(l).tilesvc.note], [true, 'GOOGLE_MAPS_TILES can’t be used — set it to 1, with GOOGLE_MAPS_SERVER_KEY\nSTARBASE_TILE_PROVIDER isn’t known — use stadia']);
  // Address lookup: the B.C. service busy (no Google words), Google's refused, or turned off.
  const busy = { ok: false, code: 'busy', plain: 'The B.C. address service is busy. It tries again by itself; a BC_GEOCODER_KEY raises the limit.', said: '', fix: null };
  l = checkLines(CHECK, PAGE, { services: { state: 'ok', data: { ...GOOD, lookup: { ...GOOD.lookup, probe: busy } } } });
  assert.deepEqual([said(l).lookupsvc.value, said(l).lookupsvc.note, flagged(l)], ['Not working · BC Address Geocoder', busy.plain, ['lookupsvc']]);
  l = checkLines(CHECK, PAGE, { services: { state: 'ok', data: { ...GOOD, lookup: { provider: 'off', fallback: null, probe: { ok: false, code: 'off' } } } } });
  assert.deepEqual([said(l).lookupsvc.value, flagged(l)], ['Turned off', []]);
  // Address suggestions: absent from an older server's answer; B.C.'s; Google
  // Places working; paused after Google refused (its words and the step).
  assert.ok(!keys(checkLines(CHECK, PAGE, { services: { state: 'ok', data: GOOD } })).includes('suggestsvc'));
  l = checkLines(CHECK, PAGE, { services: { state: 'ok', data: { ...GOOD, suggest: { provider: 'BC Address Geocoder', probe: { ok: true }, paused: null } } } });
  assert.ok(!keys(l).includes('suggestsvc'), 'the service that places the pins suggests too: one line says it');
  l = checkLines(CHECK, PAGE, { services: { state: 'ok', data: { ...GOOD, suggest: { provider: 'off', probe: null, paused: null } } } });
  assert.deepEqual([said(l).suggestsvc.label, said(l).suggestsvc.value, flagged(l)], ['Address suggestions', 'Turned off', []]);
  l = checkLines(CHECK, PAGE, { services: { state: 'ok', data: { ...GOOD, suggest: { provider: 'Google Places', probe: { ok: true, example: '13450 104 Ave' }, paused: null } } } });
  assert.equal(said(l).suggestsvc.value, 'Working · Google Places');
  const blocked = { code: 'api-blocked', plain: 'This key isn’t allowed to use that Google API. Add Map Tiles API and Places API (New) to it.', said: 'Requests to this API are blocked.', fix: 'Recipe B step 4' };
  l = checkLines(CHECK, PAGE, { services: { state: 'ok', data: { ...GOOD, suggest: { provider: 'Google Places', probe: { ok: true }, paused: blocked } } } });
  assert.deepEqual([said(l).suggestsvc.value, flagged(l)], ['Not working · Google Places', ['suggestsvc']]);
  assert.match(said(l).suggestsvc.note, /Places API \(New\)[\s\S]*Google said: “Requests to this API are blocked\.”[\s\S]*Recipe B step 4/);
  // The placing run, paused on Google's refusal, says it in plain words.
  const paused = { ...CHECK, placing: { ...CHECK.placing, state: 'paused', remaining: 5, retryAt: null,
    lastError: 'geocoder referrer: This key only works from websites. The server needs a key without a website restriction. · Google said: REQUEST_DENIED' } };
  assert.equal(said(checkLines(paused, PAGE)).placing.note, 'Address lookup isn’t answering (This key only works from websites. The server needs a key without a website restriction. · Google said: REQUEST_DENIED)');
  // Google's usage limit, the likeliest pause: plain words first too (the "429" stays on the server, for its backoff).
  const quota = { ...paused, placing: { ...paused.placing, lastError: 'geocoder 429 quota: Google’s usage limit is used up for now. · Google said: RESOURCE_EXHAUSTED' } };
  assert.equal(said(checkLines(quota, PAGE)).placing.note, 'Address lookup isn’t answering (Google’s usage limit is used up for now. · Google said: RESOURCE_EXHAUSTED)');
});

// ── No filters over Google's tiles; Show → Map always has the way back ──
const SHADES = [{ key: 'standard', label: 'Standard' }, { key: 'muted', label: 'Muted' }, { key: 'dark', label: 'Dark' }];

test('a Google look drawn: no Muted or Dark, and a saved Clean, Muted or Dark draws the standard look; the free map allows them again', () => {
  for (const viewPick of ['clean', 'muted', 'dark']) {
    const r = pickLook({ views: GVIEWS, viewPick, baseUrl: G, muted: MUTED });
    assert.deepEqual([r.shadeAllowed, r.look], [false, 'standard'], viewPick);
  }
  const sat = pickLook({ views: GVIEWS, viewPick: 'satellite', baseUrl: G, muted: MUTED });
  assert.deepEqual([sat.shadeAllowed, sat.look], [false, 'satellite']);
  // Gone to the free map by itself: shades allowed, the saved pick kept.
  const free = pickLook({ views: GVIEWS, viewPick: 'muted', drawnAuto: 'free', baseUrl: G, muted: MUTED });
  assert.deepEqual([free.shadeAllowed, free.look], [true, 'muted']);
});

test('Show → Map over Google: Streets · Satellite · Terrain (roadmap), Satellite · Streets · Terrain (satellite); the shades otherwise', () => {
  const words = (l) => l.map((v) => v.label).join(' · ');
  assert.equal(words(mapLooks({ shades: SHADES, views: GVIEWS, standardLabel: 'Streets', shadeAllowed: false })), 'Streets · Satellite · Terrain');
  const satViews = [
    { key: 'roadmap', label: 'Streets', url: `${G}?t=roadmap` },
    { key: 'terrain', label: 'Terrain', url: `${G}?t=terrain` },
    GVIEWS[2],
  ];
  const sat = mapLooks({ shades: SHADES, views: satViews, standardLabel: 'Satellite', shadeAllowed: false });
  assert.equal(words(sat), 'Satellite · Streets · Terrain');
  assert.deepEqual(sat.map((v) => v.key), ['standard', 'roadmap', 'terrain'], 'Streets comes from views: the way back to the street map');
  const CLEAN = { key: 'clean', label: 'Clean', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' };
  assert.equal(words(mapLooks({ shades: SHADES, views: [CLEAN], standardLabel: null, shadeAllowed: true })), 'Standard · Muted · Dark · Clean');
});

// ── A street map that loads and shows no streets (a provider's notice) ──
test('a notice, once found, stays for the layer whatever its tiles do after; without one, nothing changes', () => {
  const h = tileHealth();
  h.batch(0);
  for (let i = 0; i < 20; i += 1) h.tile(true);
  h.done();
  assert.deepEqual(h.get(), { loaded: 20, failed: 0, down: false, why: null });
  h.notice();
  assert.deepEqual(h.get(), { loaded: 20, failed: 0, down: true, why: 'notice' });
  // Every later tile good, views done, looks at the screen: still a notice.
  h.batch(1000);
  for (let i = 0; i < 20; i += 1) h.tile(true);
  h.done();
  h.late(1000 + TILE_WAIT_MS);
  h.screen(1);
  assert.deepEqual([h.get().down, h.get().why], [true, 'notice']);
  // A fresh layer starts afresh.
  assert.deepEqual(tileHealth().get(), { loaded: 0, failed: 0, down: false, why: null });
});

test('the look the map opens on: Clean only where it is offered (not as a fallback), else Standard; a saved pick is kept', () => {
  const CLEAN = { key: 'clean', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=k' };
  assert.equal(defaultLook([CLEAN]), 'clean');
  assert.equal(defaultLook([]), 'standard');
  assert.equal(defaultLook(undefined), 'standard');
  assert.equal(defaultLook([{ ...CLEAN, fallback: true }]), 'standard');
  assert.equal(defaultLook([{ key: 'free', url: 'x', fallback: true }]), 'standard');
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const MUTED = { key: 'muted', label: 'Muted' };
  // A saved Clean with none offered: Map.jsx draws Standard for any look
  // that is neither a provider's nor a shade; pickLook passes it through.
  const saved = pickLook({ views: [], viewPick: 'clean', baseUrl: OSM, muted: MUTED });
  assert.deepEqual([saved.providerView, saved.look], [null, 'clean']);
  assert.equal(pickLook({ views: [], viewPick: 'muted', baseUrl: OSM, muted: MUTED }).look, 'muted');
  assert.equal(pickLook({ views: [], viewPick: defaultLook([]), baseUrl: OSM, muted: MUTED }).look, 'standard');
});

test('two tiles of one place far apart in zoom; bytes compared, true or false only', () => {
  const at = { lat: 49.19, lng: -122.85 };
  const [far, near] = noticeTiles('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=k', at, 20);
  assert.match(far, /^https:\/\/a\.basemaps\.cartocdn\.com\/light_all\/3\/1\/2\.png\?key=k$/);
  assert.match(near, /^https:\/\/a\.basemaps\.cartocdn\.com\/light_all\/15\/\d+\/\d+\.png\?key=k$/);
  assert.equal(near, tileAt('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=k', at, 15, 20));
  const [f2, n2] = noticeTiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png', at);
  assert.deepEqual([f2.split('/')[3], n2.split('/')[3]], ['3', '15']);
  const buf = (a) => new Uint8Array(a).buffer;
  assert.equal(sameBytes(buf([1, 2, 3]), buf([1, 2, 3])), true);
  assert.equal(sameBytes(buf([1, 2, 3]), buf([1, 2, 4])), false);
  assert.equal(sameBytes(buf([1, 2, 3]), buf([1, 2])), false);
  assert.equal(sameBytes(null, buf([1])), false);
});

test('the map’s check names a notice, flags its service line, and carries the picture of what this phone gets', () => {
  const FREE = { tiles: { provider: 'OpenStreetMap', viaServer: false, probe: null, last: null }, lookup: { provider: 'BC Address Geocoder', fallback: null, probe: { ok: true } }, suggest: { provider: 'BC Address Geocoder', probe: { ok: true }, paused: null } };
  const pic = 'https://a.basemaps.cartocdn.com/light_all/12/650/1403.png?key=k';
  const page = { ...PAGE, tiles: { loaded: 24, failed: 0, down: true, why: 'notice' }, picture: pic };
  const l = checkLines(CHECK, page, { services: { state: 'ok', data: FREE } });
  const t = said(l).tiles;
  assert.deepEqual([t.value, t.note, t.warn], ['Clean · CARTO — sends a notice, not streets', NOTICE_CARTO, true]);
  assert.match(NOTICE_CARTO, /STARBASE_TILE_CARTO_KEY in Render, or STARBASE_TILE_CLEAN=off/);
  assert.deepEqual(t.picture, { src: pic, label: 'What this phone gets for the middle of the map:', alt: 'A piece of the street map, as this phone gets it', failed: 'No picture came back.', small: false });
  assert.equal(PICTURE.failed, 'No picture came back.');
  assert.deepEqual([said(l).tilesvc.value, said(l).tilesvc.warn], ['CARTO (Clean) · straight to the phones', true], 'its service line flagged too');
  // Another provider's notice: the other note.
  const other = said(checkLines({ ...CHECK, tiles: { ...CHECK.tiles, source: 'tiles.example', custom: true } }, { ...page, look: 'Standard', tilesFrom: 'tiles.example' })).tiles;
  assert.deepEqual([other.value, other.note], ['Standard · tiles.example — sends a notice, not streets', NOTICE_OTHER]);
  assert.match(NOTICE_OTHER, /The picture is below\.$/);
  // Streets: the line as before, still with its picture.
  const ok = said(checkLines(CHECK, { ...PAGE, picture: pic })).tiles;
  assert.deepEqual([ok.value, ok.warn, ok.picture.src, ok.picture.small], ['Clean · CARTO — 24 loaded, 0 failed', false, pic, true], 'nothing wrong: a small one (the check stays one screen)');
  assert.equal(said(checkLines(CHECK, PAGE)).tiles.picture, undefined, 'no map yet: no picture');
  // An operator's keyless CARTO address: said where the service is named.
  const keyless = checkLines({ ...CHECK, tiles: { ...CHECK.tiles, ignored: ['carto-key'] } }, PAGE, { services: { state: 'ok', data: FREE } });
  assert.match(said(keyless).tilesvc.note, /CARTO needs a key now \(STARBASE_TILE_CARTO_KEY\)/);
});

test('the front page’s map: the Map’s own look, shade and all — never Google’s tiles, the free map instead', () => {
  const osm = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: 'OSM', maxZoom: 19 };
  const clean = { key: 'clean', label: 'Clean', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=k', attribution: 'CARTO', maxZoom: 20 };
  const google = { url: '/api/tiles/{z}/{x}/{y}?t=roadmap', attribution: 'Google', maxZoom: 21 };
  const sat = { key: 'satellite', label: 'Satellite', url: '/api/tiles/{z}/{x}/{y}?t=satellite', attribution: 'Google', maxZoom: 21 };
  const free = { key: 'free', label: 'Free map', url: osm.url, attribution: 'OSM', maxZoom: 19, fallback: true };
  // No Clean offered: Standard on OpenStreetMap; a saved Clean draws it too.
  assert.deepEqual(frontTiles({ views: [], baseTiles: osm }), { ...osm, shade: null });
  assert.deepEqual(frontTiles({ views: [], baseTiles: osm, savedPick: 'clean' }), { ...osm, shade: null });
  assert.equal(frontTiles({ views: [], baseTiles: osm, savedPick: 'muted' }).shade, 'muted');
  // Clean with the key: opens on it.
  assert.equal(frontTiles({ views: [clean], baseTiles: osm }).url, clean.url);
  assert.equal(frontTiles({ views: [clean], baseTiles: osm, savedPick: 'standard' }).url, osm.url);
  // Google as the map: the free map, its own credit, whatever the pick.
  for (const savedPick of [null, 'standard', 'satellite', 'dark']) {
    const t = frontTiles({ views: [sat, free], baseTiles: google, savedPick });
    assert.deepEqual([t.url, t.attribution], [osm.url, 'OSM'], String(savedPick));
  }
  assert.equal(frontTiles({ views: [sat, free], baseTiles: google, savedPick: 'dark' }).shade, 'dark');
  // Nothing to draw yet.
  assert.equal(frontTiles({ views: [], baseTiles: null }), null);
  assert.equal(frontTiles({ views: [], baseTiles: google }), null);
});
