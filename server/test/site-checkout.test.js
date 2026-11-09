// What the website's forms may never do (review A1) — join and donate
// through to Stripe (a stand-in, fake-stripe.js), the contact form, the
// referral link, the consent and declaration words:
//
//   · a name and a postal code (or a phone) that match a voter never put
//     their email on Stripe's page, and never hang money on their record:
//     only the email the visitor typed goes to Stripe; money lands on a
//     record the same email matched, or on someone new;
//   · Stripe is never asked while the campaign's write is open, a retry with
//     the same client_key is one action and one checkout, and a Stripe
//     failure leaves the retry able to succeed — but the same key with
//     other details (a typo put right, the next person at a shared tablet)
//     is a new action with its own person and checkout, and Stripe refusing
//     the email typed is a 400 on the email;
//   · one donor on two records (another email, a cheque at the desk) is
//     added up for the year's limit when the money lands: over together,
//     the gift is flagged for the treasurer, never refunded;
//   · what someone gave before never changes the answer (no per-person room
//     check before checkout), and a refusal is a 400 in plain words, never a
//     500;
//   · join never overwrites a birth date or citizenship on file;
//   · a referral code is found through its index;
//   · a website message never pushes a note off a record;
//   · the declaration and consent words kept are the words shown;
//   · the same key with another amount is a fresh checkout;
//   · volunteers can't see or sort who used the money forms.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../index.js';
import { runAction } from '../lib/events.js';
import { campaign, send, hit, ok, member } from './site-helpers.js';
import { startFakeStripe } from './fake-stripe.js';
import { personOfCode, refCodeFor } from '../ext/site/people.js';
import { _setPaymentsForTest } from '../ext/site/payments.js';

const SECRET = 'whsec_site_checkout_test';
const KEY = 'sk_test_site_checkout';
const ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_BASE'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tag = Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let fake, db, mgr, ws;

// Stripe with a hand on the tap: hold() parks the next checkout request
// until it is let go; failNext makes the next ones fail as an outage would;
// loseNext lets Stripe make the page and loses its answer on the way back;
// an address in refuseEmails is one Stripe calls invalid (a 400 on
// customer_email, as Stripe answers an email it won't take).
const realFetch = globalThis.fetch;
let held = null;
let failNext = 0;
let loseNext = 0;
const refuseEmails = new Set();
const hold = () => {
  let reached;
  let release;
  const at = new Promise((r) => { reached = r; });
  const go = new Promise((r) => { release = r; });
  held = { reached, wait: go };
  return { at, release };
};

const deliver = async (raw, headers) => {
  const r = await app.request('/stripe/webhook', { method: 'POST', headers, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const sessionsPosted = () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions');
const sessionOf = (url) => /\/pay\/([^/?#]+)/.exec(url || '')?.[1];
const checkoutsOf = async (personId) => (await db.query('select * from stripe_checkouts where workspace_id = $1 and person_id = $2 order by created_at', [ws, personId])).rows;
const checkoutOfSession = async (session) => (await db.query('select * from stripe_checkouts where session_id = $1', [session])).rows[0];
const actionsKeyed = async (key) => (await db.query('select * from site_actions where workspace_id = $1 and client_key like $2', [ws, `%${key}%`])).rows;
const fieldIds = async () => Object.fromEntries((await db.query(
  "select id, lower(name) as n from person_fields where workspace_id = $1 and lower(name) in ('birth date', 'citizenship')", [ws],
)).rows.map((f) => [f.n, f.id]));
const fieldValues = async (personId) => Object.fromEntries((await db.query(
  `select lower(f.name) as n, v.value from person_field_values v join person_fields f on f.id = v.field_id
    where v.workspace_id = $1 and v.person_id = $2 and lower(f.name) in ('birth date', 'citizenship')`, [ws, personId],
)).rows.map((r) => [r.n, r.value]));
const unescape = (s) => s.replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// The words beside a tick box, as the page draws them.
const boxWords = (html, name, after = 0) => {
  const re = new RegExp(`<input type="checkbox"[^>]*name="${name}"[^>]*/><span>([^<]*)</span>`, 'g');
  re.lastIndex = after;
  const m = re.exec(html);
  return m ? unescape(m[1]) : null;
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
const withinTwo = async (p) => Promise.race([p.then(() => 'done'), sleep(2000).then(() => 'blocked')]);

before(async () => {
  ({ db, mgr, ws } = await campaign());
  fake = await startFakeStripe({ secret: SECRET, deliver, apiKey: KEY });
  Object.assign(process.env, { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_BASE: fake.url });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith(fake.url) && String(url).includes('/v1/checkout/sessions') && init.method === 'POST') {
      if (held) { const h = held; held = null; h.reached(); await h.wait; }
      if (failNext > 0) {
        failNext -= 1;
        return new Response(JSON.stringify({ error: { type: 'api_error', message: 'Simulated outage' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      const email = new URLSearchParams(String(init.body || '')).get('customer_email');
      if (email && refuseEmails.has(email)) {
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error', param: 'customer_email', message: `Invalid email address: ${email}` } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      if (loseNext > 0) {
        loseNext -= 1;
        await realFetch(url, init);
        throw new TypeError('fetch failed');
      }
    }
    return realFetch(url, init);
  };
  ok(await mgr.get('/api/site'));
});

after(async () => {
  globalThis.fetch = realFetch;
  _setPaymentsForTest(null);
  await fake?.close();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('a name and postal code (or phone) matching a voter never reach their email, and the money is never theirs', async () => {
  const voter = ok(await mgr.action('person.create', { name: 'Victoria Target', email: `victoria.private.${tag}@example.org`, postal: 'V3T 1V8', phone: '604-555-0199' })).person;
  const tries = [
    ['donate', { first_name: 'Victoria', last_name: 'Target', email: `stranger.${tag}@example.net`, phone: '778-000-1234', postal_code: 'v3t1v8', amount_cents: 500, cadence: 'once', declaration: true }],
    ['donate', { first_name: 'Victoria', last_name: 'Target', email: `attacker.${tag}@example.net`, postal_code: 'V3T 1V8', amount_cents: 500, cadence: 'once', declaration: true }],
    ['donate', { first_name: 'Victoria', last_name: 'Target', email: `caller.${tag}@example.net`, phone: '604-555-0199', amount_cents: 500, cadence: 'once', declaration: true }],
    ['join', { first_name: 'Victoria', last_name: 'Target', email: `joiner.${tag}@example.net`, phone: '778-000-4321', postal_code: 'V3T 1V8', declaration: true, birth_date: '1980-01-01', citizenship: 'citizen' }],
  ];
  const keys = [];
  for (const [kind, body] of tries) {
    const before = sessionsPosted().length;
    const r = ok(await send(kind, body), `${kind} ${JSON.stringify(body).slice(0, 60)}`);
    keys.push(Object.keys(r).sort().join(','));
    const call = sessionsPosted().slice(before).at(-1);
    assert.ok(call, 'Stripe was asked for a checkout');
    assert.notEqual(call.params.customer_email, voter.email, 'the voter’s email never goes to Stripe');
    assert.equal(call.params.customer_email, body.email, 'only the email the visitor typed (or none)');
    const co = await checkoutOfSession(sessionOf(r.checkout_url));
    assert.ok(co, 'the checkout is kept');
    assert.notEqual(co.person_id, voter.id, 'the money never lands on a record matched by name alone');
  }
  assert.equal(new Set(keys).size, 1, 'every answer has the same shape');
  // The same email is the same person: their own email, typed, is theirs to see.
  const own = ok(await send('donate', { first_name: 'Vicky', last_name: 'Target', email: voter.email, amount_cents: 500, cadence: 'once', declaration: true }));
  const co = await checkoutOfSession(sessionOf(own.checkout_url));
  assert.equal(co.person_id, voter.id, 'an email match carries the money');
  assert.equal(sessionsPosted().at(-1).params.customer_email, voter.email);
});

test('Stripe is never asked while the campaign’s write is open', async () => {
  const tap = hold();
  const form = send('donate', { first_name: 'Sol', last_name: 'Example', email: `sol.${tag}@example.org`, amount_cents: 2500, cadence: 'once', declaration: true });
  await tap.at; // the form is inside its Stripe call now
  const probe = runAction(db, { workspaceId: ws, actorId: null, action: 'test.probe' }, async (tx, emit) => { emit('probe', ws, 'update', {}); return true; });
  const seen = await withinTwo(probe);
  tap.release();
  await probe;
  const r = await form;
  assert.equal(seen, 'done', 'another write to the campaign went ahead while Stripe was asked');
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.checkout_url);
});

test('a retry with the same client_key is one action and one checkout; a Stripe failure leaves the retry able to succeed', async () => {
  const email = `rita.${tag}@example.org`;
  const body = { first_name: 'Rita', last_name: 'Example', email, amount_cents: 3000, cadence: 'once', declaration: true, client_key: `retry-${tag}` };
  failNext = 1;
  const down = await send('donate', body);
  assert.equal(down.status, 503, down.text);
  assert.match(down.json.error, /payment service/);
  assert.equal(down.json.checkout_url, undefined);
  const again = ok(await send('donate', body), 'the retry');
  assert.ok(sessionOf(again.checkout_url), again.checkout_url);
  const third = ok(await send('donate', body), 'once more');
  assert.equal(third.checkout_url, again.checkout_url, 'the same checkout, again');
  const actions = await actionsKeyed(`retry-${tag}`);
  assert.equal(actions.length, 1, 'one action');
  const cos = await checkoutsOf(actions[0].person_id);
  assert.equal(cos.filter((c) => c.session_id).length, 1, 'one checkout with a Stripe page');
  assert.ok(cos.every((c) => c.amount_cents === 3000));
  // Two at once with one key (a double tap): one action, one checkout, one page.
  const twin = { ...body, client_key: `twin-${tag}`, email: `twin.${tag}@example.org` };
  const before = fake.sessions.size;
  const [a, b] = await Promise.all([send('donate', twin), send('donate', twin)]);
  assert.deepEqual([a.status, b.status], [200, 200], `${a.text} ${b.text}`);
  assert.equal(a.json.checkout_url, b.json.checkout_url);
  assert.equal(fake.sessions.size, before + 1, 'Stripe made one page');
  assert.equal((await actionsKeyed(`twin-${tag}`)).length, 1);
});

test('an identical resend after a lost answer finishes the same checkout', async () => {
  const body = { first_name: 'Lou', last_name: 'Lost', email: `lou.${tag}@example.org`, amount_cents: 2500, cadence: 'once', declaration: true, client_key: `lost-${tag}` };
  const before = fake.sessions.size;
  loseNext = 1;
  const lost = await send('donate', body);
  assert.equal(lost.status, 503, lost.text);
  assert.equal(fake.sessions.size, before + 1, 'Stripe made the page; its answer was lost');
  const made = [...fake.sessions.values()].at(-1);
  const again = ok(await send('donate', body), 'the resend');
  assert.equal(again.checkout_url, made.url, 'the page Stripe made, not a second one');
  assert.equal(fake.sessions.size, before + 1);
  assert.equal((await actionsKeyed(`lost-${tag}`)).length, 1, 'one action');
});

test('after a Stripe outage, the next person sending from the same page gets their own record and checkout', async () => {
  const key = `kiosk-${tag}`;
  const alice = { first_name: 'Alice', last_name: 'First', email: `alice.${tag}@example.org`, phone: '604-555-0101', amount_cents: 5000, cadence: 'once', declaration: true, client_key: key };
  const bob = { first_name: 'Bob', last_name: 'Second', email: `bob.${tag}@example.org`, amount_cents: 5000, cadence: 'once', declaration: true, client_key: key };
  failNext = 1;
  const down = await send('donate', alice);
  assert.equal(down.status, 503, down.text);
  const his = ok(await send('donate', bob), 'Bob, the same amount, the same page');
  assert.equal(sessionsPosted().at(-1).params.customer_email, bob.email, 'Stripe’s page starts with Bob’s email');
  const co = await checkoutOfSession(sessionOf(his.checkout_url));
  const who = (await db.query('select name, email from persons where id = $1', [co.person_id])).rows[0];
  assert.deepEqual([who.name, who.email], ['Bob Second', bob.email], 'the money would be Bob’s');
  // Alice, sending hers again as it was, still finishes her own.
  const hers = ok(await send('donate', alice), 'Alice again');
  assert.notEqual(hers.checkout_url, his.checkout_url);
  assert.equal(sessionsPosted().at(-1).params.customer_email, alice.email);
  assert.equal((await actionsKeyed(key)).length, 2, 'two forms, two actions');
});

test('Stripe refusing the typed email is a 400 on the email, in plain words', async () => {
  const typo = `tia.${tag}@exmaple.org`;
  refuseEmails.add(typo);
  const r = await send('donate', { first_name: 'Tia', last_name: 'Typo', email: typo, amount_cents: 2500, cadence: 'once', declaration: true, client_key: `refused-${tag}` });
  assert.deepEqual([r.status, r.json?.field], [400, 'email'], r.text);
  assert.equal(r.json.error, 'That email address doesn’t look right. Check it and try again.');
  const plain = await hit('/site/api/forms/donate', { form: { first_name: 'Tia', last_name: 'Typo', email: typo, amount_cents: '2500', declaration: 'on', module_id: 'donate' } });
  assert.deepEqual([plain.status, plain.location], [303, '/site/?error=email&module=donate#m-donate']);
});

test('after Stripe refused the typed email, the corrected send is a new checkout with the corrected email', async () => {
  const typo = `tim.${tag}@exmaple.org`;
  const fixed = `tim.${tag}@example.org`;
  refuseEmails.add(typo);
  const body = { first_name: 'Tim', last_name: 'Typo', amount_cents: 2500, cadence: 'once', declaration: true, client_key: `typo-${tag}` };
  const first = await send('donate', { ...body, email: typo });
  assert.notEqual(first.status, 200, first.text);
  const again = await send('donate', { ...body, email: fixed });
  assert.equal(again.status, 200, again.text);
  assert.equal(sessionsPosted().at(-1).params.customer_email, fixed, 'Stripe’s page starts with the corrected email');
  const co = await checkoutOfSession(sessionOf(again.json.checkout_url));
  const who = (await db.query('select email from persons where id = $1', [co.person_id])).rows[0];
  assert.equal(who.email, fixed, 'the money would be the corrected email’s');
});

test('what someone gave before never changes the answer; a refusal is a 400 in plain words, never a 500', async () => {
  const donor = ok(await mgr.action('person.create', { name: 'Dana Donor', email: `dana.${tag}@example.org`, postal: 'V3S 2A1' })).person;
  ok(await mgr.action('gift.log', { person_id: donor.id, amount_cents: 73_400, date: today(), method: 'cheque' }));
  // Over what she has left this year, under the year's limit: off to pay,
  // as anyone would be (the payment is checked when it lands).
  for (const who of [{ email: `not.dana.${tag}@example.org`, postal_code: 'V3S2A1' }, { email: donor.email }]) {
    const r = await send('donate', { first_name: 'Dana', last_name: 'Donor', ...who, amount_cents: 100_000, cadence: 'once', declaration: true });
    assert.equal(r.status, 200, `${JSON.stringify(who)} ${r.text.slice(0, 200)}`);
    assert.ok(r.json.checkout_url);
  }
  // What no one may give is refused, naming only the limit.
  const over = await send('donate', { first_name: 'Dana', last_name: 'Donor', email: donor.email, amount_cents: 150_000, cadence: 'once', declaration: true });
  assert.deepEqual([over.status, over.json.field], [400, 'amount_cents']);
  assert.match(over.json.error, /\$1,429\.70/);
  assert.doesNotMatch(over.json.error, /734|695/);
  // A refusal from the payments side: a 400 with its field (and, without
  // JavaScript, back to the form with ?error=), never a 500.
  const refusal = Object.assign(new Error('That amount can’t be taken online.'), { status: 400, field: 'amount_cents' });
  _setPaymentsForTest({
    paymentsReady: () => true,
    checkoutFor: async () => { throw refusal; },
    prepareCheckout: async () => { throw refusal; },
  });
  try {
    const r = await send('donate', { first_name: 'Ana', email: `ana.${tag}@example.org`, amount_cents: 2500, declaration: true });
    assert.deepEqual([r.status, r.json?.field, r.json?.error], [400, 'amount_cents', 'That amount can’t be taken online.'], r.text);
    const plain = await hit('/site/api/forms/donate', { form: { email: `ana2.${tag}@example.org`, amount_cents: '2500', declaration: 'on', module_id: 'donate' } });
    assert.deepEqual([plain.status, plain.location], [303, '/site/?error=amount_cents&module=donate#m-donate']);
  } finally {
    _setPaymentsForTest(null);
  }
});

test('join never overwrites a birth date or citizenship on file; it fills what is empty for the same email', async () => {
  const f = await fieldIds();
  const set = (personId, birth, cz) => mgr.action('field.values.set', { person_id: personId, values: [{ field_id: f['birth date'], value: birth }, { field_id: f.citizenship, value: cz }] });
  const elder = ok(await mgr.action('person.create', { name: 'Bert Elder', email: `bert.${tag}@example.org`, postal: 'V4A 9Z9' })).person;
  ok(await set(elder.id, '1950-03-04', 'Canadian citizen'));
  const kept = { 'birth date': '1950-03-04', citizenship: 'Canadian citizen' };
  ok(await send('join', { first_name: 'Bert', last_name: 'Elder', email: `not.bert.${tag}@example.org`, phone: '604-111-2222', postal_code: 'V4A 9Z9', birth_date: '2008-01-01', citizenship: 'pr', declaration: true }));
  assert.deepEqual(await fieldValues(elder.id), kept, 'a name and postal code change nothing on file');
  ok(await send('join', { first_name: 'Bert', last_name: 'Elder', email: elder.email, birth_date: '2008-01-01', citizenship: 'pr', declaration: true }));
  assert.deepEqual(await fieldValues(elder.id), kept, 'the same email fills only what is empty');
  const blank = ok(await mgr.action('person.create', { name: 'Fay Blank', email: `fay.${tag}@example.org` })).person;
  ok(await send('join', { first_name: 'Fay', last_name: 'Blank', email: blank.email, birth_date: '1990-04-21', citizenship: 'pr', declaration: true }));
  assert.deepEqual(await fieldValues(blank.id), { 'birth date': '1990-04-21', citizenship: 'Permanent resident' });
});

test('a referral code is found through its index, never by reading every record', async () => {
  ok(await send('newsletter', { first_name: 'Rae', email: `rae.${tag}@example.org`, consent_email: true }));
  const rae = (await db.query('select id, attrs from persons where workspace_id = $1 and lower(email) = $2', [ws, `rae.${tag}@example.org`])).rows[0];
  const someone = ok(await mgr.action('person.create', { name: 'Sid Nocode' })).person;
  // The queries as people.js sends them.
  const seen = [];
  const recording = (q) => ({ query: (sql, params) => { seen.push({ sql, params }); return q.query(sql, params); } });
  assert.equal(await personOfCode(recording(db), ws, rae.attrs.ref_code), rae.id);
  await runAction(db, { workspaceId: ws, actorId: null, action: 'test.refcode' }, (tx, emit) => refCodeFor(recording(tx), ws, someone.id, emit));
  const byCode = seen.filter((s) => /ref_code'\s*=\s*\$2/.test(s.sql));
  assert.ok(byCode.length >= 2, `both lookups seen: ${seen.map((s) => s.sql.replace(/\s+/g, ' ').slice(0, 80)).join(' | ')}`);
  for (const s of byCode) {
    const plan = await db.transaction(async (tx) => {
      await tx.query('set local enable_seqscan = off');
      return (await tx.query(`explain ${s.sql}`, s.params)).rows.map((r) => Object.values(r)[0]).join('\n');
    });
    assert.match(plan, /persons_ref_code_idx/, `${s.sql.replace(/\s+/g, ' ')}\n${plan}`);
  }
});

test('a website message never pushes a note off a record', async () => {
  const words = 'Call after 6 — needs a ride to the polls';
  const nora = ok(await mgr.action('person.create', { name: 'Nora Notes', email: `nora.${tag}@example.org`, postal: 'V3W 1A1' })).person;
  await db.query(`update persons set attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{note}', to_jsonb($2::text)) where id = $1`, [nora.id, words]);
  const long = `Please call me. ${'x'.repeat(3970)}`;
  ok(await send('contact', { first_name: 'Nora', last_name: 'Notes', phone: '604-999-0000', postal_code: 'V3W1A1', message: long }));
  ok(await send('contact', { first_name: 'Nora', last_name: 'Notes', email: nora.email, message: `${long} again`, topic: 'Rides' }));
  const after = (await db.query('select attrs from persons where id = $1', [nora.id])).rows[0].attrs;
  assert.equal(after.note, words, 'their own note, as it was');
  // The message is kept beside the record: the action, and a request for the desk.
  const acts = (await db.query("select payload from site_actions where workspace_id = $1 and person_id = $2 and kind = 'contact' order by created_at", [ws, nora.id])).rows;
  assert.deepEqual(acts.map((a) => a.payload.message), [long, `${long} again`]);
  const reqs = (await db.query("select kind, note from door_requests where workspace_id = $1 and person_id = $2 order by created_at", [ws, nora.id])).rows;
  assert.equal(reqs.length, 2);
  assert.ok(reqs.every((r) => r.kind === 'other'));
  assert.ok(reqs[0].note.includes(long) && reqs[1].note.includes('(Rides)'), reqs.map((r) => r.note.slice(0, 40)).join(' | '));
});

test('the declaration kept with a gift or a membership is the one the visitor ticked', async () => {
  const donatePage = await hit('/site/donate');
  assert.equal(donatePage.status, 200);
  const shownGift = boxWords(donatePage.text, 'declaration');
  assert.ok(shownGift && shownGift.length > 20, `the donate form shows a declaration: ${shownGift}`);
  const gift = ok(await send('donate', { first_name: 'Dee', last_name: 'Clare', email: `dee.${tag}@example.org`, amount_cents: 2500, cadence: 'once', declaration: true }));
  assert.equal((await checkoutOfSession(sessionOf(gift.checkout_url))).declaration.text, shownGift);
  const home = await hit('/site/');
  const joinAt = home.text.indexOf('data-module="join"');
  assert.ok(joinAt > 0, 'the home page has the join form');
  const shownJoin = boxWords(home.text, 'declaration', joinAt);
  assert.ok(shownJoin && shownJoin.length > 20, `the join form shows a declaration: ${shownJoin}`);
  const joined = ok(await send('join', { first_name: 'Jo', last_name: 'Clare', email: `jo.${tag}@example.org`, birth_date: '1985-06-01', citizenship: 'citizen', declaration: true }));
  assert.equal((await checkoutOfSession(sessionOf(joined.checkout_url))).declaration.text, shownJoin);
});

test('the same key with another amount (back from Stripe, a new choice) opens a fresh checkout', async () => {
  const body = { first_name: 'Cam', last_name: 'Back', email: `cam.${tag}@example.org`, amount_cents: 5000, cadence: 'monthly', declaration: true, client_key: `back-${tag}` };
  const first = ok(await send('donate', body));
  const second = ok(await send('donate', { ...body, amount_cents: 10000, cadence: 'once' }));
  assert.notEqual(second.checkout_url, first.checkout_url);
  const s = fake.sessions.get(sessionOf(second.checkout_url));
  assert.deepEqual([s.amount_total, s.mode], [10000, 'payment']);
  assert.equal(ok(await send('donate', body)).checkout_url, first.checkout_url, 'the first choice, again, is the first checkout');
});

test('volunteers can’t see or sort who used the money forms', async () => {
  const vol = await member(mgr, 'volunteer', 'Vic Example');
  ok(await send('donate', { first_name: 'Gil', last_name: 'Giver', email: `gil.${tag}@example.org`, amount_cents: 2500, cadence: 'once', declaration: true }));
  ok(await send('join', { first_name: 'Jan', last_name: 'Joiner', email: `jan.${tag}@example.org`, declaration: true }));
  for (const t of ['Website: donate', 'Website: join']) {
    const r = await vol.client.get(`/api/persons?tag=${encodeURIComponent(t)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.persons.map((p) => p.name), [], t);
  }
  const rows = (await vol.client.get(`/api/persons?q=${encodeURIComponent('Giver')}`)).json.persons;
  assert.ok(rows.length >= 1, 'the volunteer still finds the person');
  assert.ok(rows.every((p) => !p.tags.some((x) => /^website: (donate|join)$/i.test(x))), JSON.stringify(rows.map((p) => p.tags)));
  // The desk still finds them by what they did on the website.
  const desk = ok(await mgr.get('/api/persons?web=donate&limit=200')).persons;
  assert.ok(desk.some((p) => p.name === 'Gil Giver'));
});

test('the consent words kept are the words shown — beside a box and beside the newsletter’s button', async () => {
  const was = ok(await mgr.get('/api/site')).settings;
  ok(await mgr.action('site.settings.save', { org: {}, seo: { ...was.seo, title: 'Surrey Forward' } }));
  try {
    const home = await hit('/site/');
    assert.equal(home.status, 200);
    const shownEmail = boxWords(home.text, 'consent_email');
    assert.ok(shownEmail, 'a consent box on the page');
    const nlAt = home.text.indexOf('data-module="newsletter"');
    const small = /<p class="form-small">([^<]*)/.exec(home.text.slice(nlAt))?.[1];
    assert.ok(small, 'the newsletter’s words beside its button');
    const pet = ok(await mgr.get('/api/site/campaigns')).campaigns.find((c) => c.kind === 'petition');
    ok(await send('petition', { first_name: 'Cora', email: `cora.${tag}@example.org`, campaign: pet.id, consent_email: true }));
    ok(await send('newsletter', { first_name: 'Nell', email: `nell.${tag}@example.org`, consent_email: true }));
    const kept = async (email) => (await db.query("select wording from consent_events where workspace_id = $1 and address = $2 and channel = 'email'", [ws, email])).rows[0]?.wording;
    assert.equal(await kept(`cora.${tag}@example.org`), shownEmail);
    assert.equal(await kept(`nell.${tag}@example.org`), unescape(small));
  } finally {
    ok(await mgr.action('site.settings.save', { org: was.org, seo: was.seo }));
  }
});

// ── One donor on two records: the year's limit counts them together ──
// Money lands only on the same email's record or someone new's, so a donor
// who types another email (or gave a cheque at the desk) is two records.
// When a payment lands under the limit for its own record, the records that
// may be the same donor — the same first and last name, and the same postal
// code, phone or street address — are added in; over together, the gift is
// logged as usual and flagged for the treasurer, naming the other record.
const paid = async (url) => (await fake.pay(sessionOf(url)))[0];
const giftsNamed = async (last) => (await db.query(
  `select g.*, p.email from gifts g join persons p on p.id = g.person_id
    where g.workspace_id = $1 and p.last_name = $2 and g.deleted_at is null order by g.created_at`, [ws, last],
)).rows;
// Money's parseOver: the desk reads the numbers out of the reason (the last
// such phrase in it).
const overOf = (reason) => {
  const m = [...String(reason || '').matchAll(/at \$([\d,]+(?:\.\d+)?) for (\d{4}) — over the \$([\d,]+(?:\.\d+)?) limit/g)].at(-1);
  return m ? [m[1], m[3]] : null;
};

test('one donor under two emails, the same name and postal code: over together, the second gift is flagged naming the first', async () => {
  const who = { first_name: 'Jane', last_name: 'Repeat', address: '12345 67 Ave', city: 'Surrey', postal_code: 'V3T 1V8', cadence: 'once', declaration: true };
  const a = ok(await send('donate', { ...who, email: `jane.work.${tag}@example.org`, amount_cents: 100_000 }));
  assert.equal((await paid(a.checkout_url)).body.result, 'gift recorded');
  const b = ok(await send('donate', { ...who, email: `jane.home.${tag}@example.org`, postal_code: 'v3t1v8', amount_cents: 100_000 }));
  const landed = await paid(b.checkout_url);
  assert.equal(landed.body.result, 'gift recorded', 'logged as usual: the other record may be someone else');
  const gifts = await giftsNamed('Repeat');
  assert.equal(new Set(gifts.map((g) => g.person_id)).size, 2, 'two records');
  assert.deepEqual(gifts.map((g) => g.flagged), [false, true]);
  assert.match(gifts[1].flag_reason, /^Possibly the same donor as Jane Repeat \(same address and postal code\): together they are at \$2,000\.00 for \d{4} — over the \$1,429\.70 limit on the city council slate \(/);
  assert.deepEqual(overOf(gifts[1].flag_reason), ['2,000.00', '1,429.70'], 'the desk reads the two together');
  const pay = (await db.query('select status, over_limit from stripe_payments where gift_id = $1', [gifts[1].id])).rows[0];
  assert.deepEqual([pay.status, pay.over_limit], ['paid', false], 'no refund');
  const flagged = ok(await mgr.get('/api/brief')).flagged.find((f) => f.id === gifts[1].id);
  assert.ok(flagged, 'on the desk’s Needs you');
  const ev = (await db.query("select payload from events where workspace_id = $1 and entity_type = 'gift' and entity_id = $2 and op = 'update'", [ws, gifts[1].id])).rows[0];
  assert.deepEqual([ev?.payload.flagged, ev?.payload.flag_reason], [true, gifts[1].flag_reason], 'the flag on the event log');
});

test('a cheque at the desk on a voter’s record with no email, then a gift online at the same postal code: flagged', async () => {
  const voter = ok(await mgr.action('person.create', { first_name: 'Rhea', last_name: 'Voter', address: '9876 54 St', city: 'Surrey', postal: 'V3S 2A1' })).person;
  ok(await mgr.action('gift.log', { person_id: voter.id, amount_cents: 100_000, date: today(), method: 'cheque' }));
  // The address typed another way: the postal code is enough.
  const r = ok(await send('donate', { first_name: 'Rhea', last_name: 'Voter', email: `rhea.${tag}@example.org`, address: '9876 54 Street', city: 'Surrey', postal_code: 'V3S 2A1', amount_cents: 100_000, cadence: 'once', declaration: true }));
  assert.equal((await paid(r.checkout_url)).body.result, 'gift recorded');
  const gifts = await giftsNamed('Voter');
  const online = gifts.find((g) => g.person_id !== voter.id);
  assert.ok(online, 'a record of its own');
  assert.equal(online.flagged, true);
  assert.match(online.flag_reason, /^Possibly the same donor as Rhea Voter \(same postal code\): together they are at \$2,000\.00 for/);
  assert.equal(gifts.find((g) => g.person_id === voter.id).flagged, false, 'the cheque stays as it was');
});

test('the same name at another postal code, with no phone or address in common: not flagged', async () => {
  const theo = ok(await mgr.action('person.create', { first_name: 'Theo', last_name: 'Apart', address: '1 Elm St', city: 'Surrey', postal: 'V4A 1A1', phone: '604-555-0111' })).person;
  ok(await mgr.action('gift.log', { person_id: theo.id, amount_cents: 100_000, date: today(), method: 'cheque' }));
  const r = ok(await send('donate', { first_name: 'Theo', last_name: 'Apart', email: `theo.${tag}@example.org`, phone: '778-555-0222', address: '2 Oak St', city: 'Surrey', postal_code: 'V3W 9Z9', amount_cents: 100_000, cadence: 'once', declaration: true }));
  assert.equal((await paid(r.checkout_url)).body.result, 'gift recorded');
  assert.deepEqual((await giftsNamed('Apart')).map((g) => g.flagged), [false, false]);
});

test('a pair the desk said are two people is never added up', async () => {
  const kim = ok(await mgr.action('person.create', { first_name: 'Kim', last_name: 'Twice', address: '5 Pine St', city: 'Surrey', postal: 'V3R 1B2' })).person;
  ok(await mgr.action('gift.log', { person_id: kim.id, amount_cents: 100_000, date: today(), method: 'cheque' }));
  const body = { first_name: 'Kim', last_name: 'Twice', email: `kim.${tag}@example.org`, address: '5 Pine St', city: 'Surrey', postal_code: 'V3R 1B2', cadence: 'once', declaration: true };
  assert.equal((await paid(ok(await send('donate', { ...body, amount_cents: 20_000 })).checkout_url)).body.result, 'gift recorded');
  const other = (await db.query('select id from persons where workspace_id = $1 and lower(email) = $2', [ws, body.email])).rows[0];
  ok(await mgr.action('person.notDuplicate', { a: kim.id, b: other.id }));
  assert.equal((await paid(ok(await send('donate', { ...body, amount_cents: 30_000 })).checkout_url)).body.result, 'gift recorded');
  assert.deepEqual((await giftsNamed('Twice')).map((g) => g.flagged), [false, false, false]);
});

test('the records that may be one donor are found through an index, never by reading the whole list', async () => {
  const { likelySameDonors } = await import('../ext/payments/limits.js');
  assert.equal(typeof likelySameDonors, 'function', 'limits.js finds them');
  const [jane] = (await db.query("select id from persons where workspace_id = $1 and last_name = 'Repeat' order by created_at limit 1", [ws])).rows;
  const seen = [];
  const recording = { query: (sql, params) => { seen.push({ sql, params }); return db.query(sql, params); } };
  const found = await likelySameDonors(recording, { id: ws }, jane.id, { year: Number(today().slice(0, 4)), slate: 'council' });
  assert.deepEqual(found.map((f) => [f.name, Number(f.given_cents)]), [['Jane Repeat', 100_000]]);
  assert.ok(seen.length >= 1);
  for (const s of seen) {
    const plan = await db.transaction(async (tx) => {
      await tx.query('set local enable_seqscan = off');
      return (await tx.query(`explain ${s.sql}`, s.params)).rows.map((r) => Object.values(r)[0]).join('\n');
    });
    assert.match(plan, /persons_same_donor_idx/, `${s.sql.replace(/\s+/g, ' ')}\n${plan}`);
  }
});
