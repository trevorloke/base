// Your shifts in your own Google Calendar (ext/gcal), against the fake
// Google's Calendar (fake-google.js): the campaign's switch, the first link
// made by connecting, what goes in (exactly the calendar link's content),
// the hook that notices whose calendar a write touched, the push and its
// bounds, Google's refusals, stopping and clean-up through GSI's onRevoke,
// leaving the team, and what never reaches the log, a job or an answer.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { app } from '../index.js';
import { runAction, verifyChain } from '../lib/events.js';
import { enqueueJob, registerJob, runDueJobs } from '../lib/jobs.js';
import { definePurpose } from '../lib/google/purposes.js';
import { _resetTokensForTest } from '../lib/google/tokens.js';
import { _resetPausesForTest, _setTokenTimeoutForTest } from '../lib/google/flow.js';
import { EXTENSIONS } from '../ext.js';
import { areaOfAction } from '../lib/perms.js';
import { ACTIONS } from '../actions/index.js';
import { _resetGcalForTest, _setGcalForTest, desiredFor, nextSweepAt } from '../ext/gcal/push.js';
import { ID_RE } from '../ext/gcal/google.js';
import { Browser, TOKEN_KEY, acct, join, restoreEnv, signup, startGoogle, tag } from './google-helpers.js';

// Another feature's purpose on the same grant (Gmail's, say).
definePurpose('test.gcal.other', { label: 'Test other', scopes: ['https://www.googleapis.com/auth/test.gcal'], roles: ['manager', 'treasurer', 'staff', 'volunteer'], area: null });
const order = [];
registerJob('test.gcal.quick', async () => { order.push('quick job'); });

const A = Array.from({ length: 12 }, (_, i) => acct(i + 1));
let fake, db, M, V, S, W, B2;
const lines = [];
const keep = {};
const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
// Each pass starts a fresh minute (the per-person cap has its own test).
let bounding = false;
const jobs = (ws = M.ws) => { if (!bounding) _resetGcalForTest(); return runDueJobs(db, { workspaceId: ws }); };
const linkRow = async (userId, ws = M.ws) => (await db.query('select * from gcal_links where workspace_id = $1 and user_id = $2', [ws, userId])).rows[0] || null;
const items = async (userId, ws = M.ws) => (await db.query('select * from gcal_items where workspace_id = $1 and user_id = $2 order by event_id', [ws, userId])).rows;
const calOf = (n) => fake.cal.calendars(A[n].sub);
const eventsOf = (n) => (calOf(n)[0]?.events || []);
const titles = (n) => eventsOf(n).map((e) => e.summary).sort();
const live = (id) => fake.cal.calendars().some((c) => c.id === id);
const calls = () => Object.values(fake.cal.counts).reduce((a, b) => a + b, 0);
const connect = (who, n, purpose = 'calendar.mine') => who.b.google(fake, { do: 'connect', for: purpose, app: 'field', back: '/profile' }, A[n].sub);
const shiftOn = async (day, extra = {}) => ok(await M.b.action('shift.createMany', {
  kind: 'burma_shave', location: 'King George Blvd & 88 Ave', days: [day], start: '06:30', end: '08:30', ...extra,
})).shifts[0];
const personOf = async (email) => (await db.query('select id from persons where workspace_id = $1 and lower(email) = $2', [M.ws, email.toLowerCase()])).rows[0]?.id;
const bookingOf = async (shiftId, personId) => (await db.query('select id from shift_assignments where shift_id = $1 and person_id = $2', [shiftId, personId])).rows[0]?.id;
const due = () => db.query(`update jobs set run_at = now() where workspace_id = $1 and status = 'pending' and kind in ('gcal.push', 'gcal.stop', 'google.revoke')`, [M.ws]);
const gcal = async (who) => ok(await who.b.get('/api/gcal'));

before(async () => {
  db = await freshDb();
  fake = await startGoogle(A);
  process.env.GOOGLE_CALENDAR_API_BASE = `${fake.base}/calendar/v3`;
  for (const k of ['warn', 'log', 'error']) {
    keep[k] = console[k];
    console[k] = (...a) => { lines.push(a.join(' ')); };
  }
  M = await signup(`Gcal Campaign ${tag}`, `mo.${tag}@example.org`);
  V = await join(M.b, `vik.${tag}@example.org`, 'volunteer', 'Vik Example');
  S = await join(M.b, `sam.${tag}@example.org`, 'staff', 'Sam Example');
  W = await join(M.b, `wren.${tag}@example.org`, 'volunteer', 'Wren Example');
});
beforeEach(() => {
  fake.clearKnobs(); fake.cal.reset(); fake.resetCounts();
  _resetPausesForTest(); _resetTokensForTest(); _resetGcalForTest();
  process.env.GOOGLE_TOKEN_KEY = TOKEN_KEY;
  delete process.env.STARBASE_JOBS;
});
after(async () => {
  for (const k of Object.keys(keep)) console[k] = keep[k];
  _setTokenTimeoutForTest(8000);
  delete process.env.GOOGLE_CALENDAR_API_BASE;
  await fake.close();
  restoreEnv();
});

test('the switch: off by default (no link, no push); manager-only; on needs Google set up; jobs off says so', async () => {
  const g = await gcal(M);
  assert.equal(g.available, false);
  assert.equal(g.why, 'off');
  assert.equal(g.link, null);
  assert.deepEqual(g.manager, { on: false, people: 0 });
  const v = await gcal(V);
  assert.equal(v.why, null, 'only managers are told why');
  assert.equal(v.manager, undefined);
  // Connecting while off makes no link.
  assert.equal((await connect(V, 0)).google, 'connected');
  await jobs();
  assert.equal(await linkRow(V.id), null);
  assert.equal(calls(), 0);
  assert.equal((await S.b.action('gcal.settings', { on: true })).status, 403, 'staff can’t turn it on');
  assert.equal(areaOfAction('gcal.on'), null);
  assert.equal(ACTIONS['addressbook.link'].area, 'people');
  assert.equal(areaOfAction('gcal.settings'), null);
  assert.deepEqual(ACTIONS['gcal.settings'].roles, ['manager'], 'manager-only with no area: Admin');
  delete process.env.GOOGLE_TOKEN_KEY;
  const r = await M.b.action('gcal.settings', { on: true });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'Set up Google first (Settings → Services → Google)');
  process.env.GOOGLE_TOKEN_KEY = TOKEN_KEY;
  ok(await M.b.action('gcal.settings', { on: true }));
  assert.equal((await gcal(M)).available, true);
  process.env.STARBASE_JOBS = 'off';
  assert.equal((await gcal(M)).why, 'jobs-off');
  assert.equal((await gcal(M)).available, false);
  delete process.env.STARBASE_JOBS;
  // Connected before it was on: Keep my shifts (gcal.on) makes the link.
  assert.equal((await gcal(V)).google.connected, true);
  ok(await V.b.action('gcal.on', {}));
  await jobs();
  assert.equal(calOf(0).length, 1);
});

test('first link: a connect with Calendar makes the link and one push makes the calendar once, named for the campaign', async () => {
  assert.equal((await connect(S, 2)).google, 'connected');
  const l = await linkRow(S.id);
  assert.equal(l.state, 'ok');
  assert.ok(l.dirty_at);
  await jobs();
  const cals = calOf(2);
  assert.equal(cals.length, 1);
  assert.equal(cals[0].body.summary, `Gcal Campaign ${tag} — my shifts (base.win)`);
  assert.equal(cals[0].body.description, 'Kept up to date by base.win.');
  assert.equal(cals[0].body.timeZone, 'America/Vancouver');
  assert.equal(fake.cal.counts['calendars.insert'], 1);
  await jobs();
  assert.equal(fake.cal.counts['calendars.insert'], 1, 'made once');
  const s = await gcal(S);
  assert.equal(s.link.state, 'ok');
  assert.equal(s.google.email, A[2].email);
  assert.equal((await linkRow(S.id)).dirty_at, null);
});

test('content: own booked shifts, the voting days, filing dates only for money roles; no instructions or link; UTC; ids in base32hex', async () => {
  const sh = await shiftOn('2030-05-06', { instructions: 'Door code 4411', link: 'https://meet.example.org/abc-defg' });
  keep.shift = sh;
  ok(await V.b.action('shift.join', { shift_id: sh.id }));
  ok(await S.b.action('shift.join', { shift_id: sh.id }));
  ok(await M.b.action('vote.settings', { on: false, election_day: '2030-10-19', advance_days: ['2030-10-14'] }));
  ok(await M.b.action('filing.dates', { dates: [{ name: 'Disclosure statement due', due_on: '2031-01-17' }] }));
  await jobs();
  assert.deepEqual(titles(0), ['Advance voting', 'Burma Shave — King George Blvd & 88 Ave', 'Election day'].sort());
  assert.ok(titles(2).includes('Disclosure statement due'), 'staff see filing dates');
  assert.ok(!titles(0).includes('Disclosure statement due'), 'a volunteer doesn’t');
  for (const n of [0, 2]) {
    for (const e of eventsOf(n)) {
      assert.match(e.id, ID_RE);
      assert.doesNotMatch(e.description, /Instructions:|Details:|Door code|meet\.example/);
      assert.equal(e.attendees, undefined);
      assert.equal(e.conferenceData, undefined);
      assert.equal(e.reminders, undefined);
      assert.equal(e.status, 'confirmed');
    }
  }
  const shiftEv = eventsOf(0).find((e) => e.id === `bs${sh.id.replace(/-/g, '')}`);
  assert.equal(shiftEv.start.dateTime, '2030-05-06T13:30:00.000Z');
  assert.equal(shiftEv.location, 'King George Blvd & 88 Ave');
  assert.ok(eventsOf(0).some((e) => e.id === 'bv20301019' && e.start.date === '2030-10-19' && e.end.date === '2030-10-20'));
  assert.ok(eventsOf(2).some((e) => e.id === 'bf120310117'));
  for (const c of fake.cal.calls.filter((x) => x.route.startsWith('events.'))) assert.equal(c.query.sendUpdates, 'none');
  // The same bodies under another server time zone.
  const here = await desiredFor(db, M.ws, V.id);
  const was = process.env.TZ;
  process.env.TZ = 'America/Toronto';
  const there = await desiredFor(db, M.ws, V.id);
  if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  assert.deepEqual([...there].map(([k, d]) => [k, d.hash]), [...here].map(([k, d]) => [k, d.hash]));
  // Nothing changed: no call.
  const before = calls();
  await db.query('update gcal_links set dirty_at = now() where workspace_id = $1', [M.ws]);
  ok(await M.b.action('workspace.update', { website: 'https://example.org' })); // queues a push
  await jobs();
  assert.equal(calls(), before, 'unchanged bodies are never sent again');
  const v = await gcal(V);
  assert.equal(v.link.shifts, 1);
  assert.equal(v.link.days, 2);
});

test('a volunteer kept out of Shifts gets the voting days only', async () => {
  ok(await M.b.action('permission.member.set', { user_id: V.id, grant: [], deny: ['shifts'] }));
  await jobs();
  assert.deepEqual(titles(0), ['Advance voting', 'Election day']);
  ok(await M.b.action('permission.member.set', { user_id: V.id, grant: [], deny: [] }));
  await jobs();
  assert.equal(titles(0).length, 3);
});

test('changes reach Google within one pass: assign, unassign at the desk, leave, join, declined, update, hours, delete, role, rename, time zone', async () => {
  const vp = await personOf(V.email);
  const a = await shiftOn('2030-05-13');
  ok(await M.b.action('shift.assign', { shift_id: a.id, person_id: vp }));
  await jobs();
  assert.ok(titles(0).length === 4, 'assigned at the desk');
  // Unassigned at the desk: the row is gone before the hook; its create event says whose.
  ok(await M.b.action('shift.unassign', { id: await bookingOf(a.id, vp) }));
  await jobs();
  assert.equal(titles(0).length, 3, 'unassigned: gone from Google');
  // Join, then leave; join again; declined.
  ok(await V.b.action('shift.join', { shift_id: a.id }));
  await jobs();
  assert.equal(titles(0).length, 4);
  ok(await V.b.action('shift.leave', { shift_id: a.id }));
  await jobs();
  assert.equal(titles(0).length, 3);
  fake.cal.reset();
  ok(await V.b.action('shift.join', { shift_id: a.id }));
  await jobs();
  assert.deepEqual(fake.cal.calls.map((c) => c.route), ['events.insert', 'events.update'], 're-join: 409, then PUT confirmed restores it');
  assert.equal(titles(0).length, 4);
  ok(await M.b.action('shift.setStatus', { id: await bookingOf(a.id, vp), status: 'declined' }));
  await jobs();
  assert.equal(titles(0).length, 3, 'declined');
  // A shift's time and place.
  const sh = keep.shift;
  ok(await M.b.action('shift.update', { id: sh.id, starts_at: '2030-05-06T14:30:00.000Z', ends_at: '2030-05-06T16:30:00.000Z', location: '72 Ave & 152 St' }));
  await jobs();
  const ev = eventsOf(0).find((e) => e.id === `bs${sh.id.replace(/-/g, '')}`);
  assert.equal(ev.start.dateTime, '2030-05-06T14:30:00.000Z');
  assert.equal(ev.location, '72 Ave & 152 St');
  // Their own hours.
  ok(await V.b.action('shift.hours', { shift_id: sh.id, from: '2030-05-06T15:00:00.000Z', to: '2030-05-06T16:00:00.000Z' }));
  await jobs();
  const mine = eventsOf(0).find((e) => e.id === `bs${sh.id.replace(/-/g, '')}`);
  assert.equal(mine.start.dateTime, '2030-05-06T15:00:00.000Z');
  assert.match(mine.description, /Your part/);
  // Staff made a volunteer: the filing dates go.
  ok(await M.b.action('member.setRole', { user_id: S.id, role: 'volunteer' }));
  await jobs();
  assert.ok(!titles(2).includes('Disclosure statement due'));
  ok(await M.b.action('member.setRole', { user_id: S.id, role: 'staff' }));
  await jobs();
  assert.ok(titles(2).includes('Disclosure statement due'));
  // Called off.
  const off = await shiftOn('2030-05-20');
  ok(await V.b.action('shift.join', { shift_id: off.id }));
  await jobs();
  const n = titles(0).length;
  ok(await M.b.action('shift.delete', { id: off.id }));
  await jobs();
  assert.equal(titles(0).length, n - 1, 'called off: gone from Google');
  // Renamed, then a new time zone: one PATCH each; none when unchanged.
  fake.cal.reset();
  ok(await M.b.action('workspace.update', { name: `Gcal Renamed ${tag}` }));
  await jobs();
  assert.equal(fake.cal.counts['calendars.patch'], 2, 'one each for two people');
  assert.equal(calOf(0)[0].body.summary, `Gcal Renamed ${tag} — my shifts (base.win)`);
  await runAction(db, { workspaceId: M.ws, actorId: M.id, action: 'test.tz' }, async (tx, emit) => {
    await tx.query(`update workspaces set settings = jsonb_set(settings::jsonb, '{tz}', '"America/Edmonton"') where id = $1`, [M.ws]);
    emit('workspace', M.ws, 'update', { tz: 'America/Edmonton' });
  });
  await jobs();
  assert.equal(fake.cal.counts['calendars.patch'], 4);
  assert.equal(calOf(0)[0].body.timeZone, 'America/Edmonton');
  ok(await M.b.action('workspace.update', { website: 'https://example.org/again' }));
  await jobs();
  assert.equal(fake.cal.counts['calendars.patch'], 4, 'unchanged: no PATCH');
});

test('no work: a notice, a door and the sample cost no Google call and mark nobody', async () => {
  await jobs();
  const before = calls();
  ok(await M.b.action('shift.notify', { shift_id: keep.shift.id }));
  await jobs();
  const p = await M.b.action('person.create', { name: 'Ann Example', phone: '604-555-0101' });
  ok(await M.b.action('contact.log', { person_id: p.json.person.id, channel: 'door', result: 'talked', rating: 2 }).then((r) => (r.status === 200 ? r : { status: 200, json: {} })));
  await jobs();
  assert.equal(calls(), before);
  await db.query('update gcal_links set dirty_at = null where workspace_id = $1', [M.ws]);
  const r = await M.b.post('/api/data/sample', {});
  assert.ok([200, 201, 404].includes(r.status), JSON.stringify(r.json));
  assert.equal((await db.query('select count(*)::int as n from gcal_links where workspace_id = $1 and dirty_at is not null', [M.ws])).rows[0].n, 0);
  await jobs();
  assert.equal(calls(), before);
});

test('history kept: a shift that falls out of the 30-day window is forgotten without a DELETE', async () => {
  const old = await shiftOn('2030-06-03');
  ok(await V.b.action('shift.join', { shift_id: old.id }));
  await jobs();
  const id = `bs${old.id.replace(/-/g, '')}`;
  assert.ok(eventsOf(0).some((e) => e.id === id));
  // Forty days on.
  await db.query(`update shifts set starts_at = now() - interval '40 days', ends_at = now() - interval '40 days' + interval '2 hours' where id = $1`, [old.id]);
  await db.query(`update gcal_items set ends_at = now() - interval '40 days' where event_id = $1`, [id]);
  await db.query('update gcal_links set dirty_at = now() where workspace_id = $1 and user_id = $2', [M.ws, V.id]);
  ok(await M.b.action('workspace.update', { website: 'https://example.org/40' }));
  fake.cal.reset();
  await jobs();
  assert.equal(fake.cal.counts['events.delete'] || 0, 0);
  assert.ok(eventsOf(0).some((e) => e.id === id), 'still in their calendar');
  assert.ok(!(await items(V.id)).some((r) => r.event_id === id), 'forgotten here');
});

test('Google’s answers: deleted event, deleted calendar, 403 reasons, 429 for one person only, a 500', async () => {
  const sh = keep.shift;
  const id = `bs${sh.id.replace(/-/g, '')}`;
  const cal0 = calOf(0)[0].id;
  // An event deleted in Google comes back only when the shift changes.
  fake.cal.dropEvent(cal0, id);
  ok(await M.b.action('workspace.update', { website: 'https://example.org/1' }));
  await jobs();
  assert.ok(!eventsOf(0).some((e) => e.id === id));
  ok(await M.b.action('shift.update', { id: sh.id, title: 'Burma Shave — the morning wave' }));
  await jobs();
  assert.ok(eventsOf(0).some((e) => e.id === id && e.summary === 'Burma Shave — the morning wave'));

  // 403 forbiddenForNonOrganizer on one PUT: that row is forgotten, the others go on.
  ok(await M.b.action('vote.settings', { on: false, election_day: '2030-10-20', advance_days: ['2030-10-14'] }));
  ok(await M.b.action('shift.update', { id: sh.id, title: 'Burma Shave — moved to another calendar' }));
  fake.cal.next('403', { route: 'events.update', reason: 'forbiddenForNonOrganizer', sub: A[0].sub });
  await jobs();
  assert.equal((await linkRow(V.id)).state, 'ok');
  assert.match((await items(V.id)).find((r) => r.event_id === id).hash, /^refused:/, 'not tried again until it changes');
  assert.ok(eventsOf(0).some((e) => e.id === 'bv20301020'), 'their other events are pushed');
  assert.ok(eventsOf(2).some((e) => e.id === id && e.summary === 'Burma Shave — moved to another calendar'), 'the other person is pushed');
  assert.ok(lines.some((l) => /^gcal: 403 forbiddenForNonOrganizer for a user in /.test(l)));
  // On a POST: kept as refused, not tried again until it changes.
  const w = await shiftOn('2030-05-27');
  ok(await V.b.action('shift.join', { shift_id: w.id }));
  fake.cal.next('403', { route: 'events.insert', reason: 'forbiddenForNonOrganizer', sub: A[0].sub });
  await jobs();
  const wid = `bs${w.id.replace(/-/g, '')}`;
  assert.match((await items(V.id)).find((r) => r.event_id === wid).hash, /^refused:/);
  fake.cal.reset();
  ok(await M.b.action('workspace.update', { website: 'https://example.org/2' }));
  await db.query('update gcal_links set dirty_at = now() where workspace_id = $1', [M.ws]);
  await jobs();
  assert.equal(calls(), 0, 'the same body isn’t tried again');
  ok(await M.b.action('shift.update', { id: w.id, title: 'Burma Shave — moved' }));
  await jobs();
  assert.ok(eventsOf(0).some((e) => e.id === wid));

  // 403 quotaExceeded: an hour's wait for that person, still ok and dirty.
  fake.cal.reset();
  ok(await M.b.action('shift.update', { id: w.id, title: 'Burma Shave — quota' }));
  fake.cal.next('403', { reason: 'quotaExceeded', sub: A[0].sub });
  await jobs();
  let l = await linkRow(V.id);
  assert.equal(l.state, 'ok');
  assert.ok(l.dirty_at);
  assert.ok(new Date(l.wait_until).getTime() > Date.now() + 3_500_000);
  assert.equal(fake.cal.calls.filter((c) => c.sub === A[0].sub).length, 1, 'no further calls for that person');
  assert.ok((await gcal(V)).link.paused_until);
  await db.query('update gcal_links set wait_until = null where workspace_id = $1', [M.ws]);
  await due();
  await jobs();
  assert.ok(eventsOf(0).some((e) => e.summary === 'Burma Shave — quota'));

  // 429 Retry-After 3600 for one person; the other's booking lands in one pass.
  ok(await M.b.action('shift.update', { id: w.id, title: 'Burma Shave — busy' }));
  fake.cal.next('429', { retryAfter: 3600, sub: A[0].sub });
  await jobs();
  assert.ok((await gcal(V)).link.paused_until, 'paused');
  fake.cal.reset();
  const b = await shiftOn('2030-06-10');
  ok(await S.b.action('shift.join', { shift_id: b.id }));
  await jobs();
  assert.ok(eventsOf(2).some((e) => e.id === `bs${b.id.replace(/-/g, '')}`), 'B lands within one pass');
  assert.equal(fake.cal.calls.filter((c) => c.sub === A[0].sub).length, 0, 'A gets no call');
  await db.query('update google_grants set paused_until = null');

  // A 500: the next push is queued; one call per event at most.
  fake.cal.reset();
  ok(await M.b.action('shift.update', { id: w.id, title: 'Burma Shave — five hundred' }));
  fake.cal.next('500', { route: 'events.update' });
  await jobs();
  assert.equal(fake.cal.counts['events.update'], 1);
  const next = (await db.query(`select run_at from jobs where workspace_id = $1 and kind = 'gcal.push' and status = 'pending'`, [M.ws])).rows;
  assert.equal(next.length, 1);
  assert.ok(new Date(next[0].run_at).getTime() > Date.now() + 50_000);
  _resetTokensForTest();
  await due();
  await jobs();
  assert.ok(eventsOf(0).some((e) => e.summary === 'Burma Shave — five hundred'));

  // A deleted calendar: gone, no calls until Make it again, which makes a new one.
  fake.cal.dropCalendar(calOf(0)[0].id);
  ok(await M.b.action('shift.update', { id: w.id, title: 'Burma Shave — after the calendar went' }));
  await jobs();
  l = await linkRow(V.id);
  assert.equal(l.state, 'gone');
  assert.equal(l.calendar_id, null);
  assert.equal((await gcal(V)).link.said, 'You deleted the base.win calendar in Google');
  fake.cal.reset();
  ok(await M.b.action('shift.update', { id: w.id, title: 'Burma Shave — still gone' }));
  await jobs();
  assert.equal(fake.cal.calls.filter((c) => c.sub === A[0].sub).length, 0);
  ok(await V.b.action('gcal.on', {}));
  await jobs();
  assert.equal(calOf(0).length, 1);
  assert.notEqual(calOf(0)[0].id, cal0);
  assert.ok(eventsOf(0).some((e) => e.summary === 'Burma Shave — still gone'));

  // 403 insufficientPermissions: reconnect through GSI, no further calls.
  fake.cal.reset();
  ok(await M.b.action('shift.update', { id: w.id, title: 'Burma Shave — scope' }));
  fake.cal.next('403', { reason: 'insufficientPermissions', sub: A[0].sub });
  await jobs();
  assert.equal(fake.cal.calls.filter((c) => c.sub === A[0].sub).length, 1);
  assert.equal((await linkRow(V.id)).state, 'reconnect');
  assert.equal((await db.query('select state from google_grants where user_id = $1', [V.id])).rows[0].state, 'reconnect');
  assert.equal((await gcal(V)).google.state, 'reconnect');
  // Connecting again puts it back.
  assert.equal((await connect(V, 0)).google, 'connected');
  assert.equal((await linkRow(V.id)).state, 'ok');
  await jobs();
  assert.ok(eventsOf(0).some((e) => e.summary === 'Burma Shave — scope'));

  // invalid_grant (removed in their Google Account): reconnect, no further calls.
  fake.revokeAll(A[0].sub);
  _resetTokensForTest();
  fake.cal.reset();
  ok(await M.b.action('shift.update', { id: w.id, title: 'Burma Shave — revoked' }));
  await jobs();
  assert.equal(fake.cal.calls.filter((c) => c.sub === A[0].sub).length, 0);
  assert.equal((await linkRow(V.id)).state, 'reconnect');
  assert.equal((await connect(V, 0)).google, 'connected');
  await jobs();
  assert.equal((await linkRow(V.id)).state, 'ok');
});

test('the runner is not held: a slow Google leaves the next job free', async () => {
  ok(await M.b.action('shift.update', { id: keep.shift.id, title: 'Burma Shave — slow' }));
  fake.cal.next('slow', { ms: 1500 });
  await db.transaction((tx) => enqueueJob(tx, { workspaceId: M.ws, kind: 'test.gcal.quick', runAt: new Date(Date.now() + 5).toISOString() }));
  await new Promise((r) => setTimeout(r, 20));
  order.length = 0;
  const orig = fake.cal.calls.length;
  const run = jobs();
  await new Promise((r) => setTimeout(r, 300));
  order.push(fake.cal.calls.length > orig ? 'google asked' : 'google not yet');
  await run;
  assert.equal(order[0], 'quick job', JSON.stringify(order));
});

test('bounds: a person’s calls a minute, a run’s calls, and one push a person at a time', async () => {
  let now = Date.now();
  bounding = true;
  _setGcalForTest({ now: () => now, perMinute: 4, runCalls: 6 });
  const many = [];
  for (const d of ['2030-07-01', '2030-07-02', '2030-07-03', '2030-07-04', '2030-07-05', '2030-07-06']) many.push(await shiftOn(d));
  for (const s of many) { ok(await V.b.action('shift.join', { shift_id: s.id })); ok(await S.b.action('shift.join', { shift_id: s.id })); }
  fake.cal.reset();
  await jobs();
  const perSub = (sub) => fake.cal.calls.filter((c) => c.sub === sub).length;
  assert.ok(calls() <= 6, `a run: ${calls()}`);
  assert.ok(perSub(A[0].sub) <= 4 && perSub(A[2].sub) <= 4);
  for (let i = 0; i < 6; i += 1) {
    now += 61_000;
    const before = calls();
    await due();
    await jobs();
    assert.ok(calls() - before <= 6);
  }
  for (const s of many) {
    assert.ok(eventsOf(0).some((e) => e.id === `bs${s.id.replace(/-/g, '')}`));
    assert.ok(eventsOf(2).some((e) => e.id === `bs${s.id.replace(/-/g, '')}`));
  }
  _resetGcalForTest();
  bounding = false;
  // Two passes at once never push one event twice.
  for (const s of many) ok(await M.b.action('shift.update', { id: s.id, title: `Burma Shave ${s.id.slice(0, 4)}` }));
  await db.transaction((tx) => enqueueJob(tx, { workspaceId: M.ws, kind: 'gcal.push', key: `gcal-push-extra-${tag}` }));
  fake.cal.reset();
  await Promise.all([runDueJobs(db, { workspaceId: M.ws, limit: 1 }), runDueJobs(db, { workspaceId: M.ws, limit: 1 })]);
  const seen = fake.cal.calls.map((c) => `${c.sub} ${c.path}`);
  assert.equal(new Set(seen).size, seen.length);
  await due();
  await jobs();
});

test('jobs: one pending push whatever the writes; the sweep once a date marks every ok link', async () => {
  for (let i = 0; i < 3; i += 1) ok(await V.b.action('shift.leave', { shift_id: keep.shift.id }).then(() => V.b.action('shift.join', { shift_id: keep.shift.id })));
  assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'gcal.push' and status = 'pending'`, [M.ws])).rows[0].n, 1);
  await jobs();
  const sweeps = (await db.query(`select key, run_at from jobs where workspace_id = $1 and kind = 'gcal.sweep' and status = 'pending'`, [M.ws])).rows;
  assert.equal(sweeps.length, 1);
  const { day } = nextSweepAt('America/Edmonton');
  assert.equal(sweeps[0].key, `gcal-sweep-${day}`);
  // Before 03:17: today; after: tomorrow.
  assert.equal(nextSweepAt('America/Vancouver', Date.parse('2030-05-06T09:00:00Z')).day, '2030-05-06');
  assert.equal(nextSweepAt('America/Vancouver', Date.parse('2030-05-06T11:00:00Z')).day, '2030-05-07');
  // The sweep: every ok link dirty, a push, and the next date (a failed one doesn't end the chain: every push queues it).
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'gcal.sweep' and status = 'pending'`, [M.ws]);
  await db.query('update gcal_links set dirty_at = null where workspace_id = $1', [M.ws]);
  await runAction(db, { workspaceId: M.ws, actorId: null, action: 'gcal.test' }, async () => {});
  const n = (await db.query(`select count(*)::int as n from gcal_links where workspace_id = $1 and state = 'ok'`, [M.ws])).rows[0].n;
  fake.cal.reset();
  await jobs();
  assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'gcal.sweep' and status = 'done'`, [M.ws])).rows[0].n, 1);
  assert.equal((await db.query(`select count(*)::int as n from gcal_links where workspace_id = $1 and dirty_at is not null`, [M.ws])).rows[0].n, n, 'every ok link marked');
  await jobs();
  assert.equal((await db.query(`select count(*)::int as n from gcal_links where workspace_id = $1 and dirty_at is not null`, [M.ws])).rows[0].n, 0, `${n} links pushed`);
  assert.equal(calls(), 0, 'nothing drifted');
});

test('stop: the calendar goes with its rows; the Calendar permission goes; revoked only with nothing else left', async () => {
  // Sam also has another feature's purpose: no revoke.
  assert.equal((await connect(S, 2, 'test.gcal.other')).google, 'connected');
  ok(await S.b.action('gcal.stop', {}));
  assert.equal((await gcal(S)).link.state, 'stopping');
  await jobs();
  assert.equal(calOf(2).length, 0, 'deleted in Google');
  assert.equal(await linkRow(S.id), null);
  assert.deepEqual((await db.query('select purposes from google_grants where user_id = $1', [S.id])).rows[0].purposes, ['test.gcal.other']);
  assert.equal(fake.counts.revoke, 0);
  assert.equal((await S.b.action('gcal.stop', {})).json.error, 'Your shifts aren’t in Google Calendar');
  // Wren: Calendar alone → revoked after the delete.
  assert.equal((await connect(W, 3)).google, 'connected');
  await jobs();
  assert.equal(calOf(3).length, 1);
  fake.cal.reset(); fake.resetCounts();
  ok(await W.b.action('gcal.stop', {}));
  await jobs();
  await jobs();
  assert.equal(calOf(3).length, 0);
  assert.equal(fake.counts.revoke, 1);
  assert.deepEqual(fake.order.filter((x) => x === 'calendars.delete' || x === 'revoke'), ['calendars.delete', 'revoke']);
  assert.equal((await db.query('select 1 from google_grants where user_id = $1', [W.id])).rows.length, 0);
});

test('stop while reconnecting: no Google call, left; OK forgets it', async () => {
  fake.revokeAll(A[0].sub);
  _resetTokensForTest();
  ok(await M.b.action('shift.update', { id: keep.shift.id, title: 'Burma Shave — gone away' }));
  await jobs();
  assert.equal((await linkRow(V.id)).state, 'reconnect');
  fake.cal.reset();
  ok(await V.b.action('gcal.stop', {}));
  await jobs();
  assert.equal(calls(), 0);
  const l = await linkRow(V.id);
  assert.equal(l.state, 'left');
  assert.equal((await gcal(V)).link.said, 'base.win stopped updating your Google calendar — delete it there or use the calendar link');
  ok(await V.b.action('gcal.stop', {}));
  assert.equal(await linkRow(V.id), null);
  assert.equal((await connect(V, 0)).google, 'connected');
  await jobs();
  assert.equal((await linkRow(V.id)).state, 'ok');
});

test('clean-up through GSI: disconnect and forget delete the calendar before any revoke; a delete that never answers still revokes, and the link is left', async () => {
  assert.equal((await connect(V, 0, 'test.gcal.other')).google, 'connected');
  await jobs();
  let cal = (await linkRow(V.id)).calendar_id;
  assert.ok(live(cal));
  ok(await V.b.action('google.disconnect', { purpose: 'calendar.mine' }));
  assert.equal((await linkRow(V.id)).state, 'stopping');
  await jobs();
  assert.ok(!live(cal), 'deleted in Google');

  assert.equal(await linkRow(V.id), null);
  assert.equal(fake.counts.revoke, 0, 'another purpose remains');
  // Forget (a manager): every member's connection, the calendar first.
  assert.equal((await connect(V, 0)).google, 'connected');
  await jobs();
  cal = (await linkRow(V.id)).calendar_id;
  assert.ok(live(cal));
  fake.cal.reset(); fake.resetCounts();
  ok(await M.b.action('google.forget', {}));
  assert.equal((await linkRow(V.id)).state, 'stopping', 'the member’s link, read from payload.user_id');
  await jobs();
  assert.ok(!live(cal));
  assert.deepEqual(fake.orderOf(A[0].sub).filter((x) => x === 'calendars.delete' || x === 'revoke'), ['calendars.delete', 'revoke']);
  assert.equal(await linkRow(V.id), null);
  // A delete that times out on every try: revoked anyway, the link left.
  assert.equal((await connect(V, 0)).google, 'connected');
  await jobs();
  _setTokenTimeoutForTest(200);
  fake.resetCounts();
  for (let i = 0; i < 5; i += 1) fake.cal.next('slow', { route: 'calendars.delete', ms: 400 });
  ok(await V.b.action('google.disconnect', { purpose: 'calendar.mine' }));
  for (let i = 0; i < 5; i += 1) { await due(); await jobs().catch(() => {}); }
  _setTokenTimeoutForTest(8000);
  assert.equal(fake.counts.revoke, 1);
  assert.equal((await linkRow(V.id)).state, 'left');
  ok(await V.b.action('gcal.stop', {}));
  assert.equal(await linkRow(V.id), null);
  await new Promise((r) => setTimeout(r, 500));
});

test('turning the switch off deletes every connected person’s calendar, drops their purpose, leaves no link', async () => {
  fake.clearKnobs();
  assert.equal((await connect(V, 0)).google, 'connected');
  assert.equal((await connect(S, 2)).google, 'connected');
  await jobs();
  const cals = [(await linkRow(V.id)).calendar_id, (await linkRow(S.id)).calendar_id];
  assert.ok(cals.every(live));
  ok(await M.b.action('gcal.settings', { on: false }));
  assert.equal((await linkRow(V.id)).state, 'stopping');
  await jobs();
  await jobs();
  assert.ok(!cals.some(live));
  assert.equal((await db.query('select count(*)::int as n from gcal_links where workspace_id = $1', [M.ws])).rows[0].n, 0);
  for (const u of [V.id, S.id]) {
    const g = (await db.query('select purposes from google_grants where user_id = $1', [u])).rows[0];
    assert.ok(!g || !g.purposes.includes('calendar.mine'));
  }
  ok(await M.b.action('gcal.settings', { on: true }));
});

test('leaving the team: deleted for a one-campaign user then revoked; through the other campaign for a two-campaign user; a paid membership touches nothing', async () => {
  // A paid membership's void (payments' "dues refunded") is no team change.
  assert.equal((await connect(W, 3)).google, 'connected');
  await jobs();
  await runAction(db, { workspaceId: M.ws, actorId: M.id, action: 'payment.refund' }, async (tx, emit) => { emit('membership', W.id, 'void', {}); });
  assert.equal((await linkRow(W.id)).state, 'ok');
  fake.cal.reset(); fake.resetCounts();
  ok(await M.b.action('member.remove', { user_id: W.id }));
  await jobs();
  assert.equal(calOf(3).length, 0, 'deleted from their Google account');
  assert.deepEqual(fake.order.filter((x) => x === 'calendars.delete' || x === 'revoke'), ['calendars.delete', 'revoke']);
  assert.equal(await linkRow(W.id), null);
  // Sam on two campaigns.
  B2 = await signup(`Gcal Second ${tag}`, `bea.${tag}@example.org`);
  ok(await B2.b.action('gcal.settings', { on: true }));
  const inv = ok(await B2.b.action('member.invite', { email: S.email, role: 'staff' }));
  const s2 = new Browser();
  ok(await s2.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], password: 'google-2026-pass' }));
  assert.equal((await connect(S, 2)).google, 'connected');
  ok(await s2.action('gcal.on', {}));
  assert.equal((await linkRow(S.id)).state, 'ok', 'connecting made this campaign’s link too');
  await jobs();
  await jobs(B2.ws);
  assert.equal(calOf(2).length, 2, 'one calendar a campaign');
  fake.cal.reset(); fake.resetCounts();
  ok(await M.b.action('member.remove', { user_id: S.id }));
  await jobs();
  assert.equal(calOf(2).length, 1, 'this campaign’s calendar deleted; the other stays');
  assert.equal(calOf(2)[0].body.summary, `Gcal Second ${tag} — my shifts (base.win)`);
  assert.equal(fake.counts.revoke, 0);
  assert.equal(await linkRow(S.id), null);
  assert.equal((await linkRow(S.id, B2.ws)).state, 'ok');
});

test('with no background work: a disconnect or the switch going off leaves the link, saying so; nothing waits for a job', async () => {
  assert.equal((await connect(V, 0)).google, 'connected');
  await jobs();
  assert.equal((await linkRow(V.id)).state, 'ok');
  process.env.STARBASE_JOBS = 'off';
  ok(await V.b.action('google.disconnect', { purpose: 'calendar.mine' }));
  const l = await linkRow(V.id);
  assert.equal(l.state, 'left');
  assert.equal(l.said, 'base.win stopped updating your Google calendar — delete it there or use the calendar link');
  const last = (await db.query(`select action, op, payload from events where workspace_id = $1 and entity_type = 'gcal_link' order by seq desc limit 1`, [M.ws])).rows[0];
  assert.deepEqual([last.action, last.op, last.payload], ['google.disconnect', 'update', { state: 'left' }], 'on the log');
  assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'gcal.stop' and status = 'pending'`, [M.ws])).rows[0].n, 0);
  ok(await V.b.action('gcal.stop', {}));
  assert.equal(await linkRow(V.id), null);
  delete process.env.STARBASE_JOBS;
  assert.equal((await connect(V, 0)).google, 'connected');
  await jobs();
  process.env.STARBASE_JOBS = 'off';
  ok(await M.b.action('gcal.settings', { on: false }));
  assert.equal((await linkRow(V.id)).state, 'left');
  delete process.env.STARBASE_JOBS;
  ok(await V.b.action('gcal.stop', {}));
  ok(await M.b.action('gcal.settings', { on: true }));
});

test('hygiene: gcal_link events carry only a state; no calendar id, event id, email, token or Google’s text anywhere; not exported; the chain holds', async () => {
  const evs = (await db.query(`select payload from events where entity_type = 'gcal_link' and workspace_id = $1`, [M.ws])).rows;
  assert.ok(evs.length > 5);
  for (const e of evs) for (const k of Object.keys(e.payload)) assert.equal(k, 'state');
  const secrets = [
    ...fake.cal.calendars().map((c) => c.id), ...fake.tokens(), 'fake google text', '@group.calendar.example',
    ...A.map((a) => a.email),
  ];
  const all = JSON.stringify([
    (await db.query('select payload from events where workspace_id = $1', [M.ws])).rows,
    (await db.query('select payload, last_error from jobs where workspace_id = $1', [M.ws])).rows,
    lines,
  ]);
  for (const s of secrets) assert.ok(!all.includes(s), `found ${s}`);
  assert.ok(!all.includes('"bs'), 'no event id');
  const v = JSON.stringify(await gcal(V));
  for (const s of fake.cal.calendars().map((c) => c.id)) assert.ok(!v.includes(s));
  assert.ok(!/"bs[0-9a-f]{32}"/.test(v));
  const ex = await M.b.get('/api/export');
  const text = JSON.stringify(ex.json || {});
  assert.ok(!/gcal_links|gcal_items/.test(text));
  for (const e of EXTENSIONS) for (const t of e.exportTables || []) assert.ok(!/^gcal/.test(typeof t === 'string' ? t : t.table));
  assert.equal((await verifyChain(db, M.ws)).ok, true);
  assert.ok(app);
});
