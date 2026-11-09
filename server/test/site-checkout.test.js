// What the website's forms may never do (review A1) — the contact form, a
// join's profile fields, the referral link, the money forms' tags, and the
// consent and declaration words:
//
//   · join never overwrites a birth date or citizenship on file;
//   · a referral code is found through its index;
//   · a website message never pushes a note off a record;
//   · the declaration and consent words kept are the words shown;
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
// until it is let go; failNext makes the next ones fail as an outage would.
const realFetch = globalThis.fetch;
let held = null;
let failNext = 0;
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

test('join never overwrites a birth date or citizenship on file; it fills what is empty for the same email', async () => {
  const f = await fieldIds();
  const set = (personId, birth, cz) => mgr.action('field.values.set', { person_id: personId, values: [{ field_id: f['birth date'], value: birth }, { field_id: f.citizenship, value: cz }] });
  const elder = ok(await mgr.action('person.create', { name: 'Bert Elder', email: `bert.${tag}@example.org`, postal: 'V4A 9Z9' })).person;
  ok(await set(elder.id, '1950-03-04', 'Canadian citizen'));
  const kept = { 'birth date': '1950-03-04', citizenship: 'Canadian citizen' };
  ok(await send('join', { first_name: 'Bert', last_name: 'Elder', phone: '604-111-2222', postal_code: 'V4A 9Z9', birth_date: '2008-01-01', citizenship: 'pr', declaration: true }));
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
