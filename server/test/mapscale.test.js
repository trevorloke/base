// A city-wide list on the map. Up to STARBASE_MAP_ALL located people the map
// loads them all (never cut off part way, as the old 5,000 limit did — by
// address, so a whole voter file showed only the "10…" streets). Past it the
// map asks by the part in view (?bbox): the server counts first, and a view
// over the cap (8,000 people, or the page's own ?rows=) answers
// { truncated, count } with no rows; ?dots=1 answers one lean row per door
// ([lat, lng, band, people]) so every door can be a dot long before its
// people are loaded; ?person=<id> answers that person's door wherever it is.
// From further out it is a count per patch (/map/density), by rating. The
// map opens on the campaign's own list (strays elsewhere don't zoom it out).
// Turfs count only the people inside their own corners; ?outline=1 leaves
// the counts out (the map draws the outlines at once) and /turfs/:id counts
// one. A volunteer kept to their turfs gets those doors, however big the list.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';

let mgr, vol, volId, db, ws;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
// 10 × 6 = 60 people on a grid around Newton, every third rated 1, every
// fifth rated 4.
const GRID = [];
for (let i = 0; i < 10; i += 1) for (let j = 0; j < 6; j += 1) GRID.push({ lat: 49.10 + i * 0.001, lng: -122.85 + j * 0.001, n: i * 6 + j });

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Map scale', jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = await mgr.action('member.invite', { email: 'walker.scale@example.org', role: 'volunteer' });
  vol = new Client();
  volId = ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Walker Example', password: 'walker-pass-1' })).user.id;
  for (const g of GRID) {
    await db.query(
      `insert into persons (id, workspace_id, name, address, lat, lng, rating) values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), ws, `Voter ${g.n} Example`, `${1000 + g.n} Example St`, g.lat, g.lng, g.n % 3 === 0 ? '1' : g.n % 5 === 0 ? '4' : null],
    );
  }
  // One with an address and no place on the map yet.
  await db.query(`insert into persons (id, workspace_id, name, address) values ($1, $2, 'Unplaced Example', '1 Nowhere St')`, [randomUUID(), ws]);
});

test('a list under the limit loads whole, every person (no cut-off by address)', async () => {
  process.env.STARBASE_MAP_ALL = '100';
  const j = ok(await mgr.get('/api/map/doors'));
  assert.equal(j.persons.length, 60);
  assert.equal(j.total, 60);
  assert.equal(j.unlocated, 1, 'the one with an address and no place is counted, not lost');
  assert.ok(!j.big);
});

test('a bigger list: the map is told to ask by view; the view gets everyone in it', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const whole = ok(await mgr.get('/api/map/doors'));
  assert.deepEqual([whole.big, whole.total, whole.persons.length, whole.unlocated], [true, 60, 0, 1]);
  const [bs, bw, bn, be] = whole.bounds;
  assert.ok(bs >= 49.0999 && bn <= 49.1091 && bw >= -122.8501 && be <= -122.8449 && bs < bn && bw < be, `where they live: ${whole.bounds}`);
  // The south-west corner: rows 0–4, columns 0–2 → 15 people.
  const view = ok(await mgr.get('/api/map/doors?bbox=49.0995,-122.8505,49.1045,-122.8475'));
  assert.equal(view.scope, 'view');
  assert.equal(view.persons.length, 15);
  assert.equal(view.truncated, false);
  assert.equal((await mgr.get('/api/map/doors?bbox=nonsense')).json.big, true, 'a bad box is ignored, not an error');
});

test('from further out: a count per patch, by rating, adding up to everyone in view', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const d = ok(await mgr.get('/api/map/density?bbox=49.09,-122.86,49.12,-122.84&cell=0.005,0.005'));
  const total = d.cells.reduce((n, c) => n + c[3], 0);
  assert.equal(total, 60);
  const by = (r) => d.cells.filter((c) => c[2] === r).reduce((n, c) => n + c[3], 0);
  assert.deepEqual([by('1'), by('4'), by('')], [20, 8, 32], 'rated 1, rated 4 (not also 1), not yet rated');
  const coarse = ok(await mgr.get('/api/map/density?bbox=49,-123,50,-122&cell=0.00001,0.00001'));
  assert.ok(coarse.cell[0] > 0.00001 && (1 / coarse.cell[0]) * (1 / coarse.cell[1]) <= 150000, `too fine for the area: coarsened to ${coarse.cell}`);
  assert.equal(coarse.cells.reduce((n, c) => n + c[3], 0), 60, '…and still everyone');
  assert.equal((await mgr.get('/api/map/density')).status, 400);
});

test('over the cap, a view is counted first and answers with no rows', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const prev = process.env.STARBASE_MAP_VIEW;
  // 60 people on the grid; the box covers all of them; a cap of 10 (test setting).
  process.env.STARBASE_MAP_VIEW = '10';
  const v = ok(await mgr.get('/api/map/doors?bbox=49.0995,-122.8505,49.1095,-122.8445'));
  if (prev === undefined) delete process.env.STARBASE_MAP_VIEW; else process.env.STARBASE_MAP_VIEW = prev;
  assert.equal(v.truncated, true);
  assert.equal(v.count, 60, 'how many are there');
  assert.deepEqual(v.persons, [], 'nobody is read, sent and thrown away');
  // The page's own budget (?rows=), never more than the server's cap.
  const tight = ok(await mgr.get('/api/map/doors?bbox=49.0995,-122.8505,49.1095,-122.8445&rows=59'));
  assert.deepEqual([tight.truncated, tight.count, tight.persons.length], [true, 60, 0]);
  const roomy = ok(await mgr.get('/api/map/doors?bbox=49.0995,-122.8505,49.1095,-122.8445&rows=60'));
  assert.deepEqual([roomy.truncated, roomy.count, roomy.persons.length], [false, 60, 60]);
});

test('a sign asked for before its person had a pin shows at their door', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const pid = (await db.query("select id from persons where workspace_id = $1 and name = 'Voter 0 Example'", [ws])).rows[0].id;
  await db.query(`insert into signs (id, workspace_id, person_id, address, kind, status) values ($1, $2, $3, '1000 Example St', 'lawn', 'requested')`, [randomUUID(), ws, pid]);
  const v = ok(await mgr.get('/api/map/doors?bbox=49.0995,-122.8505,49.1005,-122.8495'));
  assert.ok(v.signs.some((s) => s.person_id === pid), 'found by its person’s pin');
});

test('turfs count only the people inside them', async () => {
  // Rows 0–1 (lat 49.100–49.101), every column: 12 people.
  const polygon = [[49.0995, -122.8505], [49.0995, -122.8445], [49.1015, -122.8445], [49.1015, -122.8505]];
  const turf = ok(await mgr.action('turf.create', { name: 'Two rows', polygon })).turf;
  const t = ok(await mgr.get('/api/turfs')).turfs.find((x) => x.id === turf.id);
  assert.equal(t.people, 12);
  assert.equal(t.doors, 12);
  const walk = ok(await mgr.get(`/api/turfs/${turf.id}/walk`));
  assert.equal(walk.doors.length, 12);
  ok(await mgr.action('turf.assign', { turf_id: turf.id, user_id: volId }));
});

test('a volunteer kept to their turfs gets those doors, however big the list; no city-wide counts', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  ok(await mgr.action('permission.doors.set', { scope: 'turfs' }));
  const j = ok(await vol.get('/api/map/doors'));
  assert.equal(j.scope, 'turfs');
  assert.equal(j.persons.length, 12);
  assert.equal((await vol.get('/api/map/density?bbox=49.09,-122.86,49.12,-122.84&cell=0.005,0.005')).status, 403);
  ok(await mgr.action('permission.doors.set', { scope: 'all' }));
  const all = ok(await vol.get('/api/map/doors'));
  assert.equal(all.big, true, 'every door again: the rest asked by view, like the desk');
  assert.equal(all.persons.length, 12, 'their own turf comes whole (kept on the phone for no signal)');
  assert.equal(ok(await mgr.get('/api/map/doors')).persons.length, 0, 'the desk: all by view');
  delete process.env.STARBASE_MAP_ALL;
});

// ── Every door a dot, long before its people are loaded ──
const BOX = '49.0995,-122.8505,49.1095,-122.8445'; // the whole grid
const spot = (n) => GRID.find((g) => g.n === n);
const near = (dots, g) => dots.find((x) => Math.abs(x[0] - g.lat) < 1e-6 && Math.abs(x[1] - g.lng) < 1e-6);

test('?dots=1: one lean row per door — [lat, lng, band, people] — with the household’s band', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  // Two more at Voter 1's door (nobody there asked yet): one undecided, one
  // for Locke — the door reads opposed. One more at Voter 2's: undecided.
  for (const [name, n, rating] of [['Housemate A Example', 1, '3'], ['Housemate B Example', 1, '4B'], ['Housemate C Example', 2, '3']]) {
    await db.query(
      `insert into persons (id, workspace_id, name, address, lat, lng, rating) values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), ws, name, `${1000 + n} Example St`, spot(n).lat, spot(n).lng, rating],
    );
  }
  const d = ok(await mgr.get(`/api/map/doors?bbox=${BOX}&dots=1`));
  assert.equal(d.scope, 'view');
  assert.equal(d.persons, undefined, 'no names, phones or ids in a dots answer');
  assert.equal(d.dots.length, 60, 'one per door');
  assert.equal(d.count, 63, 'the people in the box');
  assert.equal(d.dots.reduce((n, x) => n + x[3], 0), 63, 'people add up');
  // band: 0 not asked yet · 1 undecided · 2 support · 3 opposed (any opposed
  // beats support beats undecided, as a pin's colour does).
  assert.deepEqual(near(d.dots, spot(1)).slice(2), [3, 3], 'opposed, 3 people');
  assert.deepEqual(near(d.dots, spot(2)).slice(2), [1, 2], 'undecided, 2 people');
  assert.deepEqual(near(d.dots, spot(0)).slice(2), [2, 1], 'rated 1: support');
  assert.deepEqual(near(d.dots, spot(5)).slice(2), [3, 1], 'rated 4: opposed');
  assert.deepEqual(near(d.dots, spot(7)).slice(2), [0, 1], 'not asked yet');
  assert.ok(d.dots.every((x) => x.length === 4 && String(x[0]).length <= 8 && String(x[1]).length <= 10), 'short numbers: a metre is enough');
  // Only the doors where someone has one rating (the map's "Strong yes (1)").
  const ones = ok(await mgr.get(`/api/map/doors?bbox=${BOX}&dots=1&rating=1`));
  assert.deepEqual([ones.dots.length, ones.dots.every((x) => x[2] === 2 && x[3] === 1)], [20, true]);
});

test('too many doors for dots: counted, said, and none sent', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  process.env.STARBASE_MAP_DOTS = '59';
  const cut = ok(await mgr.get(`/api/map/doors?bbox=${BOX}&dots=1`));
  process.env.STARBASE_MAP_DOTS = '60';
  const fits = ok(await mgr.get(`/api/map/doors?bbox=${BOX}&dots=1`));
  delete process.env.STARBASE_MAP_DOTS;
  assert.deepEqual([cut.truncated, cut.count, cut.dots], [true, 63, undefined]);
  assert.deepEqual([fits.truncated, fits.dots.length], [false, 60]);
});

test('?dots=1&rows=N: the people themselves where they fit, dots where they don’t', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  // The south-west corner: rows 0–4, columns 0–2 → 15 doors, 18 people.
  const corner = '49.0995,-122.8505,49.1045,-122.8475';
  const rows = ok(await mgr.get(`/api/map/doors?bbox=${corner}&dots=1&rows=18`));
  assert.deepEqual([rows.persons.length, rows.dots, rows.truncated, rows.count], [18, undefined, false, 18]);
  const dots = ok(await mgr.get(`/api/map/doors?bbox=${corner}&dots=1&rows=17`));
  assert.deepEqual([dots.persons, dots.dots.length, dots.truncated, dots.count], [undefined, 15, false, 18]);
});

test('?person=<id>: that door and everyone at it, wherever it is', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const idOf = async (name) => (await db.query('select id from persons where workspace_id = $1 and name = $2', [ws, name])).rows[0].id;
  const d = ok(await mgr.get(`/api/map/doors?person=${await idOf('Housemate B Example')}`));
  assert.equal(d.scope, 'door');
  assert.deepEqual(d.persons.map((p) => p.name).sort(), ['Housemate A Example', 'Housemate B Example', 'Voter 1 Example']);
  // Voter 0's door comes with its sign.
  const v0 = ok(await mgr.get(`/api/map/doors?person=${await idOf('Voter 0 Example')}`));
  assert.deepEqual([v0.persons.length, v0.signs.length], [1, 1]);
  // No pin, nobody, or not an id: no door (the map then offers to place them, or says not found).
  for (const id of [await idOf('Unplaced Example'), randomUUID(), 'nonsense']) {
    assert.deepEqual(ok(await mgr.get(`/api/map/doors?person=${id}`)).persons, [], id);
  }
});

test('the map opens on the campaign’s own list: strays elsewhere don’t zoom it out', async () => {
  process.env.STARBASE_MAP_ALL = '20';
  const prev = process.env.STARBASE_GEO_BOUNDS;
  // Two people whose address on file is in Prince George: 3% of the list.
  for (const n of [1, 2]) {
    await db.query(`insert into persons (id, workspace_id, name, address, lat, lng) values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), ws, `Away ${n} Example`, `${n} Far St`, 53.91 + n / 1000, -122.75]);
  }
  // Most are inside the campaign's box (Surrey's, unless set): where those people are.
  delete process.env.STARBASE_GEO_BOUNDS;
  const area = ok(await mgr.get('/api/map/doors'));
  // A campaign whose box is somewhere else: the middle of the list (5th–95th percentile).
  process.env.STARBASE_GEO_BOUNDS = '50.6,-120.5|50.8,-120.2';
  const spread = ok(await mgr.get('/api/map/doors'));
  if (prev === undefined) delete process.env.STARBASE_GEO_BOUNDS; else process.env.STARBASE_GEO_BOUNDS = prev;
  const fits = ([s, w, n, e]) => s >= 49.0999 && n <= 49.1091 && w >= -122.8501 && e <= -122.8449 && s < n && w < e;
  assert.deepEqual([area.total, area.fit], [65, 'area']);
  assert.ok(fits(area.bounds), `the list inside the campaign’s box: ${area.bounds}`);
  assert.equal(spread.fit, 'spread');
  assert.ok(fits(spread.bounds), `the middle of the list: ${spread.bounds}`);
  // A small list says where to open too (the same strays would zoom it out to the province).
  delete process.env.STARBASE_MAP_ALL;
  const small = ok(await mgr.get('/api/map/doors'));
  assert.deepEqual([small.big, small.persons.length, small.fit], [undefined, 65, 'area']);
  assert.ok(fits(small.bounds), `${small.bounds}`);
});

test('turf outlines come without counts; one turf’s counts on their own', async () => {
  const t = ok(await mgr.get('/api/turfs')).turfs.find((x) => x.name === 'Two rows');
  assert.deepEqual([t.people, t.doors], [15, 12]);
  // The map draws every outline at once: names, shapes and who walks them — nobody inside is read.
  const o = ok(await mgr.get('/api/turfs?outline=1')).turfs.find((x) => x.id === t.id);
  assert.deepEqual([o.name, o.polygon, o.members.map((m) => m.id)], [t.name, t.polygon, [volId]]);
  assert.deepEqual([o.doors, o.people, o.doorsDone, o.rated], [undefined, undefined, undefined, undefined]);
  // Its counts, when its sheet opens.
  const one = ok(await mgr.get(`/api/turfs/${t.id}`)).turf;
  assert.deepEqual([one.id, one.doors, one.people, one.doorsDone, one.rated, one.members.length], [t.id, t.doors, t.people, t.doorsDone, t.rated, 1]);
  // A volunteer's own turfs come whole either way (a few, kept on the phone for no signal).
  const mine = ok(await vol.get('/api/turfs?outline=1')).turfs;
  assert.deepEqual([mine.length, mine[0].doors, mine[0].people], [1, 12, 15]);
  assert.equal(ok(await vol.get(`/api/turfs/${t.id}`)).turf.people, 15);
  // …and a turf that isn't theirs is not theirs to count.
  const other = ok(await mgr.action('turf.create', { name: 'Not theirs', polygon: [[49.2, -122.8], [49.2, -122.79], [49.21, -122.79]] })).turf;
  assert.equal((await vol.get(`/api/turfs/${other.id}`)).status, 403);
  assert.equal((await mgr.get('/api/turfs/not-an-id')).status, 404);
  assert.equal((await mgr.get(`/api/turfs/${randomUUID()}`)).status, 404);
});

test('a city cut into turfs: the outlines read nobody, however many turfs there are', async () => {
  // Forty more turfs in a grid over the list — a campaign that has cut its whole city up.
  for (let i = 0; i < 40; i += 1) {
    const s = 49.0995 + (i % 10) * 0.001;
    const w = -122.8505 + Math.floor(i / 10) * 0.0015;
    ok(await mgr.action('turf.create', { name: `Grid ${i + 1}`, polygon: [[s, w], [s, w + 0.0015], [s + 0.001, w + 0.0015], [s + 0.001, w]] }));
  }
  // What each answer reads from the database.
  const asked = [];
  const real = db.query;
  db.query = (sql, ...rest) => { asked.push(String(sql)); return real.call(db, sql, ...rest); };
  let outline; let whole; let outlineAsked; let wholeAsked;
  try {
    outline = ok(await mgr.get('/api/turfs?outline=1'));
    outlineAsked = asked.splice(0);
    whole = ok(await mgr.get('/api/turfs'));
    wholeAsked = asked.splice(0);
  } finally {
    db.query = real;
  }
  const ofPeople = (list) => list.filter((q) => /\bfrom persons\b/.test(q)).length;
  const n = whole.turfs.length;
  assert.ok(n > 40 && outline.turfs.length === n, `${outline.turfs.length} outlines of ${n} turfs`);
  assert.equal(ofPeople(outlineAsked), 0, 'the outlines: not one read of the people');
  assert.ok(ofPeople(wholeAsked) >= n, `every turf counted reads the people inside it: ${ofPeople(wholeAsked)} reads`);
  assert.ok(outlineAsked.length < wholeAsked.length - 40, `${outlineAsked.length} queries for the outlines, ${wholeAsked.length} with every count`);
  // The same names, shapes and canvassers either way…
  const shape = (t) => [t.id, t.name, t.polygon, t.members];
  assert.deepEqual(outline.turfs.map(shape), whole.turfs.map(shape));
  // …and a turf's counts, asked for on their own, are the ones the whole answer gives.
  const counts = (t) => [t.doors, t.people, t.doorsDone, t.doorsAgain, t.rated];
  for (const name of ['Grid 1', 'Grid 17', 'Two rows']) {
    const t = whole.turfs.find((x) => x.name === name);
    assert.deepEqual(counts(ok(await mgr.get(`/api/turfs/${t.id}`)).turf), counts(t), name);
  }
  assert.ok(whole.turfs.find((x) => x.name === 'Grid 1').people > 0);
});
