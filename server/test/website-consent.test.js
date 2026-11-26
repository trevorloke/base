// Unsubscribes both ways between a campaign's own website (hosted apart) and
// base.win (server/ext/intake: consent.js, outbound.js, website.js,
// service.js).
//
// In: POST /in/v1/consent, with the website's key. A no is applied the way
// base.win's own unsubscribe and STOP are; an address or number nobody has
// yet is held, so nothing later puts it back; a yes is answered and never
// applied; the answer never says who is on file.
// Out: base.win's own unsubscribes, STOPs and do-not tags go to the website's
// /api/in/consent from a durable queue — once each, the same bytes on every
// try, never given up while the website is down — and what the website said
// is never sent back to it.
// The website is a stand-in here (fake-website.js at STARBASE_WEBSITE_URL);
// the last test holds that stand-in to the website's own source.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { freshDb, Client } from './helpers.js';
import { hit } from './site-helpers.js';
import { app } from '../index.js';
import { runAction } from '../lib/events.js';
import { enqueueJob, runDueJobs, MAX_ATTEMPTS } from '../lib/jobs.js';
import { whyNot } from '../lib/reach.js';
import { recordConsent } from '../ext/site/consent.js';
import { personToken } from '../ext/site/index.js';
import { suppress } from '../ext/mail/webhook.js';
import { applyOptOut } from '../ext/texting/store.js';
import { twilioSignature } from '../ext/texting/twilio.js';
import { _setClockForTest } from '../ext/texting/rules.js';
import { _forgetAudienceForTest } from '../ext/mailchimp/mailchimp.js';
import { _resetPaceForTest, _setRunMsForTest, _setTimeoutForTest, WAITS_MS, PER_MINUTE } from '../ext/intake/outbound.js';
import { startFakeWebsite, stableJson, consentPayload, requestFor, classifyAnswer, CONSENT_ENDPOINT } from './fake-website.js';
import { startFakeMail } from './fake-mail.js';
import { startFakeMailchimp } from './fake-mailchimp.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.wc.${tag}@example.org`;
// A number of its own for each use (the tests share one database).
const phone = () => `+1604${String(2000000 + Math.floor(Math.random() * 7999999))}`;
const dashed = (p) => `${p.slice(2, 5)}-${p.slice(5, 8)}-${p.slice(8)}`;
const SECRET = `website-inbound-secret-${tag}-${'x'.repeat(12)}`;
const PUBLIC = 'https://base.example';
const MAIL_SECRET = `whsec_${Buffer.from(`wc-mail-secret-${tag}`).toString('base64')}`;
const KEYS = ['STARBASE_WEBSITE_URL', 'STARBASE_WEBSITE_KEY', 'STARBASE_PUBLIC_URL', 'STARBASE_OWN_URL', 'RENDER_EXTERNAL_URL', 'STARBASE_ENV',
  'MAILCHIMP_API_KEY', 'MAILCHIMP_API_BASE', 'MAILCHIMP_AUDIENCE_ID', 'MAILCHIMP_WEBHOOK_SECRET',
  'MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'SENDGRID_API_KEY',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_API_BASE', 'TWILIO_VOICE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

let db, site, other, resend, chimp;
let mgr, ws, makerId, key, keyId; // the first campaign: the one base.win's own site belongs to
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };

// The sync on (both settings), or off.
const syncOn = (more = {}) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { STARBASE_WEBSITE_URL: site.url, STARBASE_WEBSITE_KEY: SECRET, STARBASE_PUBLIC_URL: PUBLIC, ...more });
};
const syncOff = () => { for (const k of KEYS) delete process.env[k]; };

// One call to /in/v1/…, as the website's server makes it. → { status, json, text }
const call = async (path, { body, k = key, headers = {}, idem = null } = {}) => {
  const res = await app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(k ? { authorization: `Bearer ${k}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idem ? { 'idempotency-key': idem } : {}), ...headers,
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : stableJson(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
};
const AT = '2026-11-07T18:30:00.000Z';
const no = (more) => ({ channel: 'email', action: 'withdraw', reason: 'unsubscribe', at: AT, ...more });
const consent = (body, opts = {}) => call('/in/v1/consent', { body, ...opts });

const campaign = async (name) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: `${name} ${tag}`, email: mail(`mgr-${name.toLowerCase().replace(/\W+/g, '')}`), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { c, ws: r.json.workspace.id, userId: r.json.user.id };
};
const makeKey = async (c, name = 'Website') => ok(await c.action('intake.key.create', { name }));
const subscribe = async (c, ...who) => { for (const w of who) ok(await c.action('subscription.add', { email: mail(w), name: `${w} Example` })); };
const subOf = async (w, email) => (await db.query('select id, status, source, unsubscribed_at from subscriptions where workspace_id = $1 and email = $2', [w, email])).rows[0];
const tagsOf = async (id) => { const t = (await db.query('select tags from persons where id = $1', [id])).rows[0].tags; return typeof t === 'string' ? JSON.parse(t) : t; };
const consents = async (w, channel, address) => (await db.query(
  'select granted, source, person_id from consent_events where workspace_id = $1 and channel = $2 and address = $3 order by created_at, id', [w, channel, address],
)).rows;
const optout = async (w, num) => (await db.query('select opted_out, keyword from texting_optouts where workspace_id = $1 and phone = $2', [w, num])).rows[0];
const said = async (w) => (await db.query(
  "select payload, actor_id, action from events where workspace_id = $1 and entity_type = 'website_consent' order by seq", [w],
)).rows.map((r) => ({ ...(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload), actor: r.actor_id, action: r.action }));
const lastSaid = async (w) => (await said(w)).at(-1);

// The queue to the website.
const jobs = async (w) => (await db.query(
  "select id, status, attempts, payload, last_error, run_at, extract(epoch from run_at - now())::float as wait from jobs where workspace_id = $1 and kind = 'website.consent' order by created_at, id", [w],
)).rows.map((r) => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }));
// What is waiting to go, without each item's own id and time.
const queued = async (w) => (await jobs(w)).filter((j) => j.status === 'pending')
  .flatMap((j) => j.payload.items).map(({ id, at, ...x }) => x);
const clearQueue = (w) => db.query("delete from jobs where workspace_id = $1 and kind in ('website.consent', 'website.backfill')", [w]);
const dueNow = (w) => db.query("update jobs set run_at = now() where workspace_id = $1 and status = 'pending'", [w]);
// Jobs due now, once (the pace starts afresh: each test has its own minute).
const runOnce = async (w) => { _resetPaceForTest(); return runDueJobs(db, { workspaceId: w }); };
const run = async (w) => { for (let i = 0; i < 6; i += 1) { await dueNow(w); await runOnce(w); } };
// What a path queued, then nothing left behind for the next one.
const took = async (w) => { const q = await queued(w); await clearQueue(w); return q; };

before(async () => {
  db = await freshDb();
  site = await startFakeWebsite({ key: SECRET });
  other = await startFakeWebsite({ key: SECRET });
  resend = await startFakeMail({
    provider: 'resend', secret: MAIL_SECRET,
    deliver: async (raw, headers) => { const r = await app.request('/hooks/mail/resend', { method: 'POST', headers, body: raw }); return { status: r.status, body: await r.json().catch(() => null) }; },
  });
  chimp = await startFakeMailchimp({ apiKey: `mc-wc-${tag}-us19` });
  syncOff();
  const first = await campaign('Harbour');
  ({ c: mgr, ws } = first);
  makerId = first.userId;
  const made = await makeKey(mgr);
  key = made.key;
  keyId = made.id;
});
after(async () => {
  await site.close(); await other.close(); await resend.close(); await chimp.close();
  _setTimeoutForTest(null);
  _setRunMsForTest(null);
  _setClockForTest(null);
  globalThis.fetch = realFetch;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

// ── 1. Who may call ──
test('the key: none, a wrong one, a revoked one, one whose maker left → 401; a good key is never answered 404 or 403', async () => {
  const WORDS = 'a valid key goes in the Authorization header: Bearer sbk_…';
  const body = no({ email: mail('auth') });
  for (const k of [null, `sbk_${'x'.repeat(40)}`, 'not-a-key']) {
    const r = await consent(body, { k });
    assert.deepEqual([r.status, r.json], [401, { error: WORDS }]);
  }
  const { c: b } = await campaign('Auth');
  const revoked = await makeKey(b, 'Old site');
  ok(await b.action('intake.key.revoke', { id: revoked.id }));
  assert.deepEqual([(await consent(body, { k: revoked.key })).status, (await consent(body, { k: revoked.key })).json], [401, { error: WORDS }]);
  // A second manager makes a key, and leaves the campaign.
  const inv = ok(await b.action('member.invite', { email: mail('auth-mgr2'), role: 'manager' }));
  const b2 = new Client();
  const b2Id = (await b2.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Mo Example', password: 'website-pass-2' })).json.user.id;
  const theirs = await makeKey(b2, 'Their site');
  assert.equal((await consent(body, { k: theirs.key })).status, 200);
  ok(await b.action('member.remove', { user_id: b2Id }));
  assert.deepEqual([(await consent(body, { k: theirs.key })).status, (await consent(body, { k: theirs.key })).json], [401, { error: WORDS }]);

  // The website reads 404 as "not built yet" and 403 as "a wrong key": neither is ever said to a good key.
  const good = (await makeKey(b, 'Site')).key;
  const bodies = [body, no({ email: mail('nobody-at-all') }), { ...body, action: 'grant' }, {}, { nonsense: true }, 'not json', '[]', 'null',
    no({ phone: '+16045550100', channel: 'sms', reason: 'stop' }), no({ phone: 'x', channel: 'sms', reason: 'deletion' })];
  for (const x of bodies) {
    const r = await consent(x, { k: good });
    assert.ok(![403, 404].includes(r.status) && r.status < 500, `${JSON.stringify(x)} → ${r.status}`);
  }
  assert.ok(![403, 404].includes((await call('/in/v1/consent', { body: 'a=1', k: good, headers: { 'content-type': 'text/plain' } })).status));
});

test('120 calls a minute on one key, shared with /in/v1/people: the next is 429', async () => {
  const { c } = await campaign('Limit');
  const k = (await makeKey(c)).key;
  for (let i = 0; i < 119; i += 1) assert.equal((await call('/in/v1/ping', { k })).status, 200);
  assert.equal((await consent(no({ email: mail('limit') }), { k })).status, 200, 'the 120th');
  const over = await consent(no({ email: mail('limit') }), { k });
  assert.deepEqual([over.status, over.json], [429, { error: 'too many requests — 120 a minute per key' }]);
});

// ── 2. The body ──
test('a body outside the shape is refused, naming the field; every body the website builds is answered { ok: true } and nothing more', async () => {
  const base = no({ email: mail('shape') });
  const wrong = [
    [{ ...base, channel: 'fax' }, /^channel: /],
    [{ ...base, action: 'delete' }, /^action: /],
    [{ ...base, reason: 'bored' }, /^reason: /],
    [{ ...base, at: 'yesterday' }, /^at: /],
    [{ ...base, at: '2026-11-07T18:30:00' }, /^at: /], // no offset: which hour is it?
    [{ ...base, email: 'not-an-address' }, /^email: /],
    [{ ...base, phone: '6'.repeat(41) }, /^phone: /],
    [{ ...base, channel: undefined }, /^channel: /],
    [{ ...base, at: undefined }, /^at: /],
    [no({}), /^an email or a phone$/],
    [{ ...base, name: 'Pat Example' }, /name/], // a field it doesn't know
    [{ ...base, person_id: '1' }, /person_id/],
  ];
  for (const [body, words] of wrong) {
    const r = await consent(body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
    assert.match(r.json.error, words);
  }
  const notJson = await consent('{"email":');
  assert.deepEqual([notJson.status, notJson.json], [400, { error: 'the body isn’t JSON' }]);
  const noType = await app.request('/in/v1/consent', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: stableJson(base) });
  assert.equal(noType.status, 415);
  assert.equal((await call('/in/v1/consent', { body: 'email=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);

  // The five things the website sends (its own builder, its own bytes).
  const num = phone();
  const built = [
    consentPayload({ email: mail('Shape-News').toUpperCase(), channel: 'email', reason: 'unsubscribe' }), // a newsletter unsubscribe
    consentPayload({ email: mail('shape-pref'), channel: 'email', reason: 'preference' }), // email off in the preference centre
    consentPayload({ email: mail('shape-pref'), phone: num, channel: 'sms', reason: 'preference' }), // texts off there
    consentPayload({ email: mail('shape-pref'), channel: 'sms', reason: 'preference' }), // …with no number on file
    consentPayload({ phone: num, channel: 'sms', reason: 'stop' }), // a text STOP
    consentPayload({ email: mail('shape-gone'), channel: 'email', reason: 'deletion' }), // an anonymized supporter
    consentPayload({ email: mail('shape-gone'), phone: phone(), channel: 'sms', reason: 'deletion' }),
  ];
  for (const payload of built) {
    const req = requestFor(key, payload, `shape-${tag}-${built.indexOf(payload)}`);
    assert.deepEqual(Object.keys(JSON.parse(req.body)), Object.keys(payload).sort(), 'keys sorted, as the website sends them');
    const res = await app.request(CONSENT_ENDPOINT, req);
    assert.deepEqual([res.status, await res.text()], [200, '{"ok":true}'], JSON.stringify(payload));
  }
});

// ── 3. An email no ──
test('email: on the list → unsubscribed, with the no on the record; never on the list → do-not-email on everyone with the address, and the address is held', async () => {
  const ana = await mgr.createPerson('Ana Example', { email: mail('ana') });
  await subscribe(mgr, 'ana');
  ok(await consent(no({ email: mail('ana') })));
  assert.equal((await subOf(ws, mail('ana'))).status, 'unsubscribed');
  assert.deepEqual(await consents(ws, 'email', mail('ana')), [
    { granted: true, source: 'desk-added', person_id: ana.id }, { granted: false, source: 'website-unsubscribe', person_id: ana.id },
  ]);
  assert.deepEqual(await tagsOf(ana.id), [], 'on the list: the list row says it, as every unsubscribe here');
  const a = await lastSaid(ws);
  assert.deepEqual([a.channel, a.reason, a.at, a.outcome, a.people, a.key], ['email', 'unsubscribe', AT, 'applied', 1, 'Website']);
  assert.ok(!JSON.stringify(a).includes(mail('ana')), 'the line on the log carries no address');

  // A household shares one address; neither is on the list (a list email reached them).
  const ben = await mgr.createPerson('Ben Example', { email: mail('ben'), tags: ['member'] });
  const bea = await mgr.createPerson('Bea Example', { email: mail('BEN').toUpperCase() });
  ok(await consent(no({ email: mail('ben'), reason: 'preference' })));
  assert.deepEqual([await tagsOf(ben.id), await tagsOf(bea.id)], [['member', 'do-not-email'], ['do-not-email']]);
  const held = await subOf(ws, mail('ben'));
  assert.deepEqual([held.status, held.source, new Date(held.unsubscribed_at).toISOString()], ['unsubscribed', 'website', AT], 'the row that holds it, dated when it happened');
  const rows = await consents(ws, 'email', mail('ben'));
  assert.deepEqual(rows.map((r) => [r.granted, r.source]).sort(), [[false, 'website-preference'], [false, 'website-preference']]);
  assert.deepEqual(rows.map((r) => r.person_id).sort(), [ben.id, bea.id].sort(), 'one no for each of them');
  assert.ok(rows.every((r) => r.granted === false), 'the row that holds a no is never read as a yes');
  assert.deepEqual([(await lastSaid(ws)).outcome, (await lastSaid(ws)).people], ['applied', 2]);
});

// ── 4. An address nobody has yet ──
test('an address nobody has: held from then on — a later sign-up, an import, the desk’s Add; the answer is the same as for someone on file', async () => {
  await mgr.createPerson('Kay Example', { email: mail('known') });
  await subscribe(mgr, 'known');
  const known = await consent(no({ email: mail('known') }));
  const unknown = await consent(no({ email: mail('ghost') }));
  assert.deepEqual([known.status, unknown.status], [200, 200]);
  assert.equal(known.text, unknown.text, 'never whether they were on file');
  const row = await subOf(ws, mail('ghost'));
  assert.deepEqual([row.status, row.source], ['unsubscribed', 'website']);
  assert.deepEqual(await consents(ws, 'email', mail('ghost')), [{ granted: false, source: 'website-unsubscribe', person_id: null }]);
  assert.deepEqual([(await lastSaid(ws)).outcome, (await lastSaid(ws)).people], ['tombstone', 0]);

  // The website's own sign-up form, with the newsletter box ticked.
  const p = ok(await call('/in/v1/people', { body: { name: 'Gil Ghost', email: mail('ghost'), newsletter: true } }));
  assert.equal((await subOf(ws, mail('ghost'))).status, 'unsubscribed', 'typing an address into a form does not put it back');
  // Whoever is imported with it later is held from a list send.
  const imp = await mgr.post('/api/data/import', { rows: [{ name: 'Gail Ghost', email: mail('ghost'), phone: '604-555-0188' }] });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  const people = (await db.query('select id, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null', [ws, mail('ghost')])).rows;
  assert.ok(people.some((x) => x.id === p.person_id) && people.length >= 1);
  for (const x of people) {
    assert.equal(await whyNot(db, 'email', 'eblast', { workspaceId: ws, email: mail('ghost'), tags: [], personId: x.id }), 'unsubscribed');
    assert.equal(await whyNot(db, 'email', 'newsletter', { workspaceId: ws, email: mail('ghost'), tags: [], personId: x.id }), 'unsubscribed');
  }
  const add = await mgr.action('subscription.add', { email: mail('ghost') });
  assert.equal(add.status, 409);
  assert.match(add.json.error, /only they can rejoin/);
  // Said again: nothing more is written.
  const before2 = (await consents(ws, 'email', mail('ghost'))).length;
  ok(await consent(no({ email: mail('ghost') })));
  assert.equal((await consents(ws, 'email', mail('ghost'))).length, before2);
  assert.equal((await lastSaid(ws)).outcome, 'already');
});

// ── 5. A text no ──
test('texts: a STOP for the number in any format — everyone with it, and whoever gets it later; texts off by email stops that person’s own number', async () => {
  const num = phone();
  const formats = [num, dashed(num), `(${num.slice(2, 5)}) ${num.slice(5, 8)} ${num.slice(8)}`];
  const three = [];
  for (const [i, f] of formats.entries()) three.push(await mgr.createPerson(`Stop ${i} Example`, { phone: f }));
  ok(await consent({ phone: num, channel: 'sms', action: 'withdraw', reason: 'stop', at: AT }));
  assert.deepEqual(await optout(ws, num), { opted_out: true, keyword: 'WEBSITE SYNC' });
  for (const p of three) assert.ok((await tagsOf(p.id)).includes('do-not-text'), 'everyone with the number, however it was typed');
  assert.deepEqual((await consents(ws, 'sms', num)).map((r) => [r.granted, r.source]), [[false, 'text-stop'], [false, 'text-stop'], [false, 'text-stop']]);
  assert.deepEqual([(await lastSaid(ws)).outcome, (await lastSaid(ws)).people], ['applied', 3]);
  // The same STOP again, the number typed another way: nothing more.
  ok(await consent({ phone: dashed(num), channel: 'sms', action: 'withdraw', reason: 'stop', at: AT }));
  assert.equal((await consents(ws, 'sms', num)).length, 3);
  assert.equal((await lastSaid(ws)).outcome, 'already');

  // A number nobody has yet, sent with dashes: held, so a record made with it later cannot be texted.
  const later = phone();
  ok(await consent({ phone: dashed(later), channel: 'sms', action: 'withdraw', reason: 'stop', at: AT }));
  assert.deepEqual(await optout(ws, later), { opted_out: true, keyword: 'WEBSITE SYNC' });
  assert.equal((await lastSaid(ws)).outcome, 'tombstone');
  const lee = await mgr.createPerson('Lee Later', { phone: dashed(later) });
  assert.equal(await whyNot(db, 'text', 'blast', { workspaceId: ws, phone: dashed(later), tags: [], personId: lee.id }), 'opted_out');

  // Texts off in the website's preference centre, with only the email: that person's own number is stopped.
  const own = phone();
  const pia = await mgr.createPerson('Pia Example', { email: mail('pia'), phone: dashed(own) });
  ok(await consent({ email: mail('pia'), channel: 'sms', action: 'withdraw', reason: 'preference', at: AT }));
  assert.deepEqual(await optout(ws, own), { opted_out: true, keyword: 'WEBSITE SYNC' });
  assert.ok((await tagsOf(pia.id)).includes('do-not-text'));
  assert.equal((await db.query("select granted, source from consent_events where workspace_id = $1 and person_id = $2 and channel = 'sms' order by created_at desc limit 1", [ws, pia.id])).rows[0].source, 'website-preference');
  assert.equal((await subOf(ws, mail('pia'))), undefined, 'texts off says nothing about email');
  // Neither a number that can be dialled nor anyone with the address: there is nothing to hold.
  ok(await consent({ email: mail('nobody-sms'), phone: '555', channel: 'sms', action: 'withdraw', reason: 'preference', at: AT }));
  assert.equal((await lastSaid(ws)).outcome, 'no-match');
});

// ── 6. What is not applied ──
test('a deletion is a no and deletes nobody; a yes changes nothing; already off writes nothing; their own later yes stands', async () => {
  const del = await mgr.createPerson('Del Example', { email: mail('del'), phone: dashed(phone()) });
  await subscribe(mgr, 'del');
  ok(await consent(no({ email: mail('del'), reason: 'deletion' })));
  ok(await consent({ email: mail('del'), channel: 'sms', action: 'withdraw', reason: 'deletion', at: AT }));
  const row = (await db.query('select name, email, deleted_at from persons where id = $1', [del.id])).rows[0];
  assert.deepEqual([row.name, row.email, row.deleted_at], ['Del Example', mail('del'), null], 'base.win deletes nobody by itself');
  assert.equal((await subOf(ws, mail('del'))).status, 'unsubscribed');
  assert.ok((await tagsOf(del.id)).includes('do-not-text'));
  assert.equal((await consents(ws, 'email', mail('del'))).at(-1).source, 'website-deletion');

  // A yes from the website is answered and not applied.
  const yes = await consent({ ...no({ email: mail('del') }), action: 'grant' });
  assert.deepEqual([yes.status, yes.text], [200, '{"ok":true}']);
  assert.equal((await subOf(ws, mail('del'))).status, 'unsubscribed');
  assert.equal((await lastSaid(ws)).outcome, 'grant-ignored');
  await mgr.createPerson('Gwen Example', { email: mail('gwen') });
  ok(await consent({ ...no({ email: mail('gwen') }), action: 'grant' }));
  assert.equal(await subOf(ws, mail('gwen')), undefined, 'nobody is put on the list from the website’s yes');

  // Already off: no second line on the consent record; one line on the log that says so.
  const n = (await consents(ws, 'email', mail('del'))).length;
  const lines = (await said(ws)).length;
  ok(await consent(no({ email: mail('del') })));
  assert.equal((await consents(ws, 'email', mail('del'))).length, n);
  assert.deepEqual([(await said(ws)).length, (await lastSaid(ws)).outcome, (await lastSaid(ws)).people], [lines + 1, 'already', 0]);

  // Their own yes (a box they ticked, with the words) after the no happened: the yes stands.
  const sam = await mgr.createPerson('Sam Example', { email: mail('sam') });
  await subscribe(mgr, 'sam');
  await runAction(db, { workspaceId: ws, actorId: null, action: 'site.form' }, (tx, emit) => recordConsent(tx, ws, {
    personId: sam.id, channel: 'email', granted: true, source: 'website-newsletter', wording: 'Yes, email me news.', address: mail('sam'),
  }, emit));
  ok(await consent(no({ email: mail('sam'), at: '2026-01-05T10:00:00-08:00' })), 'a no from last winter, late to arrive');
  assert.equal((await subOf(ws, mail('sam'))).status, 'subscribed');
  assert.equal((await lastSaid(ws)).outcome, 'superseded');
  // The same no, dated after their yes (a time in the future is read as now): applied.
  ok(await consent(no({ email: mail('sam'), at: new Date(Date.now() + 3600_000).toISOString() })));
  assert.equal((await subOf(ws, mail('sam'))).status, 'unsubscribed');
  // A START from the number after the STOP happened stands too.
  const num = phone();
  await mgr.createPerson('Tess Example', { phone: num });
  await runAction(db, { workspaceId: ws, actorId: null, action: 'twilio.sms_in' }, (tx, emit) => applyOptOut(tx, emit, ws, num, { out: true, keyword: 'STOP' }));
  await runAction(db, { workspaceId: ws, actorId: null, action: 'twilio.sms_in' }, (tx, emit) => applyOptOut(tx, emit, ws, num, { out: false, keyword: 'START' }));
  ok(await consent({ phone: num, channel: 'sms', action: 'withdraw', reason: 'stop', at: '2026-01-05T10:00:00-08:00' }));
  assert.equal((await optout(ws, num)).opted_out, false);
  assert.equal((await lastSaid(ws)).outcome, 'superseded');
});

// ── 7. Retries, and the record ──
test('the same Idempotency-Key and body is a replay and writes nothing; another body is 409; two at once apply once — all on the log as the key’s maker', async () => {
  await mgr.createPerson('Ida Example', { email: mail('ida') });
  await subscribe(mgr, 'ida');
  const body = no({ email: mail('ida') });
  const seq = async () => Number((await db.query('select event_seq from workspaces where id = $1', [ws])).rows[0].event_seq);
  const first = await consent(body, { idem: `row-${tag}-1` });
  assert.deepEqual([first.status, first.json], [200, { ok: true }]);
  const at = await seq();
  const again = await consent(body, { idem: `row-${tag}-1` });
  assert.deepEqual([again.status, again.json], [200, { ok: true, replayed: true }]);
  assert.equal(await seq(), at, 'a replay writes no event');
  assert.equal(classifyAnswer(again.status, again.json, CONSENT_ENDPOINT).kind, 'ok', 'which the website reads as taken');
  const clash = await consent(no({ email: mail('someone-else') }), { idem: `row-${tag}-1` });
  assert.deepEqual([clash.status, clash.json], [409, { error: 'that Idempotency-Key was used with a different body' }]);
  assert.equal(await subOf(ws, mail('someone-else')), undefined);

  // Two deliveries of one row at the same moment.
  await mgr.createPerson('Ivo Example', { email: mail('ivo') });
  await subscribe(mgr, 'ivo');
  const lines = (await said(ws)).length;
  const both = await Promise.all([consent(no({ email: mail('ivo') }), { idem: `row-${tag}-2` }), consent(no({ email: mail('ivo') }), { idem: `row-${tag}-2` })]);
  assert.deepEqual(both.map((r) => r.status), [200, 200]);
  assert.deepEqual(both.map((r) => r.json.replayed === true).sort(), [false, true], 'one applied it, one found it applied');
  assert.equal((await said(ws)).length, lines + 1, 'applied once');
  assert.equal((await consents(ws, 'email', mail('ivo'))).filter((r) => !r.granted).length, 1);

  // Everything the website's key did is on the campaign's log as the manager who made the key.
  const log = (await db.query("select actor_id, entity_type from events where workspace_id = $1 and action = 'intake.consent'", [ws])).rows;
  assert.ok(log.length > 10 && log.every((e) => e.actor_id === makerId));
  for (const kind of ['website_consent', 'subscription', 'person', 'texting_optout', 'consent_event']) assert.ok(log.some((e) => e.entity_type === kind), kind);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true, 'the chain verifies');
  assert.ok((await db.query('select last_used_at from intake_keys where id = $1', [keyId])).rows[0].last_used_at);
});

// ── 8. Campaigns stay apart ──
test('two campaigns in one database: one campaign’s key never changes the other’s record with the same address', async () => {
  const { c: b, ws: wsB } = await campaign('Apart');
  await mgr.createPerson('Uma Example', { email: mail('uma') });
  await subscribe(mgr, 'uma');
  const theirs = await b.createPerson('Uma Example', { email: mail('uma'), phone: '604-555-0170' });
  await subscribe(b, 'uma');
  ok(await consent(no({ email: mail('uma') })));
  ok(await consent({ phone: '604-555-0170', channel: 'sms', action: 'withdraw', reason: 'stop', at: AT }));
  assert.equal((await subOf(ws, mail('uma'))).status, 'unsubscribed');
  assert.equal((await subOf(wsB, mail('uma'))).status, 'subscribed');
  assert.deepEqual(await tagsOf(theirs.id), []);
  assert.equal(await optout(wsB, '+16045550170'), undefined);
  assert.equal((await db.query("select count(*)::int as n from events where workspace_id = $1 and action = 'intake.consent'", [wsB])).rows[0].n, 0);
  // And the other way, with the other campaign's own key.
  const keyB = (await makeKey(b)).key;
  await mgr.createPerson('Vic Example', { email: mail('vic') });
  await subscribe(mgr, 'vic');
  ok(await consent(no({ email: mail('vic') }), { k: keyB }));
  assert.equal((await subOf(ws, mail('vic'))).status, 'subscribed');
  assert.equal((await subOf(wsB, mail('vic'))).status, 'unsubscribed', 'held in the campaign whose key it was');
});

// ── 9. Going out: what is sent ──
const email = (who, reason = 'unsubscribe') => ({ channel: 'email', email: mail(who), reason });

test('out: an unsubscribe by any of base.win’s own links, the desk’s Remove, a no from Mailchimp, a spam complaint — one item each', async () => {
  syncOn();
  await clearQueue(ws);
  const people = {};
  for (const w of ['o-ana', 'o-ben', 'o-cal', 'o-dee', 'o-eli', 'o-fay', 'o-gus', 'o-hal', 'o-ivy']) people[w] = await mgr.createPerson(`${w} Example`, { email: mail(w), tags: ['member'] });
  await subscribe(mgr, 'o-ana', 'o-ben', 'o-eli', 'o-fay', 'o-gus', 'o-hal');
  assert.deepEqual(await took(ws), [], 'joining the list is not a no');

  // /u: the newsletter's own link.
  assert.equal((await app.request(`/u/${(await subOf(ws, mail('o-ana'))).id}`, { method: 'POST' })).status, 200);
  assert.deepEqual(await took(ws), [email('o-ana')]);
  assert.equal((await app.request(`/u/${(await subOf(ws, mail('o-ana'))).id}`, { method: 'POST' })).status, 200);
  assert.deepEqual(await took(ws), [], 'a second click says nothing new');

  // /bu: a list email's link — someone on the newsletter, and someone who never was.
  const list = ok(await mgr.action('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'member' } })).list;
  ok(await mgr.action('blast.send', { kind: 'eblast', subject: 'Hello', body: 'Hello there', audience: { list_id: list.id } }));
  const theirLink = async (who) => (await db.query('select id from blast_recipients where workspace_id = $1 and lower(email) = $2 order by id limit 1', [ws, mail(who)])).rows[0].id;
  await clearQueue(ws);
  assert.equal((await app.request(`/bu/${await theirLink('o-ben')}`, { method: 'POST' })).status, 200);
  assert.deepEqual(await took(ws), [email('o-ben')], 'the list row and the tag are one no');
  assert.equal((await app.request(`/bu/${await theirLink('o-cal')}`, { method: 'POST' })).status, 200);
  assert.deepEqual(await took(ws), [email('o-cal')]);

  // /lu: a ladder email's link, for someone never on the list.
  const ladder = ok(await mgr.action('ladder.create', { name: 'Thanks', trigger: { kind: 'tag', ref: 'signer' }, steps: [{ kind: 'wait', n: 1, unit: 'days' }, { kind: 'tag', tag: 'thanked' }] })).ladder;
  ok(await mgr.action('ladder.setActive', { id: ladder.id, active: true }));
  ok(await mgr.action('person.update', { id: people['o-dee'].id, tags: ['member', 'signer'] }));
  const runId = (await db.query('select id from ladder_runs where workspace_id = $1 and person_id = $2 limit 1', [ws, people['o-dee'].id])).rows[0].id;
  await clearQueue(ws);
  assert.equal((await app.request(`/lu/${runId}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' })).status, 200);
  assert.deepEqual(await took(ws), [email('o-dee')]);

  // base.win's own site: /unsubscribe, and email off on /preferences.
  const t = await personToken(ws, people['o-eli'].id);
  assert.equal((await hit('/site/unsubscribe', { method: 'POST', form: { t } })).status, 200);
  assert.deepEqual(await took(ws), [email('o-eli')]);
  const tf = await personToken(ws, people['o-fay'].id);
  assert.equal((await hit('/site/preferences', { form: { t: tf } })).status, 200); // both boxes off
  assert.deepEqual(await took(ws), [email('o-fay', 'preference')]);

  // The desk's Remove.
  ok(await mgr.action('subscription.remove', { id: (await subOf(ws, mail('o-gus'))).id }));
  assert.deepEqual(await took(ws), [email('o-gus')]);

  // A no from Mailchimp (its nightly pull finds she left there).
  Object.assign(process.env, { MAILCHIMP_API_KEY: `mc-wc-${tag}-us19`, MAILCHIMP_API_BASE: chimp.url });
  _forgetAudienceForTest();
  await db.query('insert into mailchimp_state (workspace_id, agreed_for) values ($1, $2) on conflict (workspace_id) do update set agreed_for = excluded.agreed_for', [ws, chimp.id]);
  chimp.add(mail('o-hal'), { status: 'unsubscribed' });
  site.reset();
  ok(await mgr.action('mailchimp.pull', {}));
  _resetPaceForTest();
  for (let i = 0; i < 6; i += 1) await runDueJobs(db, { workspaceId: ws }); // the pull, then what it queued
  assert.equal((await subOf(ws, mail('o-hal'))).status, 'unsubscribed');
  assert.deepEqual(site.ledger.map((x) => [x.channel, x.email, x.reason]), [['email', mail('o-hal'), 'unsubscribe']], 'what Mailchimp said is passed on to the website');
  await clearQueue(ws);
  for (const k of ['MAILCHIMP_API_KEY', 'MAILCHIMP_API_BASE']) delete process.env[k];

  // A spam complaint (the email sender's webhook).
  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: resend.url, RESEND_WEBHOOK_SECRET: MAIL_SECRET, MAIL_FROM: 'Harbour <team@example.org>' });
  const again = ok(await mgr.action('list.create', { name: 'Ivy only', kind: 'filter', filter: { tag: 'ivy' } })).list;
  ok(await mgr.action('person.update', { id: people['o-ivy'].id, tags: ['member', 'ivy'] }));
  const sent = ok(await mgr.action('blast.send', { kind: 'eblast', subject: 'AGM', body: 'Saturday', audience: { list_id: again.id } }));
  const ivy = (await db.query('select id from blast_recipients where blast_id = $1 and lower(email) = $2', [sent.blast.id, mail('o-ivy')])).rows[0];
  await clearQueue(ws);
  assert.equal((await resend.event('complained', { ref: ivy.id })).status, 200);
  assert.deepEqual(await took(ws), [email('o-ivy')]);
  // A bounce is about the address, not a person's no: nothing.
  const jo = await mgr.createPerson('Jo Example', { email: mail('o-jo') });
  await runAction(db, { workspaceId: ws, actorId: null, action: 'mail.event' }, (tx, emit) => suppress(tx, emit, ws, { email: mail('o-jo'), reason: 'bounce', source: 'resend' }));
  assert.ok(jo.id);
  assert.deepEqual(await took(ws), []);
  for (const k of ['RESEND_API_KEY', 'RESEND_API_BASE', 'RESEND_WEBHOOK_SECRET', 'MAIL_FROM']) delete process.env[k];
  syncOff();
});

test('out: a text STOP (signed, from Twilio), the Inbox’s one tap, the carrier’s “they stopped”, texts off on the site — one item each; never a START', async () => {
  syncOn();
  await clearQueue(ws);
  const TOKEN = `tw-token-${tag}`;
  const FROM = '+16045550100';
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: `ACwc${tag}`, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM: FROM });
  let reply = null;
  let sidN = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://api.twilio.com/')) return realFetch(url, init);
    const r = reply ? reply() : { status: 201, body: { sid: `SMwc${tag}${sidN += 1}`, status: 'queued' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  _setClockForTest(() => new Date('2026-10-22T19:00:00Z')); // noon in British Columbia: inside texting hours
  const name = `Harbour ${tag}`;
  const inbound = async (from, body) => {
    const path = '/api/public/twilio/sms';
    const fields = { From: from, To: FROM, Body: body, MessageSid: `SMin${tag}${sidN += 1}`, AccountSid: `ACwc${tag}` };
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, `${PUBLIC}${path}`, new URLSearchParams(fields)) },
      body: new URLSearchParams(fields).toString(),
    });
    assert.equal(res.status, 200);
  };
  try {
    // A STOP text: one item, for the number — the tag it puts on is the same no.
    const a = phone();
    const ann = await mgr.createPerson('Ann Example', { email: mail('t-ann'), phone: dashed(a) });
    assert.equal(ok(await mgr.action('text.send', { person_id: ann.id, body: `Hi Ann, it's the desk with ${name}.` })).sent, true);
    await clearQueue(ws);
    await inbound(a, 'STOP');
    assert.ok((await tagsOf(ann.id)).includes('do-not-text'));
    assert.deepEqual(await took(ws), [{ channel: 'sms', phone: a, reason: 'stop' }]);
    // START: a yes is never sent.
    await inbound(a, 'START');
    assert.equal((await optout(ws, a)).opted_out, false);
    assert.deepEqual(await took(ws), []);

    // "No thanks, stop" only flags the thread; the one tap in the Inbox is the no.
    const b = phone();
    const bo = await mgr.createPerson('Bo Example', { phone: dashed(b) });
    const conv = ok(await mgr.action('text.send', { person_id: bo.id, body: `Hi Bo, it's the desk with ${name}.` })).conversation_id;
    await inbound(b, 'No thanks, stop');
    assert.deepEqual(await took(ws), [], 'flagged for a person: not a no until someone taps');
    ok(await mgr.action('text.optout', { conversation_id: conv }));
    assert.deepEqual(await took(ws), [{ channel: 'sms', phone: b, reason: 'stop' }]);

    // Twilio 21610: the carrier already has the number opted out.
    const c = phone();
    const cy = await mgr.createPerson('Cy Example', { phone: dashed(c) });
    reply = () => ({ status: 400, body: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } });
    assert.equal(ok(await mgr.action('text.send', { person_id: cy.id, body: `Hi Cy, it's the desk with ${name}.` })).sent, false);
    reply = null;
    assert.deepEqual(await took(ws), [{ channel: 'sms', phone: c, reason: 'stop' }]);

    // Texts off on base.win's own site (their signed link).
    const d = phone();
    const di = await mgr.createPerson('Di Example', { email: mail('t-di'), phone: dashed(d) });
    assert.equal((await hit('/site/preferences', { form: { t: await personToken(ws, di.id), email: 'on' } })).status, 200); // texts box off
    assert.deepEqual((await took(ws)).filter((x) => x.channel === 'sms'), [{ channel: 'sms', phone: d, reason: 'stop' }]);
  } finally {
    globalThis.fetch = realFetch;
    _setClockForTest(null);
    syncOff();
  }
});

test('out: a tag newly put on — do-not-email, do-not-text, do-not-contact, by the desk, an import or a merge; nothing for a tag taken off, another tag beside it, do-not-call, a press release’s own link, Add, or the sample campaign', async () => {
  syncOn();
  await clearQueue(ws);
  const tags = (p, ...t) => mgr.action('person.update', { id: p.id, tags: t }).then(ok);
  const n = phone();
  const kim = await mgr.createPerson('Kim Example', { email: mail('g-kim'), phone: dashed(n) });
  await tags(kim, 'Do-Not-Email'); // typed in capitals: it counts
  assert.deepEqual(await took(ws), [email('g-kim')]);
  await tags(kim, 'Do-Not-Email', 'volunteer'); // another tag on someone already off
  assert.deepEqual(await took(ws), []);
  await tags(kim, 'Do-Not-Email', 'volunteer', 'do-not-text');
  assert.deepEqual(await took(ws), [{ channel: 'sms', email: mail('g-kim'), phone: n, reason: 'preference' }]);
  await tags(kim, 'volunteer'); // both taken off: a yes is never sent
  assert.deepEqual(await took(ws), []);
  await tags(kim, 'volunteer', 'do-not-call');
  assert.deepEqual(await took(ws), [], 'do-not-call is about the phone ringing, not email or texts');
  await tags(kim, 'volunteer', 'do-not-contact');
  assert.deepEqual((await took(ws)).sort((a, b) => a.channel.localeCompare(b.channel)), [email('g-kim'), { channel: 'sms', email: mail('g-kim'), phone: n, reason: 'preference' }]);
  // Already off, given another address: the new address is told.
  ok(await mgr.action('person.update', { id: kim.id, email: mail('g-kim2') }));
  assert.deepEqual(await took(ws), [email('g-kim2')]);
  // Someone new, made already tagged; an address that is not one is never sent as one.
  await mgr.createPerson('Lou Example', { email: mail('g-lou'), tags: ['do-not-email'] });
  assert.deepEqual(await took(ws), [email('g-lou')]);
  await mgr.createPerson('Max Example', { phone: '555', tags: ['do-not-text'] });
  assert.deepEqual(await took(ws), [], 'no address and no number that can be dialled: nothing to say');

  // An import (it syncs like any other write).
  const imp = await mgr.post('/api/data/import', { rows: [
    { name: 'Ned Example', email: mail('g-ned'), tags: 'do-not-email' }, { name: 'Ola Example', email: mail('g-ola'), tags: 'member' },
  ] });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  assert.deepEqual(await took(ws), [email('g-ned')]);

  // A merge: the record that is kept takes the other's do-not-email.
  const keep = await mgr.createPerson('Pat Example', { email: mail('g-pat') });
  const drop = await mgr.createPerson('Pat Example', { phone: '604-555-0199', tags: ['do-not-email'] });
  await clearQueue(ws);
  ok(await mgr.action('person.merge', { keep: keep.id, drop: drop.id }));
  assert.deepEqual(await took(ws), [email('g-pat')]);

  // The desk's Add is a yes: never sent.
  await mgr.createPerson('Quin Example', { email: mail('g-quin') });
  await subscribe(mgr, 'g-quin');
  assert.deepEqual(await took(ws), []);

  // A press release's own unsubscribe is about releases only.
  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: resend.url, MAIL_FROM: 'Harbour <team@example.org>' });
  await mgr.createPerson('Rae Reporter', { email: mail('g-rae'), tags: ['media'] });
  ok(await mgr.action('media.send', { subject: 'Release', body: 'News today' }));
  const rid = (await db.query("select r.id from blast_recipients r join blasts b on b.id = r.blast_id where r.workspace_id = $1 and b.kind = 'press' and lower(r.email) = $2", [ws, mail('g-rae')])).rows[0].id;
  await clearQueue(ws);
  assert.equal((await app.request(`/bu/${rid}`, { method: 'POST' })).status, 200);
  assert.deepEqual(await took(ws), []);
  for (const k of ['RESEND_API_KEY', 'RESEND_API_BASE', 'MAIL_FROM']) delete process.env[k];

  // The sample campaign's made-up people speak for nobody.
  const { c: s, ws: wsS } = await campaign('Sample');
  await makeKey(s);
  const load = await s.post('/api/data/sample', {});
  assert.equal(load.status, 200, JSON.stringify(load.json));
  assert.deepEqual(await queued(wsS), []);
  assert.equal((await s.req('DELETE', '/api/data/sample')).status, 200);
  assert.deepEqual(await queued(wsS), []);
  syncOff();
});

// ── 10. No echo; and when nothing is sent ──
test('what the website said is never sent back; and nothing is sent with a setting missing, an address that is not https, base.win’s own, a base.win address, on staging, or with no website key', async () => {
  syncOn();
  site.reset();
  await clearQueue(ws);
  await mgr.createPerson('Echo Example', { email: mail('echo'), phone: dashed(phone()) });
  await subscribe(mgr, 'echo');
  ok(await consent(no({ email: mail('echo') })));
  ok(await consent({ email: mail('echo'), channel: 'sms', action: 'withdraw', reason: 'preference', at: AT }));
  ok(await consent(no({ email: mail('echo-ghost') })));
  ok(await consent({ phone: phone(), channel: 'sms', action: 'withdraw', reason: 'stop', at: AT }));
  assert.deepEqual(await jobs(ws), [], 'no job for anything the website itself said');
  await run(ws);
  assert.equal(site.calls.length, 0, 'and no call');

  // Each way of being off: the desk takes someone off the list, and nothing is queued.
  let i = 0;
  const quiet = async (why, set, c = mgr, w = ws) => {
    i += 1;
    await c.createPerson(`Off ${i} Example`, { email: mail(`off-${i}`) });
    await subscribe(c, `off-${i}`);
    syncOn();
    set();
    ok(await c.action('subscription.remove', { id: (await subOf(w, mail(`off-${i}`))).id }));
    assert.deepEqual(await jobs(w), [], why);
    await run(w);
    assert.equal(site.calls.length, 0, why);
  };
  await quiet('no address', () => { delete process.env.STARBASE_WEBSITE_URL; });
  await quiet('no key', () => { delete process.env.STARBASE_WEBSITE_KEY; });
  await quiet('http, somewhere else', () => { process.env.STARBASE_WEBSITE_URL = 'http://www.example.org'; });
  await quiet('not an address', () => { process.env.STARBASE_WEBSITE_URL = 'www.example.org'; });
  await quiet('this server’s own address', () => { process.env.STARBASE_WEBSITE_URL = 'https://base.example'; });
  await quiet('a base.win address', () => { process.env.STARBASE_WEBSITE_URL = 'https://another.base.win'; });
  await quiet('base.win itself', () => { process.env.STARBASE_WEBSITE_URL = 'https://base.win'; });
  await quiet('staging', () => { process.env.STARBASE_ENV = 'staging'; });
  // A campaign with no live website key: the sync belongs to the campaign the website's key belongs to.
  const { c: b, ws: wsB } = await campaign('Nokey');
  await quiet('no website key', () => {}, b, wsB);
  const k = await makeKey(b);
  ok(await b.action('intake.key.revoke', { id: k.id }));
  await quiet('only a revoked key', () => {}, b, wsB);
  // With everything in place it does go (so the checks above mean something).
  syncOn();
  await mgr.createPerson('On Example', { email: mail('on-1') });
  await subscribe(mgr, 'on-1');
  ok(await mgr.action('subscription.remove', { id: (await subOf(ws, mail('on-1'))).id }));
  assert.deepEqual(await queued(ws), [email('on-1')]);
  await run(ws);
  assert.deepEqual(site.ledger.map((x) => [x.email, x.channel, x.reason]), [[mail('on-1'), 'email', 'unsubscribe']]);
  syncOff();
});

// ── 11. The job ──
test('the job: the website’s own headers and the exact bytes; a retry is the same key and the same bytes; a fault that is not the item’s own never uses a try', async () => {
  syncOn();
  site.reset();
  await clearQueue(ws);
  const n = phone();
  await mgr.createPerson('Job Example', { email: mail('job'), phone: dashed(n) });
  await subscribe(mgr, 'job');
  ok(await mgr.action('subscription.remove', { id: (await subOf(ws, mail('job'))).id }));
  const [job] = await jobs(ws);
  const item = job.payload.items[0];
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  assert.equal(new Date(item.at).toISOString(), item.at, 'the time, as toISOString writes it');

  // The website is down: the no waits, and no try is counted.
  site.fail(500);
  assert.deepEqual(await runOnce(ws), { ran: 0, failed: 0 });
  let [j] = await jobs(ws);
  assert.deepEqual([j.status, j.attempts, j.payload.tries, j.payload.last.status, j.payload.items.length], ['pending', 0, 1, 500, 1]);
  assert.ok(Math.abs(j.wait - WAITS_MS[0] / 1000) < 5, `waits a minute: ${j.wait}`);
  site.fail(false);
  await dueNow(ws);
  assert.deepEqual(await runOnce(ws), { ran: 1, failed: 0 });
  [j] = await jobs(ws);
  assert.deepEqual([j.status, j.payload.items, j.payload.tries], ['done', [], 0]);

  const [first, second] = site.calls;
  assert.equal(site.calls.length, 2);
  assert.deepEqual([first.method, first.path, first.auth, first.type, first.key], ['POST', '/api/in/consent', `Bearer ${SECRET}`, 'application/json', item.id]);
  assert.equal(first.raw, `{"action":"withdraw","at":"${item.at}","channel":"email","email":"${mail('job')}","reason":"unsubscribe"}`, 'these fields, in this order, and nothing else');
  assert.deepEqual([second.key, second.raw], [first.key, first.raw], 'the retry is the same key and the same bytes');
  assert.deepEqual(site.ledger.map((x) => [x.email, x.key]), [[mail('job'), item.id]], 'taken once');
  // Nothing of the person leaves but the address or number.
  ok(await mgr.action('person.update', { id: (await db.query('select id from persons where workspace_id = $1 and email = $2', [ws, mail('job')])).rows[0].id, tags: ['member', 'do-not-text'] }));
  await run(ws);
  assert.equal(site.calls.at(-1).raw, `{"action":"withdraw","at":"${JSON.parse(site.calls.at(-1).raw).at}","channel":"sms","email":"${mail('job')}","phone":"${n}","reason":"preference"}`);
  for (const c of site.calls) assert.ok(!/Job Example|member|person/.test(c.raw));

  // Each fault that is the website's or the settings': still pending, no try used, tried again later.
  const waiting = async (why, breakIt, mend, status) => {
    site.reset();
    await clearQueue(ws);
    await enqueueJob(db, { workspaceId: ws, kind: 'website.consent', payload: { items: [{ id: crypto.randomUUID(), channel: 'email', email: mail('wait'), reason: 'unsubscribe', at: AT }], tries: 0 } });
    breakIt();
    assert.deepEqual(await runOnce(ws), { ran: 0, failed: 0 }, why);
    const [w] = await jobs(ws);
    assert.deepEqual([w.status, w.attempts, w.payload.items.length, w.last_error], ['pending', 0, 1, null], why);
    if (status !== 429) assert.deepEqual([w.payload.tries, w.payload.last.status], [1, status], why);
    assert.ok(Math.abs(w.wait - 60) < 5, `${why}: tried again in a minute (${w.wait})`);
    assert.ok(!JSON.stringify(w).includes(SECRET), 'never the key on the job');
    mend();
    await run(ws);
    assert.equal(site.ledger.length, 1, `${why}: sent once it is mended`);
  };
  await waiting('a 503', () => site.setKey(null), () => site.setKey(SECRET), 503);
  await waiting('a 401', () => site.setKey('another-secret'), () => site.setKey(SECRET), 401);
  await waiting('a 404', () => { process.env.STARBASE_WEBSITE_URL = `${site.url}/moved`; }, () => { process.env.STARBASE_WEBSITE_URL = site.url; }, 404);
  await waiting('a 502', () => site.fail(502), () => site.fail(false), 502);
  await waiting('nobody answering', () => site.down(true), () => site.down(false), 0);
  await waiting('a 429', () => site.busy(1), () => {}, 429);
  _setTimeoutForTest(150);
  await waiting('no answer in time', () => site.slow(600), () => { site.slow(0); _setTimeoutForTest(null); }, 0);
  // A redirect is never followed: the key goes to the address that was set and nowhere else.
  await waiting('a redirect', () => site.redirect(`${other.url}/api/in/consent`), () => site.redirect(null), 307);
  assert.equal(other.calls.length, 0, 'the other address was never called');

  // The waits grow: 1 min, 5 min, 30 min, 2 h, then every 6 h — and never a try used.
  site.reset();
  await clearQueue(ws);
  await enqueueJob(db, { workspaceId: ws, kind: 'website.consent', payload: { items: [{ id: crypto.randomUUID(), channel: 'email', email: mail('long'), reason: 'unsubscribe', at: AT }], tries: 0 } });
  site.fail(503);
  const waits = [];
  for (let t = 0; t < 7; t += 1) {
    await dueNow(ws);
    await runOnce(ws);
    const [w] = await jobs(ws);
    assert.deepEqual([w.status, w.attempts, w.payload.tries], ['pending', 0, t + 1]);
    waits.push(Math.round(w.wait / 60));
  }
  assert.deepEqual(waits, [1, 5, 30, 120, 360, 360, 360]);
  site.fail(false);
  await run(ws);
  assert.deepEqual([site.ledger.length, (await jobs(ws))[0].status], [1, 'done'], 'never given up');
  syncOff();
});

test('the job: a body the website refuses is kept with its words while the others go, and is given up after five tries; settings taken away end it; 60 a minute at most', async () => {
  syncOn();
  site.reset();
  await clearQueue(ws);
  const good = { id: crypto.randomUUID(), channel: 'email', email: mail('good'), reason: 'unsubscribe', at: AT };
  const bad = { id: crypto.randomUUID(), channel: 'email', email: mail('bad'), reason: 'because', at: AT }; // a reason the website doesn't know
  const also = { id: crypto.randomUUID(), channel: 'sms', phone: phone(), reason: 'stop', at: AT };
  await enqueueJob(db, { workspaceId: ws, kind: 'website.consent', payload: { items: [bad, good, also], tries: 0 } });
  assert.deepEqual(await runOnce(ws), { ran: 0, failed: 1 });
  assert.deepEqual(site.ledger.map((x) => x.key), [good.id, also.id], 'the others still went');
  let [j] = await jobs(ws);
  assert.deepEqual([j.status, j.attempts, j.payload.items.map((x) => x.id)], ['pending', 1, [bad.id]]);
  assert.match(j.payload.items[0].said, /^400: reason: /);
  assert.match(j.last_error, /^The website refused one: 400: reason: /);
  for (let t = 2; t <= MAX_ATTEMPTS; t += 1) { await dueNow(ws); await runOnce(ws); }
  [j] = await jobs(ws);
  assert.deepEqual([j.status, j.attempts, j.payload.items.length], ['failed', MAX_ATTEMPTS, 1]);
  assert.equal(site.ledger.length, 2, 'nobody was told twice');

  // Send again (managers): what was given up on is tried once more.
  const { c: staff } = await (async () => {
    const inv = ok(await mgr.action('member.invite', { email: mail('staff'), role: 'staff' }));
    const c = new Client();
    await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Sam Example', password: 'website-pass-1' });
    return { c };
  })();
  assert.equal((await staff.action('intake.website.resend', {})).status, 403);
  assert.equal((await staff.action('intake.website.backfill', {})).status, 403);
  assert.equal((await staff.get('/api/intake/website')).status, 403);
  assert.equal(ok(await mgr.action('intake.website.resend', {})).items, 1);
  [j] = await jobs(ws);
  assert.deepEqual([j.status, j.attempts, j.payload.items[0].said], ['pending', 0, undefined]);

  // The settings are taken away (the website was disconnected on purpose): the job ends, and nothing is sent.
  site.reset();
  await clearQueue(ws);
  await enqueueJob(db, { workspaceId: ws, kind: 'website.consent', payload: { items: [good], tries: 0 } });
  delete process.env.STARBASE_WEBSITE_KEY;
  assert.deepEqual(await runOnce(ws), { ran: 1, failed: 0 });
  assert.deepEqual([(await jobs(ws))[0].status, site.calls.length], ['done', 0]);
  assert.equal((await mgr.action('intake.website.resend', {})).status, 409);

  // A run that has gone on long enough hands the rest back: still waiting, never marked done.
  syncOn();
  await clearQueue(ws);
  await enqueueJob(db, { workspaceId: ws, kind: 'website.consent', payload: { items: [good, also], tries: 0 } });
  _setRunMsForTest(-1);
  assert.deepEqual(await runOnce(ws), { ran: 0, failed: 0 });
  [j] = await jobs(ws);
  assert.deepEqual([j.status, j.attempts, j.payload.items.length, site.calls.length], ['pending', 0, 2, 0]);
  _setRunMsForTest(null);
  await run(ws);
  assert.deepEqual([(await jobs(ws))[0].status, site.ledger.map((x) => x.key)], ['done', [good.id, also.id]]);

  // 130 waiting in three jobs: 60 in the first minute and no more.
  syncOn();
  site.reset();
  await clearQueue(ws);
  const many = Array.from({ length: 130 }, (_, i) => ({ id: crypto.randomUUID(), channel: 'email', email: mail(`many-${i}`), reason: 'unsubscribe', at: AT }));
  for (let i = 0; i < many.length; i += 50) await enqueueJob(db, { workspaceId: ws, kind: 'website.consent', payload: { items: many.slice(i, i + 50), tries: 0 } });
  await runOnce(ws);
  assert.equal(site.calls.length, PER_MINUTE);
  assert.equal((await queued(ws)).length, 70);
  assert.ok((await jobs(ws)).filter((x) => x.status === 'pending').every((x) => x.attempts === 0 && x.wait > 0), 'the rest wait for the next minute; no try used');
  await runDueJobs(db, { workspaceId: ws }); // the same minute: nothing more goes
  assert.equal(site.calls.length, PER_MINUTE);
  await dueNow(ws);
  await runOnce(ws); // the next minute
  assert.equal(site.calls.length, 2 * PER_MINUTE);
  await dueNow(ws);
  await runOnce(ws);
  await dueNow(ws);
  await runOnce(ws);
  const firstLot = new Set(site.ledger.map((x) => x.email));
  assert.equal(firstLot.size, 120, 'the website’s own limit, 120 a minute, answers 429 — and nothing is lost');
  assert.equal((await queued(ws)).length, 10);
  site.reset(); // its next minute
  await run(ws);
  assert.deepEqual(site.ledger.map((x) => x.email).sort(), many.map((x) => x.email).filter((e) => !firstLot.has(e)).sort(), 'each of the 130 once');
  assert.deepEqual(await queued(ws), []);
  syncOff();
});

// ── What was already off, sent once ──
test('what was off before the website was connected is not sent by itself: the count is shown, one tap sends it once — and never what the website itself said', async () => {
  syncOff();
  const { c, ws: w } = await campaign('Before');
  await makeKey(c);
  const k = (await makeKey(c, 'Second')).key;
  const n1 = phone(); const n2 = phone();
  await c.createPerson('Ada Example', { email: mail('b-ada') });
  await subscribe(c, 'b-ada', 'b-bob');
  ok(await c.action('subscription.remove', { id: (await subOf(w, mail('b-ada'))).id }));
  await c.createPerson('Cat Example', { email: mail('B-CAT').toUpperCase(), tags: ['do-not-email'] });
  await c.createPerson('Dan Example', { email: mail('b-dan'), phone: dashed(n1), tags: ['do-not-contact'] });
  await c.createPerson('Eve Example', { phone: dashed(n2), tags: ['do-not-text'] });
  await c.createPerson('Fox Example', { email: mail('b-fox'), tags: ['member'] });
  const n3 = phone();
  await runAction(db, { workspaceId: w, actorId: null, action: 'twilio.sms_in' }, (tx, emit) => applyOptOut(tx, emit, w, n3, { out: true, keyword: 'STOP' }));
  // What the website itself told us is not sent back to it.
  ok(await consent(no({ email: mail('b-web') }), { k }));
  ok(await consent({ phone: phone(), channel: 'sms', action: 'withdraw', reason: 'stop', at: AT }, { k }));
  assert.deepEqual(await jobs(w), [], 'not connected: nothing was queued');

  syncOn();
  site.reset();
  const state = ok(await c.get('/api/intake/website'));
  assert.deepEqual([state.on, state.waiting, state.refused, state.backfill], [true, 0, 0, { status: 'none', count: 6 }]);
  assert.equal(site.calls.length, 0, 'counted, not sent');
  const tap = async () => { const r = ok(await c.action('intake.website.backfill', {})); return [r.queued, r.count]; };
  assert.deepEqual(await tap(), [true, 6]);
  assert.deepEqual(await tap(), [false, 6], 'a second tap adds nothing');
  await run(w);
  await run(w);
  assert.deepEqual(site.ledger.map((x) => [x.channel, x.email || x.phone, x.reason]).sort(), [
    ['email', mail('b-ada'), 'unsubscribe'], ['email', mail('b-cat'), 'unsubscribe'], ['email', mail('b-dan'), 'unsubscribe'],
    ['sms', n1, 'stop'], ['sms', n2, 'stop'], ['sms', n3, 'stop'],
  ].sort());
  const done = ok(await c.get('/api/intake/website')).backfill;
  assert.deepEqual([done.status, done.queued, done.total], ['done', 6, 6]);
  assert.ok(ok(await c.get('/api/events?since=0&limit=1000')).events.some((e) => e.action === 'intake.website.backfill' && e.payload.backfill === 6), 'on the log');
  syncOff();
  assert.equal((await c.action('intake.website.backfill', {})).status, 409, 'not connected: nothing to send to');
});

// ── 12. Settings → Services ──
test('Settings → Services: the row in each state, Check’s answers, how many are waiting and why — and the key in no answer, event or error', async () => {
  const seen = [];
  const get = async (path) => { const r = await mgr.get(path); seen.push(JSON.stringify(r.json)); return ok(r); };
  const row = async () => (await get('/api/connections')).services.find((s) => s.key === 'website');
  const check = async () => { const r = await mgr.post('/api/connections/check', { key: 'website' }); seen.push(JSON.stringify(r.json)); return ok(r); };
  syncOff();
  let s = await row();
  assert.deepEqual([s.name, s.state, s.missing, s.panel], ['The website — unsubscribes', 'missing', ['STARBASE_WEBSITE_URL', 'STARBASE_WEBSITE_KEY'], undefined]);
  assert.equal(s.detail, 'Not set: an unsubscribe here stays here. The website’s own still come in with a website key.');
  assert.deepEqual(await check(), { key: 'website', ok: false, said: s.detail });
  const inbound = (await get('/api/connections')).inbound.find((i) => i.name === 'The website — unsubscribes in');
  assert.match(inbound.url, /\/in\/v1\/consent$/);
  assert.equal(inbound.how, 'From the website’s server with the same website key: unsubscribes, text STOPs, preference changes');
  assert.deepEqual(ok(await mgr.get('/api/intake/website')), { on: false });

  const off = async (set, missing, words) => {
    syncOn();
    set();
    s = await row();
    assert.deepEqual([s.state, s.missing, s.panel], ['missing', missing, undefined], String(words));
    assert.match(s.detail, words);
  };
  await off(() => { delete process.env.STARBASE_WEBSITE_KEY; }, ['STARBASE_WEBSITE_KEY'], /^Only one of the two is set: STARBASE_WEBSITE_KEY is missing/);
  await off(() => { delete process.env.STARBASE_WEBSITE_URL; }, ['STARBASE_WEBSITE_URL'], /^Only one of the two is set: STARBASE_WEBSITE_URL is missing/);
  await off(() => { process.env.STARBASE_WEBSITE_URL = 'http://www.example.org'; }, [], /must start with https:\/\//);
  await off(() => { process.env.STARBASE_WEBSITE_URL = 'https://base.example/'; }, [], /this base\.win’s own address/);
  await off(() => { process.env.STARBASE_WEBSITE_URL = 'https://someone.base.win'; }, [], /is a base\.win address/);
  await off(() => { process.env.STARBASE_ENV = 'staging'; }, [], /^Off on staging: nothing is ever sent from here\.$/);
  assert.equal(s.checkable, false);

  // On.
  syncOn();
  site.reset();
  await clearQueue(ws);
  const host = new URL(site.url).host;
  s = await row();
  assert.deepEqual([s.state, s.missing, s.panel, s.flagged, s.detail], ['ready', [], 'website', undefined, `Sends each unsubscribe and text STOP to ${host}`]);
  assert.deepEqual(await check(), { key: 'website', ok: true, said: 'The website answers and takes this key' });
  assert.deepEqual(site.calls.map((c) => [c.raw, c.key]), [['{}', null]], 'Check sends an empty body and no Idempotency-Key');
  assert.deepEqual(site.ledger, [], 'and writes nothing on the website');
  site.setKey('not-ours');
  assert.deepEqual(await check(), { key: 'website', ok: false, said: 'The website refused the key: it must equal its STARBASE_INBOUND_KEY' });
  site.setKey(null);
  assert.deepEqual(await check(), { key: 'website', ok: false, said: 'The website has no STARBASE_INBOUND_KEY yet' });
  site.setKey(SECRET);
  process.env.STARBASE_WEBSITE_URL = `${site.url}/old`;
  assert.deepEqual(await check(), { key: 'website', ok: false, said: 'No such address on the website. If the website now runs on base.win, take both settings away' });
  process.env.STARBASE_WEBSITE_URL = site.url;
  site.fail(500);
  assert.deepEqual(await check(), { key: 'website', ok: false, said: 'The website answered 500: HTTP 500' });
  site.fail(false);
  site.down(true);
  assert.deepEqual(await check(), { key: 'website', ok: false, said: `The website can’t be reached at ${host}` });
  site.down(false);

  // Something waiting, with why; something refused, with the website's words.
  await mgr.createPerson('Wes Example', { email: mail('wes') });
  await subscribe(mgr, 'wes');
  site.setKey('not-ours');
  ok(await mgr.action('subscription.remove', { id: (await subOf(ws, mail('wes'))).id }));
  await enqueueJob(db, { workspaceId: ws, kind: 'website.consent', payload: { items: [{ id: crypto.randomUUID(), channel: 'email', email: mail('odd'), reason: 'because', at: AT }], tries: 0 } });
  await runOnce(ws);
  s = await row();
  assert.match(s.detail.split('\n')[1], /^2 waiting: The website refused the key \(since .+\)$/);
  assert.deepEqual([s.state, s.flagged, s.flagWord], ['ready', true, 'some are waiting']);
  site.setKey(SECRET);
  await run(ws);
  s = await row();
  assert.deepEqual([s.state, s.flagged, s.flagWord], ['ready', true, 'the website refused some']);
  assert.deepEqual(s.detail.split('\n').slice(1), ['1 the website refused: reason: Invalid option: expected one of "unsubscribe"|"stop"|"preference"|"deletion"']);
  const panel = await get('/api/intake/website');
  assert.deepEqual([panel.on, panel.host, panel.key, panel.waiting, panel.refused], [true, host, true, 0, 1]);
  // A campaign that is connected but has no website key: said, since nothing goes.
  const { c: b } = await campaign('Rowkey');
  const theirs = ok(await b.get('/api/connections')).services.find((x) => x.key === 'website');
  assert.deepEqual([theirs.flagged, theirs.flagWord], [true, 'needs a website key']);
  assert.match(theirs.detail, /Nothing is sent yet: this campaign has no website key/);

  // The key: in no answer, no event, no job and no error.
  const events = (await db.query('select payload from events where workspace_id = $1', [ws])).rows.map((r) => JSON.stringify(r.payload));
  const jobRows = (await db.query('select payload, last_error from jobs where workspace_id = $1', [ws])).rows.map((r) => JSON.stringify(r));
  for (const text of [...seen, ...events, ...jobRows]) assert.ok(!text.includes(SECRET));
  assert.ok(seen.length > 15 && events.length > 50);
  await clearQueue(ws);
  syncOff();
});

// ── 13. For any client ──
const root = (p) => new URL(`../../${p}`, import.meta.url);
const read = (p) => readFileSync(root(p), 'utf8');
test('nothing here names a client: the new files, the guide’s lines and render.yaml’s; render.yaml gives neither setting a value', async () => {
  const yaml = read('render.yaml');
  // The names of whoever is in production, read from render.yaml itself (and not the sample's on staging).
  const blocks = yaml.split(/\n {2}- type: /).slice(1);
  const valueOf = (block, k) => new RegExp(`- key: ${k}\\s*\\n\\s*value: *"?([^"\\n#]+)"?`).exec(block)?.[1]?.trim() || null;
  const named = (block) => ['STARBASE_ORG_NAME', 'STARBASE_BRAND', 'STARBASE_CITY'].map((k) => valueOf(block, k)).filter(Boolean);
  const sample = new Set(blocks.filter((b) => valueOf(b, 'STARBASE_ENV') === 'staging').flatMap(named).map((x) => x.toLowerCase()));
  const clients = [...new Set(blocks.filter((b) => valueOf(b, 'STARBASE_ENV') === 'production').flatMap(named).map((x) => x.toLowerCase()))].filter((x) => !sample.has(x));

  const index = read('server/ext/intake/index.js');
  const block = index.slice(index.indexOf('// ── Unsubscribes, both ways'));
  assert.ok(block.includes("publicRoutes.post('/in/v1/consent'"), 'the block in the intake file');
  const guide = read('INTEGRATIONS.md');
  const from = guide.indexOf('\n### Unsubscribes, both ways');
  assert.ok(from > 0, 'the guide has the section');
  const section = guide.slice(from, guide.indexOf('\n## ', from + 1));
  assert.match(section, /STARBASE_WEBSITE_URL/);
  assert.match(section, /STARBASE_WEBSITE_KEY/);
  const yamlLines = yaml.split('\n').filter((l) => /STARBASE_WEBSITE_/.test(l)).join('\n');
  const texts = {
    'server/ext/intake/index.js (the block)': block,
    'INTEGRATIONS.md (the section)': section,
    'render.yaml (the lines)': yamlLines,
    ...Object.fromEntries(['server/ext/intake/consent.js', 'server/ext/intake/outbound.js', 'server/ext/intake/website.js', 'server/ext/intake/service.js',
      'web/src/components/WebsitePanel.jsx', 'server/test/website-consent.test.js', 'server/test/fake-website.js', 'e2e-consent.mjs'].map((p) => [p, read(p)])),
  };
  for (const [where, text] of Object.entries(texts)) {
    for (const name of clients) assert.ok(!text.toLowerCase().includes(name), `${where} names a client`);
  }
  // No value, and under no service: a new client never inherits another's website.
  for (const k of ['STARBASE_WEBSITE_URL', 'STARBASE_WEBSITE_KEY']) {
    assert.ok(!new RegExp(`- key: ${k}`).test(yaml), `${k} is listed under a service`);
    assert.ok(!new RegExp(`${k}\\s*[:=]\\s*\\S`).test(yaml), `${k} is given a value`);
  }
  for (const l of yamlLines.split('\n').filter(Boolean)) assert.match(l, /^\s*#/, 'only in the comment at the top');
});

// ── 14. The website's side of the contract ──
const web = (p) => `apps/web/src/${p}`;
test('the contract: the website’s own source still says what this is built to', { skip: !existsSync(root(web('lib/server/starbase.ts'))) && 'apps/web is not in this checkout' }, () => {
  const sender = read(web('lib/server/starbase.ts'));
  const inbound = read(web('lib/server/starbase-inbound.ts'));
  const route = read(web('app/api/in/consent/route.ts'));
  const env = read(web('lib/env.ts'));
  const has = (text, snippets) => { for (const s of snippets) assert.ok(text.includes(s), `the website no longer says: ${s}`); };
  // What it sends, and how it reads the answer.
  has(sender, [
    'export const CONSENT_CHANNELS = ["email", "sms"] as const;',
    'export const CONSENT_REASONS = ["unsubscribe", "stop", "preference", "deletion"] as const;',
    'action: "withdraw";',
    'if (!channel || !reason || raw.action !== "withdraw") return null;',
    'return { ...(email ? { email } : {}), ...(phone ? { phone } : {}), channel, action: "withdraw", reason, at };',
    'v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,',
    'export const CONSENT_ENDPOINT = "/in/v1/consent";',
    'if (b.ok === true && (personId || endpoint === CONSENT_ENDPOINT)) return { kind: "ok", personId, replayed: b.replayed === true };',
    'if (status === 404 && endpoint === CONSENT_ENDPOINT) return { kind: "unsupported", status,',
    'if (status === 401 || status === 403 || status === 404) return { kind: "config", status, error: message };',
    'if (status === 429 || status === 408 || status >= 500) return { kind: "retry", status, error: message };',
    'return { kind: "refused", status, error: message };',
    'authorization: `Bearer ${key}`,',
    '"content-type": "application/json",',
    '"idempotency-key": idempotencyKey.slice(0, 200),',
    'body: stableJson(payload),',
  ]);
  // What it takes, in the order it checks.
  const checks = [
    'if (rateLimited(req, "in-consent", 120)) return error("more than 120 requests a minute", 429);',
    'if (!key) return error("Inbound consent is off: STARBASE_INBOUND_KEY isn\'t set on the website.", 503);',
    'if (!bearerMatches(req.headers.get("authorization"), key)) return error("a valid key goes in the Authorization header: Bearer …", 401);',
    'if (!/^application\\/json\\b/i.test(req.headers.get("content-type") ?? "")) return error("send JSON (Content-Type: application/json)", 415);',
    'if (!idempotencyKey || idempotencyKey.length > 200) return error("send an Idempotency-Key header (1 to 200 characters)", 400);',
    'if (raw.length > MAX_BODY) return error("the body is too large", 413);',
    'return error("the body isn’t JSON", 400);',
    'if (!parsed.success) return error(schemaError(parsed.error), 400);',
    'const answer = await applyInboundConsent(getDb(), parsed.data, idempotencyKey, raw);',
  ];
  has(route, [...checks, 'const MAX_BODY = 10_000;', 'return error("Something went wrong applying it; try again.", 500);']);
  const order = checks.map((s) => route.indexOf(s));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the checks come in this order (Check on Settings → Services relies on it)');
  has(inbound, [
    'email: trimmed(320).toLowerCase().pipe(z.email()).optional().nullable(),',
    'phone: trimmed(40).optional().nullable(),',
    'channel: z.enum(CONSENT_CHANNELS),',
    'action: z.enum(["withdraw", "grant"]),',
    'reason: z.enum(CONSENT_REASONS),',
    'at: z.iso.datetime({ offset: true }),',
    '.refine((v) => v.email || v.phone, { message: "an email or a phone" });',
    'if (d.hash !== hash) return { status: 409, body: { error: "that Idempotency-Key was used with a different body" } };',
    'return { status: 200, body: { ...(d.answer ?? { ok: true }), replayed: true } };',
    'answer = { ok: true, applied: 0, note: "Grants are not applied from Starbase; only withdrawals are." };',
    'answer = { ok: true, applied: matches.length };',
    'const digits = (raw ?? "").replace(/\\D/g, "").replace(/^1(?=\\d{10}$)/, "");',
  ]);
  has(env, ['return optional("STARBASE_INBOUND_KEY")?.trim();']);
  // And the stand-in answers as that source does.
  assert.equal(stableJson({ b: 1, a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1},"b":1}');
  assert.deepEqual(classifyAnswer(200, { ok: true }, CONSENT_ENDPOINT), { kind: 'ok', personId: null, replayed: false });
  assert.equal(classifyAnswer(404, null, CONSENT_ENDPOINT).kind, 'unsupported');
  assert.equal(classifyAnswer(400, { error: 'x' }, CONSENT_ENDPOINT).kind, 'refused');
});

test('the stand-in website checks in the website’s order, and takes each no once', async () => {
  const s = await startFakeWebsite({ key: null });
  const post = async (headers, body) => {
    const r = await realFetch(`${s.url}/api/in/consent`, { method: 'POST', headers, body });
    return [r.status, (await r.json()).error];
  };
  const body = stableJson(no({ email: mail('standin') }));
  const good = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', 'idempotency-key': 'k1' };
  try {
    assert.deepEqual(await post(good, body), [503, 'Inbound consent is off: STARBASE_INBOUND_KEY isn\'t set on the website.']);
    s.setKey(SECRET);
    assert.deepEqual(await post({ ...good, authorization: 'Bearer nope' }, body), [401, 'a valid key goes in the Authorization header: Bearer …']);
    assert.deepEqual(await post({ ...good, 'content-type': 'text/plain' }, body), [415, 'send JSON (Content-Type: application/json)']);
    assert.deepEqual(await post({ authorization: good.authorization, 'content-type': 'application/json' }, '{}'), [400, 'send an Idempotency-Key header (1 to 200 characters)']);
    assert.deepEqual(await post(good, `{"pad":"${'x'.repeat(10_000)}"}`), [413, 'the body is too large']);
    assert.deepEqual(await post(good, '{'), [400, 'the body isn’t JSON']);
    assert.equal((await post(good, '{}'))[0], 400);
    s.person({ email: mail('standin') });
    const first = await realFetch(`${s.url}/api/in/consent`, { method: 'POST', headers: good, body });
    assert.deepEqual([first.status, await first.json()], [200, { ok: true, applied: 1 }]);
    const again = await realFetch(`${s.url}/api/in/consent`, { method: 'POST', headers: good, body });
    assert.deepEqual(await again.json(), { ok: true, applied: 1, replayed: true });
    assert.deepEqual(await post(good, stableJson(no({ email: mail('standin-2') }))), [409, 'that Idempotency-Key was used with a different body']);
    const yes = await realFetch(`${s.url}/api/in/consent`, { method: 'POST', headers: { ...good, 'idempotency-key': 'k2' }, body: stableJson({ ...no({ email: mail('standin') }), action: 'grant' }) });
    assert.deepEqual(await yes.json(), { ok: true, applied: 0, note: 'Grants are not applied from Starbase; only withdrawals are.' });
    assert.equal(s.ledger.length, 1, 'one no, once; a yes is never applied');
  } finally { await s.close(); }
});
