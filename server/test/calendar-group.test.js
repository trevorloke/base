// The group calendar (ext/calendar items.js, group.js): one calendar for the
// campaign, where each person sees what is on it for them — by role,
// permission, candidate seat and team — on the page (GET /api/calendar) and
// in their own calendar link (/cal/<43>.ics). Managers add items and say who
// sees each: everyone, all candidates, one candidate, managers, or a team.
// Times are typed on the campaign's clock and kept as moments; all-day items
// are days with no time.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { verifyChain } from '../lib/events.js';
import { todayOf } from '../ext/audience/index.js';

const tag = Math.random().toString(36).slice(2, 8);
let db, mgr, ws, vol, volId, vol2, vol2Id, staff, treas, cand, cand2, cand2Seat, candSeat, other, teamId;
const I = {};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const unfold = (s) => s.replace(/\r\n /g, '');
const uids = (ics) => [...unfold(ics).matchAll(/^UID:(.*)\r?$/gm)].map((m) => m[1]);
let ipN = 0;
const fetchPath = async (path) => {
  ipN += 1;
  const res = await app.request(path, { headers: { 'x-real-ip': `198.51.100.${ipN % 250}` } });
  return { status: res.status, body: await res.text() };
};
const pathOf = (url) => new URL(url).pathname;
const join = async (role, who) => {
  const inv = ok(await mgr.action('member.invite', { email: `grp-${who.toLowerCase()}+${tag}@example.org`, role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${who} Example`, password: 'calendar-pass-2026' }));
  return { client: c, id: j.user.id };
};
// A volunteer who takes a candidate's seat (the seat's email is theirs).
const seat = async (who) => {
  const { client, id } = await join('volunteer', who);
  const s = ok(await mgr.action('candidate.save', { name: `${who} Example`, office: 'Council', email: `grp-${who.toLowerCase()}+${tag}@example.org` })).candidate.id;
  assert.equal(ok(await mgr.action('candidate.invite', { id: s })).linked, true);
  return { client, id, seat: s };
};
const add = async (input, by = mgr) => ok(await by.action('calendar.item.add', { all_day: false, ...input })).item;
const month = async (c, m, extra = '') => ok(await c.get(`/api/calendar?month=${m}${extra}`));
const keys = (r) => r.entries.map((e) => e.key);
const titles = (r) => r.entries.map((e) => e.title);
const feedOf = async (c) => {
  const f = ok(await c.get('/api/calendar/feed')).feed || ok(await c.action('calendar.feed.make', {})).feed;
  return pathOf(f.url);
};

before(async () => {
  db = await freshDb();
  delete process.env.STARBASE_PUBLIC_URL;
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Group ${tag}`, email: `grp-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  ({ client: vol, id: volId } = await join('volunteer', 'Vik'));
  ({ client: vol2, id: vol2Id } = await join('volunteer', 'Wren'));
  ({ client: staff } = await join('staff', 'Sol'));
  ({ client: treas } = await join('treasurer', 'Tess'));
  ({ client: cand, seat: candSeat } = await seat('Cleo'));
  ({ client: cand2, seat: cand2Seat } = await seat('Dev'));
  other = new Client();
  await other.signup({ workspaceName: `Elsewhere ${tag}`, email: `grp-other+${tag}@example.org` });
  teamId = ok(await mgr.action('team.create', { name: 'Sign crew' })).team.id;
  ok(await mgr.action('team.member.add', { team_id: teamId, user_id: volId }));
});

test('managers add items, timed on the campaign’s clock or all day; the log has the title and who, never the notes', async () => {
  I.all = await add({ title: 'Campaign launch', day: '2030-05-06', start: '18:30', end: '20:00', place: 'Bear Creek Park', details: 'Bring a friend', who: 'everyone' });
  // 6:30 pm in Vancouver (UTC-7) is 1:30 the next morning in UTC.
  assert.equal(new Date(I.all.starts_at).toISOString(), '2030-05-07T01:30:00.000Z');
  assert.equal(new Date(I.all.ends_at).toISOString(), '2030-05-07T03:00:00.000Z');
  I.cands = await add({ title: 'Candidates’ debate prep', day: '2030-05-08', start: '09:00', end: '10:30', who: 'candidates' });
  I.cleo = await add({ title: 'Radio interview', day: '2030-05-09', start: '07:15', end: '07:45', who: `candidate:${candSeat}` });
  I.mgrs = await add({ title: 'Budget meeting', day: '2030-05-10', start: '12:00', end: '13:00', who: 'managers', details: 'Numbers for Q3' });
  I.team = await add({ title: 'Sign crew drive', day: '2030-05-11', start: '10:00', end: '14:00', who: `team:${teamId}` });
  I.days = await add({ title: 'Office closed', all_day: true, day: '2030-05-30', last_day: '2030-06-02', who: 'everyone' });
  assert.equal(I.days.all_day, true);
  const ev = (await db.query(`select payload from events where workspace_id = $1 and entity_type = 'calendar_item' order by seq`, [ws])).rows;
  assert.equal(ev.length, 6);
  assert.deepEqual(ev[0].payload, { title: 'Campaign launch', who: 'everyone' });
  assert.ok(!JSON.stringify(ev).includes('Bring a friend') && !JSON.stringify(ev).includes('Numbers for Q3'), 'notes stay off the log');
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('who may add, change and remove: managers only; another campaign’s items are not found', async () => {
  for (const c of [vol, staff, treas, cand]) {
    assert.equal((await c.action('calendar.item.add', { title: 'Mine', all_day: true, day: '2030-05-12', who: 'everyone' })).status, 403);
    assert.equal((await c.action('calendar.item.remove', { id: I.all.id })).status, 403);
  }
  const elsewhere = await other.action('calendar.item.edit', { id: I.all.id, title: 'Taken', all_day: true, day: '2030-05-12', who: 'everyone' });
  assert.equal(elsewhere.status, 404);
  assert.equal((await other.action('calendar.item.remove', { id: I.all.id })).status, 404);
  assert.deepEqual(titles(await month(other, '2030-05')), [], 'nothing of this campaign');
});

test('the form’s refusals say what to fix', async () => {
  const bad = async (input, error) => {
    const r = await mgr.action('calendar.item.add', { title: 'Bad', all_day: false, day: '2030-05-12', start: '10:00', end: '11:00', who: 'everyone', ...input });
    assert.deepEqual([r.status, r.json.error], [400, error], JSON.stringify(input));
  };
  await bad({ end: '09:00' }, 'It ends before it starts');
  await bad({ start: undefined }, 'Add a start time, or make it all day');
  await bad({ all_day: true, last_day: '2030-05-11' }, 'The last day is before the first');
  await bad({ who: `team:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}` }, 'Pick who sees it from the list');
  await bad({ who: 'volunteers' }, 'Pick who sees it from the list');
  await bad({ day: '2030-02-30' }, 'Pick a day');
});

test('a volunteer sees items for everyone and for their team — not candidates’, managers’ or another team’s', async () => {
  const r = await month(vol, '2030-05');
  assert.deepEqual(titles(r), ['Campaign launch', 'Sign crew drive', 'Office closed']);
  assert.equal(r.canAdd, false);
  assert.equal(r.canEvery, false);
  assert.equal(r.who, undefined, 'the choices are the managers’');
  assert.deepEqual(titles(await month(vol2, '2030-05')), ['Campaign launch', 'Office closed'], 'not on the sign crew');
  const launch = r.entries[0];
  assert.deepEqual([launch.kind, launch.day, launch.allDay, launch.where, launch.details], ['item', '2030-05-06', false, 'Bear Creek Park', 'Bring a friend']);
  assert.equal(launch.who, 'Everyone');
  assert.equal(r.entries[1].who, 'Sign crew');
  // Taken off the team: its items go with it.
  ok(await mgr.action('team.member.remove', { team_id: teamId, user_id: volId }));
  assert.deepEqual(titles(await month(vol, '2030-05')), ['Campaign launch', 'Office closed']);
  ok(await mgr.action('team.member.add', { team_id: teamId, user_id: volId }));
});

test('a candidate sees items for all candidates and for their own seat — not another candidate’s', async () => {
  assert.deepEqual(titles(await month(cand, '2030-05')), ['Campaign launch', 'Candidates’ debate prep', 'Radio interview', 'Office closed']);
  assert.deepEqual(titles(await month(cand2, '2030-05')), ['Campaign launch', 'Candidates’ debate prep', 'Office closed']);
  const r = await month(cand, '2030-05');
  assert.equal(r.entries.find((e) => e.title === 'Radio interview').who, 'Cleo Example');
  assert.equal(r.entries.find((e) => e.title === 'Candidates’ debate prep').who, 'Candidates');
});

test('staff and treasurers see everyone’s items, not the managers’; a manager sees every item with who it is for', async () => {
  for (const c of [staff, treas]) assert.deepEqual(titles(await month(c, '2030-05')), ['Campaign launch', 'Office closed']);
  const m = await month(mgr, '2030-05');
  assert.deepEqual(titles(m), ['Campaign launch', 'Candidates’ debate prep', 'Radio interview', 'Budget meeting', 'Sign crew drive', 'Office closed']);
  assert.deepEqual(m.entries.map((e) => e.who), ['Everyone', 'Candidates', 'Cleo Example', 'Managers', 'Sign crew', 'Everyone']);
  assert.equal(m.canAdd, true);
  assert.deepEqual(m.who.map((w) => w.label), ['Everyone', 'All candidates', 'Cleo Example', 'Dev Example', 'Managers', 'Sign crew']);
  assert.deepEqual(m.who.map((w) => w.value), ['everyone', 'candidates', `candidate:${candSeat}`, `candidate:${cand2Seat}`, 'managers', `team:${teamId}`]);
  assert.equal(m.entries.find((e) => e.title === 'Budget meeting').value, 'managers', 'the form’s choice, for Edit');
});

test('shifts: each person’s own bookings and the website’s public events; the desk can show every shift', async () => {
  const wave = ok(await mgr.action('shift.createMany', { kind: 'burma_shave', location: 'King George Blvd & 88 Ave', days: ['2030-05-14'], start: '06:30', end: '08:30' })).shifts[0];
  const quiet = ok(await mgr.action('shift.createMany', { kind: 'burma_shave', location: '72 Ave & Scott Rd', days: ['2030-05-15'], start: '06:30', end: '08:30' })).shifts[0];
  const picnic = ok(await mgr.action('shift.createMany', { kind: 'event', location: 'Bear Creek Park', days: ['2030-05-16'], start: '11:00', end: '14:00', name: 'Family picnic', public: true, instructions: 'Gate code 2299' })).shifts[0];
  ok(await vol.action('shift.join', { shift_id: wave.id }));
  const v = await month(vol, '2030-05');
  assert.deepEqual(keys(v).filter((k) => k.startsWith('shift') || k.startsWith('event')), [`shift-${wave.id}`, `event-${picnic.id}`]);
  const mine = v.entries.find((e) => e.key === `shift-${wave.id}`);
  assert.deepEqual([mine.kind, mine.mine, mine.day, mine.shift_id], ['shift', true, '2030-05-14', wave.id]);
  assert.ok(!JSON.stringify(v).includes('Gate code'), 'never a shift’s instructions on the calendar');
  assert.deepEqual(keys(await month(vol2, '2030-05')).filter((k) => !k.startsWith('item')), [`event-${picnic.id}`], 'not someone else’s shift');
  // Every shift: the desk's (Shifts board), on asking; a volunteer's ask is ignored.
  const m = await month(mgr, '2030-05', '&every=1');
  assert.equal(m.canEvery, true);
  assert.ok(keys(m).includes(`every-${quiet.id}`) && keys(m).includes(`every-${wave.id}`));
  assert.ok(!keys(await month(mgr, '2030-05')).includes(`every-${quiet.id}`), 'only on asking');
  assert.ok(!keys(await month(vol, '2030-05', '&every=1')).some((k) => k.startsWith('every-')));
  assert.equal((await month(staff, '2030-05', '&every=1')).canEvery, true, 'staff have the Shifts board');
  // Kept out of Shifts: no shifts or events.
  await db.query(`update memberships set permissions = '{"deny":["shifts"]}' where user_id = $1 and workspace_id = $2`, [volId, ws]);
  try {
    assert.ok(!keys(await month(vol, '2030-05')).some((k) => k.startsWith('shift-') || k.startsWith('event-')));
  } finally {
    await db.query(`update memberships set permissions = '{}' where user_id = $1 and workspace_id = $2`, [volId, ws]);
  }
});

test('voting days for everyone, filing dates for the money desk', async () => {
  ok(await mgr.action('vote.settings', { on: false, election_day: '2030-10-19', advance_days: ['2030-10-09'] }));
  ok(await treas.action('filing.dates', { dates: [{ name: 'Disclosure statement due', due_on: '2030-10-20' }] }));
  const v = await month(vol, '2030-10');
  assert.deepEqual(v.entries.map((e) => [e.kind, e.title, e.day, e.allDay]), [
    ['vote', 'Advance voting', '2030-10-09', true], ['vote', 'Election day', '2030-10-19', true],
  ]);
  assert.deepEqual(titles(await month(treas, '2030-10')), ['Advance voting', 'Election day', 'Disclosure statement due']);
});

test('each entry has its own Add to Google Calendar link: the time in UTC, all-day items as days', async () => {
  const r = await month(vol, '2030-05');
  const launch = r.entries.find((e) => e.title === 'Campaign launch');
  assert.match(launch.google, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Campaign%20launch&dates=20300507T013000Z\/20300507T030000Z&/);
  assert.match(launch.google, /location=Bear%20Creek%20Park/);
  const closed = r.entries.find((e) => e.title === 'Office closed');
  assert.match(closed.google, /&dates=20300530\/20300603(&|$)/, 'the day after the last, as calendars count');
  assert.deepEqual([closed.allDay, closed.day, closed.last_day], [true, '2030-05-30', '2030-06-02']);
  // An item running into the next month is in both.
  assert.ok(titles(await month(vol, '2030-06')).includes('Office closed'));
});

test('the month is the campaign’s own: its edges and its days are on the campaign’s clock', async () => {
  // 11:30 pm on May 31 in Vancouver is June 1 in UTC: it is May's.
  const late = await add({ title: 'Late call', day: '2030-05-31', start: '23:30', end: '23:59', who: 'everyone' });
  assert.ok(titles(await month(vol, '2030-05')).includes('Late call'));
  assert.ok(!titles(await month(vol, '2030-06')).includes('Late call'));
  assert.equal((await month(vol, '2030-05')).entries.find((e) => e.title === 'Late call').day, '2030-05-31');
  // A campaign in Toronto: the same typed time is another moment.
  await db.query(`update workspaces set settings = jsonb_set(coalesce(settings::jsonb, '{}'::jsonb), '{tz}', '"America/Toronto"') where id = $1`, [ws]);
  try {
    const t = await add({ title: 'Toronto call', day: '2030-05-06', start: '18:30', end: '19:00', who: 'managers' });
    assert.equal(new Date(t.starts_at).toISOString(), '2030-05-06T22:30:00.000Z');
    const r = await month(mgr, '2030-05');
    assert.equal(r.tz, 'America/Toronto');
    // Late call (May 31, 11:30 pm Vancouver) is June 1, 2:30 am in Toronto.
    assert.ok(!titles(r).includes('Late call'));
    assert.ok(titles(await month(mgr, '2030-06')).includes('Late call'));
    ok(await mgr.action('calendar.item.remove', { id: t.id }));
  } finally {
    await db.query(`update workspaces set settings = jsonb_set(settings::jsonb, '{tz}', '"America/Vancouver"') where id = $1`, [ws]);
  }
  ok(await mgr.action('calendar.item.remove', { id: late.id }));
  // No month asked: the campaign's this month.
  const now = await month(vol, '');
  assert.equal(now.month, todayOf({ workspace: { settings: { tz: 'America/Vancouver' } } }).slice(0, 7));
  assert.equal(now.today, todayOf({ workspace: { settings: { tz: 'America/Vancouver' } } }));
  assert.equal((await vol.get('/api/calendar?month=2030-13')).status, 400);
});

test('the calendar link carries what the person may see: their items and the public events, never anyone else’s', async () => {
  const volFeed = await feedOf(vol);
  const v = await fetchPath(volFeed);
  assert.equal(v.status, 200);
  const u = uids(v.body);
  for (const id of [I.all.id, I.team.id, I.days.id]) assert.ok(u.includes(`item-${id}@base.win`), id);
  for (const id of [I.cands.id, I.cleo.id, I.mgrs.id]) assert.ok(!u.includes(`item-${id}@base.win`), id);
  assert.ok(u.some((x) => /^shift-/.test(x)), 'the public event and their own shift');
  const body = unfold(v.body);
  assert.match(body, /SUMMARY:Campaign launch\r\nDTSTART:20300507T013000Z\r\nDTEND:20300507T030000Z\r\nLOCATION:Bear Creek Park/);
  assert.match(body, /SUMMARY:Office closed\r\nDTSTART;VALUE=DATE:20300530\r\nDTEND;VALUE=DATE:20300603/);
  assert.ok(!/Gate code|grp-|@example\.org|Numbers for Q3/.test(body), 'no instructions, addresses or other people’s notes');
  // The candidate's link: their seat's item, not another candidate's.
  const c = uids((await fetchPath(await feedOf(cand))).body);
  assert.ok(c.includes(`item-${I.cleo.id}@base.win`) && c.includes(`item-${I.cands.id}@base.win`));
  assert.ok(!uids((await fetchPath(await feedOf(cand2))).body).includes(`item-${I.cleo.id}@base.win`));
  // The manager's: every item, never every shift.
  const m = uids((await fetchPath(await feedOf(mgr))).body);
  assert.ok(m.includes(`item-${I.mgrs.id}@base.win`) && m.includes(`item-${I.cleo.id}@base.win`));
  const shiftsInAll = (await db.query('select count(*)::int as n from shifts where workspace_id = $1 and deleted_at is null', [ws])).rows[0].n;
  assert.ok(m.filter((x) => x.startsWith('shift-')).length < shiftsInAll, 'not the whole shift board');
});

test('changed and removed items change in the link; Make a new link: the old one is empty, the new one the same', async () => {
  const volFeed = await feedOf(vol);
  ok(await mgr.action('calendar.item.edit', { id: I.all.id, title: 'Campaign launch party', all_day: false, day: '2030-05-06', start: '19:00', end: '21:00', place: 'Bear Creek Park', who: 'everyone' }));
  let body = unfold((await fetchPath(volFeed)).body);
  assert.match(body, /SUMMARY:Campaign launch party\r\nDTSTART:20300507T020000Z/);
  ok(await mgr.action('calendar.item.edit', { id: I.team.id, title: 'Sign crew drive', all_day: false, day: '2030-05-11', start: '10:00', end: '14:00', who: 'managers' }));
  assert.ok(!uids((await fetchPath(volFeed)).body).includes(`item-${I.team.id}@base.win`), 'moved to managers: gone from the volunteer');
  ok(await mgr.action('calendar.item.remove', { id: I.days.id }));
  body = (await fetchPath(volFeed)).body;
  assert.ok(!uids(body).includes(`item-${I.days.id}@base.win`));
  assert.ok(!titles(await month(mgr, '2030-05')).includes('Office closed'), 'removed for everyone');
  const before0 = uids(body);
  const renewed = ok(await vol.action('calendar.feed.renew', {}));
  assert.deepEqual(uids((await fetchPath(volFeed)).body), [], 'the old link answers an empty calendar');
  assert.deepEqual(uids((await fetchPath(pathOf(renewed.feed.url))).body), before0);
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('a member taken off the campaign sees nothing; their link is empty', async () => {
  const feed = await feedOf(vol2);
  assert.ok(uids((await fetchPath(feed)).body).includes(`item-${I.all.id}@base.win`));
  ok(await mgr.action('member.remove', { user_id: vol2Id }));
  assert.deepEqual(uids((await fetchPath(feed)).body), []);
});


// ── Review fixes ──

test('an item past midnight: the day it ends is the next day; it is listed on the day it starts', async () => {
  // Election night, 8 pm to 1 am in Vancouver (UTC-7 in October): 03:00 to 08:00 UTC the next day.
  const night = await add({ title: 'Election night', day: '2030-10-19', end_day: '2030-10-20', start: '20:00', end: '01:00', who: 'everyone' });
  assert.equal(new Date(night.starts_at).toISOString(), '2030-10-20T03:00:00.000Z');
  assert.equal(new Date(night.ends_at).toISOString(), '2030-10-20T08:00:00.000Z');
  const e = (await month(vol, '2030-10')).entries.find((x) => x.title === 'Election night');
  assert.deepEqual([e.day, e.allDay, e.start, e.end], ['2030-10-19', false, '2030-10-20T03:00:00.000Z', '2030-10-20T08:00:00.000Z']);
  assert.match(e.google, /&dates=20301020T030000Z\/20301020T080000Z(&|$)/);
  // Ending at midnight is the next day's 00:00.
  const late = await add({ title: 'Count watch', day: '2030-10-19', end_day: '2030-10-20', start: '20:00', end: '00:00', who: 'managers' });
  assert.equal(new Date(late.ends_at).toISOString(), '2030-10-20T07:00:00.000Z');
  // Edit keeps it overnight.
  const moved = ok(await mgr.action('calendar.item.edit', { id: night.id, title: 'Election night', all_day: false, day: '2030-10-19', end_day: '2030-10-20', start: '21:00', end: '02:00', who: 'everyone' })).item;
  assert.equal(new Date(moved.ends_at).toISOString(), '2030-10-20T09:00:00.000Z');
  const bad = async (input, error) => {
    const r = await mgr.action('calendar.item.add', { title: 'Bad', all_day: false, day: '2030-10-19', start: '20:00', end: '01:00', who: 'everyone', ...input });
    assert.deepEqual([r.status, r.json.error], [400, error], JSON.stringify(input));
  };
  await bad({ end_day: '2030-10-18' }, 'It ends before it starts');
  await bad({ end_day: '2030-10-19' }, 'It ends before it starts');
  await bad({ end_day: '2030-13-01' }, 'Pick the day it ends');
  for (const id of [night.id, late.id]) ok(await mgr.action('calendar.item.remove', { id }));
});

test('an item for a team since deleted or a seat since removed: it says so, and Edit keeps who it was for', async () => {
  const doomed = ok(await mgr.action('team.create', { name: 'Doomed' })).team.id;
  const other0 = ok(await mgr.action('team.create', { name: 'Also gone' })).team.id;
  const gone = ok(await mgr.action('candidate.save', { name: 'Gone Example', office: 'Council' })).candidate.id;
  const t = await add({ title: 'Doomed huddle', day: '2030-07-02', start: '10:00', end: '11:00', who: `team:${doomed}` });
  const c = await add({ title: 'Gone’s interview', day: '2030-07-03', start: '10:00', end: '11:00', who: `candidate:${gone}` });
  ok(await mgr.action('team.delete', { id: doomed }));
  ok(await mgr.action('team.delete', { id: other0 }));
  ok(await mgr.action('candidate.remove', { id: gone }));
  const m = await month(mgr, '2030-07');
  const et = m.entries.find((e) => e.title === 'Doomed huddle');
  const ec = m.entries.find((e) => e.title === 'Gone’s interview');
  assert.deepEqual([et.who, et.value], ['Doomed (removed)', `team:${doomed}`]);
  assert.deepEqual([ec.who, ec.value], ['Gone Example (removed)', `candidate:${gone}`]);
  assert.ok(!m.who.some((w) => [et.value, ec.value].includes(w.value)), 'not offered for new items');
  // Edit: a new time, the same who — saved.
  const et2 = ok(await mgr.action('calendar.item.edit', { id: t.id, title: 'Doomed huddle', all_day: false, day: '2030-07-02', start: '12:00', end: '13:00', who: `team:${doomed}` })).item;
  assert.deepEqual([et2.who, et2.team_id], ['team', doomed]);
  const ec2 = ok(await mgr.action('calendar.item.edit', { id: c.id, title: 'Gone’s interview', all_day: false, day: '2030-07-03', start: '12:00', end: '13:00', who: `candidate:${gone}` })).item;
  assert.deepEqual([ec2.who, ec2.candidate_id], ['candidate', gone]);
  // Another gone team, or a gone team on a new item: still refused.
  for (const r of [
    await mgr.action('calendar.item.edit', { id: t.id, title: 'Doomed huddle', all_day: false, day: '2030-07-02', start: '12:00', end: '13:00', who: `team:${other0}` }),
    await mgr.action('calendar.item.add', { title: 'New', all_day: false, day: '2030-07-02', start: '12:00', end: '13:00', who: `team:${doomed}` }),
    await mgr.action('calendar.item.add', { title: 'New', all_day: false, day: '2030-07-02', start: '12:00', end: '13:00', who: `candidate:${gone}` }),
  ]) assert.deepEqual([r.status, r.json.error], [400, 'Pick who sees it from the list']);
  // Nobody else sees them.
  for (const x of [vol, staff, cand]) assert.deepEqual(titles(await month(x, '2030-07')), []);
  for (const id of [t.id, c.id]) ok(await mgr.action('calendar.item.remove', { id }));
});
