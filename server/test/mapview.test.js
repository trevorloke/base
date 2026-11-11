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
  tileHealth, TILE_WAIT_MS, checkLines, timeOfDay, placingPoll, retryLate,
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
  assert.deepEqual(h.get(), { loaded: 0, failed: 0, down: false }, 'nothing asked for: nothing claimed');
  // A view's tiles all come.
  h.batch(0);
  for (let i = 0; i < 20; i += 1) h.tile(true);
  h.done();
  assert.deepEqual(h.get(), { loaded: 20, failed: 0, down: false });
  // The next view: the host refuses every one. Said once the view is done —
  // a few quick failures among slow tiles are not yet "most".
  h.batch(1000);
  for (let i = 0; i < 12; i += 1) h.tile(false);
  assert.equal(h.get().down, false);
  h.done();
  assert.deepEqual(h.get(), { loaded: 20, failed: 12, down: true }, 'counted since the layer was added; this view failed');
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
