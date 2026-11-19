// New campaign, Set it up, and Add a running campaign: the short-name
// rules, the .env block (the campaign's own values, nothing of staging's,
// the random lines left to the browser), the time zone from the province,
// the door's whole value, the render.yaml block for us, the code window on
// every save, and the checklist ticking itself (and staying ticked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshApp, setUp, codeNow, baseEnv, SIGNING } from './helpers.mjs';
import { makeApp } from '../server.mjs';
import { RESERVED } from '../campaigns.mjs';
import { publicKeyOf, currentKid } from '../keys.mjs';
import { tzFor, doorValue, renderSnippet, envText, JURISDICTIONS, DENY } from '../snippets.mjs';
import { readClients } from '../../door/door.mjs';
import { JURISDICTIONS as SERVER_RULES } from '../../../server/lib/org.js';

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
  address: 'https://base.win/x', entry: 'ready', platformKids: [currentKid()], setupOpen: false, campaignMade: true, doorKey: true, ...over,
});
const { db } = await freshApp();
const app = makeApp({ db, fetcher });
const op = await setUp(app, db);
const b = op.b;
const stale = () => db.query("update ops_sessions set code_at = now() - interval '11 minutes'");
const NEW = { name: 'riverton', display: 'Riverton Forward', city: 'Riverton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: 'council' };
const envBlock = (body) => /<pre class="oc-pre" id="env-block">([\s\S]*?)<\/pre>/.exec(body)[1];
const done = async (name) => new Map((await db.query('select item, done_by from checklist where campaign = $1 and done_at is not null', [name])).rows.map((r) => [r.item, r.done_by]));

test('short names: the door’s rule, the reserved list (sample too), no capitals, no trailing dash, not taken', async () => {
  for (const name of RESERVED) {
    const res = await b.post('/new', { ...NEW, name });
    assert.equal(res.status, 400, name);
    assert.match(await res.text(), /That name is kept for base\.win\./, name);
  }
  assert.ok(RESERVED.includes('sample') && RESERVED.includes('ops'));
  for (const name of ['Riverton', 'riverton-', '-riverton', 'river ton', '', 'a'.repeat(64)]) {
    const res = await b.post('/new', { ...NEW, name });
    assert.match(await res.text(), /Use letters, numbers and dashes\. It’s the address: base\.win\/&lt;name&gt;\./, name);
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
  assert.match(body, /<option value="ON" selected data-tz="America\/Toronto">/);
  assert.equal((await db.query("select count(*)::int n from campaigns where name = 'riverton'")).rows[0].n, 0);
  const ok = await b.post('/new', { ...NEW, code: await codeNow(db, op.secret) });
  assert.equal(ok.headers.get('location'), '/c/riverton/setup');
  const row = (await db.query("select display, kind, values from campaigns where name = 'riverton'")).rows[0];
  assert.deepEqual(row, { display: 'Riverton Forward', kind: 'client', values: { city: 'Riverton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: ['council'] } });
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'campaign.create' and campaign = 'riverton'")).rows[0].n, 1);
  const dup = await b.post('/new', NEW);
  assert.match(await dup.text(), /That name is taken\./);
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

test('the .env block: every value asked for, the base.win address, base.win’s key; nothing of staging; the random lines empty for the browser', async () => {
  const body = await (await b.get('/c/riverton/setup')).text();
  const block = envBlock(body);
  for (const line of ['NODE_ENV=production', 'STARBASE_ENV=production', 'BASE_PATH=/riverton', 'STARBASE_PUBLIC_URL=https://base.win/riverton', 'STARBASE_BRAND=base',
    'STARBASE_ORG_NAME=&quot;Riverton Forward&quot;', 'STARBASE_JURISDICTION=bc-municipal', 'STARBASE_PROVINCE=ON', 'STARBASE_TZ=America/Toronto',
    'STARBASE_CITY=&quot;Riverton&quot;', 'STARBASE_SLATES=&quot;council:City council&quot;', `BASE_PLATFORM_PUBKEY=${publicKeyOf(SIGNING).publicKey}`]) {
    assert.ok(block.includes(line), line);
  }
  assert.match(block, /STARBASE_TWO_STEP_KEY=<span data-random><\/span>/);
  assert.match(block, /GOOGLE_TOKEN_KEY=<span data-random><\/span>/);
  for (const bad of ['Vancouver', 'Surrey', 'Imagine', 'demo@', 'STARBASE_SAMPLE', 'FRAME_HOSTS', 'CANDIDATES', 'GEO_BOUNDS']) assert.ok(!block.includes(bad), bad);
  assert.match(body, /data-when-empty>STARBASE_TWO_STEP_KEY and GOOGLE_TOKEN_KEY are empty: press Generate next to each of these two in Render\./);
  // Before the address: no door card, Save address is the primary.
  assert.doesNotMatch(body, /Tell the door/);
  assert.match(body, /btn btn-primary" type="submit">Save address/);
  assert.equal([...body.matchAll(/btn-primary/g)].length, 1);
  // A quote or a line break in a name can't break the block.
  assert.equal(envText({ name: 'x', display: 'A "B"\nC', values: { city: 'D\\E', races: [] } }).split('\n').find((l) => l.startsWith('STARBASE_ORG_NAME')), 'STARBASE_ORG_NAME="A B C"');
});

test('pasting its address: a stale code saves nothing; then it answers, pins, and the door card shows the whole value', async () => {
  const R = 'https://base-win-riverton.onrender.com';
  answers.set(`${R}/api/health`, health(R));
  answers.set('https://base.win/riverton/api/health', health(R));
  await stale();
  const s = await b.post('/c/riverton/setup', { server_url: R });
  assert.equal(s.status, 401);
  assert.match(await s.text(), /value="https:\/\/base-win-riverton\.onrender\.com"[\s\S]*It’s been more than 10 minutes/);
  assert.equal((await db.query("select server_url from environments where campaign = 'riverton'")).rows[0].server_url, null);
  assert.equal((await b.post('/c/riverton/setup', { server_url: 'http://base-win-riverton.onrender.com' })).status, 401, 'still stale');
  const ok = await b.post('/c/riverton/setup', { server_url: `${R}/`, code: await codeNow(db, op.secret) });
  assert.equal(ok.headers.get('location'), '/c/riverton/setup');
  assert.equal((await db.query("select instance from environments where campaign = 'riverton'")).rows[0].instance, INST);
  const body = await (await b.get('/c/riverton/setup')).text();
  assert.match(body, /role="status" aria-live="polite">Answering</);
  assert.match(body, /Tell the door/);
  assert.match(body, /Adds: riverton\./);
  assert.doesNotMatch(body, /This keeps:/);
  assert.match(body, /btn btn-primary" type="submit">Invite and open the desk/);
  assert.match(body, /btn btn-quiet" type="submit">Save address/);
  assert.equal([...body.matchAll(/btn-primary/g)].length, 1);
  const value = /<pre class="oc-pre" id="door-value">([\s\S]*?)<\/pre>/.exec(body)[1].replace(/&quot;/g, '"');
  const clients = readClients(value);
  assert.deepEqual([...clients.entries()], [['riverton', { name: 'Riverton Forward', origin: R }]]);
});

test('Add a running campaign: made, service ticked by you, checked and pinned at once; the door value keeps it', async () => {
  const I = 'https://base-win.onrender.com';
  answers.set(`${I}/api/health`, health(I, { instance: 'IIIIIIIIIIIIIIIIIIIIII', tzdataCurrent: false, doorKey: false }));
  await stale();
  const s = await b.post('/existing', { name: 'imaginesurrey', display: 'Example Running', server_url: I });
  assert.equal(s.status, 401);
  assert.match(await s.text(), /value="Example Running"/);
  assert.equal((await db.query("select count(*)::int n from campaigns where name = 'imaginesurrey'")).rows[0].n, 0);
  const taken = await b.post('/existing', { name: 'other', display: 'Other', server_url: 'https://base-win-riverton.onrender.com', code: await codeNow(db, op.secret) });
  assert.equal(taken.status, 409);
  assert.match(await taken.text(), /That address is already saved for Riverton Forward\./);
  const ok = await b.post('/existing', { name: 'imaginesurrey', display: 'Example Running', server_url: I });
  assert.equal(ok.headers.get('location'), '/c/imaginesurrey');
  assert.equal((await db.query("select instance from environments where campaign = 'imaginesurrey'")).rows[0].instance, 'IIIIIIIIIIIIIIIIIIIIII');
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'campaign.add-existing'")).rows[0].n, 1);
  const d = await done('imaginesurrey');
  assert.equal(d.get('service'), 'you');
  assert.equal(d.get('answers'), 'auto');
  assert.ok(!d.has('tz') && !d.has('door-key'));
  const body = await (await b.get('/c/riverton/setup')).text();
  assert.match(body, /This keeps: imaginesurrey\. Adds: riverton\./);
  const value = /id="door-value">([\s\S]*?)<\/pre>/.exec(body)[1].replace(/&quot;/g, '"');
  assert.deepEqual([...readClients(value).keys()], ['imaginesurrey', 'riverton']);
  // An archived one, or one with no address, is left out.
  await db.query("update campaigns set archived_at = now() where name = 'imaginesurrey'");
  const v2 = doorValue((await db.query("select c.name, c.display, c.kind, c.archived_at, e.server_url from campaigns c join environments e on e.campaign = c.name")).rows, 'riverton');
  assert.deepEqual(Object.keys(JSON.parse(v2.value)), ['riverton']);
  assert.ok(!v2.value.includes('sample'));
  await db.query("update campaigns set archived_at = null where name = 'imaginesurrey'");
});

test('auto ticks are set from the checks and never cleared by a later failure', async () => {
  let d = await done('riverton');
  for (const item of ['service', 'answers', 'tz', 'entry', 'door-key', 'door', 'campaign-made']) assert.equal(d.get(item), 'auto', item);
  answers.set('https://base-win-riverton.onrender.com/api/health', health('https://base-win-riverton.onrender.com', { database: 'not reachable', tzdataCurrent: false, entry: 'no-key', doorKey: false }));
  answers.delete('https://base.win/riverton/api/health');
  await b.post('/c/riverton/check-now', {});
  d = await done('riverton');
  for (const item of ['answers', 'tz', 'entry', 'door-key', 'door', 'campaign-made']) assert.equal(d.get(item), 'auto', item);
  const page = await (await b.get('/c/riverton')).text();
  assert.match(page, /Database not reachable/);
  assert.match(page, /Time zone data current<\/span>\s*<span class="oc-check-state">Done by itself/);
  const ticks = (await db.query("select count(*)::int n from ops_log where action = 'checklist.tick' and campaign = 'riverton'")).rows[0].n;
  await b.post('/c/riverton/check-now', {});
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'checklist.tick' and campaign = 'riverton'")).rows[0].n, ticks, 'no tick twice');
});

test('the render.yaml block for us: the production block’s keys only, nothing denied, no secret with a value', () => {
  const yaml = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
  const prodBlock = yaml.slice(yaml.indexOf('name: base-win\n'), yaml.indexOf('name: base-platform\n'));
  const prodKeys = new Set([...prodBlock.matchAll(/- key: ([A-Z0-9_]+)/g)].map((m) => m[1]));
  // What a client behind the door needs that Imagine Surrey's own block doesn't name.
  const BEHIND_THE_DOOR = ['BASE_PATH', 'STARBASE_PROVINCE', 'STARBASE_TWO_STEP_KEY', 'BASE_DOOR_KEY'];
  const snippet = renderSnippet({ name: 'riverton', display: 'Riverton Forward', values: { city: 'Riverton', province: 'ON', rules: 'bc-municipal', tz: 'America/Toronto', races: ['council'] } });
  const keys = [...snippet.matchAll(/- key: ([A-Z0-9_]+)/g)].map((m) => m[1]);
  for (const k of keys) assert.ok(prodKeys.has(k) || BEHIND_THE_DOOR.includes(k), k);
  for (const k of DENY) assert.ok(!snippet.includes(k), k);
  const after = (k) => snippet.split('\n')[snippet.split('\n').findIndex((l) => l.trim() === `- key: ${k}`) + 1].trim();
  assert.equal(after('BASE_PLATFORM_PUBKEY'), 'sync: false');
  assert.equal(after('BASE_DOOR_KEY'), 'sync: false');
  assert.equal(after('STARBASE_TWO_STEP_KEY'), 'generateValue: true');
  assert.equal(after('GOOGLE_TOKEN_KEY'), 'generateValue: true');
  assert.ok(!snippet.includes(publicKeyOf(SIGNING).publicKey));
  assert.match(snippet, /name: base-win-riverton\n/);
  assert.match(snippet, /- key: STARBASE_PUBLIC_URL\n\s+value: "https:\/\/base\.win\/riverton"/);
});
