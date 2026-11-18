// Live GOTV's day clock (ext/voted/clock.js), through the API on the moved
// clock (lib/clock.js): each voting place's close from the voter guide
// (a place's own hours first, then a manager's close_override, then the
// guide's day), a mark's own day, the work window after a voting day, and
// nothing sent with no hours until a manager releases the day.
// test:pg-safe: a fresh campaign per run, every query scoped to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';
import { getDb } from '../db/client.js';
import { campaign, ok, no, at, clockBack, plus, TZ } from './gotv-helpers.js';
import { atLocal } from '../lib/tzrule.js';
import { closeAt, windowEnd } from '../ext/voted/clock.js';

const HELD = 'Names go to the office after polls close.';
let k;
const mark = (c, person, place, extra = {}) => c.action('vote.mark', { person_id: person.id, source: 'scrutineer', place_id: place, client_id: randomUUID(), ...extra });

before(async () => {
  await freshDb();
  k = await campaign('clock');
  // Sid scrutineers at Place One, Rae runs every place.
  ok(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1 }));
  ok(await k.mgr.action('gotv.post.set', { user_id: k.runner.id, role: 'runner' }));
});
after(clockBack);

test('the general day: the 16:00 place sends at 16:30, the others at 20:00; the advance day at 20:00', async () => {
  at(k.G, '16:30');
  ok(await mark(k.scrut.client, k.inA, k.p1), 'Place One closed at 16:00 (its own hours)');
  no(await mark(k.runner.client, k.inA2, k.p2), 409, HELD);
  at(k.G, '20:01');
  ok(await mark(k.runner.client, k.inA2, k.p2));
  at(k.A1, '19:59');
  no(await mark(k.scrut.client, k.inB, k.p1), 409, HELD);
  at(k.A1, '20:00');
  ok(await mark(k.scrut.client, k.inB, k.p1), 'the advance day opens at its 20:00 close');
  // Status says the same: open, and when.
  at(k.G, '15:00');
  const s = ok(await k.scrut.client.get('/api/voted/status'));
  assert.equal(s.send_open, false);
  assert.equal(s.closes_at, new Date(atLocal(k.G, '16:00', TZ)).toISOString(), 'today’s close for my place');
  assert.deepEqual(s.on_duty.place.id, k.p1);
});

test('close_override fills a day the guide lacks; a place’s own hours still win; no hours: only a release opens', async () => {
  const db = await getDb();
  const s = { close_override: { [k.G]: '18:00' } };
  const h = { days: new Map([[k.G, { opens: '08:00', closes: '20:00' }]]), places: new Map() };
  assert.equal(closeAt(h, s, k.G, null, TZ), atLocal(k.G, '20:00', TZ) - 2 * 3600_000, 'the override is used before the guide’s day');
  const own = { days: new Map(), places: new Map([['p', { id: 'p', gone: false, listed: true, closed_on: null, days: new Map([[k.G, { closes: '16:00' }]]) }]]) };
  assert.equal(closeAt(own, s, k.G, 'p', TZ), atLocal(k.G, '16:00', TZ), 'a place’s own hours win');
  assert.equal(closeAt({ days: new Map(), places: new Map() }, {}, k.G, null, TZ), null, 'no hours: no close');

  // A day with no hours anywhere (a fourth voting day the guide doesn't have).
  const X = plus(25);
  ok(await k.mgr.action('vote.settings', { advance_days: [k.A1, k.A2, X] }));
  ok(await k.mgr.action('gotv.post.set', { user_id: k.runner.id, role: 'runner', days: [] }));
  at(X, '23:00');
  no(await mark(k.runner.client, k.inA, k.p2), 409, HELD);
  assert.equal(ok(await k.runner.client.get('/api/voted/status')).closes_at, null, 'screens say: when the office says polls are closed');
  ok(await k.mgr.action('vote.settings', { close_override: { [X]: '21:00' } }));
  ok(await mark(k.runner.client, k.inA, k.p2), 'the override opens it at 21:00');
  ok(await k.mgr.action('vote.settings', { close_override: { [X]: null } }));
  no(await mark(k.runner.client, k.inA2, k.p2), 409, HELD);
  ok(await k.mgr.action('vote.settings', { release: true }));
  ok(await mark(k.runner.client, k.inA2, k.p2), 'a release opens the day');
  const rel = (await db.query('select released from voted_settings where workspace_id = $1', [k.ws])).rows[0].released;
  assert.deepEqual(typeof rel === 'string' ? JSON.parse(rel) : rel, [X]);
  ok(await k.mgr.action('vote.settings', { advance_days: [k.A1, k.A2] }));
});

test('a name written at 19:58 and sent at 00:20 the next day keeps 19:58', async () => {
  at(k.G, '19:58');
  const written = new Date(atLocal(k.G, '19:58', TZ)).toISOString();
  at(plus(21), '00:20');
  const cid = randomUUID();
  ok(await k.runner.client.action('vote.mark', { person_id: k.inB.id, source: 'scrutineer', place_id: k.p2, client_id: cid, client_at: written }));
  const db = await getDb();
  const row = (await db.query('select created_at from voted_marks where workspace_id = $1 and client_id = $2', [k.ws, cid])).rows[0];
  assert.equal(new Date(row.created_at).toISOString(), written);
});

test('advance day 1’s names: matched on a day between, still sending on day 2’s morning; refused 8 days after the last day', async () => {
  const w1 = new Date(atLocal(k.A1, '15:00', TZ)).toISOString();
  at(plus(11), '10:00'); // a non-voting day between A1 and A2
  ok(await mark(k.scrut.client, k.inA, k.p1, { client_at: w1 }));
  at(k.A2, '07:30'); // before A2 opens: still A1's window
  ok(await mark(k.scrut.client, k.inA2, k.p1, { client_at: w1 }), 'day 1’s notes still send');
  at(k.A2, '07:45');
  no(await mark(k.scrut.client, k.inB, k.p1, { client_at: new Date(atLocal(k.A2, '07:40', TZ)).toISOString() }), 409, HELD);
  // The window is capped 7 days after the last voting day.
  const wG = new Date(atLocal(k.G, '19:00', TZ)).toISOString();
  at(plus(28), '12:00');
  no(await mark(k.runner.client, k.inB, k.p2, { client_at: wG }), 403, 'Only a scrutineer or runner on duty can do this');
  const db = await getDb();
  const s = (await db.query('select advance_days, election_day from voted_settings where workspace_id = $1', [k.ws])).rows[0];
  const h = { days: new Map(), places: new Map() };
  const sett = { advance_days: [k.A1, k.A2], election_day: s.election_day };
  assert.ok(windowEnd(h, sett, k.G, TZ) <= atLocal(plus(28), '00:00', TZ));
});

test('a note’s own day: status keeps the post on a day between, and /gotv/open says which notes may be matched', async () => {
  const w1 = new Date(atLocal(k.A1, '19:58', TZ)).toISOString();
  at(plus(11), '01:58'); // after midnight, a non-voting day between A1 and A2
  const st = ok(await k.scrut.client.get('/api/voted/status'));
  assert.equal(st.on_duty, null, 'not on duty today');
  assert.deepEqual(st.post, { role: 'scrutineer', place: { id: k.p1, name: st.post?.place?.name } });
  assert.equal(st.today_from, new Date(atLocal(plus(11), '00:00', TZ)).toISOString());
  const wToday = new Date(atLocal(plus(11), '01:00', TZ)).toISOString();
  const r = ok(await k.scrut.client.get(`/api/gotv/open?${new URLSearchParams({ place_id: k.p1, written_at: `${w1},${wToday}` })}`));
  assert.deepEqual(r.notes.map((n) => [n.written_at, n.day, n.on_duty, n.open]), [[w1, k.A1, true, true], [wToday, plus(11), false, false]]);
  // Day 2's morning: day 1's note still matches; a note written today waits for today's close.
  at(k.A2, '07:45');
  const w2 = new Date(atLocal(k.A2, '07:40', TZ)).toISOString();
  const r2 = ok(await k.scrut.client.get(`/api/gotv/open?${new URLSearchParams({ place_id: k.p1, written_at: `${w1},${w2}` })}`));
  assert.deepEqual(r2.notes.map((n) => [n.day, n.on_duty, n.open]), [[k.A1, true, true], [k.A2, true, false]]);
  assert.equal(r2.notes[1].closes_hm, '20:00');
  // Not posted: refused, as the look-up is.
  no(await k.volA.client.get(`/api/gotv/open?${new URLSearchParams({ place_id: k.p1, written_at: w1 })}`), 403);
});

test('a place closed today refuses today’s marks only', async () => {
  at(k.A2, '21:00');
  const db = await getDb();
  await db.query('update vote_place_info set closed_on = $2 where place_id = $1', [k.p1, k.A2]);
  const { forgetHours } = await import('../ext/voted/clock.js');
  forgetHours(k.ws);
  no(await mark(k.scrut.client, k.inA, k.p1), 409, 'That voting place is closed today');
  at(k.G, '21:00');
  ok(await mark(k.scrut.client, k.inA, k.p1), 'open again on the next voting day');
  await db.query('update vote_place_info set closed_on = null where place_id = $1', [k.p1]);
  forgetHours(k.ws);
});
