// The Render pages and the one route every change goes through, over the
// in-memory stand-in for Render (fake-render.mjs), with the real client.
//   The code: every change needs one from the app, typed for that change.
//     The 10-minute window opens nothing, a recovery code is turned away
//     unspent, a wrong code is logged, an old or borrowed page does nothing,
//     and a second press does nothing twice.
//   The guard: a campaign connects only to the one service at its own
//     address, in base.win's workspace and repository, of the right kind.
//   Each change: the exact requests, "Asked Render to…" on the log before
//     and the result after, the read-back, then back to the page.
//   One change at a time per campaign; 6 an hour per campaign; 30 a day.
// Every test ends with nothing forbidden asked of Render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './helpers.mjs';
import { fakeWorld, IDS, OTHER_OWNER, SENTINELS, KEY } from './fake-render.mjs';
import { rig, ADDR } from './render-rig.mjs';
import { CALLS } from '../render-api.mjs';
import { pubkeyValue } from '../keys.mjs';
import { verifyLog } from '../log.mjs';
import { wordsFor } from '../words.mjs';

// Every request made is a row of the table, none makes or removes anything,
// and the stand-in saw nothing it calls forbidden.
const rows = Object.values(CALLS).map(([method, path]) => [method, new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{cursor\\?\}/, '(&cursor=[A-Za-z0-9_=-]+)?').replace(/\{\w+\}/g, '[^/?]+')}$`)]);
const clean = (world) => {
  assert.deepEqual(world.forbidden, []);
  for (const c of world.calls) {
    assert.ok(rows.some(([m, re]) => m === c.method && re.test(c.path)), `${c.method} ${c.path} is not in the table`);
    assert.ok(!(c.method === 'POST' && /^\/(services|postgres)$/.test(c.path)), 'nothing is made');
    assert.ok(!c.path.includes('connection-info'));
    assert.notEqual(c.method, 'DELETE');
  }
};
const A_SVC = `/services/${IDS.a}`;

test('with a key: Render in the menu, the board, and the link on a campaign’s page; nothing is asked of Render until someone looks', async () => {
  const r = await rig();
  assert.deepEqual(r.calls(), [], 'adding campaigns and checking their health asked Render nothing');
  for (const path of ['/', '/c/a', '/log', '/key', '/new']) {
    const p = await r.page(path);
    assert.match(p.body, /<a href="\/render">Render<\/a>/, `${path}: Render is in the menu`);
  }
  assert.match((await r.page('/c/a')).body, /<a class="btn btn-quiet" href="\/c\/a\/render">Render: service, deploys, database<\/a>/);
  assert.deepEqual(r.calls(), [], 'none of those pages asked Render anything');
  const board = await r.page('/render');
  assert.equal(board.status, 200);
  assert.match(board.body, /Connected to Render: base\.win/);
  assert.match(board.body, /aria-current="page">Render<\/a>/);
  for (const display of ['Sample \\(staging\\)', 'Example A', 'Example B', 'Imagine Surrey']) assert.match(board.body, new RegExp(`${display}</a> <span class="oc-line">Not connected</span>`));
  assert.match(board.body, /Blueprint: listed, follows main, Auto Sync on/);
  assert.match(board.body, /Nothing needs a look\./);
  assert.ok(r.calls().every((c) => c.startsWith('GET ')), 'the board only reads');
  assert.ok(!board.body.includes('SENTINEL'), 'nothing of Render’s own words or secrets');
  assert.equal([...board.body.matchAll(/btn-primary/g)].length, 0);
  // Not connected: one campaign's page offers Connect and asks Render nothing yet.
  r.mark();
  const one = await r.page('/c/a/render');
  assert.match(one.body, /Not connected/);
  assert.match(one.body, /<form method="post" action="\/c\/a\/render\/link"/);
  assert.deepEqual(r.calls(), []);
  // The other buttons don't exist before Connect.
  for (const what of ['deploy', 'restart', 'key', 'domain', 'close-db']) assert.equal((await r.b.post(`/c/a/render/${what}`, {})).status, 404, what);
  assert.equal((await r.b.post('/c/a/render/set', {})).status, 404, 'no “set a setting” route');
  assert.equal((await r.b.post('/c/a/render/make', {})).status, 404, 'no “make” route');
  assert.equal((await r.b.post('/c/a/render/delete', {})).status, 404);
  assert.equal((await r.b.post('/c/nobody/render/link', {})).status, 404);
  assert.equal((await r.b.get('/c/nobody/render')).status, 404);
  clean(r.world);
});

test('no session: off to sign in; a form from elsewhere: refused', async () => {
  const r = await rig({ campaigns: ['a'] });
  const stranger = browser(r.app);
  for (const path of ['/render', '/c/a/render']) {
    const res = await stranger.get(path);
    assert.deepEqual([res.status, res.headers.get('location')], [303, '/signin'], path);
  }
  for (const path of ['/render/check', '/c/a/render/link', '/c/a/render/deploy']) {
    const res = await stranger.post(path, {});
    assert.deepEqual([res.status, res.headers.get('location')], [303, '/signin'], path);
    assert.equal((await r.b.post(path, {}, { headers: { origin: 'https://evil.example.org' } })).status, 403, `${path} from another site`);
    assert.equal((await r.b.post(path, {}, { headers: { 'content-type': 'application/json' } })).status, 415, `${path} as JSON`);
  }
  assert.deepEqual(r.calls(), []);
  assert.deepEqual(await r.jobs('a'), []);
  clean(r.world);
});

test('Connect: the confirm page names the service and its database; a code saves the two ids and changes nothing in Render', async () => {
  const r = await rig();
  const asked = await r.ask('a', 'link');
  assert.equal(asked.res.status, 200);
  assert.match(asked.body, /<h1>Connect to Render<\/h1>/);
  assert.ok(asked.body.replace(/\s+/g, ' ').includes('Service: base-win-a, https://base-win-a.onrender.com, production branch. Database: base-win-a-db.'));
  assert.match(asked.body, /Nothing in Render changes\./);
  assert.equal([...asked.body.matchAll(/btn-primary/g)].length, 1, 'one primary: Connect');
  assert.match(asked.body, /name="code"[^>]*required/);
  assert.match(asked.body, /href="\/c\/a\/render">Cancel/);
  assert.equal((await r.env('a')).render_service, null, 'asking saves nothing');
  const [job] = await r.jobs('a');
  assert.deepEqual([job.what, job.state, job.target, job.id], ['link', 'asked', IDS.a, asked.job]);
  const res = await r.b.post('/c/a/render/link', { job: asked.job, code: await r.code() });
  assert.deepEqual([res.status, res.headers.get('location')], [303, '/c/a/render']);
  const env = await r.env('a');
  assert.deepEqual([env.render_service, env.render_db], [IDS.a, IDS.aDb]);
  const [line] = await r.log('render.link');
  assert.deepEqual(line.payload, { env: 'production', what: 'link', job: asked.job.slice(0, 12), service: IDS.a, label: 'base-win-a', database: 'base-win-a-db' });
  assert.equal(wordsFor('render.link', line.payload), 'Connected to Render: base-win-a and base-win-a-db');
  assert.deepEqual(r.writes(), [], 'Connect changes nothing in Render');
  // The sample connects to staging's service, and only to that.
  await r.connect('sample');
  const sample = await r.env('sample');
  assert.deepEqual([sample.render_service, sample.render_db], [IDS.staging, IDS.stagingDb]);
  // A campaign whose database isn't found by name still connects; Close isn't offered.
  r.world.database('base-win-b-db').name = 'some-other-name';
  const b = await r.ask('b', 'link');
  assert.match(b.body, /Database: none found/);
  await r.b.post('/c/b/render/link', { job: b.job, code: await r.code() });
  assert.deepEqual([(await r.env('b')).render_service, (await r.env('b')).render_db], [IDS.b, null]);
  assert.match((await r.page('/c/b/render')).body, /<dt>Database<\/dt><dd>No database found/);
  assert.equal((await r.b.post('/c/b/render/close-db', {})).status, 404);
  // Changing the campaign's address forgets the ids with the pin.
  const edit = await r.b.post('/c/a/edit', { display: 'Example A', server_url: 'https://base-win-a-moved.onrender.com' });
  assert.equal(edit.status, 303);
  const moved = await r.env('a');
  assert.deepEqual([moved.render_service, moved.render_db, moved.instance], [null, null, null]);
  assert.equal((await verifyLog(r.db)).ok, true);
  clean(r.world);
});

test('the guard at Connect: only the one service at this campaign’s address, in base.win’s workspace and repository, of the right kind', async () => {
  const r = await rig();
  const w = r.world;
  const a = w.service('base-win-a');
  const refused = async (words, name = 'a') => {
    const asked = await r.ask(name, 'link');
    assert.equal(asked.res.status, 409, words);
    assert.ok(asked.body.includes(words), `${words}\n${asked.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400)}`);
    assert.equal(asked.job, null);
    assert.equal((await r.env(name)).render_service, null);
    assert.deepEqual(await r.jobs(name), [], 'no job is made for a refusal');
  };
  // Staging's service at this client's address.
  const staging = w.service('base-win-staging');
  const was = { a: a.serviceDetails.url, staging: staging.serviceDetails.url, platform: w.service('base-platform').serviceDetails.url };
  a.serviceDetails.url = 'https://elsewhere.onrender.com';
  staging.serviceDetails.url = ADDR.a;
  await refused('This is staging’s service. It can’t be a client’s.');
  staging.serviceDetails.url = was.staging;
  // The control centre's own.
  w.service('base-platform').serviceDetails.url = ADDR.a;
  await refused('This is the control centre’s own service. Nothing here changes it.');
  w.service('base-platform').serviceDetails.url = was.platform;
  // No service at the address.
  await refused('No service in Render has this campaign’s address: check the address on Edit.');
  a.serviceDetails.url = was.a;
  // Two at one address.
  w.services.push({ ...a, id: 'srv-twin0000000000000001', name: 'base-win-twin' });
  await refused('Two services in Render have this address: look in Render.');
  w.services.pop();
  // On main, not production.
  a.branch = 'main';
  await refused('This service isn’t on the production branch: look in Render.');
  a.branch = 'production';
  // Another repository.
  a.repo = 'https://github.com/someone-else/fork';
  await refused('This service isn’t built from base.win’s repository.');
  a.repo = w.service('base-win-b').repo;
  // Another workspace: it isn't even listed, whatever Render sends.
  a.ownerId = OTHER_OWNER;
  w.ignoreOwnerFilter = true;
  await refused('No service in Render has this campaign’s address: check the address on Edit.');
  w.ignoreOwnerFilter = false;
  a.ownerId = w.service('base-win-b').ownerId;
  // Suspended.
  a.suspended = 'suspended';
  await refused('Suspended in Render: resume it there.');
  a.suspended = 'not_suspended';
  // Not a campaign's service by name.
  a.name = 'some-other-app';
  await refused('This isn’t a campaign’s service in Render.');
  a.name = 'base-win-a';
  // The server says it is somewhere else.
  r.health.a = { ...r.answer('a'), ownOrigin: 'https://another.onrender.com' };
  await r.b.post('/c/a/check-now', {});
  await refused('This server says it is somewhere else: check the Render address saved here.');
  r.health.a = r.answer('a');
  await r.b.post('/c/a/check-now', {});
  // The sample connects to staging only: a client's service at its address is refused.
  staging.serviceDetails.url = 'https://elsewhere.onrender.com';
  a.serviceDetails.url = ADDR.sample;
  await refused('The sample connects to staging’s service only.', 'sample');
  a.serviceDetails.url = was.a;
  staging.serviceDetails.url = was.staging;
  // An archived campaign connects to nothing.
  await r.b.post('/c/b/archive', {});
  await refused('This campaign is archived. Bring it back first.', 'b');
  // A server not answering does not block (that is when Restart is wanted).
  r.health.a = null;
  await r.b.post('/c/a/check-now', {});
  assert.equal((await r.ask('a', 'link')).res.status, 200);
  assert.deepEqual(r.writes(), []);
  clean(w);
});

test('the code: the 10-minute window opens nothing, a recovery code is turned away unspent, a wrong code is logged', async () => {
  const r = await rig({ campaigns: ['a'] });
  await r.connect('a');
  const asked = await r.ask('a', 'restart');
  assert.equal(asked.res.status, 200);
  // The window is fresh (a code was typed seconds ago) and that is not enough.
  assert.ok((await r.db.query('select extract(epoch from now() - code_at)::float8 as age from ops_sessions')).rows[0].age < 60);
  r.mark();
  let res = await r.b.post('/c/a/render/restart', { job: asked.job });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /Render changes take a code every time\./);
  res = await r.b.post('/c/a/render/restart', { job: asked.job, code: '   ' });
  assert.equal(res.status, 401);
  // A recovery code: refused before it is spent.
  const left = (await r.db.query('select jsonb_array_length(recovery) as n from operators')).rows[0].n;
  res = await r.b.post('/c/a/render/restart', { job: asked.job, code: r.op.codes[0] });
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.match(body, /Use the code from your app\. A recovery code signs you in; it doesn’t change anything in Render\./);
  assert.match(body, new RegExp(`name="job" value="${asked.job}"`), 'the same page comes back');
  assert.equal((await r.db.query('select jsonb_array_length(recovery) as n from operators')).rows[0].n, left, 'the recovery code is still unused');
  assert.equal((await r.log('recovery.used')).length, 0);
  // A wrong code.
  res = await r.b.post('/c/a/render/restart', { job: asked.job, code: '000000' });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /That code didn’t work\. Type the one your app shows now\./);
  assert.deepEqual(r.calls(), [], 'nothing at all was asked of Render');
  const denied = await r.log('render.denied');
  assert.equal(denied.length, 4);
  assert.deepEqual(denied[3].payload, { env: 'production', what: 'restart', job: asked.job.slice(0, 12), problem: 'code', service: IDS.a, label: 'base-win-a' });
  assert.equal(wordsFor('render.denied', denied[3].payload), 'Refused a Render change: wrong code');
  assert.equal((await r.jobs('a')).find((j) => j.id === asked.job).state, 'asked', 'the page can still be used');
  // The right code, on the same page: done once. The same code again does nothing.
  const code = await r.code();
  res = await r.b.post('/c/a/render/restart', { job: asked.job, code });
  assert.equal(res.status, 303);
  assert.deepEqual(r.writes().map((c) => `${c.method} ${c.path}`), [`POST ${A_SVC}/restart`]);
  assert.equal((await r.log('stepup')).length >= 2, true, 'the typed code is on the log like any other');
  clean(r.world);
});

test('an old page does nothing: another session’s, another campaign’s, a used one, one over 5 minutes old; a second press does nothing twice', async () => {
  const r = await rig({ campaigns: ['a', 'b'] });
  await r.connect('a', 'b');
  const old = async (res) => {
    assert.equal(res.status, 409);
    assert.match(await res.text(), /That page is old\. Start again\./);
  };
  // Another session's page.
  const other = await r.other();
  let asked = await r.ask('a', 'restart');
  r.mark();
  await old(await other.post('/c/a/render/restart', { job: asked.job, code: await r.code() }));
  // Another campaign's page, another change's page.
  await old(await r.b.post('/c/b/render/restart', { job: asked.job, code: await r.code() }));
  await old(await r.b.post('/c/a/render/deploy', { job: asked.job, code: await r.code() }));
  // A made-up job.
  await old(await r.b.post('/c/a/render/restart', { job: 'f'.repeat(32), code: await r.code() }));
  await old(await r.b.post('/c/a/render/restart', { job: `${asked.job}' or '1'='1`, code: await r.code() }));
  // Over 5 minutes old.
  await r.db.query("update render_jobs set asked_at = now() - interval '6 minutes' where id = $1", [asked.job]);
  await old(await r.b.post('/c/a/render/restart', { job: asked.job, code: await r.code() }));
  assert.deepEqual(r.calls(), [], 'none of them asked Render anything');
  assert.equal((await r.log('render.denied')).filter((l) => l.payload.problem === 'old').length, 6);
  assert.equal(wordsFor('render.denied', { problem: 'old' }), 'Refused a Render change: old page');
  // A second press: one restart.
  asked = await r.ask('a', 'restart');
  const first = await r.b.post('/c/a/render/restart', { job: asked.job, code: await r.code() });
  assert.equal(first.status, 303);
  await old(await r.b.post('/c/a/render/restart', { job: asked.job, code: await r.code() }));
  assert.deepEqual(r.world.restarts, [IDS.a], 'one restart');
  // Two presses at the very same moment: one restart.
  r.again();
  asked = await r.ask('a', 'restart');
  const code = await r.code();
  const both = await Promise.all([r.b.post('/c/a/render/restart', { job: asked.job, code }), r.b.post('/c/a/render/restart', { job: asked.job, code })]);
  assert.equal(both.filter((x) => x.status === 303).length, 1, 'one of the two went through');
  assert.deepEqual(r.world.restarts, [IDS.a, IDS.a]);
  // Asked pages over an hour old are swept at the next ask.
  await r.db.query("update render_jobs set asked_at = now() - interval '2 hours' where state = 'asked'");
  await r.ask('a', 'restart');
  assert.equal((await r.db.query("select count(*)::int as n from render_jobs where state = 'asked'")).rows[0].n, 1);
  clean(r.world);
});

test('each change: the exact requests, the log line before and the result after, the read-back, then back to the page', async () => {
  const r = await rig({ campaigns: ['a', 'sample'] });
  await r.connect('a', 'sample');
  const page = async () => (await r.page('/c/a/render')).body;
  const lines = async () => (await r.log()).filter((l) => l.action !== 'render.link').map((l) => [l.action, l.payload.what, l.payload.ok ?? null]);
  let body = await page();
  assert.match(body, /<dt>Service<\/dt><dd>base-win-a · production branch · Starter · Oregon · deploys by itself/);
  assert.match(body, /<dt>Last deploy<\/dt><dd>Live · d9130ae · /);
  assert.match(body, /<dt>Addresses<\/dt><dd>a\.base\.win · Not added yet/);
  assert.match(body, /<dt>Settings<\/dt><dd>Missing: BASE_PLATFORM_PUBKEY/);
  assert.match(body, /Email, texting and Google keys are not read here/);
  assert.match(body, /<dt>Database<\/dt><dd>base-win-a-db · Basic 1 GB · PostgreSQL 16 · Open to anyone on the internet/);
  assert.match(body, /href="https:\/\/dashboard\.render\.com\/web\/srv-clienta000000000001" rel="noreferrer"/);
  for (const [what, words] of [['deploy', 'Deploy latest'], ['restart', 'Restart'], ['key', 'Set base.win’s key'], ['domain', 'Add its address'], ['close-db', 'Close the database to the internet']]) {
    assert.match(body, new RegExp(`action="/c/a/render/${what}"[^>]*>\\s*<button class="btn btn-quiet" type="submit">${words}</button>`), words);
  }
  assert.equal([...body.matchAll(/btn-primary/g)].length, 0, 'the page’s buttons are quiet: the primary is the confirm page’s');
  assert.ok(!body.includes('SENTINEL') && !body.includes('203.0.113.7'), 'no value, no address of who may connect');

  // Set base.win's key: set, read back, deploy.
  let asked = await r.ask('a', 'key');
  assert.ok(asked.body.replace(/\s+/g, ' ').includes('Sets BASE_PLATFORM_PUBKEY on base-win-a to base.win’s key, then deploys (2 to 3 minutes). After that, Open desk works. No other setting is touched.'));
  assert.equal([...asked.body.matchAll(/btn-primary/g)].length, 1);
  r.mark();
  const before = (await r.log()).length;
  let res = await r.b.post('/c/a/render/key', { job: asked.job, code: await r.code(), value: 'SENTINEL-TYPED-VALUE', key: 'DATABASE_URL', setting: 'DATABASE_URL' });
  assert.deepEqual([res.status, res.headers.get('location')], [303, '/c/a/render']);
  assert.deepEqual(r.calls(), [
    `GET /services/${IDS.platform}`, `GET ${A_SVC}`,
    `PUT ${A_SVC}/env-vars/BASE_PLATFORM_PUBKEY`, `GET ${A_SVC}/env-vars/BASE_PLATFORM_PUBKEY`, `POST ${A_SVC}/deploys`,
  ], 'the service is read again, then set, read back, deploy');
  assert.deepEqual(r.writes().map((c) => c.body), [{ value: pubkeyValue() }, { clearCache: 'do_not_clear' }], 'the value is base.win’s public key; nothing typed is sent');
  const two = (await r.log()).slice(before).filter((l) => l.action.startsWith('render.'));
  assert.deepEqual(two.map((l) => l.action), ['render.start', 'render.result']);
  assert.deepEqual(two[0].payload, { env: 'production', what: 'key', job: asked.job.slice(0, 12), service: IDS.a, label: 'base-win-a', setting: 'BASE_PLATFORM_PUBKEY' });
  assert.deepEqual(two[1].payload, { ...two[0].payload, ok: true });
  assert.deepEqual([wordsFor('render.start', two[0].payload), wordsFor('render.result', two[1].payload)], ['Asked Render to set base.win’s key', 'Render did it']);
  assert.ok(r.asked.at(-1).includes('a.base.win') || r.asked.at(-1).startsWith(ADDR.a), 'the campaign’s health is checked again afterwards');
  body = await page();
  assert.match(body, /Render did it\. A new version takes 2 to 3 minutes to go live\./);
  assert.match(body, /<dt>Last deploy<\/dt><dd>Deploying · c41f2aa/);
  assert.match(body, /<dt>Settings<\/dt><dd>Nothing missing/);
  assert.doesNotMatch(body, /render\/key"/, 'the button goes once the key is set');

  // Deploy: refused while one is running.
  asked = await r.ask('a', 'deploy');
  assert.equal(asked.res.status, 409);
  assert.match(asked.body, /A deploy is already running there\. Wait for it to finish\./);
  r.world.finishDeploys(IDS.a);
  asked = await r.ask('a', 'deploy');
  assert.ok(asked.body.replace(/\s+/g, ' ').includes('Render builds the newest version on the production branch and switches to it when ready, in 2 to 3 minutes. Nothing in the database changes. Best outside canvassing hours.'));
  r.mark();
  res = await r.b.post('/c/a/render/deploy', { job: asked.job, code: await r.code() });
  assert.equal(res.status, 303);
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [['POST', `${A_SVC}/deploys`, { clearCache: 'do_not_clear' }]]);
  r.world.finishDeploys(IDS.a);

  // Restart.
  asked = await r.ask('a', 'restart');
  assert.ok(asked.body.replace(/\s+/g, ' ').includes('The server stops and starts on the same version. It may not answer for a minute. Nothing saved is lost. Use it when the campaign has stopped answering.'));
  r.mark();
  res = await r.b.post('/c/a/render/restart', { job: asked.job, code: await r.code() });
  assert.equal(res.status, 303);
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [['POST', `${A_SVC}/restart`, null]]);

  // Add its address: add, then read the list back.
  asked = await r.ask('a', 'domain');
  assert.ok(asked.body.replace(/\s+/g, ' ').includes('Adds a.base.win to base-win-a. Then, where base.win’s domain is registered, add a CNAME named a pointing at base-win-a.onrender.com.'));
  r.mark();
  res = await r.b.post('/c/a/render/domain', { job: asked.job, code: await r.code(), name: 'evil.example.org', host: 'evil.example.org' });
  assert.equal(res.status, 303);
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [['POST', `${A_SVC}/custom-domains`, { name: 'a.base.win' }]], 'the address is built from the short name, never typed');
  assert.equal(r.calls().at(-1), `GET ${A_SVC}/custom-domains?limit=20`, 'read back');
  body = await page();
  assert.match(body, /<dt>Addresses<\/dt><dd>a\.base\.win · Waiting for the DNS record/);
  assert.match(body, /Check the address again/);
  assert.equal(wordsFor('render.start', (await r.log('render.start')).at(-1).payload), 'Asked Render to add a.base.win');
  // Check the address again: once the DNS record is there, Render says verified.
  r.again();
  r.world.dnsReady = ['a.base.win'];
  asked = await r.ask('a', 'domain');
  assert.match(asked.body, /<h1>Check the address again<\/h1>/);
  r.mark();
  res = await r.b.post('/c/a/render/domain', { job: asked.job, code: await r.code() });
  assert.deepEqual(r.writes().map((c) => [c.method, c.path, c.body]), [['POST', `${A_SVC}/custom-domains/a.base.win/verify`, null]]);
  body = await page();
  assert.match(body, /<dt>Addresses<\/dt><dd>a\.base\.win · Verified/);
  assert.doesNotMatch(body, /render\/domain"/);
  // The sample gets no address: there is no such change for it.
  assert.equal((await r.b.post('/c/sample/render/domain', {})).status, 404);

  // Close the database: the list read, sent back without "anyone", read back.
  asked = await r.ask('a', 'close-db');
  assert.ok(asked.body.replace(/\s+/g, ' ').includes('Removes ‘anywhere’ from who may connect to base-win-a-db. The campaign’s own server still connects. A database tool on your own computer stops connecting until you add its address in Render.'));
  r.mark();
  res = await r.b.post('/c/a/render/close-db', { job: asked.job, code: await r.code() });
  assert.equal(res.status, 303);
  assert.deepEqual(r.calls().slice(-3), [`GET /postgres/${IDS.aDb}`, `PATCH /postgres/${IDS.aDb}`, `GET /postgres/${IDS.aDb}`]);
  assert.deepEqual(r.writes().map((c) => c.body), [{ ipAllowList: [{ cidrBlock: '203.0.113.7/32', description: 'the office' }] }]);
  body = await page();
  assert.match(body, /Closed to the internet/);
  assert.match(body, /1 other address may connect \(set in Render\)\./);
  assert.doesNotMatch(body, /render\/close-db"/);
  assert.equal((await r.ask('a', 'close-db')).res.status, 409, 'already closed: nothing to do');

  assert.deepEqual(await lines(), [
    ['render.start', 'key', null], ['render.result', 'key', true], ['render.start', 'deploy', null], ['render.result', 'deploy', true],
    ['render.start', 'restart', null], ['render.result', 'restart', true], ['render.start', 'domain', null], ['render.result', 'domain', true],
    ['render.start', 'domain', null], ['render.result', 'domain', true], ['render.start', 'close-db', null], ['render.result', 'close-db', true],
  ]);
  const rowsText = JSON.stringify([await r.jobs('a'), await r.log('%'), await r.env('a')]);
  for (const never of [pubkeyValue(), 'SENTINEL', '203.0.113.7', KEY, SENTINELS.db]) assert.ok(!rowsText.includes(never), `a row holds ${never.slice(0, 16)}`);
  const board = (await r.page('/render')).body;
  assert.match(board, /Asked Render to close the database to the internet · Example A/);
  assert.match(board, /Render did it · Example A/);
  assert.equal((await verifyLog(r.db)).ok, true);
  clean(r.world);
});

test('a change Render refuses, one with no answer, and one that doesn’t show afterwards are each logged as what they were', async () => {
  const r = await rig({ campaigns: ['a'] });
  await r.connect('a');
  const last = async () => { const l = (await r.log('render.result')).at(-1); return [l.payload, wordsFor('render.result', l.payload)]; };
  const job = async () => (await r.jobs('a')).at(-1);
  // Refused.
  r.world.refuse(409, { on: /\/restart$/ });
  assert.equal((await r.change('a', 'restart')).status, 303);
  let [payload, words] = await last();
  assert.deepEqual([payload.ok, payload.status, payload.problem, payload.step, words], [false, 409, 'conflict', 'restart', 'Render didn’t do it (answer 409)']);
  assert.deepEqual([(await job()).state, (await job()).problem], ['failed', '409']);
  assert.match((await r.page('/c/a/render')).body, /Render didn’t do it \(answer 409\)\./);
  // No answer (the change may have happened): never sent a second time.
  r.world.madeButTimedOut({ on: /\/restart$/ });
  r.mark();
  assert.equal((await r.change('a', 'restart')).status, 303);
  [payload, words] = await last();
  assert.deepEqual([payload.ok, payload.unsure, words], [false, true, 'No answer from Render']);
  assert.equal(r.writes().length, 1, 'not tried again by itself');
  assert.equal((await job()).state, 'unknown');
  assert.match((await r.page('/c/a/render')).body, /No answer from Render: look there before trying again\./);
  assert.match((await r.page('/render')).body, /Example A: the last change has no answer on record/);
  // A 500 after the change was made: unsure too.
  r.world.madeButSaid(500, { on: /\/restart$/ });
  assert.equal((await r.change('a', 'restart')).status, 303);
  assert.equal((await job()).state, 'unknown');
  // Close the database: Render says yes but the list is as it was.
  r.world.keepsOpen = true;
  assert.equal((await r.change('a', 'close-db')).status, 303);
  [payload, words] = await last();
  assert.deepEqual([payload.ok, payload.problem, payload.step], [false, 'still-open', 'read-back']);
  assert.match((await r.page('/c/a/render')).body, /Render didn’t close it\./);
  r.world.keepsOpen = false;
  // The key is set but the deploy doesn't start.
  r.world.refuse(500, { on: /\/deploys$/ });
  r.again();
  assert.equal((await r.change('a', 'key')).status, 303);
  assert.equal(r.world.settingsOf(IDS.a).BASE_PLATFORM_PUBKEY, pubkeyValue());
  assert.match((await r.page('/c/a/render')).body, /The key is set\. The deploy didn’t start: press Deploy latest\./);
  // The key: set, but it doesn't read back as set.
  delete r.world.settingsOf(IDS.a).BASE_PLATFORM_PUBKEY;
  r.world.madeButSaid(200, { on: /^PUT / });
  r.world.refuse(404, { on: /env-vars\/BASE_PLATFORM_PUBKEY$/, times: 3 });
  // (the page's own look, the PUT, the read-back)
  await r.db.query("update render_jobs set began_at = now() - interval '2 hours' where campaign = 'a'");
  const res = await r.change('a', 'key');
  assert.equal(res.status, 303);
  [payload] = await last();
  assert.deepEqual([payload.ok, payload.step], [false, payload.step]);
  assert.ok(['set', 'read-back'].includes(payload.step));
  r.world.up();
  // No usable signing key: the change isn't offered.
  const signing = process.env.PLATFORM_SIGNING_KEY;
  process.env.PLATFORM_SIGNING_KEY = 'short';
  const asked = await r.ask('a', 'key');
  assert.equal(asked.res.status, 409);
  assert.match(asked.body, /PLATFORM_SIGNING_KEY in Render is missing or too short\./);
  process.env.PLATFORM_SIGNING_KEY = signing;
  assert.equal((await verifyLog(r.db)).ok, true);
  clean(r.world);
});

test('after Connect: a branch or an address changed in Render is refused, at the page and at the last moment', async () => {
  const r = await rig({ campaigns: ['a'] });
  await r.connect('a');
  const a = r.world.service('base-win-a');
  // Changed before asking.
  a.branch = 'main';
  let asked = await r.ask('a', 'restart');
  assert.equal(asked.res.status, 409);
  assert.match(asked.body, /Connect again: the service changed in Render since it was connected\./);
  const body = (await r.page('/c/a/render')).body;
  assert.match(body, /Connect again: the service changed in Render since it was connected\./);
  assert.doesNotMatch(body, /render\/(deploy|restart|key|domain|close-db)"/, 'every button hides');
  assert.match(body, /action="\/c\/a\/render\/link"[\s\S]*Connect again/);
  assert.match((await r.page('/render')).body, /Example A: Connect again: the service changed/);
  a.branch = 'production';
  // Changed between the page and the code.
  for (const change of [() => { a.branch = 'main'; }, () => { a.serviceDetails.url = 'https://moved.onrender.com'; }, () => { a.suspended = 'suspended'; },
    () => { a.ownerId = OTHER_OWNER; }, () => { a.repo = 'https://github.com/someone-else/fork'; }]) {
    asked = await r.ask('a', 'restart');
    assert.equal(asked.res.status, 200);
    const keep = JSON.parse(JSON.stringify(a));
    change();
    r.mark();
    const res = await r.b.post('/c/a/render/restart', { job: asked.job, code: await r.code() });
    assert.equal(res.status, 409);
    assert.deepEqual(r.writes(), [], 'nothing was sent');
    Object.assign(a, keep);
  }
  const denied = (await r.log('render.denied')).filter((l) => l.payload.problem === 'target');
  assert.equal(denied.length, 5);
  assert.equal(wordsFor('render.denied', denied[0].payload), 'Refused a Render change: not this campaign’s service');
  // The page named one service; by the time the code is typed the campaign is tied to another id.
  r.again();
  asked = await r.ask('a', 'restart');
  a.id = 'srv-recreated0000000001';
  for (const k of ['settings', 'domains', 'deploys']) r.world[k][a.id] = r.world[k][IDS.a];
  await r.db.query("update environments set render_service = $1 where campaign = 'a'", [a.id]);
  r.mark();
  const swapped = await r.b.post('/c/a/render/restart', { job: asked.job, code: await r.code() });
  assert.equal(swapped.status, 409);
  assert.match(await swapped.text(), /Connect again: the service changed in Render since it was connected\./);
  assert.deepEqual(r.writes(), [], 'the change goes only to the service the page named');
  a.id = IDS.a;
  await r.db.query("update environments set render_service = $1 where campaign = 'a'", [IDS.a]);
  // The service saved is gone from Render altogether.
  r.again();
  r.world.services.splice(r.world.services.indexOf(a), 1);
  asked = await r.ask('a', 'restart');
  assert.equal(asked.res.status, 409);
  assert.match(asked.body, /Connect again/);
  // The database target: a database that isn't this service's is refused.
  r.world.services.push(a);
  r.world.database('base-win-a-db').name = 'someone-elses-db';
  asked = await r.ask('a', 'close-db');
  assert.equal(asked.res.status, 409);
  assert.match(asked.body, /This isn’t this service’s database in Render\./);
  assert.deepEqual(r.world.restarts, []);
  clean(r.world);
});

test('one change at a time per campaign; 6 an hour per campaign; 30 a day in all', async () => {
  const r = await rig({ campaigns: ['a', 'b'] });
  await r.connect('a', 'b');
  await r.db.query("update render_jobs set began_at = now() - interval '10 minutes', ended_at = now() - interval '10 minutes'");
  // The lease: a change still running on this campaign.
  let asked = await r.ask('a', 'restart');
  await r.db.query(`insert into render_jobs (id, campaign, env, what, target, state, asked_in, began_at) values ('${'1'.repeat(32)}', 'a', 'production', 'deploy', $1, 'running', 'x', now() - interval '1 minute')`, [IDS.a]);
  r.mark();
  let res = await r.b.post('/c/a/render/restart', { job: asked.job, code: await r.code() });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /Already working on a change here\. Wait a minute\./);
  assert.deepEqual(r.writes(), []);
  assert.match((await r.page('/c/a/render')).body, /Working on a change here\. Wait a minute, then reload\./);
  // Another campaign is not held up by it.
  assert.equal((await r.change('b', 'restart')).status, 303);
  // The database itself allows one running change per campaign.
  await assert.rejects(r.db.query(`insert into render_jobs (id, campaign, env, what, state, asked_in, began_at) values ('${'2'.repeat(32)}', 'a', 'production', 'deploy', 'running', 'x', now())`));
  // Three minutes on with no result: it becomes "no answer on record", with no request to Render.
  await r.db.query("update render_jobs set began_at = now() - interval '4 minutes' where state = 'running'");
  r.mark();
  const body = (await r.page('/c/a/render')).body;
  assert.match(body, /The last change has no answer on record: look in Render\./);
  assert.equal((await r.db.query("select state, problem from render_jobs where id = $1", ['1'.repeat(32)])).rows[0].state, 'unknown');
  assert.deepEqual(r.writes(), []);
  // 6 an hour on one campaign (the one above began 4 minutes ago and counts).
  r.again();
  for (let i = 0; i < 5; i += 1) assert.equal((await r.change('a', 'restart')).status, 303, `change ${i + 2}`);
  r.again();
  asked = await r.ask('a', 'restart');
  r.mark();
  res = await r.b.post('/c/a/render/restart', { job: asked.job, code: await r.code() });
  assert.equal(res.status, 429);
  assert.match(await res.text(), /Too many changes\. Wait, or do it in Render\./);
  assert.deepEqual(r.writes(), []);
  const capped = (await r.log('render.denied')).at(-1);
  assert.deepEqual([capped.payload.problem, wordsFor('render.denied', capped.payload)], ['caps', 'Refused a Render change: too many changes']);
  // Connect is not a change at Render and is not counted.
  assert.equal((await r.change('a', 'link')).status, 303);
  // An hour later it works again.
  await r.db.query("update render_jobs set began_at = began_at - interval '61 minutes' where campaign = 'a'");
  assert.equal((await r.change('a', 'restart')).status, 303);
  // 30 a day across every campaign.
  await r.db.query("delete from render_jobs where state <> 'asked'");
  await r.db.query(`insert into render_jobs (id, campaign, env, what, state, asked_in, began_at, ended_at)
    select md5(i::text), 'a', 'production', 'restart', 'done', 'x', now() - interval '3 hours', now() from generate_series(1, 30) as i`);
  r.again();
  asked = await r.ask('b', 'restart');
  res = await r.b.post('/c/b/render/restart', { job: asked.job, code: await r.code() });
  assert.equal(res.status, 429, '30 changes today: the next waits, on any campaign');
  await r.db.query("update render_jobs set began_at = now() - interval '25 hours' where began_at < now() - interval '2 hours'");
  assert.equal((await r.change('b', 'restart')).status, 303);
  clean(r.world);
});

test('Check Render’s answers: reads only, no code; and what the pages say when Render can’t be read', async () => {
  const r = await rig({ campaigns: ['sample', 'a'] });
  // Before the sample is connected: the reads that need no campaign.
  let res = await r.b.post('/render/check', {});
  let body = (await res.text()).replace(/\s+/g, ' ');
  assert.equal(res.status, 200);
  assert.equal([...body.matchAll(/<dd>As expected<\/dd>/g)].length, 5);
  assert.match(body, /Connect Sample \(staging\) to check the rest/);
  await r.connect('sample', 'a');
  r.mark();
  res = await r.b.post('/render/check', {});
  body = (await res.text()).replace(/\s+/g, ' ');
  assert.equal([...body.matchAll(/<dd>As expected<\/dd>/g)].length, 10);
  assert.match(body, /Every answer is as expected\./);
  assert.ok(r.calls().every((c) => c.startsWith('GET ')), 'reads only');
  assert.ok(r.calls().every((c) => !c.includes(IDS.a) && !c.includes(IDS.first)), 'against staging only, never a client’s service');
  // A field that isn't where it should be is named.
  r.world.dropField('verificationStatus').dropField('plan');
  res = await r.b.post('/render/check', {});
  body = (await res.text()).replace(/\s+/g, ' ');
  assert.match(body, /Staging’s addresses<\/dt><dd>[^<]*Missing: verificationStatus\./);
  assert.match(body, /Staging’s service<\/dt><dd>Not as expected\. Missing: serviceDetails\.plan\./);
  assert.match(body, /Some answers are not as expected\./);
  assert.ok(!body.includes('SENTINEL'));
  r.world.up();
  // Render can't read one setting alone: the page says Not read, and never lists settings.
  r.world.refuse(404, { on: /env-vars/, times: Infinity });
  body = (await r.page('/c/a/render')).body;
  assert.match(body, /<dt>Settings<\/dt><dd>Not read/);
  assert.doesNotMatch(body, /Missing:/);
  r.world.up();
  // Render down: each row says so, the rest of the console is as usual.
  r.world.down();
  body = (await r.page('/c/a/render')).body;
  assert.match(body, /Render didn’t answer\. The rest of this page is as usual\./);
  assert.doesNotMatch(body, /render\/(deploy|restart)"/);
  assert.doesNotMatch(body, /Each button first shows/, 'no buttons, so no line about them');
  const board = await r.page('/render');
  assert.equal(board.status, 200);
  assert.match(board.body, /Render didn’t answer/);
  const campaign = await r.page('/c/a');
  assert.equal(campaign.status, 200);
  assert.match(campaign.body, /<dt>Answering<\/dt><dd>Yes/);
  assert.equal((await r.page('/')).status, 200);
  const asked = await r.ask('a', 'restart');
  assert.equal(asked.res.status, 409);
  assert.match(asked.body, /Render didn’t answer\. Nothing was changed\./);
  r.world.up();
  // Render refuses the key.
  r.world.refuse(401, { on: /./, times: Infinity });
  assert.match((await r.page('/render')).body, /Render refused the key\. Make a new one: see below\./);
  assert.match((await r.ask('a', 'restart')).body, /Render refused the key\. See Render, in the menu\./);
  r.world.up();
  assert.deepEqual(r.writes(), []);
  clean(r.world);
});

test('the board: what needs a look, where production is, and the warnings before the key is safe', async () => {
  const world = fakeWorld({ platformBranch: 'main', platformBuild: 'npm ci --omit=dev' });
  world.owners.push({ id: OTHER_OWNER, name: 'someone@example.org', email: 'x@example.org', type: 'user' });
  const r = await rig({ world });
  await r.connect('sample', 'a', 'b', 'imaginesurrey');
  let body = (await r.page('/render')).body;
  assert.match(body, /The control centre itself isn’t running from the production branch yet\./);
  assert.match(body, /build command in Render isn’t npm ci --omit=dev --ignore-scripts yet/);
  assert.match(body, /This key sees 2 workspaces\. It should see only base\.win’s\./);
  assert.ok(!body.includes('someone@example.org'), 'never an email');
  assert.match(body, /Production: all 3 connected campaigns are on d9130ae\./);
  assert.match(body, /Staging is on e4f5a6b: Promote is waiting\. <a href="https:\/\/github\.com\/example-org\/base\/actions\/workflows\/promote\.yml" rel="noreferrer" target="_blank">Promote to production \(GitHub\) ↗<\/a>/);
  assert.match(body, /Example A: a\.base\.win isn’t added in Render/);
  assert.match(body, /Example A: its database is open to the internet/);
  assert.doesNotMatch(body, /Imagine Surrey: /, 'nothing to look at there: its own domain waiting is its own business');
  assert.match(body, /Imagine Surrey<\/a> <span class="oc-line">base-win · Live · d9130ae · [^<]* · database closed/);
  assert.match(body, /Sample \(staging\)<\/a> <span class="oc-line">base-win-staging · Live · e4f5a6b · [^<]* · made-up data only/);
  // One client's deploy fails, another is still going.
  world.deploys[IDS.a].push({ ...world.deploys[IDS.a][0], id: 'dep-failed00000000001', status: 'build_failed', commit: { id: 'aaaaaaa1', message: 'x' } });
  world.deploys[IDS.b].push({ ...world.deploys[IDS.b][0], id: 'dep-going000000000001', status: 'build_in_progress', commit: { id: 'bbbbbbb2', message: 'x' } });
  world.service('base-win-b').autoDeploy = 'no';
  world.service('base-win').suspended = 'suspended';
  body = (await r.page('/render')).body;
  assert.match(body, /Production: 1 of 3 are on d9130ae\. Example A: the last deploy failed\. Example B: still deploying\./);
  assert.match(body, /Example A: the last deploy failed/);
  assert.match(body, /Example B: it doesn’t deploy by itself/);
  assert.match(body, /Imagine Surrey: Suspended in Render: resume it there\./);
  assert.match((await r.page('/c/b/render')).body, /does not deploy by itself/);
  assert.match((await r.page('/c/a/render')).body, /<dt>Last deploy<\/dt><dd>Failed · aaaaaaa/);
  // Key set, but the service doesn't know its own id: everything else is off.
  delete process.env.RENDER_SERVICE_ID;
  r.again();
  const { makeApp } = await import('../server.mjs');
  const plain = makeApp({ db: r.db });
  const b2 = browser(plain);
  for (const [k, v] of r.b.jar) b2.jar.set(k, v);
  const off = await b2.get('/render');
  assert.equal(off.status, 200);
  assert.match(await off.text(), /Not connected: this service doesn’t know its own Render id\./);
  assert.equal((await b2.get('/c/a/render')).status, 404);
  assert.equal((await b2.post('/c/a/render/restart', {})).status, 404);
  assert.equal((await b2.post('/render/check', {})).status, 404);
  process.env.RENDER_SERVICE_ID = IDS.platform;
  clean(world);
});

test('base.win’s key page: while the key is being changed, a connected campaign without the new one gets a button', async () => {
  const r = await rig({ campaigns: ['a', 'b'] });
  await r.connect('a');
  const signing = process.env.PLATFORM_SIGNING_KEY;
  process.env.PLATFORM_SIGNING_KEY = `${signing},another-test-signing-key-0123456789abcdef`;
  const body = (await r.page('/key')).body;
  assert.match(body, /Don’t remove the old key yet: Example A, Example B don’t have the new one\./);
  assert.match(body, /<form method="post" action="\/c\/a\/render\/key"[^>]*><button class="btn btn-quiet" type="submit">Set base\.win’s key on Example A<\/button>/);
  assert.doesNotMatch(body, /\/c\/b\/render\/key/, 'not connected: no button');
  const asked = await r.ask('a', 'key');
  assert.equal(asked.res.status, 200);
  r.mark();
  const res = await r.b.post('/c/a/render/key', { job: asked.job, code: await r.code() });
  assert.equal(res.status, 303);
  assert.deepEqual(r.writes()[0].body, { value: pubkeyValue() }, 'both public keys, the new one first');
  assert.match(pubkeyValue(), /^[A-Za-z0-9_-]{43},[A-Za-z0-9_-]{43}$/);
  process.env.PLATFORM_SIGNING_KEY = signing;
  clean(r.world);
});
