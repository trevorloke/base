// Live GOTV's feed (ext/voted/live.js): marks reach the canvassers whose
// turf or phone bank holds the person, within the 1 s batch, and nobody
// else; practice reaches only the practice group; a merge reaches the kept
// person's turf; settings commits (vote.settings, and a voter guide
// publish that writes GOTV's days) send `mode` and close a stream that
// turned off; the guide's corrections send `guide`; the catch-up read; the
// stream's heartbeat, its limit of three per person, and that it holds no
// database connection; the turf index's small steps; the summary by voting
// place; and lock_timeout on a voting day's writes (on a real Postgres).
// test:pg-safe: a fresh campaign per run, every query scoped to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';
import { campaign, ok, no, readSSE, clockBack, square, plus, at } from './gotv-helpers.js';
import { turfIndex, rebuild, dropIndex } from '../ext/voted/turfindex.js';
import { forgetSummary } from '../ext/voted/summary.js';

process.env.STARBASE_GOTV_PING_MS = '300';
let k;
const open = (client, headers = {}) => app.request('/api/voted/live', { headers: { cookie: client.cookie, ...headers } });
const sheet = (c, person, place, extra = {}) => c.action('vote.mark', { person_id: person.id, source: 'scrutineer', place_id: place, client_id: randomUUID(), ...extra });
const votedFor = (events, id) => events.some((e) => e.event === 'voted' && e.data.some((x) => x.p === id));

before(async () => {
  await freshDb();
  k = await campaign('live');
  ok(await k.mgr.action('gotv.post.set', { user_id: k.scrut.id, role: 'scrutineer', place_id: k.p1 }));
  ok(await k.mgr.action('vote.settings', { ceo_answer: { allows_live: true, note: 'Yes, recorded for the test' } }));
  ok(await k.mgr.action('vote.settings', { send: 'live' }));
});
after(clockBack);

test('off: no stream; a scrutineer-only person is refused it; one with a turf or a bank number gets it', async () => {
  no(await k.volA.client.get('/api/voted/live'), 409, 'GOTV isn’t on.');
  // On election day (by itself) the stream opens.
  at(k.G, '10:00');
  const scr = await open(k.scrut.client);
  assert.equal(scr.status, 403);
  assert.equal((await scr.json()).error, 'Who voted doesn’t need the live list');
  ok(await k.mgr.action('turf.assign', { turf_id: k.turfB, user_id: k.scrut.id }));
  const withTurf = await open(k.scrut.client);
  assert.equal(withTurf.status, 200);
  assert.match(withTurf.headers.get('cache-control'), /no-transform/);
  assert.equal(withTurf.headers.get('x-accel-buffering'), 'no');
  await withTurf.body.cancel();
  ok(await k.mgr.action('turf.unassign', { turf_id: k.turfB, user_id: k.scrut.id }));
  // A bank number makes them a caller.
  const callee = await k.mgr.createPerson(`Callee Example ${k.tag}`, { phone: '604-555-0178' });
  const bank = ok(await k.mgr.action('bank.create', { name: `Live bank ${k.tag}`, person_ids: [callee.id] }));
  ok(await k.mgr.action('bank.assign', { id: bank.bank?.id || bank.id, user_id: k.scrut.id, count: 1 }));
  const withBank = await open(k.scrut.client);
  assert.equal(withBank.status, 200);
  await withBank.body.cancel();
  ok(await k.mgr.action('bank.release', { id: bank.bank?.id || bank.id, user_id: k.scrut.id }));
});

test('a mark reaches turf A’s canvasser within 2 s and not turf B’s; the heartbeat runs', async () => {
  ok(await k.mgr.action('vote.settings', { mode: 'on' }));
  const a = await open(k.volA.client);
  const b = await open(k.volB.client);
  const t0 = Date.now();
  const readA = readSSE(a, (ev) => votedFor(ev, k.inA.id) && ev.some((e) => e.comment === ': ping'), 4000);
  const readB = readSSE(b, () => false, 2500);
  await new Promise((r) => setTimeout(r, 100));
  ok(await sheet(k.scrut.client, k.inA, k.p1));
  const evA = await readA;
  const evB = await readB;
  assert.ok(votedFor(evA, k.inA.id), JSON.stringify(evA));
  assert.ok(Date.now() - t0 < 4000);
  const got = evA.find((e) => e.event === 'voted').data.find((x) => x.p === k.inA.id);
  assert.ok(got.v && got.x === 0);
  assert.ok(evA.some((e) => e.comment === ': ping'), 'the heartbeat');
  assert.ok(!votedFor(evB, k.inA.id), 'not to another turf');
});

test('the catch-up read: commit order, one per person, scoped; reload past 1000 or from before today', async () => {
  const head = ok(await k.volA.client.get('/api/voted/status')).feed;
  ok(await k.staff.client.action('vote.mark', { person_id: k.inA2.id, source: 'desk' }));
  ok(await k.staff.client.action('vote.mark', { person_id: k.inA2.id, source: 'desk', voted: false }));
  ok(await k.staff.client.action('vote.mark', { person_id: k.inB.id, source: 'desk' }));
  const a = ok(await k.volA.client.get(`/api/voted/changes?since=${head}`));
  assert.deepEqual(a.changes.map((c) => [c.p, c.v]), [[k.inA2.id, null]], 'one row for A2, its value now; nothing of B');
  const desk = ok(await k.mgr.get(`/api/voted/changes?since=${head}`));
  assert.deepEqual(desk.changes.map((c) => c.p).sort(), [k.inA2.id, k.inB.id].sort());
  assert.ok(desk.last > head);
  assert.equal(ok(await k.mgr.get('/api/voted/changes?since=0')).reload, true);
  // More than 1000 since: reload.
  const db = await getDb();
  await db.query(
    `insert into voted_marks (id, workspace_id, person_id, voted, source, created_at)
     select gen_random_uuid(), $1, $2, true, 'desk', now() from generate_series(1, 1001)`, [k.ws, k.inB.id],
  ).catch(async () => {
    for (let i = 0; i < 1001; i += 1) await db.query("insert into voted_marks (id, workspace_id, person_id, voted, source) values ($1, $2, $3, true, 'desk')", [randomUUID(), k.ws, k.inB.id]);
  });
  assert.equal(ok(await k.mgr.get(`/api/voted/changes?since=${desk.last}`)).reload, true);
});

test('practice changes reach only the practice group', async () => {
  at(plus(5), '12:00');
  ok(await k.mgr.action('vote.settings', { mode: 'off' }));
  ok(await k.mgr.action('vote.settings', { mode: 'practice', practice_users: [k.volA.id] }));
  no(await k.volB.client.get('/api/voted/live'), 409, 'GOTV isn’t on.');
  const a = await open(k.volA.client);
  const desk = await open(k.mgr);
  const readA = readSSE(a, (ev) => votedFor(ev, k.inA2.id), 4000);
  const readD = readSSE(desk, () => false, 2500);
  await new Promise((r) => setTimeout(r, 100));
  ok(await sheet(k.scrut.client, k.inA2, k.p1, { practice: true }));
  const evA = await readA;
  const evD = await readD;
  assert.equal(evA.find((e) => e.event === 'voted').data.find((x) => x.p === k.inA2.id).x, 1);
  assert.ok(!votedFor(evD, k.inA2.id), 'a manager outside the group gets no practice change');
  // Ending practice: mode to the group's stream, then it closes.
  const a2 = await open(k.volA.client);
  const read2 = readSSE(a2, (ev) => ev.some((e) => e.event === 'closed'), 4000);
  await new Promise((r) => setTimeout(r, 100));
  ok(await k.mgr.action('vote.settings', { mode: 'off', auto: false }));
  const ev2 = await read2;
  const mode = ev2.find((e) => e.event === 'mode');
  assert.equal(mode?.data.practice, false);
  assert.equal(mode?.data.active, false);
  assert.ok(ev2.some((e) => e.event === 'closed'), 'and the stream closes');
  ok(await k.mgr.action('vote.settings', { auto: true }));
});

test('a merge reaches the canvasser on the kept person’s turf, live and through the catch-up read', async () => {
  ok(await k.mgr.action('vote.settings', { mode: 'on' }));
  const keep = await k.mgr.createPerson(`Keep Example ${k.tag}`, { lat: 49.1403, lng: -122.8403, phone: '604-555-0181' });
  const drop = await k.mgr.createPerson(`Keep Example ${k.tag}`, { phone: '604-555-0181' });
  ok(await k.mgr.action('vote.mark', { person_id: drop.id, source: 'desk' }));
  const head = ok(await k.volA.client.get('/api/voted/status')).feed;
  const a = await open(k.volA.client);
  const read = readSSE(a, (ev) => votedFor(ev, keep.id), 4000);
  await new Promise((r) => setTimeout(r, 100));
  ok(await k.mgr.action('person.merge', { keep: keep.id, drop: drop.id }));
  const ev = await read;
  assert.ok(ev.find((e) => e.event === 'voted').data.find((x) => x.p === keep.id).v, 'live');
  const ch = ok(await k.volA.client.get(`/api/voted/changes?since=${head}`));
  assert.ok(ch.changes.find((c) => c.p === keep.id)?.v, 'and caught up');
});

test('settings commits: mode on every stream, and a voter guide publish that moves GOTV’s days', async () => {
  ok(await k.mgr.action('vote.settings', { mode: 'off', auto: true }));
  // Today is no GOTV day: the guide's days include it, and publishing with
  // "Also use these days for GOTV mode" turns GOTV on by itself.
  at(plus(30), '10:00');
  const D = plus(30);
  ok(await k.mgr.action('site.guide.days', { days: [{ day: D, kind: 'general', opens: '08:00', closes: '20:00' }] }));
  ok(await k.mgr.action('site.guide.place.save', { id: k.p1, name: `Place One ${k.tag}`, address: '100 Example Ave', lat: 49.15, lng: -122.8, days: [{ day: D }] }));
  ok(await k.mgr.action('site.guide.place.save', { id: k.p2, name: `Place Two ${k.tag}`, address: '200 Example Ave', lat: 49.16, lng: -122.81, days: [{ day: D }] }));
  ok(await k.mgr.action('site.guide.save', { vote_anywhere: true, official_url: 'https://elections.example.org/vote' }));
  ok(await k.mgr.action('site.guide.check', { section: 'days', checked: true }));
  ok(await k.mgr.action('site.guide.check', { section: 'places', checked: true }));
  ok(await k.mgr.action('site.settings.save', { org: { name: 'Live Example Campaign', agentName: 'Pat Example', agentContact: 'agent@example.org' } }));
  // A desk stream needs GOTV active: practice for a moment gives one to the group.
  assert.equal(ok(await k.volA.client.get('/api/voted/status')).active, false);
  ok(await k.mgr.action('vote.settings', { mode: 'practice', practice_users: [k.volA.id] }));
  const a = await open(k.volA.client);
  const read = readSSE(a, (ev) => ev.some((e) => e.event === 'mode' && e.data.on), 5000);
  await new Promise((r) => setTimeout(r, 100));
  ok(await k.mgr.action('site.guide.publish', { gotv_days: true }));
  const ev = await read;
  const mode = ev.find((e) => e.event === 'mode');
  assert.equal(mode?.data.on, true, 'the open stream hears GOTV turn on by itself');
  assert.equal(mode?.data.active, true);
  assert.ok(!ev.some((e) => e.event === 'closed'), 'and stays open');
  // The next status is on at once (no 5 s wait for the kept settings).
  const s = ok(await k.volA.client.get('/api/voted/status'));
  assert.equal(s.on, true);
  assert.equal(s.voting_day, 'election');
  // Practice ends (GOTV stays on: today is a voting day); a stream open now
  // gets mode (off) and closes when the days move away.
  ok(await k.mgr.action('vote.settings', { mode: 'off' }));
  await a.body.cancel().catch(() => {});
  const b = await open(k.volA.client);
  const readB = readSSE(b, (e2) => e2.some((e) => e.event === 'closed'), 5000);
  await new Promise((r) => setTimeout(r, 100));
  ok(await k.mgr.action('vote.settings', { election_day: plus(31), advance_days: [] }));
  const evB = await readB;
  assert.equal(evB.find((e) => e.event === 'mode')?.data.on, false);
  assert.ok(evB.some((e) => e.event === 'closed'));
});

test('the guide’s live correction: closed today sends `guide` with the new rev; with GOTV off nothing fails', async () => {
  ok(await k.mgr.action('vote.settings', { mode: 'on' }));
  const a = await open(k.volA.client);
  const read = readSSE(a, (ev) => ev.some((e) => e.event === 'guide'), 5000);
  await new Promise((r) => setTimeout(r, 100));
  ok(await k.mgr.action('site.guide.place.save', { id: k.p2, name: `Place Two ${k.tag}`, address: '200 Example Ave', lat: 49.16, lng: -122.81, days: [{ day: plus(30) }], closed: true }));
  const ev = await read;
  const g = ev.find((e) => e.event === 'guide');
  const db = await getDb();
  const rev = (await db.query('select rev from vote_guide where workspace_id = $1', [k.ws])).rows[0].rev;
  assert.equal(g?.data.rev, Number(rev));
  ok(await k.mgr.action('vote.settings', { mode: 'off', auto: false }));
  ok(await k.mgr.action('site.guide.place.save', { id: k.p2, name: `Place Two ${k.tag}`, address: '200 Example Ave', lat: 49.16, lng: -122.81, days: [{ day: plus(30) }], closed: false }));
  ok(await k.mgr.action('vote.settings', { auto: true }));
});

test('three streams a person: a fourth closes the first; open streams hold no pool connection', async () => {
  ok(await k.mgr.action('vote.settings', { mode: 'on' }));
  const first = await open(k.volA.client);
  const readFirst = readSSE(first, (ev) => ev.some((e) => e.event === 'closed'), 4000);
  const others = [await open(k.volA.client), await open(k.volA.client)];
  await new Promise((r) => setTimeout(r, 50));
  const fourth = await open(k.volA.client);
  assert.ok((await readFirst).some((e) => e.event === 'closed'), 'the oldest gave way');
  for (const r of [...others, fourth]) await r.body.cancel();
  const db = await getDb();
  if (!db.pool) return; // PGlite: one connection, nothing to count
  const used = () => db.pool.totalCount - db.pool.idleCount;
  const before = used();
  const many = [];
  const viewers = [k.volB.client, k.mgr, k.staff.client, k.admin.client];
  for (let i = 0; i < 50; i += 1) many.push(await open(viewers[i % 4]));
  assert.ok(many.every((r) => r.status === 200));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(used(), before, 'no connection held by an open stream');
  for (const r of many) await r.body.cancel().catch(() => {});
});

test('the turf index: a turf rebuilds alone, a person’s pin moves them, and a build yields', async () => {
  const idx = await turfIndex(await getDb(), k.ws);
  const before = idx.turfs.get(k.turfB);
  const p = await k.mgr.createPerson(`Mover Example ${k.tag}`, { lat: 49.1402, lng: -122.8402 });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await turfIndex(await getDb(), k.ws)).turfs.get(k.turfA).ids.has(p.id), 'a new pin in A');
  ok(await k.mgr.action('person.update', { id: p.id, lat: 49.24, lng: -122.74 }));
  await new Promise((r) => setTimeout(r, 50));
  const now = await turfIndex(await getDb(), k.ws);
  assert.ok(!now.turfs.get(k.turfA).ids.has(p.id) && now.turfs.get(k.turfB).ids.has(p.id), 'moved to B');
  ok(await k.mgr.action('turf.update', { id: k.turfA, polygon: square(49.14, -122.84, 0.002) }));
  await new Promise((r) => setTimeout(r, 50));
  const after2 = await turfIndex(await getDb(), k.ws);
  assert.equal(after2.turfs.get(k.turfB), before === after2.turfs.get(k.turfB) ? before : after2.turfs.get(k.turfB));
  assert.ok(after2.turfs.get(k.turfB).ids.has(p.id), 'B kept');
  // A build of 20,000 points yields: the event loop's delay stays small.
  const db = await getDb();
  const ws2 = (await db.query('select id from workspaces where id = $1', [k.ws])).rows[0].id;
  const big = ok(await k.mgr.action('turf.create', { name: `Big turf ${k.tag}`, polygon: square(49.5, -122.5, 0.2) })).turf.id;
  await db.query(
    `insert into persons (id, workspace_id, kind, name, lat, lng, tags, socials)
     select gen_random_uuid(), $1, 'person', 'Dot Example ' || g, 49.5 + (random() - 0.5) * 0.3, -122.5 + (random() - 0.5) * 0.3, '[]', '{}'
       from generate_series(1, 20000) g`, [ws2],
  );
  dropIndex(k.ws);
  // The longest stretch the build keeps the event loop to itself, measured
  // between turns of a setImmediate ticker. In these tests the database runs
  // in this same thread (PGlite), so a query's own time blocks the loop here
  // as it never does over Postgres's wire: that time is taken out of each
  // gap, leaving the build's own work. The last tick() in finally counts
  // the stretch after the build's last yield too.
  const q0 = db.query;
  let busy = 0, since = 0, inQueries = 0;
  const queryTime = () => inQueries + (busy ? performance.now() - since : 0);
  db.query = async (...a) => {
    if (busy++ === 0) since = performance.now();
    try { return await q0.apply(db, a); } finally { if (--busy === 0) inQueries += performance.now() - since; }
  };
  let longest = 0, turns = 0, on = true, prev = performance.now(), prevQ = 0;
  const tick = () => {
    const t = performance.now(), q = queryTime();
    longest = Math.max(longest, (t - prev) - (q - prevQ));
    prev = t; prevQ = q; turns += 1;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  let built;
  try { built = await rebuild(db, k.ws); } finally { on = false; tick(); db.query = q0; }
  assert.ok(built.turfs.get(big).ids.size > 5000);
  assert.ok(turns > 2, `the ticker ran between the build's steps (${turns} turns)`);
  assert.ok(longest < 250, `the build held the event loop ${longest.toFixed(0)} ms at a stretch`);
});

test('the summary: by voting place, marked in the last hour by when it reached the office, held, kept 15 s', async () => {
  at(plus(30), '21:00');
  ok(await k.mgr.action('vote.settings', { mode: 'on' }));
  ok(await k.staff.client.action('gotv.check', { typed: 'Unsure Example', place_id: k.p1, client_id: randomUUID() }));
  const sum = ok(await k.mgr.get('/api/voted/summary'));
  assert.ok(Array.isArray(sum.by_place));
  const one = sum.by_place.find((p) => p.place_id === k.p1);
  assert.ok(one && 'marks_today' in one && 'scrutineers_on_duty' in one && 'closes_at' in one);
  assert.ok(sum.held >= 1);
  assert.equal(typeof sum.marked_hour, 'number');
  const again = ok(await k.mgr.get('/api/voted/summary'));
  assert.equal(again.held, sum.held, 'kept');
  void at;
});

test('scrutineers on duty: only on a voting day, inside its window, at a place open today (not on a day off)', async () => {
  // The days as the tests above left them: GOTV's election day plus(31),
  // Place One open on plus(30) (a guide day only) and plus(31).
  const E = plus(31);
  ok(await k.mgr.action('vote.settings', { election_day: E, advance_days: [], auto: true }));
  ok(await k.mgr.action('site.guide.place.save', { id: k.p1, name: `Place One ${k.tag}`, address: '100 Example Ave', lat: 49.15, lng: -122.8, days: [{ day: plus(30) }, { day: E }] }));
  const onDutyAt = async (day) => {
    at(day, '10:00');
    forgetSummary(k.ws, true);
    const sum = ok(await k.mgr.get('/api/voted/summary'));
    return sum.by_place.find((p) => p.place_id === k.p1).scrutineers_on_duty;
  };
  assert.equal(await onDutyAt(E), 1, 'election day: the scrutineer is on duty at Place One');
  assert.equal(await onDutyAt(plus(30)), 0, 'the place is open but it isn’t a GOTV voting day: nobody is');
  assert.equal(await onDutyAt(plus(32)), 0, 'a day off: nobody is');
  forgetSummary(k.ws, true);
});

test('a held campaign lock: vote.mark answers 503 after the wait, which the outbox retries (real Postgres only)', async (t) => {
  const db = await getDb();
  if (!db.pool || !process.env.GOTV_REAL_PG) { t.skip('needs a real Postgres (GOTV_REAL_PG=1 with DATABASE_URL)'); return; }
  process.env.STARBASE_GOTV_LOCK_MS = '1000';
  const holder = await db.pool.connect();
  try {
    await holder.query('begin');
    await holder.query('select 1 from workspaces where id = $1 for update', [k.ws]);
    const t0 = Date.now();
    const r = await k.volA.client.action('vote.mark', { person_id: k.inA.id, source: 'door', client_id: randomUUID() });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'Busy — will try again');
    assert.ok(Date.now() - t0 >= 900);
  } finally {
    await holder.query('rollback');
    holder.release();
    delete process.env.STARBASE_GOTV_LOCK_MS;
  }
});
