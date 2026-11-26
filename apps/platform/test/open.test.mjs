// Open desk and Invite: the code window (a stale one asks for a code in the
// new tab and then opens the desk there), the redirect to the campaign's
// own address with a token the other side accepts, the log (never the
// token, never the invited email), no token when any check fails, the
// pinning rules, and base.win’s key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, setUp, codeNow, baseEnv, SIGNING } from './helpers.mjs';
import { makeApp } from '../server.mjs';
import { createCampaign } from '../campaigns.mjs';
import { publicKeyOf, currentKid } from '../keys.mjs';
import { verifyEntry, parseKeys } from './verify-entry.mjs';
import { sha256 } from '../ops-auth.mjs';

baseEnv();
const INST = 'EBESExQVFhcYGRobHB0eHw';
const A = 'https://base-win-a.onrender.com';
const S = 'https://starbase-staging.onrender.com';
const answers = new Map();
const fetcher = async (url) => {
  const a = answers.get(url);
  if (!a) throw Object.assign(new Error('x'), { name: 'ECONNREFUSED' });
  return { status: a.status || 200, body: JSON.stringify(a.body), ms: 4 };
};
const health = (origin, over = {}) => ({
  ok: true, database: 'ok', service: 'starbase', env: 'production', commit: 'd9130ae', tzdataCurrent: true, ownOrigin: origin, instance: INST,
  address: 'https://a.base.win', entry: 'ready', platformKids: [currentKid()], setupOpen: false, campaignMade: true, doorKey: true, ...over,
});
const { db } = await freshApp();
const app = makeApp({ db, fetcher });
const op = await setUp(app, db);
const b = op.b;
await db.transaction((tx) => createCampaign(tx, { name: 'a', display: 'Example A', serverUrl: A }));
answers.set(`${A}/api/health`, { body: health(A) });
answers.set('https://a.base.win/api/health', { body: health(A) });
await b.post('/c/a/check-now', {});
const stale = () => db.query("update ops_sessions set code_at = now() - interval '11 minutes'");
const tables = async () => {
  let all = '';
  for (const t of ['operators', 'operator_setup', 'setup_tries', 'ops_sessions', 'campaigns', 'environments', 'checks', 'checklist', 'ops_log', 'ops_chain']) {
    all += JSON.stringify((await db.query(`select * from ${t}`)).rows);
  }
  return all;
};
const tokenOf = (location) => decodeURIComponent(location.split('#t=')[1]);

test('a stale code: Open answers Type your code, posting back to Open; a right code then goes straight to the desk', async () => {
  await stale();
  const res = await b.post('/c/a/open', { env: 'production' });
  assert.equal(res.status, 200, 'an ordinary page asking for input: the new tab logs no error');
  const body = await res.text();
  assert.match(body, /<h1>Type your code<\/h1>/);
  assert.match(body, /Opening a desk needs a fresh code\./);
  assert.match(body, /<form method="post" action="\/c\/a\/open" class="oc-form">/);
  assert.match(body, /<input type="hidden" name="env" value="production">/);
  assert.doesNotMatch(body, /target="_blank"/, 'it stays in this tab');
  assert.equal((await db.query("select count(*)::int n from ops_log where action = 'desk.open'")).rows[0].n, 0);
  const wrong = await b.post('/c/a/open', { env: 'production', code: '000000' });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /That code didn’t work/);
  const ok = await b.post('/c/a/open', { env: 'production', code: await codeNow(db, op.secret) });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('location'), /^https:\/\/base-win-a\.onrender\.com\/admin\/enter#t=bw-entry\.v1\./);
});

test('a fresh code: 303 to <server_url>/admin/enter#t=…, no-store; the token passes the campaign’s own check', async () => {
  const res = await b.post('/c/a/open', { env: 'production' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const token = tokenOf(res.headers.get('location'));
  const codeAt = (await db.query('select floor(extract(epoch from code_at))::int8 t from ops_sessions')).rows[0].t;
  const r = verifyEntry(token, { keys: parseKeys(publicKeyOf(SIGNING).publicKey), aud: A, env: 'production', inst: INST, nowMs: Date.now() });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.payload.aud, A);
  assert.equal(r.payload.op.stepUpAt, Number(codeAt));
  assert.equal(r.payload.op.email, op.email);
  assert.equal(r.payload.go, '/desk');
  assert.equal(r.payload.invite, null);
  const line = (await db.query("select payload from ops_log where action = 'desk.open' order by seq desc limit 1")).rows[0].payload;
  assert.deepEqual(line, { campaign: 'a', env: 'production', aud: A, nonce: r.payload.nonce, purpose: 'open' });
  assert.ok(!(await tables()).includes(token.split('.')[3]), 'the token is in no table');
  assert.ok(!(await tables()).includes(token.split('.')[2]));
});

test('Open desk on the campaign page and the list: a form to a new tab, with nothing passed on', async () => {
  for (const path of ['/', '/c/a']) {
    const body = await (await b.get(path)).text();
    assert.match(body, /<form method="post" action="\/c\/a\/open" target="_blank" rel="noopener noreferrer"/, path);
  }
});

test('Invite the first manager: the primary until done; a token with the invite; the log has a hash, never the email; the checklist ticks', async () => {
  let page = await (await b.get('/c/a')).text();
  assert.match(page, /<h2>Invite the first manager<\/h2>/);
  assert.match(page, /btn btn-primary" type="submit">Invite and open the desk/);
  assert.match(page, /btn btn-quiet" type="submit">Open desk/);
  assert.equal([...page.matchAll(/btn-primary/g)].length, 1);
  await stale();
  const s = await b.post('/c/a/invite', { env: 'production', email: 'Sam@Example.org' });
  assert.equal(s.status, 200);
  const sBody = await s.text();
  assert.match(sBody, /action="\/c\/a\/invite"/);
  assert.match(sBody, /name="email" value="sam@example.org"/);
  const res = await b.post('/c/a/invite', { env: 'production', email: 'Sam@Example.org', code: await codeNow(db, op.secret) });
  assert.equal(res.status, 303);
  const r = verifyEntry(tokenOf(res.headers.get('location')), { keys: parseKeys(publicKeyOf(SIGNING).publicKey), aud: A, env: 'production', inst: INST });
  assert.equal(r.ok, true);
  assert.equal(r.payload.go, '/desk/settings/members');
  assert.deepEqual(r.payload.invite, { email: 'sam@example.org' });
  const line = (await db.query("select payload from ops_log where action = 'desk.open' order by seq desc limit 1")).rows[0].payload;
  assert.equal(line.purpose, 'invite');
  assert.equal(line.invite_hash, sha256('sam@example.org'));
  const log = JSON.stringify((await db.query('select * from ops_log')).rows);
  assert.doesNotMatch(log, /sam@example/i);
  assert.equal((await db.query("select done_by from checklist where campaign = 'a' and item = 'first-manager-invited'")).rows[0].done_by, 'auto');
  page = await (await b.get('/c/a')).text();
  assert.match(page, /First manager invited<\/span>\s*<span class="oc-check-state">Done by itself/);
  assert.match(page, /btn btn-primary" type="submit">Open desk/);
  assert.equal((await b.post('/c/a/invite', { env: 'production', email: 'not an email' })).status, 400);
  assert.equal((await b.post('/c/sample/invite', { env: 'staging', email: 'sam@example.org' })).status, 404, 'clients only');
});

test('ticking by hand: logged; a stale code shows the Code field on that item and saves nothing', async () => {
  await stale();
  const s = await b.post('/c/a/tick', { item: 'email', done: '1' });
  assert.equal(s.status, 401);
  assert.match(await s.text(), /value="email"><input type="hidden" name="done" value="1">\s*<div class="field">\s*<label for="code">Code/);
  assert.equal((await db.query("select count(*)::int n from checklist where item = 'email' and done_at is not null")).rows[0].n, 0);
  assert.equal((await b.post('/c/a/tick', { item: 'email', done: '1', code: await codeNow(db, op.secret) })).status, 303);
  assert.equal((await db.query("select done_by from checklist where item = 'email'")).rows[0].done_by, 'you');
  assert.equal((await b.post('/c/a/tick', { item: 'first-manager-invited', done: '0' })).status, 303, 'an auto tick can be taken back');
  assert.equal((await db.query("select done_at from checklist where item = 'first-manager-invited'")).rows[0].done_at, null);
  assert.equal((await b.post('/c/a/tick', { item: 'tz', done: '1' })).status, 404, 'auto items aren’t ticked by hand');
  const acts = (await db.query("select action, payload from ops_log where action like 'checklist.%' order by seq")).rows;
  assert.deepEqual(acts.slice(-2).map((r) => [r.action, r.payload.item]), [['checklist.tick', 'email'], ['checklist.untick', 'first-manager-invited']]);
});

test('no token, and the right line, when the desk can’t be opened', async () => {
  const cases = [
    ['entry not ready', health(A, { entry: 'no-key' }), /base.win sign-in isn’t set up there/],
    ['the key not held', health(A, { platformKids: ['00000000'] }), /Key in Render is wrong/],
    ['somewhere else', health(A, { ownOrigin: 'https://base-win-z.onrender.com' }), /This server says it is somewhere else/],
    ['another instance', health(A, { instance: 'ZZZZZZZZZZZZZZZZZZZZZZ' }), /This server has changed since it was added/],
    ['another env', health(A, { env: 'staging' }), /This server says it is somewhere else/],
    ['not answering', null, /Not answering — can’t open the desk/],
  ];
  for (const [what, h, words] of cases) {
    if (h) answers.set(`${A}/api/health`, { body: h }); else answers.delete(`${A}/api/health`);
    await b.post('/c/a/check-now', {});
    const before = (await db.query("select count(*)::int n from ops_log where action = 'desk.open'")).rows[0].n;
    const res = await b.post('/c/a/open', { env: 'production' });
    assert.equal(res.status, 409, what);
    assert.match(await res.text(), words, what);
    assert.equal(res.headers.get('location'), null);
    assert.equal((await db.query("select count(*)::int n from ops_log where action = 'desk.open'")).rows[0].n, before, what);
    const page = await (await b.get('/c/a')).text();
    assert.doesNotMatch(page, /action="\/c\/a\/open"/, what);
  }
  answers.set(`${A}/api/health`, { body: health(A) });
  await b.post('/c/a/check-now', {});
  assert.equal((await b.post('/c/a/open', {})).status, 303);
  // Archived.
  await db.query("update campaigns set archived_at = now() where name = 'a'");
  const res = await b.post('/c/a/open', {});
  assert.equal(res.status, 409);
  assert.match(await res.text(), /Archived/);
  await db.query("update campaigns set archived_at = null where name = 'a'");
  // An instance never pinned.
  await db.query("update environments set instance = null where campaign = 'a'");
  answers.set(`${A}/api/health`, { body: health(A, { ownOrigin: 'https://base-win-z.onrender.com' }) });
  await b.post('/c/a/check-now', {});
  assert.equal((await b.post('/c/a/open', {})).status, 409);
  answers.set(`${A}/api/health`, { body: health(A) });
  await b.post('/c/a/check-now', {});
  assert.equal((await db.query("select instance from environments where campaign = 'a'")).rows[0].instance, INST, 'pinned again');
});

test('pinning: a second environment reporting an instance already pinned is not pinned (and can’t open)', async () => {
  answers.set(`${S}/api/health`, { body: health(S, { env: 'staging' }) });
  assert.equal((await b.post('/sample', { server_url: S })).status, 303);
  assert.equal((await db.query("select instance from environments where campaign = 'sample'")).rows[0].instance, null);
  const page = await (await b.get('/c/sample')).text();
  assert.match(page, /This server says it is somewhere else/);
  assert.equal((await b.post('/c/sample/open', { env: 'staging' })).status, 409);
  answers.set(`${S}/api/health`, { body: health(S, { env: 'staging', instance: 'SSSSSSSSSSSSSSSSSSSSSS' }) });
  await b.post('/c/sample/check-now', {});
  const res = await b.post('/c/sample/open', { env: 'staging' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^https:\/\/starbase-staging\.onrender\.com\/admin\/enter#t=/);
  assert.equal((await b.post('/c/sample/open', { env: 'production' })).status, 404, 'the sample has staging only');
});

test('the sample’s address: a stale code shows the Code field and keeps what was typed', async () => {
  await db.query("update environments set server_url = null, instance = null where campaign = 'sample'");
  await stale();
  const res = await b.post('/sample', { server_url: S });
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.match(body, /It’s been more than 10 minutes/);
  assert.match(body, /value="https:\/\/starbase-staging\.onrender\.com"/);
  assert.equal((await db.query("select server_url from environments where campaign = 'sample'")).rows[0].server_url, null);
  assert.equal((await b.post('/sample', { server_url: S, code: await codeNow(db, op.secret) })).status, 303);
});

test('base.win’s key: one Copy; both keys while changing, and who doesn’t have the new one yet', async () => {
  let body = await (await b.get('/key')).text();
  assert.match(body, /Paste this as BASE_PLATFORM_PUBKEY on each campaign’s service in Render, then Save and deploy\./);
  assert.match(body, new RegExp(`id="key-value">${publicKeyOf(SIGNING).publicKey}</pre>`));
  assert.equal([...body.matchAll(/btn-primary/g)].length, 1);
  assert.doesNotMatch(body, /kid|cd935ce9/);
  // While changing keys the setting holds "old,new": the old one still
  // signs, so no campaign is shut out before it has the new one.
  const NEW = 'a-brand-new-signing-key-0123456789abcdefghijk';
  process.env.PLATFORM_SIGNING_KEY = `${SIGNING},${NEW}`;
  body = await (await b.get('/key')).text();
  assert.match(body, new RegExp(`id="key-value">${publicKeyOf(NEW).publicKey},${publicKeyOf(SIGNING).publicKey}</pre>`));
  assert.match(body, /Don’t remove the old key yet: Example A, Sample \(staging\) don’t have the new one\./);
  const res = await b.post('/c/a/open', { env: 'production' });
  assert.equal(res.status, 303, 'a campaign holding only the old key still opens');
  assert.equal(verifyEntry(res.headers.get('location').split('#t=')[1], { keys: parseKeys(publicKeyOf(SIGNING).publicKey), aud: A, env: 'production', inst: INST }).ok, true);
  baseEnv();
});

test('a too-short first signing value is no key at all: nothing is minted with the second', async () => {
  process.env.PLATFORM_SIGNING_KEY = `short-new-value,${SIGNING}`;
  const body = await (await b.get('/key')).text();
  assert.match(body, /PLATFORM_SIGNING_KEY in Render is missing or too short/);
  assert.doesNotMatch(body, /id="key-value"/);
  const res = await b.post('/c/a/open', { env: 'production' });
  assert.notEqual(res.status, 303);
  baseEnv();
});
