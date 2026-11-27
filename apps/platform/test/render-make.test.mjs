// Stage 2: a new campaign's database and service, made by the control
// centre in Render, over the in-memory stand-in (fake-render.mjs).
//   The gate: nothing of stage 2 exists (its routes are Not found, the
//     set-up page is as before, no create call can be made) until Check
//     Render’s answers has run with the sample connected and seen, in
//     Render's own answer about staging, every word the creating calls send.
//   Making: each press looks first, makes only what isn't there, saves the
//     id and logs it; it stops at the first step it can't finish, and Carry
//     on goes on from there. Whatever Render does (refuses, makes it but
//     says it failed, makes it and never answers, lists it late) and
//     whatever happens here (the save fails, the console starts again),
//     there is never a second database or service under the name.
//   Adding a missing setting (8.1): only on a campaign made with New
//     campaign, only a setting that is missing, only its own value.
// Every test ends with nothing forbidden asked of Render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDS, OWNER, REPO, SENTINELS } from './fake-render.mjs';
import { rig } from './render-rig.mjs';
import { makeRender, CALLS, SHAPES } from '../render-api.mjs';
import { serviceSettings, envLines, DENY } from '../snippets.mjs';
import { settingsFor, writableFor, valueFor, WRITABLE, WRITABLE_MADE, makeRefusal } from '../render-guard.mjs';
import { appendLog, verifyLog } from '../log.mjs';
import { wordsFor } from '../words.mjs';
import { pubkeyValue } from '../keys.mjs';

const flat = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// Check Render’s answers, with the sample connected: the gate opens.
const openGate = async (r) => {
  if (!(await r.env('sample'))?.render_service) await r.connect('sample');
  const res = await r.b.post('/render/check', {});
  assert.equal(res.status, 200);
  return flat(await res.text());
};
// Never two under one name.
const atMostOne = (r, name = 'x') => {
  assert.ok(r.world.named(`base-win-${name}`).length <= 1, `one service called base-win-${name}`);
  assert.ok(r.world.named(`base-win-${name}-db`).length <= 1, `one database called base-win-${name}-db`);
};
// Two minutes and more since the last press.
const age = (r, name = 'x') => r.db.query("update render_jobs set asked_at = asked_at - interval '3 minutes', began_at = began_at - interval '3 minutes', ended_at = ended_at - interval '3 minutes' where campaign = $1", [name]);
const setup = async (r, name = 'x') => flat((await r.page(`/c/${name}/setup`)).body);
const lines = (body) => Object.fromEntries([...body.matchAll(/(Database made|Database ready|Service made|Address added|First build live|Answering) (Done|Not yet|Failed)/g)].map((m) => [m[1], m[2]]));
const ALL_DONE = { 'Database made': 'Done', 'Database ready': 'Done', 'Service made': 'Done', 'Address added': 'Done', 'First build live': 'Done', Answering: 'Done' };
const clean = (world) => {
  assert.deepEqual(world.forbidden, []);
  for (const c of world.calls) assert.notEqual(c.method, 'DELETE');
};
const made = (r, name = 'x') => ({ svc: r.world.service(`base-win-${name}`), db: r.world.database(`base-win-${name}-db`) });

test('the gate: no make, no set and nothing new on the set-up page until Check Render’s answers has seen what making needs', async () => {
  const r = await rig({ campaigns: ['sample', 'a'], fresh: ['x'] });
  const before = (await r.page('/c/x/setup')).body;
  assert.doesNotMatch(before, /Make it in Render/);
  const closed = async (why) => {
    assert.equal((await r.b.post('/c/x/render/make', {})).status, 404, `make: ${why}`);
    assert.equal((await r.b.post('/c/a/render/set', { setting: 'STARBASE_TZ' })).status, 404, `set: ${why}`);
    assert.equal((await r.page('/c/x/setup')).body, before, `the set-up page is as before: ${why}`);
  };
  await closed('no check yet');
  await r.connect('a');
  // Before the sample is connected, staging's service and database can't be read: still closed.
  let body = flat(await (await r.b.post('/render/check', {})).text());
  assert.match(body, /Connect Sample \(staging\) to check the rest/);
  assert.match(body, /New campaign still walks you through Render by hand/);
  let line = (await r.log('render.check')).at(-1);
  assert.equal(line.payload.make, false);
  assert.equal(wordsFor('render.check', line.payload), 'Checked Render’s answers: New campaign walks you through Render by hand');
  await closed('the sample not connected');
  // A word making relies on that Render doesn't use: still closed, and the page names it.
  await r.connect('sample');
  r.world.dropField('healthCheckPath');
  body = await openGate(r);
  assert.match(body, /Staging’s service, as a new one is made Doesn’t match: serviceDetails\.healthCheckPath/);
  assert.match(body, /Staging’s database, as a new one is made Matches/);
  assert.match(body, /New campaign still walks you through Render by hand/);
  await closed('one word doesn’t match');
  r.world.up();
  // Every word matches: open.
  body = await openGate(r);
  assert.match(body, /Staging’s service, as a new one is made Matches/);
  assert.match(body, /New campaign can make a campaign’s database and service in Render from here/);
  line = (await r.log('render.check')).at(-1);
  assert.deepEqual(Object.keys(line.payload).sort(), ['make', 'ok', 'owner', 'shapes']);
  assert.deepEqual([line.payload.ok, line.payload.make, line.payload.owner], [true, true, OWNER]);
  assert.match(line.payload.shapes, /^[0-9a-f]{16}$/);
  assert.equal(line.payload.shapes, r.render.makeShapes);
  assert.equal(wordsFor('render.check', line.payload), 'Checked Render’s answers: New campaign can make things in Render');
  const card = (await r.page('/c/x/setup')).body;
  assert.match(card, /<button class="btn btn-primary[^"]*" type="submit">Make it in Render<\/button>/);
  assert.equal([...card.matchAll(/btn-primary/g)].length, 1, 'one primary');
  assert.equal((await r.ask('x', 'make')).res.status, 200);
  // A check that fails closes it again; a good one opens it.
  r.world.down();
  await openGate(r);
  await closed('the newest check failed');
  r.world.up();
  await openGate(r);
  assert.equal((await r.ask('x', 'make')).res.status, 200);
  // A release that changes the words sent: the record no longer fits.
  await r.db.transaction((tx) => appendLog(tx, { action: 'render.check', payload: { ok: true, make: true, shapes: '0'.repeat(16), owner: OWNER } }));
  await closed('the words changed since the check');
  // A key for another workspace than the one checked.
  await r.db.transaction((tx) => appendLog(tx, { action: 'render.check', payload: { ok: true, make: true, shapes: r.render.makeShapes, owner: 'tea-another000000000001' } }));
  assert.equal((await r.b.post('/c/x/render/make', {})).status, 404, 'another workspace');
  assert.deepEqual(r.writes(), []);
  // No key: everything of it is gone, whatever the log says.
  await openGate(r);
  delete process.env.RENDER_API_KEY;
  assert.equal((await r.b.post('/c/x/render/make', {})).status, 404);
  assert.doesNotMatch((await r.page('/c/x/setup')).body, /Make it in Render/);
  assert.ok(!r.world.calls.some((c) => c.method === 'POST' && /^\/(services|postgres)$/.test(c.path)), 'nothing was made');
  clean(r.world);
});

test('Make it in Render: what it will do, then two presses (the database takes a while): one database, one service, its address saved and added', async () => {
  const r = await rig({ campaigns: ['sample'], fresh: ['x'] });
  await openGate(r);
  r.world.never('available');
  const asked = await r.ask('x', 'make');
  assert.equal(asked.res.status, 200);
  const words = flat(asked.body);
  assert.match(asked.body, /<h1>Make it in Render<\/h1>/);
  assert.ok(words.includes('Makes two paid things in Render: the database base-win-x-db (Basic 1 GB, PostgreSQL 16, Oregon, closed to the internet) and the service base-win-x (Starter, Docker, from the production branch). Render bills for both from today: check its prices. Then it adds x.base.win. Nothing else in Render is touched and nothing is copied from another campaign. It takes about 5 minutes and may ask you to press Carry on once.'), words);
  assert.equal([...asked.body.matchAll(/btn-primary/g)].length, 1);
  assert.match(asked.body, /name="code"[^>]*required/);
  assert.match(asked.body, /href="\/c\/x\/setup">Cancel/);
  assert.deepEqual(r.writes(), [], 'asking makes nothing');
  r.mark();
  // The start line is on the log before each thing is asked for.
  const send = r.world.send;
  const seen = [];
  r.world.send = async (method, path, body) => {
    if (method === 'POST' && /^\/(postgres|services)$/.test(path)) {
      seen.push((await r.db.query("select payload from ops_log where action = 'render.start' order by seq desc limit 1")).rows[0]?.payload.step);
    }
    return send(method, path, body);
  };
  let res = await r.b.post('/c/x/render/make', { job: asked.job, code: await r.code() });
  assert.deepEqual([res.status, res.headers.get('location')], [303, '/c/x/setup']);
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [['POST', '/postgres', { name: 'base-win-x-db', ownerId: OWNER, plan: 'basic_1gb', region: 'oregon', version: '16', ipAllowList: [] }]]);
  let env = await r.env('x');
  assert.equal(env.render_db, made(r).db.id);
  assert.deepEqual([env.render_service, env.server_url], [null, null]);
  let page = await setup(r);
  assert.match(page, /Render is getting the database ready\. Press Carry on in a few minutes\./);
  assert.deepEqual(lines(page), { 'Database made': 'Done', 'Database ready': 'Not yet', 'Service made': 'Not yet', 'Address added': 'Not yet', 'First build live': 'Not yet', Answering: 'Not yet' });
  assert.match((await r.page('/c/x/setup')).body, /<button class="btn btn-primary[^"]*" type="submit">Carry on<\/button>/);
  assert.match((await r.page('/c/x/setup')).body, /<meta http-equiv="refresh" content="15">/);
  // The database is ready; a new console over the same database carries on.
  r.world.lift('available');
  r.again();
  const carry = await r.ask('x', 'make');
  assert.match(carry.body, /<h1>Carry on making it in Render<\/h1>/);
  assert.match(flat(carry.body), /Carries on from where it stopped\. It looks first and never makes a second one\./);
  res = await r.b.post('/c/x/render/make', { job: carry.job, code: await r.code() });
  assert.equal(res.status, 303);
  assert.deepEqual(seen, ['database', 'service']);
  const { svc, db } = made(r);
  assert.ok(svc && db);
  assert.deepEqual(r.writes().map((c) => `${c.method} ${c.path}`), ['POST /postgres', 'POST /services', `POST /services/${svc.id}/custom-domains`]);
  assert.deepEqual(r.world.connectionReads, [db.id], 'its connection details read once, for its own new database');
  const create = r.writes()[1].body;
  assert.deepEqual({ ...create, envVars: undefined }, {
    type: 'web_service', name: 'base-win-x', ownerId: OWNER, repo: REPO, branch: 'production', autoDeploy: 'yes', envVars: undefined,
    serviceDetails: { runtime: 'docker', plan: 'starter', region: 'oregon', healthCheckPath: '/api/health', envSpecificDetails: { dockerfilePath: './Dockerfile', dockerContext: '.' } },
  });
  const sent = Object.fromEntries(create.envVars.map((e) => [e.key, e]));
  assert.deepEqual(sent.STARBASE_TWO_STEP_KEY, { key: 'STARBASE_TWO_STEP_KEY', generateValue: true }, 'Render makes the random keys');
  assert.deepEqual(sent.GOOGLE_TOKEN_KEY, { key: 'GOOGLE_TOKEN_KEY', generateValue: true });
  assert.equal(sent.DATABASE_URL.value, `postgres://u:${SENTINELS.newDb}-${db.id}@${db.id}-a/db`, 'its own new database, by the internal address');
  assert.equal(sent.BASE_PLATFORM_PUBKEY.value, pubkeyValue());
  assert.deepEqual(r.writes()[2].body, { name: 'x.base.win' });
  env = await r.env('x');
  assert.deepEqual([env.render_db, env.render_service, env.server_url], [db.id, svc.id, 'https://base-win-x.onrender.com']);
  assert.deepEqual(r.world.domains[svc.id], [{ name: 'x.base.win', verificationStatus: 'unverified' }]);
  page = await setup(r);
  assert.deepEqual(lines(page), { 'Database made': 'Done', 'Database ready': 'Done', 'Service made': 'Done', 'Address added': 'Done', 'First build live': 'Not yet', Answering: 'Not yet' });
  // The log: a start and a result for each thing made, the address saved as an edit would.
  const log = (await r.log()).filter((l) => l.campaign === 'x').map((l) => [l.action, l.payload.step || l.payload.what, l.payload.ok ?? null]);
  assert.deepEqual(log, [['render.start', 'database', null], ['render.result', 'database', true], ['render.start', 'service', null], ['render.result', 'service', true],
    ['render.start', 'domain', null], ['render.result', 'domain', true]]);
  const edit = (await r.log('campaign.edit')).at(-1);
  assert.equal(edit.payload.after.server_url, 'https://base-win-x.onrender.com');
  for (const l of await r.log()) assert.ok(!JSON.stringify(l).includes(SENTINELS.newDb), 'the database’s address is on no line');
  // The first build goes live and the server answers: every line Done, Invite next.
  r.world.finishDeploys(svc.id);
  r.health.x = r.answer('x');
  assert.equal((await r.b.post('/c/x/check-now', {})).status, 303);
  page = await setup(r);
  assert.deepEqual(lines(page), ALL_DONE);
  const raw = (await r.page('/c/x/setup')).body;
  assert.match(raw, /Invite the first manager/);
  assert.equal([...raw.matchAll(/btn-primary/g)].length, 1);
  assert.doesNotMatch(raw, /Or ask us to add it to render\.yaml/, 'a Blueprint would make a second service under the name');
  assert.doesNotMatch(raw, /http-equiv="refresh"/, 'nothing left to wait for');
  assert.equal((await r.b.post('/c/x/render/make', {})).status, 409, 'made: nothing more to make');
  assert.equal((await verifyLog(r.db)).ok, true);
  atMostOne(r);
  clean(r.world);
});

// Every step × every failure: Carry on until it is made, never two.
const STEPS = { database: /^POST \/postgres$/, service: /^POST \/services$/, domain: /^POST \/services\/[^/]+\/custom-domains$/ };
const FAILS = {
  refused: (w, on) => w.refuse(422, { on }),
  payment: (w, on) => w.refuse(402, { on }),
  'made but said 500': (w, on) => w.madeButSaid(500, { on }),
  'made, no answer': (w, on) => w.madeButTimedOut({ on }),
};
const FIRST_WORDS = {
  'database refused': /Render refused the database \(answer 422\)\. Nothing was made\./,
  'database payment': /Render needs a payment method for this plan\. Nothing was made\./,
  'database made but said 500': /Render didn’t say whether it made the database\. Wait two minutes, then Carry on: it looks first and never makes a second one\./,
  'database made, no answer': /Render didn’t say whether it made the database\. Wait two minutes, then Carry on/,
  'service refused': /Render refused the service \(answer 422\)\. The database is kept; nothing was made twice\./,
  'service payment': /Render needs a payment method for this plan\. Nothing was made\./,
  'service made but said 500': /Render didn’t say whether it made the service\. Wait two minutes, then Carry on/,
  'service made, no answer': /Render didn’t say whether it made the service\./,
  'domain refused': /Render didn’t add x\.base\.win \(answer 422\)\. Press Carry on to try again\./,
  'domain payment': /Render didn’t add x\.base\.win \(answer 402\)/,
  'domain made but said 500': /Render didn’t say whether it added x\.base\.win\. Press Carry on: it looks first\./,
  'domain made, no answer': /Render didn’t say whether it added x\.base\.win/,
};
for (const [step, on] of Object.entries(STEPS)) {
  for (const [kind, fault] of Object.entries(FAILS)) {
    test(`every step × every failure: ${step}, ${kind}`, async () => {
      const r = await rig({ campaigns: ['sample'], fresh: ['x'] });
      await openGate(r);
      fault(r.world, on);
      assert.equal((await r.change('x', 'make')).status, 303);
      atMostOne(r);
      assert.match(await setup(r), FIRST_WORDS[`${step} ${kind}`]);
      const unsure = kind.startsWith('made') && step !== 'domain';
      if (unsure) {
        // Inside two minutes of a make with no answer, Carry on is turned away before anything is asked.
        r.again();
        r.mark();
        const early = await r.ask('x', 'make');
        assert.equal(early.res.status, 409);
        assert.match(flat(early.body), new RegExp(`Render didn’t say whether it made the ${step}\\. Wait two minutes, then Carry on`));
        assert.deepEqual(r.calls(), []);
      }
      for (let press = 0; press < 4 && !(made(r).svc && r.world.domains[made(r).svc.id]?.length && (await r.env('x')).server_url); press += 1) {
        await age(r);
        r.again();
        assert.equal((await r.change('x', 'make')).status, 303, `Carry on ${press + 1}`);
        atMostOne(r);
      }
      const { svc, db } = made(r);
      assert.ok(svc && db, 'made in the end');
      const env = await r.env('x');
      assert.deepEqual([env.render_db, env.render_service, env.server_url], [db.id, svc.id, 'https://base-win-x.onrender.com']);
      assert.deepEqual(r.world.domains[svc.id].map((d) => d.name), ['x.base.win']);
      assert.equal(r.world.settingsOf(svc.id).DATABASE_URL, `postgres://u:${SENTINELS.newDb}-${db.id}@${db.id}-a/db`);
      if (unsure) {
        const found = (await r.log('render.result')).filter((l) => l.payload.step === step && l.payload.found);
        assert.equal(found.length, 1, 'adopted once, logged as found');
        assert.equal(wordsFor('render.result', found[0].payload), 'Found what Render had already made');
      }
      assert.equal((await verifyLog(r.db)).ok, true);
      clean(r.world);
    });
  }
}

test('Render lists a new thing late; the save fails after Render made it; the console starts again: still one of each', async () => {
  // Lists that miss the new database twice, after a make with no answer.
  let r = await rig({ campaigns: ['sample'], fresh: ['x'] });
  await openGate(r);
  r.world.madeButTimedOut({ on: STEPS.database });
  await r.change('x', 'make');
  await age(r);
  r.world.lag(2);
  r.again();
  assert.equal((await r.change('x', 'make')).status, 303);
  atMostOne(r);
  assert.ok(made(r).svc, 'it looked again, found it, and went on');
  clean(r.world);

  // The id can't be saved after Render made the database.
  r = await rig({ campaigns: ['sample'], fresh: ['x'] });
  await openGate(r);
  const real = r.db.transaction.bind(r.db);
  let armed = true;
  r.db.transaction = (fn) => real((tx) => fn(new Proxy(tx, {
    get: (t, k) => (k === 'query'
      ? (sql, params) => { if (armed && /set render_db = /.test(sql)) { armed = false; throw new Error('the save failed'); } return t.query(sql, params); }
      : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])),
  })));
  await r.change('x', 'make');
  assert.equal(r.world.named('base-win-x-db').length, 1);
  assert.equal((await r.env('x')).render_db, null);
  assert.match(await setup(r), /Render didn’t say whether it made the database\. Wait two minutes/);
  await age(r);
  r.again();
  assert.equal((await r.change('x', 'make')).status, 303);
  atMostOne(r);
  assert.equal((await r.env('x')).render_db, made(r).db.id, 'found and saved');
  assert.ok(made(r).svc);
  clean(r.world);

  // A new console, mid-way, over the same database.
  r = await rig({ campaigns: ['sample'], fresh: ['x'] });
  await openGate(r);
  r.world.never('available');
  await r.change('x', 'make');
  r.world.lift('available');
  r.again();
  await r.change('x', 'make');
  atMostOne(r);
  assert.ok(made(r).svc);
  clean(r.world);
});

test('one press at a time: the same page pressed twice makes one database', async () => {
  const r = await rig({ campaigns: ['sample'], fresh: ['x'] });
  await openGate(r);
  r.world.never('available');
  const asked = await r.ask('x', 'make');
  const code = await r.code();
  const [one, two] = await Promise.all([
    r.b.post('/c/x/render/make', { job: asked.job, code }),
    r.b.post('/c/x/render/make', { job: asked.job, code }),
  ]);
  const statuses = [one.status, two.status].sort();
  assert.equal(statuses[0], 303, 'one press runs');
  assert.ok([401, 409].includes(statuses[1]), `the other is turned away (${statuses[1]})`);
  assert.equal(r.world.calls.filter((c) => c.method === 'POST' && c.path === '/postgres').length, 1);
  atMostOne(r);
  clean(r.world);
});

test('what it didn’t make, it never uses: a same-named database or service stops it; a database saved by anything but its own make is never wired', async () => {
  // A database already under the name, made by hand.
  let r = await rig({ campaigns: ['sample'], fresh: ['x'] });
  await openGate(r);
  r.world.databases.push({ ...r.world.database('base-win-a-db'), id: 'dpg-byhand0000000000001', name: 'base-win-x-db', createdAt: '2026-10-01T17:50:00Z' });
  r.mark();
  assert.equal((await r.change('x', 'make')).status, 303);
  assert.deepEqual(r.writes(), [], 'nothing made');
  assert.deepEqual(r.world.connectionReads, []);
  assert.match(await setup(r), /A database called base-win-x-db is already in Render and this page didn’t make it\. Nothing was changed\. Choose another short name, or finish by hand \(More\)\./);
  assert.equal((await r.env('x')).render_db, null);
  clean(r.world);

  // A service already under the name: the database made is kept, no service, no connection details read.
  r = await rig({ campaigns: ['sample'], fresh: ['x'] });
  await openGate(r);
  r.world.addClient('x', { url: 'https://someone-else.onrender.com' });
  r.world.databases.pop();
  r.mark();
  await r.change('x', 'make');
  assert.deepEqual(r.writes().map((c) => `${c.method} ${c.path}`), ['POST /postgres']);
  assert.deepEqual(r.world.connectionReads, []);
  assert.match(await setup(r), /A service called base-win-x is already in Render and this page didn’t make it\. Nothing was changed\./);
  assert.equal((await r.env('x')).render_service, null);
  clean(r.world);

  // Another campaign's database put in this campaign's row: refused before it is read.
  r = await rig({ campaigns: ['sample'], fresh: ['x'] });
  await openGate(r);
  r.world.never('available');
  await r.change('x', 'make');
  await r.db.query("update environments set render_db = $1 where campaign = 'x'", [IDS.bDb]);
  r.world.lift('available');
  r.again();
  r.mark();
  await r.change('x', 'make');
  assert.deepEqual(r.writes(), []);
  assert.deepEqual(r.world.connectionReads, []);
  assert.ok(!r.calls().some((c) => c.includes(IDS.bDb)), 'the other database isn’t even read');
  assert.match(await setup(r), /Couldn’t wire the database\. Nothing more was made\./);
  clean(r.world);

  // The client itself: makeService takes only a database made for this name, after the make began.
  const world = r.world;
  const c = makeRender({ send: world.send, cacheMs: 0 });
  const camp = (await r.db.query("select * from campaigns where name = 'x'")).rows[0];
  const gate = { shapes: c.makeShapes, owner: OWNER };
  const t = await c.makeTarget(camp, { campaign: 'x', env: 'production' }, gate);
  assert.equal(t.ok, true);
  const before = world.connectionReads.length;
  assert.equal((await c.makeService(t.target, { database: IDS.bDb, since: new Date(0).toISOString() })).problem, 'not-allowed', 'another campaign’s database');
  assert.equal((await c.makeService(t.target, { database: made(r).db.id, since: new Date(Date.now() + 3600_000).toISOString() })).problem, 'not-allowed', 'one made before this make began');
  assert.equal((await c.makeService({ ...t.target }, { database: made(r).db.id, since: new Date(0).toISOString() })).problem, 'not-allowed', 'a look-alike target');
  assert.equal((await c.makeDatabase({ kind: 'make', dbName: 'base-win-x-db' })).problem, 'not-allowed');
  assert.equal(world.connectionReads.length, before);
  assert.equal((await c.makeTarget(camp, { campaign: 'x' }, { shapes: '0'.repeat(16), owner: OWNER })).ok, false, 'words changed since the check');
  assert.equal((await c.makeTarget(camp, { campaign: 'x' }, { shapes: c.makeShapes, owner: 'tea-another000000000001' })).ok, false, 'another workspace');
  assert.equal((await c.makeTarget({ ...camp, values: {} }, { campaign: 'x' }, gate)).ok, false, 'a campaign added as already running');
  assert.equal((await c.makeTarget({ ...camp, kind: 'sample', name: 'sample' }, { campaign: 'sample' }, gate)).ok, false, 'the sample');
  clean(world);
});

test('two new campaigns a day; names that would take a protected one; a campaign set up by hand', async () => {
  const r = await rig({ campaigns: ['sample', 'a'], fresh: ['x', 'y', 'z', 'q-db'] });
  await openGate(r);
  for (const name of ['x', 'y']) { r.again(); assert.equal((await r.change(name, 'make')).status, 303, name); }
  r.again();
  r.mark();
  const third = await r.ask('z', 'make');
  assert.equal(third.res.status, 429);
  assert.match(flat(third.body), /Two new campaigns were made in Render today\. Make the next one tomorrow, or by hand \(More\)\./);
  assert.deepEqual(r.calls(), []);
  await r.db.query("update render_jobs set began_at = began_at - interval '25 hours', asked_at = asked_at - interval '25 hours', ended_at = ended_at - interval '25 hours'");
  assert.equal((await r.ask('z', 'make')).res.status, 200, 'a day later');
  // Names.
  for (const name of ['db', 'q-db', 'staging-db']) assert.match(makeRefusal(name), /can’t be made in Render/, name);
  for (const name of ['x', 'win', 'platform-x']) assert.equal(makeRefusal(name), null, name);
  const refused = await r.ask('q-db', 'make');
  assert.equal(refused.res.status, 409);
  assert.match(flat(refused.body), /The short name q-db can’t be made in Render: base-win-q-db would look like a database’s name\. Make it by hand \(More\), or start again with another short name\./);
  // Set up by hand (its address pasted, its service connected): nothing to make.
  assert.equal((await r.ask('a', 'make')).res.status, 409);
  assert.match(flat((await r.ask('a', 'make')).body), /This campaign’s service was set up by hand\. Nothing was changed\./);
  assert.doesNotMatch((await r.page('/c/a/setup')).body, /Make it in Render/);
  clean(r.world);
});

test('the creating call’s settings: this campaign’s own values only, and Render makes the two random keys', async () => {
  const camp = { name: 'x', display: 'Example "X"\nCampaign', kind: 'client', values: { city: 'Exampleton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: ['council', 'school_board'], bounds: '43.6,-79.5|43.8,-79.2' } };
  const list = serviceSettings({ name: camp.name, display: camp.display, values: camp.values, publicKey: pubkeyValue() });
  assert.deepEqual(list.map((e) => e.key), envLines({ name: 'x', display: 'X', values: camp.values }).map((l) => l.key), 'the .env block’s keys, in its order');
  for (const e of list.filter((x) => ['STARBASE_TWO_STEP_KEY', 'GOOGLE_TOKEN_KEY'].includes(x.key))) assert.deepEqual(e, { key: e.key, generateValue: true });
  const values = Object.fromEntries(list.filter((e) => 'value' in e).map((e) => [e.key, e.value]));
  assert.deepEqual(values, {
    NODE_ENV: 'production', STARBASE_ENV: 'production', STARBASE_PUBLIC_URL: 'https://x.base.win', STARBASE_BRAND: 'base', STARBASE_ORG_NAME: 'Example X Campaign',
    STARBASE_JURISDICTION: 'bc-municipal', STARBASE_PROVINCE: 'ON', STARBASE_TZ: 'America/Toronto', STARBASE_CITY: 'Exampleton', STARBASE_SLATES: 'council:City council,school_board:School board',
    STARBASE_GEO_BOUNDS: '43.6,-79.5|43.8,-79.2', STARBASE_CANDIDATES: 'none', BASE_PLATFORM_PUBKEY: pubkeyValue(),
  }, 'no quotes: Render takes each value as it is');
  assert.deepEqual(settingsFor(camp), list);
  const text = JSON.stringify(list);
  for (const bad of ['Vancouver', 'Surrey', 'Imagine', 'Hartwell', 'Opposed', 'demo@', 'imagine-surrey', ...DENY, 'RESEND', 'TWILIO', 'GOOGLE_MAPS', 'DATABASE_URL']) assert.ok(!text.includes(bad), bad);
  // Nothing to make settings from: no list at all.
  assert.equal(settingsFor({ ...camp, values: {} }), null, 'a campaign added as already running');
  assert.equal(settingsFor({ ...camp, kind: 'sample' }), null, 'the sample');
  assert.equal(settingsFor({ ...camp, values: { ...camp.values, tz: 'Europe/London' } }), null, 'a value off its list');
  assert.equal(settingsFor({ ...camp, values: { ...camp.values, bounds: '1,2|3' } }), null, 'a map area of the wrong shape');
  // The wider list of settings it may add later, only with the gate open and only for a campaign made here.
  assert.deepEqual(WRITABLE, ['BASE_PLATFORM_PUBKEY']);
  assert.deepEqual(writableFor(camp), ['BASE_PLATFORM_PUBKEY']);
  assert.deepEqual(writableFor(camp, { stage2: true }), WRITABLE_MADE);
  assert.deepEqual(writableFor({ ...camp, values: {} }, { stage2: true }), ['BASE_PLATFORM_PUBKEY']);
  assert.deepEqual(writableFor({ ...camp, kind: 'sample' }, { stage2: true }), ['BASE_PLATFORM_PUBKEY']);
  assert.equal(valueFor(camp, 'STARBASE_TZ'), null, 'the gate closed: only base.win’s key');
  assert.equal(valueFor(camp, 'STARBASE_TZ', { stage2: true }), 'America/Toronto');
  assert.equal(valueFor(camp, 'STARBASE_PUBLIC_URL', { stage2: true }), 'https://x.base.win');
  assert.equal(valueFor({ ...camp, values: {} }, 'STARBASE_TZ', { stage2: true }), null);
  for (const never of ['NODE_ENV', 'STARBASE_ENV', 'DATABASE_URL', 'STARBASE_TWO_STEP_KEY', 'GOOGLE_TOKEN_KEY', 'RESEND_API_KEY', ...DENY]) assert.equal(valueFor(camp, never, { stage2: true }), null, never);
  // The table: three new rows, the connection details named once.
  assert.deepEqual([CALLS.makeDatabase, CALLS.connectionInfo, CALLS.makeService], [['POST', '/postgres'], ['GET', '/postgres/{id}/connection-info'], ['POST', '/services']]);
  assert.equal(SHAPES.make.ready, 'available');
});

test('add a missing setting (8.1): a campaign made here, a setting that is missing, its own value; then deploy', async () => {
  const r = await rig({ campaigns: ['sample', 'a', 'imaginesurrey'] });
  await r.connect('a', 'imaginesurrey');
  delete r.world.settingsOf(IDS.a).STARBASE_TZ;
  // The gate closed: missing is said, nothing offered.
  let page = (await r.page('/c/a/render')).body;
  assert.match(page, /Missing: STARBASE_TZ, BASE_PLATFORM_PUBKEY/);
  assert.doesNotMatch(page, /render\/set/);
  await openGate(r);
  page = (await r.page('/c/a/render')).body;
  assert.match(page, /<form method="post" action="\/c\/a\/render\/set"[^>]*>\s*<input type="hidden" name="setting" value="STARBASE_TZ">\s*<button class="btn btn-quiet" type="submit">Add STARBASE_TZ<\/button>/);
  assert.doesNotMatch(page, /name="setting" value="BASE_PLATFORM_PUBKEY"/, 'base.win’s key has its own button');
  r.mark();
  const res = await r.b.post('/c/a/render/set', { setting: 'STARBASE_TZ' });
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(flat(body), /Adds STARBASE_TZ = America\/Vancouver to base-win-a, then deploys\. It is added only because it is missing\./);
  const job = /name="job" value="([0-9a-f]{32})"/.exec(body)[1];
  assert.equal((await r.b.post('/c/a/render/set', { job, code: await r.code() })).status, 303);
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [
    ['PUT', `/services/${IDS.a}/env-vars/STARBASE_TZ`, { value: 'America/Vancouver' }],
    ['POST', `/services/${IDS.a}/deploys`, { clearCache: 'do_not_clear' }],
  ]);
  assert.equal(r.world.settingsOf(IDS.a).STARBASE_TZ, 'America/Vancouver');
  const start = (await r.log('render.start')).at(-1);
  assert.deepEqual([start.payload.what, start.payload.setting], ['set', 'STARBASE_TZ']);
  assert.equal(wordsFor('render.start', start.payload), 'Asked Render to add STARBASE_TZ');
  assert.match(flat((await r.page('/c/a/render')).body), /Missing: BASE_PLATFORM_PUBKEY/);
  // Already set: nothing is changed. Off the list, a campaign added as already running, the sample: Not found.
  r.again();
  r.mark();
  const set = await r.b.post('/c/a/render/set', { setting: 'STARBASE_TZ' });
  assert.equal(set.status, 409);
  assert.match(flat(await set.text()), /STARBASE_TZ is already set on base-win-a\. Nothing was changed\./);
  for (const setting of ['NODE_ENV', 'STARBASE_ENV', 'DATABASE_URL', 'RESEND_API_KEY', 'STARBASE_SAMPLE', 'BASE_PLATFORM_PUBKEY', '']) {
    assert.equal((await r.b.post('/c/a/render/set', { setting })).status, 404, setting || 'no setting');
  }
  assert.equal((await r.b.post('/c/imaginesurrey/render/set', { setting: 'STARBASE_CANDIDATES' })).status, 404);
  assert.equal((await r.b.post('/c/sample/render/set', { setting: 'STARBASE_TZ' })).status, 404);
  assert.deepEqual(r.writes(), []);
  // Set in Render between the page and the code: nothing is written.
  delete r.world.settingsOf(IDS.a).STARBASE_CITY;
  const asked = await r.b.post('/c/a/render/set', { setting: 'STARBASE_CITY' });
  const job2 = /name="job" value="([0-9a-f]{32})"/.exec(await asked.text())[1];
  r.world.settingsOf(IDS.a).STARBASE_CITY = 'Set by hand';
  assert.equal((await r.b.post('/c/a/render/set', { job: job2, code: await r.code() })).status, 409);
  assert.equal(r.world.settingsOf(IDS.a).STARBASE_CITY, 'Set by hand', 'a value already there is never changed');
  assert.deepEqual(r.writes(), []);
  clean(r.world);
});
