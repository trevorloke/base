// Mainstreeting (ext/mainstreet): people met at an event or a bus loop —
// their own channel, with the place; new people come in tagged, people on
// file are found (never on an email a volunteer can't see), the save is
// once even when the phone sends it twice, and the desk gets the asks.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';

let mgr, vol, db;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const meet = (c, body) => c.action('mainstreet.meet', { client_id: randomUUID(), place: 'Newton bus loop', ...body });

before(async () => {
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Mainstreet', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'vol@example.org', role: 'volunteer' });
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Volunteer', password: 'mainstreet-pass-1' }));
});

test('a volunteer meets someone new: a person (first and last apart, tagged), a mainstreet contact with the place and rating', async () => {
  const r = ok(await meet(vol, { first_name: 'Ana', last_name: 'Example', phone: '604-555-0191', postal: 'v3w 1a1', rating: '2', note: 'Rides the 96' }));
  const p = (await db.query('select name, first_name, last_name, phone, postal, rating, tags from persons where id = $1', [r.person_id])).rows[0];
  assert.deepEqual([p.name, p.first_name, p.last_name, p.phone, p.postal, p.rating], ['Ana Example', 'Ana', 'Example', '604-555-0191', 'V3W 1A1', '2']);
  assert.ok(p.tags.includes('mainstreeting'));
  const c = (await db.query('select channel, outcome, rating, note, place from contacts where id = $1', [r.contact_id])).rows[0];
  assert.deepEqual({ ...c }, { channel: 'mainstreet', outcome: 'contacted', rating: '2', note: 'Rides the 96', place: 'Newton bus loop' });
  const hist = ok(await mgr.get(`/api/persons/${r.person_id}`)).contacts;
  assert.equal(hist[0].channel, 'mainstreet');
});

test('someone on file: found by name and phone, not doubled; blanks filled, nothing overwritten', async () => {
  const on = await mgr.createPerson('Ben Example', { phone: '604-555-0192', city: 'Surrey' });
  const r = ok(await meet(vol, { first_name: 'Ben', last_name: 'Example', phone: '(604) 555-0192', postal: 'V3T 1V8' }));
  assert.equal(r.person_id, on.id);
  const p = (await db.query('select postal, city, tags from persons where id = $1', [on.id])).rows[0];
  assert.deepEqual([p.postal, p.city, p.tags.includes('mainstreeting')], ['V3T 1V8', 'Surrey', true]);
});

test('a volunteer is never matched on an email the campaign holds; the desk sees “may be the same person”', async () => {
  const held = await mgr.createPerson('Cara Example', { email: 'cara@example.org' });
  const r = ok(await meet(vol, { first_name: 'Cara', last_name: 'Example', email: 'cara@example.org' }));
  assert.notEqual(r.person_id, held.id, 'a new record — the volunteer learns nothing about who holds the email');
  const p = (await db.query("select email, attrs->>'maybe_same_as' as same from persons where id = $1", [r.person_id])).rows[0];
  assert.deepEqual([p.email, p.same], [null, held.id]);
  // The desk is matched on the email.
  const d = ok(await meet(mgr, { first_name: 'Cara', last_name: 'Example', email: 'CARA@example.org' }));
  assert.equal(d.person_id, held.id);
});

test('wants to volunteer → a request for the desk; newsletter → on the list, but never back on for someone who left', async () => {
  const r = ok(await meet(vol, { first_name: 'Dev', last_name: 'Example', email: 'dev@example.org', volunteer: true, newsletter: true }));
  const req = (await db.query('select kind, note from door_requests where person_id = $1', [r.person_id])).rows;
  assert.deepEqual(req.map((x) => [x.kind, x.note]), [['volunteer', 'Met mainstreeting at Newton bus loop']]);
  assert.equal((await db.query("select status, source from subscriptions where email = 'dev@example.org'")).rows[0].source, 'mainstreeting');
  ok(await mgr.action('subscription.add', { email: 'eli@example.org', name: 'Eli' }));
  const sid = (await db.query("select id from subscriptions where email = 'eli@example.org'")).rows[0].id;
  ok(await mgr.action('subscription.remove', { id: sid }));
  ok(await meet(mgr, { first_name: 'Eli', last_name: 'Example', email: 'eli@example.org', newsletter: true }));
  assert.equal((await db.query("select status from subscriptions where email = 'eli@example.org'")).rows[0].status, 'unsubscribed');
});

test('sent twice from a phone (the same client_id): one person, one contact; refusals; the books verify', async () => {
  const id = randomUUID();
  const a = ok(await vol.action('mainstreet.meet', { client_id: id, place: 'Farmers market', first_name: 'Fay', last_name: 'Example' }));
  const b = ok(await vol.action('mainstreet.meet', { client_id: id, place: 'Farmers market', first_name: 'Fay', last_name: 'Example' }));
  assert.deepEqual([b.person_id, b.contact_id, b.duplicate], [a.person_id, a.contact_id, true]);
  assert.equal((await db.query("select count(*)::int as n from persons where name = 'Fay Example'")).rows[0].n, 1);
  assert.equal((await meet(vol, { first_name: '', last_name: '' })).status, 400, 'no name');
  assert.equal((await vol.action('mainstreet.meet', { client_id: randomUUID(), place: '', first_name: 'X' })).status, 400, 'no place');
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});
