// Live GOTV, what the screens read (ext/voted stage 2): the desk's Settings
// and Ready list (GET /gotv/setup), the closing time as the campaign's wall
// time, every voting place on Voting places (today's open ones first), a
// practice that marked someone ticking "Practice run done", whether a
// scrutineer has anything to receive live, a volunteer with no list, and
// the sign-in code's session saying what it is (/auth/me scope).
// test:pg-safe: a fresh campaign per run, every query scoped to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { campaign, ok, no, at, clockBack, plus } from './gotv-helpers.js';

let k;
before(async () => {
  await freshDb();
  k = await campaign('screens');
});
after(clockBack);

test('GET /gotv/setup: the desk’s Settings and Ready list, read by the desk only', async () => {
  at(plus(1), '12:00');
  no(await k.volA.client.get('/api/gotv/setup'), 403);
  const s = ok(await k.staff.client.get('/api/gotv/setup'));
  assert.equal(s.send, 'after_close');
  assert.equal(s.scope, 'turfs');
  assert.deepEqual(s.days.map((d) => d.day), [k.A1, k.A2, k.G]);
  const g = s.days.find((d) => d.day === k.G);
  assert.equal(g.guide_close, '20:00');
  assert.equal(g.places_differ, 1, 'Place One closes at 16:00 on election day');
  assert.deepEqual(s.ready.map((r) => r.key), ['ceo', 'days', 'hours', 'places', 'appointed', 'signed_in', 'practice_run', 'briefed', 'no_deploys']);
  const by = Object.fromEntries(s.ready.map((r) => [r.key, r]));
  assert.equal(by.days.done, true);
  assert.equal(by.hours.done, true);
  assert.equal(by.places.done, true);
  assert.equal(by.ceo.done, false);
  assert.equal(by.practice_run.done, false);
  assert.equal(by.briefed.tick, true);
  ok(await k.mgr.action('vote.settings', { ready: { key: 'briefed', done: true }, ceo_answer: { allows_live: false, note: 'Asked by phone' } }));
  const s2 = ok(await k.mgr.get('/api/gotv/setup'));
  const by2 = Object.fromEntries(s2.ready.map((r) => [r.key, r]));
  assert.equal(by2.briefed.done, true);
  assert.equal(by2.ceo.done, true);
  assert.deepEqual(by2.ceo.answer && { a: by2.ceo.answer.allows_live, n: by2.ceo.answer.note }, { a: false, n: 'Asked by phone' });
});

test('a practice that marked someone ticks "Practice run done"; one that marked no one doesn’t', async () => {
  at(plus(1), '12:00');
  ok(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1 }));
  ok(await k.mgr.action('vote.settings', { mode: 'practice' }));
  ok(await k.mgr.action('vote.settings', { mode: 'off' }));
  assert.equal(Object.fromEntries(ok(await k.mgr.get('/api/gotv/setup')).ready.map((r) => [r.key, r.done])).practice_run, false);
  ok(await k.mgr.action('vote.settings', { mode: 'practice' }));
  ok(await k.scrut.client.action('vote.mark', { person_id: k.inA.id, source: 'scrutineer', place_id: k.p1, practice: true, client_id: randomUUID() }));
  ok(await k.mgr.action('vote.settings', { mode: 'off' }));
  assert.equal(Object.fromEntries(ok(await k.mgr.get('/api/gotv/setup')).ready.map((r) => [r.key, r.done])).practice_run, true);
});

test('status: the close as the campaign’s wall time; the stream only for someone with a list; a volunteer with none is told', async () => {
  at(k.G, '10:00');
  const scrut = ok(await k.scrut.client.get('/api/voted/status'));
  assert.equal(scrut.closes_hm, '16:00', 'Place One’s own election-day close');
  assert.equal(scrut.stream, false, 'a scrutineer with no turf and no calls has nothing to receive');
  const places = ok(await k.scrut.client.get('/api/gotv/places')).places;
  assert.equal(places.find((p) => p.id === k.p2).closes_hm, '20:00');
  assert.equal(ok(await k.volA.client.get('/api/voted/status')).has_list, true);
  assert.equal(ok(await k.runner.client.get('/api/voted/status')).has_list, false, 'a runner is a volunteer with no turf and no calls');
  ok(await k.mgr.action('turf.assign', { turf_id: k.turfA, user_id: k.scrut.id }));
  // The status is kept a moment; a new read after the post is dropped.
  ok(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1 }));
  assert.equal(ok(await k.scrut.client.get('/api/voted/status')).stream, true);
});

test('Voting places lists every place, today’s open ones first', async () => {
  at(k.A1, '10:00');
  ok(await k.mgr.action('site.guide.place.save', { id: k.p2, name: `Place Two ${k.tag}`, address: '200 Example Ave', lat: 49.16, lng: -122.81, days: [{ day: k.A2 }, { day: k.G }] }));
  const sum = ok(await k.mgr.get('/api/voted/summary'));
  const ids = sum.by_place.map((p) => p.place_id);
  assert.deepEqual(ids, [k.p1, k.p2]);
  assert.equal(sum.by_place[0].open_today, true);
  assert.equal(sum.by_place[1].open_today, false);
  assert.equal(sum.by_place[0].closes_hm, '20:00');
});

test('the sign-in code’s session says what it is', async () => {
  at(k.A1, '10:00');
  const code = ok(await k.mgr.action('gotv.signin.code', { user_id: k.scrut.id }));
  const phone = new Client();
  const used = await phone.post('/api/auth/go', { token: code.url.split('/').pop() });
  assert.equal(used.status, 200, JSON.stringify(used.json));
  assert.equal(ok(await phone.get('/api/auth/me')).scope, 'gotv');
  assert.equal(ok(await k.scrut.client.get('/api/auth/me')).scope, null);
});
