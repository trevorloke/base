// render-api.mjs, the one way to Render: each call's method, path and body;
// the key goes to Render's API host in one header and nowhere else, and
// cfg() never hands it out; a redirect is not followed; a made-up id never
// reaches the wire; every kind of failure becomes a named problem and
// Render's own answer never comes back; a setting's value is dropped; a
// change takes a checked target, never an id, and never a value from its
// caller; closing a database only ever shortens the list it read.
// The stand-in for Render listens on 127.0.0.1:5608 (fake-render.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { baseEnv } from './helpers.mjs';
import { fakeWorld, startFakeRender, renderEnv, noRenderEnv, KEY, IDS, OWNER, REPO, SENTINELS } from './fake-render.mjs';

baseEnv();
renderEnv();
const { cfg } = await import('../config.mjs');
const { makeRender, sharedRender, CALLS, SHAPES } = await import('../render-api.mjs');
const { READABLE } = await import('../render-guard.mjs');
const { pubkeyValue } = await import('../keys.mjs');
const { settingNames } = await import('../../../shared/old-names.js');
const { renderSnippet } = await import('../snippets.mjs');

const world = fakeWorld();
const fake = await startFakeRender({ port: 5608, world });
after(() => fake.close());
const listenerEnv = () => { noRenderEnv(); baseEnv(); renderEnv({ OPS_ALLOW_LOCAL: '1', OPS_RENDER_API: fake.base }); };
listenerEnv();
// Nothing is kept between calls here, so each test sees what it asked for.
const client = () => makeRender({ cacheMs: 0, timeoutMs: 400 });
const lastCall = () => world.received[world.received.length - 1];
const NEVER_BACK = ['SENTINEL-RENDER-BODY', SENTINELS.client, SENTINELS.db, SENTINELS.newDb, 'SENTINEL-COMMIT-MESSAGE', 'SENTINEL-OWNER-EMAIL', KEY];
const clean = (value) => { const s = JSON.stringify(value); for (const bad of NEVER_BACK) assert.ok(!s.includes(bad), `the answer holds ${bad.slice(0, 20)}`); return value; };

// The control centre's own rows for campaign "a" and for the sample.
const campaignA = { name: 'a', display: 'Example A', kind: 'client', archived_at: null, values: { city: 'Exampleton', province: 'BC', rules: 'bc-municipal', tz: 'America/Vancouver', races: ['council'], bounds: '50.6,-120.5|50.8,-120.2' } };
const envA = { campaign: 'a', env: 'production', server_url: 'https://base-win-a.onrender.com', instance: 'AAAAAAAAAAAAAAAAAAAAAA', render_service: IDS.a, render_db: IDS.aDb };
const healthA = { answering: true, own_origin: envA.server_url, env_reported: 'production' };

test('cfg() says whether a key is set and never hands it out', () => {
  const c = cfg();
  assert.equal(c.render, true);
  assert.equal(c.ownService, IDS.platform);
  assert.ok(!JSON.stringify(c).includes(KEY), 'no key in cfg()');
  for (const v of Object.values(c)) assert.notEqual(v, KEY);
  for (const bad of ['short', `rnd_${'x'.repeat(200)}`, 'rnd_with a space 0123456789abcdef', '']) {
    process.env.RENDER_API_KEY = bad;
    assert.equal(cfg().render, false, JSON.stringify(bad));
    assert.equal(makeRender(), null, 'no client without a key');
    assert.equal(sharedRender(), null);
  }
  process.env.RENDER_SERVICE_ID = '../../owners';
  assert.equal(cfg().ownService, '', 'an id that isn’t one counts as none');
  listenerEnv();
});

test('the stand-in address is for tests only: 127.0.0.1, OPS_ALLOW_LOCAL, and never on Render', () => {
  assert.equal(cfg().renderApi, fake.base);
  for (const [k, v] of [['OPS_RENDER_API', 'http://localhost:5608/v1'], ['OPS_RENDER_API', 'https://api.example.org/v1'], ['OPS_RENDER_API', 'http://127.0.0.1.example.org/v1'],
    ['OPS_RENDER_API', 'http://user:pw@127.0.0.1:5608/v1'], ['OPS_ALLOW_LOCAL', ''], ['RENDER', 'true']]) {
    listenerEnv();
    process.env[k] = v;
    assert.equal(cfg().renderApi, '', `${k}=${v}`);
  }
  listenerEnv();
});

test('on Render the key goes to Render’s API host, over TLS, in one header, whatever else is set', async () => {
  listenerEnv();
  process.env.RENDER = 'true';
  const seen = [];
  const real = https.request;
  https.request = (options, onResponse) => {
    seen.push(options);
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      onResponse(res);
      res.emit('data', Buffer.from(JSON.stringify(world.service('base-platform'))));
      res.emit('end');
      req.emit('close');
    };
    req.destroy = () => {};
    return req;
  };
  try {
    const before = world.received.length;
    const me = await makeRender({ cacheMs: 0 }).self();
    assert.equal(me.ok, true);
    assert.equal(world.received.length, before, 'nothing went to the stand-in');
    assert.equal(seen.length, 1);
    const o = seen[0];
    assert.equal(o.host, 'api.render.com');
    assert.equal(o.port, 443);
    assert.equal(o.path, `/v1/services/${IDS.platform}`);
    assert.equal(o.method, 'GET');
    assert.equal(o.agent, false);
    assert.equal(o.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!('rejectUnauthorized' in o), 'TLS checking is never turned off');
    assert.deepEqual(Object.keys(o.headers).sort(), ['Authorization', 'accept', 'user-agent']);
  } finally { https.request = real; listenerEnv(); }
});

test('each read: its method and path, the key in the header, and only the cut-down answer', async () => {
  const c = client();
  const me = clean(await c.self());
  assert.deepEqual({ ...me, missing: undefined }, { ok: true, id: IDS.platform, ownerId: OWNER, repo: REPO, branch: 'production', build: 'ignore-scripts', missing: undefined });
  assert.deepEqual([lastCall().method, lastCall().path, lastCall().auth, lastCall().body], ['GET', `/services/${IDS.platform}`, `Bearer ${KEY}`, null]);

  const ws = clean(await c.workspaces());
  assert.deepEqual([ws.ok, ws.count, ws.label], [true, 1, 'base.win']);
  assert.equal(lastCall().path, '/owners?limit=20');

  const list = clean(await c.services());
  assert.equal(lastCall().path, `/services?ownerId=${OWNER}&limit=100`);
  assert.deepEqual(list.list.map((s) => s.name), ['base-platform', 'base-win-staging', 'base-win', 'base-win-a', 'base-win-b'], 'ours only');
  world.ignoreOwnerFilter = true;
  assert.equal((await client().services()).list.some((s) => s.name === 'base-win-stranger'), false, 'another workspace’s service is left out here, whatever Render sends');
  assert.equal((await client().databases()).list.some((d) => d.name === 'base-win-stranger-db'), false);
  world.ignoreOwnerFilter = false;

  const s = clean(await c.service(IDS.a));
  assert.deepEqual({ ...s, missing: undefined, createdAt: undefined }, {
    ok: true, id: IDS.a, name: 'base-win-a', type: 'web_service', ownerId: OWNER, repo: REPO, branch: 'production', auto: true, suspended: false,
    url: 'https://base-win-a.onrender.com', plan: 'starter', region: 'oregon', createdAt: undefined, missing: undefined,
  });
  assert.equal(lastCall().path, `/services/${IDS.a}`);

  const d = clean(await c.lastDeploy(IDS.a));
  assert.deepEqual([d.ok, d.state, d.commit], [true, 'live', 'd9130ae']);
  assert.equal(lastCall().path, `/services/${IDS.a}/deploys?limit=1`);
  assert.ok(!('message' in d));

  const dom = clean(await c.domains(IDS.first));
  assert.deepEqual(dom.list, [{ name: 'imaginesurrey.base.win', verified: true }, { name: 'imaginesurrey.ca', verified: false }]);
  assert.equal(lastCall().path, `/services/${IDS.first}/custom-domains?limit=20`);

  const dbs = clean(await c.databases());
  assert.equal(lastCall().path, `/postgres?ownerId=${OWNER}&limit=100`);
  assert.deepEqual(dbs.list.map((x) => x.name), ['base-platform-db', 'base-win-staging-db', 'base-win-db', 'base-win-a-db', 'base-win-b-db']);

  const db = clean(await c.database(IDS.aDb));
  assert.deepEqual({ ...db, missing: undefined, createdAt: undefined }, {
    ok: true, id: IDS.aDb, name: 'base-win-a-db', ownerId: OWNER, plan: 'basic_1gb', version: '16', region: 'oregon', status: 'available',
    createdAt: undefined, open: true, others: 1, missing: undefined,
  });
  assert.ok(!JSON.stringify(db).includes('203.0.113.7'), 'who may connect is a count, never the addresses');

  const bp = clean(await c.blueprints());
  assert.deepEqual(bp.list, [{ label: 'base', branch: 'main', autoSync: true }]);
  assert.equal(lastCall().path, '/blueprints?limit=20');
});

test('a long list is read page by page, five pages at most', async () => {
  const w = fakeWorld();
  for (let i = 0; i < 620; i += 1) w.services.push({ ...w.service('base-win-b'), id: `srv-extra${String(i).padStart(14, '0')}`, name: `base-win-x${i}` });
  const got = await makeRender({ send: w.send, cacheMs: 0 }).services();
  assert.equal(got.ok, true);
  assert.equal(got.list.length, 500);
  const pages = w.calls.filter((c) => c.path.startsWith('/services?'));
  assert.equal(pages.length, 5);
  assert.match(pages[1].path, /&cursor=c100$/);
  assert.deepEqual(w.forbidden, []);
});

test('isSet says set or not, never the value, and refuses a name off the list', async () => {
  const c = client();
  assert.deepEqual(clean(await c.isSet(IDS.a, 'BASE_TZ')), { ok: true, set: true });
  // Asked by its name today, then by its older name (shared/old-names.js).
  assert.deepEqual(world.received.slice(-2).map((x) => x.path), settingNames('BASE_TZ').map((n) => `/services/${IDS.a}/env-vars/${n}`));
  assert.deepEqual(await c.isSet(IDS.a, 'BASE_PLATFORM_PUBKEY'), { ok: true, set: false });
  const before = world.received.length;
  for (const name of ['DATABASE_URL', 'RESEND_API_KEY', 'BASE_TWO_STEP_KEY', 'GOOGLE_TOKEN_KEY', 'RENDER_API_KEY', 'BASE_SAMPLE', '', 'NODE_ENV/../DATABASE_URL']) {
    assert.equal((await c.isSet(IDS.a, name)).problem, 'not-allowed', name);
  }
  assert.equal(world.received.length, before, 'none of them was asked for');
  assert.ok(!READABLE.includes('DATABASE_URL'));
});

test('an id that isn’t an id never reaches the wire', async () => {
  const c = client();
  const before = world.received.length;
  for (const id of [`${IDS.a}/env-vars`, '../owners', `${IDS.a}?x=1`, `a@${IDS.a}`, 'srv-', 'SRV-ABCDEFGH', `${IDS.a}%2F..`, '', null, 42, `${IDS.a}\n`]) {
    for (const read of [c.service, c.lastDeploy, c.domains, c.database]) assert.equal((await read(id)).ok, false, String(id));
    assert.equal((await c.isSet(id, 'NODE_ENV')).ok, false);
  }
  assert.equal(world.received.length, before);
});

test('a change takes a checked target, never an id, and never a value from its caller', async () => {
  const c = client();
  const before = world.received.length;
  const lookalike = { kind: 'service', id: IDS.a, service: IDS.a, name: 'base-win-a', label: 'base-win-a', campaign: 'a' };
  for (const not of [IDS.a, lookalike, Object.freeze({ ...lookalike }), null, undefined]) {
    for (const change of [c.deploy, c.restart, c.addDomain, c.checkDomain, c.closeDatabase]) assert.equal((await change(not)).problem, 'not-allowed');
    assert.equal((await c.setOne(not, 'BASE_PLATFORM_PUBKEY')).problem, 'not-allowed');
  }
  assert.equal(world.received.length, before, 'nothing was sent');

  const got = await c.target(campaignA, envA, healthA);
  assert.equal(got.ok, true);
  const t = got.target;
  assert.ok(Object.isFrozen(t));
  assert.deepEqual([t.kind, t.id, t.name, t.campaign], ['service', IDS.a, 'base-win-a', 'a']);

  assert.deepEqual(await c.deploy(t), { ok: true });
  assert.deepEqual([lastCall().method, lastCall().path, lastCall().body], ['POST', `/services/${IDS.a}/deploys`, { clearCache: 'do_not_clear' }]);
  assert.deepEqual(await c.restart(t), { ok: true });
  assert.deepEqual([lastCall().method, lastCall().path, lastCall().body], ['POST', `/services/${IDS.a}/restart`, null]);

  // The value is base.win's public key, worked out inside; a second argument changes nothing.
  assert.deepEqual(await c.setOne(t, 'BASE_PLATFORM_PUBKEY', 'SENTINEL-TYPED-VALUE'), { ok: true });
  assert.deepEqual([lastCall().method, lastCall().path, lastCall().body], ['PUT', `/services/${IDS.a}/env-vars/BASE_PLATFORM_PUBKEY`, { value: pubkeyValue() }]);
  assert.equal(world.settingsOf(IDS.a).BASE_PLATFORM_PUBKEY, pubkeyValue());
  const sent = world.received.length;
  for (const key of ['BASE_TZ', 'BASE_PUBLIC_URL', 'DATABASE_URL', 'NODE_ENV', 'BASE_ENV', 'RESEND_API_KEY', 'BASE_SAMPLE']) {
    assert.equal((await c.setOne(t, key)).problem, 'not-allowed', key);
  }
  assert.equal(world.received.length, sent, 'no other setting can be written');
  // No usable signing key: nothing to set.
  const signing = process.env.PLATFORM_SIGNING_KEY;
  process.env.PLATFORM_SIGNING_KEY = 'short';
  assert.equal((await c.setOne(t, 'BASE_PLATFORM_PUBKEY')).problem, 'not-allowed');
  process.env.PLATFORM_SIGNING_KEY = signing;
  assert.equal(world.received.length, sent);

  assert.deepEqual(await c.addDomain(t), { ok: true });
  assert.deepEqual([lastCall().method, lastCall().path, lastCall().body], ['POST', `/services/${IDS.a}/custom-domains`, { name: 'a.base.win' }]);
  assert.deepEqual(await c.checkDomain(t), { ok: true });
  assert.deepEqual([lastCall().method, lastCall().path, lastCall().body], ['POST', `/services/${IDS.a}/custom-domains/a.base.win/verify`, null]);
  // A service target is not a database target.
  assert.equal((await c.closeDatabase(t)).problem, 'not-allowed');
});

test('closing a database sends back only what it read, without “anyone”', async () => {
  const c = client();
  const got = await c.target(campaignA, envA, healthA, { database: true });
  assert.equal(got.ok, true);
  assert.deepEqual([got.target.kind, got.target.id, got.target.name], ['database', IDS.aDb, 'base-win-a-db']);
  assert.equal((await c.deploy(got.target)).problem, 'not-allowed', 'a database target deploys nothing');
  world.database('base-win-a-db').ipAllowList.push({ cidrBlock: '::/0', description: 'everywhere (v6)' });
  assert.deepEqual(await c.closeDatabase(got.target), { ok: true });
  assert.deepEqual([lastCall().method, lastCall().path], ['PATCH', `/postgres/${IDS.aDb}`]);
  assert.deepEqual(lastCall().body, { ipAllowList: [{ cidrBlock: '203.0.113.7/32', description: 'the office' }] });
  assert.equal((await c.database(IDS.aDb)).open, false);
  // Closed already: nothing is sent.
  const before = world.received.filter((r) => r.method === 'PATCH').length;
  assert.deepEqual(await c.closeDatabase(got.target), { ok: true, already: true });
  assert.equal(world.received.filter((r) => r.method === 'PATCH').length, before);
  // An entry it can't read back exactly: it sends nothing.
  world.database('base-win-a-db').ipAllowList.push({ cidrBlock: '0.0.0.0/0', description: 'everywhere' }, { cidrBlock: 'not an address' });
  assert.equal((await c.closeDatabase(got.target)).problem, 'unexpected-answer');
  assert.equal(world.received.filter((r) => r.method === 'PATCH').length, before);
  world.database('base-win-a-db').ipAllowList = [{ cidrBlock: '203.0.113.7/32', description: 'the office' }];
});

test('every failure becomes a named problem, and Render’s own words never come back', async () => {
  const c = client();
  const on = new RegExp(`/services/${IDS.b}$`);
  for (const [status, problem] of [[401, 'refused-key'], [403, 'refused-key'], [409, 'conflict'], [400, 'invalid'], [422, 'invalid'], [402, 'payment'], [500, 'error'], [503, 'error']]) {
    world.refuse(status, { on });
    const r = clean(await c.service(IDS.b));
    assert.deepEqual(r, { ok: false, status, problem, unsure: false }, String(status));
  }
  assert.deepEqual(clean(await c.service('srv-nosuchservice000001')), { ok: false, status: 404, problem: 'not-found', unsure: false });
  // 429: one more try, then it works; twice in a row is "busy".
  world.refuse(429, { on });
  let before = world.received.length;
  assert.equal((await c.service(IDS.b)).ok, true);
  assert.equal(world.received.length, before + 2, 'one retry');
  world.refuse(429, { on, times: 2 });
  before = world.received.length;
  assert.deepEqual(await c.service(IDS.b), { ok: false, status: 429, problem: 'busy', unsure: false });
  assert.equal(world.received.length, before + 2, 'and only one');
  // A redirect is not followed.
  world.redirect({ on });
  before = world.received.length;
  assert.deepEqual(await c.service(IDS.b), { ok: false, status: 302, problem: 'error', unsure: false });
  assert.equal(world.received.length, before + 1);
  assert.ok(!world.received.some((r) => r.path.includes('elsewhere')));
  // Slow, and too big.
  world.slow(900, { on });
  assert.deepEqual(await c.service(IDS.b), { ok: false, status: null, problem: 'timeout', unsure: false });
  world.big({ on });
  assert.deepEqual(await c.service(IDS.b), { ok: false, status: null, problem: 'unexpected-answer', unsure: false });
  // A missing field, by our name for it; a string that isn't the shape it should be.
  world.dropField('ownerId', { on });
  assert.deepEqual(clean(await c.service(IDS.b)), { ok: false, status: 200, problem: 'unexpected-answer', unsure: false, field: 'ownerId' });
  world.up();
  const b = world.service('base-win-b');
  const was = { name: b.name, branch: b.branch, url: b.serviceDetails.url, plan: b.serviceDetails.plan };
  b.name = '<script>alert(1)</script>';
  assert.deepEqual(clean(await c.service(IDS.b)), { ok: false, status: 200, problem: 'unexpected-answer', unsure: false, field: 'name' });
  b.name = was.name;
  b.branch = 'production"><img src=x>';
  b.serviceDetails.url = 'javascript:alert(1)';
  b.serviceDetails.plan = 'SENTINEL-RENDER-BODY plan';
  b.suspended = 'maybe';
  const odd = clean(await c.service(IDS.b));
  assert.deepEqual([odd.ok, odd.branch, odd.url, odd.plan, odd.suspended], [true, null, null, null, null], 'anything else becomes null');
  assert.deepEqual(odd.missing.sort(), ['branch', 'serviceDetails.plan', 'serviceDetails.url', 'suspended']);
  Object.assign(b, { branch: was.branch, suspended: 'not_suspended' });
  Object.assign(b.serviceDetails, { url: was.url, plan: was.plan });
});

test('a change with no answer is “unsure”; one Render refused is not', async () => {
  const c = client();
  const { target: t } = await c.target(campaignA, envA, healthA);
  const on = /\/restart$/;
  world.madeButTimedOut({ on });
  assert.deepEqual(await c.restart(t), { ok: false, status: null, problem: 'error', unsure: true });
  world.madeButSaid(500, { on });
  assert.deepEqual(clean(await c.restart(t)), { ok: false, status: 500, problem: 'error', unsure: true });
  world.slow(900, { on });
  assert.deepEqual(await c.restart(t), { ok: false, status: null, problem: 'timeout', unsure: true });
  world.refuse(409, { on });
  assert.deepEqual(clean(await c.restart(t)), { ok: false, status: 409, problem: 'conflict', unsure: false });
  await new Promise((r) => setTimeout(r, 700)); // the slow one finishes
});

test('the control centre’s own service: missing, or in another workspace', async () => {
  const c = client();
  process.env.RENDER_SERVICE_ID = 'srv-notinthisworkspace1';
  assert.deepEqual(await c.self(), { ok: false, status: 404, problem: 'other-workspace', unsure: false });
  assert.equal((await c.services()).problem, 'other-workspace', 'and then nothing is listed');
  assert.equal((await c.target(campaignA, envA, healthA)).problem, 'other-workspace');
  delete process.env.RENDER_SERVICE_ID;
  assert.equal((await c.self()).problem, 'no-own-id');
  listenerEnv();
  // The build command sits in one of two places; either is read, and only whether it is the right one is kept.
  const p = world.service('base-platform');
  const details = p.serviceDetails;
  p.serviceDetails = { ...details, envSpecificDetails: {}, buildCommand: 'npm ci --omit=dev' };
  assert.equal((await c.self()).build, 'other');
  p.serviceDetails = { ...details, envSpecificDetails: { buildCommand: 'npm ci --omit=dev --ignore-scripts && echo SENTINEL-RENDER-BODY' } };
  assert.equal(clean(await c.self()).build, 'other');
  p.serviceDetails = details;
});

test('Check Render’s answers: each read is “as expected”, or names what is missing', async () => {
  const c = client();
  const first = await c.check();
  assert.deepEqual(first.map((l) => l.call), ['self', 'workspaces', 'services', 'databases', 'blueprints'], 'before the sample is connected: the reads that need no campaign');
  assert.ok(first.every((l) => l.ok), JSON.stringify(first));
  const all = clean(await c.check({ service: IDS.staging, database: IDS.stagingDb }));
  assert.deepEqual(all.map((l) => l.call), ['self', 'workspaces', 'services', 'databases', 'blueprints', 'service', 'lastDeploy', 'domains', 'isSet', 'database']);
  assert.ok(all.every((l) => l.ok && !l.fields.length), JSON.stringify(all));
  world.dropField('suspended').dropField('verificationStatus').dropField('ipAllowList');
  const odd = clean(await c.check({ service: IDS.staging, database: IDS.stagingDb }));
  const by = Object.fromEntries(odd.map((l) => [l.call, l]));
  assert.deepEqual([by.service.ok, by.service.fields], [false, ['suspended']]);
  assert.deepEqual([by.domains.ok, by.domains.problem, by.domains.fields], [false, 'unexpected-answer', ['verificationStatus']]);
  assert.deepEqual([by.database.ok, by.database.fields], [false, ['ipAllowList']]);
  world.up();
  // Render has no way to read one setting alone: the one every service has comes back "not set".
  world.refuse(404, { on: /env-vars/, times: Infinity });
  const none = await c.check({ service: IDS.staging, database: IDS.stagingDb });
  assert.deepEqual(none.find((l) => l.call === 'isSet').fields, ['one setting read alone']);
  world.up();
});

test('what was read is kept a minute, cut down; a failure is not kept; a change is always checked afresh', async () => {
  const w = fakeWorld();
  const c = makeRender({ send: w.send });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await c.service(IDS.a)).name, 'base-win-a');
    assert.equal((await c.lastDeploy(IDS.a)).state, 'live');
    assert.deepEqual(await c.isSet(IDS.a, 'BASE_TZ'), { ok: true, set: true });
  }
  assert.equal(w.calls.length, 4, 'asked once each (the setting by both of its names)');
  c.forget();
  await c.service(IDS.a);
  assert.equal(w.calls.length, 5, 'forgotten after a change: asked again');
  w.refuse(500, { on: /custom-domains/ });
  assert.equal((await c.domains(IDS.a)).ok, false);
  assert.equal((await c.domains(IDS.a)).ok, true, 'a failure is not kept');
  // A target is read from Render at that moment, whatever was kept.
  await c.self();
  const before = w.calls.length;
  const got = await c.target(campaignA, envA, healthA);
  assert.equal(got.ok, true);
  assert.deepEqual(w.calls.slice(before).map((x) => x.path), [`/services/${IDS.platform}`, `/services/${IDS.a}`]);
  w.service('base-win-a').branch = 'main';
  assert.equal((await c.target(campaignA, envA, healthA)).ok, false, 'a change made in Render a second ago is seen');
  assert.deepEqual(w.forbidden, []);
});

test('what a new campaign is made as: the same words as the wizard’s block and render.yaml', () => {
  const m = SHAPES.make;
  const snippet = renderSnippet({ name: 'x', display: 'X', values: campaignA.values });
  for (const line of [`plan: ${m.servicePlan}`, `region: ${m.region}`, `branch: ${m.branch}`, `runtime: ${m.runtime}`, `dockerfilePath: ${m.dockerfilePath}`,
    `dockerContext: ${m.dockerContext}`, `healthCheckPath: ${m.healthCheckPath}`, 'autoDeploy: true', `plan: ${m.databasePlan}`, `postgresMajorVersion: "${m.postgres}"`]) {
    assert.ok(snippet.includes(`    ${line}\n`) || snippet.endsWith(`    ${line}`), `the wizard’s block: ${line}`);
  }
  assert.equal(m.autoDeploy, 'yes');
  assert.equal(m.databasePlanApi, m.databasePlan.replace('-', '_'));
  const yaml = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
  const at = yaml.indexOf('    name: base-win\n');
  assert.ok(at > 0);
  const production = yaml.slice(at, yaml.indexOf('\n  - type: web', at));
  for (const line of [`plan: ${m.servicePlan}`, `region: ${m.region}`, `branch: ${m.branch}`, `runtime: ${m.runtime}`, `dockerfilePath: ${m.dockerfilePath}`,
    `dockerContext: ${m.dockerContext}`, `healthCheckPath: ${m.healthCheckPath}`]) {
    assert.match(production, new RegExp(`^    ${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*(#.*)?$`, 'm'), `render.yaml’s production block: ${line}`);
  }
  assert.match(yaml.slice(yaml.indexOf('\ndatabases:')), new RegExp(`- name: base-win-db\\n\\s+plan: ${m.databasePlan}\\b[^\\n]*\\n\\s+region: ${m.region}\\n\\s+postgresMajorVersion: "${m.postgres}"`));
  const platform = yaml.slice(yaml.indexOf('name: base-platform\n'), yaml.indexOf('\ndatabases:'));
  assert.match(platform, new RegExp(`^    buildCommand: ${SHAPES.platformBuild}\\s*(#.*)?$`, 'm'), 'render.yaml builds the control centre the way the Render page checks for');
  assert.equal(Object.keys(CALLS).length, 19, 'stage 1’s sixteen and stage 2’s three');
});

test('a create Render answered (2xx) but whose answer can’t be read is “unsure”, never “refused”', async () => {
  const c = client();
  const x = { ...campaignA, name: 'xr', display: 'Example XR' };
  const envX = { campaign: 'xr', env: 'production', server_url: null, instance: null, render_service: null, render_db: null };
  const got = await c.makeTarget(x, envX, { shapes: c.makeShapes, owner: OWNER });
  assert.equal(got.ok, true);
  const on = /^POST \/postgres$/;
  world.madeButUnreadable({ on });
  assert.deepEqual(clean(await c.makeDatabase(got.target)), { ok: false, status: 201, problem: 'unexpected-answer', unsure: true });
  world.madeButBig({ on });
  assert.deepEqual(clean(await c.makeDatabase(got.target)), { ok: false, status: null, problem: 'unexpected-answer', unsure: true });
  assert.equal(world.databases.filter((d) => d.name === 'base-win-xr-db').length, 2, 'Render made it both times');
  // Render refused it: sure, nothing was made.
  world.refuse(422, { on });
  assert.deepEqual(clean(await c.makeDatabase(got.target)), { ok: false, status: 422, problem: 'invalid', unsure: false });
  world.up();
  world.databases = world.databases.filter((d) => d.name !== 'base-win-xr-db');
});

test('the stand-in was never asked for anything forbidden, and always got the key', () => {
  assert.deepEqual(world.forbidden, []);
  assert.ok(world.received.length > 50);
  assert.ok(world.received.every((r) => r.auth === `Bearer ${KEY}`), 'every request carried the key, in the one header');
  for (const r of world.received) {
    const rest = { ...r.headers };
    delete rest.authorization;
    assert.ok(!JSON.stringify([r.path, r.body, rest]).includes(KEY), 'and nowhere else');
  }
  assert.ok(world.received.every((r) => ['GET', 'POST', 'PUT', 'PATCH'].includes(r.method)));
});
