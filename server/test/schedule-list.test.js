// The shifts list (GET /api/shifts): what is coming up, soonest first —
// never the oldest 500. A campaign with 516 past shifts used to show "No
// shifts coming up" on every phone, and a volunteer's own next shift as an
// open one. Past shifts come only when asked (?past=1), newest first, a
// page at a time.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { addDays, dayOf, instantOf } from '@starbase/shared/dayparts';

const TZ = 'America/Vancouver';
const tag = Math.random().toString(36).slice(2, 8);
let db, mgr, vol, ws;
const today = dayOf(new Date(), TZ);
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };

// Shifts made straight in the table (a fixture: hundreds of them), `n` of
// them, the first at `from` and one every `stepHours` after.
const fill = (n, from, stepHours, title) => db.query(
  `insert into shifts (id, workspace_id, title, starts_at, ends_at)
   select gen_random_uuid(), $1, $4::text || ' ' || g, $2::timestamptz + make_interval(hours => g * $3::int), $2::timestamptz + make_interval(hours => g * $3::int + 2)
     from generate_series(0, $5::int - 1) g`,
  [ws, from, stepHours, title, n],
);

before(async () => {
  db = await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `List ${tag}`, email: `list-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = ok(await mgr.action('member.invite', { email: `list-vol+${tag}@example.org`, role: 'volunteer' }));
  vol = new Client();
  ok(await vol.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Asha Example', password: 'list-pass-2026' }));
});

test('516 past shifts and one next week: the list is next week’s shift, and the volunteer’s next shift is theirs', async () => {
  // Twelve a week for 43 weeks, the last of them three days ago.
  await fill(516, new Date(Date.now() - (3 + 516 * 14 / 24) * 864e5).toISOString(), 14, 'Past');
  const day = addDays(today, 7);
  const next = ok(await mgr.action('shift.create', {
    title: 'Burma Shave — next week', starts_at: instantOf(day, '06:30', TZ), ends_at: instantOf(day, '08:30', TZ),
  })).shift;
  ok(await vol.action('shift.join', { shift_id: next.id }));

  for (const who of [vol, mgr]) {
    const list = ok(await who.get('/api/shifts')).shifts;
    assert.deepEqual(list.map((s) => s.title), ['Burma Shave — next week'], 'what is coming up — no past shift in the way');
  }
  const mine = ok(await vol.get('/api/shifts')).shifts;
  // Today's rule for "Your next shift" (web/src/pages/Today.jsx): the caller's own, soonest.
  const yours = mine.filter((s) => s.mine && new Date(s.starts_at) >= new Date()).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];
  assert.equal(yours?.id, next.id, 'Your next shift');
  assert.equal(ok(await mgr.get('/api/shifts')).shifts[0].mine, false, 'not the manager’s');
  // The row is the shape every build reads.
  const row = mine[0];
  assert.deepEqual([row.id, row.filled, row.mine, row.capacity, typeof row.starts_at, typeof row.ends_at], [next.id, 1, true, null, 'string', 'string']);
  assert.equal(ok(await vol.get('/api/brief')).shifts[0].id, next.id, 'Today’s own read agrees');
});

test('past shifts come when asked: newest first, a page at a time, each once', async () => {
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = ok(await vol.get(`/api/shifts?past=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    assert.ok(r.shifts.length <= 100, 'a page is 100 at most');
    seen.push(...r.shifts);
    cursor = r.next;
    pages += 1;
  } while (cursor && pages < 20);
  assert.equal(seen.length, 516);
  assert.equal(new Set(seen.map((s) => s.id)).size, 516, 'no shift twice');
  assert.equal(pages, 6);
  const times = seen.map((s) => new Date(s.starts_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  assert.ok(seen.every((s) => /^Past /.test(s.title) && s.mine === false && typeof s.filled === 'number'));
  assert.equal(ok(await vol.get('/api/shifts?past=1&limit=5')).shifts.length, 5);
  assert.equal(ok(await vol.get('/api/shifts?past=1&cursor=nonsense')).shifts.length, 100, 'a bad cursor is the first page');
});

test('“coming up” starts with the campaign’s today: a shift earlier today is in, last night’s is not', async () => {
  const early = ok(await mgr.action('shift.create', {
    title: 'Earlier today', starts_at: instantOf(today, '00:01', TZ), ends_at: instantOf(today, '00:02', TZ),
  })).shift;
  const lastNight = ok(await mgr.action('shift.create', {
    title: 'Last night', starts_at: instantOf(addDays(today, -1), '21:00', TZ), ends_at: instantOf(addDays(today, -1), '23:30', TZ),
  })).shift;
  const overnight = ok(await mgr.action('shift.create', {
    title: 'Election night', starts_at: instantOf(addDays(today, -1), '20:00', TZ), ends_at: instantOf(today, '01:00', TZ),
  })).shift;
  const list = ok(await mgr.get('/api/shifts')).shifts.map((s) => s.id);
  assert.ok(list.includes(early.id), 'earlier today');
  assert.ok(list.includes(overnight.id), 'ran past midnight into today');
  assert.ok(!list.includes(lastNight.id), 'over before today began');
  assert.deepEqual(list.slice(0, 2), [overnight.id, early.id], 'soonest first');
  const past = ok(await mgr.get('/api/shifts?past=1&limit=3')).shifts.map((s) => s.id);
  assert.equal(past[0], lastNight.id, 'the newest past shift');
  assert.ok(!past.includes(early.id) && !past.includes(overnight.id), 'never in both lists');
  for (const s of [early, lastNight, overnight]) ok(await mgr.action('shift.delete', { id: s.id }));
});

test('more than 500 coming up: the first 500, a cursor for the rest, and the caller’s own shift past them all the same', async () => {
  // 505 more, from two weeks out; the volunteer is on the very last.
  await fill(505, instantOf(addDays(today, 14), '09:00', TZ), 3, 'Later');
  const last = (await db.query(`select id from shifts where workspace_id = $1 and title = 'Later 504'`, [ws])).rows[0];
  ok(await vol.action('shift.join', { shift_id: last.id }));

  const first = ok(await vol.get('/api/shifts'));
  assert.equal(first.shifts.length, 501, '500 and the caller’s own');
  assert.equal(first.shifts[0].title, 'Burma Shave — next week', 'soonest first');
  assert.equal(first.shifts[500].id, last.id);
  assert.equal(first.shifts.filter((s) => s.mine).length, 2);
  assert.ok(first.next, 'more to come');
  const desk = ok(await mgr.get('/api/shifts'));
  assert.equal(desk.shifts.length, 500, 'nothing of the manager’s own to add');

  const rest = ok(await vol.get(`/api/shifts?cursor=${encodeURIComponent(first.next)}`));
  assert.equal(rest.shifts.length, 6);
  assert.equal(rest.next, null, 'the end');
  const all = new Set([...first.shifts, ...rest.shifts].map((s) => s.id));
  assert.equal(all.size, 506, 'every upcoming shift, the caller’s own counted once');
});
