// The poller: what a health check keeps, the public address it also asks
// (https://<name>.base.win), the guard on every fetch, pinning, the 7-day
// sweep, and what the checklist ticks from the answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, baseEnv } from './helpers.mjs';
import * as fake from './fake-health.mjs';
import { safeGet, addressAllowed } from '../safe-fetch.mjs';
import { pollOnce, checkUrl } from '../poller.mjs';
import { createCampaign, publicAddress } from '../campaigns.mjs';
import { currentKid } from '../keys.mjs';

baseEnv();
process.env.OPS_ALLOW_LOCAL = '1';
// The stand-in for every client's public address: /<name> on the fake server.
process.env.OPS_PUBLIC_TEMPLATE = `${fake.ORIGIN}/{name}`;
const INST = 'EBESExQVFhcYGRobHB0eHw';
const health = (over = {}) => ({
  ok: true, database: 'ok', service: 'starbase', env: 'production', organization: 'Example Campaign', commit: 'd9130ae', build: 'index-abc.js',
  tzdataCurrent: true, ownOrigin: fake.ORIGIN, instance: INST, address: 'https://a.base.win', entry: 'ready', platformKids: [currentKid()],
  setupOpen: false, campaignMade: true, store: 'postgres', ...over,
});
const { db } = await freshApp();
await db.transaction((tx) => createCampaign(tx, { name: 'a', display: 'Example A', serverUrl: fake.ORIGIN }));
const latest = async (via = 'server') => (await db.query("select * from checks where campaign = 'a' and via = $1 order by id desc limit 1", [via])).rows[0];

before(fake.start);
after(fake.stop);

test('a healthy answer: only the known fields kept, strings cut to 200; the public address asked where it is built here, never at the address given', async () => {
  fake.handlers.set('/api/health', fake.json(200, health({ commit: 'x'.repeat(500), secretThing: 'nope', address: 'https://evil.example/elsewhere', platformKids: ['k1', 7, 'k2'] })));
  fake.handlers.set('/a/api/health', fake.json(200, health()));
  fake.seen.length = 0;
  await pollOnce(db);
  const s = await latest();
  assert.equal(s.answering, true);
  assert.equal(s.status, 200);
  assert.equal(s.commit.length, 200);
  assert.deepEqual(s.platform_kids, ['k1', 'k2']);
  assert.equal(s.own_origin, fake.ORIGIN);
  assert.equal(s.entry, 'ready');
  assert.equal(s.store, 'postgres');
  assert.ok(!('door_key' in s), 'nothing of the door is kept');
  assert.ok(!JSON.stringify(s).includes('nope'), 'unknown keys are dropped');
  assert.deepEqual(fake.seen.map((r) => r.url).sort(), ['/a/api/health', '/api/health']);
  assert.ok(fake.seen.every((r) => r.ua === 'base.win-control-centre' && !r.cookie && !r.auth));
  assert.equal((await latest('public')).answering, true);
  assert.equal((await db.query("select count(*)::int n from checks where via not in ('server', 'public')")).rows[0].n, 0);
});

test('a 503 with its database down is still an answer, and kept', async () => {
  fake.handlers.set('/api/health', fake.json(503, health({ ok: false, database: 'not reachable' })));
  await pollOnce(db);
  const s = await latest();
  assert.equal(s.answering, true);
  assert.equal(s.status, 503);
  assert.equal(s.database, 'not reachable');
});

test('not JSON, a redirect (not followed) and a timeout are each not answering, with the reason only', async () => {
  fake.handlers.set('/api/health', (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hello</html>'); });
  await pollOnce(db);
  assert.deepEqual([(await latest()).answering, (await latest()).problem], [false, 'not-json']);
  fake.handlers.set('/api/health', (req, res) => { res.writeHead(302, { location: '/elsewhere' }); res.end(); });
  fake.handlers.set('/elsewhere', fake.json(200, health()));
  fake.seen.length = 0;
  await pollOnce(db);
  assert.deepEqual([(await latest()).answering, (await latest()).problem, (await latest()).status], [false, 'redirect', 302]);
  assert.ok(!fake.seen.some((r) => r.url === '/elsewhere'), 'the redirect is not followed');
  fake.handlers.set('/api/health', () => { /* never answers */ });
  const r = await checkUrl(`${fake.ORIGIN}/api/health`, { fetcher: (u) => safeGet(u, { timeoutMs: 300 }) });
  assert.deepEqual([r.answering, r.problem], [false, 'timeout']);
});

test('a 1 MB answer is cut at 16 KB', async () => {
  fake.handlers.set('/big', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"x":"${'a'.repeat(1024 * 1024)}"}`); });
  const res = await safeGet(`${fake.ORIGIN}/big`);
  assert.equal(res.body.length, 16 * 1024);
  const r = await checkUrl(`${fake.ORIGIN}/big`);
  assert.deepEqual([r.answering, r.problem], [false, 'not-json']);
});

test('the guard: a name that resolves to a private or metadata address is refused when connecting, unless local is allowed for 127.0.0.1', async () => {
  const lookupTo = (address, family = 4) => (host, opts, cb) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family));
  for (const ip of ['10.0.0.1', '169.254.169.254', '192.168.1.5', '100.64.0.1', '127.0.0.1']) {
    await assert.rejects(safeGet('https://health.example.org/api/health', { lookup: lookupTo(ip), allowLocal: false }), { name: 'blocked-address' }, ip);
  }
  await assert.rejects(safeGet('https://health.example.org/api/health', { lookup: lookupTo('fd00::1', 6), allowLocal: false }), { name: 'blocked-address' });
  await assert.rejects(safeGet('https://health.example.org/', { lookup: lookupTo('10.0.0.1'), allowLocal: true }), { name: 'blocked-address' }, 'local allows 127.0.0.1 only');
  await assert.rejects(safeGet('https://10.0.0.1/api/health', { allowLocal: true }), { name: 'blocked-address' });
  await assert.rejects(safeGet('https://[::ffff:169.254.169.254]/', { allowLocal: false }), { name: 'blocked-address' });
  await assert.rejects(safeGet('http://health.example.org/api/health', { allowLocal: true }), { name: 'not-https' });
  await assert.rejects(safeGet(`${fake.ORIGIN}/api/health`, { allowLocal: false }), { name: 'not-https' });
  assert.equal(addressAllowed('8.8.8.8', { allowLocal: false }), true);
  assert.equal(addressAllowed('127.0.0.1', { allowLocal: false }), false);
});

test('IPv6 forms that embed or route to private space are refused; global ones are not', async () => {
  for (const ip of ['::7f00:1', '::a9fe:a9fe', '::', '::1', 'fec0::1', 'fd00::1', 'fe80::1', 'ff02::1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::a9fe:a9fe',
    '2002:a9fe:a9fe::1', '2002:7f00:1::1', '2001:0:a9fe:a9fe::1', '2001:db8::1', '::ffff:169.254.169.254']) {
    assert.equal(addressAllowed(ip, { allowLocal: false }), false, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888']) assert.equal(addressAllowed(ip, { allowLocal: false }), true, ip);
  // An AAAA answer in one of them is refused when the connection is made.
  const lookup = (h, o, cb) => (o?.all ? cb(null, [{ address: '::a9fe:a9fe', family: 6 }]) : cb(null, '::a9fe:a9fe', 6));
  await assert.rejects(safeGet('https://health.example.org/api/health', { lookup, allowLocal: false }), { name: 'blocked-address' });
});

test('the first matching answer pins the instance; a later different one never re-pins', async () => {
  const { db: d } = await freshApp();
  const answers = new Map();
  const fetcher = async (url) => ({ status: 200, body: JSON.stringify(answers.get(url)), ms: 3 });
  await d.transaction((tx) => createCampaign(tx, { name: 'a', display: 'Example A', serverUrl: 'https://base-win-a.onrender.com' }));
  answers.set('https://base-win-a.onrender.com/api/health', health({ ownOrigin: 'https://base-win-other.onrender.com' }));
  await pollOnce(d, { fetcher });
  assert.equal((await d.query("select instance from environments where campaign = 'a'")).rows[0].instance, null, 'not where it says it is: not pinned');
  answers.set('https://base-win-a.onrender.com/api/health', health({ ownOrigin: 'https://base-win-a.onrender.com' }));
  await pollOnce(d, { fetcher });
  assert.equal((await d.query("select instance from environments where campaign = 'a'")).rows[0].instance, INST);
  answers.set('https://base-win-a.onrender.com/api/health', health({ ownOrigin: 'https://base-win-a.onrender.com', instance: 'AAAAAAAAAAAAAAAAAAAAAA' }));
  await pollOnce(d, { fetcher });
  assert.equal((await d.query("select instance from environments where campaign = 'a'")).rows[0].instance, INST);
  const pins = (await d.query("select payload from ops_log where action = 'environment.pin'")).rows;
  assert.deepEqual(pins.map((p) => p.payload), [{ env: 'production', instance: INST }]);
  // A second campaign whose server reports the instance already pinned isn't pinned (S1).
  await d.transaction((tx) => createCampaign(tx, { name: 'b', display: 'Example B', serverUrl: 'https://base-win-b.onrender.com' }));
  answers.set('https://base-win-b.onrender.com/api/health', health({ ownOrigin: 'https://base-win-b.onrender.com' }));
  await pollOnce(d, { fetcher });
  assert.equal((await d.query("select instance from environments where campaign = 'b'")).rows[0].instance, null);
});

test('checks older than 7 days are swept after each run', async () => {
  await db.query("insert into checks (campaign, env, via, at, answering) values ('a', 'production', 'server', now() - interval '8 days', true), ('a', 'production', 'server', now() - interval '6 days', true)");
  fake.handlers.set('/api/health', fake.json(200, health()));
  await pollOnce(db);
  assert.equal((await db.query("select count(*)::int n from checks where at < now() - interval '7 days'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from checks where at < now() - interval '5 days'")).rows[0].n, 1);
});

test('Campaign made ticks only once the server says a workspace exists, not on setupOpen false (a fresh server holding the key)', async () => {
  const { db: d } = await freshApp();
  const answers = new Map();
  const fetcher = async (url) => ({ status: 200, body: JSON.stringify(answers.get(url) || {}), ms: 3 });
  const U = 'https://base-win-fresh.onrender.com';
  await d.transaction((tx) => createCampaign(tx, { name: 'fresh', display: 'Example Fresh', serverUrl: U }));
  const made = async () => (await d.query("select done_by from checklist where campaign = 'fresh' and item = 'campaign-made' and done_at is not null")).rows[0]?.done_by;
  // A fresh campaign server with BASE_PLATFORM_PUBKEY set, before the first entry.
  answers.set(`${U}/api/health`, health({ ownOrigin: U, setupOpen: false, campaignMade: false }));
  await pollOnce(d, { fetcher });
  assert.equal((await d.query("select campaign_made, setup_open from checks where campaign = 'fresh' and via = 'server' order by id desc limit 1")).rows[0].campaign_made, false);
  assert.equal(await made(), undefined, 'no workspace yet: not made');
  // An older server that doesn't say: not made either.
  answers.set(`${U}/api/health`, health({ ownOrigin: U, setupOpen: false, campaignMade: undefined }));
  await pollOnce(d, { fetcher });
  assert.equal(await made(), undefined);
  // The first entry made the workspace.
  answers.set(`${U}/api/health`, health({ ownOrigin: U, setupOpen: false, campaignMade: true }));
  await pollOnce(d, { fetcher });
  assert.equal(await made(), 'auto');
});

test('Campaign made on a server from before campaignMade: setupOpen false with none of the control centre’s keys still ticks', async () => {
  const { db: d } = await freshApp();
  const answers = new Map();
  const fetcher = async (url) => ({ status: 200, body: JSON.stringify(answers.get(url) || {}), ms: 3 });
  const U = 'https://base-win-older.onrender.com';
  await d.transaction((tx) => createCampaign(tx, { name: 'older', display: 'Example Older', serverUrl: U }));
  const made = async () => (await d.query("select done_by from checklist where campaign = 'older' and item = 'campaign-made' and done_at is not null")).rows[0]?.done_by;
  // Older and holding the key: setupOpen false says nothing.
  answers.set(`${U}/api/health`, health({ ownOrigin: U, setupOpen: false, campaignMade: undefined }));
  await pollOnce(d, { fetcher });
  assert.equal(await made(), undefined);
  // Older and open: not made.
  answers.set(`${U}/api/health`, health({ ownOrigin: U, setupOpen: true, campaignMade: undefined, platformKids: [] }));
  await pollOnce(d, { fetcher });
  assert.equal(await made(), undefined);
  // Older, no key, setup closed: a workspace exists.
  answers.set(`${U}/api/health`, health({ ownOrigin: U, setupOpen: false, campaignMade: undefined, platformKids: [] }));
  await pollOnce(d, { fetcher });
  assert.equal(await made(), 'auto');
});

// (Each of these starts from an empty database, so they come last.)
test('a client’s public address is https://<name>.base.win; only a stand-in with {name} in it replaces that', async () => {
  const was = process.env.OPS_PUBLIC_TEMPLATE;
  delete process.env.OPS_PUBLIC_TEMPLATE;
  assert.equal(publicAddress('riverton'), 'https://riverton.base.win');
  process.env.OPS_PUBLIC_TEMPLATE = 'https://one-address.example.org';
  assert.equal(publicAddress('riverton'), 'https://riverton.base.win', 'no {name}: every client would share it');
  process.env.OPS_PUBLIC_TEMPLATE = 'http://127.0.0.1:5603/{name}/';
  assert.equal(publicAddress('riverton'), 'http://127.0.0.1:5603/riverton');
  delete process.env.OPS_PUBLIC_TEMPLATE;
  // Asked there for a client's production; the sample (staging) has no such address.
  const { db: d } = await freshApp();
  const asked = [];
  const fetcher = async (url) => { asked.push(url); return { status: 200, body: JSON.stringify(health({ ownOrigin: new URL(url).origin })), ms: 3 }; };
  await d.transaction((tx) => createCampaign(tx, { name: 'riverton', display: 'Riverton Forward', serverUrl: 'https://base-win-riverton.onrender.com' }));
  await d.query("update environments set server_url = 'https://starbase-staging.onrender.com' where campaign = 'sample'");
  await pollOnce(d, { fetcher });
  assert.deepEqual(asked.sort(), ['https://base-win-riverton.onrender.com/api/health', 'https://riverton.base.win/api/health', 'https://starbase-staging.onrender.com/api/health']);
  assert.deepEqual((await d.query('select campaign, via from checks order by campaign, via')).rows,
    [{ campaign: 'riverton', via: 'public' }, { campaign: 'riverton', via: 'server' }, { campaign: 'sample', via: 'server' }]);
  process.env.OPS_PUBLIC_TEMPLATE = was;
});

test('“Answers at <name>.base.win” ticks only when the public address reaches the pinned server', async () => {
  const { db: d } = await freshApp();
  const U = 'https://base-win-pub.onrender.com';
  const P = `${fake.ORIGIN}/pub/api/health`;
  const answers = new Map();
  const fetcher = async (url) => {
    if (!answers.has(url)) throw Object.assign(new Error('x'), { name: 'ENOTFOUND' });
    return { status: 200, body: JSON.stringify(answers.get(url)), ms: 3 };
  };
  await d.transaction((tx) => createCampaign(tx, { name: 'pub', display: 'Example Pub', serverUrl: U }));
  const ticked = async () => (await d.query("select done_by from checklist where campaign = 'pub' and item = 'public' and done_at is not null")).rows[0]?.done_by;
  // The domain isn't there yet.
  answers.set(`${U}/api/health`, health({ ownOrigin: U }));
  await pollOnce(d, { fetcher });
  assert.deepEqual([(await d.query("select answering, problem from checks where campaign = 'pub' and via = 'public'")).rows[0]], [{ answering: false, problem: 'ENOTFOUND' }]);
  assert.equal(await ticked(), undefined);
  // It answers, but from some other server: not this campaign's.
  answers.set(P, health({ ownOrigin: U, instance: 'AAAAAAAAAAAAAAAAAAAAAA' }));
  await pollOnce(d, { fetcher });
  assert.equal(await ticked(), undefined);
  // The custom domain reaches the pinned server.
  answers.set(P, health({ ownOrigin: U }));
  await pollOnce(d, { fetcher });
  assert.equal(await ticked(), 'auto');
});

test('“Answers, database fine” and the service tick only on a real database; a server too old to say still ticks', async () => {
  const { db: d } = await freshApp();
  const answers = new Map();
  const fetcher = async (url) => ({ status: 200, body: JSON.stringify(answers.get(url) || {}), ms: 3 });
  const E = 'https://base-win-embedded.onrender.com';
  const O = 'https://base-win-old.onrender.com';
  await d.transaction((tx) => createCampaign(tx, { name: 'embedded', display: 'Example Embedded', serverUrl: E }));
  await d.transaction((tx) => createCampaign(tx, { name: 'old', display: 'Example Old', serverUrl: O }));
  const done = async (name) => (await d.query('select item from checklist where campaign = $1 and done_at is not null order by item', [name])).rows.map((r) => r.item);
  answers.set(`${E}/api/health`, health({ ownOrigin: E, store: 'embedded' }));
  answers.set(`${O}/api/health`, health({ ownOrigin: O, store: undefined, instance: 'OOOOOOOOOOOOOOOOOOOOOO' }));
  await pollOnce(d, { fetcher });
  assert.equal((await d.query("select store from checks where campaign = 'embedded' and via = 'server'")).rows[0].store, 'embedded');
  assert.equal((await d.query("select store from checks where campaign = 'old' and via = 'server'")).rows[0].store, null);
  assert.deepEqual((await done('embedded')).filter((i) => ['answers', 'service'].includes(i)), [], 'the built-in database is not a real one');
  assert.ok((await done('embedded')).includes('tz'), 'the rest still tick');
  assert.deepEqual((await done('old')).filter((i) => ['answers', 'service'].includes(i)), ['answers', 'service']);
  answers.set(`${E}/api/health`, health({ ownOrigin: E, store: 'postgres' }));
  await pollOnce(d, { fetcher });
  assert.deepEqual((await done('embedded')).filter((i) => ['answers', 'service'].includes(i)), ['answers', 'service']);
});
