// Consent both ways (ext/site/consent.js): a ticked box on the website puts
// a new address on base.win's own newsletter list with the words they saw
// on the record — but never back someone who left; the supporter's own
// signed links (/preferences, /unsubscribe) change base.win's real state
// both ways (the list, do-not-email, a number's STOP, the opt-in fields);
// and base.win's own doors — /u, a STOP text, the desk's Add and Remove, a
// do-not-email tag — land on the same record.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { hit, send, ok, campaign, personBy } from './site-helpers.js';
import { personToken } from '../ext/site/index.js';
import { sign } from '../ext/site/tokens.js';
import { runAction } from '../lib/events.js';
import { applyOptOut } from '../ext/texting/store.js';
import { app } from '../index.js';

let db, mgr, ws;
const consents = async (where, params) => (await db.query(
  `select channel, granted, source, wording, address from consent_events where workspace_id = $1 and ${where} order by created_at, id`, [ws, ...params],
)).rows;
const subOf = async (email) => (await db.query('select id, status from subscriptions where workspace_id = $1 and email = $2', [ws, email])).rows[0];
const one = async (email) => (await personBy(db, ws, 'lower(email) = $2', [email]))[0];
const tags = (p) => (Array.isArray(p.tags) ? p.tags : JSON.parse(p.tags || '[]'));
const optIns = async (personId) => Object.fromEntries((await mgr.get(`/api/persons/${personId}/fields`)).json.fields
  .filter((f) => /opt-in/.test(f.name)).map((f) => [f.name, f.value]));

before(async () => {
  ({ db, mgr, ws } = await campaign());
});

test('a ticked box: on the list, the consent with its words, the opt-in field; an unticked one changes nothing', async () => {
  ok(await send('contact', { first_name: 'Ama', email: 'ama@example.org', phone: '604-555-0111', message: 'Hi', consent_email: true, consent_sms: true }));
  const p = await one('ama@example.org');
  assert.equal((await subOf('ama@example.org')).status, 'subscribed');
  const rows = await consents('person_id = $2', [p.id]);
  assert.deepEqual(rows.map((r) => [r.channel, r.granted, r.source, r.address]), [
    ['email', true, 'website-contact', 'ama@example.org'],
    ['sms', true, 'website-contact', '+16045550111'],
  ]);
  assert.equal(rows[0].wording, 'Yes, Imagine Surrey can email me news and ways to help. I can unsubscribe at any time.');
  assert.match(rows[1].wording, /^Yes, Imagine Surrey can text me about events and volunteering\. Reply STOP/);
  assert.deepEqual(await optIns(p.id), { 'Email opt-in': true, 'SMS opt-in': true });
  const ev = (await db.query("select payload from events where workspace_id = $1 and entity_type = 'consent_event' order by seq", [ws])).rows;
  assert.equal(ev.length, 2, 'each on the event log');

  ok(await send('contact', { first_name: 'Ben', email: 'ben@example.org', message: 'No boxes' }));
  const b = await one('ben@example.org');
  assert.equal(await subOf('ben@example.org'), undefined);
  assert.deepEqual(await consents('person_id = $2', [b.id]), []);
});

test('base.win’s own unsubscribe link is on the record; a website box never puts them back, their own link does', async () => {
  ok(await send('newsletter', { first_name: 'Cleo', email: 'cleo@example.org', consent_email: true }));
  const sub = await subOf('cleo@example.org');
  const p = await one('cleo@example.org');
  // base.win's own one-click unsubscribe (routes/public.js /u).
  const u = await app.request(`/u/${sub.id}`, { method: 'POST' });
  assert.equal(u.status, 200);
  const rows = await consents('person_id = $2', [p.id]);
  assert.deepEqual(rows.map((r) => [r.channel, r.granted, r.source]), [['email', true, 'website-newsletter'], ['email', false, 'unsubscribe-link']]);
  assert.deepEqual(await optIns(p.id), { 'Email opt-in': false, 'SMS opt-in': null }, 'the opt-in follows');

  // Someone typing her address into a form doesn't put her back.
  ok(await send('petition', { email: 'cleo@example.org', campaign: (await mgr.get('/api/site/campaigns')).json.campaigns[0].id, consent_email: true }));
  assert.equal((await subOf('cleo@example.org')).status, 'unsubscribed');
  assert.equal((await consents('person_id = $2', [p.id])).length, 2, 'nothing new on the record');

  // Her own link (from an email) does.
  const t = await personToken(ws, p.id);
  const page = await hit(`/site/preferences?t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<input type="checkbox" name="email" value="on">/, 'email shown off');
  assert.match(page.text, /name="sms" value="on" disabled/, 'no phone: texts can’t be turned on');
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  const saved = await hit('/site/preferences', { form: { t, email: 'on' } });
  assert.equal(saved.status, 200);
  assert.match(saved.text, /Saved\./);
  assert.equal((await subOf('cleo@example.org')).status, 'subscribed');
  assert.deepEqual((await consents('person_id = $2', [p.id])).at(-1), {
    channel: 'email', granted: true, source: 'preferences', address: 'cleo@example.org',
    wording: 'Yes, Imagine Surrey can email me news and ways to help. I can unsubscribe at any time.',
  });
  assert.match(saved.text, new RegExp(`/site/r/${(await one('cleo@example.org')).attrs.ref_code}`), 'their link to share');
});

test('/unsubscribe: opening it only asks; the button takes them off base.win’s list and says so', async () => {
  ok(await send('newsletter', { first_name: 'Dev', email: 'dev@example.org', consent_email: true }));
  const p = await one('dev@example.org');
  const t = await personToken(ws, p.id);
  const ask = await hit(`/site/unsubscribe?t=${encodeURIComponent(t)}`);
  assert.equal(ask.status, 200);
  assert.match(ask.text, /Stop emails from Imagine Surrey\?/);
  assert.equal((await subOf('dev@example.org')).status, 'subscribed', 'opening it changed nothing');
  const done = await hit(`/site/unsubscribe?t=${encodeURIComponent(t)}`, { method: 'POST', form: { 'List-Unsubscribe': 'One-Click' } });
  assert.equal(done.status, 200);
  assert.match(done.text, /You’re unsubscribed/);
  assert.equal((await subOf('dev@example.org')).status, 'unsubscribed');
  assert.deepEqual((await consents('person_id = $2', [p.id])).at(-1).source, 'unsubscribe-link');
  const twice = await hit('/site/unsubscribe', { method: 'POST', form: { t } });
  assert.equal(twice.status, 200);
  assert.equal((await consents('person_id = $2 and granted = false', [p.id])).length, 1, 'once on the record');
  // Never on the list (a blast reached them): do-not-email instead, as /lu does.
  const desk = (await mgr.action('person.create', { name: 'Eve Example', email: 'eve@example.org' })).json.person;
  const te = await personToken(ws, desk.id);
  assert.equal((await hit('/site/unsubscribe', { method: 'POST', form: { t: te } })).status, 200);
  assert.ok(tags(await one('eve@example.org')).includes('do-not-email'));
  // A link that's forged, for someone else, or too old shows a plain dead end.
  for (const bad of ['nope', `${t.slice(0, -3)}abc`, await sign('person', { w: ws, p: p.id }, -1), await sign('preview', { w: ws, p: p.id }, 600)]) {
    const r = await hit(`/site/preferences?t=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 404);
    assert.match(r.text, /doesn’t work any more/);
  }
});

test('texts: their own link turns them off as a STOP for the number, and on again as a START', async () => {
  ok(await send('volunteer', { first_name: 'Fay', email: 'fay@example.org', phone: '604-555-0122', consent_sms: true }));
  const p = await one('fay@example.org');
  const t = await personToken(ws, p.id);
  assert.match((await hit(`/site/preferences?t=${encodeURIComponent(t)}`)).text, /name="sms" value="on" checked/);
  await hit('/site/preferences', { form: { t } }); // both boxes off
  const stop = (await db.query('select opted_out, keyword from texting_optouts where workspace_id = $1 and phone = $2', [ws, '+16045550122'])).rows[0];
  assert.deepEqual(stop, { opted_out: true, keyword: 'WEBSITE' });
  assert.ok(tags(await one('fay@example.org')).includes('do-not-text'));
  assert.deepEqual((await optIns(p.id))['SMS opt-in'], false);
  // A form box doesn't turn them back on…
  ok(await send('contact', { email: 'fay@example.org', phone: '604-555-0122', consent_sms: true, message: 'hi' }));
  assert.ok(tags(await one('fay@example.org')).includes('do-not-text'));
  // …their own link does.
  await hit('/site/preferences', { form: { t, sms: 'on' } });
  const start = (await db.query('select opted_out from texting_optouts where workspace_id = $1 and phone = $2', [ws, '+16045550122'])).rows[0];
  assert.equal(start.opted_out, false);
  assert.ok(!tags(await one('fay@example.org')).includes('do-not-text'));
  const sms = await consents("person_id = $2 and channel = 'sms'", [p.id]);
  assert.deepEqual(sms.map((r) => [r.granted, r.source]), [[true, 'website-volunteer'], [false, 'preferences'], [true, 'preferences']]);
});

test('base.win’s own doors land on the record: a STOP text, the desk’s Add and Remove, a do-not-email tag', async () => {
  const g = (await mgr.action('person.create', { name: 'Gus Example', email: 'gus@example.org', phone: '604-555-0133' })).json.person;
  // A STOP text (the texting webhook's write).
  await runAction(db, { workspaceId: ws, actorId: null, action: 'twilio.sms_in' }, (tx, emit) => applyOptOut(tx, emit, ws, '+16045550133', { out: true, keyword: 'STOP' }));
  assert.deepEqual((await consents("person_id = $2 and channel = 'sms'", [g.id])).map((r) => [r.granted, r.source]), [[false, 'text-stop']]);
  await runAction(db, { workspaceId: ws, actorId: null, action: 'twilio.sms_in' }, (tx, emit) => applyOptOut(tx, emit, ws, '+16045550133', { out: false, keyword: 'START' }));
  assert.deepEqual((await consents("person_id = $2 and channel = 'sms'", [g.id])).map((r) => [r.granted, r.source]), [[false, 'text-stop'], [true, 'text-start']]);
  // The desk's Add and Remove on the newsletter list.
  const add = ok(await mgr.action('subscription.add', { email: 'gus@example.org', name: 'Gus Example' }));
  ok(await mgr.action('subscription.remove', { id: add.id }));
  assert.deepEqual((await consents("person_id = $2 and channel = 'email'", [g.id])).map((r) => [r.granted, r.source]), [[true, 'desk-added'], [false, 'desk-removed']]);
  // A do-not-email tag set by hand (once, however often the record is saved after).
  const h = (await mgr.action('person.create', { name: 'Hal Example', email: 'hal@example.org' })).json.person;
  ok(await mgr.action('person.update', { id: h.id, tags: ['do-not-email'] }));
  ok(await mgr.action('person.update', { id: h.id, tags: ['do-not-email', 'VIP'] }));
  assert.deepEqual((await consents('person_id = $2', [h.id])).map((r) => [r.channel, r.granted]), [['email', false]]);
});

test('the site’s preferences page belongs to the campaign it was signed for', async () => {
  const p = await one('ama@example.org');
  const other = await sign('person', { w: '00000000-0000-4000-8000-000000000000', p: p.id }, 600);
  assert.equal((await hit(`/site/preferences?t=${encodeURIComponent(other)}`)).status, 404);
});
