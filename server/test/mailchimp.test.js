// Mailchimp (server/ext/mailchimp): a list becomes a tag in the campaign's
// Mailchimp audience — by default only the addresses subscribed to base.win's
// newsletter, only email, first and last name, never changing anyone already
// in the audience — and a no in either place is a no in both: unsubscribed
// and cleaned come back (the webhook is only a hint: base.win reads the
// member itself; a daily job and Pull now are the net), and base.win's own
// unsubscribes, do-not-email and bounces go out. Mailchimp is a stand-in
// here (fake-mailchimp.js at MAILCHIMP_API_BASE).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runAction } from '../lib/events.js';
import { runDueJobs } from '../lib/jobs.js';
import { startFakeMailchimp } from './fake-mailchimp.js';
import { signPayload } from '../ext/payments/stripe.js';
import { _forgetAudienceForTest, pathKey } from '../ext/mailchimp/mailchimp.js';
import { _setSliceForTest } from '../ext/mailchimp/push.js';
import { suppress } from '../ext/mail/webhook.js';
import { recordConsent } from '../ext/site/consent.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.mc.${tag}@example.org`;
const KEY = `mc-test-key-${tag}-us19`;
const PUBLIC = 'https://base.example';
const KEYS = ['MAILCHIMP_API_KEY', 'MAILCHIMP_API_BASE', 'MAILCHIMP_AUDIENCE_ID', 'MAILCHIMP_WEBHOOK_SECRET', 'STARBASE_PUBLIC_URL',
  'MAIL_PROVIDER', 'RESEND_API_KEY', 'SENDGRID_API_KEY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let db, fake;

const on = (more = {}) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { MAILCHIMP_API_KEY: KEY, MAILCHIMP_API_BASE: fake.url, STARBASE_PUBLIC_URL: PUBLIC, ...more });
  _forgetAudienceForTest(); // which audience the account's only one is, is asked afresh
};
before(async () => {
  db = await freshDb();
  // Webhooks come to this server in-process, at the path Mailchimp was given.
  fake = await startFakeMailchimp({
    apiKey: KEY,
    deliver: async (raw, headers, url) => {
      const r = await app.request(new URL(url).pathname, { method: 'POST', headers, body: raw });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  });
  on();
});
after(async () => {
  await fake.close();
  _setSliceForTest(null);
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
// A campaign of its own for each test (they share one database, and one stand-in Mailchimp, emptied first).
const campaign = async (name) => {
  fake.reset();
  on();
  const c = new Client();
  const r = await c.signup({ workspaceName: `${name} ${tag}`, email: mail(`mgr-${name.toLowerCase().replace(/\W+/g, '')}`), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { c, ws: r.json.workspace.id };
};
const join = async (mgr, role, who) => {
  const inv = ok(await mgr.action('member.invite', { email: mail(who), role }));
  const c = new Client();
  await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'mailchimp-pass-1' });
  return c;
};
// Jobs due now, until none is left (a job may hand on to the next).
const run = async (ws) => {
  const total = { ran: 0, failed: 0 };
  for (let i = 0; i < 20; i += 1) {
    const r = await runDueJobs(db, { workspaceId: ws });
    total.ran += r.ran; total.failed += r.failed;
    if (!r.ran) break;
  }
  return total;
};
const person = (c, who, extra = {}) => c.createPerson(`${who[0].toUpperCase()}${who.slice(1)} Example`, { email: mail(who), tags: ['member'], ...extra });
const subscribe = async (c, ...who) => { for (const w of who) ok(await c.action('subscription.add', { email: mail(w), name: `${w} Example` })); };
const membersList = async (c) => ok(await c.action('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'member' } })).list;
const push = async (c, ws, listId, more = {}) => {
  const r = ok(await c.action('mailchimp.push', { list_id: listId, ...more }));
  const jobs = await run(ws);
  return { ...r, jobs };
};
const stateOf = async (c, listId, counts = false) => ok(await c.get(`/api/lists/${listId}/mailchimp${counts ? '?counts=1' : ''}`));
const TAG = 'base.win: Members';
const inTag = () => fake.tagged(TAG);
const writes = () => fake.calls.filter((x) => x.method !== 'GET');
const logged = async (c) => ok(await c.get('/api/events?since=0&limit=1000')).events;
const mine = async (c, action) => (await logged(c)).filter((e) => e.action === action);
const subOf = async (ws, who) => (await db.query('select id, status from subscriptions where workspace_id = $1 and email = $2', [ws, mail(who)])).rows[0];
const consents = async (ws, who) => (await db.query(
  "select granted, source from consent_events where workspace_id = $1 and channel = 'email' and address = $2 order by created_at", [ws, mail(who)],
)).rows;
const suppressions = async (ws) => (await db.query('select email, reason, source from email_suppressions where workspace_id = $1 and lifted_at is null order by email', [ws])).rows;
const pullJobs = async (ws) => (await db.query("select key, status, run_at from jobs where workspace_id = $1 and kind = 'mailchimp.pull' order by run_at", [ws])).rows;
const connect = async (c) => ok(await c.action('mailchimp.connect', {}));
const hookPath = () => `/hooks/mailchimp/${pathKey()}`;

test('the default sends only the subscribed — email, first and last name, never changing anyone already there', async () => {
  const { c, ws } = await campaign('Default');
  const ana = await person(c, 'ana', { phone: '604-555-0142', address: '123 Example Street', tags: ['member', 'vip-donor'] });
  await person(c, 'ben');
  await person(c, 'cal'); // can be emailed, but never joined the newsletter
  await person(c, 'dee', { tags: ['member', 'do-not-email'] });
  await person(c, 'eli');
  await c.createPerson('Fay Example', { tags: ['member'] }); // no address
  await person(c, 'gus');
  await db.query("update persons set rating = 'rating-code-xyz' where id = $1", [ana.id]);
  await subscribe(c, 'ana', 'ben', 'eli', 'gus');
  ok(await c.action('subscription.remove', { id: (await subOf(ws, 'eli')).id })); // left the newsletter
  await runAction(db, { workspaceId: ws, actorId: null, action: 'mail.event' }, (tx, emit) => suppress(tx, emit, ws, { email: mail('gus'), reason: 'bounce', source: 'resend' }));
  await run(ws);
  fake.calls.length = 0;
  const list = await membersList(c);

  // Before anything is sent: how many would go, each way.
  const asked = await stateOf(c, list.id, true);
  assert.deepEqual([asked.on, asked.sync, asked.counts], [true, null, { subscribed: 2, everyone: 3 }]);
  assert.equal(fake.calls.length, 0, 'asking reads nothing at Mailchimp');

  const sent = await push(c, ws, list.id);
  assert.deepEqual([sent.sync.status, sent.sync.consent, sent.sync.tag], ['queued', 'subscribed', TAG]);
  const s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.tagged, s.removed, s.skipped, s.note], ['synced', 2, 2, 2, 0, 0, null]);
  assert.ok(s.synced_at);

  // In Mailchimp: the two subscribed, by first and last name, in the tag.
  assert.deepEqual(fake.members().map((m) => [m.email_address, m.status, m.merge_fields]).sort(), [
    [mail('ana'), 'subscribed', { FNAME: 'Ana', LNAME: 'Example' }],
    [mail('ben'), 'subscribed', { FNAME: 'Ben', LNAME: 'Example' }],
  ]);
  assert.deepEqual(inTag(), [mail('ana'), mail('ben')]);
  // What left base.win: an address and two names each — nothing else on file.
  const batches = fake.calls.filter((x) => x.method === 'POST' && x.path === `/lists/${fake.id}`);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].body.update_existing, false, 'someone already in the audience is never changed');
  for (const m of batches[0].body.members) {
    assert.deepEqual(Object.keys(m).sort(), ['email_address', 'merge_fields', 'status']);
    assert.deepEqual(Object.keys(m.merge_fields).sort(), ['FNAME', 'LNAME']);
    assert.equal(m.status, 'subscribed');
  }
  const traffic = JSON.stringify(fake.calls);
  for (const secret of ['rating-code-xyz', 'vip-donor', '"member"', '123 Example', '555-0142', '5550142', ana.id]) {
    assert.ok(!traffic.includes(secret), `${secret} never leaves base.win`);
  }
  // Mailchimp is called with the key as the password (Basic), never in an address.
  assert.ok(fake.calls.every((x) => x.auth.startsWith('Basic ') && !JSON.stringify([x.path, x.query]).includes(KEY)));

  // On the event log: who sent which list, and how many (as the system, when it was done).
  const log = await mine(c, 'mailchimp.push');
  assert.deepEqual(log.map((e) => [e.entity_type, e.op, Boolean(e.actor_id)]), [['mailchimp_sync', 'create', true], ['mailchimp_sync', 'update', false]]);
  assert.deepEqual(log[0].payload, { list_id: list.id, list: 'Members', tag: TAG, consent: 'subscribed' });
  assert.deepEqual(log[1].payload, { status: 'synced', total: 2, added: 2, tagged: 2, removed: 0, skipped: 0 });

  // One tick widens it: everyone on the list who can be emailed.
  fake.calls.length = 0;
  await push(c, ws, list.id, { everyone: true });
  const wide = (await stateOf(c, list.id)).sync;
  assert.deepEqual([wide.status, wide.consent, wide.total, wide.added, wide.tagged, wide.removed], ['synced', 'all', 3, 1, 1, 0]);
  assert.deepEqual(inTag(), [mail('ana'), mail('ben'), mail('cal')]);
  // Never: do-not-email, someone who left the newsletter, a suppressed address.
  for (const who of ['dee', 'eli', 'gus']) assert.equal(fake.member(mail(who)), null, `${who} never goes`);
  assert.equal(ok(await c.get('/api/audit/verify')).ok, true);
});

test('a second sync changes nothing; then it adds and removes exactly the difference', async () => {
  const { c, ws } = await campaign('Again');
  const people = {};
  for (const w of ['ana', 'ben', 'cal']) people[w] = await person(c, w);
  await subscribe(c, 'ana', 'ben', 'cal');
  // Someone who joined in Mailchimp itself, with another name there: never touched.
  fake.add(mail('ana'), { first: 'Anastasia', last: 'Sample' });
  const list = await membersList(c);
  const first = await push(c, ws, list.id);
  assert.deepEqual([first.jobs.ran, first.jobs.failed], [1, 0]);
  let s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.total, s.added, s.tagged], [3, 2, 3], 'two were new to the audience; all three are in the tag');
  assert.deepEqual(fake.member(mail('ana')).merge_fields, { FNAME: 'Anastasia', LNAME: 'Sample' }, 'her name in Mailchimp is Mailchimp’s');

  // Again, nothing changed here: nothing is written there.
  fake.calls.length = 0;
  await push(c, ws, list.id);
  assert.deepEqual(writes(), [], 'only reads');
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.tagged, s.removed, s.skipped], ['synced', 3, 0, 0, 0, 0]);

  // Hal joins the list; Ben leaves it (he is still a member of the audience — only the tag goes).
  await person(c, 'hal');
  await subscribe(c, 'hal');
  ok(await c.action('person.update', { id: people.ben.id, tags: [] }));
  await run(ws);
  fake.calls.length = 0;
  await push(c, ws, list.id);
  const w = writes();
  assert.deepEqual(w.map((x) => [x.method, x.path.replace(/(segments\/)\d+$/, '$1N')]), [['POST', `/lists/${fake.id}`], ['POST', `/lists/${fake.id}/segments/N`], ['POST', `/lists/${fake.id}/segments/N`]]);
  assert.deepEqual(w[0].body.members.map((m) => m.email_address), [mail('hal')]);
  assert.deepEqual(w[1].body, { members_to_add: [mail('hal')] });
  assert.deepEqual(w[2].body, { members_to_remove: [mail('ben')] });
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.total, s.added, s.tagged, s.removed], [3, 1, 1, 1]);
  assert.deepEqual(inTag(), [mail('ana'), mail('cal'), mail('hal')]);
  assert.equal(fake.member(mail('ben')).status, 'subscribed', 'out of the tag, still in the audience');
});

test('two lists of one name never share a tag; an address goes as it is written and is told apart whatever its capitals', async () => {
  const { c, ws } = await campaign('Names');
  const typed = `Ana.Caps.${tag}@Example.org`;
  await c.createPerson('Ana Example', { email: typed, tags: ['member'] });
  await person(c, 'ben', { tags: ['member', 'board'] });
  ok(await c.action('subscription.add', { email: typed }));
  await subscribe(c, 'ben');
  const members = await membersList(c);
  const board = ok(await c.action('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'board' } })).list;
  await push(c, ws, members.id);
  const second = await push(c, ws, board.id);
  assert.equal(second.sync.tag, 'base.win: Members (2)');
  assert.deepEqual(fake.tagged(TAG), [typed.toLowerCase(), mail('ben')]);
  assert.deepEqual(fake.tagged('base.win: Members (2)'), [mail('ben')]);
  assert.equal(fake.member(typed).email_address, typed, 'as it is on file');
  // Again: the capitals don't make her look new, and each list keeps its own tag.
  fake.calls.length = 0;
  await push(c, ws, members.id);
  await push(c, ws, board.id);
  assert.deepEqual(writes(), []);
  assert.equal((await stateOf(c, board.id)).sync.tag, 'base.win: Members (2)');
  // A very long name still makes a tag Mailchimp will take (100 characters), and the two still differ.
  const long = 'L'.repeat(120);
  const l1 = ok(await c.action('list.create', { name: long, kind: 'filter', filter: { tag: 'member' } })).list;
  const l2 = ok(await c.action('list.create', { name: long, kind: 'filter', filter: { tag: 'board' } })).list;
  const t1 = (await push(c, ws, l1.id)).sync.tag;
  const t2 = (await push(c, ws, l2.id)).sync.tag;
  assert.deepEqual([t1.length, t2.length, t1 === t2, t2.endsWith(' (2)')], [100, 100, false, true]);
});

test('a big list goes in parts: each address once, an address Mailchimp refuses is counted and not tried twice', async () => {
  const { c, ws } = await campaign('Parts');
  const names = ['ana', 'ben', 'cal', 'dee', 'eli', 'fay', 'gus'];
  for (const w of names) await person(c, w);
  await subscribe(c, ...names);
  fake.refuse(mail('cal'));
  const list = await membersList(c);
  // Two addresses to a call, and a part ends after each call.
  _setSliceForTest({ ms: 0, chunk: 2 });
  // …and Mailchimp gives three rows to a page, whatever is asked for: every page is still read.
  fake.pageMax(3);
  try {
    ok(await c.action('mailchimp.push', { list_id: list.id }));
    assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
    let s = (await stateOf(c, list.id)).sync;
    assert.deepEqual([s.status, s.total, s.todo, s.tagged], ['syncing', 7, 5, 2], 'part-way: it says how many are still to go');
    const waiting = async () => (await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'mailchimp.sync' and status = 'pending'", [ws])).rows[0].n;
    assert.equal(await waiting(), 1, 'one job carries it on');
    // A part that ends while the next is already waiting queues no second one.
    assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
    await db.query("update jobs set status = 'pending' where id = (select id from jobs where workspace_id = $1 and kind = 'mailchimp.sync' and status = 'done' order by done_at desc limit 1)", [ws]);
    assert.equal(await waiting(), 2);
    assert.deepEqual(await runDueJobs(db, { workspaceId: ws, limit: 1 }), { ran: 1, failed: 0 });
    assert.equal(await waiting(), 1, 'never two chains for one sync');
    await run(ws);
    s = (await stateOf(c, list.id)).sync;
    assert.deepEqual([s.status, s.total, s.added, s.tagged, s.skipped, s.todo], ['synced', 7, 6, 6, 1, 0]);
  } finally { _setSliceForTest(null); }
  const sentTo = fake.calls.filter((x) => x.method === 'POST' && x.path === `/lists/${fake.id}`).flatMap((x) => x.body.members.map((m) => m.email_address));
  assert.deepEqual(sentTo.sort(), names.map(mail).sort(), 'each address was offered once');
  assert.deepEqual(inTag(), names.filter((w) => w !== 'cal').map(mail));
  assert.equal(fake.member(mail('cal')), null);
  // The same with a pull: five left in Mailchimp, three to a page — all five are found.
  for (const w of ['ana', 'ben', 'dee', 'eli', 'fay']) await fake.unsubscribe(mail(w), { send: false });
  ok(await c.action('mailchimp.pull', {}));
  await run(ws);
  assert.equal(ok(await c.get('/api/mailchimp')).pull_note, '5 unsubscribed');
  assert.equal(ok(await c.get('/api/subscriptions')).subscribed, 2);
});

test('an address unsubscribed in Mailchimp is never re-added, and is turned off in base.win', async () => {
  const { c, ws } = await campaign('Unsub');
  for (const w of ['ana', 'ben', 'cal']) await person(c, w);
  await subscribe(c, 'ana', 'ben', 'cal');
  await connect(c);
  const list = await membersList(c);
  await push(c, ws, list.id);
  assert.deepEqual(inTag(), [mail('ana'), mail('ben'), mail('cal')]);

  // Ana unsubscribes in Mailchimp: its webhook says so, and base.win reads her record itself.
  fake.calls.length = 0;
  const [hook] = await fake.unsubscribe(mail('ana'));
  assert.deepEqual([hook.status, hook.body], [200, { received: true }]);
  assert.equal((await subOf(ws, 'ana')).status, 'subscribed', 'nothing changes on the webhook’s word alone');
  await run(ws);
  assert.deepEqual(fake.calls.map((x) => [x.method, x.path]), [['GET', `/lists/${fake.id}/members/${fake.member(mail('ana')).id}`]], 'one read; base.win tells Mailchimp nothing back');
  assert.equal((await subOf(ws, 'ana')).status, 'unsubscribed');
  assert.deepEqual((await consents(ws, 'ana')).at(-1), { granted: false, source: 'mailchimp-unsubscribe' });
  const log = await mine(c, 'mailchimp.pull');
  assert.ok(log.length && log.every((e) => e.actor_id === null), 'on the event log, as the system');
  assert.deepEqual(log.filter((e) => e.entity_type === 'subscription').map((e) => e.payload), [{ status: 'unsubscribed', source: 'mailchimp-unsubscribe' }]);
  // The same webhook again: one more read, nothing more written.
  const seq = (await logged(c)).length;
  await fake.hook('unsubscribe', { email: mail('ana'), list_id: fake.id });
  await run(ws);
  assert.equal((await logged(c)).length, seq);

  // Ben unsubscribes there too, and the webhook never arrives: the next sync finds out first.
  await fake.unsubscribe(mail('ben'), { send: false });
  fake.calls.length = 0;
  await push(c, ws, list.id);
  assert.equal((await subOf(ws, 'ben')).status, 'unsubscribed');
  assert.deepEqual((await consents(ws, 'ben')).at(-1), { granted: false, source: 'mailchimp-unsubscribe' });
  // Neither is offered to Mailchimp again; both leave the tag; both stay unsubscribed there.
  assert.equal(fake.calls.filter((x) => x.method === 'POST' && x.path === `/lists/${fake.id}`).length, 0);
  assert.deepEqual(inTag(), [mail('cal')]);
  assert.deepEqual([fake.member(mail('ana')).status, fake.member(mail('ben')).status], ['unsubscribed', 'unsubscribed']);
  assert.equal(fake.calls.filter((x) => x.method === 'PATCH').length, 0);
  const s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.removed], ['synced', 1, 2]);
  // And base.win's own newsletter leaves them out from now on.
  assert.equal(ok(await c.get('/api/subscriptions')).subscribed, 1);
});

test('a forged webhook for a still-subscribed member changes nothing; the address is the lock, the signature too when a secret is set', async () => {
  const { c, ws } = await campaign('Forged');
  await person(c, 'ana');
  await subscribe(c, 'ana');
  await connect(c);
  const list = await membersList(c);
  await push(c, ws, list.id);
  const before = (await logged(c)).length;
  const post = (path, body, headers = {}) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  const form = (type, email) => new URLSearchParams({ type, fired_at: '2026-11-10 12:00:00', 'data[email]': email, 'data[list_id]': fake.id }).toString();

  // A made-up "she unsubscribed": taken as a hint, her record read, nothing done.
  fake.calls.length = 0;
  let r = await post(hookPath(), form('unsubscribe', mail('ana')));
  assert.equal(r.status, 200);
  await run(ws);
  assert.deepEqual(fake.calls.map((x) => x.method), ['GET'], 'all a forged call can cause is one read');
  assert.equal((await subOf(ws, 'ana')).status, 'subscribed');
  assert.equal((await logged(c)).length, before, 'nothing on the log');
  // About someone nobody here has on file: not even a read. Another audience's: the same.
  fake.calls.length = 0;
  assert.equal((await post(hookPath(), form('unsubscribe', mail('stranger')))).status, 200);
  assert.equal((await post(hookPath(), form('unsubscribe', mail('ana')).replace(fake.id, 'another-audience'))).status, 200);
  assert.deepEqual([(await run(ws)).ran, fake.calls.length], [0, 0]);
  // The same told as JSON is read the same way.
  assert.equal((await fake.hook('unsubscribe', { email: mail('ana'), list_id: fake.id }, { json: true })).status, 200);
  assert.equal((await run(ws)).ran, 1);

  // Any other address under /hooks/mailchimp is not found — and says nothing about why.
  for (const path of ['/hooks/mailchimp/0123456789abcdef0123456789abcdef', '/hooks/mailchimp/', `${hookPath()}/x`, `/hooks/mailchimp/${pathKey().toUpperCase()}`]) {
    r = await post(path, form('unsubscribe', mail('ana')));
    assert.deepEqual([r.status, await r.json()], [404, { error: 'not found' }], path);
  }
  // Mailchimp asks the address before saving a webhook: yes at the right one only.
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await app.request(hookPath(), { method })).status, 200, method);
    assert.equal((await app.request('/hooks/mailchimp/0123456789abcdef0123456789abcdef', { method })).status, 404, method);
  }
  assert.equal((await run(ws)).ran, 0);

  // With the signing secret set, a delivery must carry Mailchimp's signature over its exact bytes.
  process.env.MAILCHIMP_WEBHOOK_SECRET = 'mc-signing-secret';
  const raw = form('unsubscribe', mail('ana'));
  r = await post(hookPath(), raw);
  assert.deepEqual([r.status, await r.json()], [400, { error: 'signature refused' }], 'unsigned');
  r = await post(hookPath(), raw, { 'x-mailchimp-signature': signPayload(raw, 'someone-else') });
  assert.equal(r.status, 400, 'signed with another secret');
  r = await post(hookPath(), `${raw}&data[extra]=1`, { 'x-mailchimp-signature': signPayload(raw, 'mc-signing-secret') });
  assert.equal(r.status, 400, 'the bytes changed after signing');
  r = await post(hookPath(), raw, { 'x-mailchimp-signature': signPayload(raw, 'mc-signing-secret', Math.floor(Date.now() / 1000) - 3600) });
  assert.equal(r.status, 400, 'an hour old');
  assert.equal((await run(ws)).ran, 0, 'a refused delivery queues nothing');
  r = await post(hookPath(), raw, { 'x-mailchimp-signature': signPayload(raw, 'mc-signing-secret') });
  assert.equal(r.status, 200);
  // While a secret is rolled, either signs.
  process.env.MAILCHIMP_WEBHOOK_SECRET = 'mc-new-secret, mc-signing-secret';
  assert.equal((await post(hookPath(), raw, { 'x-mailchimp-signature': signPayload(raw, 'mc-signing-secret') })).status, 200);
  delete process.env.MAILCHIMP_WEBHOOK_SECRET;

  // Mailchimp not connected here: the address answers nothing.
  delete process.env.MAILCHIMP_API_KEY;
  assert.equal((await post('/hooks/mailchimp/0123456789abcdef0123456789abcdef', raw)).status, 404);
});

test('an unsubscribe in base.win reaches Mailchimp once — a do-not-email tag and a bounce too; nobody is ever put back', async () => {
  const { c, ws } = await campaign('Out');
  const people = {};
  for (const w of ['ana', 'ben', 'cal', 'dee']) people[w] = await person(c, w);
  await subscribe(c, 'ana', 'ben');
  await connect(c);
  const list = await membersList(c);
  await push(c, ws, list.id, { everyone: true });
  assert.deepEqual(inTag(), ['ana', 'ben', 'cal', 'dee'].map(mail));
  const patches = () => fake.calls.filter((x) => x.method === 'PATCH').map((x) => [x.path, x.body]);
  const memberPath = (who) => `/lists/${fake.id}/members/${fake.member(mail(who)).id}`;

  // Ana uses the unsubscribe link in a newsletter.
  fake.calls.length = 0;
  assert.equal((await app.request(`/u/${(await subOf(ws, 'ana')).id}`, { method: 'POST' })).status, 200);
  await run(ws);
  assert.deepEqual(patches(), [[memberPath('ana'), { status: 'unsubscribed' }]]);
  assert.equal(fake.member(mail('ana')).status, 'unsubscribed');
  // Once: nothing more goes however often the jobs run, and Mailchimp's own webhook for it is not sent back here.
  assert.deepEqual([(await run(ws)).ran, patches().length], [0, 1]);

  // The desk takes Ben off the newsletter; Cal is tagged do-not-email; Dee's address bounces for good.
  fake.calls.length = 0;
  ok(await c.action('subscription.remove', { id: (await subOf(ws, 'ben')).id }));
  ok(await c.action('person.update', { id: people.cal.id, tags: ['member', 'do-not-email'] }));
  await runAction(db, { workspaceId: ws, actorId: null, action: 'mail.event' }, (tx, emit) => suppress(tx, emit, ws, { email: mail('dee'), reason: 'bounce', source: 'resend' }));
  await run(ws);
  assert.deepEqual(patches().sort(), ['ben', 'cal', 'dee'].map((w) => [memberPath(w), { status: 'unsubscribed' }]).sort());
  // A later change to someone already do-not-email says nothing new.
  fake.calls.length = 0;
  ok(await c.action('person.update', { id: people.cal.id, tags: ['member', 'do-not-email', 'volunteer'] }));
  assert.deepEqual([(await run(ws)).ran, fake.calls.length], [0, 0]);

  // Someone who was never in the audience: looked for, not there, nothing sent.
  const eve = await person(c, 'eve');
  ok(await c.action('person.update', { id: eve.id, tags: ['member', 'do-not-contact'] }));
  await run(ws);
  assert.deepEqual(fake.calls.map((x) => x.method), ['GET']);
  assert.equal(fake.member(mail('eve')), null, 'an address is never added to Mailchimp to say no for it');
  // Someone who already left in Mailchimp, or whose address it cleaned: left as they are.
  const fay = await person(c, 'fay');
  fake.add(mail('fay'), { status: 'cleaned' });
  fake.calls.length = 0;
  ok(await c.action('person.update', { id: fay.id, tags: ['member', 'do-not-email'] }));
  await run(ws);
  assert.deepEqual([fake.calls.map((x) => x.method), fake.member(mail('fay')).status], [['GET'], 'cleaned']);

  // Nothing base.win ever sends puts anyone back: no call says "subscribed" about a member already there.
  fake.calls.length = 0;
  await subscribe(c, 'gil'); // a new subscriber here is not Mailchimp's business until a list is sent
  ok(await c.action('person.update', { id: people.cal.id, tags: ['member'] })); // the desk lifts do-not-email
  assert.deepEqual([(await run(ws)).ran, fake.calls.length], [0, 0]);
  await push(c, ws, list.id, { everyone: true });
  assert.equal(fake.member(mail('cal')).status, 'unsubscribed', 'Cal stays unsubscribed in Mailchimp until Cal says otherwise there');
  assert.ok(fake.calls.filter((x) => x.method === 'PATCH').every((x) => x.body.status === 'unsubscribed'));
  assert.ok(fake.calls.filter((x) => x.method === 'POST' && x.path === `/lists/${fake.id}`).every((x) => x.body.update_existing === false));

  // Mailchimp is down when someone unsubscribes here: the no is kept, said on Settings → Services,
  // and sent once Mailchimp answers again (the next pull puts it back in line).
  await person(c, 'hal');
  await subscribe(c, 'hal');
  await push(c, ws, list.id, { everyone: true });
  assert.equal(fake.member(mail('hal')).status, 'subscribed');
  fake.fail(500);
  ok(await c.action('subscription.remove', { id: (await subOf(ws, 'hal')).id }));
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 0, failed: 1 });
  assert.equal(ok(await c.get('/api/mailchimp')).waiting, 1);
  await db.query("update jobs set status = 'failed', done_at = now() where workspace_id = $1 and kind = 'mailchimp.optout' and status = 'pending'", [ws]);
  assert.equal(ok(await c.get('/api/mailchimp')).waiting, 1, 'given up on by the job runner: still waiting, still said');
  fake.fail(false);
  ok(await c.action('mailchimp.pull', {}));
  await run(ws);
  assert.equal(fake.member(mail('hal')).status, 'unsubscribed');
  assert.equal(ok(await c.get('/api/mailchimp')).waiting, 0);
});

test('a 429 halfway leaves a sync the next run completes; a refusal that will not change stops it with Mailchimp’s words', async () => {
  const { c, ws } = await campaign('Limit');
  for (const w of ['ana', 'ben', 'cal']) await person(c, w);
  await subscribe(c, 'ana', 'ben', 'cal');
  const list = await membersList(c);
  ok(await c.action('mailchimp.push', { list_id: list.id }));
  // Mailchimp takes the three into the audience, then says "too many" before the tag is filled.
  const calls = [];
  fake.calls.length = 0;
  fake.limit({ after: 6 });
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 0, failed: 1 });
  calls.push(...fake.calls.map((x) => `${x.method} ${x.path.replace(/(segments\/)\d+/, '$1N')}`));
  assert.equal(calls.at(-1), `POST /lists/${fake.id}/segments/N`, calls.join(' | '));
  let s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.stalled, s.added, s.tagged], ['syncing', false, 3, 0]);
  assert.match(s.note, /^Mailchimp said: .*10 simultaneous connections/);
  assert.equal(fake.members().length, 3);
  assert.deepEqual(inTag(), []);
  // The job runner tries again by itself (a minute later): it finishes what was left.
  await db.query("update jobs set run_at = now() where workspace_id = $1 and kind = 'mailchimp.sync' and status = 'pending'", [ws]);
  assert.deepEqual(await run(ws), { ran: 1, failed: 0 });
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.tagged, s.skipped, s.note], ['synced', 3, 3, 3, 0, null], 'three were added once, not twice');
  assert.deepEqual(inTag(), ['ana', 'ben', 'cal'].map(mail));

  // Mailchimp keeps failing: after the last try the sync says it stopped, and Try again starts it afresh.
  await person(c, 'dee');
  await subscribe(c, 'dee');
  fake.fail(503);
  ok(await c.action('mailchimp.push', { list_id: list.id }));
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 0, failed: 1 });
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.stalled], ['syncing', false], 'still trying');
  await db.query("update jobs set status = 'failed', done_at = now() where workspace_id = $1 and kind = 'mailchimp.sync' and status = 'pending'", [ws]);
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.stalled], ['syncing', true]);
  assert.match(s.note, /^Mailchimp said: /);
  fake.fail(false);
  await push(c, ws, list.id);
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.stalled, s.total, s.added], ['synced', false, 4, 1]);

  // A key Mailchimp refuses will not get better by waiting: failed at once, in its words, nothing retried.
  ok(await c.action('mailchimp.push', { list_id: list.id }));
  process.env.MAILCHIMP_API_KEY = `wrong-${KEY}`;
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.stalled], ['failed', false]);
  assert.match(s.note, /^Mailchimp refused the key/);
  assert.ok(!JSON.stringify(s).includes(KEY));
  assert.deepEqual((await mine(c, 'mailchimp.push')).at(-1).payload, { status: 'failed', note: s.note });
  // …and the next tap is told so before anything is queued.
  const refused = await c.action('mailchimp.push', { list_id: list.id });
  assert.deepEqual([refused.status, refused.json.error], [502, 'Mailchimp refused the key — copy the whole key, with its ending (like -us19)']);
  assert.equal((await run(ws)).ran, 0);
  // Any other refusal is said in Mailchimp's own words (an account that may not do this, say).
  on({ MAILCHIMP_AUDIENCE_ID: fake.id });
  ok(await c.action('mailchimp.push', { list_id: list.id }));
  fake.fail(403);
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
  fake.fail(false);
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.note], ['failed', 'Mailchimp said: An unexpected internal error has occurred.']);
  // An audience id that could not be one never reaches an address.
  on({ MAILCHIMP_AUDIENCE_ID: '../../ping' });
  fake.calls.length = 0;
  const odd = await c.action('mailchimp.push', { list_id: list.id });
  assert.deepEqual([odd.status, fake.calls.length], [409, 0]);
  assert.match(odd.json.error, /^MAILCHIMP_AUDIENCE_ID isn’t an audience’s id/);
});

test('cleaned in Mailchimp is a dead address here; Pull now, the daily job, and a yes here that is newer than a no there', async () => {
  const { c, ws } = await campaign('Pull');
  for (const w of ['ana', 'ben', 'cal', 'dee', 'gil']) await person(c, w);
  await subscribe(c, 'ana', 'ben', 'dee', 'gil');
  const list = await membersList(c);
  const withEmail = async () => ok(await c.get('/api/lists')).lists.find((l) => l.id === list.id).counts.with_email;
  assert.equal(await withEmail(), 5);
  // In Mailchimp before base.win knew of it: Cal's address was cleaned, Ben left last week, and so did
  // someone base.win has never heard of. Dee and Gil left Mailchimp long ago. Since then Dee ticked the
  // newsletter box on the campaign's website herself; Gil was only typed in at the desk.
  fake.add(mail('cal'), { status: 'cleaned', changed: new Date(Date.now() - 9 * 86400e3) });
  fake.add(mail('ben'), { status: 'unsubscribed', changed: new Date(Date.now() - 7 * 86400e3) });
  fake.add(mail('nobody'), { status: 'unsubscribed' });
  fake.add(mail('dee'), { status: 'unsubscribed', changed: new Date(Date.now() - 400 * 86400e3) });
  fake.add(mail('gil'), { status: 'unsubscribed', changed: new Date(Date.now() - 400 * 86400e3) });
  await runAction(db, { workspaceId: ws, actorId: null, action: 'site.form' }, (tx, emit) => recordConsent(tx, ws, {
    channel: 'email', granted: true, source: 'newsletter-form', wording: 'Yes, email me news from the campaign', address: mail('dee'),
  }, emit));

  let st = ok(await c.get('/api/mailchimp'));
  assert.deepEqual([st.on, st.pulling, st.pulled_at], [true, false, null]);
  assert.equal(ok(await c.action('mailchimp.pull', {})).queued, true);
  assert.equal(ok(await c.get('/api/mailchimp')).pulling, true);
  assert.deepEqual(await run(ws), { ran: 1, failed: 0 });

  assert.deepEqual(await suppressions(ws), [{ email: mail('cal'), reason: 'bounce', source: 'mailchimp' }]);
  assert.equal((await subOf(ws, 'ben')).status, 'unsubscribed');
  assert.equal((await subOf(ws, 'dee')).status, 'subscribed', 'her own yes here is newer than her no there');
  assert.equal((await subOf(ws, 'gil')).status, 'unsubscribed', 'the desk typing him in does not undo his no');
  assert.equal((await db.query('select count(*)::int as n from consent_events where workspace_id = $1 and address = $2', [ws, mail('nobody')])).rows[0].n, 0, 'nothing is kept about an address nobody here holds');
  assert.equal(await withEmail(), 2, 'the list counts neither');
  st = ok(await c.get('/api/mailchimp'));
  assert.deepEqual([st.pulling, st.pull_ok, st.pull_note], [false, true, '2 unsubscribed · 1 dead address']);
  assert.ok(st.pulled_at);
  // Neither change is told back to Mailchimp.
  assert.deepEqual(writes(), []);
  const firstPull = fake.calls.filter((x) => x.path === `/lists/${fake.id}/members`);
  assert.deepEqual(firstPull.map((x) => [x.query.status, x.query.since_last_changed, x.query.count]), [['unsubscribed', undefined, '1000'], ['cleaned', undefined, '1000']], 'the first pull reads them all');

  // The days to come are queued, one job a day; each run queues the next ones first.
  const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  assert.deepEqual((await pullJobs(ws)).filter((j) => j.status === 'pending').map((j) => j.key), [1, 2, 3].map((n) => `mailchimp.pull:${day(n)}`));
  // Tomorrow's, run now: only what changed since the last pull (less an hour).
  await fake.clean(mail('ana'), { send: false });
  await db.query("update jobs set run_at = now() where workspace_id = $1 and key = $2", [ws, `mailchimp.pull:${day(1)}`]);
  fake.calls.length = 0;
  assert.deepEqual(await run(ws), { ran: 1, failed: 0 });
  const through = new Date(ok(await c.get('/api/mailchimp')).pulled_at).getTime();
  const daily = fake.calls.filter((x) => x.path === `/lists/${fake.id}/members`);
  assert.deepEqual(daily.map((x) => x.query.status), ['unsubscribed', 'cleaned']);
  for (const x of daily) {
    const since = new Date(x.query.since_last_changed).getTime();
    assert.ok(since < through - 3500e3 && since > through - 2 * 3600e3 - 60e3, `since ${x.query.since_last_changed}`);
  }
  assert.deepEqual((await suppressions(ws)).map((r) => r.email), [mail('ana'), mail('cal')]);
  assert.deepEqual((await pullJobs(ws)).filter((j) => j.status === 'pending').map((j) => j.key), [2, 3].map((n) => `mailchimp.pull:${day(n)}`));
  assert.equal(ok(await c.get('/api/mailchimp')).pull_note, '1 dead address');

  // Mailchimp down: the pull says so, the job runner tries again later, and the days to come stay queued.
  fake.fail(500);
  ok(await c.action('mailchimp.pull', {}));
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 0, failed: 1 });
  st = ok(await c.get('/api/mailchimp'));
  assert.equal(st.pull_ok, false);
  assert.match(st.pull_note, /^Mailchimp said: /);
  fake.fail(false);
  assert.equal(ok(await c.get('/api/audit/verify')).ok, true);
});

test('an address changed in Mailchimp is noted on the log, once — and only when Mailchimp says so itself', async () => {
  const { c, ws } = await campaign('Address');
  const ana = await person(c, 'ana');
  await subscribe(c, 'ana');
  await connect(c);
  fake.add(mail('ana-new'));
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await fake.hook('upemail', { old_email: mail('ana'), new_email: mail('ana-new'), list_id: fake.id })).status, 200);
    await run(ws);
  }
  const notes = (await mine(c, 'mailchimp.pull')).filter((e) => e.entity_type === 'mailchimp_address');
  assert.deepEqual(notes.map((e) => [e.entity_id, e.op, e.payload, e.actor_id]), [[ana.id, 'update', { was: mail('ana'), now: mail('ana-new') }, null]]);
  assert.equal((await db.query('select email from persons where id = $1', [ana.id])).rows[0].email, mail('ana'), 'the person here is not changed');
  // A made-up change to an address Mailchimp does not have: nothing.
  await fake.hook('upemail', { old_email: mail('ana'), new_email: mail('made-up'), list_id: fake.id });
  await run(ws);
  assert.equal((await mine(c, 'mailchimp.pull')).filter((e) => e.entity_type === 'mailchimp_address').length, 1);
});

test('Settings → Services: the Mailchimp row, Check and Connect — and who may do what', async () => {
  const { c: mgr, ws } = await campaign('Services');
  const staff = await join(mgr, 'staff', 'staff-services');
  const vol = await join(mgr, 'volunteer', 'vol-services');
  const rowOf = async () => ok(await mgr.get('/api/connections')).services.find((s) => s.key === 'mailchimp');
  const check = async () => ok(await mgr.post('/api/connections/check', { key: 'mailchimp' }));
  await person(mgr, 'ana');
  await subscribe(mgr, 'ana');
  const list = await membersList(mgr);
  const answers = [];

  // Not set up: named, with its setting; no button on a list; a push is refused; nothing is read.
  delete process.env.MAILCHIMP_API_KEY;
  let row = await rowOf();
  assert.deepEqual([row.name, row.state, row.launch, row.missing, row.checkable, row.panel], ['Mailchimp', 'missing', false, ['MAILCHIMP_API_KEY'], true, undefined]);
  assert.equal(row.for, 'A list becomes a tag in your Mailchimp audience; unsubscribes and dead addresses come back');
  assert.equal(ok(await staff.get('/api/integrations')).mailchimp, false);
  assert.deepEqual(await check(), { key: 'mailchimp', ok: false, said: 'MAILCHIMP_API_KEY isn’t set' });
  let r = await staff.action('mailchimp.push', { list_id: list.id });
  assert.deepEqual([r.status, r.json.error], [409, 'Mailchimp isn’t connected here']);
  assert.deepEqual((await stateOf(staff, list.id)), { on: false, running: false, sync: null });
  const off = ok(await mgr.action('mailchimp.connect', {}));
  assert.deepEqual([off.ok, off.said], [false, 'MAILCHIMP_API_KEY isn’t set']);
  // A key without its server ("-us19") can't be used: said, not guessed.
  process.env.MAILCHIMP_API_KEY = 'a-key-with-no-server';
  delete process.env.MAILCHIMP_API_BASE;
  row = await rowOf();
  assert.deepEqual([row.state, row.missing], ['missing', ['MAILCHIMP_API_KEY']]);
  assert.match(row.detail, /doesn’t end in its server/);
  assert.equal(ok(await staff.get('/api/integrations')).mailchimp, false);
  assert.equal(fake.calls.length, 0);

  // Set up.
  on();
  row = await rowOf();
  assert.deepEqual([row.state, row.missing, row.set, row.panel], ['ready', [], ['MAILCHIMP_API_KEY'], 'mailchimp']);
  assert.match(row.detail, /^Built against Mailchimp’s published API/);
  assert.equal(ok(await staff.get('/api/integrations')).mailchimp, true);
  const coming = ok(await mgr.get('/api/connections')).inbound.find((i) => /Mailchimp/.test(i.name));
  assert.equal(coming.url, `${PUBLIC}/hooks/mailchimp/…`, 'the address is listed without its last part');

  // Check, one shortfall at a time.
  process.env.MAILCHIMP_API_KEY = `wrong-${KEY}`;
  assert.deepEqual(await check(), { key: 'mailchimp', ok: false, said: 'Mailchimp refused the key — copy the whole key, with its ending (like -us19)' });
  on();
  fake.audience('aud0002', 'Old list');
  answers.push(await check());
  assert.deepEqual(answers.at(-1), { key: 'mailchimp', ok: false, said: `The key works, but the account has 2 audiences — set MAILCHIMP_AUDIENCE_ID to one: “Sample Campaign” (${fake.id}) · “Old list” (aud0002)` });
  r = await staff.action('mailchimp.push', { list_id: list.id });
  assert.deepEqual([r.status, r.json.error], [409, `The account has 2 audiences — a manager sets MAILCHIMP_AUDIENCE_ID to one (Settings → Services → Mailchimp → Check names them)`]);
  process.env.MAILCHIMP_AUDIENCE_ID = 'no-such-audience';
  assert.deepEqual(await check(), { key: 'mailchimp', ok: false, said: 'The key works, but there’s no audience “no-such-audience” on this account — check MAILCHIMP_AUDIENCE_ID' });
  on({ MAILCHIMP_AUDIENCE_ID: fake.id });
  fake.add(mail('someone'));
  fake.add(mail('someone-else'));
  answers.push(await check());
  assert.deepEqual(answers.at(-1), { key: 'mailchimp', ok: false, said: 'The key works · audience “Sample Campaign” · 2 subscribed — but Mailchimp isn’t sending unsubscribes here yet: tap Connect' });
  assert.deepEqual(writes(), [], 'Check only reads');

  // Connect is the one write: the webhook, with base.win's own changes left out of it.
  fake.signing('mc-shown-once');
  fake.probe(async (url) => (await app.request(new URL(url).pathname)).status);
  r = await staff.action('mailchimp.connect', {});
  assert.equal(r.status, 403);
  const made = ok(await mgr.action('mailchimp.connect', {}));
  answers.push(made);
  assert.deepEqual([made.ok, made.said, made.secret], [true, 'Mailchimp now sends unsubscribes and dead addresses here', 'mc-shown-once']);
  assert.deepEqual(fake.webhooks().map((w) => [w.url, w.events, w.sources]), [[`${PUBLIC}/hooks/mailchimp/${pathKey()}`,
    { subscribe: false, unsubscribe: true, profile: false, cleaned: true, upemail: true, campaign: false }, { user: true, admin: true, api: false }]]);
  const log = await mine(mgr, 'mailchimp.connect');
  assert.deepEqual(log.map((e) => [e.entity_type, e.op, e.payload, Boolean(e.actor_id)]), [['mailchimp', 'update', { webhook: 'connected' }, true]]);
  assert.equal((await pullJobs(ws)).filter((j) => j.status === 'pending').length, 3, 'the daily pull starts with it');
  answers.push(await check());
  assert.deepEqual(answers.at(-1), { key: 'mailchimp', ok: true, said: 'The key works · audience “Sample Campaign” · 2 subscribed · unsubscribes come back here' });
  // Again: already there, nothing written, no secret (Mailchimp shows it once).
  fake.calls.length = 0;
  const again = ok(await mgr.action('mailchimp.connect', {}));
  answers.push(again);
  assert.deepEqual([again.ok, again.said, again.secret, writes().length], [true, 'Mailchimp already sends unsubscribes and dead addresses here', undefined, 0]);
  assert.equal((await mine(mgr, 'mailchimp.connect')).length, 1);

  // A webhook made with an earlier key points at an address that answers nothing now: Connect replaces it.
  fake.webhooks()[0].url = `${PUBLIC}/hooks/mailchimp/0123456789abcdef0123456789abcdef`;
  fake.webhooks().push({ id: 'other', url: 'https://another-tool.example/hook', events: { unsubscribe: true }, sources: { user: true }, list_id: fake.id, secret: null });
  answers.push(await check());
  assert.deepEqual(answers.at(-1), { key: 'mailchimp', ok: false, said: 'The key works · audience “Sample Campaign” · 2 subscribed — but Mailchimp sends unsubscribes to an address from an earlier key: tap Connect' });
  ok(await mgr.action('mailchimp.connect', {}));
  assert.deepEqual(fake.webhooks().map((w) => w.url).sort(), ['https://another-tool.example/hook', `${PUBLIC}/hooks/mailchimp/${pathKey()}`], 'another tool’s webhook is left alone');
  // A webhook there with the events switched off is not "connected".
  fake.webhooks().find((w) => w.url.includes('/hooks/mailchimp/')).events.cleaned = false;
  assert.match((await check()).said, /isn’t sending unsubscribes here yet: tap Connect$/);
  ok(await mgr.action('mailchimp.connect', {}));
  assert.equal((await check()).ok, true);

  // A signing secret set here that is not the webhook's would have every delivery refused: Check says so.
  const hookPost = (raw, headers = {}) => app.request(hookPath(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: raw });
  const hint = new URLSearchParams({ type: 'unsubscribe', 'data[email]': mail('ana'), 'data[list_id]': fake.id }).toString();
  on({ MAILCHIMP_AUDIENCE_ID: fake.id, MAILCHIMP_WEBHOOK_SECRET: 'not-the-webhooks-secret' });
  assert.equal((await check()).ok, true, 'nothing has been refused yet');
  assert.equal((await hookPost(hint, { 'x-mailchimp-signature': signPayload(hint, 'mc-shown-once') })).status, 400);
  answers.push(await check());
  assert.deepEqual(answers.at(-1), { key: 'mailchimp', ok: false, said: 'The key works · audience “Sample Campaign” · 2 subscribed — but the last thing Mailchimp sent was refused: its signature didn’t match MAILCHIMP_WEBHOOK_SECRET' });
  on({ MAILCHIMP_AUDIENCE_ID: fake.id, MAILCHIMP_WEBHOOK_SECRET: 'mc-shown-once' });
  assert.equal((await hookPost(hint, { 'x-mailchimp-signature': signPayload(hint, 'mc-shown-once') })).status, 200);
  assert.equal((await check()).ok, true, 'the right secret: taken, and Check is content again');
  // …and a webhook that isn't signed at all, with a secret set here.
  fake.webhooks().find((w) => w.url.includes('/hooks/mailchimp/')).secret = null;
  assert.match((await check()).said, /— but MAILCHIMP_WEBHOOK_SECRET is set and that webhook isn’t signed, so what it sends is refused: take the setting away, or delete the webhook in Mailchimp and tap Connect$/);
  on({ MAILCHIMP_AUDIENCE_ID: fake.id });
  assert.equal((await check()).ok, true);
  await run(ws);

  // Mailchimp needs somewhere public to send to.
  delete process.env.STARBASE_PUBLIC_URL;
  assert.deepEqual([(await mgr.action('mailchimp.connect', {})).json.said], ['Set the public address first (STARBASE_PUBLIC_URL): Mailchimp needs somewhere to send unsubscribes']);
  on({ MAILCHIMP_AUDIENCE_ID: fake.id });

  // Who may: the desk sends a list; managers connect, check and pull; volunteers none of it.
  for (const [who, path] of [[staff, '/api/mailchimp'], [vol, '/api/mailchimp'], [vol, `/api/lists/${list.id}/mailchimp`], [vol, '/api/integrations']]) assert.equal((await who.get(path)).status, 403, path);
  for (const name of ['mailchimp.connect', 'mailchimp.pull']) assert.equal((await staff.action(name, {})).status, 403, name);
  assert.equal((await vol.action('mailchimp.push', { list_id: list.id })).status, 403);
  assert.equal((await staff.post('/api/connections/check', { key: 'mailchimp' })).status, 403);
  assert.equal((await staff.action('mailchimp.push', { list_id: list.id })).status, 200);
  assert.equal((await mgr.action('mailchimp.push', { list_id: '11111111-1111-4111-8111-111111111111' })).status, 404);
  // Sent twice while the first is still on its way: one job, not two.
  ok(await staff.action('mailchimp.push', { list_id: list.id }));
  assert.equal((await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'mailchimp.sync' and status = 'pending'", [ws])).rows[0].n, 1);
  await run(ws);
  const st = await stateOf(staff, list.id);
  assert.deepEqual([st.sync.status, st.sync.by], ['synced', 'Sam Example']);

  // Never the key, never the address's last part, in any answer or on the log.
  const said = JSON.stringify([answers, await rowOf(), ok(await mgr.get('/api/connections')), st, ok(await mgr.get('/api/mailchimp')), await logged(mgr)]);
  assert.ok(!said.includes(KEY) && !said.includes(pathKey()), 'no key and no webhook address in what base.win says');
  assert.ok(!JSON.stringify(await logged(mgr)).includes('mc-shown-once'), 'the signing secret is shown once, never kept');
});
