// The website's join and donate forms through to a payment landing — the
// site server, payments and the gift/membership paths together (each was
// built and tested on its own; this proves they meet). A youth member pays
// the youth rate; their birth date and citizenship reach the membership; a
// donation lands as a gift with its receipt; over the limit is refused
// before Stripe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { startFakeStripe } from './fake-stripe.js';

const SECRET = 'whsec_site_payments_test';
const KEY = 'sk_test_site_payments';
const ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_BASE'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tag = Math.random().toString(36).slice(2, 8);
const yr = new Date().getFullYear();
let fake, mgr, db;

const deliver = async (raw, headers) => {
  const r = await app.request('/stripe/webhook', { method: 'POST', headers, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const form = async (kind, body) => {
  const r = await app.request(`/site/api/forms/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const sessionOf = (url) => /\/pay\/([^/?#]+)/.exec(url || '')?.[1];
const who = (first, extra = {}) => ({ first_name: first, last_name: 'Example', email: `${first.toLowerCase()}.${tag}@example.org`, postal_code: 'V3T 1V8', ...extra });

before(async () => {
  db = await freshDb();
  fake = await startFakeStripe({ secret: SECRET, deliver, apiKey: KEY });
  Object.assign(process.env, { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_BASE: fake.url });
  mgr = new Client();
  await mgr.signup({ workspaceName: `Site money ${tag}`, jurisdiction: 'bc-municipal' });
  assert.equal((await mgr.get('/api/site')).status, 200, 'the site is seeded');
});

after(async () => {
  await fake?.close();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('a youth member joins on the website at the youth rate; their birth date and citizenship reach the membership', async () => {
  const birth = `${yr - 20}-05-06`;
  const r = await form('join', who('Yuna', { birth_date: birth, citizenship: 'pr', term: 1, amount_cents: 500, declaration: true, address: '13450 104 Ave', city: 'Surrey' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const session = sessionOf(r.json.checkout_url);
  assert.ok(session, `a checkout: ${r.json.checkout_url}`);
  await fake.pay(session);
  const m = (await db.query(
    `select m.youth, m.citizenship, m.source, m.term_years from member_terms m join persons p on p.id = m.person_id where p.email = $1`,
    [`yuna.${tag}@example.org`],
  )).rows;
  assert.deepEqual(m.map((x) => [x.youth, x.citizenship, x.source, x.term_years]), [[true, 'pr', 'website', 1]]);
});

test('an adult paying the youth rate is told the minimum before Stripe', async () => {
  const before = fake.calls.length;
  const r = await form('join', who('Adam', { birth_date: `${yr - 45}-01-01`, citizenship: 'citizen', term: 1, amount_cents: 500, declaration: true }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /(smallest membership is|at least) \$10/i);
  assert.equal(fake.calls.length, before, 'Stripe never asked');
});

test('a donation on the website lands as a gift with its receipt; over the limit is refused before Stripe', async () => {
  const r = await form('donate', who('Dora', { amount_cents: 5000, cadence: 'once', declaration: true, address: '13460 104 Ave', city: 'Surrey' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await fake.pay(sessionOf(r.json.checkout_url));
  const g = (await db.query(
    `select g.amount_cents, g.method from gifts g join persons p on p.id = g.person_id where p.email = $1 and g.deleted_at is null`,
    [`dora.${tag}@example.org`],
  )).rows;
  assert.deepEqual(g.map((x) => [x.amount_cents, x.method]), [[5000, 'card']]);
  const receipts = (await db.query(
    `select count(*)::int as n from receipts r join gifts g on g.id = r.gift_id join persons p on p.id = g.person_id where p.email = $1`,
    [`dora.${tag}@example.org`],
  )).rows[0].n;
  assert.equal(receipts, 1, 'the receipt, by itself');
  const before = fake.calls.length;
  const over = await form('donate', who('Dora', { amount_cents: 500000, cadence: 'once', declaration: true }));
  assert.equal(over.status, 400);
  assert.doesNotMatch(over.json.error, /\$50/, 'never says what they gave');
  assert.equal(fake.calls.length, before, 'Stripe never asked');
});
