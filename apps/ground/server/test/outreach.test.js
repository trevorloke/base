// Outreach: the newsletter list and its unsubscribe link, email blasts
// (newsletter + press), the campaign's website address on public pages.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

let c, slug;

const pub = async (method, path, body, headers = {}) => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null, text = '';
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) json = await res.json(); else text = await res.text();
  return { status: res.status, json, text, headers: res.headers };
};

before(async () => {
  await freshDb();
  delete process.env.RESEND_API_KEY;
  c = new Client();
  const r = await c.signup({ workspaceName: 'Imagine Surrey' });
  slug = r.json.workspace.slug;
  await c.action('workspace.update', { website: 'https://imaginesurrey.ca' });
});

test('newsletter: desk adds, dedupe on email, the link asks then unsubscribes, a public page links back to the website', async () => {
  const s1 = await c.action('subscription.add', { name: 'Maya Chen', email: 'Maya@Example.org' });
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  await c.action('subscription.add', { email: 'maya@example.org' });
  let subs = await c.get('/api/subscriptions');
  assert.equal(subs.json.subscriptions.filter((s) => s.email === 'maya@example.org').length, 1, 'case-insensitive dedupe');
  const maya = subs.json.subscriptions.find((s) => s.email === 'maya@example.org');
  const ask = await pub('GET', `/u/${maya.id}`);
  assert.equal(ask.status, 200);
  assert.match(ask.text, /Unsubscribe from Imagine Surrey\?/);
  assert.match(ask.text, /imaginesurrey\.ca/, 'public pages link back to the campaign website');
  assert.equal((await c.get('/api/subscriptions')).json.subscriptions.find((s) => s.email === 'maya@example.org').status, 'subscribed', 'opening only asks');
  const un = await pub('POST', `/u/${maya.id}`);
  assert.equal(un.status, 200);
  assert.match(un.text, /Unsubscribed/);
  subs = await c.get('/api/subscriptions');
  assert.equal(subs.json.subscriptions.find((s) => s.email === 'maya@example.org').status, 'unsubscribed');
  assert.equal((await c.action('subscription.add', { email: 'maya@example.org' })).status, 409, 'off the list, only they can rejoin');
  const manual = await c.action('subscription.add', { email: 'board@example.org', name: 'Board Member' });
  assert.equal(manual.status, 200);
  const bad = await c.action('subscription.add', { email: 'not-an-email' });
  assert.equal(bad.status, 400);
  assert.equal((await pub('GET', '/u/not-a-link')).status, 404);
});

test('blasts: newsletter goes to the subscribed list; press goes to media-tagged people; queued without a provider', async () => {
  await c.createPerson('Reporter One', { email: 'r1@news.example', tags: ['media'] });
  await c.createPerson('Reporter NoEmail', { tags: ['media'] });
  await c.createPerson('Not Media', { email: 'x@example.org', tags: ['VIP'] });

  const press = await c.action('blast.send', { kind: 'press', subject: 'Imagine Surrey unveils transit plan', body: 'FOR IMMEDIATE RELEASE …' });
  assert.equal(press.status, 200);
  assert.equal(press.json.blast.audience_count, 1, 'only media-tagged people with email');
  assert.equal(press.json.blast.status, 'queued');
  assert.match(press.json.blast.provider_note, /RESEND_API_KEY/);
  assert.deepEqual(press.json.counts, { total: 1, sent: 0, failed: 0, queued: 1 }, 'saved, not sent');

  const news = await c.action('blast.send', { kind: 'newsletter', subject: 'This week', body: 'Hello friends' });
  assert.equal(news.json.blast.audience_count, 1, 'the board member; maya unsubscribed');

  const list = await c.get('/api/blasts');
  assert.equal(list.json.blasts.length, 2);
  assert.equal(list.json.mediaContacts, 1);
  assert.equal(list.json.emailConfigured, false);
});

test('empty audiences are refused with a plain reason', async () => {
  const fresh = new Client();
  await fresh.signup({ workspaceName: 'Empty Lists' });
  const r = await fresh.action('blast.send', { kind: 'press', subject: 's', body: 'b' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /tagged 'media'/);
});

test('public writes append to the event log under a system actor', async () => {
  const ev = await c.get('/api/events?since=0&limit=1000');
  assert.ok(ev.json.events.some((e) => e.action === 'public.unsubscribe' && e.actor_id === null));
  const verify = await c.get('/api/audit/verify');
  assert.equal(verify.json.ok, true);
});

test('with a provider: every newsletter carries the recipient’s own unsubscribe link; press does not', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const news = await c.action('blast.send', { kind: 'newsletter', subject: 'Footer check', body: 'Body text' });
    assert.equal(news.status, 200);
    assert.equal(news.json.blast.status, 'sent');
    const subs = (await c.get('/api/subscriptions')).json.subscriptions.filter((s) => s.status === 'subscribed');
    assert.equal(sent.length, subs.length);
    assert.deepEqual(news.json.counts, { total: subs.length, sent: subs.length, failed: 0, queued: 0 });
    for (const s of subs) {
      const msg = sent.find((m) => m.to[0] === s.email);
      assert.ok(msg, `sent to ${s.email}`);
      assert.match(msg.text, /^Body text/);
      assert.ok(msg.text.includes(`/u/${s.id}`), 'own unsubscribe link');
      assert.match(msg.text, /Sent by Imagine Surrey/);
    }
    const links = sent.map((m) => m.text.match(/\/u\/([0-9a-f-]{36})/)[1]);
    assert.equal(new Set(links).size, links.length, 'links are per-recipient');

    sent.length = 0;
    const press = await c.action('blast.send', { kind: 'press', subject: 'Release', body: 'News' });
    assert.equal(press.json.blast.status, 'sent');
    assert.ok(sent.every((m) => !m.text.includes('/u/')), 'press has no newsletter unsubscribe link');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
});

const withEmailProvider = async (fn, { fail = () => false } = {}) => {
  const sent = [];
  const realFetch = globalThis.fetch;
  const hadKey = Object.hasOwn(process.env, 'RESEND_API_KEY');
  const oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const msg = JSON.parse(init.body);
      if (fail(msg.to[0])) return new Response('mailbox unavailable', { status: 500 });
      sent.push(msg);
      return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.RESEND_API_KEY = oldKey; else delete process.env.RESEND_API_KEY;
  }
};

test('send later is real: a saved newsletter goes out with blast.resend once email is connected — once', async () => {
  const w = new Client();
  await w.signup({ workspaceName: 'Resend Newsletter' });
  for (const [email, name] of [['ana.resend@example.org', 'Ana'], ['ben.resend@example.org', 'Ben'], ['cy.resend@example.org', 'Cy']]) {
    assert.equal((await w.action('subscription.add', { email, name })).status, 200);
  }
  delete process.env.RESEND_API_KEY;
  const saved = await w.action('blast.send', { kind: 'newsletter', subject: 'Saved for later', body: 'Hello neighbours' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.blast.status, 'queued', 'no provider: saved, not sent');
  assert.equal(saved.json.blast.audience_count, 3);
  assert.deepEqual(saved.json.counts, { total: 3, sent: 0, failed: 0, queued: 3 });
  const id = saved.json.blast.id;

  const refused = await w.action('blast.resend', { id });
  assert.equal(refused.status, 409, 'still not connected: refused, nothing pretends to send');
  assert.match(refused.json.error, /isn't connected/);
  assert.equal((await w.get('/api/blasts')).json.blasts.find((b) => b.id === id).status, 'queued');

  // Cy leaves the list before email is connected: Cy must never get it.
  const cy = (await w.get('/api/subscriptions')).json.subscriptions.find((s) => s.email === 'cy.resend@example.org');
  await w.action('subscription.remove', { id: cy.id });

  await withEmailProvider(async (sent) => {
    const r = await w.action('blast.resend', { id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.resent, { sent: 2, failed: 0, skipped: 1 });
    assert.deepEqual(r.json.counts, { total: 2, sent: 2, failed: 0, queued: 0 }, 'the whole send after this run');
    assert.equal(r.json.blast.status, 'sent');
    assert.equal(r.json.blast.audience_count, 2, 'the unsubscribed address is off the send');
    assert.equal(r.json.blast.provider_note, null);
    assert.ok(r.json.blast.sent_at, 'sent time recorded, as blast.send does');
    assert.deepEqual(sent.map((m) => m.to[0]).sort(), ['ana.resend@example.org', 'ben.resend@example.org']);
    const subs = (await w.get('/api/subscriptions')).json.subscriptions;
    for (const m of sent) {
      assert.equal(m.subject, 'Saved for later');
      assert.match(m.text, /^Hello neighbours/);
      assert.ok(m.text.includes(`/u/${subs.find((s) => s.email === m.to[0]).id}`), 'own unsubscribe link');
      assert.match(m.text, /Sent by Resend Newsletter/);
    }

    const again = await w.action('blast.resend', { id });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.resent, { sent: 0, failed: 0, skipped: 0 });
    assert.deepEqual(again.json.counts, { total: 2, sent: 2, failed: 0, queued: 0 });
    assert.equal(sent.length, 2, 'sent rows are never re-sent');
    assert.equal(again.json.blast.status, 'sent');
  });

  const listed = (await w.get('/api/blasts')).json.blasts.find((b) => b.id === id);
  assert.equal(listed.status, 'sent');
  assert.equal(listed.audience_count, 2);
  assert.ok(listed.sent_at);
  // On the log: the tap (who was asked for), then how it went.
  const resends = (await w.get('/api/events?since=0&limit=1000')).json.events
    .filter((e) => e.action === 'blast.resend' && e.entity_type === 'blast');
  assert.deepEqual(resends.map((e) => e.payload), [
    { asked: 3 }, { resent: 2, sent: 2, failed: 0, unsubscribed: 1, status: 'sent' },
  ], 'one logged resend; the no-op second run logs nothing');
  assert.equal((await w.get('/api/audit/verify')).json.ok, true);
});

test('blast.resend records each result, and Send now retries the failed ones — never a sent one', async () => {
  const w = new Client();
  await w.signup({ workspaceName: 'Resend Press' });
  await w.createPerson('Desk One', { email: 'desk1.resend@news.example', tags: ['media'] });
  await w.createPerson('Desk Two', { email: 'desk2.resend@news.example', tags: ['media'] });
  delete process.env.RESEND_API_KEY;
  const saved = await w.action('blast.send', { kind: 'press', subject: 'Saved release', body: 'FOR IMMEDIATE RELEASE' });
  assert.equal(saved.json.blast.status, 'queued');
  const id = saved.json.blast.id;

  let desk2Down = true;
  await withEmailProvider(async (sent) => {
    const r = await w.action('blast.resend', { id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.resent, { sent: 1, failed: 1, skipped: 0 });
    assert.deepEqual(r.json.counts, { total: 2, sent: 1, failed: 1, queued: 0 }, 'exactly who was reached');
    assert.equal(r.json.blast.status, 'queued', 'a mix of sent and failed — the same rule as blast.send');
    assert.match(r.json.blast.provider_note, /email provider 500/);
    assert.equal(r.json.blast.sent_at, null);
    assert.deepEqual(sent.map((m) => m.to[0]), ['desk1.resend@news.example']);
    assert.ok(sent.every((m) => !m.text.includes('/u/')), 'press carries no unsubscribe link');
    assert.match(sent[0].text, /Resend Press$/);

    // The provider still turns desk2 down: tried again, still failed, desk1 untouched.
    const still = await w.action('blast.resend', { id });
    assert.deepEqual(still.json.resent, { sent: 0, failed: 1, skipped: 0 }, 'the failed one is tried again');
    assert.deepEqual(still.json.counts, { total: 2, sent: 1, failed: 1, queued: 0 });
    assert.equal(sent.length, 1, 'the sent one is never sent twice');

    // The provider takes it now: the send is complete.
    desk2Down = false;
    const ok = await w.action('blast.resend', { id });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.resent, { sent: 1, failed: 0, skipped: 0 });
    assert.deepEqual(ok.json.counts, { total: 2, sent: 2, failed: 0, queued: 0 });
    assert.equal(ok.json.blast.status, 'sent');
    assert.equal(ok.json.blast.provider_note, null);
    assert.ok(ok.json.blast.sent_at);
    assert.deepEqual(sent.map((m) => m.to[0]), ['desk1.resend@news.example', 'desk2.resend@news.example'], 'each reached exactly once');

    const done = await w.action('blast.resend', { id });
    assert.deepEqual(done.json.resent, { sent: 0, failed: 0, skipped: 0 }, 'nothing left to send');
    assert.equal(sent.length, 2);
  }, { fail: (to) => desk2Down && to === 'desk2.resend@news.example' });

  const ev = (await w.get('/api/events?since=0&limit=1000')).json.events
    .filter((e) => e.action === 'blast.resend' && e.payload.status);
  assert.deepEqual(ev.map((e) => [e.payload.sent, e.payload.failed]), [[1, 1], [0, 1], [1, 0]], 'every real attempt is logged; the no-op is not');
  assert.equal((await w.get('/api/audit/verify')).json.ok, true);
});

test('blast.send that partly fails answers exact counts; Send now reaches only the failed one', async () => {
  const w = new Client();
  await w.signup({ workspaceName: 'Half Sent' });
  for (const email of ['half.one@example.org', 'half.two@example.org']) {
    assert.equal((await w.action('subscription.add', { email })).status, 200);
  }
  let down = true;
  await withEmailProvider(async (sent) => {
    const r = await w.action('blast.send', { kind: 'newsletter', subject: 'Half', body: 'Hello' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.counts, { total: 2, sent: 1, failed: 1, queued: 0 });
    assert.equal(r.json.blast.status, 'queued');
    assert.deepEqual(sent.map((m) => m.to[0]), ['half.one@example.org']);
    const listed = (await w.get('/api/blasts')).json.blasts.find((b) => b.id === r.json.blast.id);
    assert.equal(listed.sent_count, 1, 'the list says the same as the send');
    assert.equal(listed.failed_count, 1);

    down = false;
    const again = await w.action('blast.resend', { id: r.json.blast.id });
    assert.deepEqual(again.json.resent, { sent: 1, failed: 0, skipped: 0 });
    assert.deepEqual(again.json.counts, { total: 2, sent: 2, failed: 0, queued: 0 });
    assert.equal(again.json.blast.status, 'sent');
    assert.deepEqual(sent.map((m) => m.to[0]), ['half.one@example.org', 'half.two@example.org']);
  }, { fail: (to) => down && to === 'half.two@example.org' });

  // Email disconnected again: refused, and the counts stay what they are.
  delete process.env.RESEND_API_KEY;
  const blast = (await w.get('/api/blasts')).json.blasts[0];
  assert.equal((await w.action('blast.resend', { id: blast.id })).status, 409);
});

test('blast.resend: desk roles only, own workspace only', async () => {
  delete process.env.RESEND_API_KEY;
  const saved = await c.action('blast.send', { kind: 'newsletter', subject: 'Desk only', body: 'b' });
  const id = saved.json.blast.id;
  const inv = await c.action('member.invite', { email: 'vol.resend@example.org', role: 'volunteer' });
  const vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Resend Vol', password: 'knock-knock-2026' });
  assert.equal((await vol.action('blast.resend', { id })).status, 403);
  assert.ok(!(await vol.get('/api/actions')).json.actions.includes('blast.resend'));
  assert.ok((await c.get('/api/actions')).json.actions.includes('blast.resend'));

  const other = new Client();
  await other.signup({ workspaceName: 'Someone Else' });
  await withEmailProvider(async (sent) => {
    assert.equal((await other.action('blast.resend', { id })).status, 404, 'another campaign cannot send it');
    assert.equal(sent.length, 0);
  });
  assert.equal((await c.action('blast.resend', { id: '99999999-9999-4999-8999-999999999999' })).status, 404);
});
