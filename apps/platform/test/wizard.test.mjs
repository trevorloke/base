// New campaign, Set it up, and Add a running campaign: the short-name
// rules, the map area, the .env block (the campaign's own values, nothing
// of staging's, the random lines left to the browser), the time zone from
// the province, the campaign's own address (<name>.base.win), the
// render.yaml block for us, the short set-up page of a campaign that was
// already running, the code window on every save, and the checklist
// ticking itself (and staying ticked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshApp, setUp, codeNow, baseEnv, SIGNING } from './helpers.mjs';
import { makeApp } from '../server.mjs';
import { RESERVED } from '../campaigns.mjs';
import { publicKeyOf, currentKid } from '../keys.mjs';
import { ITEMS, MANUAL } from '../checklist.mjs';
import { tzFor, renderSnippet, envText, envLines, mapBounds, parseCorner, hasValues, JURISDICTIONS, DENY } from '../snippets.mjs';
import { JURISDICTIONS as SERVER_RULES, geoBounds } from '../../../server/lib/org.js';

baseEnv();
const INST = 'EBESExQVFhcYGRobHB0eHw';
const answers = new Map();
const fetcher = async (url) => {
  const a = answers.get(url);
  if (!a) throw Object.assign(new Error('x'), { name: 'ECONNREFUSED' });
  return { status: 200, body: JSON.stringify(a), ms: 4 };
};
const health = (origin, over = {}) => ({
  ok: true, database: 'ok', service: 'starbase', env: 'production', commit: 'd9130ae', tzdataCurrent: true, ownOrigin: origin, instance: INST,
  address: 'https://x.base.win', entry: 'ready', platformKids: [currentKid()], setupOpen: false, campaignMade: true, store: 'postgres', ...over,
});
const { db } = await freshApp();
const app = makeApp({ db, fetcher });
const op = await setUp(app, db);
const b = op.b;
const stale = () => db.query("update ops_sessions set code_at = now() - interval '11 minutes'");
// The map area as Google Maps copies each corner.
const NEW = {
  name: 'riverton', display: 'Riverton Forward', city: 'Riverton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: 'council',
  sw: '43.61234567, -79.71234567', ne: '43.85, -79.45',
};
const BOUNDS = '43.61235,-79.71235|43.85,-79.45';
const envBlock = (body) => /<pre class="oc-pre" id="env-block">([\s\S]*?)<\/pre>/.exec(body)[1];
const done = async (name) => new Map((await db.query('select item, done_by from checklist where campaign = $1 and done_at is not null', [name])).rows.map((r) => [r.item, r.done_by]));
// What staging's sample is given in render.yaml: none of it may reach a client.
const YAML = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
const sampleValue = (key) => new RegExp(`- key: ${key}\\b[^\\n]*\\n\\s+value: "([^"]+)"`).exec(YAML)?.[1] || '';

test('short names: the address’s own rule, the reserved list (sample, staging and demo too), no capitals, no trailing dash, not taken', async () => {
  for (const name of RESERVED) {
    const res = await b.post('/new', { ...NEW, name });
    assert.equal(res.status, 400, name);
    assert.match(await res.text(), /That name is kept for base\.win\./, name);
  }
  for (const kept of ['sample', 'ops', 'staging', 'demo', 'www']) assert.ok(RESERVED.includes(kept), kept);
  for (const name of ['Riverton', 'riverton-', '-riverton', 'river ton', 'river.ton', '', 'a'.repeat(64)]) {
    const res = await b.post('/new', { ...NEW, name });
    assert.match(await res.text(), /Use letters, numbers and dashes\. It’s the address: &lt;name&gt;\.base\.win\./, name);
  }
  assert.equal((await db.query("select count(*)::int n from campaigns where kind = 'client'")).rows[0].n, 0);
  for (const path of ['/new', '/existing']) {
    const body = await (await b.get(path)).text();
    assert.match(body, /It’s the address: &lt;name&gt;\.base\.win\./, path);
    assert.doesNotMatch(body, /base\.win\//, path);
  }
});

test('the map area: two corners as a map copies them, numbers in range, the first south-west of the second', async () => {
  assert.deepEqual(parseCorner('49.19130813786935, -122.84901'), [49.19131, -122.84901]);
  assert.deepEqual(parseCorner(' (49,-122.5) '), [49, -122.5]);
  for (const bad of ['', 'Riverton', '49.1', '49.1 -122.8', '49.1, -122.8, 3', '91, 10', '-90.01, 10', '10, 180.5', '1e2, 5', '49,1, -122,8']) assert.equal(parseCorner(bad), null, bad);
  assert.deepEqual(mapBounds(NEW.sw, NEW.ne), { bounds: BOUNDS });
  assert.match(mapBounds('nowhere', NEW.ne).problem, /^Type the south-west corner as two numbers/);
  assert.match(mapBounds(NEW.sw, '').problem, /^Type the north-east corner as two numbers/);
  for (const [sw, ne] of [[NEW.ne, NEW.sw], ['43.6, -79.4', '43.8, -79.7'], ['43.9, -79.7', '43.8, -79.4'], [NEW.sw, NEW.sw]]) {
    assert.equal(mapBounds(sw, ne).problem, 'The first corner must be south-west of the second: lower on the map and further left.', `${sw} | ${ne}`);
  }
  // What it makes is what the campaign server reads (server/lib/org.js geoBounds), not its default.
  const was = process.env.STARBASE_GEO_BOUNDS;
  for (const [sw, ne] of [[NEW.sw, NEW.ne], ['-0.00001, -0.00001', '0.00001, 0.00001'], ['-90, -180', '90, 180'], ['0.0000001, 0', '5, 5']]) {
    process.env.STARBASE_GEO_BOUNDS = mapBounds(sw, ne).bounds;
    assert.equal(geoBounds(), process.env.STARBASE_GEO_BOUNDS, `${sw} | ${ne}`);
  }
  if (was === undefined) delete process.env.STARBASE_GEO_BOUNDS; else process.env.STARBASE_GEO_BOUNDS = was;
  // On the form: both are needed, with the way to find them, and what was typed is kept.
  const form = await (await b.get('/new')).text();
  assert.match(form, /<input class="input" id="sw" name="sw" type="text" value="" required/);
  assert.match(form, /<input class="input" id="ne" name="ne" type="text" value="" required/);
  assert.match(form, /In Google Maps, right-click the bottom-left corner of the city, then click the two numbers at the top of the menu to copy them\. Paste them here\./);
  assert.match(form, /The same for the top-right corner of the city\./);
  for (const [over, words] of [[{ sw: '' }, /Type the south-west corner/], [{ ne: 'top right' }, /Type the north-east corner/], [{ sw: NEW.ne, ne: NEW.sw }, /The first corner must be south-west of the second/]]) {
    const res = await b.post('/new', { ...NEW, ...over });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.match(body, words);
    assert.match(body, /value="Riverton Forward"/);
    if (over.ne === 'top right') assert.match(body, /name="ne" type="text" value="top right"/);
  }
  assert.equal((await db.query("select count(*)::int n from campaigns where kind = 'client'")).rows[0].n, 0);
});

test('a stale code on New campaign: the Code field, what was typed kept, nothing made', async () => {
  await stale();
  const res = await b.post('/new', NEW);
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.match(body, /It’s been more than 10 minutes: type your code\./);
  assert.match(body, /value="Riverton Forward"/);
  assert.match(body, /name="sw" type="text" value="43\.61234567, -79\.71234567"/);
  assert.match(body, /<option value="ON" selected data-tz="America\/Toronto">/);
  assert.equal((await db.query("select count(*)::int n from campaigns where name = 'riverton'")).rows[0].n, 0);
  const ok = await b.post('/new', { ...NEW, code: await codeNow(db, op.secret) });
  assert.equal(ok.headers.get('location'), '/c/riverton/setup');
  const row = (await db.query("select display, kind, values from campaigns where name = 'riverton'")).rows[0];
  assert.deepEqual(row, { display: 'Riverton Forward', kind: 'client', values: { city: 'Riverton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: ['council'], bounds: BOUNDS } });
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'campaign.create' and campaign = 'riverton'")).rows[0].n, 1);
  const dup = await b.post('/new', NEW);
  assert.match(await dup.text(), /That name is taken\./);
  assert.match(await (await b.get('/c/riverton')).text(), /<dt>Map area<\/dt><dd>43\.61235, -79\.71235 to 43\.85, -79\.45<\/dd>/);
});

test('the time zone follows the province; a race is needed; the rules are the server’s own', async () => {
  assert.equal(tzFor('BC'), 'America/Vancouver');
  assert.equal(tzFor('AB'), 'America/Edmonton');
  assert.equal(tzFor('NL'), 'America/St_Johns');
  assert.equal(tzFor('QC'), 'America/Toronto');
  assert.equal(tzFor('PE'), 'America/Halifax');
  assert.deepEqual(JURISDICTIONS, SERVER_RULES);
  assert.equal((await b.post('/new', { ...NEW, name: 'westcan', province: 'AB', tz: '' })).status, 303);
  assert.equal((await db.query("select values->>'tz' tz from campaigns where name = 'westcan'")).rows[0].tz, 'America/Edmonton');
  const none = await b.post('/new', { ...NEW, name: 'noraces', races: '' });
  assert.match(await none.text(), /Tick at least one race\./);
  const body = await (await b.get('/new')).text();
  assert.match(body, /<option value="BC" selected data-tz="America\/Vancouver">British Columbia/);
  assert.match(body, /<option value="America\/St_Johns">St\. John’s<\/option>/);
  assert.match(body, /name="races" value="council" checked[\s\S]*name="races" value="school_board" checked/);
  assert.equal([...body.matchAll(/btn-primary/g)].length, 1);
});

test('the .env block: every value asked for, its own address and map area, no opponents, base.win’s key; nothing of the door or of staging; the random lines empty for the browser', async () => {
  const body = await (await b.get('/c/riverton/setup')).text();
  const block = envBlock(body);
  const lines = block.split('\n');
  for (const line of ['NODE_ENV=production', 'STARBASE_ENV=production', 'STARBASE_PUBLIC_URL=https://riverton.base.win', 'STARBASE_BRAND=base',
    'STARBASE_ORG_NAME=&quot;Riverton Forward&quot;', 'STARBASE_JURISDICTION=bc-municipal', 'STARBASE_PROVINCE=ON', 'STARBASE_TZ=America/Toronto',
    'STARBASE_CITY=&quot;Riverton&quot;', 'STARBASE_SLATES=&quot;council:City council&quot;', `STARBASE_GEO_BOUNDS=${BOUNDS}`, 'STARBASE_CANDIDATES=none',
    `BASE_PLATFORM_PUBKEY=${publicKeyOf(SIGNING).publicKey}`]) {
    assert.ok(lines.includes(line), line);
  }
  assert.match(block, /STARBASE_TWO_STEP_KEY=<span data-random><\/span>/);
  assert.match(block, /GOOGLE_TOKEN_KEY=<span data-random><\/span>/);
  // Each client is at its own address: no path under base.win, nothing of the door's.
  for (const bad of ['BASE_PATH', 'BASE_DOOR_KEY', 'BASE_CLIENTS', 'base.win/']) assert.ok(!block.includes(bad), bad);
  assert.doesNotMatch(body, /BASE_DOOR_KEY|BASE_CLIENTS|BASE_PATH|Tell the door|the door/);
  // Nothing of staging's sample: its settings, its Vancouver map box, its made-up opponents.
  const sampleBox = sampleValue('STARBASE_GEO_BOUNDS');
  const sampleOpponents = sampleValue('STARBASE_CANDIDATES');
  assert.match(sampleBox, /^49\.\d+,-123\.\d+\|/, 'render.yaml still gives the sample a Vancouver box');
  for (const bad of ['Vancouver', 'Surrey', 'Imagine', 'demo@', 'STARBASE_SAMPLE', 'FRAME_HOSTS', sampleBox, ...sampleBox.split(/[|,]/), ...sampleOpponents.split(/[;:]/).filter((part) => part.length > 3), 'Hartwell', 'Opposed']) assert.ok(!block.includes(bad), bad);
  // The map area and the opponents are one line each, and only ever these values.
  assert.deepEqual(lines.filter((l) => l.includes('GEO_BOUNDS')), [`STARBASE_GEO_BOUNDS=${BOUNDS}`]);
  assert.deepEqual(lines.filter((l) => l.includes('CANDIDATES')), ['STARBASE_CANDIDATES=none']);
  for (const k of DENY) assert.ok(!block.includes(k), k);
  assert.ok(!DENY.includes('STARBASE_GEO_BOUNDS') && DENY.includes('STARBASE_SAMPLE') && DENY.includes('STARBASE_DEMO_EMAIL'));
  assert.equal(envLines({ name: 'x', display: 'X', values: { races: [] } }).find((l) => l.key === 'STARBASE_CANDIDATES').value, 'none', 'never a list of names, whatever the campaign');
  assert.match(body, /data-when-empty>STARBASE_TWO_STEP_KEY and GOOGLE_TOKEN_KEY are empty: press Generate next to each of these two in Render\./);
  // Before the address: no address card yet, Save address is the primary.
  assert.doesNotMatch(body, /Give it its address/);
  assert.match(body, /btn btn-primary" type="submit">Save address/);
  assert.equal([...body.matchAll(/btn-primary/g)].length, 1);
  // A quote or a line break in a name can't break the block.
  assert.equal(envText({ name: 'x', display: 'A "B"\nC', values: { city: 'D\\E', races: [] } }).split('\n').find((l) => l.startsWith('STARBASE_ORG_NAME')), 'STARBASE_ORG_NAME="A B C"');
});

test('no usable signing key: the key page’s warning in place of the block, never an empty BASE_PLATFORM_PUBKEY', async () => {
  for (const value of ['', 'too-short']) {
    process.env.PLATFORM_SIGNING_KEY = value;
    const res = await b.get('/c/riverton/setup');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /PLATFORM_SIGNING_KEY in Render is missing or too short\. Press Generate next to it, then Save and deploy\./);
    assert.match(body, /on the control centre’s own service in Render \(base-platform\)/);
    assert.doesNotMatch(body, /id="env-block"/);
    assert.doesNotMatch(body, /BASE_PLATFORM_PUBKEY=/);
    assert.doesNotMatch(body, /data-random|data-copy="env-block"/);
    // The key page says the same words.
    assert.ok((await (await b.get('/key')).text()).includes('PLATFORM_SIGNING_KEY in Render is missing or too short. Press Generate next to it, then Save and deploy.'));
  }
  baseEnv();
  assert.match(envBlock(await (await b.get('/c/riverton/setup')).text()), /BASE_PLATFORM_PUBKEY=[A-Za-z0-9_-]{43}\n/);
});

test('pasting its address: a stale code saves nothing; then it answers, pins, and the next card gives it its own address', async () => {
  const R = 'https://base-win-riverton.onrender.com';
  answers.set(`${R}/api/health`, health(R));
  await stale();
  const s = await b.post('/c/riverton/setup', { server_url: R });
  assert.equal(s.status, 401);
  assert.match(await s.text(), /value="https:\/\/base-win-riverton\.onrender\.com"[\s\S]*It’s been more than 10 minutes/);
  assert.equal((await db.query("select server_url from environments where campaign = 'riverton'")).rows[0].server_url, null);
  assert.equal((await b.post('/c/riverton/setup', { server_url: 'http://base-win-riverton.onrender.com' })).status, 401, 'still stale');
  const ok = await b.post('/c/riverton/setup', { server_url: `${R}/`, code: await codeNow(db, op.secret) });
  assert.equal(ok.headers.get('location'), '/c/riverton/setup');
  assert.equal((await db.query("select instance from environments where campaign = 'riverton'")).rows[0].instance, INST);
  let body = await (await b.get('/c/riverton/setup')).text();
  assert.match(body, /role="status" aria-live="polite">Answering</);
  // The card: a custom domain on its own service, a CNAME at the registrar, the certificate.
  const card = /<li class="card"><h2>Give it its address<\/h2>([\s\S]*?)<\/li>\s*<li class="card"><h2>Invite the first manager/.exec(body)[1];
  assert.match(card, /Render → this campaign’s service → <b>Settings → Custom Domains<\/b> → add <code>riverton\.base\.win<\/code>\./);
  assert.match(card, /add a <b>CNAME<\/b> record named <code>riverton<\/code> pointing at <code>base-win-riverton\.onrender\.com<\/code>\./);
  assert.match(card, /Wait until Render shows the domain as verified and its certificate as issued\./);
  assert.match(card, /“Answers at riverton\.base\.win” on the campaign’s checklist ticks by itself\./);
  assert.match(card, /Not answering at riverton\.base\.win yet\. It is checked every 5 minutes\./);
  assert.doesNotMatch(body, /Tell the door|door-value|BASE_CLIENTS|This keeps:|Adds:/);
  assert.match(body, /btn btn-primary" type="submit">Invite and open the desk/);
  assert.match(body, /btn btn-quiet" type="submit">Save address/);
  assert.equal([...body.matchAll(/btn-primary/g)].length, 1);
  assert.ok(!(await done('riverton')).has('public'), 'not ticked before the address answers');
  // Some other server answers at that name: said, and not ticked.
  answers.set('https://riverton.base.win/api/health', health(R, { instance: 'AAAAAAAAAAAAAAAAAAAAAA' }));
  await b.post('/c/riverton/check-now', {});
  assert.match(await (await b.get('/c/riverton/setup')).text(), /riverton\.base\.win answers, but from another server: check the CNAME record\./);
  assert.ok(!(await done('riverton')).has('public'));
  // The domain is added: the check of https://riverton.base.win reaches the pinned server.
  answers.set('https://riverton.base.win/api/health', health(R));
  await b.post('/c/riverton/check-now', {});
  body = await (await b.get('/c/riverton/setup')).text();
  assert.match(body, /class="oc-status oc-ok" role="status" aria-live="polite">Answering at riverton\.base\.win</);
  assert.equal((await done('riverton')).get('public'), 'auto');
  assert.match(await (await b.get('/c/riverton')).text(), /Answers at riverton\.base\.win<\/span>\s*<span class="oc-check-state">Done by itself/);
});

test('a new service on a release from before base.win sign-in: the address card says so, and what to do', async () => {
  const W = 'https://base-win-westcan.onrender.com';
  answers.set(`${W}/api/health`, { ok: true, database: 'ok', service: 'starbase', env: 'production', commit: '04ab25f', tzdataCurrent: true });
  assert.equal((await b.post('/c/westcan/setup', { server_url: W })).status, 303);
  const body = await (await b.get('/c/westcan/setup')).text();
  assert.match(body, /Answering, but on a release from before base\.win sign-in\. Run Promote to production \(GitHub → Actions\), wait for ‘Live’ in Render, then press Save address again\./);
  assert.doesNotMatch(body, /somewhere else|Give it its address|Invite the first manager/);
  assert.match(body, /btn btn-primary" type="submit">Save address/);
});

test('the checklist: nothing of the door, the address ticks by itself, and nothing new to tick by hand', () => {
  const keys = ITEMS.map((i) => i.key);
  assert.deepEqual(keys, ['service', 'answers', 'tz', 'entry', 'public', 'campaign-made', 'first-manager-invited', 'email', 'first-manager-in']);
  assert.deepEqual(ITEMS.find((i) => i.key === 'public'), { key: 'public', words: 'Answers at <name>.base.win', by: 'auto' });
  assert.deepEqual(MANUAL, ['service', 'first-manager-invited', 'email', 'first-manager-in']);
  for (const i of ITEMS) assert.doesNotMatch(`${i.key} ${i.words}`, /door|base\.win\//i, i.key);
});

test('Add a running campaign: made, service ticked by you, checked and pinned at once', async () => {
  const I = 'https://base-win.onrender.com';
  answers.set(`${I}/api/health`, health(I, { instance: 'IIIIIIIIIIIIIIIIIIIIII', tzdataCurrent: false }));
  await stale();
  const s = await b.post('/existing', { name: 'running', display: 'Example Running', server_url: I });
  assert.equal(s.status, 401);
  assert.match(await s.text(), /value="Example Running"/);
  assert.equal((await db.query("select count(*)::int n from campaigns where name = 'running'")).rows[0].n, 0);
  const taken = await b.post('/existing', { name: 'other', display: 'Other', server_url: 'https://base-win-riverton.onrender.com', code: await codeNow(db, op.secret) });
  assert.equal(taken.status, 409);
  assert.match(await taken.text(), /That address is already saved for Riverton Forward\./);
  const ok = await b.post('/existing', { name: 'running', display: 'Example Running', server_url: I });
  assert.equal(ok.headers.get('location'), '/c/running');
  assert.equal((await db.query("select instance from environments where campaign = 'running'")).rows[0].instance, 'IIIIIIIIIIIIIIIIIIIIII');
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'campaign.add-existing'")).rows[0].n, 1);
  const d = await done('running');
  assert.equal(d.get('service'), 'you');
  assert.equal(d.get('answers'), 'auto');
  assert.ok(!d.has('tz') && !d.has('public'));
  assert.deepEqual((await db.query("select values from campaigns where name = 'running'")).rows[0].values, {});
});

test('Set-up steps for a campaign that was already running: a short page, only base.win’s key and its address; none of its settings', async () => {
  assert.equal(hasValues({}), false);
  assert.equal(hasValues({ city: 'Riverton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: ['council'] }), false, 'no map area: not enough to make a block from');
  const res = await b.get('/c/running/setup');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<h1>Set up Example Running<\/h1>/);
  assert.match(body, /This campaign was already running when it was added here, so its settings live in Render \(its service → <b>Environment<\/b>\)\./);
  // The one line to add, whole.
  assert.match(body, new RegExp(`<pre class="oc-pre" id="key-line">BASE_PLATFORM_PUBKEY=${publicKeyOf(SIGNING).publicKey}</pre>`));
  assert.match(body, /data-copy="key-line"/);
  // Its own address: the custom-domain step, with the service's onrender.com address.
  assert.match(body, /<h2>Give it its address<\/h2>/);
  assert.match(body, /Custom Domains<\/b> → add <code>running\.base\.win<\/code>/);
  assert.match(body, /<b>CNAME<\/b> record named <code>running<\/code> pointing at <code>base-win\.onrender\.com<\/code>/);
  // Never the brand, the campaign values or the two random keys; no block, no form.
  assert.doesNotMatch(body, /STARBASE_|NODE_ENV|GOOGLE_TOKEN_KEY|TWO_STEP|data-random|id="env-block"|yaml-snippet|undefined|<form method="post" action="\/c\/running/);
  assert.equal([...body.matchAll(/[A-Z][A-Z0-9_]{3,}=/g)].map((m) => m[0]).join(), 'BASE_PLATFORM_PUBKEY=', 'one setting line on the page');
  assert.equal([...body.matchAll(/btn-primary/g)].length, 0);
  // Its page links here, and the page says when sign-in is already ready there.
  assert.match(await (await b.get('/c/running')).text(), /href="\/c\/running\/setup">Set-up steps</);
  assert.match(body, /base\.win sign-in is ready there/);
  // No usable key: the warning, and no line with an empty value.
  process.env.PLATFORM_SIGNING_KEY = '';
  const none = await (await b.get('/c/running/setup')).text();
  assert.match(none, /PLATFORM_SIGNING_KEY in Render is missing or too short\./);
  assert.doesNotMatch(none, /BASE_PLATFORM_PUBKEY=/);
  baseEnv();
  // With no address saved, the card says where to find it.
  await b.post('/c/running/edit', { display: 'Example Running', server_url: '' });
  const bare = await b.get('/c/running/setup');
  assert.equal(bare.status, 200);
  assert.match(await bare.text(), /pointing at the service’s onrender\.com address \(at the top of its Render page\)\./);
  await b.post('/c/running/edit', { display: 'Example Running', server_url: 'https://base-win.onrender.com' });
  // The sample and an unknown name have no such page.
  assert.equal((await b.get('/c/sample/setup')).status, 404);
  assert.equal((await b.get('/c/nobody/setup')).status, 404);
});

test('auto ticks are set from the checks and never cleared by a later failure', async () => {
  let d = await done('riverton');
  for (const item of ['service', 'answers', 'tz', 'entry', 'public', 'campaign-made']) assert.equal(d.get(item), 'auto', item);
  answers.set('https://base-win-riverton.onrender.com/api/health', health('https://base-win-riverton.onrender.com', { database: 'not reachable', tzdataCurrent: false, entry: 'no-key', store: 'embedded' }));
  answers.delete('https://riverton.base.win/api/health');
  await b.post('/c/riverton/check-now', {});
  d = await done('riverton');
  for (const item of ['answers', 'tz', 'entry', 'public', 'campaign-made']) assert.equal(d.get(item), 'auto', item);
  const page = await (await b.get('/c/riverton')).text();
  assert.match(page, /Database not reachable/);
  assert.match(page, /riverton\.base\.win not answering/);
  assert.match(page, /Time zone data current<\/span>\s*<span class="oc-check-state">Done by itself/);
  const ticks = (await db.query("select count(*)::int n from ops_log where action = 'checklist.tick' and campaign = 'riverton'")).rows[0].n;
  await b.post('/c/riverton/check-now', {});
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'checklist.tick' and campaign = 'riverton'")).rows[0].n, ticks, 'no tick twice');
});

test('the render.yaml block for us: the production block’s keys only, nothing denied, nothing of the door, no secret with a value', () => {
  const prodBlock = YAML.slice(YAML.indexOf('name: base-win\n'), YAML.indexOf('name: base-platform\n'));
  const prodKeys = new Set([...prodBlock.matchAll(/- key: ([A-Z0-9_]+)/g)].map((m) => m[1]));
  // What a new client is given that Imagine Surrey's own block may not name.
  const A_NEW_CLIENT = ['STARBASE_PROVINCE', 'STARBASE_TWO_STEP_KEY', 'STARBASE_GEO_BOUNDS', 'STARBASE_CANDIDATES'];
  const snippet = renderSnippet({ name: 'riverton', display: 'Riverton Forward', values: { city: 'Riverton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: ['council'], bounds: BOUNDS } });
  const keys = [...snippet.matchAll(/- key: ([A-Z0-9_]+)/g)].map((m) => m[1]);
  for (const k of keys) assert.ok(prodKeys.has(k) || A_NEW_CLIENT.includes(k), k);
  assert.equal(new Set(keys).size, keys.length, 'no key twice');
  for (const k of [...DENY, 'BASE_PATH', 'BASE_DOOR_KEY', 'BASE_CLIENTS']) assert.ok(!snippet.includes(k), k);
  const after = (k) => snippet.split('\n')[snippet.split('\n').findIndex((l) => l.trim() === `- key: ${k}`) + 1].trim();
  assert.equal(after('BASE_PLATFORM_PUBKEY'), 'sync: false');
  assert.equal(after('STARBASE_TWO_STEP_KEY'), 'generateValue: true');
  assert.equal(after('GOOGLE_TOKEN_KEY'), 'generateValue: true');
  assert.equal(after('STARBASE_GEO_BOUNDS'), `value: "${BOUNDS}"`);
  assert.equal(after('STARBASE_CANDIDATES'), 'value: "none"');
  assert.equal(after('STARBASE_PUBLIC_URL'), 'value: "https://riverton.base.win"');
  assert.ok(!snippet.includes(publicKeyOf(SIGNING).publicKey));
  assert.match(snippet, /name: base-win-riverton\n/);
  // The database: 0.5 CPU, 1 GB, by the name Render gives that plan.
  assert.match(snippet, /- name: base-win-riverton-db\n {4}plan: basic-1gb\n/);
  assert.doesNotMatch(snippet, /0\.5c-1g/);
});
