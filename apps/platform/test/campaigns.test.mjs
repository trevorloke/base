// Campaigns: the list and one campaign's page with their chips and lines;
// Edit, Archive and Confirm behind the code window (nothing saved on a
// stale one); one address per environment; a changed address forgets the
// pin; Check now needs no code. A client's own address is <name>.base.win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, setUp, codeNow, baseEnv } from './helpers.mjs';
import { makeApp } from '../server.mjs';
import { createCampaign, openBlock, chipsFor, entryState, publicState } from '../campaigns.mjs';
import { currentKid } from '../keys.mjs';

baseEnv();
const INST = 'EBESExQVFhcYGRobHB0eHw';
const A = 'https://base-win-a.onrender.com';
const B = 'https://base-win-b.onrender.com';
const S = 'https://base-win-staging.onrender.com';
const answers = new Map();
const fetcher = async (url) => {
  const a = answers.get(url);
  if (!a) throw Object.assign(new Error('x'), { name: 'ECONNREFUSED' });
  return { status: a.status || 200, body: JSON.stringify(a.body), ms: 4 };
};
const health = (origin, over = {}) => ({
  ok: true, database: 'ok', service: 'base.win', env: 'production', commit: 'd9130ae', tzdataCurrent: true, ownOrigin: origin, instance: INST,
  address: 'https://a.base.win', entry: 'ready', platformKids: [currentKid()], setupOpen: false, campaignMade: true, store: 'postgres', ...over,
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
  answers.set('https://a.base.win/api/health', { body: health(A) });
  await stale();
  const res = await b.post('/c/a/check-now', {});
  assert.equal(res.headers.get('location'), '/c/a');
  assert.equal((await pinned('a')).instance, INST);
  const page = await (await b.get('/c/a')).text();
  assert.match(page, /<dt>Answering<\/dt><dd>Yes<\/dd>/);
  assert.match(page, /<dt>base.win sign-in<\/dt><dd>Ready<\/dd>/);
  assert.match(page, /Answered 1 of 1 check today/);
  assert.match(page, /<dt>City<\/dt><dd>Exampleton<\/dd>/);
  assert.match(page, /<dt>Database<\/dt><dd>Fine<\/dd>/);
  assert.match(page, /<dt>a\.base\.win<\/dt><dd>Answering<\/dd>/);
  assert.match(page, /Answers at a\.base\.win<\/span>\s*<span class="oc-check-state">Done by itself/);
  assert.doesNotMatch(page, /[Dd]oor|base\.win\/a\b|Short address/, 'nothing of the door');
  assert.doesNotMatch(page, /class="chip/);
  assert.doesNotMatch(page, /class="oc-block"/);
  const list = await (await b.get('/')).text();
  assert.match(list, /Production · Answering · d9130ae · checked just now/);
});

test('the chips, only when true', async () => {
  const camp = { name: 'a', kind: 'client' };
  const envRow = { env: 'production', server_url: A, instance: INST };
  const server = { answering: true, database: 'ok', store: 'postgres', tz_current: true, entry: 'ready', platform_kids: [currentKid()], own_origin: A, env_reported: 'production', instance: INST, setup_open: false, campaign_made: true, commit: 'd9130ae' };
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server, pub: { answering: true }, newest: 'd9130ae', staging: 'd9130ae' }), []);
  assert.deepEqual(chipsFor({
    campaign: camp, envRow, pub: { answering: false }, newest: 'e0e0e0e',
    server: { ...server, database: 'not reachable', tz_current: false, instance: 'AAAAAAAAAAAAAAAAAAAAAA' },
  }), ['Database not reachable', 'Time zone data old', 'Server changed: confirm it', 'a.base.win not answering', 'Version differs']);
  // The door is not asked about: a server that says its key isn't set shows nothing for it.
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, door_key: false } }), []);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, entry: 'no-key' } }), ['base.win sign-in not set up']);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, platform_kids: ['00000000'] } }), ['Key in Render is wrong: copy base.win’s key again']);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, own_origin: B } }), ['This server says it is somewhere else']);
});

test('a campaign on a release from before base.win sign-in: said so, not “somewhere else”, and no Open', async () => {
  const camp = { name: 'a', kind: 'client', archived_at: null };
  const envRow = { env: 'production', server_url: A, instance: null };
  // What such a release answers: it is up, and says nothing of where it is or of sign-in.
  const old = { answering: true, database: 'ok', tz_current: true, env_reported: 'production', commit: '04ab25f', entry: null, own_origin: null, instance: null, platform_kids: null };
  assert.equal(entryState(old), 'old-release');
  assert.equal(openBlock(camp, envRow, old), 'old-release');
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: old }), ['On a release from before base.win sign-in']);
  // A current server always says how ready it is, so it is never taken for an old one.
  for (const entry of ['no-key', 'bad-key', 'no-origin']) {
    assert.equal(entryState({ ...old, entry }), 'not-set-up', entry);
    assert.notEqual(openBlock(camp, envRow, { ...old, entry, own_origin: A }), 'old-release', entry);
  }
  assert.equal(openBlock(camp, envRow, { ...old, entry: 'no-origin' }), 'elsewhere');
  // Something that answers but is no campaign server (no database word) is not called an old release.
  assert.equal(openBlock(camp, envRow, { answering: true, entry: null, own_origin: null, database: null }), 'elsewhere');
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { answering: true, database: 'ok', entry: null, own_origin: 'https://other.example.org', env_reported: 'production' } }), ['base.win sign-in not set up', 'This server says it is somewhere else']);
  // On the pages: the line says what to do, and there is nothing to open.
  const O = 'https://base-win-old.onrender.com';
  await db.transaction((tx) => createCampaign(tx, { name: 'old', display: 'Example Old', serverUrl: O }));
  answers.set(`${O}/api/health`, { body: { ok: true, database: 'ok', service: 'base.win', env: 'production', organization: 'Example Old', commit: '04ab25f', build: 'index-x.js', tzdataCurrent: true } });
  await b.post('/c/old/check-now', {});
  const page = await (await b.get('/c/old')).text();
  assert.match(page, /<li class="chip chip-warn">On a release from before base\.win sign-in<\/li>/);
  assert.match(page, /class="oc-block">This campaign is on a release from before base\.win sign-in, so its desk can’t be opened from here yet\. Run Promote to production \(GitHub → Actions\), wait for ‘Live’ in Render, then press Check now\./);
  assert.match(page, /<dt>base.win sign-in<\/dt><dd>Not in this release<\/dd>/);
  assert.doesNotMatch(page, /somewhere else/);
  assert.doesNotMatch(page, /action="\/c\/old\/open"/);
  await db.query("update campaigns set archived_at = now() where name = 'old'");
});

test('the campaign’s own address: answering, another server (a chip), or not known yet (no chip)', async () => {
  const camp = { name: 'a', kind: 'client' };
  const envRow = { env: 'production', server_url: A, instance: INST };
  const server = { answering: true, database: 'ok', store: 'postgres', tz_current: true, entry: 'ready', platform_kids: [currentKid()], own_origin: A, env_reported: 'production', instance: INST, setup_open: false, campaign_made: true, commit: 'd9130ae' };
  const chips = (pub, row = envRow, c = camp) => chipsFor({ campaign: c, envRow: row, server: c.kind === 'sample' ? { ...server, env_reported: 'staging' } : server, pub });
  const state = (pub, row = envRow) => publicState({ envRow: row, server, pub });
  // The pinned server answers there.
  assert.equal(state({ answering: true, instance: INST }), 'answering');
  assert.deepEqual(chips({ answering: true, instance: INST }), []);
  // A server that says it is a different one answers there.
  assert.equal(state({ answering: true, instance: 'AAAAAAAAAAAAAAAAAAAAAA' }), 'elsewhere');
  assert.deepEqual(chips({ answering: true, instance: 'AAAAAAAAAAAAAAAAAAAAAA' }), ['a.base.win answers from another server']);
  // The answer names no instance (an older release, or its database is down): not known, so no chip.
  assert.equal(state({ answering: true, instance: null }), 'unknown');
  assert.deepEqual(chips({ answering: true, instance: null }), []);
  // No instance pinned yet: nothing to compare with.
  assert.equal(state({ answering: true, instance: INST }, { ...envRow, instance: null }), 'unknown');
  assert.deepEqual(chipsFor({ campaign: camp, envRow: { ...envRow, instance: null }, server: { ...server, instance: null, entry: null, own_origin: null }, pub: { answering: true, instance: 'AAAAAAAAAAAAAAAAAAAAAA' } }), ['On a release from before base.win sign-in']);
  assert.equal(state({ answering: false, instance: null }), 'not-answering');
  assert.equal(state(null), 'not-checked');
  // The server changed (its database was rebuilt) and its own address reaches that same server:
  // “Server changed” says so, and it is not called another server.
  const changed = { ...server, instance: 'NNNNNNNNNNNNNNNNNNNNNN' };
  const samePub = { answering: true, instance: 'NNNNNNNNNNNNNNNNNNNNNN' };
  assert.equal(publicState({ envRow, server: changed, pub: samePub }), 'unknown');
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: changed, pub: samePub }), ['Server changed: confirm it']);
  assert.equal(publicState({ envRow, server: changed, pub: { answering: true, instance: 'AAAAAAAAAAAAAAAAAAAAAA' } }), 'elsewhere', 'a third server is still another server');
  // The sample has no address of its own.
  assert.deepEqual(chips({ answering: true, instance: 'AAAAAAAAAAAAAAAAAAAAAA' }, { ...envRow, env: 'staging' }, { name: 'sample', kind: 'sample' }), []);
});

test('Sign-up is open to anyone: sign-up open and no campaign made yet, on a client', async () => {
  const camp = { name: 'a', kind: 'client' };
  const envRow = { env: 'production', server_url: A, instance: INST };
  const server = { answering: true, database: 'ok', store: 'postgres', tz_current: true, entry: 'ready', platform_kids: [currentKid()], own_origin: A, env_reported: 'production', instance: INST, commit: 'd9130ae' };
  const chips = (over, c = camp) => chipsFor({ campaign: c, envRow: c.kind === 'sample' ? { ...envRow, env: 'staging' } : envRow, server: { ...server, ...(c.kind === 'sample' ? { env_reported: 'staging' } : {}), ...over } });
  assert.deepEqual(chips({ setup_open: true, campaign_made: false }), ['Sign-up is open to anyone']);
  assert.deepEqual(chips({ setup_open: true, campaign_made: true }), [], 'a campaign is made: its managers chose to keep sign-up open');
  assert.deepEqual(chips({ setup_open: false, campaign_made: false }), [], 'closed: it holds base.win’s key and waits for the first entry');
  assert.deepEqual(chips({ setup_open: true, campaign_made: null }), [], 'a server too old to say whether a campaign is made');
  assert.deepEqual(chips({ setup_open: null, campaign_made: null }), []);
  assert.deepEqual(chips({ setup_open: true, campaign_made: false }, { name: 'sample', kind: 'sample' }), [], 'the sample is not a client');
});

test('Not on a real database: the server says it keeps its data in the built-in one', async () => {
  const camp = { name: 'a', kind: 'client' };
  const envRow = { env: 'production', server_url: A, instance: INST };
  const server = { answering: true, database: 'ok', tz_current: true, entry: 'ready', platform_kids: [currentKid()], own_origin: A, env_reported: 'production', instance: INST, commit: 'd9130ae' };
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, store: 'embedded' } }), ['Not on a real database']);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, store: 'postgres' } }), []);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, store: null } }), [], 'a server too old to say');
  // Staging too: the sample on the built-in database loses everything at a restart.
  assert.deepEqual(chipsFor({ campaign: { name: 'sample', kind: 'sample' }, envRow: { ...envRow, env: 'staging' }, server: { ...server, env_reported: 'staging', store: 'embedded' } }), ['Not on a real database']);
});

test('Production is on …; staging is on …: only when both are known and differ, on the client, in short commits', async () => {
  const camp = { name: 'a', kind: 'client' };
  const envRow = { env: 'production', server_url: A, instance: INST };
  const server = { answering: true, database: 'ok', tz_current: true, entry: 'ready', platform_kids: [currentKid()], own_origin: A, env_reported: 'production', instance: INST, commit: '04ab25f' };
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server, staging: '5a53e89' }), ['Production is on 04ab25f; staging is on 5a53e89']);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server, staging: '04ab25f' }), []);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server, staging: null }), [], 'staging not known');
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, commit: null }, staging: '5a53e89' }), [], 'production not known');
  // A long commit and its short form are the same release; a long one is shown short.
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server: { ...server, commit: '04ab25f0c1d2e3f4a5b6c7d8e9f00112233445566' }, staging: '04ab25f' }), []);
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server, staging: '5a53e89aa11bb22cc33dd44ee55ff66778899001' }), ['Production is on 04ab25f; staging is on 5a53e89']);
  // "Version differs" between clients stays, next to it.
  assert.deepEqual(chipsFor({ campaign: camp, envRow, server, newest: 'e0e0e0e', staging: '5a53e89' }), ['Version differs', 'Production is on 04ab25f; staging is on 5a53e89']);
  assert.deepEqual(chipsFor({ campaign: { name: 'sample', kind: 'sample' }, envRow: { ...envRow, env: 'staging' }, server: { ...server, env_reported: 'staging', commit: '5a53e89' }, staging: '5a53e89', newest: '04ab25f' }), [], 'never on the sample itself');
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
  assert.equal((await b.post('/c/sample/edit', { display: 'Sample (staging)', server_url: 'HTTPS://Base-Win-Staging.onrender.com:443/' })).status, 303);
  assert.deepEqual(await pinned('sample'), { instance: 'SSSSSSSSSSSSSSSSSSSSSS', server_url: S }, 'saved normalized, polled and pinned at once');
  assert.equal((await b.post('/c/a/edit', { display: 'Renamed A', server_url: 'https://base-win-a2.onrender.com' })).status, 303);
  assert.deepEqual(await pinned('a'), { instance: null, server_url: 'https://base-win-a2.onrender.com' });
});

test('on the pages: a Promote is waiting, the built-in database, and sign-up open to anyone', async () => {
  // Campaign b on a release staging has moved past; staging (the sample) answers.
  answers.set(`${B}/api/health`, { body: health(B, { instance: 'BBBBBBBBBBBBBBBBBBBBBB', commit: '04ab25f' }) });
  answers.set(`${S}/api/health`, { body: health(S, { env: 'staging', instance: 'SSSSSSSSSSSSSSSSSSSSSS', commit: '5a53e89' }) });
  await b.post('/c/b/check-now', {});
  await b.post('/c/sample/check-now', {});
  let page = await (await b.get('/c/b')).text();
  assert.match(page, /<li class="chip chip-warn">Production is on 04ab25f; staging is on 5a53e89<\/li>/);
  const list = await (await b.get('/')).text();
  assert.match(list, /Example B<\/a>[\s\S]*?Production is on 04ab25f; staging is on 5a53e89/);
  const sampleCard = /<section class="oc-sample card"[\s\S]*?<\/section>/.exec(list)[0];
  assert.match(sampleCard, /Answering · 5a53e89/);
  assert.doesNotMatch(sampleCard, /Production is on/, 'on the clients, not on the sample');
  // Staging promoted: the same release on both, and the chip is gone.
  answers.set(`${B}/api/health`, { body: health(B, { instance: 'BBBBBBBBBBBBBBBBBBBBBB', commit: '5a53e89', store: 'embedded', setupOpen: true, campaignMade: false }) });
  await b.post('/c/b/check-now', {});
  page = await (await b.get('/c/b')).text();
  assert.doesNotMatch(page, /Production is on/);
  assert.match(page, /<li class="chip chip-warn">Not on a real database<\/li>/);
  assert.match(page, /<li class="chip chip-warn">Sign-up is open to anyone<\/li>/);
  assert.match(page, /<dt>Database<\/dt><dd>Built in: not a real database<\/dd>/);
  assert.match(page, /<dt>b\.base\.win<\/dt><dd>Not answering<\/dd>/);
  assert.match(page, /<li class="chip chip-warn">b\.base\.win not answering<\/li>/);
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
