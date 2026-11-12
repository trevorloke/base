// The website's forms (ext/site/forms.js, SITE.md "Public forms"): every
// kind's happy path and what it leaves in base.win, the fields it can't do
// without, the honeypot, the per-address limit, a retry that never doubles,
// someone on file matched rather than doubled, a plain form post's 303s, a
// referral link credited, online payments (and the plain words when they
// aren't set up), and an answer that never says who was on file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hit, send, ok, campaign, member, personBy } from './site-helpers.js';
import { _setPaymentsForTest } from '../ext/site/payments.js';
import { runAction } from '../lib/events.js';

let db, mgr, ws, vol;
let petition, pledge;
const actionsOf = async (personId, kind) => (await db.query(
  'select * from site_actions where workspace_id = $1 and person_id = $2 and kind = $3 order by created_at', [ws, personId, kind],
)).rows;
const lastEvent = async (action) => (await db.query(
  'select * from events where workspace_id = $1 and action = $2 order by seq desc', [ws, action],
)).rows;
const tags = (p) => (Array.isArray(p.tags) ? p.tags : JSON.parse(p.tags || '[]'));
const future = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const requestsOf = async (personId, kind) => (await db.query(
  'select * from door_requests where workspace_id = $1 and person_id = $2 and kind = $3 order by created_at', [ws, personId, kind],
)).rows;

// A stand-in for ext/payments, the way the site uses it: the checkout kept
// in the form's write (prepareCheckout), then Stripe's page after it
// (openCheckout, whose `also` runs in its own short write).
const fakePayments = ({ url = (n) => `https://checkout.stripe.com/c/pay/cs_test_${n}`, down = null } = {}) => {
  const calls = [];
  const ids = new Map();
  return {
    calls,
    paymentsReady: () => true,
    prepareCheckout: async (tx, ctx, args) => {
      calls.push({ ws: ctx.workspaceId, ...args });
      const id = randomUUID();
      ids.set(id, calls.length);
      return { id };
    },
    retryCheckout: async (tx, ctx, id) => ({ id }),
    openCheckout: async (dbx, ctx, id, { action, also }) => {
      if (down) throw down;
      const page = url(ids.get(id));
      const { result } = await runAction(dbx, { workspaceId: ctx.workspaceId, actorId: null, action }, (tx, emit) => also(tx, emit, { url: page, session_id: `cs_${id}` }));
      return { url: page, id, result };
    },
  };
};

before(async () => {
  ({ db, mgr, ws } = await campaign());
  vol = await member(mgr, 'volunteer', 'Vic Example');
  const cs = ok(await mgr.get('/api/site/campaigns')).campaigns;
  petition = cs.find((c) => c.kind === 'petition');
  pledge = cs.find((c) => c.kind === 'pledge');
});
after(() => _setPaymentsForTest(null));

test('newsletter: a new person on the list, tagged, with the consent they gave — the answer is only ok', async () => {
  const r = await send('newsletter', { first_name: 'Asha', last_name: 'Example', email: 'Asha@Example.org', consent_email: true, source: 'home', module_id: 'newsletter' });
  const [p] = await personBy(db, ws, "lower(email) = 'asha@example.org'");
  assert.deepEqual(r.json, { ok: true, ref_code: p.attrs.ref_code }, 'ok, and their own code for the share sheet');
  assert.deepEqual([p.name, p.first_name, p.last_name], ['Asha Example', 'Asha', 'Example']);
  assert.deepEqual(tags(p), ['Website: newsletter']);
  assert.match(p.attrs.ref_code, /^[a-z0-9]{8}$/, 'a referral code of their own');
  const sub = (await db.query('select status, source from subscriptions where workspace_id = $1 and email = $2', [ws, 'asha@example.org'])).rows[0];
  assert.deepEqual(sub, { status: 'subscribed', source: 'website-newsletter' });
  const [a] = await actionsOf(p.id, 'newsletter');
  assert.deepEqual([a.module_id, a.source, a.payload.consent_email], ['newsletter', 'home', true]);
  const ev = (await lastEvent('site.form.newsletter'))[0];
  const siteEv = (await db.query("select payload from events where workspace_id = $1 and action = 'site.form.newsletter' and entity_type = 'site_action'", [ws])).rows[0];
  assert.deepEqual(Object.keys(siteEv.payload).sort(), ['campaign_id', 'kind', 'module_id', 'page_id', 'person_id', 'referrer_id', 'source']);
  assert.equal(ev.actor_id, null, 'a system write on the chain');
  // The box is a must for a newsletter, and so is an email.
  const noBox = await send('newsletter', { email: 'ben@example.org' });
  assert.deepEqual([noBox.status, noBox.json.field], [400, 'consent_email']);
  const noEmail = await send('newsletter', { phone: '604-555-0101', consent_email: true });
  assert.deepEqual([noEmail.status, noEmail.json.field], [400, 'email']);
});

test('every kind needs an email or a phone, and checks what it is sent', async () => {
  for (const kind of ['newsletter', 'petition', 'pledge', 'volunteer', 'rsvp', 'contact', 'join', 'donate']) {
    const r = await send(kind, { first_name: 'Nobody' });
    assert.deepEqual([r.status, r.json.field], [400, 'email'], kind);
    assert.match(r.json.error, /email or your phone/);
  }
  const cases = [
    ['petition', { email: 'a@example.org' }, 'campaign'],
    ['petition', { email: 'a@example.org', campaign: petition.id, comment: 'x'.repeat(1001) }, 'comment'],
    ['pledge', { email: 'a@example.org', campaign: petition.id }, 'campaign'], // a petition isn't a pledge
    ['rsvp', { email: 'a@example.org' }, 'shift_id'],
    ['contact', { email: 'a@example.org' }, 'message'],
    ['contact', { email: 'a@example.org', message: 'x'.repeat(4001) }, 'message'],
    ['volunteer', { email: 'a@example.org', roles: Array.from({ length: 21 }, (_, i) => `r${i}`) }, 'roles'],
    ['volunteer', { email: 'a@example.org', availability: 'x'.repeat(301) }, 'availability'],
    ['join', { email: 'a@example.org' }, 'declaration'],
    ['join', { email: 'a@example.org', declaration: true, birth_date: '1990-02-31' }, 'birth_date'],
    ['join', { email: 'a@example.org', declaration: true, birth_date: new Date(Date.now() - 10 * 365 * 864e5).toISOString().slice(0, 10) }, 'birth_date'],
    ['join', { email: 'a@example.org', declaration: true, term: 2 }, 'term'],
    ['join', { email: 'a@example.org', declaration: true, citizenship: 'visitor' }, 'citizenship'],
    ['join', { email: 'a@example.org', declaration: true, amount_cents: 500 }, 'amount_cents'],
    ['donate', { email: 'a@example.org', declaration: true }, 'amount_cents'],
    ['donate', { email: 'a@example.org', amount_cents: 5000 }, 'declaration'],
    ['donate', { email: 'a@example.org', declaration: true, amount_cents: 300 }, 'amount_cents'],
    ['donate', { email: 'a@example.org', declaration: true, amount_cents: 5000, cadence: 'weekly' }, 'cadence'],
    ['donate', { email: 'a@example.org', declaration: true, amount_cents: 5000, slate: 'mars' }, 'slate'],
    ['newsletter', { email: 'not-an-email', consent_email: true }, 'email'],
    ['contact', { phone: '12', message: 'hi' }, 'phone'],
    ['contact', { email: 'a@example.org', consent_sms: true, message: 'hi' }, 'phone'],
  ];
  for (const [kind, body, field] of cases) {
    const r = await send(kind, body);
    assert.deepEqual([r.status, r.json?.field], [400, field], `${kind} ${JSON.stringify(body).slice(0, 80)}`);
    assert.ok(r.json.error.length > 5 && !/undefined|null/.test(r.json.error), r.json.error);
  }
  assert.equal((await send('nope', { email: 'a@example.org' })).status, 404);
  assert.equal((await hit('/site/api/forms/contact', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
});

test('join and donate need an email: a phone alone is refused', async () => {
  _setPaymentsForTest(fakePayments());
  try {
    for (const kind of ['join', 'donate']) {
      const r = await send(kind, { first_name: 'Pho', last_name: 'Only', phone: '604-555-0142', postal_code: 'V3T 1V8', amount_cents: 2500, declaration: true });
      assert.deepEqual([r.status, r.json?.field], [400, 'email'], `${kind}: ${r.text}`);
      assert.equal(r.json.error, kind === 'join' ? 'Add your email to join' : 'Add your email to give');
    }
    assert.equal((await personBy(db, ws, "last_name = 'Only'")).length, 0, 'nothing kept');
  } finally {
    _setPaymentsForTest(null);
  }
});

test('an email Stripe would refuse is refused on the form, and the browser checks it the same way', async () => {
  const good = ['jane@gmail.com', 'Jane.Doe@Example.org', 'first.last+tag@sub.example.co.uk', "o'brien@example.ie", 'a-b@my-domain.ca', 'ana@xn--80ak6aa92e.com'];
  const bad = ['jane@gmail..com', 'jane..doe@gmail.com', '.jane@gmail.com', 'jane.@gmail.com', 'jane@.gmail.com', 'jane@gmail.com.', 'jane@-gmail.com', 'jane@gmail-.com', 'jane@gmail.c', 'jane@localhost'];
  for (const email of bad) {
    const r = await send('newsletter', { email, consent_email: true });
    assert.deepEqual([r.status, r.json?.field], [400, 'email'], email);
  }
  for (const email of good) assert.equal((await send('newsletter', { email, consent_email: true })).status, 200, email);
  const { EMAIL_RE } = await import('../../shared/site/components/util.js');
  assert.ok(EMAIL_RE instanceof RegExp, 'one pattern for the server and the browser (shared/site/components/util.js)');
  for (const email of bad) assert.equal(EMAIL_RE.test(email), false, email);
  for (const email of good) assert.equal(EMAIL_RE.test(email.toLowerCase()), true, email);
});

test('petition and pledge: the signature, the tags, a person signing twice counts once', async () => {
  const r = await send('petition', { first_name: 'Ravi', last_name: 'Example', email: 'ravi@example.org', postal_code: 'v3t1v8', campaign: petition.id, comment: 'All the way!' });
  const [p] = await personBy(db, ws, "lower(email) = 'ravi@example.org'");
  assert.deepEqual(r.json, { ok: true, ref_code: p.attrs.ref_code });
  assert.deepEqual(tags(p).sort(), ['Signed: Get SkyTrain to South Surrey', 'Website: petition'].sort());
  assert.equal(p.postal, 'V3T 1V8');
  const [a] = await actionsOf(p.id, 'petition');
  assert.deepEqual([a.campaign_id, a.payload.comment], [petition.id, 'All the way!']);
  await send('petition', { email: 'ravi@example.org', campaign: petition.id });
  assert.equal(ok(await mgr.get(`/api/site/campaigns/${petition.id}`)).campaign.signatures, 1, 'the same person, once');
  ok(await send('pledge', { first_name: 'Ravi', email: 'ravi@example.org', campaign: pledge.id }));
  const after = (await personBy(db, ws, "lower(email) = 'ravi@example.org'"))[0];
  assert.ok(tags(after).includes('Signed: Stop Doug McCallum and Mandeep…'), 'a long title is cut at a word, within 40 characters');
  assert.ok(tags(after).every((t) => t.length <= 40));
});

test('someone on file is matched, not doubled: by email (blanks filled, nothing overwritten), by name and phone, by name and postal code', async () => {
  const onFile = (await mgr.action('person.create', { name: 'Mina Example', email: 'mina@example.org', city: 'Surrey', tags: ['VIP'] })).json.person;
  ok(await send('contact', { first_name: 'Minnie', last_name: 'Example', email: 'MINA@example.org', phone: '604-555-0123', postal_code: 'v4a 1a1', message: 'Can I get a lawn sign?', topic: 'Signs' }));
  const [m] = await personBy(db, ws, "lower(email) = 'mina@example.org'");
  assert.equal(m.id, onFile.id);
  assert.deepEqual([m.name, m.phone, m.postal, m.city], ['Mina Example', '604-555-0123', 'V4A 1A1', 'Surrey'], 'blanks filled, the name kept');
  assert.deepEqual(tags(m).sort(), ['VIP', 'Website: contact'].sort());
  assert.equal(m.attrs.note, undefined, 'their note is theirs: a website message is never written there');
  assert.deepEqual((await requestsOf(m.id, 'other')).map((r) => r.note), ['From the website (Signs): Can I get a lawn sign?'], 'the message, a request for the desk');

  const byPhone = (await mgr.action('person.create', { first_name: 'Omar', last_name: 'Example', phone: '(604) 555-0144' })).json.person;
  ok(await send('volunteer', { first_name: 'Omar', last_name: 'Example', phone: '604 555 0144', email: 'omar.new@example.org', roles: ['Doorknocking'] }));
  const omars = await personBy(db, ws, "name = 'Omar Example'");
  assert.equal(omars.length, 1, 'one Omar');
  assert.equal(omars[0].id, byPhone.id);
  assert.equal(omars[0].email, null, 'a match by name and phone fills nothing');
  assert.equal(omars[0].attrs.typed_email, 'omar.new@example.org', 'the email they typed is kept beside the record');

  const voter = (await mgr.action('person.create', { first_name: 'Lena', last_name: 'Example', address: '10250 140 St', postal: 'V3T 4B2' })).json.person;
  ok(await send('petition', { first_name: 'Lena', last_name: 'Example', phone: '604-555-0177', postal_code: 'v3t4b2', campaign: petition.id }));
  const lenas = await personBy(db, ws, "name = 'Lena Example'");
  assert.equal(lenas.length, 1, 'one Lena');
  assert.equal(lenas[0].id, voter.id);
  assert.equal(lenas[0].phone, null, 'a match by name and postal code fills nothing');
  // An email that matches nobody with a name nobody has: someone new.
  ok(await send('newsletter', { first_name: 'Lena', last_name: 'Example', email: 'other.lena@example.org', consent_email: true }));
  assert.equal((await personBy(db, ws, "name = 'Lena Example'")).length, 2);
});

test('the honeypot hears what a person would, and nothing is kept', async () => {
  const before = (await db.query('select count(*)::int as n from persons where workspace_id = $1', [ws])).rows[0].n;
  const r = await send('newsletter', { email: 'bot@example.org', consent_email: true, website: 'https://spam.example' });
  assert.deepEqual([r.status, Object.keys(r.json).sort()], [200, ['ok', 'ref_code']]);
  const plain = await hit('/site/api/forms/newsletter', { form: { email: 'bot2@example.org', consent_email: 'on', website: 'x', module_id: 'newsletter' } });
  assert.deepEqual([plain.status, plain.location], [303, '/site/?sent=newsletter#m-newsletter']);
  assert.equal((await db.query('select count(*)::int as n from persons where workspace_id = $1', [ws])).rows[0].n, before);
  assert.equal((await db.query("select count(*)::int as n from subscriptions where workspace_id = $1 and email like 'bot%'", [ws])).rows[0].n, 0);
});

test('one address may send 20 a minute; the 21st waits', async () => {
  const ip = '203.0.113.77';
  for (let i = 0; i < 20; i += 1) {
    const r = await send('contact', { email: `burst${i}@example.org`, message: 'hello' }, { ip });
    assert.equal(r.status, 200, `${i}`);
  }
  const r = await send('contact', { email: 'burst21@example.org', message: 'hello' }, { ip });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /wait a minute/);
  const plain = await hit('/site/api/forms/contact', { ip, form: { email: 'x@example.org', message: 'hi', module_id: 'contact-form' } });
  assert.deepEqual([plain.status, plain.location], [303, '/site/?error=busy&module=contact-form#m-contact-form']);
  assert.equal((await send('contact', { email: 'elsewhere@example.org', message: 'hi' })).status, 200, 'another address is fine');
});

test('a retry with the same client_key is the same action, never a second', async () => {
  const body = { first_name: 'Rita', email: 'rita@example.org', message: 'Twice?', client_key: 'k-3f6a1c2e-retry' };
  const a = ok(await send('contact', body));
  const b = ok(await send('contact', body));
  assert.deepEqual(a, b);
  const [p] = await personBy(db, ws, "lower(email) = 'rita@example.org'");
  assert.equal((await actionsOf(p.id, 'contact')).length, 1);
  assert.equal((await requestsOf(p.id, 'other')).length, 1, 'the message once');
  ok(await send('contact', { ...body, client_key: 'k-other' }));
  assert.equal((await actionsOf(p.id, 'contact')).length, 2, 'a new key is a new message');
  const tooLong = await send('contact', { ...body, client_key: 'x'.repeat(65) });
  assert.equal(tooLong.status, 400);
});

test('a plain form post (no JavaScript) goes back to its page: ?sent=, or ?error= with the field', async () => {
  const site = ok(await mgr.get('/api/site'));
  const donatePage = site.pages.find((p) => p.slug === 'volunteer');
  const sent = await hit('/site/api/forms/volunteer', { form: { email: 'plain@example.org', roles: ['Doorknocking', 'Phoning'], page_id: donatePage.id, module_id: 'volunteer-form' } });
  assert.deepEqual([sent.status, sent.location], [303, '/site/volunteer?sent=volunteer#m-volunteer-form']);
  const [p] = await personBy(db, ws, "lower(email) = 'plain@example.org'");
  const req = (await db.query("select note from door_requests where workspace_id = $1 and person_id = $2 and kind = 'volunteer'", [ws, p.id])).rows[0];
  assert.match(req.note, /Doorknocking, Phoning/, 'every ticked role arrives');
  const err = await hit('/site/api/forms/contact', { form: { email: 'plain@example.org', page_id: donatePage.id, module_id: 'contact' } });
  assert.deepEqual([err.status, err.location], [303, '/site/volunteer?error=message&module=contact#m-contact']);
  const back = await hit('/site/api/forms/petition', { form: { email: 'plain2@example.org', campaign: petition.id, module_id: 'sky' } });
  assert.equal(back.location, `/site/act/${petition.slug}?sent=petition#m-sky`, 'with no page, the petition’s own page');
  const ref = await hit('/site/api/forms/contact', { form: { email: 'plain3@example.org', message: 'hi' }, headers: { referer: 'http://localhost/site/events' } });
  assert.equal(ref.location, '/site/events?sent=contact', 'else the page it came from');
  const thanks = await hit('/site/volunteer?sent=volunteer');
  assert.equal(thanks.status, 200);
  assert.match(thanks.headers.get('cache-control'), /no-store/);
});

test('volunteer: a "Wants to volunteer" request for the desk, with the roles, when they are free and their note', async () => {
  ok(await send('volunteer', { first_name: 'Vera', last_name: 'Example', email: 'vera@example.org', roles: ['Doorknocking', 'Translation'], availability: 'Weekday evenings', note: 'I speak Punjabi' }));
  const [p] = await personBy(db, ws, "lower(email) = 'vera@example.org'");
  const r = (await db.query("select * from door_requests where workspace_id = $1 and person_id = $2", [ws, p.id])).rows[0];
  assert.equal(r.kind, 'volunteer');
  assert.equal(r.note, 'From the website: Doorknocking, Translation. Free: Weekday evenings. “I speak Punjabi”');
  assert.equal(r.done_at, null);
  const open = ok(await mgr.get('/api/requests')).requests;
  assert.ok(open.some((x) => x.id === r.id), 'on the desk’s list');
  assert.deepEqual(tags(p), ['Website: volunteer']);
});

test('rsvp: booked through the app’s own booking — room checked, a public upcoming shift only, booked again after "can’t make it"', async () => {
  const shift = (await mgr.action('shift.create', { title: 'Town hall', starts_at: future(48), capacity: 2 })).json.shift;
  const notPublic = await send('rsvp', { email: 'early@example.org', shift_id: shift.id });
  assert.deepEqual([notPublic.status, notPublic.json.field], [400, 'shift_id']);
  ok(await mgr.action('shift.public', { id: shift.id, public: true }));
  ok(await send('rsvp', { first_name: 'Ana', email: 'ana.rsvp@example.org', shift_id: shift.id }));
  ok(await send('rsvp', { first_name: 'Ana', email: 'ana.rsvp@example.org', shift_id: shift.id }));
  const booked = ok(await mgr.get(`/api/shifts/${shift.id}`)).assignees;
  assert.equal(booked.length, 1, 'booked once');
  assert.equal(booked[0].status, 'assigned');
  ok(await send('rsvp', { first_name: 'Bo', email: 'bo@example.org', shift_id: shift.id }));
  const full = await send('rsvp', { first_name: 'Cy', email: 'cy@example.org', shift_id: shift.id });
  assert.deepEqual([full.status, full.json.field], [400, 'shift_id']);
  assert.match(full.json.error, /full/);
  assert.equal((await personBy(db, ws, "lower(email) = 'cy@example.org'")).length, 0, 'nothing kept from a refused form');
  // Ana can't make it after all; then she can, and the spot is hers again.
  const ana = booked[0];
  ok(await mgr.action('shift.setStatus', { id: ana.assignment_id, status: 'declined' }));
  ok(await send('rsvp', { email: 'ana.rsvp@example.org', shift_id: shift.id }));
  assert.equal(ok(await mgr.get(`/api/shifts/${shift.id}`)).assignees.find((x) => x.id === ana.id).status, 'assigned');
  const past = (await mgr.action('shift.create', { title: 'Yesterday', starts_at: new Date(Date.now() - 864e5).toISOString() })).json.shift;
  ok(await mgr.action('shift.public', { id: past.id, public: true }));
  const over = await send('rsvp', { email: 'late@example.org', shift_id: past.id });
  assert.deepEqual([over.status, over.json.field], [400, 'shift_id']);
});

test('a referral link: remembered 30 days, the forms credit the referrer, someone new is "Brought in by" them', async () => {
  const [referrer] = await personBy(db, ws, "lower(email) = 'asha@example.org'");
  const code = referrer.attrs.ref_code;
  const r = await hit(`/site/r/${code}`);
  assert.deepEqual([r.status, r.location], [302, '/site/']);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^site_ref=${code};`));
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /Path=\/site/);
  assert.match(cookie, /HttpOnly/);
  const unknown = await hit('/site/r/zzzzzzzz');
  assert.equal(unknown.headers.get('set-cookie'), null, 'an unknown code is not remembered');

  // The cookie credits a form…
  ok(await send('newsletter', { first_name: 'Nia', last_name: 'Example', email: 'nia@example.org', consent_email: true }, { headers: { cookie: `site_ref=${code}` } }));
  const [nia] = await personBy(db, ws, "lower(email) = 'nia@example.org'");
  assert.equal((await actionsOf(nia.id, 'newsletter'))[0].referrer_id, referrer.id);
  const by = ok(await mgr.get(`/api/persons/${nia.id}/knows`));
  assert.deepEqual(by.brought_in_by, { id: referrer.id, name: referrer.name }, 'Brought in by');
  // …and so does a ref sent with it; someone already on file is credited, not "brought in".
  ok(await send('petition', { email: 'ravi@example.org', campaign: petition.id, ref: code }));
  const [ravi] = await personBy(db, ws, "lower(email) = 'ravi@example.org'");
  const sig = (await actionsOf(ravi.id, 'petition')).at(-1);
  assert.equal(sig.referrer_id, referrer.id);
  assert.equal(ok(await mgr.get(`/api/persons/${ravi.id}/knows`)).brought_in_by, null);
  // Their own link doesn't credit themselves.
  ok(await send('contact', { email: 'asha@example.org', message: 'me', ref: code }));
  assert.equal((await actionsOf(referrer.id, 'contact'))[0].referrer_id, null);
});

test('join and donate: plain words when online payments aren’t set up; otherwise off to the checkout', async () => {
  _setPaymentsForTest(null);
  const off = await send('donate', { email: 'giver@example.org', amount_cents: 5000, declaration: true });
  assert.equal(off.status, 503);
  assert.match(off.json.error, /Online payments aren’t set up/);
  const plainOff = await hit('/site/api/forms/join', { form: { email: 'giver@example.org', declaration: 'on', module_id: 'join' } });
  assert.deepEqual([plainOff.status, plainOff.location], [303, '/site/?error=payments&module=join#m-join']);

  const fake = fakePayments();
  const { calls } = fake;
  _setPaymentsForTest(fake);
  const site = ok(await mgr.get('/api/site'));
  const donatePage = site.pages.find((p) => p.slug === 'donate');
  const giftForm = {
    first_name: 'Gia', last_name: 'Example', email: 'gia@example.org', address: '13450 104 Ave', city: 'Surrey', postal_code: 'V3T 1V8',
    amount_cents: 5000, cadence: 'monthly', declaration: true, page_id: donatePage.id, module_id: 'donate', client_key: 'gift-1',
  };
  const gift = ok(await send('donate', giftForm));
  assert.equal(gift.checkout_url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const [g] = await personBy(db, ws, "lower(email) = 'gia@example.org'");
  assert.deepEqual(calls[0], {
    ws, personId: g.id, kind: 'donation', amountCents: 5000, cadence: 'monthly', slate: null, email: 'gia@example.org',
    declaration: 'I’m a Canadian citizen or permanent resident. I live in British Columbia. This contribution is my own money, and no one will pay me back for it.',
    successUrl: 'http://localhost/site/donate?sent=donate#m-donate', cancelUrl: 'http://localhost/site/donate?cancelled=donate#m-donate',
    metadata: { site_action_id: (await actionsOf(g.id, 'donate'))[0].id, kind: 'donate' },
  });
  assert.deepEqual(tags(g), [], 'the money forms leave no tag');
  assert.deepEqual(ok(await send('donate', giftForm)), gift, 'a retry gets the same checkout');
  assert.equal(calls.length, 1, 'and makes no second one');
  assert.equal(g.address, '13450 104 Ave');

  const over = await send('donate', { email: 'gia@example.org', amount_cents: 99_999_00, declaration: true });
  assert.deepEqual([over.status, over.json.field], [400, 'amount_cents']);
  assert.match(over.json.error, /at most \$[\d,.]+ in a year/);
  const monthly = await send('donate', { email: 'gia@example.org', amount_cents: 500_00, cadence: 'monthly', declaration: true });
  assert.deepEqual([monthly.status, monthly.json.field], [400, 'amount_cents']);

  const youth = new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10);
  const joined = ok(await send('join', { first_name: 'Jo', last_name: 'Example', email: 'jo@example.org', birth_date: youth, citizenship: 'pr', term: 4, declaration: true }));
  assert.equal(joined.checkout_url, 'https://checkout.stripe.com/c/pay/cs_test_2');
  assert.deepEqual([calls[1].kind, calls[1].amountCents, calls[1].metadata.term, calls[1].metadata.youth], ['membership', 2000, '4', 'yes'], 'the youth minimum for four years');
  const [jo] = await personBy(db, ws, "lower(email) = 'jo@example.org'");
  const fields = Object.fromEntries(ok(await mgr.get(`/api/persons/${jo.id}/fields`)).fields.map((f) => [f.name, f.value]));
  assert.deepEqual([fields['Birth date'], fields.Citizenship], [youth, 'Permanent resident'], 'kept on their profile');
  const plain = await hit('/site/api/forms/join', { form: { email: 'jo2@example.org', declaration: 'on', amount_cents: '2500', module_id: 'join' } });
  assert.deepEqual([plain.status, plain.location], [303, 'https://checkout.stripe.com/c/pay/cs_test_3']);
  // Stripe not answering: the person and what they did are kept (the form's
  // write is done before Stripe is asked), with no answer yet — so the same
  // key, sent again, finishes it as one action.
  const down = fakePayments({ down: Object.assign(new Error('stripe down'), { status: 503 }) });
  _setPaymentsForTest(down);
  const body = { email: 'down@example.org', amount_cents: 5000, declaration: true, client_key: 'down-1' };
  const failing = await send('donate', body);
  assert.equal(failing.status, 503);
  assert.match(failing.json.error, /payment service/);
  const [d] = await personBy(db, ws, "lower(email) = 'down@example.org'");
  const [kept] = await actionsOf(d.id, 'donate');
  assert.equal(kept.answer, null, 'nothing told yet');
  _setPaymentsForTest(fakePayments({ url: () => 'https://checkout.stripe.com/c/pay/cs_test_back' }));
  assert.equal(ok(await send('donate', body)).checkout_url, 'https://checkout.stripe.com/c/pay/cs_test_back', 'the retry gets its checkout');
  assert.equal((await actionsOf(d.id, 'donate')).length, 1, 'one action');
  _setPaymentsForTest(null);
});

test('a form from another site is refused; the answer never carries a person id', async () => {
  const r = await send('newsletter', { email: 'x@example.org', consent_email: true }, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
  const same = await send('newsletter', { email: 'mina@example.org', consent_email: true }, { headers: { 'sec-fetch-site': 'same-origin' } });
  const fresh = await send('newsletter', { email: 'never.before@example.org', consent_email: true });
  const shape = (j) => Object.keys(j).sort().map((k) => `${k}:${typeof j[k]}:${String(j[k]).length}`);
  assert.deepEqual(shape(same.json), shape(fresh.json), 'someone on file hears exactly what someone new would');
  const [mina] = await personBy(db, ws, "lower(email) = 'mina@example.org'");
  assert.notEqual(same.json.ref_code, mina.attrs.ref_code, 'and never their code');
  // Nothing the app keeps answers a form, and a volunteer's session does nothing here.
  const withCookie = await send('newsletter', { email: 'cookie@example.org', consent_email: true }, { headers: { cookie: vol.client.cookie } });
  assert.equal(withCookie.json.ok, true);
  assert.equal(withCookie.headers.get('set-cookie'), null);
});

test('every kind: the honeypot keeps nothing, and a retry with the same key is one action', async () => {
  _setPaymentsForTest(fakePayments({ url: () => 'https://checkout.stripe.com/c/pay/cs_test_every' }));
  const shift = (await mgr.action('shift.create', { title: 'Every kind', starts_at: future(30), capacity: 20 })).json.shift;
  ok(await mgr.action('shift.public', { id: shift.id, public: true }));
  const extra = {
    newsletter: { consent_email: true }, petition: { campaign: petition.id }, pledge: { campaign: pledge.id },
    volunteer: { roles: ['Phoning'] }, rsvp: { shift_id: shift.id }, contact: { message: 'Hello' },
    join: { declaration: true }, donate: { declaration: true, amount_cents: 2500 },
  };
  for (const [kind, more] of Object.entries(extra)) {
    const email = `every.${kind}@example.org`;
    const trap = await send(kind, { email, website: 'http://bot.example', ...more });
    const heard = ['join', 'donate'].includes(kind) ? ['ok'] : ['ok', 'ref_code'];
    assert.deepEqual([trap.status, Object.keys(trap.json).sort()], [200, heard], `${kind}: the honeypot hears ok`);
    assert.equal((await personBy(db, ws, 'lower(email) = $2', [email])).length, 0, `${kind}: and nothing is kept`);
    const body = { first_name: 'Every', last_name: 'Example', email, client_key: `every-${kind}`, ...more };
    const first = ok(await send(kind, body), kind);
    const again = ok(await send(kind, body), kind);
    assert.deepEqual(again, first, `${kind}: the same answer`);
    const [p] = await personBy(db, ws, 'lower(email) = $2', [email]);
    assert.equal((await actionsOf(p.id, kind)).length, 1, `${kind}: one action`);
    // The money forms leave no tag: who gave or joined is never a volunteer's to see.
    assert.equal(tags(p).includes(`Website: ${kind}`), !['join', 'donate'].includes(kind), kind);
  }
  _setPaymentsForTest(null);
});

test('an address placed on the map by the app’s own lookup (here, a neighbour already on the map)', async () => {
  const was = process.env.GEOCODE_ON_SAVE;
  process.env.GEOCODE_ON_SAVE = 'on';
  _setPaymentsForTest(fakePayments({ url: () => 'https://checkout.stripe.com/c/pay/cs_test_map' }));
  try {
    ok(await mgr.action('person.create', { name: 'Neighbour Example', address: '7700 128 St', city: 'Surrey', lat: 49.14, lng: -122.87 }));
    ok(await send('donate', { first_name: 'Pia', last_name: 'Example', email: 'pia@example.org', address: '7700 128 St', city: 'Surrey', amount_cents: 2500, declaration: true }));
    let p;
    for (let i = 0; i < 40; i += 1) {
      [p] = await personBy(db, ws, "lower(email) = 'pia@example.org'");
      if (p?.lat != null) break;
      await new Promise((r) => { setTimeout(r, 100); });
    }
    assert.deepEqual([p.lat, p.lng], [49.14, -122.87], 'on the map');
    const placed = (await db.query("select count(*)::int as n from events where workspace_id = $1 and action = 'person.geocode' and entity_id = $2", [ws, p.id])).rows[0].n;
    assert.equal(placed, 1, 'by the app’s own lookup (person.geocode)');
  } finally {
    if (was === undefined) delete process.env.GEOCODE_ON_SAVE; else process.env.GEOCODE_ON_SAVE = was;
    _setPaymentsForTest(null);
  }
});

test('two records made one: the referrals follow the one that stays', async () => {
  const [referrer] = await personBy(db, ws, "lower(email) = 'asha@example.org'");
  const twin = (await mgr.action('person.create', { name: 'Asha Example', phone: '604-555-0199' })).json.person;
  ok(await mgr.action('person.merge', { keep: twin.id, drop: referrer.id }));
  const credited = (await db.query('select count(*)::int as n from site_actions where workspace_id = $1 and referrer_id = $2', [ws, twin.id])).rows[0].n;
  assert.ok(credited >= 2, 'the merged record’s referrals are the kept one’s');
  // Their old link still works: it finds the record they were made one with.
  ok(await send('contact', { email: 'late.friend@example.org', message: 'Sent by Asha', ref: referrer.attrs.ref_code }));
  const [friend] = await personBy(db, ws, "lower(email) = 'late.friend@example.org'");
  assert.equal((await actionsOf(friend.id, 'contact'))[0].referrer_id, twin.id);
});
