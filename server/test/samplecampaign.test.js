// Staging's sample campaign (lib/samplecampaign.js): everyone in it is made
// up; it is made on an empty database, made again by itself when a release
// carries a newer SAMPLE_VERSION, and only ever over the demo account's own
// sample (G1 to G6 in the file's header); a new reset word starts it over;
// production never.
//
// Every case starts from nothing (wipe): under test:pg the file's cases
// share one database. The staging block's values are set before the server
// is loaded (shared/scale.js reads the opponents when it loads; the test
// helper sets Imagine Surrey's brand when none is set).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stagingBlock, SAMPLE_PRINT, printNow } from './sample-prints.js';
import { findReal } from './real-names.js';
import * as CAST from '../lib/samplecast.js';

const BLOCK = stagingBlock();
delete BLOCK.NODE_ENV;
Object.assign(process.env, BLOCK);
const { freshDb, Client } = await import('./helpers.js');
const { app } = await import('../index.js');
const { bootstrap } = await import('../db/schema.js');
const { createSession, SESSION_COOKIE } = await import('../lib/auth.js');
const { seedSample, samplePeople, pinFor, demoOwnsIt, sampleMaking, SAMPLE_VERSION, AREAS } = await import('../lib/samplecampaign.js');

const DEMO = BLOCK.STARBASE_DEMO_EMAIL;
const KEYS = ['STARBASE_ENV', 'STARBASE_SAMPLE', 'STARBASE_SAMPLE_RESET', 'STARBASE_DEMO_EMAIL', 'STARBASE_OPEN_SIGNUP', 'STARBASE_BRAND'];
let kept; let db;
const wipe = async () => {
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await db.query('drop schema if exists sample_meta cascade');
  await bootstrap(db);
};
beforeEach(async () => {
  kept = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const k of KEYS) if (BLOCK[k] !== undefined) process.env[k] = BLOCK[k];
  db = await freshDb();
  await wipe();
});
afterEach(() => { for (const k of KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; } });
const count = async (table) => Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);
const made = async () => (await db.query('select version, state, email, attempts from sample_meta.made where id = 1')).rows[0] || null;
const instance = async () => (await db.query('select instance from platform_identity where id = 1')).rows[0].instance;
const logs = () => { const lines = []; const log = (l) => lines.push(l); log.lines = lines; return log; };
const quiet = () => {};
const N = 8; // a small sample: the decisions are what is tested here
const enter = async () => {
  const r = await app.request('/api/auth/demo');
  assert.equal(r.status, 302);
  const c = new Client();
  c.cookie = r.headers.get('set-cookie').split(';')[0];
  return c;
};
// Somebody else's campaign, made the way a stranger would make it.
const strangersCampaign = async (email = 'someone@example.org') => {
  const wanted = process.env.STARBASE_SAMPLE;
  delete process.env.STARBASE_SAMPLE;
  process.env.STARBASE_OPEN_SIGNUP = '1';
  const c = new Client();
  const r = await c.signup({ email, workspaceName: 'Not The Sample' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  delete process.env.STARBASE_OPEN_SIGNUP;
  process.env.STARBASE_SAMPLE = wanted;
  return c;
};
// An app that fails where told to, for the cases where a make goes wrong.
const appThat = (fail) => ({ request: (path, init) => fail(path, init) ?? app.request(path, init) });

// ── Everyone in it is made up ──

test('the people: the cast’s surnames, 99xx house numbers on the 20 streets, made-up phones and emails', () => {
  const people = samplePeople(320);
  assert.deepEqual(samplePeople(320), people, 'the same sample every time');
  const streets = AREAS.flatMap((a) => a.streets);
  assert.equal(streets.length, 20);
  const ADDRESS = new RegExp(`^99\\d\\d (${streets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
  assert.equal(CAST.SURNAMES.length, 30);
  for (const p of people) {
    assert.ok(CAST.SURNAMES.includes(p.last_name), p.last_name);
    assert.ok(CAST.FIRST_NAMES.includes(p.first_name), p.first_name);
    assert.match(p.address, ADDRESS);
    assert.ok(AREAS.find((a) => a.name === p.area).streets.includes(p.address.slice(5)), `${p.address} is in ${p.area}`);
    assert.equal(p.city, 'Vancouver');
    for (const k of ['postal', 'unit', 'socials']) assert.equal(p[k], undefined, k);
    if (p.phone !== null) assert.match(p.phone, /^604-555-01\d\d$/);
    if (p.email !== null) assert.match(p.email, /@example\.org$/);
  }
});

test('each pin is inside its neighbourhood, and one address is one pin', () => {
  const at = new Map();
  for (const p of samplePeople(320)) {
    const [s, w, n, e] = AREAS.find((a) => a.name === p.area).box;
    assert.ok(p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e, `${p.address} is inside ${p.area}`);
    const pin = `${p.lat},${p.lng}`;
    if (at.has(p.address)) assert.equal(pin, at.get(p.address), `${p.address}: a household is one dot`);
    at.set(p.address, pin);
  }
});

test('every street has one straight piece of its centreline inside its neighbourhood', () => {
  const streets = AREAS.flatMap((a) => a.streets);
  assert.deepEqual(Object.keys(CAST.SEGMENTS).sort(), [...streets].sort(), 'one piece for each of the 20 streets, and no other');
  const metres = ([y1, x1], [y2, x2]) => Math.hypot((x2 - x1) * 111320 * Math.cos((y1 * Math.PI) / 180), (y2 - y1) * 110540);
  for (const a of AREAS) {
    const [s, w, n, e] = a.box;
    for (const street of a.streets) {
      const seg = CAST.SEGMENTS[street];
      assert.equal(seg.length, 2, street);
      for (const [lat, lng] of seg) assert.ok(lat >= s && lat <= n && lng >= w && lng <= e, `${street}: an end outside ${a.name}`);
      assert.ok(metres(...seg) >= 300, `${street}: at least 300 m, so the dots spread out`);
    }
  }
});

test('each pin is on its street’s piece of centreline', () => {
  for (const a of AREAS) for (const street of a.streets) assert.ok(CAST.SEGMENTS[street], `${street}: no segment`);
  for (const p of samplePeople(320)) {
    const [[y1, x1], [y2, x2]] = CAST.SEGMENTS[p.address.slice(5)];
    const f = (Number(p.address.slice(0, 4)) - 9900) / 100;
    assert.ok(Math.abs(p.lat - (y1 + f * (y2 - y1))) < 1e-6 && Math.abs(p.lng - (x1 + f * (x2 - x1))) < 1e-6, p.address);
  }
  assert.deepEqual(pinFor(AREAS[0], 9900, AREAS[0].streets[0]), pinFor(AREAS[0], 9900, AREAS[0].streets[0]));
  // The ends of the range: 9900 is the piece's first end, 9999 just short of its other.
  const [[a, b], [c, d]] = CAST.SEGMENTS['Main St'];
  assert.deepEqual(pinFor(AREAS[0], 9900, 'Main St'), { lat: a, lng: b });
  const last = pinFor(AREAS[0], 9999, 'Main St');
  assert.ok(Math.abs(last.lat - (a + 0.99 * (c - a))) < 1e-6 && Math.abs(last.lng - (b + 0.99 * (d - b))) < 1e-6);
});

test('nothing seeded is a real name: the people, the cast, the shifts', () => {
  const everything = JSON.stringify({ people: samplePeople(320), cast: CAST, block: BLOCK });
  assert.deepEqual(findReal(everything), []);
  assert.equal(CAST.OPPONENTS_LINE, BLOCK.STARBASE_CANDIDATES, 'render.yaml sets the cast’s opponents');
});

test('the print: a change to the sample raises SAMPLE_VERSION', async () => {
  const why = 'the sample changed: raise SAMPLE_VERSION and record the new print with it (server/test/sample-prints.js)';
  assert.equal(await printNow(), SAMPLE_PRINT.print, why);
  assert.ok(SAMPLE_VERSION >= SAMPLE_PRINT.version, why);
  assert.equal(SAMPLE_VERSION, 3);
});

// ── Made, and made again ──

test('an empty database with no sample_meta at all: made, and recorded', async () => {
  const got = await seedSample(app, quiet, N);
  assert.deepEqual([got.people, got.turfs, got.shifts, got.failed], [N, 4, 5, 0]);
  assert.ok(got.knocks > 0);
  assert.equal(await count('persons'), N);
  assert.deepEqual(await made(), { version: SAMPLE_VERSION, state: 'made', email: DEMO, attempts: 0 });
  assert.equal(await seedSample(app, quiet, N), null, 'the usual start: nothing more');
  assert.equal(await count('persons'), N);
});

test('today’s staging (the first sample, no record) is made again, keeping the server’s instance', async () => {
  // The first sample: made before there was a record of it.
  assert.ok(await seedSample(app, quiet, N));
  await db.query('drop schema sample_meta cascade');
  const visitor = await enter();
  assert.ok((await visitor.createPerson('Left Behind')).id);
  const was = await instance();
  const got = await seedSample(app, quiet, N);
  assert.equal(got.people, N);
  assert.equal(await count('persons'), N);
  assert.equal((await db.query("select count(*) as n from persons where name = 'Left Behind'")).rows[0].n, 0);
  assert.equal(await instance(), was);
  assert.deepEqual(await made(), { version: SAMPLE_VERSION, state: 'made', email: DEMO, attempts: 0 });
});

test('an older version over the demo’s own campaign: made again; the instance and the control centre’s entries stay', async () => {
  assert.ok(await seedSample(app, quiet, N));
  const visitor = await enter();
  assert.ok((await visitor.createPerson('Left Behind')).id);
  const ws = (await db.query('select id from workspaces')).rows[0].id;
  const user = (await db.query('select id from users where email = $1', [DEMO])).rows[0].id;
  await db.query(
    `insert into operator_entries (nonce, operator_id, kid, workspace_id, user_id, iat, exp)
     values ('n-1', 'op-1', 'k-1', $1, $2, now(), now() + interval '1 hour'), ('n-old', 'op-1', 'k-1', $1, $2, now() - interval '2 days', now() - interval '1 day')`,
    [ws, user],
  );
  await db.query('update sample_meta.made set version = $1', [SAMPLE_VERSION - 1]);
  const was = await instance();
  const log = logs();
  assert.equal((await seedSample(app, log, N)).people, N);
  assert.equal(await count('persons'), N, 'the visitor’s person is gone');
  assert.equal((await db.query("select count(*) as n from persons where name = 'Left Behind'")).rows[0].n, 0);
  assert.equal(await count('workspaces'), 1);
  assert.equal(await instance(), was, 'the control centre still knows the server');
  assert.deepEqual((await db.query('select nonce, workspace_id, user_id from operator_entries')).rows, [{ nonce: 'n-1', workspace_id: null, user_id: null }]);
  assert.deepEqual(await made(), { version: SAMPLE_VERSION, state: 'made', email: DEMO, attempts: 0 });
  // The visitor's old sign-in is gone with the old sample.
  assert.equal((await visitor.get('/api/auth/me')).status, 401);
});

test('the same version: nothing; the same version for another demo email: made again as the new account', async () => {
  assert.ok(await seedSample(app, quiet, N));
  const visitor = await enter();
  await visitor.createPerson('Left Behind');
  assert.equal(await seedSample(app, quiet, N), null);
  assert.equal(await count('persons'), N + 1);

  process.env.STARBASE_DEMO_EMAIL = 'new-demo@base.win';
  assert.equal((await seedSample(app, quiet, N)).people, N);
  assert.equal(await count('persons'), N);
  assert.deepEqual(await made(), { version: SAMPLE_VERSION, state: 'made', email: 'new-demo@base.win', attempts: 0 });
  assert.ok(await demoOwnsIt(db, 'new-demo@base.win'));
  assert.equal((await db.query('select count(*) as n from users where email = $1', [DEMO])).rows[0].n, 0);
});

test('a higher recorded version (a roll-back): nothing over a campaign; made on an empty database', async () => {
  assert.ok(await seedSample(app, quiet, N));
  await db.query('update sample_meta.made set version = $1', [SAMPLE_VERSION + 1]);
  const log = logs();
  assert.equal(await seedSample(app, log, N), null);
  assert.equal(await count('workspaces'), 1);
  assert.match(log.lines.join('\n'), /newer than this release/);

  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await bootstrap(db);
  assert.equal((await seedSample(app, quiet, N)).people, N, 'an empty sample server always makes the sample');
});

test('G5: somebody else’s first campaign, or two campaigns: nothing dropped, and the log says what to do', async () => {
  const stranger = await strangersCampaign();
  await stranger.createPerson('Their Person');
  let log = logs();
  assert.equal(await seedSample(app, log, N), null);
  assert.equal(await count('persons'), 1);
  assert.match(log.lines.join('\n'), /this database’s first campaign is not the demo account’s, so nothing was dropped\. To start over, set STARBASE_SAMPLE_RESET to a new word\./);
  assert.equal(await made(), null, 'seen before anything is claimed');

  await wipe();
  assert.ok(await seedSample(app, quiet, N));
  await db.query('update sample_meta.made set version = 1');
  await strangersCampaign('second@example.org');
  log = logs();
  assert.equal(await seedSample(app, log, N), null);
  assert.equal(await count('workspaces'), 2);
  assert.equal(await count('persons'), N);
  assert.match(log.lines.join('\n'), /nothing was dropped/);
  assert.deepEqual(await made(), { version: 1, state: 'made', email: DEMO, attempts: 0 }, 'seen before anything is claimed');
});

test('G5 checked again under sign-up’s lock: a campaign made after the decision is never dropped', async () => {
  // Decision "make" (empty database); then, before the sample's sign-up,
  // the control centre's first entry makes a campaign.
  const sneak = appThat((path, init) => {
    if (path !== '/api/auth/signup') return null;
    return (async () => {
      await db.query(`insert into users (id, email, name, password_hash) values ('00000000-0000-4000-8000-000000000001', 'support@example.org', 'Support', 'none')`);
      await db.query(`insert into workspaces (id, name, slug, jurisdiction, settings) values ('00000000-0000-4000-8000-000000000002', 'Entered', 'entered', 'bc-municipal', '{}')`);
      await db.query(`insert into memberships (user_id, workspace_id, role) values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'manager')`);
      return app.request(path, init);
    })();
  });
  const log = logs();
  assert.equal(await seedSample(sneak, log, N), null);
  assert.equal(await count('workspaces'), 1);
  assert.equal((await db.query('select name from workspaces')).rows[0].name, 'Entered');
  assert.equal((await made()).state, 'failed');
  // And the next start does not drop it either: it is not the demo's.
  assert.equal(await seedSample(app, quiet, N), null);
  assert.equal((await db.query('select name from workspaces')).rows[0].name, 'Entered');
});

test('G5 checked again under sign-up’s lock: a campaign that appears after the decision to make it again stops the drop', async () => {
  assert.ok(await seedSample(app, quiet, N));
  await db.query('update sample_meta.made set version = 1');
  const beforeDrop = async () => { await strangersCampaign('late@example.org'); };
  const log = logs();
  assert.equal(await seedSample(app, log, N, { beforeDrop }), null);
  assert.equal(await count('workspaces'), 2);
  assert.equal(await count('persons'), N);
  assert.match(log.lines.join('\n'), /nothing was dropped/);
  assert.equal((await made()).state, 'failed');
});

test('G6: a make under way (1 minute old) is left to it, with one timer to look again; one 11 minutes old has died, and is made again', async () => {
  assert.ok(await seedSample(app, quiet, N));
  await db.query("update sample_meta.made set state = 'making', version = 1, at = now() - interval '1 minute'");
  const timers = [];
  const later = (fn, ms) => { timers.push(ms); return null; };
  assert.equal(await seedSample(app, quiet, N, { later }), null);
  assert.equal(timers.length, 1);
  assert.ok(timers[0] > 9 * 60_000 - 2_000 && timers[0] <= 9 * 60_000 + 5_000, `${timers[0]} ms`);
  assert.equal(await sampleMaking(db), true);

  await db.query("update sample_meta.made set at = now() - interval '11 minutes'");
  assert.equal(await sampleMaking(db), false);
  assert.equal((await seedSample(app, quiet, N, { later })).people, N);
  assert.equal(timers.length, 1);
  assert.equal((await made()).state, 'made');
});

test('two starts at once: only the one that wins the claim makes it', async () => {
  const [a, b] = await Promise.all([seedSample(app, quiet, N), seedSample(app, quiet, N)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(await count('workspaces'), 1);
  assert.equal(await count('persons'), N);
});

test('two starts at once over an older sample: only the one that wins the claim drops it and makes it again', async () => {
  assert.ok(await seedSample(app, quiet, N));
  await db.query('update sample_meta.made set version = 1');
  const lines = logs();
  const [a, b] = await Promise.all([seedSample(app, lines, N), seedSample(app, lines, N)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(lines.lines.filter((l) => /the old sample was dropped/.test(l)).length, 1, 'dropped once');
  assert.equal(await count('workspaces'), 1);
  assert.equal(await count('persons'), N);
  assert.equal((await made()).state, 'made');
});

test('a make that throws is "failed", made again at the next start, and left alone after three tries', async () => {
  const boom = appThat((path) => (path === '/api/actions/turf.create' ? Promise.reject(new Error('boom')) : null));
  assert.equal(await seedSample(boom, quiet, N), null);
  assert.deepEqual(await made(), { version: SAMPLE_VERSION, state: 'failed', email: DEMO, attempts: 1 });
  assert.equal((await seedSample(app, quiet, N)).people, N, 'made again at the next start');
  assert.deepEqual(await made(), { version: SAMPLE_VERSION, state: 'made', email: DEMO, attempts: 0 });

  await wipe();
  for (let i = 1; i <= 3; i++) {
    assert.equal(await seedSample(boom, quiet, N), null);
    assert.deepEqual([(await made()).state, (await made()).attempts], ['failed', i]);
  }
  const log = logs();
  assert.equal(await seedSample(app, log, N), null);
  assert.match(log.lines.join('\n'), new RegExp(`sample: version ${SAMPLE_VERSION} could not be made in 3 tries`));
  assert.equal((await made()).attempts, 3);
});

test('one failed step: "made", and not made again at the next start', async () => {
  let once = true;
  const oneFails = appThat((path) => {
    if (path !== '/api/actions/shift.create' || !once) return null;
    once = false;
    return Promise.resolve(new Response(JSON.stringify({ error: 'no' }), { status: 400, headers: { 'content-type': 'application/json' } }));
  });
  const got = await seedSample(oneFails, quiet, N);
  assert.equal(got.failed, 1);
  assert.equal(got.shifts, 4);
  assert.deepEqual(await made(), { version: SAMPLE_VERSION, state: 'made', email: DEMO, attempts: 0 });
  assert.equal(await seedSample(app, quiet, N), null);
});

test('a new reset word starts it over; the same word again does nothing', async () => {
  assert.ok(await seedSample(app, quiet, N));
  const visitor = await enter();
  await visitor.createPerson('Left Behind');
  process.env.STARBASE_SAMPLE_RESET = 'first';
  assert.equal((await seedSample(app, quiet, N)).people, N);
  assert.equal(await count('persons'), N);
  assert.equal(await count('workspaces'), 1);
  assert.equal(await seedSample(app, quiet, N), null, 'the same word again drops nothing');
  assert.equal(await count('persons'), N);
});

test('production, or no sample asked for: nothing made, nothing dropped, whatever the record says', async () => {
  assert.ok(await seedSample(app, quiet, N));
  await (await enter()).createPerson('Left Behind');
  await db.query('update sample_meta.made set version = 1');
  for (const [k, v] of [['STARBASE_ENV', 'production'], ['STARBASE_SAMPLE', ''], ['STARBASE_DEMO_EMAIL', '']]) {
    const was = process.env[k];
    process.env[k] = v;
    assert.equal(await seedSample(app, quiet, N), null, `${k}=${JSON.stringify(v)}`);
    assert.equal(await count('persons'), N + 1);
    process.env[k] = was;
  }
});

// ── The demo account stays the demo's ──

test('the demo account can’t be removed, demoted or given two-step sign-in, so a second manager can’t switch the self-rebuild off', async () => {
  assert.ok(await seedSample(app, quiet, N));
  const demo = await enter();
  const ws = (await db.query('select id from workspaces')).rows[0].id;
  const demoId = (await db.query('select id from users where email = $1', [DEMO])).rows[0].id;
  // A second manager, as a visitor could invite and become.
  const otherId = '00000000-0000-4000-8000-0000000000aa';
  await db.query("insert into users (id, email, name, password_hash) values ($1, 'second@example.org', 'Second Manager', 'none')", [otherId]);
  await db.query("insert into memberships (user_id, workspace_id, role) values ($1, $2, 'manager')", [otherId, ws]);
  const other = new Client();
  other.cookie = `${SESSION_COOKIE}=${await createSession(db, otherId, ws)}`;
  assert.equal((await other.get('/api/auth/me')).status, 200);

  for (const [name, input] of [['member.remove', { user_id: demoId }], ['member.setRole', { user_id: demoId, role: 'volunteer' }]]) {
    const r = await other.action(name, input);
    assert.equal(r.status, 409, name);
    assert.equal(r.json.error, 'The demo can’t change this.');
  }
  for (const [name, input] of [['twostep.start', {}], ['twostep.require', { on: true }]]) {
    const r = await demo.action(name, input);
    assert.equal(r.status, 409, name);
    assert.equal(r.json.error, 'The demo can’t change this.', name);
  }
  // The second manager can still be changed, as anyone can.
  assert.equal((await demo.action('member.setRole', { user_id: otherId, role: 'staff' })).status, 200);
  // G5 still holds, so the next sample still replaces this one.
  assert.ok(await demoOwnsIt(db, DEMO));
  await db.query('update sample_meta.made set version = 1');
  assert.equal((await seedSample(app, quiet, N)).people, N);
  assert.equal(await count('users'), 1);
});
