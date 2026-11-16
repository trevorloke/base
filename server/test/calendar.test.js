// Calendars (ext/calendar): a person's calendar link (their shifts, the
// voting days and — for the people who handle money — the filing dates),
// read again on every fetch with no cookie; "Make a new link", "Stop this
// link" and "Email me the link"; and the one-item files behind "Add to
// calendar", kept under a ticket for 10 minutes and 3 reads.
//
// The query plan of a link's shifts (content.js MY_SHIFTS_SQL) in a
// campaign of 20,000 people, 5,000 shifts and 20,000 bookings, as the plan
// test prints it (PGlite, after ANALYZE):
//   Limit → Sort (s.starts_at, s.id) → Nested Loop Left Join
//     → Nested Loop
//         → Nested Loop
//             → Index Scan using persons_ws_email_idx on persons p
//                 (workspace_id, lower(email))
//             → Index Scan using sassign_ws_person_idx on shift_assignments a
//                 (workspace_id, person_id = p.id)
//         → Index Scan using shifts_pkey on shifts s (id = a.shift_id)
//     → Index Scan using places_pkey on places pl (id = s.place_id)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { verifyChain } from '../lib/events.js';
import { runDueJobs } from '../lib/jobs.js';
import { startFakeMail } from './fake-mail.js';
import { _setTicketClockForTest } from '../ext/calendar/tickets.js';
import { MY_SHIFTS_SQL } from '../ext/calendar/content.js';

const tag = Math.random().toString(36).slice(2, 8);
const KEYS = ['MAIL_PROVIDER', 'MAIL_FROM', 'RESEND_API_KEY', 'RESEND_API_BASE', 'SENDGRID_API_KEY', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let db, mail, mgr, ws, vol, volId, vol2, treas, treasId, other;
const S = {};
let ipN = 0;
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const unfold = (s) => s.replace(/\r\n /g, '');
const uids = (ics) => [...unfold(ics).matchAll(/^UID:(.*)\r?$/gm)].map((m) => m[1]);
const events = (ics) => (ics.match(/BEGIN:VEVENT/g) || []).length;
// A fetch with no cookie at all, from its own address unless one is given.
const fetchPath = async (path, ip) => {
  ipN += 1;
  const res = await app.request(path, { headers: { 'x-real-ip': ip || `203.0.113.${ipN % 250}` } });
  return { status: res.status, headers: res.headers, body: await res.text() };
};
const pathOf = (url) => new URL(url).pathname;
const join = async (role, who) => {
  const inv = ok(await mgr.action('member.invite', { email: `cal-${who}+${tag}@example.org`, role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${who} Example`, password: 'calendar-pass-2026' }));
  return { client: c, id: j.user.id };
};
const shiftOn = async (day, start, end, extra = {}) => ok(await mgr.action('shift.createMany', {
  kind: 'burma_shave', location: 'King George Blvd & 88 Ave', days: [day], start, end, ...extra,
})).shifts[0];
const linkOf = async (c) => ok(await c.get('/api/calendar/feed')).feed;

before(async () => {
  db = await freshDb();
  for (const k of KEYS) delete process.env[k];
  mail = await startFakeMail({ provider: 'resend' });
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Calendar ${tag}`, email: `cal-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  ({ client: vol, id: volId } = await join('volunteer', 'Vik'));
  ({ client: vol2 } = await join('volunteer', 'Wren'));
  ({ client: treas, id: treasId } = await join('treasurer', 'Tess'));
  other = new Client();
  await other.signup({ workspaceName: `Elsewhere ${tag}`, email: `cal-other+${tag}@example.org` });
  // Shifts in 2030 (B.C. on UTC-7 by any copy of the rules).
  S.mine = await shiftOn('2030-05-06', '06:30', '08:30', { instructions: 'Door code 4411', link: 'https://example.org/wave' });
  S.declined = await shiftOn('2030-05-07', '06:30', '08:30');
  S.removed = await shiftOn('2030-05-08', '06:30', '08:30');
  S.calledOff = await shiftOn('2030-05-09', '06:30', '08:30');
  S.theirs = await shiftOn('2030-05-10', '06:30', '08:30');
  S.old = await shiftOn('2030-05-11', '06:30', '08:30');
  for (const k of ['mine', 'declined', 'removed', 'calledOff']) ok(await vol.action('shift.join', { shift_id: S[k].id }), k);
  ok(await vol2.action('shift.join', { shift_id: S.theirs.id }));
  ok(await vol.action('shift.leave', { shift_id: S.declined.id }));
  const removed = (await rows('select a.id from shift_assignments a join shifts s on s.id = a.shift_id where s.id = $1', [S.removed.id]))[0].id;
  ok(await mgr.action('shift.unassign', { id: removed }));
  ok(await mgr.action('shift.delete', { id: S.calledOff.id }));
  ok(await mgr.action('vote.settings', { on: false, election_day: '2030-10-19', advance_days: ['2030-10-09', '2030-10-14'] }));
  ok(await treas.action('filing.dates', { dates: [{ name: 'Disclosure statement due', due_on: '2031-01-17' }] }));
});
after(async () => {
  _setTicketClockForTest(null);
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await mail?.close?.();
});

test('Get my calendar link: made once; asked again it is the same link, with no second event', async () => {
  assert.equal(await linkOf(vol), null);
  const made = ok(await vol.action('calendar.feed.make', {}));
  assert.match(pathOf(made.feed.url), /^\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
  assert.equal(made.feed.webcal, made.feed.url.replace(/^http:/, 'webcal:'));
  assert.equal(made.feed.google, `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(made.feed.url)}`);
  const n = (await rows(`select count(*)::int as n from events where workspace_id = $1 and entity_type = 'calendar_feed'`, [ws]))[0].n;
  const again = ok(await vol.action('calendar.feed.make', {}));
  assert.equal(again.duplicate, true);
  assert.equal(again.feed.url, made.feed.url);
  assert.equal((await rows(`select count(*)::int as n from events where workspace_id = $1 and entity_type = 'calendar_feed'`, [ws]))[0].n, n, 'no event for the same link');
  assert.equal((await linkOf(vol)).url, made.feed.url);
  assert.equal(await linkOf(vol2), null, 'nobody sees another person’s link');
});

test('a volunteer’s link: only their own booked shifts, the voting days, no filing dates, no instructions', async () => {
  const r = await fetchPath(pathOf((await linkOf(vol)).url));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=300');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(uids(r.body), [`shift-${S.mine.id}@base.win`, 'vote-2030-10-09@base.win', 'vote-2030-10-14@base.win', 'vote-2030-10-19@base.win'],
    'not the one they can’t make, the one they were taken off, the one called off, or someone else’s');
  const body = unfold(r.body);
  assert.match(body, /X-WR-CALNAME:Calendar [a-z0-9]+ — my shifts/);
  assert.match(body, /REFRESH-INTERVAL;VALUE=DURATION:PT1H/);
  assert.match(body, /DTSTART:20300506T133000Z/);
  assert.match(body, /SUMMARY:Election day/);
  assert.match(body, /SUMMARY:Advance voting/);
  assert.ok(!/Instructions|Details|4411|example\.org\/wave/.test(body), 'no instructions or Details link in a calendar link');
  assert.ok(!/Disclosure/.test(body));
  assert.match(body, /Open in base\.win: http:\/\/localhost\/shifts\//, 'the field app’s copy of the shift');
});

test('a treasurer’s link has the filing dates — unless kept out of Donations; the desk’s link opens the desk', async () => {
  ok(await treas.action('calendar.feed.make', {}));
  const url = pathOf((await linkOf(treas)).url);
  const r = await fetchPath(url);
  assert.ok(uids(r.body).includes('filing-1-2031-01-17@base.win'));
  assert.match(unfold(r.body), /SUMMARY:Disclosure statement due\r\nDTSTART;VALUE=DATE:20310117\r\nDTEND;VALUE=DATE:20310118/);
  await db.query(`update memberships set permissions = '{"deny":["money"]}' where user_id = $1 and workspace_id = $2`, [treasId, ws]);
  try {
    const denied = await fetchPath(url);
    assert.ok(!uids(denied.body).some((u) => u.startsWith('filing-')), 'read again on every fetch');
    assert.ok(uids(denied.body).includes('vote-2030-10-19@base.win'));
  } finally {
    await db.query(`update memberships set permissions = '{}' where user_id = $1 and workspace_id = $2`, [treasId, ws]);
  }
  // A volunteer kept out of Shifts: no shifts, the voting days still.
  await db.query(`update memberships set permissions = '{"deny":["shifts"]}' where user_id = $1 and workspace_id = $2`, [volId, ws]);
  try {
    const v = await fetchPath(pathOf((await linkOf(vol)).url));
    assert.ok(!uids(v.body).some((u) => u.startsWith('shift-')));
  } finally {
    await db.query(`update memberships set permissions = '{}' where user_id = $1 and workspace_id = $2`, [volId, ws]);
  }
  // A candidate is a volunteer (ext/candidates keeps the role 'volunteer'):
  // what a volunteer gets, read through the Candidates row
  // (candidates.test.js has their link).
});

test('Make a new link: the old one answers an empty calendar; Stop this link: the same; unknown: not found', async () => {
  const before0 = await linkOf(vol);
  const renewed = ok(await vol.action('calendar.feed.renew', {}));
  assert.notEqual(renewed.feed.url, before0.url);
  const old = await fetchPath(pathOf(before0.url));
  assert.equal(old.status, 200);
  assert.equal(events(old.body), 0, 'an empty calendar clears what the app had');
  assert.match(old.body, /X-WR-CALNAME:/);
  assert.equal(events((await fetchPath(pathOf(renewed.feed.url))).body), 4);
  ok(await vol.action('calendar.feed.stop', {}));
  assert.equal(await linkOf(vol), null);
  assert.equal(events((await fetchPath(pathOf(renewed.feed.url))).body), 0);
  assert.equal((await vol.action('calendar.feed.stop', {})).status, 409, 'nothing to stop');
  const unknown = await fetchPath(`/cal/${'A'.repeat(43)}.ics`);
  assert.deepEqual([unknown.status, unknown.body], [404, 'Not found']);
  ok(await vol.action('calendar.feed.make', {}));
  // On the log: every write, never the token or an address.
  const ev = await rows(`select action, op, payload from events where workspace_id = $1 and entity_type = 'calendar_feed' order by seq`, [ws]);
  assert.deepEqual(ev.filter((e) => e.action === 'calendar.feed.renew').map((e) => e.op), ['void', 'create']);
  const tokens = (await rows('select token from calendar_feeds where workspace_id = $1', [ws])).map((t) => t.token);
  const logged = JSON.stringify(ev);
  assert.ok(tokens.every((t) => !logged.includes(t)) && !logged.includes('@'), 'no token or address on the log');
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('a member taken off the campaign: their link answers an empty calendar', async () => {
  const { client: gone, id: goneId } = await join('volunteer', 'Gus');
  ok(await gone.action('shift.join', { shift_id: S.old.id }));
  ok(await gone.action('calendar.feed.make', {}));
  const url = pathOf((await linkOf(gone)).url);
  assert.equal(events((await fetchPath(url)).body), 4);
  ok(await mgr.action('member.remove', { user_id: goneId }));
  const r = await fetchPath(url);
  assert.deepEqual([r.status, events(r.body)], [200, 0]);
});

test('routes: only <43 characters>.ics is a calendar link', async () => {
  const token = pathOf((await linkOf(vol)).url).slice(5, -4);
  assert.equal((await fetchPath(`/cal/${token}`)).status, 404);
  assert.equal((await fetchPath(`/cal/${token}.ics.ics`)).status, 404);
  assert.equal((await fetchPath(`/cal/${token}x.ics`)).status, 404);
  assert.equal((await fetchPath(`/cal/${token.slice(1)}.ics`)).status, 404);
  assert.equal((await fetchPath(`/cal/${token}.ICS`)).status, 404);
  const r = await fetchPath(`/cal/${token}`);
  assert.ok(!/<html/i.test(r.body), 'never the app’s page');
});

test('Email me the link: one job sends it, outside the write; 3 an hour; nothing pretends when email isn’t set up', async () => {
  ok(await vol2.action('calendar.feed.make', {}));
  // Email not connected: the read says so (the phone hides the button)…
  assert.equal(ok(await vol2.get('/api/calendar/feed')).canEmail, false);
  // …and the action is refused, nothing queued.
  const off = await vol2.action('calendar.feed.email', {});
  assert.equal(off.status, 409);
  assert.equal(off.json.error, 'Email isn’t set up for this campaign — use Copy link');
  assert.equal((await rows(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'calendar.feed.email'`, [ws]))[0].n, 0);
  Object.assign(process.env, { RESEND_API_KEY: 're_test_key', RESEND_API_BASE: mail.url, MAIL_FROM: 'Calendar Example <team@example.org>' });
  assert.equal(ok(await vol2.get('/api/calendar/feed')).canEmail, true);
  // No live link: refused.
  const { client: none } = await join('volunteer', 'Nia');
  assert.equal((await none.action('calendar.feed.email', {})).status, 409);
  const link = await linkOf(vol2);
  const sentBefore = mail.sent.length;
  ok(await vol2.action('calendar.feed.email', {}));
  const job = (await rows(`select id, payload from jobs where workspace_id = $1 and kind = 'calendar.feed.email'`, [ws]));
  assert.equal(job.length, 1);
  assert.equal(mail.sent.length, sentBefore, 'the tap sends nothing');
  assert.ok(!JSON.stringify(job[0].payload).includes(link.url.split('/cal/')[1].slice(0, -4)) && !JSON.stringify(job[0].payload).includes('@'), 'no token or address in the job');
  await runDueJobs(db, { workspaceId: ws });
  const m = mail.sent.slice(sentBefore);
  assert.equal(m.length, 1);
  assert.equal([].concat(m[0].to)[0], `cal-wren+${tag}@example.org`);
  assert.equal(m[0].subject, 'Your shifts in your calendar');
  assert.equal(m[0].key, `cal-email-${job[0].id}`);
  const text = typeof m[0].body === "string" ? JSON.parse(m[0].body).text : m[0].body.text;
  assert.match(text, /^Open Google Calendar on a computer\. Beside Other calendars, choose \+ then From URL\. Paste this link:\n\n/);
  assert.ok(text.includes(`\n\n${link.url}\n\n`), 'the https link');
  assert.match(text, /\n\n— Calendar [a-z0-9]+$/);
  ok(await vol2.action('calendar.feed.email', {}));
  ok(await vol2.action('calendar.feed.email', {}));
  const fourth = await vol2.action('calendar.feed.email', {});
  assert.deepEqual([fourth.status, fourth.json.error], [429, 'We just sent it — check your email']);
  for (const k of ['RESEND_API_KEY', 'RESEND_API_BASE', 'MAIL_FROM']) delete process.env[k];
});

test('the 121st fetch of a link in an hour is refused', async () => {
  const url = pathOf((await linkOf(treas)).url);
  for (let i = 0; i < 118; i += 1) assert.equal((await fetchPath(url)).status, 200); // 2 fetches already
  assert.equal((await fetchPath(url)).status, 429);
});

test('Add to calendar: the file link checks the reader, carries their own hours and the instructions, needs no cookie', async () => {
  // A booking's own hours (flexible shift hours, ext/schedule).
  await db.query(
    `update shift_assignments a set arrive_at = '2030-05-06T14:00:00Z', leave_at = '2030-05-06T15:00:00Z'
       from persons p where p.id = a.person_id and a.shift_id = $1 and lower(p.email) = $2`, [S.mine.id, `cal-vik+${tag}@example.org`]);
  try {
    const { url } = ok(await vol.get(`/api/calendar/shift/${S.mine.id}/link`));
    assert.match(pathOf(url), /^\/cal\/once\/[A-Za-z0-9_-]{22}\.ics$/);
    const r = await fetchPath(pathOf(url));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/calendar; charset=utf-8');
    assert.equal(r.headers.get('content-disposition'), 'inline; filename="burma-shave-king-george-blvd-88-ave.ics"');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    const body = unfold(r.body);
    assert.match(body, /DTSTART:20300506T140000Z/, 'their own hours');
    assert.match(body, /Your part: 7 – 8 a\.m\. of a 6:30 – 8:30 a\.m\. shift/);
    assert.match(body, /Instructions: Door code 4411/);
    assert.match(body, /Details: https:\/\/example\.org\/wave/);
    // 3 reads, then gone.
    assert.equal((await fetchPath(pathOf(url))).status, 200);
    assert.equal((await fetchPath(pathOf(url))).status, 200);
    const gone = await fetchPath(pathOf(url));
    assert.deepEqual([gone.status, gone.body], [404, 'This link has expired — tap Add to calendar again']);
  } finally {
    await db.query('update shift_assignments set arrive_at = null, leave_at = null where workspace_id = $1', [ws]);
  }
  // A desk reader: the whole shift, the desk's copy.
  const desk = await fetchPath(pathOf(ok(await mgr.get(`/api/calendar/shift/${S.mine.id}/link`)).url));
  assert.match(unfold(desk.body), /DTSTART:20300506T133000Z/);
  assert.match(unfold(desk.body), /Open in base\.win: http:\/\/localhost\/admin\/shifts\//);
  // Ten minutes on, a ticket is gone.
  const t0 = Date.now();
  const late = ok(await vol.get(`/api/calendar/shift/${S.mine.id}/link`)).url;
  _setTicketClockForTest(() => t0 + 10 * 60_000 + 1000);
  try {
    assert.equal((await fetchPath(pathOf(late))).status, 404);
  } finally {
    _setTicketClockForTest(null);
  }
  // Each kind's refusals.
  assert.equal((await vol.get(`/api/calendar/shift/${S.calledOff.id}/link`)).status, 404, 'called off');
  assert.equal((await other.get(`/api/calendar/shift/${S.mine.id}/link`)).status, 404, 'another campaign');
  assert.equal((await vol.get('/api/calendar/shift/not-an-id/link')).status, 404);
  await db.query(`update memberships set permissions = '{"deny":["shifts"]}' where user_id = $1 and workspace_id = $2`, [volId, ws]);
  try {
    assert.equal((await vol.get(`/api/calendar/shift/${S.mine.id}/link`)).status, 403);
  } finally {
    await db.query(`update memberships set permissions = '{}' where user_id = $1 and workspace_id = $2`, [volId, ws]);
  }
  assert.equal((await vol.get('/api/calendar/filing/1/link')).status, 403, 'a volunteer has no filing dates');
  assert.equal((await treas.get('/api/calendar/filing/2/link')).status, 404, 'no second date');
  const filing = await fetchPath(pathOf(ok(await treas.get('/api/calendar/filing/1/link')).url));
  assert.deepEqual(uids(filing.body), ['filing-1-2031-01-17@base.win']);
  await db.query(`update memberships set permissions = '{"deny":["money"]}' where user_id = $1 and workspace_id = $2`, [treasId, ws]);
  try {
    assert.equal((await treas.get('/api/calendar/filing/1/link')).status, 403, 'kept out of Donations');
  } finally {
    await db.query(`update memberships set permissions = '{}' where user_id = $1 and workspace_id = $2`, [treasId, ws]);
  }
  const vote = await fetchPath(pathOf(ok(await vol.get('/api/calendar/vote/all/link')).url));
  assert.deepEqual(uids(vote.body), ['vote-2030-10-09@base.win', 'vote-2030-10-14@base.win', 'vote-2030-10-19@base.win']);
  assert.match(unfold(vote.body), /DTSTART;VALUE=DATE:20301019\r\nDTEND;VALUE=DATE:20301020/);
  assert.equal((await other.get('/api/calendar/vote/all/link')).status, 404, 'no voting days set');
  assert.equal((await vol.get('/api/calendar/vote/1/link')).status, 404);
  assert.equal((await vol.get('/api/calendar/nothing/1/link')).status, 404);
  assert.equal((await fetchPath(`/cal/once/${'B'.repeat(22)}.ics`)).status, 404);
});

test('the link’s shifts are read through the email index and the person index, never a scan of shifts', async () => {
  // A campaign at size: 20,000 people, 5,000 shifts, 20,000 bookings.
  await db.query(`insert into persons (id, workspace_id, kind, name, email)
    select gen_random_uuid(), $1, 'person', 'Bulk Example ' || g, 'bulk' || g || '@example.org' from generate_series(1, 20000) g`, [ws]);
  await db.query(`insert into shifts (id, workspace_id, title, starts_at, ends_at)
    select gen_random_uuid(), $1, 'Bulk shift ' || g, now() + (g || ' hours')::interval, now() + (g + 2 || ' hours')::interval from generate_series(1, 5000) g`, [ws]);
  await db.query(`insert into shift_assignments (id, workspace_id, shift_id, person_id, status)
    select gen_random_uuid(), $1, s.id, p.id, 'confirmed'
      from (select id, row_number() over (order by id) as n from shifts where workspace_id = $1 and title like 'Bulk shift %') s
      join (select id, row_number() over (order by id) as n from persons where workspace_id = $1 and name like 'Bulk Example %') p on p.n % 5000 = s.n % 5000`, [ws]);
  await db.query('analyze persons'); await db.query('analyze shifts'); await db.query('analyze shift_assignments');
  const plan = (await db.query(`explain ${MY_SHIFTS_SQL}`, [ws, `cal-vik+${tag}@example.org`, ['assigned', 'confirmed', 'completed']]))
    .rows.map((r) => r['QUERY PLAN']).join('\n');
  console.log(plan.split('\n').map((l) => `# ${l}`).join('\n'));
  // (or the person search's prefix index on the same lower(email), when the planner prefers it)
  assert.match(plan, /persons_ws_email_(prefix_)?idx/);
  assert.match(plan, /sassign_ws_person_idx/);
  assert.ok(!/Seq Scan on shifts/.test(plan));
  // Each matched person drives their own bookings (a Postgres 16 at 300,000
  // people hashed every booking when the planner guessed 1,500 matches).
  assert.ok(!/Seq Scan on shift_assignments|Hash Join/.test(plan), 'never every booking');
  assert.match(plan, /Index Cond: \(\(workspace_id = .+\) AND \(person_id = p\.id\)\)/);
  await db.query(`delete from shift_assignments a using shifts s where s.id = a.shift_id and s.workspace_id = $1 and s.title like 'Bulk shift %'`, [ws]);
  await db.query(`delete from shifts where workspace_id = $1 and title like 'Bulk shift %'`, [ws]);
  await db.query(`delete from persons where workspace_id = $1 and name like 'Bulk Example %'`, [ws]);
});

test('the export leaves the link’s token out', async () => {
  const { exportTables } = await import('../ext/calendar/index.js');
  assert.deepEqual(exportTables, [{ table: 'calendar_feeds', omit: ['token'] }]);
});

test('the website: events.ics lists the public upcoming events and nothing private; one event by id; only where the site lists them', async () => {
  ok(await mgr.get('/api/site')); // the campaign's website, as first opened
  const picnic = ok(await mgr.action('shift.createMany', {
    kind: 'event', location: 'Bear Creek Park', days: ['2030-06-01'], start: '11:00', end: '14:00', name: 'Family picnic', public: true, instructions: 'Gate code 2299',
  })).shifts[0];
  const wave = await shiftOn('2030-06-02', '06:30', '08:30', { public: true });
  const quiet = ok(await mgr.action('shift.createMany', { kind: 'event', location: 'Back room', days: ['2030-06-03'], start: '19:00', end: '21:00', name: 'Board meeting' })).shifts[0];
  const all = await fetchPath('/site/events.ics');
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(all.headers.get('cache-control'), 'public, max-age=600');
  assert.deepEqual(uids(all.body), [`shift-${picnic.id}@base.win`], 'the Events list only: not an opening, not a private shift');
  const body = unfold(all.body);
  assert.match(body, /X-WR-CALNAME:.+ events\r\n/);
  assert.match(body, /DTSTART:20300601T180000Z\r\nDTEND:20300601T210000Z/);
  assert.match(body, /LOCATION:Bear Creek Park/);
  assert.ok(!/Gate code|Instructions|Details/.test(body), 'never the instructions');
  assert.match(body, /\\n[^\r\n]+ — http:\/\/localhost\/site\r\nURL:http:\/\/localhost\/site\/\r\n/, 'it ends with the campaign and its site; it links the page');
  const one = await fetchPath(`/site/events/${wave.id}.ics`);
  assert.equal(one.status, 200, 'one from the openings too');
  assert.deepEqual(uids(one.body), [`shift-${wave.id}@base.win`]);
  assert.equal(one.headers.get('content-disposition'), 'inline; filename="burma-shave-king-george-blvd-88-ave.ics"');
  assert.equal((await fetchPath(`/site/events/${quiet.id}.ics`)).status, 404, 'a private shift');
  assert.equal((await fetchPath(`/site/events/${'0'.repeat(36)}.ics`)).status, 404);
  const page = await fetchPath(`/site/events/${picnic.id}`);
  assert.ok(!/^text\/calendar/.test(page.headers.get('content-type') || ''), 'no .ics: not a calendar');
  // Signed up with no JavaScript: the page comes back naming the event, and
  // says how to put it in a calendar under "You’re signed up".
  const home = (await rows(`select id, published from site_pages where workspace_id = $1 and published is not null`, [ws]))
    .map((r) => ({ id: r.id, mods: (typeof r.published === 'string' ? JSON.parse(r.published) : r.published).modules || [] }))
    .find((r) => r.mods.some((m) => m.kind === 'events'));
  const evMod = home.mods.find((m) => m.kind === 'events').id;
  const posted = await app.request('/site/api/forms/rsvp', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': '198.51.100.77' },
    body: new URLSearchParams({ first_name: 'Rae', email: `cal-rae+${tag}@example.org`, shift_id: picnic.id, page_id: home.id, module_id: evMod }).toString(),
  });
  assert.equal(posted.status, 303, await posted.text());
  const back = posted.headers.get('location');
  assert.match(back, new RegExp(`\\?sent=rsvp&shift=${picnic.id}#m-${evMod}$`));
  const after = (await fetchPath(back.replace(/#.*$/, ''))).body;
  const done = /<p class="rsvp-done rsvp-done--page"[\s\S]*?<\/p>\s*<p class="rsvp-cal">([\s\S]*?)<\/p>/.exec(after);
  assert.ok(done, 'Add it to your calendar, under the page’s own “You’re signed up”');
  assert.match(done[1], /Add it to your calendar:/);
  assert.match(done[1], /href="https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&amp;text=Family(%20|\+)picnic/);
  assert.match(done[1], new RegExp(`href="/site/events/${picnic.id}\\.ics"`));
  // A shift that is not this module's: no line, rather than the wrong one.
  const odd = (await fetchPath(back.replace(/#.*$/, '').replace(picnic.id, quiet.id))).body;
  assert.match(odd, /rsvp-done--page/);
  assert.ok(!/class="rsvp-cal"/.test(odd.slice(odd.indexOf('rsvp-done--page'), odd.indexOf('rsvp-done--page') + 800)));
  // A site whose published pages list no events or openings: both are its 404.
  await db.query(
    `update site_pages set published = jsonb_set(published, '{modules}', coalesce((select jsonb_agg(m) from jsonb_array_elements(published->'modules') m
        where m->>'kind' not in ('events', 'shifts')), '[]'::jsonb))
      where workspace_id = $1 and jsonb_typeof(published->'modules') = 'array'`, [ws]);
  assert.equal((await fetchPath('/site/events.ics')).status, 404);
  assert.equal((await fetchPath(`/site/events/${picnic.id}.ics`)).status, 404);
});
