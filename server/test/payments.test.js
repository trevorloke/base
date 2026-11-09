// Online payments (ext/payments) against a stand-in Stripe (fake-stripe.js):
// the website's forms open a checkout for someone already recorded
// (checkoutFor, run here as the site's form handler would run it); the
// donor pays on Stripe's page; Stripe's signed webhook lands the gift
// through the normal gift path — card, online, the declaration kept, the
// limit checked, the receipt issued — or the membership, or each month of a
// monthly gift (a pledge kept, stopped when the subscription is). Over the
// limit before checkout is refused in plain words; over the limit when the
// payment lands is refunded through Stripe, flagged for the treasurer and
// the donor emailed. Refunds and disputes from Stripe void or flag the gift.
// Each event once; a bad signature never gets in. The desk sees it all on
// Donations; Settings → Services shows Stripe and its webhook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runAction } from '../lib/events.js';
import { runDueJobs } from '../lib/jobs.js';
import { campaignDay } from '../lib/gifts.js';
import { checkoutFor, paymentsData, paymentsReady, STRIPE_EVENTS, DECLARATION } from '../ext/payments/index.js';
import { signPayload } from '../ext/payments/stripe.js';
import { startFakeStripe } from './fake-stripe.js';

const SECRET = 'whsec_payments_test_secret';
const KEY = 'sk_test_payments_0123456789';
const ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_BASE', 'RESEND_API_KEY', 'MAIL_FROM', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.pay.${tag}@example.org`;
const today = campaignDay(new Date(), 'America/Vancouver');
const SUCCESS = 'https://site.example.org/donate?sent=donate&session={CHECKOUT_SESSION_ID}';
const CANCEL = 'https://site.example.org/donate';

let db, fake, mgr, staff, vol, wsId;

// The webhook, in-process: what Stripe would POST.
const deliver = async (raw, headers) => {
  const r = await app.request('/stripe/webhook', { method: 'POST', headers, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const member = async (ws, role, who) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: `Temp ${who} ${tag}`, email: mail(who) });
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [r.json.user.id, ws, role]);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [r.json.user.id, ws]);
  return c;
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

// The site's form handler: the person is recorded, then the checkout opens
// inside the same write.
const open = (personId, opts = {}) => runAction(db, { workspaceId: wsId, actorId: null, action: 'site.form.donate' }, (tx, emit) => checkoutFor(tx, { workspaceId: wsId }, {
  personId, kind: 'donation', amountCents: 5000, cadence: 'once', slate: null, declaration: true,
  successUrl: SUCCESS, cancelUrl: CANCEL, metadata: { source: 'share-whatsapp', module_id: 'm-donate' }, ...opts,
}, emit)).then((r) => r.result);
const refused = async (personId, opts) => {
  try { await open(personId, opts); } catch (e) { return e; }
  assert.fail('expected the checkout to be refused');
  return null;
};

const donor = (first, extra = {}) => mgr.createPerson(`${first} Example`, { email: mail(first.toLowerCase()), address: '13450 104 Ave', city: 'Surrey', postal: 'V3T 1V8', ...extra });
const deskGift = async (person, cents, extra = {}) => ok(await mgr.action('gift.log', { person_id: person.id, amount_cents: cents, date: today, ...extra })).gift;
const giftsOf = async (personId) => (await db.query('select * from gifts where workspace_id = $1 and person_id = $2 order by created_at', [wsId, personId])).rows;
const paymentOf = async (where, v) => (await db.query(`select * from stripe_payments where workspace_id = $1 and ${where} = $2`, [wsId, v])).rows[0];
const sessionOf = (r) => fake.sessions.get(r.session_id);
const desk = async (c = mgr) => ok(await c.get('/api/payments'));
const verified = async () => assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);

// The email provider, stood in for (as in receipts.test.js).
const withEmail = async (fn) => {
  const realFetch = globalThis.fetch;
  const sent = [];
  const seen = new Set();
  process.env.RESEND_API_KEY = 're_test_payments';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const key = init.headers?.['Idempotency-Key'] || null;
      if (!(key && seen.has(key))) { if (key) seen.add(key); sent.push({ ...JSON.parse(init.body), key }); }
      return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try { return await fn(sent); } finally { globalThis.fetch = realFetch; delete process.env.RESEND_API_KEY; }
};

before(async () => {
  db = await freshDb();
  for (const k of ENV) delete process.env[k];
  fake = await startFakeStripe({ secret: SECRET, deliver, apiKey: KEY });
  Object.assign(process.env, { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_BASE: fake.url });
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `North Shore ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' });
  wsId = r.json.workspace.id;
  staff = await member(wsId, 'staff', 'staff');
  vol = await member(wsId, 'volunteer', 'vol');
});

after(async () => {
  await fake?.close();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('not set up: no checkout, the webhook says so, the site’s loaders say not ready', async () => {
  const p = await donor('Nora');
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    assert.equal(paymentsReady(), false);
    const e = await refused(p.id, {});
    assert.deepEqual([e.status, e.message], [503, 'Online payments aren’t set up yet.']);
    const w = await deliver(JSON.stringify({ id: 'evt_x', type: 'invoice.paid' }), { 'content-type': 'application/json' });
    assert.equal(w.status, 503);
    assert.equal((await paymentsData(db, { id: wsId })).ready, false);
  } finally {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  }
  assert.deepEqual(await paymentsData(db, { id: wsId }), { ready: true, mode: 'test', year: Number(today.slice(0, 4)), limit_cents: 142970, monthly_max_cents: 11900 });
});

test('a checkout needs the declaration; a gift once opens Stripe’s page with the amount, our ids and the way back', async () => {
  const p = await donor('Mina');
  const before = fake.calls.length;
  const e = await refused(p.id, { declaration: false });
  assert.deepEqual([e.status, e.field], [400, 'declaration']);
  assert.equal(fake.calls.length, before, 'nothing sent to Stripe');
  assert.equal((await refused(p.id, { amountCents: 50 })).field, 'amount_cents');
  assert.equal((await refused(p.id, { slate: 'mayor' })).field, 'slate');
  assert.equal((await refused(p.id, { kind: 'membership', cadence: 'monthly' })).field, 'cadence');
  assert.equal((await refused('00000000-0000-4000-8000-000000000000', {})).field, 'person');
  assert.equal((await db.query('select count(*)::int as n from stripe_checkouts where workspace_id = $1', [wsId])).rows[0].n, 0, 'a refusal keeps nothing');

  const r = await open(p.id);
  assert.match(r.url, new RegExp(`^${fake.url}/pay/cs_test_`));
  const call = fake.calls.find((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST' && c.idem === `base-checkout-${r.id}`);
  assert.ok(call, 'one idempotency key per checkout');
  const prm = call.params;
  assert.equal(prm.mode, 'payment');
  assert.equal(prm.submit_type, 'donate');
  assert.deepEqual(prm.line_items['0'].price_data, { currency: 'cad', unit_amount: '5000', product_data: { name: `Contribution to North Shore ${tag}` } });
  assert.deepEqual(prm.metadata, { base_checkout: r.id, base_workspace: wsId, base_kind: 'donation' });
  assert.deepEqual(prm.payment_intent_data.metadata, prm.metadata, 'on the payment too, so a refund or dispute finds it');
  assert.equal(prm.client_reference_id, r.id);
  assert.equal(prm.customer_email, mail('mina'));
  assert.deepEqual([prm.success_url, prm.cancel_url], [SUCCESS, CANCEL]);
  assert.equal(call.auth, `Bearer ${KEY}`);
  const co = (await db.query('select * from stripe_checkouts where id = $1', [r.id])).rows[0];
  assert.deepEqual([co.person_id, co.kind, co.cadence, co.amount_cents, co.slate, co.status, co.mode, co.session_id], [p.id, 'donation', 'once', 5000, 'council', 'open', 'test', r.session_id]);
  assert.equal(co.declaration.text, DECLARATION);
  assert.equal(co.declaration.source, 'website');
  assert.deepEqual(co.metadata, { source: 'share-whatsapp', module_id: 'm-donate' });
  const ev = (await db.query(`select action, payload from events where workspace_id = $1 and entity_type = 'payment_checkout' and entity_id = $2`, [wsId, r.id])).rows[0];
  assert.equal(ev.action, 'site.form.donate', 'on the event log with the form that opened it');
  assert.equal(ev.payload.declaration.text, DECLARATION);
});

test('a gift once: the webhook logs it through the gift path — card, online, the declaration kept — with its receipt', async () => {
  const p = await donor('Omar');
  const r = await open(p.id, { amountCents: 7500 });
  const [paid] = await fake.pay(r.session_id);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.result, 'gift recorded');
  const [g] = await giftsOf(p.id);
  assert.deepEqual([g.amount_cents, g.method, g.cadence, g.slate, g.note, g.flagged], [7500, 'card', 'one-time', 'council', 'Paid online', false]);
  assert.equal(g.date.toISOString().slice(0, 10), today, 'the campaign’s day it was paid');
  assert.equal(g.attrs.source, 'online');
  assert.equal(g.attrs.declaration.text, DECLARATION, 'the declaration kept with the gift');
  const giftEv = (await db.query(`select action, payload from events where workspace_id = $1 and entity_type = 'gift' and entity_id = $2`, [wsId, g.id])).rows[0];
  assert.equal(giftEv.action, 'stripe.payment');
  assert.equal(giftEv.payload.source, 'online');
  assert.equal(giftEv.payload.declaration.text, DECLARATION);
  const rc = ok(await mgr.get(`/api/receipts/gift/${g.id}`)).receipt;
  assert.match(rc.number, /^\d{4}-\d{4}$/, 'the receipt, issued by itself');
  assert.equal(rc.method, 'card');
  const pay = await paymentOf('gift_id', g.id);
  assert.deepEqual([pay.status, pay.amount_cents, pay.kind, pay.cadence], ['paid', 7500, 'donation', 'once']);
  assert.equal(pay.payment_intent, sessionOf(r).payment_intent);
  assert.equal((await db.query('select status from stripe_checkouts where id = $1', [r.id])).rows[0].status, 'paid');
  const d = await desk();
  assert.equal(d.gifts[g.id].word, 'Paid');
  assert.ok(d.recent.some((x) => x.gift_id === g.id && x.name === 'Omar Example' && x.word === 'Paid'));
  const ledger = ok(await mgr.get('/api/records/gift?limit=50')).records.find((x) => x.id === g.id);
  assert.equal(ledger.attrs.source, 'online', 'the ledger can mark it online');
  await verified();
});

test('each event once: a repeat, or a second event for the same payment, changes nothing', async () => {
  const p = await donor('Pia');
  const r = await open(p.id);
  const [first] = await fake.pay(r.session_id);
  const again = await fake.send(first.event.type, first.event.data.object, { id: first.event.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  const other = await fake.send('checkout.session.async_payment_succeeded', first.event.data.object);
  assert.equal(other.body.result, 'already recorded');
  assert.equal((await giftsOf(p.id)).length, 1, 'one gift');
  assert.equal((await db.query('select count(*)::int as n from stripe_events where id = $1', [first.event.id])).rows[0].n, 1);
  // Two deliveries of one new event at once: still one.
  const r2 = await open(p.id, { amountCents: 2000 });
  const s2 = fake.complete(r2.session_id);
  const both = await Promise.all([1, 2].map(() => fake.send('checkout.session.completed', s2, { id: `evt_same_${tag}` })));
  assert.deepEqual(both.map((x) => x.status), [200, 200]);
  assert.equal((await giftsOf(p.id)).length, 2);
  // Not ours (another app on the same Stripe account): left alone, 200.
  const theirs = await fake.send('checkout.session.completed', { id: 'cs_someone_else', object: 'checkout.session', mode: 'payment', metadata: { type: 'order' }, amount_total: 999 });
  assert.deepEqual([theirs.status, theirs.body.ignored], [200, 'not a base.win checkout']);
  await verified();
});

test('a bad signature, an old one, a changed body or none is refused, and nothing is read', async () => {
  const p = await donor('Quinn');
  const r = await open(p.id);
  const s = fake.complete(r.session_id);
  const evt = { id: `evt_forged_${tag}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: s } };
  const raw = JSON.stringify(evt);
  const post = (body, sig) => deliver(body, { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) });
  assert.equal((await post(raw, signPayload(raw, 'whsec_wrong'))).status, 400);
  assert.equal((await post(raw, signPayload(raw, SECRET, Math.floor(Date.now() / 1000) - 600))).status, 400, 'ten minutes old');
  assert.equal((await post(raw.replace('"cs_', '"cs_x'), signPayload(raw, SECRET))).status, 400, 'a changed body');
  const none = await post(raw, null);
  assert.equal(none.status, 400);
  assert.match(none.body.error, /no signature/);
  assert.equal((await giftsOf(p.id)).length, 0);
  assert.equal((await db.query('select count(*)::int as n from stripe_events where id = $1', [evt.id])).rows[0].n, 0);
  // Signed properly, the same event goes in.
  assert.equal((await post(raw, signPayload(raw, SECRET))).status, 200);
  assert.equal((await giftsOf(p.id)).length, 1);
});

test('monthly: the checkout keeps a pledge, each paid invoice is that month’s gift, cancelling in Stripe stops the pledge', async () => {
  const p = await donor('Rosa');
  const r = await open(p.id, { cadence: 'monthly', amountCents: 2500 });
  const prm = fake.calls.find((c) => c.idem === `base-checkout-${r.id}`).params;
  assert.equal(prm.mode, 'subscription');
  assert.deepEqual(prm.line_items['0'].price_data.recurring, { interval: 'month' });
  assert.equal(prm.line_items['0'].price_data.product_data.name, `Monthly contribution to North Shore ${tag}`);
  assert.deepEqual(prm.subscription_data.metadata, { base_checkout: r.id, base_workspace: wsId, base_kind: 'donation' });
  assert.equal(prm.payment_intent_data, undefined);

  const [started, firstMonth] = await fake.pay(r.session_id);
  assert.equal(started.body.result, 'monthly gift started');
  assert.equal(firstMonth.body.result, 'month’s gift recorded');
  const pledge = (await db.query('select * from gift_pledges where workspace_id = $1 and person_id = $2', [wsId, p.id])).rows;
  assert.equal(pledge.length, 1, 'one pledge');
  assert.deepEqual([pledge[0].amount_cents, pledge[0].method, pledge[0].stopped_at], [2500, 'card', null]);
  const sub = sessionOf(r).subscription;
  const second = await fake.invoice(sub);
  assert.equal(second.body.result, 'month’s gift recorded');
  const gifts = await giftsOf(p.id);
  assert.deepEqual(gifts.map((g) => [g.amount_cents, g.cadence, g.method, g.note]), [[2500, 'monthly', 'card', 'Paid online — monthly'], [2500, 'monthly', 'card', 'Paid online — monthly']]);
  for (const g of gifts) assert.ok(ok(await mgr.get(`/api/receipts/gift/${g.id}`)).receipt, 'each month gets its receipt');
  const pays = (await db.query('select * from stripe_payments where workspace_id = $1 and subscription_id = $2 order by created_at', [wsId, sub])).rows;
  assert.equal(pays.length, 2);
  assert.equal(pays[1].payment_intent, second.paymentIntent, 'the invoice’s payment found through Stripe (newer API versions leave it off)');
  assert.equal((await fake.send('invoice.paid', second.invoice)).body.result, 'already recorded', 'an invoice once');

  let d = await desk();
  const row = d.monthly.find((m) => m.person_id === p.id);
  assert.deepEqual([row.amount_cents, row.online, row.last_gift_on], [2500, true, today]);
  assert.ok(d.monthly_cents >= 2500);

  const cancel = await fake.cancel(sub);
  assert.equal(cancel.body.result, 'monthly gift stopped');
  assert.ok((await db.query('select stopped_at from gift_pledges where id = $1', [pledge[0].id])).rows[0].stopped_at);
  d = await desk();
  assert.ok(!d.monthly.some((m) => m.person_id === p.id), 'no longer a monthly donor');
  assert.equal((await giftsOf(p.id)).filter((g) => !g.deleted_at).length, 2, 'the months already given stay');
  await verified();
});

test('monthly, out of order and in the older API shape: the first invoice before the checkout’s own event still keeps one pledge', async () => {
  const p = await donor('Sami');
  const r = await open(p.id, { cadence: 'monthly', amountCents: 1500 });
  const s = fake.complete(r.session_id);
  const sub = fake.subscriptions.get(s.subscription);
  // An endpoint on an older API version: invoice.subscription and invoice.payment_intent.
  const inv = { id: `in_old_${tag}`, object: 'invoice', subscription: sub.id, subscription_details: { metadata: sub.metadata }, payment_intent: `pi_old_${tag}`,
    amount_paid: 1500, currency: 'cad', customer: sub.customer, status: 'paid', status_transitions: { paid_at: Math.floor(Date.now() / 1000) } };
  assert.equal((await fake.send('invoice.paid', inv)).body.result, 'month’s gift recorded');
  assert.equal((await fake.send('checkout.session.completed', s)).body.result, 'monthly gift started');
  assert.equal((await db.query('select count(*)::int as n from gift_pledges where workspace_id = $1 and person_id = $2 and stopped_at is null', [wsId, p.id])).rows[0].n, 1);
  assert.equal((await paymentOf('invoice_id', inv.id)).payment_intent, `pi_old_${tag}`);
  // An invoice that carries no metadata at all: the subscription is read from Stripe.
  const bare = { id: `in_bare_${tag}`, object: 'invoice', subscription: sub.id, amount_paid: 1500, currency: 'cad', status: 'paid', payment_intent: `pi_bare_${tag}` };
  await db.query('update stripe_checkouts set subscription_id = null where id = $1', [r.id]);
  assert.equal((await fake.send('invoice.paid', bare)).body.result, 'month’s gift recorded');
  assert.ok(fake.calls.some((c) => c.path === `/v1/subscriptions/${sub.id}`));
  assert.equal((await giftsOf(p.id)).length, 2);
});

test('membership dues: the gift, and the membership the way the membership form makes one (website, youth, citizen, member)', async () => {
  const yr = Number(today.slice(0, 4));
  const p = await donor('Tara');
  const birth = `${yr - 24}-02-01`;
  const opts = { kind: 'membership', term: 1, birthDate: birth, citizenship: 'citizen', declaration: 'I’m a Canadian citizen. I live in BC. These dues are my own money.' };
  assert.match((await refused(p.id, { ...opts, amountCents: 400 })).message, /The smallest membership is \$5\.00 for 1 year \(aged 14 to 30\)/);
  assert.match((await refused(p.id, { ...opts, birthDate: `${yr - 40}-01-01`, amountCents: 900 })).message, /The smallest membership is \$10\.00 for 1 year\./);
  assert.match((await refused(p.id, { ...opts, birthDate: `${yr - 12}-01-01`, amountCents: 1000 })).message, /Members are 14 or older/);
  assert.equal((await refused(p.id, { ...opts, term: 2 })).field, 'term');
  const r = await open(p.id, { ...opts, amountCents: 2500 });
  const prm = fake.calls.find((c) => c.idem === `base-checkout-${r.id}`).params;
  assert.equal(prm.line_items['0'].price_data.product_data.name, `North Shore ${tag} membership (1 year)`);
  assert.equal(prm.submit_type, 'pay');
  const [paid] = await fake.pay(r.session_id);
  assert.equal(paid.body.result, 'membership and gift recorded');
  const [g] = await giftsOf(p.id);
  assert.deepEqual([g.amount_cents, g.method, g.note], [2500, 'card', 'Membership dues — paid online']);
  assert.equal(g.attrs.declaration.text, opts.declaration, 'the words they ticked');
  const m = ok(await mgr.get(`/api/persons/${p.id}/membership`));
  assert.equal(m.member, true);
  assert.deepEqual([m.memberships[0].source, m.memberships[0].term_years, m.memberships[0].youth, m.memberships[0].citizenship, m.memberships[0].declaration_on],
    ['website', 1, true, 'citizen', today]);
  const tags = (await db.query('select tags from persons where id = $1', [p.id])).rows[0].tags;
  assert.ok(tags.includes('member'));
  // A renewal starts when the current term ends.
  const r2 = await open(p.id, { ...opts, term: 4, amountCents: 2000 });
  await fake.pay(r2.session_id);
  const m2 = ok(await mgr.get(`/api/persons/${p.id}/membership`));
  assert.equal(m2.memberships.length, 2);
  assert.equal(m2.memberships[0].starts_on, m.memberships[0].ends_on);
  await verified();
});

test('over the limit before checkout: refused in plain words (never their own giving), nothing sent, nothing kept', async () => {
  const p = await donor('Uma');
  await deskGift(p, 140000);
  const before = fake.calls.length;
  const e = await refused(p.id, { amountCents: 5000 });
  assert.deepEqual([e.status, e.field], [400, 'amount_cents']);
  assert.equal(e.message, 'That would take you over this year’s $1,429.70 limit for contributions to the city council slate. Try a smaller amount.');
  assert.ok(!/1,400/.test(e.message));
  assert.equal(fake.calls.length, before, 'Stripe never asked');
  assert.equal((await db.query('select count(*)::int as n from stripe_checkouts where person_id = $1', [p.id])).rows[0].n, 0);
  // What's left fits; the other slate is its own limit.
  assert.ok((await open(p.id, { amountCents: 2970 })).url);
  assert.ok((await open(p.id, { amountCents: 50000, slate: 'school_board' })).url);
  // Monthly: each payment left this year counts, and a whole year must fit.
  const q = await donor('Vik');
  assert.match((await refused(q.id, { cadence: 'monthly', amountCents: 20000 })).message, /The most a monthly gift can be this year is \$119\.00/);
  await deskGift(q, 135000);
  const monthly = await refused(q.id, { cadence: 'monthly', amountCents: 6000 });
  assert.match(monthly.message, /^A monthly gift of \$60\.00 would take you over this year’s \$1,429\.70 limit/);
  // A monthly gift already running counts against a new one.
  const w = await donor('Wren');
  await open(w.id, { cadence: 'monthly', amountCents: 6000 }).then((x) => fake.pay(x.session_id));
  assert.match((await refused(w.id, { cadence: 'monthly', amountCents: 6000 })).message, /would take you over/);
});

test('over the limit when it lands: no gift, refunded through Stripe, flagged for the treasurer, the donor emailed once', async () => {
  const p = await donor('Xena');
  const r = await open(p.id, { amountCents: 50000 });
  // Meanwhile the desk logs gifts from the same person.
  await deskGift(p, 100000);
  await deskGift(p, 30000);
  await withEmail(async (sent) => {
    const [landed] = await fake.pay(r.session_id);
    assert.equal(landed.status, 200);
    assert.equal(landed.body.result, 'over_limit');
    const live = (await giftsOf(p.id)).filter((g) => !g.deleted_at);
    assert.deepEqual(live.map((g) => g.amount_cents), [100000, 30000], 'no gift for the payment');
    let pay = await paymentOf('session_id', r.session_id);
    assert.deepEqual([pay.status, pay.over_limit, pay.gift_id], ['over_limit', true, null]);
    let d = await desk();
    assert.match(d.needs.find((x) => x.id === pay.id).line, /is being refunded/);

    await runDueJobs(db, { workspaceId: wsId });
    const call = fake.calls.find((c) => c.method === 'POST' && c.path === '/v1/refunds' && c.params.metadata?.base_payment === pay.id);
    assert.ok(call, 'refunded through Stripe');
    assert.deepEqual([call.params.payment_intent, call.params.amount, call.idem], [sessionOf(r).payment_intent, '50000', `base-over-limit-${pay.id}-50000`]);
    pay = await paymentOf('id', pay.id);
    assert.deepEqual([pay.status, pay.refunded_cents], ['refunded', 50000]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to[0], mail('xena'));
    assert.equal(sent[0].subject, `Your gift to North Shore ${tag} was refunded`);
    assert.match(sent[0].text, /^Hi Xena,/);
    assert.match(sent[0].text, /would have taken you over this year’s limit/);
    assert.ok(!/1,300|1,000/.test(sent[0].text), 'never their own giving');
    assert.ok(pay.donor_emailed_at);

    d = await desk(staff);
    const need = d.needs.find((x) => x.id === pay.id);
    assert.equal(need.word, 'Returned — over the limit');
    assert.match(need.line, /refunded in full; no gift was logged\. They were emailed\./);
    assert.equal(need.can_ack, true);
    // Run again: no second refund, no second email.
    await runDueJobs(db, { workspaceId: wsId });
    await fake.send('charge.refunded', { id: 'ch_x', object: 'charge', payment_intent: sessionOf(r).payment_intent, amount: 50000, amount_refunded: 50000, refunded: true });
    assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/refunds' && c.params.metadata?.base_payment === pay.id).length, 1);
    assert.equal(sent.length, 1);
    // Today: it rides with the gifts over the limit, for the desk only.
    const brief = ok(await mgr.get('/api/brief'));
    const onToday = brief.flagged.find((f) => f.payment_id === pay.id);
    assert.deepEqual([onToday?.donor, onToday?.amount_cents, onToday?.online], ['Xena Example', 50000, true]);
    assert.equal(ok(await vol.get('/api/brief')).flagged.length, 0, 'never a volunteer’s');
    // Got it.
    assert.equal((await vol.action('payment.ack', { id: pay.id })).status, 403);
    ok(await mgr.action('payment.ack', { id: pay.id }));
    assert.ok(!(await desk()).needs.some((x) => x.id === pay.id), 'off Needs you');
    assert.ok(!ok(await mgr.get('/api/brief')).flagged.some((f) => f.payment_id === pay.id), 'and off Today');
  });
  await verified();
});

test('a refund Stripe won’t make is the treasurer’s; once they refund it in Stripe the donor is told', async () => {
  const p = await donor('Yara');
  const r = await open(p.id, { amountCents: 40000 });
  await deskGift(p, 120000);
  fake.failRefunds('charge_disputed');
  await withEmail(async (sent) => {
    await fake.pay(r.session_id);
    await runDueJobs(db, { workspaceId: wsId });
    let pay = await paymentOf('session_id', r.session_id);
    assert.equal(pay.status, 'refund_failed');
    const need = (await desk()).needs.find((x) => x.id === pay.id);
    assert.match(need.line, /the refund didn’t go through \(Simulated: charge_disputed\)\. Refund \$400\.00 in Stripe\./);
    assert.equal(need.can_ack, false);
    fake.failRefunds(false);
    // The treasurer refunds it from Stripe's dashboard.
    await fake.refund(sessionOf(r).payment_intent);
    await runDueJobs(db, { workspaceId: wsId });
    pay = await paymentOf('id', pay.id);
    assert.equal(pay.status, 'refunded');
    assert.equal(sent.length, 1, 'the donor is emailed now');
  });
  fake.failRefunds(false);
});

test('refunds and disputes from Stripe: a full refund voids the gift and its receipt; a partial one and a dispute are flagged; a lost dispute voids', async () => {
  const p = await donor('Zoe');
  const pay1 = await open(p.id, { amountCents: 6000 });
  await fake.pay(pay1.session_id);
  const pi1 = sessionOf(pay1).payment_intent;
  const [g1] = await giftsOf(p.id);
  const full = await fake.refund(pi1);
  assert.equal(full.body.result, 'refunded: the gift is void');
  assert.ok((await giftsOf(p.id))[0].deleted_at, 'the gift is void');
  assert.equal(ok(await mgr.get(`/api/receipts/gift/${g1.id}`)).receipt.void, true, 'and so is its receipt');
  let d = await desk();
  const n1 = d.needs.find((x) => x.gift_id === g1.id);
  assert.deepEqual([n1.word, n1.line], ['Refunded', 'Refunded in Stripe — the gift is void.']);
  assert.equal((await fake.refund(pi1, 0)).body.result, 'already recorded');

  const pay2 = await open(p.id, { amountCents: 5000 });
  await fake.pay(pay2.session_id);
  const pi2 = sessionOf(pay2).payment_intent;
  assert.equal((await fake.refund(pi2, 1000)).body.result, 'partly refunded: flagged for the treasurer');
  const g2 = (await giftsOf(p.id)).find((g) => g.amount_cents === 5000);
  assert.equal(g2.deleted_at, null, 'a partial refund leaves the gift for the treasurer');
  d = await desk();
  assert.equal(d.needs.find((x) => x.gift_id === g2.id).line, '$10.00 of $50.00 was refunded in Stripe. The gift still says $50.00: void it and log $40.00.');
  assert.equal(d.gifts[g2.id].word, 'Partly refunded');

  const pay3 = await open(p.id, { amountCents: 4000 });
  await fake.pay(pay3.session_id);
  const pi3 = sessionOf(pay3).payment_intent;
  const g3 = (await giftsOf(p.id)).find((g) => g.amount_cents === 4000);
  assert.equal((await fake.dispute(pi3, 'created')).body.result, 'disputed: flagged for the treasurer');
  d = await desk();
  const n3 = d.needs.find((x) => x.gift_id === g3.id);
  assert.equal(n3.word, 'Disputed');
  assert.match(n3.line, /^The card holder disputed this payment with their bank\. Answer in Stripe by [A-Z][a-z]+ \d+ — the gift counts until it’s settled\.$/);
  assert.equal(d.gifts[g3.id].word, 'Disputed');
  assert.equal((await fake.dispute(pi3, 'won')).body.result, 'dispute won');
  assert.equal((await paymentOf('payment_intent', pi3)).status, 'paid');
  assert.equal((await giftsOf(p.id)).find((g) => g.id === g3.id).deleted_at, null);
  await fake.dispute(pi3, 'created');
  assert.equal((await fake.dispute(pi3, 'lost')).body.result, 'dispute lost: the gift is void');
  assert.ok((await giftsOf(p.id)).find((g) => g.id === g3.id).deleted_at);
  assert.equal((await desk()).needs.find((x) => x.gift_id === g3.id).word, 'Dispute lost');

  // A refunded membership's dues: the membership is void too.
  const m = await open(p.id, { kind: 'membership', term: 1, amountCents: 1000 });
  await fake.pay(m.session_id);
  assert.equal(ok(await mgr.get(`/api/persons/${p.id}/membership`)).member, true);
  await fake.refund(sessionOf(m).payment_intent);
  assert.equal(ok(await mgr.get(`/api/persons/${p.id}/membership`)).member, false, 'no dues, no membership');
  await verified();
});

test('a donor merged into another record while paying: the gift lands on the one kept; a deleted one is the treasurer’s to log', async () => {
  const p = await donor('Bea');
  const keep = await donor('Beatrice', { email: mail('beatrice') });
  const r = await open(p.id, { amountCents: 3000 });
  // ext/duplicates' merge: the record goes, pointing at the one kept.
  await db.query(`update persons set deleted_at = now(), attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{merged_into}', to_jsonb($2::text)) where id = $1`, [p.id, keep.id]);
  const [paid] = await fake.pay(r.session_id);
  assert.equal(paid.body.result, 'gift recorded');
  assert.equal((await giftsOf(keep.id)).length, 1, 'on the record kept');
  const gone = await donor('Cal');
  const r2 = await open(gone.id, { amountCents: 2000 });
  await db.query('update persons set deleted_at = now() where id = $1', [gone.id]);
  const [landed] = await fake.pay(r2.session_id);
  assert.equal(landed.body.result, 'no_donor');
  const need = (await desk()).needs.find((x) => x.person_id === gone.id);
  assert.match(need.line, /^Paid online, but the donor’s record was deleted — log the gift by hand/);
  assert.equal(need.can_ack, true);
  await verified();
});

test('an expired checkout is closed; nobody paid, nothing is logged', async () => {
  const p = await donor('Ava');
  const r = await open(p.id);
  assert.equal((await fake.expire(r.session_id)).body.result, 'checkout expired');
  assert.equal((await db.query('select status from stripe_checkouts where id = $1', [r.id])).rows[0].status, 'expired');
  assert.equal((await giftsOf(p.id)).length, 0);
});

test('the desk: Donations’ online side is the money roles’; volunteers get none of it', async () => {
  assert.equal((await vol.get('/api/payments')).status, 403);
  assert.equal((await new Client().get('/api/payments')).status, 401);
  const d = await desk(staff);
  assert.deepEqual(d.stripe, { ready: true, mode: 'test' });
  assert.ok(d.recent.length > 0);
  assert.ok(d.recent.every((x) => x.test === true), 'test-mode payments say so');
  assert.equal((await staff.action('payment.ack', { id: '00000000-0000-4000-8000-000000000000' })).status, 404);
});

test('Settings → Services: Stripe set up, not set up or in test mode, the webhook address, the events, and Check', async () => {
  process.env.STARBASE_PUBLIC_URL = 'https://base.example.org/northshore';
  try {
    const stripeRow = async () => ok(await mgr.get('/api/connections')).services.find((s) => s.key === 'stripe');
    let s = await stripeRow();
    assert.equal(s.state, 'test');
    assert.match(s.detail, /^Test mode/);
    assert.deepEqual(s.webhook, { url: 'https://base.example.org/northshore/stripe/webhook', events: STRIPE_EVENTS });
    assert.ok(!JSON.stringify(s).includes(KEY) && !JSON.stringify(s).includes(SECRET), 'never a key');
    const inbound = ok(await mgr.get('/api/connections')).inbound.find((i) => i.url.endsWith('/stripe/webhook'));
    assert.ok(inbound, 'listed with what comes in');
    fake.endpoints([]);
    let c = ok(await mgr.post('/api/connections/check', { key: 'stripe' }));
    assert.deepEqual([c.ok, c.said], [false, 'The key works (test mode), but no webhook in Stripe sends to https://base.example.org/northshore/stripe/webhook — add it']);
    fake.endpoints([{ id: 'we_1', url: 'https://base.example.org/northshore/stripe/webhook', status: 'enabled', enabled_events: STRIPE_EVENTS.slice(0, 5) }]);
    c = ok(await mgr.post('/api/connections/check', { key: 'stripe' }));
    assert.match(c.said, /^The webhook is there, but it doesn’t send customer\.subscription\.updated/);
    fake.endpoints([{ id: 'we_1', url: 'https://base.example.org/northshore/stripe/webhook', status: 'enabled', enabled_events: STRIPE_EVENTS }]);
    c = ok(await mgr.post('/api/connections/check', { key: 'stripe' }));
    assert.deepEqual([c.ok, c.said], [true, 'The key works (test mode) and the webhook sends every event base.win needs']);
    process.env.STRIPE_SECRET_KEY = 'sk_live_not_real';
    s = await stripeRow();
    assert.deepEqual([s.state, s.detail], ['ready', 'Live — gifts are real money']);
    delete process.env.STRIPE_SECRET_KEY;
    s = await stripeRow();
    assert.deepEqual([s.state, s.missing], ['missing', ['STRIPE_SECRET_KEY']]);
    assert.equal(ok(await mgr.post('/api/connections/check', { key: 'stripe' })).said, 'STRIPE_SECRET_KEY isn’t set');
  } finally {
    process.env.STRIPE_SECRET_KEY = KEY;
    delete process.env.STARBASE_PUBLIC_URL;
  }
});
