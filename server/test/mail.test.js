// Email that hears back (server/ext/mail, server/lib/mail): every email
// carries base.win's own ref and keeps the sender's id; the sender's delivery
// events come in at POST /hooks/mail/:provider — signed over the exact bytes,
// each done once — and a bounce or a spam complaint puts the address on the
// campaign's suppression list, which every "who can be emailed" then honours:
// a list, the newsletter, a row at the moment it is sent, a ladder's email.
// A bounce is about the address (no consent changes); a complaint is also a
// no to email, on the record. The sender is a stand-in (fake-mail.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runDueJobs } from '../lib/jobs.js';
import { startFakeMail } from './fake-mail.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.mail.${tag}@example.org`;
const SECRET = `whsec_${Buffer.from(`mail-test-secret-${tag}`).toString('base64')}`;
const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'SENDGRID_API_KEY', 'SENDGRID_API_BASE',
  'SENDGRID_WEBHOOK_PUBLIC_KEY', 'STARBASE_EMAIL_TIMEOUT_MS', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let db, resend, grid;

const hookTo = (provider) => async (raw, headers) => {
  const r = await app.request(`/hooks/mail/${provider}`, { method: 'POST', headers, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const useResend = () => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: resend.url, RESEND_WEBHOOK_SECRET: SECRET, MAIL_FROM: 'Imagine Surrey <team@example.org>', STARBASE_PUBLIC_URL: 'https://base.example' });
};
const useSendgrid = ({ events = true } = {}) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { MAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'SG.test_key', SENDGRID_API_BASE: grid.url, MAIL_FROM: 'Imagine Surrey <team@example.org>', STARBASE_PUBLIC_URL: 'https://base.example' });
  if (events) process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = grid.publicKey;
};

before(async () => {
  db = await freshDb();
  resend = await startFakeMail({ provider: 'resend', secret: SECRET, deliver: hookTo('resend') });
  grid = await startFakeMail({ provider: 'sendgrid', deliver: hookTo('sendgrid') });
  useResend();
});
after(async () => {
  await resend.close();
  await grid.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// A campaign of its own for each test (they share one database).
const campaign = async (name) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: `${name} ${tag}`, email: mail(`mgr-${name.toLowerCase().replace(/\W+/g, '')}`), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { c, ws: r.json.workspace.id };
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const subscribe = async (c, ...who) => { for (const w of who) ok(await c.action('subscription.add', { email: mail(w), name: `${w} Example` })); };
const rowsOf = async (blastId) => (await db.query('select * from blast_recipients where blast_id = $1 order by email', [blastId])).rows;
const rowOf = async (blastId, who) => (await rowsOf(blastId)).find((r) => r.email === mail(who));
const suppressions = async (ws) => (await db.query('select email, reason, source, detail, lifted_at from email_suppressions where workspace_id = $1 order by email', [ws])).rows;
const consents = async (ws, who) => (await db.query(
  "select granted, source, person_id from consent_events where workspace_id = $1 and channel = 'email' and address = $2 order by created_at", [ws, mail(who)],
)).rows;
const statOf = async (c, id) => ok(await c.get('/api/blasts/stats')).stats.find((s) => s.id === id);
const listed = async (c, id) => ok(await c.get('/api/blasts')).blasts.find((b) => b.id === id);
const logged = async (c) => ok(await c.get('/api/events?since=0&limit=1000')).events;
const seqOf = async (ws) => Number((await db.query('select event_seq from workspaces where id = $1', [ws])).rows[0].event_seq);
const mailEvents = async () => (await db.query('select count(*)::int as n from mail_events')).rows[0].n;
const members = async (c, ...who) => {
  const out = {};
  for (const w of who) out[w] = await c.createPerson(`${w} Example`, { email: mail(w), tags: ['member'] });
  const list = ok(await c.action('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'member' } })).list;
  return { people: out, list };
};
const withEmailOf = async (c, listId) => ok(await c.get('/api/lists')).lists.find((l) => l.id === listId).counts.with_email;

test('every email carries base.win’s own ref, and the sender’s id is kept on the recipient’s row', async () => {
  const { c } = await campaign('Refs');
  await subscribe(c, 'ref-ana', 'ref-ben');
  resend.reset();
  const sent = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'Hello', body: 'Words' }));
  assert.deepEqual(sent.counts, { total: 2, sent: 2, failed: 0, queued: 0 });
  const rows = await rowsOf(sent.blast.id);
  assert.equal(resend.sent.length, 2);
  for (const r of rows) {
    const m = resend.sent.find((x) => x.to === r.email);
    assert.equal(m.ref, r.id, 'the ref is the recipient’s row');
    assert.deepEqual([r.provider, r.provider_id], ['resend', m.id], 'the sender’s id for this email');
    assert.deepEqual([r.delivered_at, r.bounced_at, r.complained_at, r.bounce_detail], [null, null, null, null]);
  }
  // Until the sender says more, the numbers are what they were: what it took.
  const st = await statOf(c, sent.blast.id);
  assert.deepEqual([st.delivered, st.confirmed, st.bounced, st.complained], [2, 0, 0, 0]);
});

test('a bounce suppresses the address — a list’s count, its next send and the newsletter leave it out; no consent changes', async () => {
  const { c, ws } = await campaign('Bounce');
  const { list } = await members(c, 'b-ana', 'b-ben', 'b-cal');
  await subscribe(c, 'b-ana', 'b-ben');
  assert.equal(await withEmailOf(c, list.id), 3);
  resend.reset();
  const first = ok(await c.action('blast.send', { kind: 'eblast', subject: 'AGM', body: 'Saturday', audience: { list_id: list.id } }));
  assert.equal(first.blast.audience_count, 3);
  const ana = await rowOf(first.blast.id, 'b-ana');
  const before = await seqOf(ws);

  const ev = await resend.event('bounced', { ref: ana.id, detail: 'No such mailbox' });
  assert.equal(ev.status, 200, JSON.stringify(ev.body));
  assert.equal(ev.body.received, true);

  assert.deepEqual(await suppressions(ws), [{ email: mail('b-ana'), reason: 'bounce', source: 'resend', detail: 'Permanent / General: No such mailbox', lifted_at: null }]);
  const row = await rowOf(first.blast.id, 'b-ana');
  assert.equal(row.status, 'sent', 'it was sent; it bounced');
  assert.ok(row.bounced_at);
  assert.equal(row.bounce_detail, 'Permanent / General: No such mailbox');
  // On the event log, as the system.
  const mine = (await logged(c)).filter((e) => Number(e.seq) > before);
  assert.deepEqual(mine.map((e) => [e.action, e.entity_type, e.op, e.actor_id]), [
    ['mail.event', 'blast_recipient', 'update', null], ['mail.event', 'email_suppression', 'create', null],
  ]);
  assert.deepEqual(mine[1].payload, { email: mail('b-ana'), reason: 'bounce', source: 'resend' });
  // A bounce is about the address, not a no: still on the newsletter list, no tag, no consent row.
  assert.deepEqual(await consents(ws, 'b-ana'), [{ granted: true, source: 'desk-added', person_id: (await db.query('select id from persons where workspace_id = $1 and lower(email) = $2', [ws, mail('b-ana')])).rows[0].id }]);
  const subs = ok(await c.get('/api/subscriptions'));
  assert.equal(subs.subscriptions.find((s) => s.email === mail('b-ana')).status, 'subscribed');
  assert.equal(subs.subscriptions.find((s) => s.email === mail('b-ana')).can_email, false, 'but it can’t be emailed');
  assert.deepEqual([subs.subscribed, subs.emailable], [2, 1], 'two said yes; one of them can be emailed');
  const person = (await db.query('select tags from persons where workspace_id = $1 and lower(email) = $2', [ws, mail('b-ana')])).rows[0];
  assert.ok(!JSON.stringify(person.tags).includes('do-not-email'));

  // The send's numbers.
  const st = await statOf(c, first.blast.id);
  assert.deepEqual([st.delivered, st.bounced, st.complained], [2, 1, 0], 'delivered no longer counts the one that bounced');
  // Who can be emailed now: the list's count, its next send, the newsletter.
  assert.equal(await withEmailOf(c, list.id), 2);
  resend.reset();
  const next = ok(await c.action('blast.send', { kind: 'eblast', subject: 'Again', body: 'Hi', audience: { list_id: list.id } }));
  assert.equal(next.blast.audience_count, 2);
  assert.deepEqual(resend.sent.map((m) => m.to).sort(), [mail('b-ben'), mail('b-cal')]);
  resend.reset();
  const news = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'News', body: 'Hi' }));
  assert.equal(news.blast.audience_count, 1);
  assert.deepEqual(resend.sent.map((m) => m.to), [mail('b-ben')]);
  assert.equal(ok(await c.get('/api/audit/verify')).ok, true);
});

test('a complaint also ends consent: off the newsletter (or do-not-email), a no on the record — and the address is suppressed', async () => {
  const { c, ws } = await campaign('Complaint');
  const { people, list } = await members(c, 'c-ana', 'c-ben');
  await subscribe(c, 'c-ana'); // Ana is on the newsletter list; Ben never was
  resend.reset();
  const sent = ok(await c.action('blast.send', { kind: 'eblast', subject: 'AGM', body: 'Saturday', audience: { list_id: list.id } }));
  const ana = await rowOf(sent.blast.id, 'c-ana');
  const ben = await rowOf(sent.blast.id, 'c-ben');
  assert.equal((await resend.event('complained', { ref: ana.id })).status, 200);
  assert.equal((await resend.event('complained', { ref: ben.id })).status, 200);

  assert.deepEqual((await suppressions(ws)).map((s) => [s.email, s.reason, s.source]), [[mail('c-ana'), 'complaint', 'resend'], [mail('c-ben'), 'complaint', 'resend']]);
  assert.ok((await rowOf(sent.blast.id, 'c-ana')).complained_at);
  // Ana: off the list. Ben, who never was on it: do-not-email. Both: a no on the record.
  const subs = ok(await c.get('/api/subscriptions'));
  assert.equal(subs.subscriptions.find((s) => s.email === mail('c-ana')).status, 'unsubscribed');
  assert.ok(!subs.subscriptions.some((s) => s.email === mail('c-ben')), 'no list row made for him');
  assert.ok(ok(await c.get(`/api/persons/${people['c-ben'].id}`)).person.tags.includes('do-not-email'));
  for (const who of ['c-ana', 'c-ben']) {
    const nos = (await consents(ws, who)).filter((x) => x.granted === false);
    assert.ok(nos.length >= 1, `${who}: a no to email on the record`);
    assert.ok(nos.every((x) => x.source === 'complaint'), JSON.stringify(nos));
    assert.ok(nos.some((x) => x.person_id === people[who].id), 'on their own record');
  }
  // The desk can't put her back: only she can rejoin.
  assert.equal((await c.action('subscription.add', { email: mail('c-ana') })).status, 409);
  const st = await statOf(c, sent.blast.id);
  assert.deepEqual([st.delivered, st.bounced, st.complained], [2, 0, 2], 'a complaint was delivered: that is how they saw it');
  assert.equal(await withEmailOf(c, list.id), 0);
  assert.equal(ok(await c.get('/api/audit/verify')).ok, true);
});

test('the same event twice changes nothing', async () => {
  const { c, ws } = await campaign('Twice');
  const { list } = await members(c, 't-ana', 't-ben');
  await subscribe(c, 't-ana');
  const sent = ok(await c.action('blast.send', { kind: 'eblast', subject: 'AGM', body: 'Saturday', audience: { list_id: list.id } }));
  const ana = await rowOf(sent.blast.id, 't-ana');
  const first = await resend.event('complained', { ref: ana.id });
  assert.equal(first.status, 200);
  const state = async () => ({ seq: await seqOf(ws), sup: await suppressions(ws), nos: await consents(ws, 't-ana'), row: await rowOf(sent.blast.id, 't-ana'), n: await mailEvents() });
  const one = await state();
  // The sender delivers it again: the very same bytes and headers.
  const again = await resend.post(first.raw, first.headers);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, 1);
  assert.deepEqual(await state(), one);
  // …and again as a fresh delivery of the same event (the same id, signed anew).
  const third = await resend.event('complained', { ref: ana.id, id: first.id });
  assert.deepEqual([third.status, third.body.duplicate], [200, 1]);
  assert.deepEqual(await state(), one);
  // A second complaint about the same address (another email): still one suppression, no second no.
  const other = await resend.event('complained', { ref: ana.id });
  assert.equal(other.status, 200);
  const two = await state();
  assert.deepEqual([two.sup, two.nos], [one.sup, one.nos]);
});

test('a bad signature is refused with nothing written', async () => {
  const { c, ws } = await campaign('Forged');
  const { list } = await members(c, 'f-ana');
  const sent = ok(await c.action('blast.send', { kind: 'eblast', subject: 'AGM', body: 'Saturday', audience: { list_id: list.id } }));
  const ana = await rowOf(sent.blast.id, 'f-ana');
  const before = { seq: await seqOf(ws), n: await mailEvents() };
  const unchanged = async (why) => {
    assert.deepEqual({ seq: await seqOf(ws), n: await mailEvents() }, before, why);
    assert.deepEqual(await suppressions(ws), [], why);
    assert.equal((await rowOf(sent.blast.id, 'f-ana')).bounced_at, null, why);
  };
  const forged = await resend.event('bounced', { ref: ana.id, signWith: `whsec_${Buffer.from('someone-else').toString('base64')}` });
  assert.equal(forged.status, 400, JSON.stringify(forged.body));
  await unchanged('signed with another secret');
  assert.equal((await resend.event('bounced', { ref: ana.id, sign: false })).status, 400);
  await unchanged('not signed');
  // Signed, then one byte changed on the way.
  const good = resend.build('bounced', { ref: ana.id });
  const headers = resend.signed(good.raw, { id: good.id });
  assert.equal((await resend.post(good.raw.replace('Permanent', 'permanent'), headers)).status, 400);
  await unchanged('the bytes aren’t the ones signed');
  // Signed six minutes ago: a captured delivery can't be replayed.
  assert.equal((await resend.event('bounced', { ref: ana.id, t: Math.floor(Date.now() / 1000) - 360 })).status, 400);
  await unchanged('too old');
  // The right signature over the very same event: done.
  assert.equal((await resend.post(good.raw, headers)).status, 200);
  assert.equal((await suppressions(ws)).length, 1);
  // Signed bytes that aren't an event: refused, not a crash; an event base.win doesn't use: taken, nothing done.
  const junk = 'not json';
  assert.equal((await resend.post(junk, resend.signed(junk))).status, 400);
  const opened = resend.build('delivered', { ref: ana.id, extra: { type: 'email.opened' } });
  const n = await mailEvents();
  const r = await resend.post(opened.raw, resend.signed(opened.raw, { id: opened.id }));
  assert.deepEqual([r.status, r.body.events], [200, 0]);
  assert.equal(await mailEvents(), n);
});

test('with no webhook secret set the route answers 503; a sender that isn’t the one in use, or isn’t one at all, is 404', async () => {
  const good = resend.build('bounced', { to: mail('nobody') });
  const headers = resend.signed(good.raw, { id: good.id });
  try {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const r = await resend.post(good.raw, headers);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(r.body.error, /RESEND_WEBHOOK_SECRET/);
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    assert.equal((await hookTo('sendgrid')(good.raw, headers)).status, 404, 'SendGrid isn’t the sender in use');
    assert.equal((await hookTo('mailgun')(good.raw, headers)).status, 404);
    assert.equal((await app.request('/hooks/mail/resend')).status, 404, 'POST only');
    // No sender at all: nothing answers there.
    delete process.env.RESEND_API_KEY;
    assert.equal((await resend.post(good.raw, headers)).status, 404);
  } finally { useResend(); }
});

test('a delivered event settles a row left "sending" (not sure it went): sent, the send’s status follows', async () => {
  const { c, ws } = await campaign('Unsure');
  await subscribe(c, 'u-ana', 'u-ben');
  try {
    process.env.STARBASE_EMAIL_TIMEOUT_MS = '150';
    resend.hang();
    const sent = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'Not sure', body: 'Hello' }));
    resend.hang(false);
    assert.deepEqual(sent.counts, { total: 2, sent: 0, failed: 0, queued: 0, sending: 2 });
    assert.equal((await listed(c, sent.blast.id)).status, 'queued');
    const ana = await rowOf(sent.blast.id, 'u-ana');
    const ben = await rowOf(sent.blast.id, 'u-ben');
    assert.deepEqual([ana.status, ana.provider_id], ['sending', null]);

    const before = await seqOf(ws);
    assert.equal((await resend.event('delivered', { ref: ana.id, to: ana.email, messageId: 'em_late_1' })).status, 200);
    const now = await rowOf(sent.blast.id, 'u-ana');
    assert.equal(now.status, 'sent', 'the sender says it arrived: it went');
    assert.ok(now.delivered_at && now.sent_at);
    assert.deepEqual([now.provider, now.provider_id], ['resend', 'em_late_1'], 'and now we know the sender’s id');
    let b = await listed(c, sent.blast.id);
    assert.deepEqual([b.sent_count, b.sending_count, b.status], [1, 1, 'queued']);
    assert.deepEqual((await logged(c)).filter((e) => Number(e.seq) > before).map((e) => [e.action, e.entity_type, e.payload.status]), [['mail.event', 'blast_recipient', 'sent']]);
    // A bounce settles the other one too: it went, and bounced.
    assert.equal((await resend.event('bounced', { ref: ben.id, to: ben.email, messageId: 'em_late_2' })).status, 200);
    b = await listed(c, sent.blast.id);
    assert.deepEqual([b.sent_count, b.sending_count, b.retry_count, b.status], [2, 0, 0, 'sent'], 'everyone is accounted for: the send is sent');
    assert.ok(b.sent_at);
    const st = await statOf(c, sent.blast.id);
    assert.deepEqual([st.delivered, st.confirmed, st.bounced], [1, 1, 1]);
    // An ordinary delivered event — the row already 'sent' — is one write to the row: nothing on the log.
    const { c: c2, ws: ws2 } = await campaign('Plain delivered');
    await subscribe(c2, 'u-cal');
    const two = ok(await c2.action('blast.send', { kind: 'newsletter', subject: 'Sure', body: 'Hello' }));
    const cal = await rowOf(two.blast.id, 'u-cal');
    const seq = await seqOf(ws2);
    assert.equal((await resend.event('delivered', { ref: cal.id })).status, 200);
    assert.ok((await rowOf(two.blast.id, 'u-cal')).delivered_at);
    assert.equal(await seqOf(ws2), seq);
    assert.equal((await statOf(c2, two.blast.id)).confirmed, 1);
  } finally { useResend(); resend.hang(false); }
});

test('events out of order end bounced: a bounce before its delivered, or after', async () => {
  const { c } = await campaign('Order');
  await subscribe(c, 'o-ana', 'o-ben', 'o-cal');
  const sent = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'Order', body: 'Hello' }));
  const [ana, ben, cal] = await Promise.all(['o-ana', 'o-ben', 'o-cal'].map((w) => rowOf(sent.blast.id, w)));
  const t = Date.now();
  // Ana: the bounce arrives first, then the (older) delivered.
  assert.equal((await resend.event('bounced', { ref: ana.id, at: new Date(t) })).status, 200);
  assert.equal((await resend.event('delivered', { ref: ana.id, at: new Date(t - 5000) })).status, 200);
  // Ben: delivered, then bounced (a mailbox that took it and sent it back).
  assert.equal((await resend.event('delivered', { ref: ben.id, at: new Date(t - 5000) })).status, 200);
  assert.equal((await resend.event('bounced', { ref: ben.id, at: new Date(t) })).status, 200);
  // Cal: delivered; a "delayed" notice after it changes nothing.
  assert.equal((await resend.event('delivered', { ref: cal.id })).status, 200);
  assert.equal((await resend.event('deferred', { ref: cal.id })).status, 200);
  for (const who of ['o-ana', 'o-ben']) {
    const r = await rowOf(sent.blast.id, who);
    assert.ok(r.bounced_at && r.delivered_at, who);
    assert.match(r.bounce_detail, /^Permanent/, 'the bounce’s words stay');
  }
  const st = await statOf(c, sent.blast.id);
  assert.deepEqual([st.delivered, st.confirmed, st.bounced], [1, 1, 2], 'bounced, whichever came first');
  assert.equal((await rowOf(sent.blast.id, 'o-cal')).bounced_at, null);
});

test('a delay: the sender has it — a row "not sure it went" went; its words go when the email arrives, and a late notice changes nothing', async () => {
  const { c, ws } = await campaign('Delay');
  await subscribe(c, 'd-ana', 'd-ben');
  try {
    process.env.STARBASE_EMAIL_TIMEOUT_MS = '150';
    resend.hang();
    const sent = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'Slow', body: 'Hello' }));
    resend.hang(false);
    assert.deepEqual(sent.counts, { total: 2, sent: 0, failed: 0, queued: 0, sending: 2 });
    const ana = await rowOf(sent.blast.id, 'd-ana');
    const before = await seqOf(ws);
    // Delayed: the sender is still trying, so it has the email — never a reason to send it again.
    assert.equal((await resend.event('deferred', { ref: ana.id, to: ana.email, messageId: 'em_slow_1' })).status, 200);
    let now = await rowOf(sent.blast.id, 'd-ana');
    assert.deepEqual([now.status, now.delivered_at, now.bounced_at, now.bounce_detail, now.provider_id], ['sent', null, null, 'Delivery delayed', 'em_slow_1']);
    assert.deepEqual((await logged(c)).filter((e) => Number(e.seq) > before).map((e) => [e.action, e.entity_type, e.payload.status]), [['mail.event', 'blast_recipient', 'sent']]);
    let st = await statOf(c, sent.blast.id);
    assert.deepEqual([st.delivered, st.confirmed, st.bounced], [1, 0, 0], 'taken, not yet confirmed');
    // It arrives: the delay is moot.
    assert.equal((await resend.event('delivered', { ref: ana.id })).status, 200);
    now = await rowOf(sent.blast.id, 'd-ana');
    assert.ok(now.delivered_at);
    assert.equal(now.bounce_detail, null);
    // A delay notice that comes in after it arrived says nothing new.
    assert.equal((await resend.event('deferred', { ref: ana.id })).status, 200);
    assert.equal((await rowOf(sent.blast.id, 'd-ana')).bounce_detail, null);
    st = await statOf(c, sent.blast.id);
    assert.deepEqual([st.delivered, st.confirmed], [1, 1]);
    // "The sender couldn't send it" is not "it went": the other row stays not sure, with the words.
    const ben = await rowOf(sent.blast.id, 'd-ben');
    assert.equal((await resend.event('failed', { ref: ben.id, to: ben.email, detail: 'Daily quota reached' })).status, 200);
    const b = await rowOf(sent.blast.id, 'd-ben');
    assert.deepEqual([b.status, b.bounce_detail], ['sending', 'Daily quota reached']);
  } finally { useResend(); resend.hang(false); }
});

test('the sender’s own refusals and soft failures: "suppressed" stops the address (no consent change); delayed and failed only leave their words', async () => {
  const { c, ws } = await campaign('Soft');
  await subscribe(c, 's-ana', 's-ben', 's-cal', 's-dee');
  const sent = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'Soft', body: 'Hello' }));
  const row = (w) => rowOf(sent.blast.id, w);
  assert.equal((await resend.event('suppressed', { ref: (await row('s-ana')).id, detail: 'On the suppression list' })).status, 200);
  assert.equal((await resend.event('suppressed', { ref: (await row('s-ben')).id, extra: { data: { suppressed: { type: 'complaint', message: 'Marked as spam before' } } } })).status, 200);
  assert.equal((await resend.event('deferred', { ref: (await row('s-cal')).id })).status, 200);
  assert.equal((await resend.event('failed', { ref: (await row('s-dee')).id, detail: 'Daily quota reached' })).status, 200);
  assert.deepEqual((await suppressions(ws)).map((s) => [s.email, s.reason, s.detail]), [
    [mail('s-ana'), 'bounce', 'Resend won’t send to it — bounce: On the suppression list'],
    [mail('s-ben'), 'complaint', 'Resend won’t send to it — complaint: Marked as spam before'],
  ]);
  // Not delivered, so they count with the bounced; nobody's consent changed (the sender's list is not a no).
  const ana = await row('s-ana');
  assert.ok(ana.bounced_at);
  assert.equal(ana.complained_at, null);
  assert.deepEqual((await consents(ws, 's-ben')).map((x) => x.granted), [true]);
  assert.equal(ok(await c.get('/api/subscriptions')).subscriptions.find((s) => s.email === mail('s-ben')).status, 'subscribed');
  const cal = await row('s-cal');
  assert.deepEqual([cal.bounced_at, cal.status], [null, 'sent']);
  assert.match(cal.bounce_detail, /delayed/i);
  const dee = await row('s-dee');
  assert.deepEqual([dee.bounced_at, dee.bounce_detail], [null, 'Daily quota reached']);
  const st = await statOf(c, sent.blast.id);
  assert.deepEqual([st.delivered, st.bounced, st.complained], [2, 2, 0]);
  // Ben's own complaint then reaches us: the address was stopped already, and now his consent ends too — once.
  assert.equal((await resend.event('complained', { to: mail('s-ben') })).status, 200);
  assert.equal(ok(await c.get('/api/subscriptions')).subscriptions.find((x) => x.email === mail('s-ben')).status, 'unsubscribed');
  const nos = (await consents(ws, 's-ben')).filter((x) => x.granted === false);
  assert.deepEqual(nos.map((x) => x.source), ['complaint']);
  assert.equal((await resend.event('complained', { to: mail('s-ben') })).status, 200);
  assert.equal((await consents(ws, 's-ben')).filter((x) => x.granted === false).length, 1, 'a second complaint is not a second no');
});

test('an event with no row of ours (a ladder email, a receipt): a bounce or a complaint still stops the address, in every campaign here that holds it', async () => {
  const one = await campaign('Holds A');
  const two = await campaign('Holds B');
  const none = await campaign('Holds C');
  const addr = mail('shared');
  const a = await one.c.createPerson('Shared Example', { email: addr });
  ok(await two.c.action('subscription.add', { email: addr }));
  await none.c.createPerson('Other Example', { email: mail('other') });
  const seq = await seqOf(none.ws);

  const r = await resend.event('bounced', { to: addr.toUpperCase(), messageId: 'em_receipt_1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await suppressions(one.ws)).map((s) => [s.email, s.reason]), [[addr, 'bounce']]);
  assert.deepEqual((await suppressions(two.ws)).map((s) => [s.email, s.reason]), [[addr, 'bounce']]);
  assert.deepEqual(await suppressions(none.ws), [], 'a campaign that doesn’t hold the address hears nothing');
  assert.equal(await seqOf(none.ws), seq);
  assert.equal(ok(await two.c.get('/api/subscriptions')).emailable, 0);
  // A complaint about it: a no in both, the suppression now a complaint.
  assert.equal((await resend.event('complained', { to: addr })).status, 200);
  assert.deepEqual((await suppressions(one.ws)).map((s) => s.reason), ['complaint']);
  assert.ok(ok(await one.c.get(`/api/persons/${a.id}`)).person.tags.includes('do-not-email'));
  assert.equal(ok(await two.c.get('/api/subscriptions')).subscriptions.find((s) => s.email === addr).status, 'unsubscribed');
  for (const x of [one, two]) {
    assert.ok((await db.query("select 1 from consent_events where workspace_id = $1 and address = $2 and granted = false and source = 'complaint'", [x.ws, addr])).rows.length >= 1);
    assert.equal(ok(await x.c.get('/api/audit/verify')).ok, true);
  }
  // Delivered, delayed, or about an address nobody here holds: taken (200), nothing to do, and still done once.
  const n = await mailEvents();
  const d = await resend.event('delivered', { to: addr });
  assert.equal(d.status, 200);
  assert.equal((await resend.event('bounced', { to: mail('never-heard-of') })).status, 200);
  assert.equal(await mailEvents(), n + 2);
  assert.equal((await resend.post(d.raw, d.headers)).body.duplicate, 1);
  // A ref that isn't one of ours (another app on the same sender account): by the address, never a crash.
  assert.equal((await resend.event('bounced', { to: mail('never-heard-of'), ref: 'not-a-uuid' })).status, 200);
  assert.equal((await resend.event('bounced', { to: mail('never-heard-of'), ref: '00000000-0000-4000-8000-000000000000' })).status, 200);
});

test('a send saved earlier: an address suppressed since is taken off at the moment it is sent, never emailed', async () => {
  const { c, ws } = await campaign('Saved');
  await subscribe(c, 'v-ana', 'v-ben', 'v-cal');
  try {
    delete process.env.RESEND_API_KEY; // email not connected: the send is saved
    const saved1 = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'Saved', body: 'Hello' }));
    assert.equal(saved1.blast.status, 'queued');
    useResend();
    assert.equal((await resend.event('bounced', { to: mail('v-ana') })).status, 200);
    assert.deepEqual((await suppressions(ws)).map((s) => s.email), [mail('v-ana')]);
    const b = await listed(c, saved1.blast.id);
    assert.deepEqual([b.queued_count, b.retry_count], [2, 2], 'Send now · 2: the two it would email');
    resend.reset();
    const go = ok(await c.action('blast.resend', { id: saved1.blast.id }));
    assert.deepEqual(go.resent, { sent: 2, failed: 0, skipped: 0, suppressed: 1 });
    assert.deepEqual(go.counts, { total: 2, sent: 2, failed: 0, queued: 0 });
    assert.deepEqual(resend.sent.map((m) => m.to).sort(), [mail('v-ben'), mail('v-cal')]);
    assert.equal(go.blast.status, 'sent');
    assert.equal(go.blast.audience_count, 2);
    const run = (await logged(c)).filter((e) => e.action === 'blast.resend' && e.payload.resent != null).at(-1);
    assert.deepEqual(run.payload, { resent: 2, sent: 2, failed: 0, unsubscribed: 0, suppressed: 1, status: 'sent' });
  } finally { useResend(); }
});

test('an A/B send: the rest held for the winner leave out an address suppressed during the wait', async () => {
  const { c, ws } = await campaign('Winner');
  const who = Array.from({ length: 50 }, (_, i) => `w-${String(i).padStart(2, '0')}`);
  await subscribe(c, ...who);
  resend.reset();
  const sent = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'A', body: 'Hello', ab: { subject_b: 'B', pct: 10, wait_hours: 1, metric: 'opens' } }));
  assert.equal(resend.sent.length, 10, 'A and B now');
  const held = (await rowsOf(sent.blast.id)).filter((r) => r.ab_group === 'rest');
  assert.equal(held.length, 40);
  assert.equal((await resend.event('bounced', { to: held[0].email })).status, 200);
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws]);
  assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
  assert.equal(resend.sent.length, 49);
  assert.ok(!resend.sent.some((m) => m.to === held[0].email), 'the suppressed one was never emailed');
  const b = await listed(c, sent.blast.id);
  assert.deepEqual([b.audience_count, b.sent_count, b.status], [49, 49, 'sent']);
});

test('the press list leaves out a suppressed address too, and its count says so before the send', async () => {
  const { c } = await campaign('Press');
  for (const w of ['p-ana', 'p-ben']) await c.createPerson(`${w} Example`, { email: mail(w), tags: ['media'] });
  assert.equal(ok(await c.get('/api/blasts')).mediaContacts, 2);
  assert.equal((await resend.event('bounced', { to: mail('p-ana') })).status, 200);
  assert.equal(ok(await c.get('/api/blasts')).mediaContacts, 1, 'the number the Press screen asks about');
  resend.reset();
  const sent = ok(await c.action('blast.send', { kind: 'press', subject: 'Release', body: 'For immediate release.' }));
  assert.equal(sent.blast.audience_count, 1);
  assert.deepEqual(resend.sent.map((m) => m.to), [mail('p-ben')]);
});

test('a ladder’s email step skips a suppressed address, and says so', async () => {
  const { c, ws } = await campaign('Ladder');
  const lad = ok(await c.action('ladder.create', { name: 'Thanks', trigger: { kind: 'tag', ref: 'signer' }, steps: [{ kind: 'email', subject: 'Thanks', body: 'Thank you.' }] })).ladder;
  ok(await c.action('ladder.setActive', { id: lad.id, active: true }));
  const ana = await c.createPerson('Ana Example', { email: mail('l-ana') });
  const ben = await c.createPerson('Ben Example', { email: mail('l-ben') });
  await subscribe(c, 'l-ana', 'l-ben');
  assert.equal((await resend.event('bounced', { to: mail('l-ana') })).status, 200);
  resend.reset();
  for (const p of [ana, ben]) ok(await c.action('person.update', { id: p.id, tags: ['signer'] }));
  for (let i = 0; i < 10; i += 1) { const r = await runDueJobs(db, { workspaceId: ws }); if (r.ran + r.failed === 0) break; }
  assert.deepEqual(resend.sent.map((m) => m.to), [mail('l-ben')]);
  const runs = ok(await c.get(`/api/ladders/${lad.id}`));
  const of = (p) => runs.people.find((x) => x.person.id === p.id);
  assert.deepEqual(of(ana).skipped.map((s) => `${s.kind}:${s.reason}`), ['email:suppressed']);
  assert.deepEqual(of(ben).skipped, []);
  assert.equal(runs.emailYes, 1, 'who an email step can reach');
});

test('the suppressed address is still absent after the sender is switched; the new sender’s events come in at its own address', async () => {
  const { c, ws } = await campaign('Switch');
  const { list } = await members(c, 'x-ana', 'x-ben', 'x-cal');
  const first = ok(await c.action('blast.send', { kind: 'eblast', subject: 'One', body: 'Hi', audience: { list_id: list.id } }));
  assert.equal((await resend.event('bounced', { ref: (await rowOf(first.blast.id, 'x-ana')).id })).status, 200);
  const late = resend.build('bounced', { ref: (await rowOf(first.blast.id, 'x-cal')).id });
  try {
    useSendgrid();
    grid.reset();
    assert.equal(ok(await c.get('/api/blasts')).emailConfigured, true);
    const second = ok(await c.action('blast.send', { kind: 'eblast', subject: 'Two', body: 'Hi', audience: { list_id: list.id } }));
    assert.equal(second.blast.audience_count, 2);
    assert.deepEqual(grid.sent.map((m) => m.to).sort(), [mail('x-ben'), mail('x-cal')]);
    const ben = await rowOf(second.blast.id, 'x-ben');
    assert.deepEqual([ben.provider, ben.provider_id, grid.sent.find((m) => m.to === ben.email).ref], ['sendgrid', grid.sent.find((m) => m.to === ben.email).id, ben.id]);
    // The old sender's address answers no more; the new one's does, signed its own way.
    assert.equal((await resend.post(late.raw, resend.signed(late.raw, { id: late.id }))).status, 404);
    const ev = await grid.event('bounced', { ref: ben.id });
    assert.equal(ev.status, 200, JSON.stringify(ev.body));
    assert.deepEqual((await suppressions(ws)).map((s) => [s.email, s.source]), [[mail('x-ana'), 'resend'], [mail('x-ben'), 'sendgrid']]);
    // By the sender's id alone (no ref came back): the row is still found.
    const cal = await rowOf(second.blast.id, 'x-cal');
    const byId = grid.build('complained', { messageId: cal.provider_id, to: cal.email, extra: { event: 'spam report' } });
    assert.equal((await grid.post(byId.raw, grid.signed(byId.raw))).status, 200);
    assert.ok((await rowOf(second.blast.id, 'x-cal')).complained_at);
    // A forged SendGrid delivery (signed with another key) is refused.
    const { generateKeyPairSync } = await import('node:crypto');
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    assert.equal((await grid.event('bounced', { to: mail('x-dee'), signWith: other })).status, 400);
    const st = await statOf(c, second.blast.id);
    assert.deepEqual([st.delivered, st.bounced, st.complained], [1, 1, 1]);
    // SendGrid posts many events in one delivery: each is done, once — and a delivery bigger than
    // an ordinary request (its batches run to hundreds of kilobytes) is still taken.
    const { c: c3 } = await campaign('Batch');
    const many = Array.from({ length: 14 }, (_, i) => `y-${String(i).padStart(2, '0')}`);
    await subscribe(c3, ...many);
    const big = ok(await c3.action('blast.send', { kind: 'newsletter', subject: 'Batch', body: 'Hi' }));
    const rows = await rowsOf(big.blast.id);
    const one = (kind, r, extra) => JSON.parse(grid.build(kind, { ref: r.id, to: r.email, extra }).raw)[0];
    const noise = Array.from({ length: 900 }, (_, i) => ({ email: mail('y-00'), event: 'processed', sg_event_id: `noise-${tag}-${i}`, timestamp: 1793728800, useragent: 'x'.repeat(400) }));
    const batch = `${JSON.stringify([...rows.slice(0, 12).map((r) => one('delivered', r)), one('bounced', rows[12]), one('deferred', rows[13]), ...noise])}\r\n`;
    assert.ok(Buffer.byteLength(batch) > 300 * 1024, 'bigger than the ordinary limit');
    const taken = await grid.post(batch, grid.signed(batch));
    assert.deepEqual([taken.status, taken.body], [200, { received: true, events: 14 }], JSON.stringify(taken.body));
    const after = await rowsOf(big.blast.id);
    assert.equal(after.filter((r) => r.delivered_at).length, 12);
    assert.ok(after[12].bounced_at);
    assert.equal(after[13].bounce_detail, '451 try again later');
    const bst = await statOf(c3, big.blast.id);
    assert.deepEqual([bst.delivered, bst.confirmed, bst.bounced], [13, 12, 1]);
    const again = await grid.post(batch, grid.signed(batch));
    assert.deepEqual([again.status, again.body.duplicate], [200, 14], 'the same delivery again: nothing done twice');
    assert.equal(await withEmailOf(c, list.id), 0);
    delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
    assert.equal((await grid.event('bounced', { to: mail('x-dee') })).status, 503);
  } finally { useResend(); }
  assert.equal(ok(await c.get('/api/audit/verify')).ok, true);
});

test('delivery events are kept thirty days, then dropped: far past any sender’s retries', async () => {
  const { pruneEvents } = await import('../ext/mail/webhook.js');
  const id = (n) => `prune-${tag}-${n}`;
  await db.query(
    `insert into mail_events (provider, id, workspace_id, kind, received_at) values
       ('resend', $1, null, 'delivered', now() - interval '31 days'), ('resend', $2, null, 'bounced', now() - interval '29 days')`,
    [id(1), id(2)],
  );
  await pruneEvents(db);
  assert.deepEqual((await db.query('select id from mail_events where id = any($1::text[]) order by id', [[id(1), id(2)]])).rows.map((r) => r.id), [id(2)]);
});

test('not sure it went, with a sender that can’t drop a repeat: offered only once delivery events flow and thirty minutes have passed', async () => {
  const { c, ws } = await campaign('Repeat');
  await subscribe(c, 'r-ana', 'r-ben');
  const age = (id, minutes) => db.query(`update blast_recipients set sending_at = now() - make_interval(mins => $2) where blast_id = $1 and status = 'sending'`, [id, minutes]);
  try {
    useSendgrid({ events: false });
    process.env.STARBASE_EMAIL_TIMEOUT_MS = '150';
    grid.reset();
    grid.hang();
    const sent = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'Maybe', body: 'Hello' }));
    grid.hang(false);
    assert.deepEqual(sent.counts, { total: 2, sent: 0, failed: 0, queued: 0, sending: 2 });
    const now = async () => { const b = await listed(c, sent.blast.id); return [b.sending_count, b.retry_count, b.repeat_count]; };
    await age(sent.blast.id, 45);
    assert.deepEqual(await now(), [2, 0, 0], 'delivery events aren’t connected: nothing says they didn’t go — never offered');
    assert.deepEqual(ok(await c.action('blast.resend', { id: sent.blast.id })).resent, { sent: 0, failed: 0, skipped: 0 });
    assert.equal(grid.sent.length, 0);
    // Connected (the key is set), but no event has come in for this campaign yet: still not proof —
    // not even when another campaign on this server is hearing from SendGrid right now.
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = grid.publicKey;
    const other = await campaign('Repeat neighbour');
    await db.query("insert into mail_events (provider, id, workspace_id, kind) values ('sendgrid', $1, $2, 'delivered')", [`neighbour-${tag}`, other.ws]);
    assert.deepEqual(await now(), [2, 0, 0]);
    assert.deepEqual(ok(await c.action('blast.resend', { id: sent.blast.id })).resent, { sent: 0, failed: 0, skipped: 0 });
    assert.equal(grid.sent.length, 0, 'Try again reaches no one on a neighbour’s word');
    assert.equal((await db.query('select count(*)::int as n from blast_recipients where blast_id = $1 and send_asked_at is not null', [sent.blast.id])).rows[0].n, 0, '…and asks for no one');
    // Another email goes, and its delivery event arrives: events flow now.
    const probe = ok(await c.action('blast.send', { kind: 'newsletter', subject: 'Probe', body: 'Hello' }));
    assert.equal(grid.sent.length, 2);
    assert.equal((await grid.event('delivered', { ref: (await rowOf(probe.blast.id, 'r-ana')).id })).status, 200);
    // Eleven minutes old is too soon for this sender; thirty-one is not.
    await age(sent.blast.id, 11);
    assert.deepEqual(await now(), [2, 0, 0]);
    await age(sent.blast.id, 31);
    assert.deepEqual(await now(), [2, 2, 2], 'Try again · 2 — and both may get a second copy');
    // The proof has to be newer than the email: events that came in before it was handed over say nothing about it.
    await db.query(`update mail_events set received_at = now() - interval '2 hours' where workspace_id = $1`, [ws]);
    assert.deepEqual(await now(), [2, 0, 0]);
    await db.query('update mail_events set received_at = now() where workspace_id = $1', [ws]);
    assert.deepEqual(await now(), [2, 2, 2]);
    const again = ok(await c.action('blast.resend', { id: sent.blast.id }));
    assert.deepEqual(again.resent, { sent: 2, failed: 0, skipped: 0 });
    assert.equal(grid.sent.length, 4);
    assert.deepEqual(await now(), [0, 0, 0]);
    // With Resend the same rows are offered after ten minutes, as always: its key drops a repeat.
    useResend();
    process.env.STARBASE_EMAIL_TIMEOUT_MS = '150';
    const { c: c2 } = await campaign('Repeat Resend');
    await subscribe(c2, 'r-cal');
    resend.hang();
    const two = ok(await c2.action('blast.send', { kind: 'newsletter', subject: 'Maybe', body: 'Hello' }));
    resend.hang(false);
    await age(two.blast.id, 11);
    const b = await listed(c2, two.blast.id);
    assert.deepEqual([b.sending_count, b.retry_count, b.repeat_count], [1, 1, 0]);
  } finally { useResend(); grid.hang(false); resend.hang(false); }
});

