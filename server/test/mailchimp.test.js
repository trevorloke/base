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
import { enqueueJob, runDueJobs } from '../lib/jobs.js';
import { startFakeMailchimp } from './fake-mailchimp.js';
import { signPayload } from '../lib/signature.js';
import { _forgetAudienceForTest, pathKey } from '../ext/mailchimp/mailchimp.js';
import { _setSliceForTest } from '../ext/mailchimp/push.js';
import { pull } from '../ext/mailchimp/pull.js';
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
// The first pull from an audience waits for a yes; a test about something else starts past it, as if
// someone had said yes to the stand-in's audience (`asks: true` keeps the question to come).
const campaign = async (name, { asks = false } = {}) => {
  fake.reset();
  on();
  const c = new Client();
  const r = await c.signup({ workspaceName: `${name} ${tag}`, email: mail(`mgr-${name.toLowerCase().replace(/\W+/g, '')}`), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  if (!asks) await db.query('insert into mailchimp_state (workspace_id, agreed_for) values ($1, $2)', [r.json.workspace.id, fake.id]);
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
// Every write to Mailchimp carries an idempotency key, and a key is only ever shared by the same call said again.
const keysAreTrue = (calls = writes()) => {
  const said = new Map();
  for (const x of calls) {
    assert.match(String(x.key), /^base-mc-[a-z]+-[0-9a-f-]{20,}$/, `${x.method} ${x.path} carries a key`);
    const what = JSON.stringify([x.method, x.path, x.query, x.body]);
    assert.equal(said.get(x.key) ?? what, what, `one key, two different calls: ${x.key}`);
    said.set(x.key, what);
  }
  return said.size;
};
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
// The question before the first pull, with when it was counted said as 'when' (null: not counted).
const asked = (f) => (f ? { ...f, counted_at: f.counted_at ? 'when' : null } : f);

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
  // (What was said to Mailchimp: each call's query and body. A call's key and a member's place in an
  // address are 32 random-looking characters, where a run of digits means nothing.)
  const traffic = JSON.stringify(fake.calls.map((x) => [x.query, x.body]));
  for (const secret of ['rating-code-xyz', 'vip-donor', '"member"', '123 Example', '555-0142', '5550142', ana.id]) {
    assert.ok(!traffic.includes(secret), `${secret} never leaves base.win`);
  }
  assert.ok(fake.calls.every((x) => !x.path.includes(ana.id)), 'nor is anyone named in an address by who they are here');
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
  people.hal = await person(c, 'hal');
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
  assert.equal(keysAreTrue(w), 3, 'three writes, three keys');

  // Hal leaves the list and comes back. The last sync then says to Mailchimp exactly what an earlier
  // one said about him — and must not be taken for that one said again: a key belongs to one run.
  ok(await c.action('person.update', { id: people.hal.id, tags: [] }));
  await push(c, ws, list.id);
  assert.deepEqual(inTag(), [mail('ana'), mail('cal')]);
  ok(await c.action('person.update', { id: people.hal.id, tags: ['member'] }));
  fake.calls.length = 0;
  await push(c, ws, list.id);
  const again = writes();
  assert.deepEqual(again.map((x) => x.body), [w[0].body, w[1].body], 'the same two calls as before');
  assert.equal(keysAreTrue([...w, ...again]), 5, 'five writes over the two syncs, five keys');
  assert.deepEqual(inTag(), [mail('ana'), mail('cal'), mail('hal')]);
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
    assert.equal(s.skipped_why, `${mail('cal')} looks fake or invalid, please enter a real email address.`, 'and why, in Mailchimp’s own words');
  } finally { _setSliceForTest(null); }
  const sentTo = fake.calls.filter((x) => x.method === 'POST' && x.path === `/lists/${fake.id}`).flatMap((x) => x.body.members.map((m) => m.email_address));
  assert.deepEqual(sentTo.sort(), names.map(mail).sort(), 'each address was offered once');
  // The tag is read once for the whole sync, however many parts it takes (each part keeps it up to date):
  // re-read for every part, a big list would spend most of its calls reading.
  const tagReads = () => fake.calls.filter((x) => x.method === 'GET' && /\/segments\/\d+\/members$/.test(x.path)).length;
  assert.equal(tagReads(), 1, 'one read (the tag was still empty), for four parts');
  // Sync again reads it afresh, once: something may have changed there since.
  fake.calls.length = 0;
  fake.pageMax(1000);
  await push(c, ws, list.id);
  assert.equal(tagReads(), 1);
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

  // The desk takes Ben off the newsletter; Cal is tagged do-not-email (typed in capitals: it counts);
  // Dee's address bounces for good.
  fake.calls.length = 0;
  ok(await c.action('subscription.remove', { id: (await subOf(ws, 'ben')).id }));
  ok(await c.action('person.update', { id: people.cal.id, tags: ['member', 'Do-Not-Email'] }));
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

test('an older no on someone’s record never hides a new one: their own link, the desk’s tag again, do-not-contact, a new address', async () => {
  const { c, ws } = await campaign('Older');
  const there = (...who) => who.map((w) => fake.member(mail(w))?.status);
  const tags = async (p, ...t) => ok(await c.action('person.update', { id: p.id, tags: ['member', ...t] }));
  const patches = () => fake.calls.filter((x) => x.method === 'PATCH');
  // Ana left the newsletter last year by her own link, with the address she had then;
  // the desk has since typed in her new one.
  const ana = await person(c, 'ana-old');
  await subscribe(c, 'ana-old');
  assert.equal((await app.request(`/u/${(await subOf(ws, 'ana-old')).id}`, { method: 'POST' })).status, 200);
  ok(await c.action('person.update', { id: ana.id, email: mail('ana') }));
  // Dee, Eli and Fay were each tagged do-not-email once, and the desk lifted it.
  const people = {};
  for (const w of ['dee', 'eli', 'fay']) {
    people[w] = await person(c, w);
    await tags(people[w], 'do-not-email');
    await tags(people[w]);
  }
  await run(ws);
  const list = await membersList(c);
  await push(c, ws, list.id, { everyone: true });
  assert.deepEqual(there('ana', 'dee', 'eli', 'fay'), ['subscribed', 'subscribed', 'subscribed', 'subscribed'], 'all four can be emailed here, so all four went');

  // An email goes to the list from base.win (no sender is set up here: the rows are made, nothing is sent).
  ok(await c.action('blast.send', { kind: 'eblast', subject: 'Hello', body: 'Hello there', audience: { list_id: list.id } }));
  const theirLink = async (who) => {
    const row = (await db.query('select id from blast_recipients where workspace_id = $1 and lower(email) = $2', [ws, mail(who)])).rows[0];
    assert.ok(row, `the email went to ${who}`);
    assert.equal((await app.request(`/bu/${row.id}`, { method: 'POST' })).status, 200);
  };
  fake.calls.length = 0;
  await theirLink('ana'); // her own unsubscribe, at an address typed in after an old no
  await theirLink('dee'); // her own unsubscribe, after a tag the desk had lifted
  await tags(people.eli, 'do-not-contact'); // do-not-contact, after a lifted do-not-email
  await tags(people.fay, 'do-not-email'); // the desk’s tag, again
  assert.equal((await run(ws)).failed, 0);
  assert.deepEqual(there('ana', 'dee', 'eli', 'fay'), ['unsubscribed', 'unsubscribed', 'unsubscribed', 'unsubscribed'], 'each new no reached Mailchimp');
  assert.equal(patches().length, 4, 'once each');
  keysAreTrue();

  // The same no, a new address. Gus is do-not-email here; the desk corrects his address to one Mailchimp
  // has subscribed (he joined there himself, with it): Mailchimp is told about that address — once.
  const gus = await person(c, 'gus', { tags: ['member', 'do-not-email'] });
  fake.add(mail('gus-work'));
  await run(ws);
  fake.calls.length = 0;
  ok(await c.action('person.update', { id: gus.id, email: mail('gus-work') }));
  await run(ws);
  assert.deepEqual([there('gus-work'), patches().length], [['unsubscribed'], 1]);
  // …and nothing that says nothing new about email is ever told: another tag beside it, a phone number,
  // do-not-contact on top of do-not-email, the same address typed again.
  fake.calls.length = 0;
  await tags(gus, 'do-not-email', 'volunteer');
  ok(await c.action('person.update', { id: gus.id, phone: '604-555-0143' }));
  await tags(gus, 'do-not-email', 'volunteer', 'do-not-contact');
  ok(await c.action('person.update', { id: gus.id, email: mail('gus-work') }));
  assert.deepEqual([(await run(ws)).ran, fake.calls.length], [0, 0]);
  // So someone who says yes again in Mailchimp itself keeps that yes: a later change to their record
  // here, still tagged, is no new no and never takes them off there.
  fake.member(mail('fay')).status = 'subscribed';
  await tags(people.fay, 'do-not-email', 'volunteer');
  assert.deepEqual([(await run(ws)).ran, there('fay')], [0, ['subscribed']]);
  // The tag lifted and put on once more is a new no, and is told.
  await tags(people.fay, 'volunteer');
  await tags(people.fay, 'volunteer', 'do-not-email');
  await run(ws);
  assert.deepEqual(there('fay'), ['unsubscribed']);
  assert.equal(ok(await c.get('/api/audit/verify')).ok, true);
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
  // Said so whoever tapped can act on it: who chooses, and where — never a setting's name (Check names it, for a manager).
  assert.equal(odd.json.error, 'The audience set for base.win isn’t a Mailchimp audience — a manager chooses one (Settings → Services → Mailchimp → Check names them)');
});

test('cleaned in Mailchimp is a dead address here; Pull now, the daily job, and a yes here that is newer than a no there', async () => {
  const { c, ws } = await campaign('Pull', { asks: true });
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
  // The first pull from an audience turns off here everyone on file who ever left there, and nobody here
  // can turn that back: it only counts, and asks — the audience, and how many on file it would turn off.
  st = ok(await c.get('/api/mailchimp'));
  assert.deepEqual([asked(st.first), st.pulled_at], [{ audience: fake.id, name: 'Sample Campaign', unsubscribed: 2, cleaned: 1, counted_at: 'when', counting: false }, null]);
  assert.deepEqual([await suppressions(ws), (await subOf(ws, 'ben')).status, (await subOf(ws, 'gil')).status], [[], 'subscribed', 'subscribed'], 'nobody is turned off before a yes');
  assert.deepEqual(writes(), []);
  // The yes, for the audience it was counted for: now it is done — what it counted is what it does.
  fake.calls.length = 0;
  ok(await c.action('mailchimp.pull', { agree: fake.id }));
  assert.deepEqual(await run(ws), { ran: 1, failed: 0 });

  assert.deepEqual(await suppressions(ws), [{ email: mail('cal'), reason: 'bounce', source: 'mailchimp' }]);
  assert.equal((await subOf(ws, 'ben')).status, 'unsubscribed');
  assert.equal((await subOf(ws, 'dee')).status, 'subscribed', 'her own yes here is newer than her no there');
  assert.equal((await subOf(ws, 'gil')).status, 'unsubscribed', 'the desk typing him in does not undo his no');
  assert.equal((await db.query('select count(*)::int as n from consent_events where workspace_id = $1 and address = $2', [ws, mail('nobody')])).rows[0].n, 0, 'nothing is kept about an address nobody here holds');
  assert.equal(await withEmail(), 2, 'the list counts neither');
  st = ok(await c.get('/api/mailchimp'));
  assert.deepEqual([st.pulling, st.pull_ok, st.pull_note, st.first], [false, true, '2 unsubscribed · 1 dead address', null]);
  assert.ok(st.pulled_at);
  const yes = (await logged(c)).filter((e) => e.entity_type === 'mailchimp');
  assert.deepEqual(yes.map((e) => [e.action, e.payload, Boolean(e.actor_id)]), [['mailchimp.pull', { first_pull: 'yes', audience: fake.id, name: 'Sample Campaign', unsubscribed: 2, cleaned: 1 }, true]],
    'the yes is on the log: who gave it, for which audience, and what they were shown');
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

  // Dee is still on here (her own yes), and unsubscribed there. Sent to Mailchimp, she is put in the tag
  // and left exactly as she is — and the next sync finds her there and writes nothing: Mailchimp lists
  // a tag's members without the unsubscribed unless asked, and base.win asks.
  fake.calls.length = 0;
  await push(c, ws, list.id);
  assert.deepEqual([inTag(), fake.member(mail('dee')).status], [[mail('dee')], 'unsubscribed']);
  const tagRead = fake.calls.find((x) => x.method === 'GET' && /\/segments\/\d+\/members$/.test(x.path));
  assert.deepEqual([tagRead.query.include_unsubscribed, tagRead.query.include_cleaned, tagRead.query.include_transactional], ['true', 'true', 'true']);
  fake.calls.length = 0;
  await push(c, ws, list.id);
  assert.deepEqual(writes(), [], 'nothing to do the second time');
  assert.equal(fake.member(mail('dee')).status, 'unsubscribed', 'never put back');

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

test('the first pull asks first: Connect and the daily pull only count; a yes for that audience opens it; later pulls run as built', async () => {
  const { c: mgr, ws } = await campaign('Door', { asks: true });
  const staff = await join(mgr, 'staff', 'staff-door');
  const people = {};
  for (const w of ['ana', 'ben', 'cal', 'dee', 'eli', 'gus']) people[w] = await person(mgr, w);
  await subscribe(mgr, 'ana', 'ben', 'cal', 'eli', 'gus');
  const list = await membersList(mgr);
  // In Mailchimp from before base.win was connected to it: Ana and Dee left long ago (Dee never joined
  // the newsletter here), Cal's address died there, and someone nobody here knows left too.
  const longAgo = new Date(Date.now() - 300 * 86400e3);
  for (const w of ['ana', 'dee', 'stranger']) fake.add(mail(w), { status: 'unsubscribed', changed: longAgo });
  fake.add(mail('cal'), { status: 'cleaned', changed: longAgo });
  for (const w of ['ben', 'eli', 'gus']) fake.add(mail(w));
  const tagsOf = async (w) => (await db.query('select tags from persons where id = $1', [people[w].id])).rows[0].tags;
  const nothingYet = async () => {
    assert.deepEqual([(await subOf(ws, 'ana')).status, (await subOf(ws, 'ben')).status, await suppressions(ws), (await tagsOf('dee')).includes('do-not-email')],
      ['subscribed', 'subscribed', [], false], 'nobody is turned off before a yes');
  };

  // Not counted yet.
  assert.deepEqual(ok(await mgr.get('/api/mailchimp')).first, { audience: null, name: null, unsubscribed: null, cleaned: null, counted_at: null, counting: false });
  // Connect: the webhook is made, and what the first pull would do is counted at once — only counted.
  ok(await mgr.action('mailchimp.connect', {}));
  assert.equal(ok(await mgr.get('/api/mailchimp')).first.counting, true);
  await run(ws);
  const FIRST = { audience: fake.id, name: 'Sample Campaign', unsubscribed: 2, cleaned: 1, counted_at: 'when', counting: false };
  let st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([asked(st.first), st.pulled_at, st.pull_note], [FIRST, null, null]);
  await nothingYet();
  // A list's page has the same question for the desk.
  assert.deepEqual(asked((await stateOf(staff, list.id)).first), FIRST);
  // Someone leaving there now is not the past: Eli unsubscribes in Mailchimp, its webhook says so, and her
  // email is off here at once — she has just said no.
  await fake.unsubscribe(mail('eli'));
  await run(ws);
  assert.equal((await subOf(ws, 'eli')).status, 'unsubscribed');
  await nothingYet();

  // Pull now and the daily pull count again (someone else left there meanwhile), and turn nobody off.
  fake.add(mail('ben'), { status: 'unsubscribed', changed: longAgo });
  ok(await mgr.action('mailchimp.pull', {}));
  await run(ws);
  assert.deepEqual(asked(ok(await mgr.get('/api/mailchimp')).first), { ...FIRST, unsubscribed: 3 }, 'counted afresh');
  const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  await db.query('update jobs set run_at = now() where workspace_id = $1 and key = $2', [ws, `mailchimp.pull:${day(1)}`]);
  fake.calls.length = 0;
  assert.deepEqual(await run(ws), { ran: 1, failed: 0 });
  assert.deepEqual(fake.calls.filter((x) => x.path === `/lists/${fake.id}/members`).map((x) => [x.query.status, x.query.since_last_changed]),
    [['unsubscribed', undefined], ['cleaned', undefined]], 'the daily pull reads them all, and counts');
  assert.deepEqual(asked(ok(await mgr.get('/api/mailchimp')).first), { ...FIRST, unsubscribed: 3 });
  await nothingYet();
  assert.deepEqual(writes(), []);

  // The yes: a manager's here (staff give it by sending a list), and only for the audience counted.
  assert.equal((await staff.action('mailchimp.pull', { agree: fake.id })).status, 403);
  let r = await mgr.action('mailchimp.pull', { agree: 'aud-not-this-one' });
  assert.deepEqual([r.status, r.json.error], [409, 'Mailchimp’s audience has changed since — look again']);
  await run(ws);
  await nothingYet();
  ok(await mgr.action('mailchimp.pull', { agree: fake.id }));
  await run(ws);
  st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([st.first, st.pull_note], [null, '3 unsubscribed · 1 dead address'], 'what it counted is what it did');
  assert.deepEqual([(await subOf(ws, 'ana')).status, (await subOf(ws, 'ben')).status, (await tagsOf('dee')).includes('do-not-email')], ['unsubscribed', 'unsubscribed', true]);
  assert.deepEqual(await suppressions(ws), [{ email: mail('cal'), reason: 'bounce', source: 'mailchimp' }]);
  assert.equal((await stateOf(staff, list.id)).first, null);
  const yes = (await logged(mgr)).filter((e) => e.entity_type === 'mailchimp' && e.payload.first_pull);
  assert.deepEqual(yes.map((e) => [e.action, e.payload, Boolean(e.actor_id)]), [['mailchimp.pull', { first_pull: 'yes', audience: fake.id, name: 'Sample Campaign', unsubscribed: 3, cleaned: 1 }, true]]);
  // A yes said twice is one yes.
  ok(await mgr.action('mailchimp.pull', { agree: fake.id }));
  await run(ws);
  assert.equal((await logged(mgr)).filter((e) => e.entity_type === 'mailchimp' && e.payload.first_pull).length, 1);

  // Later pulls run as built: Gus leaves there with no webhook, and the next pull turns him off, no question.
  await fake.unsubscribe(mail('gus'), { send: false });
  ok(await mgr.action('mailchimp.pull', {}));
  await run(ws);
  st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([st.first, st.pull_note, (await subOf(ws, 'gus')).status], [null, '1 unsubscribed', 'unsubscribed']);

  // Another audience is another door: a yes for the first one is no yes for it.
  await person(mgr, 'fay');
  await subscribe(mgr, 'fay');
  fake.audience('aud0002', 'Old list');
  fake.add(mail('fay'), { status: 'unsubscribed', changed: longAgo, audienceId: 'aud0002' });
  on({ MAILCHIMP_AUDIENCE_ID: 'aud0002' });
  ok(await mgr.action('mailchimp.pull', {}));
  await run(ws);
  assert.deepEqual(asked(ok(await mgr.get('/api/mailchimp')).first), { audience: 'aud0002', name: 'Old list', unsubscribed: 1, cleaned: 0, counted_at: 'when', counting: false });
  assert.equal((await subOf(ws, 'fay')).status, 'subscribed');
  assert.equal((await mgr.action('mailchimp.pull', { agree: fake.id })).status, 409);
  on();
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('with nobody on file to turn off nothing is asked, and nothing opens: the first pull that would turn someone off still asks', async () => {
  const { c: mgr, ws } = await campaign('Late', { asks: true });
  const staff = await join(mgr, 'staff', 'staff-late');
  const doorSaid = async () => (await logged(mgr)).filter((e) => e.entity_type === 'mailchimp' && e.payload.first_pull)
    .map((e) => [e.action, e.payload, Boolean(e.actor_id)]);
  // In Mailchimp (an older audience, say): three who left long ago, and someone nobody here knows.
  const longAgo = new Date(Date.now() - 300 * 86400e3);
  const gone = ['ola', 'pia', 'quin'];
  for (const w of gone) fake.add(mail(w), { status: 'unsubscribed', changed: longAgo });
  fake.add(mail('stranger'), { status: 'unsubscribed' });
  // Connect before the campaign's file is in: nobody on file to turn off, so there is nothing to ask…
  await connect(mgr);
  await run(ws);
  let st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([asked(st.first), st.pull_ok, st.pull_note], [{ audience: fake.id, name: null, unsubscribed: 0, cleaned: 0, counted_at: 'when', counting: false }, true, 'Nothing new']);
  // …and nothing opens by itself: only a person's yes does that.
  assert.deepEqual(await doorSaid(), []);
  // A list goes all the same, turning nobody off: a send counts first, then goes on with what it was shown.
  for (const w of ['ana', 'ben']) await person(mgr, w);
  await subscribe(mgr, 'ana', 'ben');
  const list = await membersList(mgr);
  let r = ok(await staff.action('mailchimp.push', { list_id: list.id }));
  assert.deepEqual([r.sync, r.first.counting], [undefined, true]);
  await run(ws);
  assert.deepEqual(asked((await stateOf(staff, list.id)).first), { audience: fake.id, name: null, unsubscribed: 0, cleaned: 0, counted_at: 'when', counting: false });
  r = ok(await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id, shown: { unsubscribed: 0, cleaned: 0 } }));
  assert.equal(r.sync.status, 'queued');
  await run(ws);
  assert.deepEqual([(await stateOf(staff, list.id)).sync.status, inTag()], ['synced', [mail('ana'), mail('ben')]]);
  assert.deepEqual(await doorSaid(), [], 'still nobody has said yes');

  // The campaign's file comes in: the three, on the newsletter and on the list.
  for (const w of gone) await person(mgr, w);
  await subscribe(mgr, ...gone);
  const stillOn = async () => (await Promise.all(gone.map(async (w) => (await subOf(ws, w)).status))).filter((s) => s === 'subscribed').length;
  // The nightly pull counts them, and turns nobody off.
  const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  await db.query('update jobs set run_at = now() where workspace_id = $1 and key = $2', [ws, `mailchimp.pull:${day(1)}`]);
  await run(ws);
  assert.deepEqual([ok(await mgr.get('/api/mailchimp')).first.unsubscribed, await stillOn()], [3, 3]);
  // Sync again: counted afresh, and the answer is the question — nothing goes, nobody is turned off.
  fake.calls.length = 0;
  r = ok(await staff.action('mailchimp.push', { list_id: list.id }));
  assert.deepEqual([r.sync, r.first.counting], [undefined, true]);
  assert.equal((await run(ws)).ran, 1, 'counted again, though a count was there');
  const FIRST = { audience: fake.id, name: 'Sample Campaign', unsubscribed: 3, cleaned: 0, counted_at: 'when', counting: false };
  assert.deepEqual(asked((await stateOf(staff, list.id)).first), FIRST);
  assert.deepEqual([await stillOn(), writes(), await doorSaid()], [3, [], []], 'nobody turned off, nothing sent, nothing opened');
  // Going on as if nobody would be turned off is not what the count says now: look again.
  r = await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id, shown: { unsubscribed: 0, cleaned: 0 } });
  assert.deepEqual([r.status, r.json.error, await stillOn()], [409, 'The count has changed since — look again', 3]);
  // The yes, to what it showed: the three are turned off, and the yes on the log is a person's.
  ok(await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id, shown: { unsubscribed: 3, cleaned: 0 } }));
  await run(ws);
  const s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([await stillOn(), s.status, s.pulled_unsubscribed], [0, 'synced', 3]);
  assert.deepEqual(await doorSaid(), [['mailchimp.push', { first_pull: 'yes', audience: fake.id, name: 'Sample Campaign', unsubscribed: 3, cleaned: 0 }, true]]);
  st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([st.first, st.pull_note], [null, '3 unsubscribed']);
});

test('a yes is for what it was shown: the first pull after it counts again, and asks again before turning off more', async () => {
  const { c: mgr, ws } = await campaign('Stale', { asks: true });
  const staff = await join(mgr, 'staff', 'staff-stale');
  const longAgo = new Date(Date.now() - 300 * 86400e3);
  const leftLongAgo = async (...who) => { for (const w of who) { await person(mgr, w); await subscribe(mgr, w); fake.add(mail(w), { status: 'unsubscribed', changed: longAgo }); } };
  const everyone = ['ana', 'ben', 'cal', 'dee', 'eli', 'fay'];
  const stillOn = async () => (await Promise.all(everyone.map(async (w) => (await subOf(ws, w))?.status))).filter((x) => x === 'subscribed').length;
  const doorSaid = async () => (await logged(mgr)).filter((e) => e.entity_type === 'mailchimp' && e.payload.first_pull)
    .map((e) => [e.action, e.payload.first_pull, e.payload.unsubscribed, Boolean(e.actor_id)]);
  await leftLongAgo('ana', 'ben');
  const list = await membersList(mgr);
  // On a list's page: Send counts, and asks about two.
  ok(await staff.action('mailchimp.push', { list_id: list.id }));
  await run(ws);
  let first = (await stateOf(staff, list.id)).first;
  assert.deepEqual([first.unsubscribed, first.cleaned], [2, 0]);
  assert.ok(Math.abs(Date.now() - Date.parse(first.counted_at)) < 60e3, 'it says when it was counted');
  // The supporter file comes in while the question is open: three more who left that audience long ago.
  await leftLongAgo('cal', 'dee', 'eli');
  // The yes to two. Before taking anything in, the sync's pull counts again — five — and asks again:
  // nobody is turned off, nothing is sent, and the list's line says why.
  ok(await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id, shown: { unsubscribed: 2, cleaned: 0 } }));
  await run(ws);
  let s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([s.status, s.note, s.pulled_unsubscribed], ['failed', '5 people here unsubscribed in Mailchimp, more than the question said, so nothing was sent — tap Try again', 0]);
  assert.deepEqual([await stillOn(), fake.tagged(TAG)], [5, null]);
  first = (await stateOf(staff, list.id)).first;
  assert.deepEqual([first.unsubscribed, first.counting], [5, false]);
  assert.deepEqual(await doorSaid(), [['mailchimp.push', 'yes', 2, true], ['mailchimp.pull', 'asked again', undefined, false]]);
  const again = (await logged(mgr)).filter((e) => e.payload?.first_pull === 'asked again')[0];
  assert.deepEqual([again.payload.shown, again.payload.counted], [{ unsubscribed: 2, cleaned: 0 }, { unsubscribed: 5, cleaned: 0 }], 'what the yes saw, and what was counted');
  // A yes to the old number is refused: look again.
  const r = await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id, shown: { unsubscribed: 2, cleaned: 0 } });
  assert.deepEqual([r.status, r.json.error], [409, 'The count has changed since — look again']);

  // Settings → Services shows the count it has, however old: one more comes in after it, and the manager's
  // yes to five asks again too — then the yes to six is done.
  await leftLongAgo('fay');
  assert.equal(ok(await mgr.get('/api/mailchimp')).first.unsubscribed, 5);
  ok(await mgr.action('mailchimp.pull', { agree: fake.id, shown: { unsubscribed: 5, cleaned: 0 } }));
  await run(ws);
  let st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([st.first.unsubscribed, st.pulled_at, await stillOn()], [6, null, 6]);
  ok(await mgr.action('mailchimp.pull', { agree: fake.id, shown: { unsubscribed: 6, cleaned: 0 } }));
  await run(ws);
  st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([st.first, st.pull_note, await stillOn()], [null, '6 unsubscribed', 0]);
  assert.deepEqual((await doorSaid()).map((x) => x.slice(1, 3)), [['yes', 2], ['asked again', undefined], ['yes', 5], ['asked again', undefined], ['yes', 6]]);
  // Try again on the list now sends, and asks nothing.
  ok(await staff.action('mailchimp.push', { list_id: list.id }));
  await run(ws);
  s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([s.status, s.total], ['synced', 0]);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('the question counts people: two records with one address are two', async () => {
  const { c, ws } = await campaign('Household', { asks: true });
  const longAgo = new Date(Date.now() - 300 * 86400e3);
  // Ana and Bo share one address the desk typed in; Cy and Di are on the newsletter.
  await c.createPerson('Ana Example', { email: mail('home') });
  await c.createPerson('Bo Example', { email: mail('home') });
  for (const w of ['cy', 'di']) { await person(c, w); await subscribe(c, w); }
  for (const w of ['home', 'cy']) fake.add(mail(w), { status: 'unsubscribed', changed: longAgo });
  await connect(c);
  await run(ws);
  const first = ok(await c.get('/api/mailchimp')).first;
  assert.deepEqual([first.unsubscribed, first.cleaned], [3, 0], 'Ana, Bo and Cy: three people, two addresses');
  ok(await c.action('mailchimp.pull', { agree: fake.id, shown: { unsubscribed: 3, cleaned: 0 } }));
  await run(ws);
  const off = (await db.query(`select name from persons where workspace_id = $1 and deleted_at is null and tags @> '"do-not-email"'::jsonb order by name`, [ws])).rows.map((x) => x.name);
  assert.deepEqual([off, (await subOf(ws, 'cy')).status, (await subOf(ws, 'di')).status], [['Ana Example', 'Bo Example'], 'unsubscribed', 'subscribed']);
  assert.equal(ok(await c.get('/api/mailchimp')).pull_note, '3 unsubscribed', 'what it counted is what it did');
});

// The door's own log: [what, how many it showed, a person's?].
const doorLog = async (c) => (await logged(c)).filter((e) => e.entity_type === 'mailchimp' && e.payload.first_pull)
  .map((e) => [e.payload.first_pull, e.payload.unsubscribed, Boolean(e.actor_id)]);
const longAgo = () => new Date(Date.now() - 300 * 86400e3);
const tomorrow = () => new Date(Date.now() + 86400e3).toISOString().slice(0, 10);

test('until someone says yes, a no Mailchimp dates after the audience was first counted is new: the nightly pull takes it in, as its webhook would have; older ones wait for the question', async () => {
  const { c: mgr, ws } = await campaign('Net', { asks: true });
  const staff = await join(mgr, 'staff', 'staff-net');
  const onFile = async (w, there = {}) => { await person(mgr, w); await subscribe(mgr, w); fake.add(mail(w), there); };
  // A brand-new audience: Ana, Ben and Cy are subscribed in both places, and nobody has left it. Connect counts
  // nobody to turn off: there is no question, and nothing opens.
  for (const w of ['ana', 'ben', 'cy']) await onFile(w);
  await connect(mgr);
  await run(ws);
  let st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([asked(st.first), st.pull_note], [{ audience: fake.id, name: null, unsubscribed: 0, cleaned: 0, counted_at: 'when', counting: false }, 'Nothing new']);
  // Weeks later Ana unsubscribes from one of its emails and Ben's address dies there; neither webhook arrives (a
  // deploy, a signing secret copied wrong). And Dee comes in on file: she left that audience long ago.
  await fake.unsubscribe(mail('ana'), { send: false });
  await fake.clean(mail('ben'), { send: false });
  await onFile('dee', { status: 'unsubscribed', changed: longAgo() });
  // The nightly pull is the net for a webhook that never came: Ana's no and Ben's dead address are newer than the
  // audience's first count, and taken in as their webhooks would have been. Dee's is older: counted, and asked.
  await db.query('update jobs set run_at = now() where workspace_id = $1 and key = $2', [ws, `mailchimp.pull:${tomorrow()}`]);
  assert.deepEqual(await run(ws), { ran: 1, failed: 0 });
  assert.deepEqual([(await subOf(ws, 'ana')).status, await suppressions(ws), (await subOf(ws, 'dee')).status],
    ['unsubscribed', [{ email: mail('ben'), reason: 'bounce', source: 'mailchimp' }], 'subscribed']);
  assert.deepEqual((await consents(ws, 'ana')).at(-1), { granted: false, source: 'mailchimp-unsubscribe' });
  st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([asked(st.first), st.pull_note], [{ audience: fake.id, name: 'Sample Campaign', unsubscribed: 1, cleaned: 0, counted_at: 'when', counting: false }, '1 unsubscribed · 1 dead address']);
  assert.ok(st.pulled_at, 'the line says when');
  assert.deepEqual(await doorLog(mgr), [], 'nobody has said yes, and nothing opened');

  // On a list's page, the yes to the question as it stands (Dee). Before its sync's pull, Gil comes in on file (he
  // left long ago too), so does Hal (his address died there long ago), and Eve unsubscribes there, her webhook lost
  // as well. The pull counts more from before than the yes saw: it asks again and sends nothing — but Eve's no is
  // new, and taken in, and the list's line says so.
  const list = await membersList(mgr);
  await onFile('gil', { status: 'unsubscribed', changed: longAgo() });
  await onFile('hal', { status: 'cleaned', changed: longAgo() });
  await onFile('eve');
  await fake.unsubscribe(mail('eve'), { send: false });
  ok(await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id, shown: { unsubscribed: 1, cleaned: 0 } }));
  await run(ws);
  const s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([s.status, s.note, s.pulled_unsubscribed, s.pulled_cleaned],
    ['failed', '2 people here unsubscribed in Mailchimp and 1 address here is dead there, more than the question said, so nothing was sent — tap Try again', 1, 0]);
  assert.deepEqual([(await subOf(ws, 'eve')).status, (await subOf(ws, 'dee')).status, (await subOf(ws, 'gil')).status], ['unsubscribed', 'subscribed', 'subscribed']);
  assert.deepEqual([(await suppressions(ws)).map((x) => x.email), fake.tagged(TAG)], [[mail('ben')], null], 'Hal waits for the question; nothing was sent');
  assert.deepEqual(await doorLog(mgr), [['yes', 1, true], ['asked again', undefined, false]]);
  // The yes to the question as it stands now: the three from before are turned off, and the door is open.
  ok(await mgr.action('mailchimp.pull', { agree: fake.id, shown: { unsubscribed: 2, cleaned: 1 } }));
  await run(ws);
  st = ok(await mgr.get('/api/mailchimp'));
  assert.deepEqual([st.first, st.pull_note, (await subOf(ws, 'dee')).status, (await subOf(ws, 'gil')).status, (await suppressions(ws)).map((x) => x.email)],
    [null, '2 unsubscribed · 1 dead address', 'unsubscribed', 'unsubscribed', [mail('ben'), mail('hal')]]);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('a pull already on its way when someone says yes never stands in for the count that yes was promised', async () => {
  const { c: mgr, ws } = await campaign('Race', { asks: true });
  on({ MAILCHIMP_AUDIENCE_ID: fake.id }); // known without asking Mailchimp: a pull reads its state, then Mailchimp
  const leftLongAgo = async (...who) => { for (const w of who) { await person(mgr, w); await subscribe(mgr, w); fake.add(mail(w), { status: 'unsubscribed', changed: longAgo() }); } };
  const door = async () => (await db.query('select agreed_for, agreed_unsubscribed, agreed_cleaned from mailchimp_state where workspace_id = $1', [ws])).rows[0];
  await leftLongAgo('ana');
  await connect(mgr);
  await run(ws);
  const first = ok(await mgr.get('/api/mailchimp')).first;
  assert.deepEqual([first.unsubscribed, first.cleaned], [1, 0]);
  // A pull on its way (the nightly one, or a count a Send started) is still reading Mailchimp…
  const held = fake.hold();
  const x = pull(db, ws, { full: true });
  await held.reached;
  // …when the manager says yes to the question (one person), and Ana, that one person, unsubscribes here herself.
  ok(await mgr.action('mailchimp.pull', { agree: fake.id, shown: { unsubscribed: 1, cleaned: 0 } }));
  assert.equal((await app.request(`/u/${(await subOf(ws, 'ana')).id}`, { method: 'POST' })).status, 200);
  held.release();
  assert.deepEqual(await x, { unsubscribed: 0, cleaned: 0 });
  // It counted nobody and went on, but it began before the yes: the yes still waits for a count of its own.
  assert.deepEqual(await door(), { agreed_for: fake.id, agreed_unsubscribed: 1, agreed_cleaned: 0 });
  // The supporter file comes in: three who left that audience long ago. The yes's own pull counts again — three,
  // more than it was shown — and asks again, turning nobody off.
  await leftLongAgo('ben', 'cal', 'dee');
  await run(ws);
  assert.deepEqual(await Promise.all(['ben', 'cal', 'dee'].map(async (w) => (await subOf(ws, w)).status)), ['subscribed', 'subscribed', 'subscribed']);
  assert.deepEqual(asked(ok(await mgr.get('/api/mailchimp')).first), { audience: fake.id, name: 'Sample Campaign', unsubscribed: 3, cleaned: 0, counted_at: 'when', counting: false });
  assert.deepEqual(await doorLog(mgr), [['yes', 1, true], ['asked again', undefined, false]]);
  on();
});

test('a pull sets aside only the yes it counted against, never a newer one given while it was on its way', async () => {
  const { c: mgr, ws } = await campaign('Newer', { asks: true });
  on({ MAILCHIMP_AUDIENCE_ID: fake.id });
  const leftLongAgo = async (...who) => { for (const w of who) { await person(mgr, w); await subscribe(mgr, w); fake.add(mail(w), { status: 'unsubscribed', changed: longAgo() }); } };
  const door = async () => (await db.query('select agreed_for, agreed_unsubscribed, agreed_cleaned from mailchimp_state where workspace_id = $1', [ws])).rows[0];
  await leftLongAgo('ana');
  await connect(mgr);
  await run(ws);
  // The yes to one person. Ben comes in (he left long ago too) before any pull has counted again.
  ok(await mgr.action('mailchimp.pull', { agree: fake.id, shown: { unsubscribed: 1, cleaned: 0 } }));
  await leftLongAgo('ben');
  // A pull starts (it is the first after that yes, and counts against it), and is held while it reads Mailchimp.
  const held = fake.hold();
  const x = pull(db, ws, { full: true });
  await held.reached;
  // Meanwhile the yes's own pull counts two, more than it saw, and asks again — and the manager says yes to two.
  await run(ws);
  assert.deepEqual(ok(await mgr.get('/api/mailchimp')).first.unsubscribed, 2);
  ok(await mgr.action('mailchimp.pull', { agree: fake.id, shown: { unsubscribed: 2, cleaned: 0 } }));
  // The held pull counts two as well, more than the yes it began under: that yes was set aside already, and the
  // newer one, for two, is not its to set aside.
  held.release();
  await x;
  assert.deepEqual(await door(), { agreed_for: fake.id, agreed_unsubscribed: 2, agreed_cleaned: 0 });
  assert.deepEqual(await doorLog(mgr), [['yes', 1, true], ['asked again', undefined, false], ['yes', 2, true]]);
  // The newer yes's own pull counts two, as it was shown, and turns both off.
  await run(ws);
  assert.deepEqual([(await subOf(ws, 'ana')).status, (await subOf(ws, 'ben')).status, ok(await mgr.get('/api/mailchimp')).first], ['unsubscribed', 'unsubscribed', null]);
  on();
});

test('a sync the question stopped says why in a sentence of its own: a list that went by itself never reads "since it was counted"', async () => {
  const { c: mgr, ws } = await campaign('Words', { asks: true });
  const staff = await join(mgr, 'staff', 'staff-words');
  await person(mgr, 'ana');
  await subscribe(mgr, 'ana');
  const list = await membersList(mgr);
  // Send: counted first — nobody on file to turn off, so the list goes on by itself (the page sends what it was shown).
  ok(await staff.action('mailchimp.push', { list_id: list.id }));
  await run(ws);
  assert.deepEqual(asked((await stateOf(staff, list.id)).first), { audience: fake.id, name: null, unsubscribed: 0, cleaned: 0, counted_at: 'when', counting: false });
  // Before its sync's pull, Hal comes in on file: his address died in Mailchimp long ago.
  await person(mgr, 'hal');
  fake.add(mail('hal'), { status: 'cleaned', changed: longAgo() });
  ok(await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id, shown: { unsubscribed: 0, cleaned: 0 } }));
  await run(ws);
  const s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([s.status, s.note], ['failed', '1 address here is dead in Mailchimp, so nothing was sent — tap Try again']);
  assert.deepEqual([await suppressions(ws), fake.tagged(TAG)], [[], null]);
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

test('an audience that insists on a field of its own still takes a new address, and an unsubscribe', async () => {
  const { c, ws } = await campaign('Required');
  for (const w of ['ana', 'ben']) await person(c, w);
  await c.createPerson('Cher', { email: mail('cher'), tags: ['member'] }); // one name only: no last name to send
  await subscribe(c, 'ana', 'ben', 'cher');
  // The audience asks every new member for a postal code (a field base.win never sends) — and for a last name.
  fake.requireMerge('POSTAL');
  const list = await membersList(c);
  await push(c, ws, list.id);
  let s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.tagged, s.skipped], ['synced', 3, 3, 3, 0], 'nobody was refused for a field the audience usually asks for');
  fake.requireMerge('LNAME');
  const dee = await person(c, 'dee');
  await c.createPerson('Eli', { email: mail('eli'), tags: ['member'] });
  await subscribe(c, 'dee', 'eli');
  await push(c, ws, list.id);
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.skipped], ['synced', 5, 2, 0]);
  assert.deepEqual(fake.member(mail('eli')).merge_fields, { FNAME: 'Eli', LNAME: '' });
  // Still only the address and the two names: nothing is made up to satisfy the audience.
  for (const x of fake.calls.filter((y) => y.method === 'POST' && y.path === `/lists/${fake.id}`)) {
    assert.equal(x.query.skip_merge_validation, 'true');
    for (const m of x.body.members) assert.deepEqual(Object.keys(m.merge_fields).sort(), ['FNAME', 'LNAME']);
  }
  // Eli (no last name in Mailchimp either) says no here: the audience's rule about a last name never stops that.
  ok(await c.action('subscription.remove', { id: (await subOf(ws, 'eli')).id }));
  ok(await c.action('person.update', { id: dee.id, tags: ['member', 'do-not-email'] }));
  assert.equal((await run(ws)).failed, 0);
  assert.deepEqual([fake.member(mail('eli')).status, fake.member(mail('dee')).status], ['unsubscribed', 'unsubscribed']);
});

test('an address Mailchimp refuses is counted once, however often its part of the sync is tried', async () => {
  const { c, ws } = await campaign('Once');
  for (const w of ['ana', 'ben', 'cal']) await person(c, w);
  await subscribe(c, 'ana', 'ben', 'cal');
  fake.refuse(mail('cal'));
  const list = await membersList(c);
  ok(await c.action('mailchimp.push', { list_id: list.id }));
  // Mailchimp takes two into the audience and refuses the third; then says "too many" before the tag is filled.
  fake.calls.length = 0;
  fake.limit({ after: 6 });
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 0, failed: 1 });
  const refusedCall = fake.calls.at(-1);
  assert.deepEqual([refusedCall.method, refusedCall.path.replace(/\d+$/, 'N')], ['POST', `/lists/${fake.id}/segments/N`]);
  let s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.added, s.tagged, s.skipped], ['syncing', 2, 0, 0], 'nothing is counted for a part that isn’t done');
  // The job runner tries again: the same part, from its start.
  await db.query("update jobs set run_at = now() where workspace_id = $1 and kind = 'mailchimp.sync' and status = 'pending'", [ws]);
  assert.deepEqual(await run(ws), { ran: 1, failed: 0 });
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.tagged, s.skipped], ['synced', 3, 2, 2, 1], 'Cal was refused twice and is counted once');
  assert.deepEqual(inTag(), [mail('ana'), mail('ben')]);
  // The tag call that was refused and the one that went through said the same thing: one key.
  const tagCalls = fake.calls.filter((x) => x.method === 'POST' && /\/segments\/\d+$/.test(x.path));
  assert.deepEqual([tagCalls.length, new Set(tagCalls.map((x) => x.key)).size], [2, 1]);
  keysAreTrue();

  // Why it would not take him is kept with the count, in Mailchimp's own words — the first refusal's, when there are several.
  const CAL_SAID = `${mail('cal')} looks fake or invalid, please enter a real email address.`;
  assert.equal(s.skipped_why, CAL_SAID);
  for (const w of ['dee', 'eli']) await person(c, w);
  await subscribe(c, 'dee', 'eli');
  fake.refuse(mail('dee'), 'has signed up to a lot of lists very recently; we’re not allowing more signups for now');
  // …and a member it takes into the audience but will not put in a tag is one it would not take, too.
  fake.untaggable(mail('eli'), 'This contact can’t be added to a tag.');
  await push(c, ws, list.id);
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.tagged, s.skipped, s.skipped_why], ['synced', 5, 1, 0, 3, CAL_SAID]);
  assert.deepEqual(inTag(), [mail('ana'), mail('ben')]);
  // Only the tag's refusal is left: its words are the ones kept.
  fake.refuse(mail('cal'), false);
  fake.refuse(mail('dee'), false);
  await push(c, ws, list.id);
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.tagged, s.skipped, s.skipped_why], ['synced', 5, 2, 2, 1, 'This contact can’t be added to a tag.']);
  // Nothing refused any more: nothing is said about it.
  fake.untaggable(mail('eli'), false);
  await push(c, ws, list.id);
  s = (await stateOf(c, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.tagged, s.skipped, s.skipped_why], ['synced', 5, 1, 0, null]);
  assert.deepEqual(inTag(), ['ana', 'ben', 'cal', 'dee', 'eli'].map(mail));
});

test('the first send asks first, then says who its own pull turned off here: everyone who had left in Mailchimp', async () => {
  const { c: mgr, ws } = await campaign('First', { asks: true });
  const staff = await join(mgr, 'staff', 'staff-first');
  const names = ['ana', 'ben', 'cal', 'dee', 'eli'];
  for (const w of names) await person(mgr, w);
  await mgr.createPerson('Fay Example', { email: mail('fay') }); // on file, not on this list
  await subscribe(mgr, ...names, 'fay');
  const list = await membersList(mgr);
  // In Mailchimp from before base.win was connected to it: Ana and Fay left long ago, Ben's address died there.
  const longAgo = new Date(Date.now() - 300 * 86400e3);
  fake.add(mail('ana'), { status: 'unsubscribed', changed: longAgo });
  fake.add(mail('fay'), { status: 'unsubscribed', changed: longAgo });
  fake.add(mail('ben'), { status: 'cleaned', changed: longAgo });

  // A staff member sends the list, with no pull before it: the question counts five…
  assert.deepEqual((await stateOf(staff, list.id, true)).counts, { subscribed: 5, everyone: 5 });
  // …and nothing goes yet. A sync starts with a pull, and the first pull from an audience turns off here
  // everyone on file who ever left there, for good: the answer is a question, counted first.
  let r = ok(await staff.action('mailchimp.push', { list_id: list.id }));
  assert.deepEqual([r.sync, r.first], [undefined, { audience: fake.id, name: null, unsubscribed: null, cleaned: null, counted_at: null, counting: true }]);
  assert.equal((await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id })).status, 409, 'no yes before it is counted');
  await run(ws);
  const FIRST = { audience: fake.id, name: 'Sample Campaign', unsubscribed: 2, cleaned: 1, counted_at: 'when', counting: false };
  const q = await stateOf(staff, list.id, true);
  assert.deepEqual([asked(q.first), q.sync, q.counts], [FIRST, null, { subscribed: 5, everyone: 5 }], 'nobody turned off, nothing sent');
  assert.deepEqual([fake.tagged(TAG), writes()], [null, []]);
  // Tapped again: counted afresh before the question is answered, and still nothing goes.
  r = ok(await staff.action('mailchimp.push', { list_id: list.id }));
  assert.deepEqual([asked(r.first), (await run(ws)).ran], [{ ...FIRST, counting: true }, 1]);
  assert.deepEqual([asked((await stateOf(staff, list.id)).first), fake.tagged(TAG)], [FIRST, null]);
  // "Turn their email off here": the yes, for this audience and what it showed — and the list goes.
  r = ok(await staff.action('mailchimp.push', { list_id: list.id, agree: fake.id, shown: { unsubscribed: 2, cleaned: 1 } }));
  assert.equal(r.sync.status, 'queued');
  await run(ws);
  const yes = (await logged(mgr)).filter((e) => e.entity_type === 'mailchimp' && e.payload.first_pull);
  assert.deepEqual(yes.map((e) => [e.action, e.payload, Boolean(e.actor_id)]), [['mailchimp.push', { first_pull: 'yes', audience: fake.id, name: 'Sample Campaign', unsubscribed: 2, cleaned: 1 }, true]]);
  // Three go — and the list's own answer says why: what this sync's pull turned off here, all of it
  // (Fay is not on the list: her email is off here now all the same).
  let s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.added, s.tagged, s.skipped], ['synced', 3, 3, 3, 0]);
  assert.deepEqual([s.pulled_unsubscribed, s.pulled_cleaned], [2, 1]);
  assert.equal(ok(await mgr.get('/api/mailchimp')).pull_note, '2 unsubscribed · 1 dead address', 'the same as Settings → Services says');
  assert.equal(ok(await mgr.get('/api/subscriptions')).emailable, 3);
  // While one is on its way the numbers are the new sync's, from nothing…
  ok(await staff.action('mailchimp.push', { list_id: list.id }));
  s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([s.status, s.pulled_unsubscribed, s.pulled_cleaned], ['queued', 0, 0]);
  // …and the next sync's pull finds nothing new, and says nothing.
  await run(ws);
  s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.pulled_unsubscribed, s.pulled_cleaned], ['synced', 3, 0, 0]);
  // Someone leaves in Mailchimp and its webhook never arrives: the next sync finds one.
  await fake.unsubscribe(mail('cal'), { send: false });
  await push(staff, ws, list.id);
  s = (await stateOf(staff, list.id)).sync;
  assert.deepEqual([s.status, s.total, s.removed, s.pulled_unsubscribed, s.pulled_cleaned], ['synced', 2, 1, 1, 0]);
});

test('one address Mailchimp will not change never holds up the others; Settings → Services says who is waiting, and why', async () => {
  const { c, ws } = await campaign('Held');
  const names = ['ana', 'ben', 'cal', 'dee'];
  for (const w of names) await person(c, w);
  await subscribe(c, ...names);
  const list = await membersList(c);
  await push(c, ws, list.id);
  assert.deepEqual(names.map((w) => fake.member(mail(w)).status), ['subscribed', 'subscribed', 'subscribed', 'subscribed']);
  const waitingJob = async () => (await db.query("select status, attempts, payload from jobs where workspace_id = $1 and kind = 'mailchimp.optout' order by created_at desc limit 1", [ws])).rows
    .map((j) => [j.status, j.attempts, (typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload).emails])[0];

  // Four people say no here in one go; Mailchimp will not change Ben just now.
  fake.lock(mail('ben'), 'Ben’s record is being looked at.');
  await enqueueJob(db, { workspaceId: ws, kind: 'mailchimp.optout', payload: { emails: names.map(mail) } });
  fake.calls.length = 0;
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 0, failed: 1 });
  assert.deepEqual(names.map((w) => fake.member(mail(w)).status), ['unsubscribed', 'subscribed', 'unsubscribed', 'unsubscribed'], 'the others were told');
  assert.deepEqual(await waitingJob(), ['pending', 1, [mail('ben')]], 'only Ben is still to tell');
  let st = ok(await c.get('/api/mailchimp'));
  assert.deepEqual([st.waiting, st.waiting_note], [1, 'Mailchimp said: Ben’s record is being looked at.']);
  keysAreTrue();
  // Tried again: one read and one try about Ben, nothing about anyone else.
  await db.query("update jobs set run_at = now() where workspace_id = $1 and kind = 'mailchimp.optout' and status = 'pending'", [ws]);
  fake.calls.length = 0;
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 0, failed: 1 });
  assert.deepEqual(fake.calls.map((x) => x.method), ['GET', 'PATCH']);
  // Mailchimp lets go of him. Pull now sends it again at once — it does not wait for the job's own next try.
  fake.lock(mail('ben'), false);
  ok(await c.action('mailchimp.pull', {}));
  assert.equal((await run(ws)).failed, 0);
  assert.equal(fake.member(mail('ben')).status, 'unsubscribed');
  st = ok(await c.get('/api/mailchimp'));
  assert.deepEqual([st.waiting, st.waiting_note], [0, null]);

  // Mailchimp not answering at all is another matter: nobody is asked about one by one, everyone waits.
  for (const w of ['eli', 'fay']) { await person(c, w); await subscribe(c, w); }
  await push(c, ws, list.id);
  await enqueueJob(db, { workspaceId: ws, kind: 'mailchimp.optout', payload: { emails: [mail('eli'), mail('fay')] } });
  fake.fail(503);
  fake.calls.length = 0;
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 0, failed: 1 });
  assert.equal(fake.calls.length, 1, 'one call found Mailchimp down; the rest were not tried');
  assert.deepEqual(await waitingJob(), ['pending', 1, [mail('eli'), mail('fay')]]);
  st = ok(await c.get('/api/mailchimp'));
  assert.equal(st.waiting, 2);
  assert.match(st.waiting_note, /^Mailchimp said: /);
  fake.fail(false);
});

test('Settings → Services: the Mailchimp row, Check and Connect — and who may do what', async () => {
  const { c: mgr, ws } = await campaign('Services', { asks: true });
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
  assert.deepEqual((await stateOf(staff, list.id)), { on: false, running: false, sync: null, first: null });
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
  // The honest line, in a manager's words (INTEGRATIONS.md says why: built against Mailchimp's published API).
  assert.equal(row.detail, 'Press Check before relying on it: it tries your own Mailchimp account.');
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
  // A staff member's Send is told who chooses, and where — never a setting's name they cannot change.
  r = await staff.action('mailchimp.push', { list_id: list.id });
  assert.deepEqual([r.status, r.json.error], [409, 'Mailchimp has 2 audiences and none is chosen for base.win — a manager chooses one (Settings → Services → Mailchimp → Check names them)']);
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
  const pending = (await pullJobs(ws)).filter((j) => j.status === 'pending');
  assert.deepEqual([pending.filter((j) => j.key).length, pending.filter((j) => !j.key).length], [3, 1], 'the daily pull starts with it, and the first pull is counted at once');
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
  assert.deepEqual(writes().map((x) => x.method), ['POST', 'DELETE'], 'the new one is made before the old one goes');
  keysAreTrue();
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
  // A volunteer granted People works in that area, and still can't send a list to Mailchimp — only the
  // desk can, as only the desk can download it.
  const volId = ok(await mgr.get('/api/members')).members.find((m) => m.role === 'volunteer').id;
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: ['people'], deny: [] }));
  r = await vol.action('mailchimp.push', { list_id: list.id });
  assert.deepEqual([r.status, (await vol.get(`/api/lists/${list.id}/export.csv`)).status], [403, 403], JSON.stringify(r.json));
  assert.equal((await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'mailchimp.sync'", [ws])).rows[0].n, 0, 'nothing was started');
  assert.equal((await staff.post('/api/connections/check', { key: 'mailchimp' })).status, 403);
  // Nobody on file left that audience: a send counts first, then goes on with what it was shown.
  assert.equal((await staff.action('mailchimp.push', { list_id: list.id })).status, 200);
  await run(ws);
  assert.equal((await mgr.action('mailchimp.push', { list_id: '11111111-1111-4111-8111-111111111111' })).status, 404);
  const nobody = { agree: fake.id, shown: { unsubscribed: 0, cleaned: 0 } };
  ok(await staff.action('mailchimp.push', { list_id: list.id, ...nobody }));
  // Sent twice while the first is still on its way: one job, not two.
  ok(await staff.action('mailchimp.push', { list_id: list.id, ...nobody }));
  assert.equal((await db.query("select count(*)::int as n from jobs where workspace_id = $1 and kind = 'mailchimp.sync' and status = 'pending'", [ws])).rows[0].n, 1);
  await run(ws);
  const st = await stateOf(staff, list.id);
  assert.deepEqual([st.sync.status, st.sync.by], ['synced', 'Sam Example']);

  // Never the key, never the address's last part, in any answer or on the log.
  const said = JSON.stringify([answers, await rowOf(), ok(await mgr.get('/api/connections')), st, ok(await mgr.get('/api/mailchimp')), await logged(mgr)]);
  assert.ok(!said.includes(KEY) && !said.includes(pathKey()), 'no key and no webhook address in what base.win says');
  assert.ok(!JSON.stringify(await logged(mgr)).includes('mc-shown-once'), 'the signing secret is shown once, never kept');
});
