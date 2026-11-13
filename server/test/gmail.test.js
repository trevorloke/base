// Gmail (ext/gmail): one email, written by one staff member, to one person,
// from their own Gmail — one purpose on GSI's Google connection — and Email
// as a way someone was reached, logged by hand. Every Google call goes to
// server/test/fake-google.js (GMAIL_API_BASE and GSI's test addresses).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';
import { ACTIONS } from '../actions/index.js';
import { areaOfAction, areaOfPath, mayRun } from '../lib/perms.js';
import { enqueueJob, runDueJobs } from '../lib/jobs.js';
import { definePurpose, purposeOf } from '../lib/google/purposes.js';
import { _resetPausesForTest, _setTokenTimeoutForTest, tokenPaused } from '../lib/google/flow.js';
import { _resetTokensForTest } from '../lib/google/tokens.js';
import { _resetGmailForTest, _setGmailTimeoutForTest, sendUrl } from '../ext/gmail/send.js';
import { _resetLimiterForTest } from '../ext/gmail/actions.js';
import { forViewer } from '../lib/viewer.js';
import { acct, join, restoreEnv, signup, startGoogle, tag } from './google-helpers.js';

const GMAIL = 'https://www.googleapis.com/auth/gmail.send';
definePurpose('test.gmailother', { label: 'Test other', scopes: ['https://www.googleapis.com/auth/test.gmailother'], roles: ['manager', 'staff'], area: null });

const A = Array.from({ length: 16 }, (_, i) => acct(i + 1, { name: `Gm${i + 1} Example` }));
let fake, db, M, S, T, V, X, M2;
const P = {};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const mail = (who) => `${who}.gm.${tag}@example.org`;
const connect = (b, sub, purpose = 'gmail.send') => b.google(fake, { do: 'connect', for: purpose, app: 'desk', back: '/profile' }, sub);
const send = (who, person, extra = {}) => who.b.action('gmail.send', {
  person_id: person.id, subject: 'Hello', body: 'A few lines.', client_key: randomUUID(), ...extra,
});
const row = async (id) => (await db.query('select * from gmail_sends where id = $1', [id])).rows[0];
const grant = async (userId) => (await db.query('select * from google_grants where user_id = $1', [userId])).rows[0];
const reset = () => { _resetPausesForTest(); _resetTokensForTest(); _resetGmailForTest(); };
// A staff member of their own, connected for Gmail with account n.
let nextAcct = 4;
const staffer = async (label) => {
  const u = await join(M.b, mail(label), 'staff', `${label} Example`);
  const n = nextAcct++;
  assert.equal((await connect(u.b, A[n].sub)).google, 'connected');
  return { ...u, acct: A[n] };
};
const person = async (key, name, extra = {}) => { P[key] = ok(await M.b.action('person.create', { name, ...extra })).person; return P[key]; };

before(async () => {
  db = await freshDb();
  fake = await startGoogle(A);
  process.env.GMAIL_API_BASE = fake.base;
  _setGmailTimeoutForTest(400);
  M = await signup(`Gmail Campaign ${tag}`, mail('mo'));
  S = await join(M.b, mail('sam'), 'staff', 'Sam Example');
  T = await join(M.b, mail('tia'), 'staff', 'Tia Example');
  V = await join(M.b, mail('vic'), 'volunteer', 'Vic Example');
  X = await join(M.b, mail('xan'), 'staff', 'Xan Example'); // denied Outreach below
  M2 = await signup(`Gmail Other ${tag}`, mail('mo2'));
  await person('jane', 'Jane Example', { email: mail('jane') });
  await person('dee', 'Dee Example', { email: mail('dee'), tags: ['do-not-email'] });
  await person('eli', 'Eli Example', { email: mail('eli'), tags: ['Do-Not-Contact'] });
  await person('sue', 'Sue Example', { email: mail('sue') });
  await person('cy', 'Cy Example', { email: mail('cy') });
  await person('noa', 'Noa Example', {});
  ok(await M.b.action('subscription.add', { email: mail('cy') }));
  const sub = (await db.query('select id from subscriptions where workspace_id = $1 and email = $2', [M.ws, mail('cy')])).rows[0];
  ok(await M.b.action('subscription.remove', { id: sub.id }));
  await db.query(`insert into email_suppressions (id, workspace_id, email, reason, source) values ($1, $2, $3, 'bounce', 'test')`, [randomUUID(), M.ws, mail('sue')]);
});
beforeEach(() => {
  fake.clearKnobs(); fake.resetCounts(); reset(); _setTokenTimeoutForTest(8000);
  for (const u of [S, T, X].filter(Boolean)) _resetLimiterForTest(u.id);
});
after(async () => { _setTokenTimeoutForTest(8000); _setGmailTimeoutForTest(10_000); delete process.env.GMAIL_API_BASE; await fake.close(); restoreEnv(); });

test('boot: GSI’s google_grants as built; contacts may be reached by email; gmail_sends refers to no google_* table', async () => {
  const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'google_grants'`)).rows.map((r) => r.column_name);
  for (const c of ['purposes', 'refresh_sealed', 'state', 'paused_until']) assert.ok(cols.includes(c), c);
  assert.ok(!cols.includes('holder'));
  const def = (await db.query(`select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_channel_check'`)).rows[0].d;
  for (const ch of ['door', 'phone', 'text', 'in_person', 'mainstreet', 'email']) assert.ok(def.includes(`'${ch}'`), ch);
  const refs = (await db.query(`select confrelid::regclass::text as t from pg_constraint where conrelid = 'gmail_sends'::regclass and contype = 'f'`)).rows.map((r) => r.t);
  assert.deepEqual(refs, ['users']);
});

test('setup: without GSI’s connections nothing turns on; the Gmail row says so with no settings of its own; no test address in production', async () => {
  const key = process.env.GOOGLE_TOKEN_KEY;
  delete process.env.GOOGLE_TOKEN_KEY;
  try {
    assert.equal(ok(await M.b.get('/api/gmail')).setup, false);
    const r = await M.b.action('gmail.settings', { on: true, review: 'unreviewed' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'Set up Google first — Settings → Services → Google');
    const row = ok(await M.b.get('/api/connections')).services.find((s) => s.key === 'gmail');
    assert.equal(row.state, 'missing');
    assert.equal(row.checkable, false);
    assert.equal(row.panel, 'gmail');
    assert.deepEqual([row.missing, row.set], [[], []]);
    assert.match(row.detail, /Set up the Google row first/);
  } finally {
    process.env.GOOGLE_TOKEN_KEY = key;
  }
  const r = await M.b.action('gmail.settings', { on: true });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Say how Google is set up for base.win');
  const row = ok(await M.b.get('/api/connections')).services.find((s) => s.key === 'gmail');
  assert.equal(row.state, 'default');
  assert.match(row.detail, /^Off · test address in use \(GMAIL_API_BASE\)$/);
  const on = ok(await M.b.action('gmail.settings', { on: true, review: 'unreviewed' }));
  assert.deepEqual([on.on, on.review], [true, 'unreviewed']);
  assert.deepEqual(ok(await M.b.get('/api/gmail')).review, 'unreviewed');
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.GMAIL_API_BASE = 'http://127.0.0.1:1';
  try {
    assert.equal(sendUrl(), 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  } finally {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
    process.env.GMAIL_API_BASE = fake.base;
  }
  assert.equal(sendUrl(), `${fake.base}/gmail/v1/users/me/messages/send`);
});

test('purpose: exactly the one scope; GSI’s connect asks for openid, email and gmail.send; volunteers and staff denied Outreach can’t connect', async () => {
  const p = purposeOf('gmail.send');
  assert.deepEqual(p.scopes, [GMAIL]);
  assert.deepEqual([p.roles, p.area, p.label], [['manager', 'treasurer', 'staff'], 'outreach', 'Send from your Gmail']);
  const r = await connect(S.b, A[0].sub);
  assert.equal(r.google, 'connected');
  assert.equal(new URL(r.at).searchParams.get('scope'), `openid email ${GMAIL}`);
  assert.equal((await connect(T.b, A[1].sub)).google, 'connected');
  assert.equal((await connect(V.b, A[2].sub)).google, 'not-allowed');
  ok(await M.b.action('permission.member.set', { user_id: X.id, grant: [], deny: ['outreach'] }));
  assert.equal((await connect(X.b, A[3].sub)).google, 'not-allowed');
});

test('send: one message from their Gmail, as typed; the row sent; the log holds no words; History says so; a replay sends nothing', async () => {
  const key = randomUUID();
  const r = ok(await send(S, P.jane, { subject: 'Café on Saturday ☕', body: 'Hi Jane,\nSee you there.\n— Sam', client_key: key }));
  assert.equal(r.status, 'sent');
  assert.equal(fake.gmailSent.length, 1);
  const m = fake.gmailSent[0];
  assert.equal(m.headers.from, `"Sam Example" <${A[0].email}>`);
  assert.equal(m.headers.to, `<${mail('jane')}>`);
  assert.equal(m.headers.subject, `=?UTF-8?B?${Buffer.from('Café on Saturday ☕').toString('base64')}?=`);
  assert.equal(m.headers['content-type'], 'text/plain; charset=UTF-8');
  assert.ok(!('list-unsubscribe' in m.headers));
  assert.equal(m.body, 'Hi Jane,\r\nSee you there.\r\n— Sam');
  assert.ok(!/<img|https?:\/\//i.test(m.raw), 'no pixel, no tracked link');
  const sent = await row(r.id);
  assert.deepEqual([sent.status, sent.kind, sent.gmail_id, sent.from_email, sent.to_email], ['sent', 'person', m.id, A[0].email, mail('jane')]);
  const ev = (await db.query(`select action, op, payload from events where workspace_id = $1 and entity_type = 'gmail_send' and entity_id = $2 order by seq`, [M.ws, r.id])).rows;
  assert.deepEqual(ev.map((e) => [e.action, e.op, e.payload]), [
    ['gmail.send', 'create', { person_id: P.jane.id, status: 'sending' }],
    ['gmail.result', 'update', { status: 'sent' }],
  ]);
  const all = JSON.stringify((await db.query('select payload from events where workspace_id = $1', [M.ws])).rows);
  for (const word of ['Café on Saturday', 'See you there', A[0].email]) assert.ok(!all.includes(word), word);
  const job = (await db.query(`select run_at > now() + interval '14 minutes' as later from jobs where workspace_id = $1 and key = $2`, [M.ws, `gmail-settle-${r.id}`])).rows[0];
  assert.equal(job.later, true, 'its settle job, 15 minutes out');
  const h = ok(await M.b.get(`/api/persons/${P.jane.id}/timeline`));
  const e = h.entries.find((x) => x.id === `gmail:${r.id}`);
  assert.deepEqual([e.label, e.title, e.by, e.group], ['Email', 'Sent from Gmail', 'Sam Example', 'messages']);
  assert.match(e.detail, /^Café on Saturday ☕ · Hi Jane, See you there\. — Sam$/);
  // The same send again: its row, and nothing sent.
  const again = ok(await send(S, P.jane, { client_key: key }));
  assert.deepEqual([again.id, again.status, again.duplicate], [r.id, 'sent', true]);
  assert.equal(fake.counts.gmail, 1);
  assert.equal(fake.gmailSent.length, 1);
  // A Gmail send logs no contact.
  assert.equal((await db.query('select count(*)::int as n from contacts where workspace_id = $1 and person_id = $2', [M.ws, P.jane.id])).rows[0].n, 0);
});

test('one bare address: a list, a name with brackets or a line break in the stored email is refused before any call', async () => {
  for (const bad of [`a.${tag}@b.co,c@d.co`, `"x" <a.${tag}@b.co>`, `a.${tag}@b.co\nBcc: x@d.co`, 'a@b', '@b.co', 'a@@b.co']) {
    await db.query('update persons set email = $2 where id = $1', [P.noa.id, bad]);
    const r = await send(S, P.noa);
    assert.equal(r.status, 409, bad);
    assert.equal(r.json.error, 'That email address isn’t valid — fix it under Edit');
  }
  await db.query('update persons set email = null where id = $1', [P.noa.id]);
  const r = await send(S, P.noa);
  assert.deepEqual([r.status, r.json.error], [409, 'No email on file']);
  assert.equal(fake.counts.gmail, 0);
  assert.equal(fake.counts.refresh, 0);
});

test('reach: do-not-email, do-not-contact (capitals) and a bounced address refuse with their words; leaving the newsletter doesn’t', async () => {
  for (const [p, words] of [[P.dee, 'They asked not to be emailed'], [P.eli, 'They asked not to be contacted'], [P.sue, 'That address bounced or reported spam — check it under Edit']]) {
    const r = await send(S, p);
    assert.deepEqual([r.status, r.json.error], [409, words]);
  }
  assert.equal(fake.counts.gmail, 0);
  assert.equal(ok(await send(S, P.cy)).status, 'sent');
  assert.equal(fake.counts.gmail, 1);
});

test('no answer in time: Not sure it went, asked once, never again', async () => {
  fake.next('gmail', 'hang');
  const r = ok(await send(S, P.jane));
  assert.deepEqual([r.status, r.said], ['unsure', 'Not sure it went — check your Gmail’s Sent folder before sending again.']);
  assert.equal(fake.counts.gmail, 1);
  assert.equal((await row(r.id)).status, 'unsure');
  // Google's pause for no answer: the next is refused before asking, and says nothing went.
  const next = ok(await send(S, P.jane));
  assert.deepEqual([next.status, next.said], ['failed', 'Google isn’t answering — nothing was sent. Try again in a minute.']);
  assert.equal(fake.counts.gmail, 1);
  fake.next('gmail', '500');
  reset();
  assert.equal(ok(await send(S, P.jane)).status, 'unsure', 'a 5xx may have gone too');
  assert.equal(fake.counts.gmail, 2, 'never retried');
});

test('a stale token: 401 then 200 is sent, once; 401 twice needs connecting again, and the next send is refused before any call', async () => {
  fake.next('gmail', '401');
  const r = ok(await send(S, P.jane));
  assert.equal(r.status, 'sent');
  assert.equal(fake.counts.gmail, 2);
  assert.equal(fake.gmailSent.length, 1);
  const U = await staffer('una');
  fake.resetCounts();
  fake.next('gmail', '401'); fake.next('gmail', '401');
  const bad = ok(await send(U, P.jane));
  assert.deepEqual([bad.status, bad.said, bad.code], ['failed', 'Gmail needs connecting again — Your profile', 'reconnect']);
  assert.equal((await grant(U.id)).state, 'reconnect');
  fake.resetCounts();
  const next = await send(U, P.jane);
  assert.equal(next.status, 409);
  assert.match(next.json.error, /^Gmail needs connecting again — Your profile/);
  assert.equal(fake.counts.gmail + fake.counts.refresh, 0);
  assert.equal(ok(await U.b.get('/api/gmail')).me.trouble, 'reconnect');
});

test('the token endpoint silent: nothing was sent, no send call; invalid_client: GSI’s pause, no send call', async () => {
  _setTokenTimeoutForTest(300);
  fake.next('refresh', 'slow');
  const r = ok(await send(T, P.jane));
  assert.deepEqual([r.status, r.said], ['failed', 'Google isn’t answering — nothing was sent. Try again in a minute.']);
  assert.equal(fake.counts.gmail, 0);
  reset();
  fake.resetCounts();
  fake.next('refresh', 'invalid_client');
  const c = ok(await send(T, P.jane));
  assert.deepEqual([c.status, c.said], ['failed', 'Gmail isn’t working on this server — tell your campaign manager.']);
  assert.equal(tokenPaused()?.code, 'client');
  assert.equal(fake.counts.gmail, 0);
  const next = await send(T, P.jane);
  assert.deepEqual([next.status, next.json.error], [503, 'Gmail isn’t working on this server — tell your campaign manager.']);
});

test('Gmail’s limits pause this grant only (an hour for a day’s limit); another staff member can still send', async () => {
  const U = await staffer('ula');
  // Every limit with no Retry-After waits an hour: GSI's googleFetch applies
  // Gmail's quotaPauseMs to each of them.
  const cases = [['rateLimitExceeded', {}, 3600], ['429', { retryAfter: 120 }, 120], ['dailyLimitExceeded', {}, 3600]];
  for (const [kind, opts, secs] of cases) {
    await db.query('update google_grants set paused_until = null where user_id = $1', [U.id]);
    reset();
    fake.resetCounts();
    fake.next('gmail', kind, opts);
    const r = ok(await send(U, P.jane));
    assert.equal(r.status, 'failed', kind);
    assert.match(r.said, /^Gmail asked us to wait\. Try after \d{1,2}:\d{2} [ap]m\.$/, kind);
    const left = (new Date((await grant(U.id)).paused_until).getTime() - Date.now()) / 1000;
    assert.ok(left > secs - 15 && left <= secs, `${kind}: ${left}`);
    const again = await send(U, P.jane);
    assert.equal(again.status, 429, kind);
    assert.match(again.json.error, /^Gmail asked us to wait — try after /);
    assert.equal(fake.counts.gmail, 1, kind);
    const me = ok(await U.b.get('/api/gmail')).me;
    assert.equal(me.trouble, 'paused');
    // The same hour the refusal named, on the campaign's clock (not the device's).
    assert.equal(`Gmail asked us to wait. Try after ${me.pausedClock}.`, r.said, kind);
    assert.equal(ok(await send(S, P.jane)).status, 'sent', `${kind}: Sam still sends`);
  }
});

test('the Gmail API off in Google Cloud: every send on the server waits 60 s with no call, one log line, and Services says so', async () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    fake.next('gmail', 'accessNotConfigured');
    const r = ok(await send(S, P.jane));
    assert.deepEqual([r.status, r.said], ['failed', 'Gmail isn’t working on this server — tell your campaign manager.']);
    for (const who of [S, T]) {
      const n = await send(who, P.jane);
      assert.deepEqual([n.status, n.json.error], [503, 'Gmail isn’t working on this server — tell your campaign manager.']);
      assert.equal((await who.b.action('gmail.test')).status, 503);
    }
    assert.equal(fake.counts.gmail, 1);
    assert.deepEqual(warned.filter((w) => w.startsWith('gmail:')), ['gmail: Gmail API is off in Google Cloud — no sends for 60 s']);
    const row = ok(await M.b.get('/api/connections')).services.find((s) => s.key === 'gmail');
    assert.match(row.detail, /Gmail API is off in Google Cloud — turn it on \(step 1 of the Gmail steps in GOING-LIVE\), then Check on the Google row/);
    assert.ok(ok(await M.b.get('/api/gmail')).apiOff);
  } finally {
    console.warn = warn;
  }
});

test('other refusals: Google’s own words; a scope taken away needs connecting again', async () => {
  fake.next('gmail', 'invalidArgument');
  const r = ok(await send(S, P.jane));
  assert.deepEqual([r.status, r.said], ['failed', 'Gmail didn’t send it: Invalid To header']);
  const U = await staffer('uma');
  fake.next('gmail', 'insufficientPermissions');
  const s = ok(await send(U, P.jane));
  assert.deepEqual([s.status, s.said], ['failed', 'Gmail needs connecting again — Your profile']);
  assert.equal((await grant(U.id)).state, 'reconnect');
});

test('the settle job: a send still going 15 minutes on is Not sure it went; a sent one is left alone', async () => {
  const mk = async (status) => {
    const id = randomUUID();
    await db.query(
      `insert into gmail_sends (id, workspace_id, person_id, user_id, client_key, to_email, from_email, subject, body, status)
       values ($1, $2, $3, $4, $5, 'a@example.org', 'b@example.org', 'S', 'B', $6)`,
      [id, M.ws, P.jane.id, S.id, randomUUID(), status],
    );
    await db.transaction((tx) => enqueueJob(tx, { workspaceId: M.ws, kind: 'gmail.settle', runAt: new Date(Date.now() - 1000).toISOString(), payload: { id }, key: `gmail-settle-${id}` }));
    return id;
  };
  const going = await mk('sending');
  const sent = await mk('sent');
  await runDueJobs(db, { workspaceId: M.ws });
  const g = await row(going);
  assert.deepEqual([g.status, g.said], ['unsure', 'base.win lost track of this send']);
  assert.equal((await row(sent)).status, 'sent');
  const ev = (await db.query(`select action, payload, actor_id from events where workspace_id = $1 and entity_id = $2`, [M.ws, going])).rows;
  assert.deepEqual(ev.map((e) => [e.action, e.payload, e.actor_id]), [['gmail.settle', { status: 'unsure' }, S.id]]);
  await db.query('delete from gmail_sends where id = any($1::uuid[])', [[going, sent]]);
});

test('the cap: the 101st in 24 hours is refused, counted across campaigns; a test send counts and never shows in History', async () => {
  const U = await staffer('cap');
  const fill = async (ws, n, person) => {
    for (let i = 0; i < n; i += 1) {
      await db.query(
        `insert into gmail_sends (id, workspace_id, kind, person_id, user_id, client_key, to_email, from_email, subject, body, status)
         values ($1, $2, $3, $4, $5, $6, 'a@example.org', 'b@example.org', 'S', 'B', 'sent')`,
        [randomUUID(), ws, person ? 'person' : 'test', person, U.id, randomUUID()],
      );
    }
  };
  await fill(M.ws, 60, P.cy.id);
  await fill(M2.ws, 39, null); // another campaign on this server
  // Failed sends don't count.
  await db.query(`update gmail_sends set status = 'failed' where id = (select id from gmail_sends where user_id = $1 limit 1)`, [U.id]);
  assert.equal(ok(await U.b.get('/api/gmail')).me.sentToday, 98);
  const t = ok(await U.b.action('gmail.test'));
  assert.equal(t.status, 'sent');
  assert.equal(fake.gmailSent.at(-1).headers.to, `<${U.acct.email}>`);
  assert.equal((await row(t.id)).kind, 'test');
  assert.equal(ok(await send(U, P.jane)).status, 'sent', 'the 100th');
  const r = await send(U, P.jane);
  assert.deepEqual([r.status, r.json.error], [429, 'You’ve sent 100 from Gmail today — try tomorrow, or use Outreach → Email']);
  const h = ok(await M.b.get(`/api/persons/${P.cy.id}/timeline`));
  assert.ok(!h.entries.some((e) => e.id === `gmail:${t.id}`));
  await db.query('delete from gmail_sends where user_id = $1', [U.id]);
});

test('roles and areas: volunteers and staff denied Outreach get 403; only managers (or Admin) change the switch; switch off is 409', async () => {
  for (const [path, area] of [['/api/gmail', 'outreach']]) assert.equal(areaOfPath(path), area);
  assert.equal(areaOfAction('gmail.send'), 'outreach');
  assert.equal(areaOfAction('gmail.test'), 'outreach');
  const ctx = (role, grant = [], deny = []) => ({ role, perms: { grant: new Set(grant), deny: new Set(deny) } });
  assert.equal(mayRun(ctx('staff', ['outreach']), 'gmail.settings', ACTIONS['gmail.settings']), false, 'Outreach isn’t enough: Admin');
  assert.equal(mayRun(ctx('staff', ['admin']), 'gmail.settings', ACTIONS['gmail.settings']), true);
  assert.equal(mayRun(ctx('staff', [], ['outreach']), 'gmail.send', ACTIONS['gmail.send']), false);
  ok(await M.b.action('permission.member.set', { user_id: X.id, grant: [], deny: ['outreach'] }));
  for (const who of [V, X]) {
    assert.equal((await send(who, P.jane)).status, 403);
    assert.equal((await who.b.action('gmail.test')).status, 403);
    assert.equal((await who.b.get('/api/gmail')).status, 403);
  }
  assert.equal((await S.b.action('gmail.settings', { on: false })).status, 403);
  ok(await M.b.action('permission.member.set', { user_id: T.id, grant: ['outreach'], deny: [] }));
  assert.equal((await T.b.action('gmail.settings', { on: false })).status, 403);
  ok(await M.b.action('permission.member.set', { user_id: T.id, grant: ['admin'], deny: [] }));
  assert.deepEqual(ok(await T.b.action('gmail.settings', { on: false })).on, false);
  const off = await send(S, P.jane);
  assert.deepEqual([off.status, off.json.error], [409, 'Sending from Gmail is off for this campaign']);
  assert.equal(ok(await S.b.get('/api/gmail')).me.trouble, 'off');
  ok(await M.b.action('gmail.settings', { on: true }));
  ok(await M.b.action('permission.member.set', { user_id: T.id, grant: [], deny: [] }));
  // What managers see: who connected.
  const g = ok(await M.b.get('/api/gmail'));
  assert.ok(g.people.some((p) => p.name === 'Sam Example' && p.email === A[0].email));
  assert.ok(!('people' in ok(await S.b.get('/api/gmail'))));
  // Staff denied Outreach: GSI's connections follow the team, so Gmail
  // goes from their grant at once (here their only purpose: the grant goes).
  const W = await staffer('wes');
  ok(await M.b.action('permission.member.set', { user_id: W.id, grant: [], deny: ['outreach'] }));
  assert.equal(await grant(W.id), undefined);
  // GSI's disconnect has no area: a staff member denied Outreach can still
  // run it (here nothing is left to let go).
  assert.equal(mayRun(ctx('staff', [], ['outreach']), 'google.disconnect', ACTIONS['google.disconnect']), true);
});

test('disconnect: Gmail goes from a grant that holds another purpose (no revoke); the last one revokes once', async () => {
  const U = await staffer('dis');
  assert.equal((await connect(U.b, U.acct.sub, 'test.gmailother')).google, 'connected');
  await runDueJobs(db, { workspaceId: M.ws });
  fake.resetCounts();
  const d = ok(await U.b.action('google.disconnect', { purpose: 'gmail.send' }));
  assert.equal(d.still_at_google, true);
  await runDueJobs(db, { workspaceId: M.ws });
  assert.equal(fake.counts.revoke, 0);
  const r = await send(U, P.jane);
  assert.deepEqual([r.status, r.json.error], [409, 'Connect your Gmail first — Your profile']);
  assert.equal(ok(await U.b.get('/api/gmail')).me.connected, false);
  ok(await U.b.action('google.disconnect', { purpose: 'test.gmailother' }));
  await runDueJobs(db, { workspaceId: M.ws });
  assert.equal(fake.counts.revoke, 1);
});

test('logging email by hand: desk only, Talked · No answer · Refused, never refused for reach, once through the outbox; door and call counts unchanged', async () => {
  const brief = async () => ok(await M.b.get('/api/brief')).field;
  const was = await brief();
  const id = randomUUID();
  const log = (who, extra) => who.b.action('contact.log', { person_id: P.dee.id, channel: 'email', outcome: 'contacted', ...extra });
  ok(await log(S, { client_id: id }));
  const dup = ok(await log(S, { client_id: id }));
  assert.equal(dup.duplicate, true);
  ok(await log(S, { outcome: 'no_answer' }));
  ok(await log(M, { outcome: 'refused', person_id: P.eli.id }));
  for (const outcome of ['moved', 'inaccessible', 'left_lit', 'left_message']) {
    const r = await log(S, { outcome });
    assert.deepEqual([r.status, r.json.error], [400, 'That outcome isn’t for email'], outcome);
  }
  const v = await log(V, {});
  assert.deepEqual([v.status, v.json.error], [403, 'Email is logged at the desk']);
  const n = (await db.query(`select count(*)::int as n from contacts where workspace_id = $1 and channel = 'email'`, [M.ws])).rows[0].n;
  assert.equal(n, 3, 'one per log, the replay once');
  const now = await brief();
  assert.deepEqual([now.doors, now.calls, now.texts], [was.doors, was.calls, was.texts], 'Today’s doors, calls and texts don’t count email');
  assert.equal(now.week, was.week + 3, 'the week’s contacts count every contact, email too');
  const rep = ok(await M.b.get('/api/reports')).reports.contacts;
  const { head } = rep;
  const last = rep.rows.at(-1);
  assert.equal(last[head.indexOf('Doors')], 0);
  assert.equal(last[head.indexOf('Calls')], 0);
  assert.ok(last[head.indexOf('Reached')] >= 1, 'Reached counts every channel, email too');
  const h = ok(await M.b.get(`/api/persons/${P.dee.id}/timeline`));
  assert.ok(h.entries.some((e) => e.kind === 'email' && e.label === 'Email' && e.title === 'Talked'));
});

test('the person read: email_why for the desk; none at all for a volunteer', async () => {
  const why = async (who, p) => ok(await who.b.get(`/api/persons/${p.id}`)).person;
  assert.equal((await why(S, P.jane)).email_why, null);
  assert.equal((await why(S, P.dee)).email_why, 'do_not_email');
  assert.equal((await why(M, P.eli)).email_why, 'do_not_contact');
  assert.equal((await why(S, P.sue)).email_why, 'suppressed');
  assert.equal((await why(S, P.cy)).email_why, null, 'leaving the newsletter isn’t a no');
  await db.query('update persons set email = null where id = $1', [P.noa.id]);
  assert.equal((await why(S, P.noa)).email_why, 'no_email');
  // Any other path that hands a volunteer a person row drops it too.
  assert.ok(!('email_why' in forViewer({ role: 'volunteer', user: { email: '' } })({ id: 'x', email: 'a@b.co', tags: [], email_why: null })));
  const vp = await V.b.get(`/api/persons/${P.dee.id}`);
  if (vp.status === 200) assert.ok(!('email_why' in vp.json.person));
  else assert.equal(vp.status, 403);
});

test('merging two records moves their Gmail sends (no merge code of Gmail’s)', async () => {
  const a = await person('ma', 'Mia Example', { email: mail('mia') });
  const b = await person('mb', 'Mia Example', { email: mail('mia2') });
  const r = ok(await send(S, b));
  ok(await M.b.action('person.merge', { keep: a.id, drop: b.id }));
  assert.equal((await row(r.id)).person_id, a.id);
});
