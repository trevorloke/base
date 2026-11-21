// Campaigns: the list and one campaign's page with their chips and lines;
// Edit, Archive and Confirm behind the code window (nothing saved on a
// stale one); one address per environment; a changed address forgets the
// pin; Check now needs no code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, setUp, codeNow, baseEnv } from './helpers.mjs';
import { makeApp } from '../server.mjs';
import { createCampaign, openBlock, chipsFor } from '../campaigns.mjs';
import { currentKid } from '../keys.mjs';

baseEnv();
const INST = 'EBESExQVFhcYGRobHB0eHw';
const A = 'https://base-win-a.onrender.com';
const B = 'https://base-win-b.onrender.com';
const S = 'https://starbase-staging.onrender.com';
const answers = new Map();
const fetcher = async (url) => {
  const a = answers.get(url);
  if (!a) throw Object.assign(new Error('x'), { name: 'ECONNREFUSED' });
  return { status: a.status || 200, body: JSON.stringify(a.body), ms: 4 };
};
const health = (origin, over = {}) => ({
  ok: true, database: 'ok', service: 'starbase', env: 'production', commit: 'd9130ae', tzdataCurrent: true, ownOrigin: origin, instance: INST,
  address: 'https://base.win/a', entry: 'ready', platformKids: [currentKid()], setupOpen: false, campaignMade: true, doorKey: true, ...over,
});
const { db } = await freshApp();
const app = makeApp({ db, fetcher });
const op = await setUp(app, db);
const b = op.b;
await db.transaction((tx) => createCampaign(tx, { name: 'a', display: 'Example A', serverUrl: A, values: { city: 'Exampleton', races: ['council'] } }));
await db.transaction((tx) => createCampaign(tx, { name: 'b', display: 'Example B', serverUrl: B }));
const pinned = async (name) => (await db.query('select instance, server_url from environments where campaign = $1', [name])).rows[0];
const stale = () => db.query("update ops_sessions set code_at = now() - interval '11 minutes'");

test('before the first poll: Not checked yet; the sample row offers to set its address', async () => {
  const body = await (await b.get('/')).text();
  assert.match(body, /Sample \(staging\)/);
  assert.match(body, /<form method="post" action="\/sample"[\s\S]*Set its address<\/button>/);
  assert.match(body, /Example A<\/a>\s*<span class="oc-line">Not checked yet/);
  assert.equal([...body.matchAll(/btn-primary/g)].length, 1, 'one primary');
});

test('Check now needs no fresh code; a healthy server answers, pins, and shows no chips', async () => {
  answers.set(`${A}/api/health`, { body: health(A) });
  answers.set('https://base.win/a/api/health', { body: health(A) });
  await stale();
  const res = await b.post('/c/a/check-now', {});
  assert.equal(res.headers.get('location'), '/c/a');
  assert.equal((await pinned('a')).instance, INST);
  const page = await (await b.get('/c/a')).text();
  assert.match(page, /<dt>Answering<\/dt><dd>Yes<\/dd>/);
  assert.match(page, /<dt>base.win sign-in<\/dt><dd>Ready<\/dd>/);
  assert.match(page, /Answered 1 of 1 check today/);
  assert.match(page, /<dt>City<\/dt><dd>Exampleton<\/dd>/);
  assert.doesNotMatch(page, /class="chip/);
  assert.doesNotMatch(page, /class="oc-block"/);
  const list = await (await b.get('/')).text();
  assert.match(list, /Production · Answering · d9130ae · checked just now/);
});

test('the chips, only when true', async () => {
  const camp = { name: 'a', kind: 'client' };
  const envRow = { env: 'production', server_url: A, instance: INST };
  const server = { answering: true, database: 'ok', tz_current: true, entry: 'ready', platform_kids: [currentKid()], own_origin: A, env_reported: 'production', instance: INST, door_key: true, commit: 'd9130ae' };
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server, door: { answering: true }, newest: 'd9130ae' }), []);
  assert.deepEqual(chipsFor({
    campaign: camp, envRow, door: { answering: false }, newest: 'e0e0e0e',
    server: { ...server, database: 'not reachable', tz_current: false, door_key: false, instance: 'AAAAAAAAAAAAAAAAAAAAAA' },
  }), ['Database not reachable', 'Time zone data old', 'Server changed: confirm it', 'Door key not set', 'base.win/a not answering', 'Version differs']);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, entry: 'no-key' } }), ['base.win sign-in not set up']);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, platform_kids: ['00000000'] } }), ['Key in Render is wrong: copy base.win’s key again']);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, own_origin: B } }), ['This server says it is somewhere else']);
});

test('no Open, and the right line, when the desk can’t be opened', async () => {
  const camp = { name: 'a', kind: 'client', archived_at: null };
  const envRow = { env: 'production', server_url: A, instance: INST };
  const ok = { answering: true, entry: 'ready', platform_kids: [currentKid()], own_origin: A, env_reported: 'production', instance: INST };
  assert.equal(openBlock(camp, envRow, ok), null);
  assert.equal(openBlock({ ...camp, archived_at: new Date() }, envRow, ok), 'archived');
  assert.equal(openBlock(camp, envRow, { ...ok, answering: false }), 'not-answering');
  assert.equal(openBlock(camp, envRow, { ...ok, entry: 'no-key' }), 'not-set-up');
  assert.equal(openBlock(camp, envRow, { ...ok, platform_kids: [] }), 'wrong-key');
  assert.equal(openBlock(camp, envRow, { ...ok, own_origin: B }), 'elsewhere');
  assert.equal(openBlock(camp, envRow, { ...ok, env_reported: 'staging' }), 'elsewhere');
  assert.equal(openBlock(camp, { ...envRow, instance: null }, ok), 'elsewhere');
  assert.equal(openBlock(camp, envRow, { ...ok, instance: 'AAAAAAAAAAAAAAAAAAAAAA' }), 'changed');
  assert.equal(openBlock(camp, { ...envRow, server_url: null }, ok), 'no-address');
  answers.set(`${B}/api/health`, { body: health(B, { entry: 'no-key', instance: 'BBBBBBBBBBBBBBBBBBBBBB' }) });
  await b.post('/c/b/check-now', {});
  const page = await (await b.get('/c/b')).text();
  assert.match(page, /base.win sign-in isn’t set up there: add BASE_PLATFORM_PUBKEY in Render \(copy it from base.win’s key\), Save and deploy\. If you just did, wait for ‘Live’, then press Check now\./);
  answers.set(`${B}/api/health`, { status: 503, body: 'x' });
  answers.delete(`${B}/api/health`);
  await b.post('/c/b/check-now', {});
  assert.match(await (await b.get('/c/b')).text(), /Not answering — can’t open the desk\./);
  assert.match(await (await b.get('/')).text(), /Not answering since \d{1,2}:\d\d [ap]m/);
});

test('each state-changing form with a stale code shows its page with a Code field and saves nothing; a right code saves and logs the step-up', async () => {
  await stale();
  const edit = await b.post('/c/a/edit', { display: 'Renamed A', server_url: A });
  assert.equal(edit.status, 401);
  const editBody = await edit.text();
  assert.match(editBody, /It’s been more than 10 minutes: type your code\./);
  assert.match(editBody, /value="Renamed A"/, 'what was typed is kept');
  assert.equal((await db.query("select display from campaigns where name = 'a'")).rows[0].display, 'Example A');
  const arch = await b.post('/c/a/archive', {});
  assert.equal(arch.status, 401);
  assert.match(await arch.text(), /<details class="oc-more" open>[\s\S]*name="code"[\s\S]*Archive/);
  assert.equal((await db.query("select archived_at from campaigns where name = 'a'")).rows[0].archived_at, null);
  const wrong = await b.post('/c/a/archive', { code: '000000' });
  assert.match(await wrong.text(), /That code didn’t work/);
  const right = await b.post('/c/a/edit', { display: 'Renamed A', server_url: A, code: await codeNow(db, op.secret) });
  assert.equal(right.headers.get('location'), '/c/a');
  assert.equal((await db.query("select display from campaigns where name = 'a'")).rows[0].display, 'Renamed A');
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'stepup'")).rows[0].n, 1);
  const editLog = (await db.query("select payload from ops_log where action = 'campaign.edit'")).rows[0].payload;
  assert.deepEqual(editLog, { env: 'production', before: { display: 'Example A', server_url: A }, after: { display: 'Renamed A', server_url: A } });
  assert.equal((await pinned('a')).instance, INST, 'the same address keeps the pin');
  // Fresh now: archive and bring back without a code.
  assert.equal((await b.post('/c/a/archive', {})).status, 303);
  assert.ok((await db.query("select archived_at from campaigns where name = 'a'")).rows[0].archived_at);
  assert.match(await (await b.get('/c/a')).text(), /Archived — bring it back/);
  assert.equal((await b.post('/c/a/unarchive', {})).status, 303);
  assert.deepEqual((await db.query("select action from ops_log where action like 'campaign.%archive' order by seq")).rows.map((r) => r.action), ['campaign.archive', 'campaign.unarchive']);
});

test('two environments can’t save the same address; a changed address forgets the pin', async () => {
  const taken = await b.post('/c/sample/edit', { display: 'Sample (staging)', server_url: `${A}/admin` });
  assert.equal(taken.status, 409);
  assert.match(await taken.text(), /That address is already saved for Renamed A\./);
  assert.equal((await pinned('sample')).server_url, null);
  assert.equal((await b.post('/c/sample/edit', { display: 'Sample (staging)', server_url: 'http://insecure.example.org' })).status, 400);
  answers.set(`${S}/api/health`, { body: health(S, { env: 'staging', instance: 'SSSSSSSSSSSSSSSSSSSSSS' }) });
  assert.equal((await b.post('/c/sample/edit', { display: 'Sample (staging)', server_url: 'HTTPS://Starbase-Staging.onrender.com:443/' })).status, 303);
  assert.deepEqual(await pinned('sample'), { instance: 'SSSSSSSSSSSSSSSSSSSSSS', server_url: S }, 'saved normalized, polled and pinned at once');
  assert.equal((await b.post('/c/a/edit', { display: 'Renamed A', server_url: 'https://base-win-a2.onrender.com' })).status, 303);
  assert.deepEqual(await pinned('a'), { instance: null, server_url: 'https://base-win-a2.onrender.com' });
});

test('a server that changed: the chip, then Confirm (behind the code) re-pins and logs old and new', async () => {
  answers.set('https://base-win-a2.onrender.com/api/health', { body: health('https://base-win-a2.onrender.com') });
  await b.post('/c/a/check-now', {});
  assert.equal((await pinned('a')).instance, INST);
  answers.set('https://base-win-a2.onrender.com/api/health', { body: health('https://base-win-a2.onrender.com', { instance: 'NNNNNNNNNNNNNNNNNNNNNN' }) });
  await b.post('/c/a/check-now', {});
  const page = await (await b.get('/c/a')).text();
  assert.match(page, /Server changed: confirm it/);
  assert.match(page, /This server has changed since it was added\./);
  assert.match(page, /Confirm it’s the same campaign/);
  await stale();
  const s = await b.post('/c/a/confirm-server', { env: 'production' });
  assert.equal(s.status, 401);
  assert.equal((await pinned('a')).instance, INST);
  const ok = await b.post('/c/a/confirm-server', { env: 'production', code: await codeNow(db, op.secret) });
  assert.equal(ok.headers.get('location'), '/c/a');
  assert.equal((await pinned('a')).instance, 'NNNNNNNNNNNNNNNNNNNNNN');
  const repin = (await db.query("select payload from ops_log where action = 'environment.repin'")).rows[0].payload;
  assert.deepEqual(repin, { env: 'production', old: INST, new: 'NNNNNNNNNNNNNNNNNNNNNN' });
  assert.equal((await b.post('/c/a/confirm-server', { env: 'production' })).status, 409, 'nothing left to confirm');
  // Its page's log lines, newest first.
  assert.match(await (await b.get('/c/a')).text(), /Confirmed the production server changed · Renamed A[\s\S]*Recognised the production server/);
});

test('an unknown campaign is a 404', async () => {
  assert.equal((await b.get('/c/nobody')).status, 404);
  assert.equal((await b.post('/c/nobody/archive', {})).status, 404);
});
