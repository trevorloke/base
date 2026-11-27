// The owner's rule: nothing of one campaign reaches another, and no other
// client gets anything of Imagine Surrey's.
//   N1  With two clients connected, a change on one names only that one's
//       service and database; nothing sent is something Render returned
//       (but a database's own allow-list, sent back shorter).
//   N2  A campaign added as already running, on its hand-made service: the
//       settings it never had are not "missing", nothing offers to add
//       them, its own domain is listed plain, and its service receives
//       nothing but what was pressed on its own page.
//   N3  Opening Campaigns, a campaign, the log or base.win's key, or running
//       the health checks, asks Render nothing.
//   N5  No Render page or log line for one campaign holds another's name,
//       display name or address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IDS, SENTINELS } from './fake-render.mjs';
import { rig, ADDR } from './render-rig.mjs';
import { pollOnce } from '../poller.mjs';
import { makeApp } from '../server.mjs';
import { WRITABLE, writableFor, neededFor } from '../render-guard.mjs';
import { pubkeyValue } from '../keys.mjs';

const copy = (x) => JSON.parse(JSON.stringify(x));
const ofOthers = (world, mine) => copy({
  settings: Object.fromEntries(Object.entries(world.settings).filter(([id]) => !mine.includes(id))),
  domains: Object.fromEntries(Object.entries(world.domains).filter(([id]) => !mine.includes(id))),
  deploys: Object.fromEntries(Object.entries(world.deploys).filter(([id]) => !mine.includes(id))),
  services: world.services.filter((s) => !mine.includes(s.id)),
  databases: world.databases.filter((d) => !mine.includes(d.id)),
});

test('N1: a change on one client names only that client’s service and database, and sends nothing Render returned', async () => {
  const r = await rig();
  await r.connect('a', 'b', 'imaginesurrey', 'sample');
  const before = ofOthers(r.world, [IDS.a, IDS.aDb]);
  // Every string Render holds, anywhere in its answers.
  const returned = new Set();
  const gather = (v) => { if (typeof v === 'string') returned.add(v); else if (v && typeof v === 'object') Object.values(v).forEach(gather); };
  gather([r.world.settings, r.world.domains, r.world.services, r.world.databases, r.world.owners, r.world.deploys, r.world.blueprints]);
  r.mark();
  for (const what of ['key', 'restart', 'domain', 'close-db']) assert.equal((await r.change('a', what)).status, 303, what);
  r.world.finishDeploys(IDS.a);
  assert.equal((await r.change('a', 'deploy')).status, 303);
  await r.page('/c/a/render');
  const others = [IDS.b, IDS.bDb, IDS.first, IDS.firstDb, IDS.staging, IDS.stagingDb, IDS.other, IDS.otherDb, IDS.platformDb];
  for (const c of r.world.calls.slice(r.from)) {
    for (const id of others) assert.ok(!`${c.path} ${JSON.stringify(c.body)}`.includes(id), `${c.method} ${c.path} names another campaign’s ${id}`);
    assert.ok(c.path.includes(IDS.a) || c.path.includes(IDS.aDb) || c.path === `/services/${IDS.platform}`, `${c.method} ${c.path}`);
    assert.ok(!/^\/(services|postgres)\?/.test(c.path), 'no list of everyone’s services is read for a change');
  }
  const sent = r.writes().filter((c) => c.method !== 'PATCH').flatMap((c) => Object.values(c.body || {}));
  assert.deepEqual(sent.sort(), ['a.base.win', 'do_not_clear', 'do_not_clear', pubkeyValue()].sort(), 'each value sent is worked out here');
  for (const v of sent) assert.ok(!returned.has(v), `${v} came from Render`);
  // The one thing sent back is the database's own allow-list, shorter.
  const patch = r.writes().filter((c) => c.method === 'PATCH');
  assert.deepEqual(patch.map((c) => [c.path, c.body]), [[`/postgres/${IDS.aDb}`, { ipAllowList: [{ cidrBlock: '203.0.113.7/32', description: 'the office' }] }]]);
  assert.deepEqual(ofOthers(r.world, [IDS.a, IDS.aDb]), before, 'every other service, database, setting, address and deploy is as it was');
  assert.deepEqual(r.world.forbidden, []);
});

test('N2: a campaign added as already running: nothing is “missing”, nothing offers to add a setting, its own domain is plain', async () => {
  const r = await rig();
  const camp = (await r.db.query("select * from campaigns where name = 'imaginesurrey'")).rows[0];
  assert.deepEqual(camp.values, {}, 'none of its settings are kept here');
  const mine = r.world.settingsOf(IDS.first);
  for (const never of ['STARBASE_CANDIDATES', 'STARBASE_GEO_BOUNDS', 'STARBASE_PROVINCE']) {
    assert.ok(!(never in mine), `${never} was never set on its service`);
    assert.ok(!neededFor(camp).includes(never), `${never} is not “needed” there`);
  }
  assert.deepEqual(WRITABLE, ['BASE_PLATFORM_PUBKEY']);
  assert.deepEqual(writableFor(camp), ['BASE_PLATFORM_PUBKEY']);
  await r.connect('a', 'sample');
  const settingsBefore = copy(mine);
  // Before it is connected, and while other campaigns are changed: its service is asked nothing at all.
  for (const what of ['key', 'restart', 'domain', 'close-db']) await r.change('a', what);
  await r.change('sample', 'restart');
  await r.page('/c/a/render');
  await r.b.post('/render/check', {});
  const touching = (list) => list.filter((c) => `${c.path} ${JSON.stringify(c.body)}`.includes(IDS.first) || `${c.path}`.includes(IDS.firstDb));
  assert.deepEqual(touching(r.world.calls), [], 'not connected: no request names its service or database');
  await r.connect('imaginesurrey');
  r.mark();
  const page = await r.page('/c/imaginesurrey/render');
  assert.match(page.body, /<dt>Settings<\/dt><dd>Nothing missing/);
  assert.doesNotMatch(page.body, /STARBASE_|Missing:/);
  assert.match(page.body, /<dt>Addresses<\/dt><dd>imaginesurrey\.base\.win · Verified<br>imaginesurrey\.ca<\/dd>/, 'its own domain is listed plain: no state, no flag');
  const buttons = [...page.body.matchAll(/action="\/c\/imaginesurrey\/render\/([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ['deploy', 'restart'], 'nothing to set, add or close');
  assert.ok(!page.body.includes('/site'), 'its public address setting is never shown or judged');
  // Only "is it set?" for the settings it should have; never the three it never had, never a secret.
  const asked = r.calls().filter((c) => c.includes('/env-vars/')).map((c) => c.split('/env-vars/')[1]).sort();
  assert.deepEqual(asked, neededFor(camp).slice().sort());
  const board = await r.page('/render');
  assert.doesNotMatch(board.body, /Imagine Surrey: /, 'nothing needs a look there');
  for (const what of ['set', 'make', 'settings', 'env']) {
    assert.equal((await r.b.post(`/c/imaginesurrey/render/${what}`, { key: 'STARBASE_CANDIDATES', value: 'none', setting: 'STARBASE_PUBLIC_URL' })).status, 404, `no ${what} route`);
  }
  // Its key is set and its sign-in is ready: Set base.win's key isn't offered; pressing through anyway sets only that one name.
  assert.deepEqual(touching(r.writes()), [], 'opening its page changed nothing');
  assert.deepEqual(r.world.settingsOf(IDS.first), settingsBefore, 'its settings are as they were: its public address, its brand, its names');
  // What the owner presses on its own page is all it receives.
  assert.equal((await r.change('imaginesurrey', 'restart')).status, 303);
  assert.deepEqual(touching(r.writes()).map((c) => `${c.method} ${c.path}`), [`POST /services/${IDS.first}/restart`]);
  assert.deepEqual(r.world.settingsOf(IDS.first), settingsBefore);
  assert.deepEqual(r.world.forbidden, []);
});

test('N3: Campaigns, a campaign, the log, base.win’s key, the health checks and starting up ask Render nothing', async () => {
  const r = await rig();
  await r.connect('a', 'b', 'imaginesurrey', 'sample');
  r.mark();
  for (const path of ['/', '/c/a', '/c/imaginesurrey', '/c/sample', '/c/a/setup', '/c/a/edit', '/log', '/key', '/new', '/existing', '/healthz']) {
    assert.equal((await r.page(path)).status, 200, path);
  }
  assert.equal((await r.b.post('/c/a/check-now', {})).status, 303);
  assert.equal(await pollOnce(r.db, { fetcher: async () => ({ status: 200, ms: 1, body: JSON.stringify(r.answer('a')) }) }), 4);
  makeApp({ db: r.db, render: r.render });
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(r.calls(), [], 'no request to Render');
  assert.deepEqual(await (await r.b.get('/healthz')).json(), { ok: true, db: 'ok' }, '/healthz says nothing about Render');
  // The health checks themselves carry nothing of Render's.
  assert.ok(r.asked.length >= 8 && r.asked.every((url) => /\/api\/health$/.test(url)));
  assert.deepEqual(r.world.forbidden, []);
});

test('N5: no Render page or log line for one campaign holds another’s name, display name or address', async () => {
  const r = await rig();
  await r.connect('a', 'b', 'imaginesurrey', 'sample');
  const others = ['Example B', 'base-win-b', 'b.base.win', ADDR.b, 'Imagine', 'Surrey', 'imaginesurrey', ADDR.imaginesurrey, 'base-win-db', 'base-win-staging', 'starbase-staging',
    'Sample (staging)', IDS.b, IDS.first, IDS.staging, IDS.bDb, IDS.firstDb, 'Hartwell', 'Vancouver', SENTINELS.client, SENTINELS.db];
  const pages = [];
  pages.push((await r.page('/c/a/render')).body);
  for (const what of ['key', 'restart', 'domain', 'close-db']) {
    r.again();
    const asked = await r.ask('a', what);
    pages.push(asked.body);
    pages.push(await (await r.b.post(`/c/a/render/${what}`, { job: asked.job, code: '000000' })).text());
    assert.equal((await r.b.post(`/c/a/render/${what}`, { job: asked.job, code: await r.code() })).status, 303);
    pages.push((await r.page('/c/a/render')).body);
  }
  r.again();
  pages.push((await r.ask('a', 'deploy')).body, (await r.ask('a', 'close-db')).body, (await r.ask('a', 'link')).body);
  r.world.service('base-win-a').branch = 'main';
  pages.push((await r.ask('a', 'restart')).body, (await r.page('/c/a/render')).body);
  assert.ok(pages.length >= 16);
  for (const [i, body] of pages.entries()) for (const other of others) assert.ok(!body.includes(other), `page ${i} for campaign a holds ${other}`);
  const lines = (await r.db.query("select action, payload from ops_log where campaign = 'a' and action like 'render.%'")).rows;
  assert.ok(lines.length >= 12);
  for (const l of lines) for (const other of others) assert.ok(!JSON.stringify(l).includes(other), `${l.action} holds ${other}`);
  const jobs = JSON.stringify(await r.jobs('a'));
  for (const other of others) assert.ok(!jobs.includes(other), `a job row holds ${other}`);
  assert.deepEqual(r.world.forbidden, []);
});

test('the new files name no client', () => {
  for (const path of ['render-api.mjs', 'render-guard.mjs', 'render-routes.mjs', 'pages/render.mjs']) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /Surrey|Imagine|imaginesurrey/i, path);
  }
});
