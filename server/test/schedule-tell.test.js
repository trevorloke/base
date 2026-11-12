// Telling people about their shifts without a tap per shift (ext/schedule):
// "Tell everyone on this week's shifts" queues one message per person — the
// write sends nothing; a job does, outside any write, and keeps how each
// went — and "Remind people the evening before" is off until a manager
// turns it on, then goes once per booking at 6 pm on the campaign's clock,
// inside the texting hours. Email and Twilio are stand-ins here (a stubbed
// fetch); the clock is the texting rules' (quiet hours read it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { verifyChain } from '../lib/events.js';
import { runDueJobs } from '../lib/jobs.js';
import { _setClockForTest } from '../ext/texting/rules.js';
import { _setPerRunForTest, noticeWords, remindAt } from '../ext/schedule/tell.js';
import { shiftMessage } from '../lib/notify.js';

const tag = Math.random().toString(36).slice(2, 8);
const TZ = 'America/Vancouver';
const ENV = ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_API_BASE'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const emails = [];
const texts = [];
// What the stand-ins answer; a test may swap them.
let onEmail = () => new Response('{}', { status: 200 });
let onText = () => new Response('{}', { status: 201 });
// Open transactions while a provider is being called: there must be none.
let inWrite = 0;
let sentInWrite = 0;

let db, mgr, ws, staff, vol, volId, other;
const P = {};
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const at = (iso) => _setClockForTest(() => new Date(iso));
const connect = () => {
  Object.assign(process.env, { RESEND_API_KEY: 'test-key', TWILIO_ACCOUNT_SID: `AC${tag}`, TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+16045550100' });
  delete process.env.TWILIO_API_BASE;
};
const disconnect = () => { for (const k of ENV) delete process.env[k]; };
const join = async (role, name) => {
  const inv = ok(await mgr.action('member.invite', { email: `tell-${name}+${tag}@example.org`.toLowerCase(), role }));
  const c = new Client();
  const j = ok(await c.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: `${name} Example`, password: 'tell-pass-2026' }));
  return { client: c, id: j.user.id };
};
// Run this campaign's due jobs until none is left (a job may queue the next).
const runJobs = async () => {
  let ran = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = await runDueJobs(db, { workspaceId: ws });
    assert.equal(r.failed, 0, 'no job failed');
    if (!r.ran) break;
    ran += r.ran;
  }
  return ran;
};
// A reminder job's hour has come: due now by the database's clock.
const due = (day) => db.query(`update jobs set run_at = now() where workspace_id = $1 and key = $2 and status = 'pending'`, [ws, `schedule.remind:${day}`]);
const shiftOn = async (day, start, end, extra = {}) => ok(await mgr.action('shift.createMany', {
  kind: 'burma_shave', location: 'King George Blvd & 88 Ave', days: [day], start, end, ...extra,
})).shifts[0];
const book = async (shift, person) => ok(await mgr.action('shift.assign', { shift_id: shift.id, person_id: person.id })).assignment.id;
const noticesOf = (batch) => rows(
  `select p.name, n.state, n.email, n.text, n.text_note, n.kind from shift_notices n join persons p on p.id = n.person_id
    where n.workspace_id = $1 and n.batch_id = $2 order by p.name`, [ws, batch]);

// The week of Monday May 6, 2030 (B.C. on UTC-7 by any copy of the rules).
const MON = '2030-05-06';

before(async () => {
  db = await freshDb();
  disconnect();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) {
      if (inWrite) sentInWrite += 1;
      emails.push({ ...JSON.parse(init.body), key: init.headers?.['Idempotency-Key'] });
      return onEmail();
    }
    if (u.startsWith('https://api.twilio.com/')) {
      if (inWrite) sentInWrite += 1;
      texts.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return onText();
    }
    return realFetch(url, init);
  };
  // Count the writes that are open, to prove no provider is called in one.
  const transaction = db.transaction.bind(db);
  db.transaction = async (fn) => { inWrite += 1; try { return await transaction(fn); } finally { inWrite -= 1; } };
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Tell ${tag}`, email: `tell-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  ({ client: staff } = await join('staff', 'Sam'));
  ({ client: vol, id: volId } = await join('volunteer', 'Vik'));
  other = new Client();
  await other.signup({ workspaceName: `Elsewhere ${tag}`, email: `tell-other+${tag}@example.org` });
  const mk = async (key, name, extra) => { P[key] = await mgr.createPerson(name, extra); };
  await mk('asha', 'Asha Example', { email: `asha.${tag}@example.org`, phone: '604-555-0151' });
  await mk('ben', 'Ben Example', { email: `ben.${tag}@example.org` });
  await mk('cam', 'Cam Example', { phone: '604-555-0153' });
  await mk('dee', 'Dee Example', { email: `dee.${tag}@example.org`, phone: '604-555-0154' });
  await mk('eli', 'Eli Example', { email: `eli.${tag}@example.org`, phone: '604-555-0155' });
  await mk('flo', 'Flo Example');
});
after(() => {
  globalThis.fetch = realFetch;
  _setClockForTest(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('the words: a week’s shifts in order on the campaign’s clock; a reminder says tomorrow', () => {
  const shifts = [
    { title: 'Burma Shave — King George Blvd & 88 Ave', starts_at: '2030-05-06T13:30:00Z', ends_at: '2030-05-06T15:30:00Z', location: 'King George Blvd & 88 Ave', instructions: 'Bring a sign.', link: 'https://example.org/wave' },
    { title: 'Phone night', starts_at: '2030-05-09T01:00:00Z', ends_at: null, location: 'Campaign office' },
  ];
  const week = noticeWords({ kind: 'week', shifts, workspaceName: 'Imagine Example', tz: TZ, thisWeek: true });
  assert.equal(week.subject, 'Your shifts this week');
  assert.equal(week.email, [
    'Your shifts this week:',
    '',
    'Burma Shave — King George Blvd & 88 Ave',
    'Monday, May 6 at 6:30 a.m. – 8:30 a.m.',
    'Where: King George Blvd & 88 Ave',
    'Instructions: Bring a sign.',
    'Details: https://example.org/wave',
    '',
    'Phone night',
    'Wednesday, May 8 at 6:00 p.m.',
    'Where: Campaign office',
    '',
    '— Imagine Example',
  ].join('\n'));
  assert.equal(week.text, [
    'Your shifts this week:',
    'Mon, May 6, 6:30 a.m.: Burma Shave — King George Blvd & 88 Ave',
    'Wed, May 8, 6:00 p.m.: Phone night, Campaign office',
    '— Imagine Example',
  ].join('\n'));
  const later = noticeWords({ kind: 'week', shifts, workspaceName: 'Imagine Example', tz: TZ, thisWeek: false, week: MON });
  assert.equal(later.subject, 'Your shifts for the week of May 6');
  assert.match(later.email, /^Your shifts for the week of May 6:\n/);
  const one = noticeWords({ kind: 'reminder', shifts: shifts.slice(0, 1), workspaceName: 'Imagine Example', tz: TZ });
  assert.equal(one.subject, 'Tomorrow: Burma Shave — King George Blvd & 88 Ave');
  assert.match(one.email, /^A reminder — you’re on tomorrow:\n\nBurma Shave — King George Blvd & 88 Ave\nMonday, May 6 at 6:30 a\.m\. – 8:30 a\.m\.\n/);
  assert.match(one.text, /^A reminder — you’re on tomorrow:\nMon, May 6, 6:30 a\.m\.: Burma Shave — King George Blvd & 88 Ave\n— Imagine Example$/);
  assert.equal(noticeWords({ kind: 'reminder', shifts, workspaceName: 'X', tz: TZ }).subject, 'Tomorrow: your 2 shifts');
  // A long week still fits in a text: the first eight, and how many more.
  const many = Array.from({ length: 11 }, (_, i) => ({ title: `Shift ${i + 1}`, starts_at: `2030-05-06T${String(13 + i).padStart(2, '0')}:00:00Z` }));
  const long = noticeWords({ kind: 'week', shifts: many, workspaceName: 'X', tz: TZ, thisWeek: true }).text;
  assert.match(long, /Shift 8\n\+ 3 more — ask us for the full list\n— X$/);
  assert.ok(long.length <= 1000);
});

test('a place nothing could name: a message gives its map — never its coordinates as words', () => {
  const pinned = { title: 'Mainstreet — Pinned place', starts_at: '2030-05-07T14:00:00Z', ends_at: '2030-05-07T16:00:00Z', location: 'Pin at 49.1451, −122.8599' };
  const map = 'https://www.google.com/maps/search/?api=1&query=49.1451,-122.8599';
  const week = noticeWords({ kind: 'week', shifts: [pinned], workspaceName: 'Imagine Example', tz: TZ, thisWeek: true });
  assert.ok(week.email.includes(`\nWhere: see the map — ${map}\n`), week.email);
  assert.equal(week.text.split('\n')[1], `Tue, May 7, 7:00 a.m.: Mainstreet — Pinned place, see the map — ${map}`);
  const reminder = noticeWords({ kind: 'reminder', shifts: [pinned], workspaceName: 'Imagine Example', tz: TZ });
  // A shift's own notice ("Notify everyone", "Tell them" on a card) says the same.
  const one = shiftMessage(pinned, 'Imagine Example', TZ);
  assert.ok(one.includes(`\nWhere: see the map — ${map}\n`), one);
  for (const words of [week.email, week.text, reminder.email, reminder.text, one]) {
    assert.doesNotMatch(words, /Pin at|49\.1451, /, 'the coordinates are only inside the map link');
  }
  // A named place is its words, as before.
  assert.match(shiftMessage({ ...pinned, location: 'Newton Exchange' }, 'X', TZ), /\nWhere: Newton Exchange\n/);
});

test('a week of pinned places is built to a text’s length — no link cut, the rest counted, the sign-off kept', () => {
  // Nine Signs shifts at points nobody named: each line carries its map link.
  const nine = Array.from({ length: 9 }, (_, i) => ({
    title: 'Signs — Pinned place', starts_at: `2030-05-0${6 + (i % 3)}T${16 + Math.floor(i / 3)}:00:00Z`, ends_at: null,
    location: `Pin at 49.14${String(i).padStart(2, '0')}, −122.85${String(i).padStart(2, '0')}`,
  }));
  const text = noticeWords({ kind: 'week', shifts: nine, workspaceName: 'Imagine Example', tz: TZ, thisWeek: true }).text;
  const lines = text.split('\n');
  assert.ok(text.length <= 1000, `${text.length} characters`);
  assert.equal(lines[0], 'Your shifts this week:');
  assert.equal(lines.at(-1), '— Imagine Example', 'the sign-off survives');
  const shown = lines.slice(1, -2);
  assert.ok(shown.length >= 1 && shown.length < 9, `${shown.length} shifts listed`);
  for (const l of shown) assert.match(l, /, see the map — https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=49\.14\d*,-122\.85\d*$/, 'every link whole');
  assert.equal(lines.at(-2), `+ ${9 - shown.length} more — ask us for the full list`, 'what didn’t fit is counted, never dropped without a word');
  // Eight that fit in a text are all there, as before; a ninth is "+ 1 more".
  const short = nine.map((s) => ({ ...s, location: 'Campaign office', title: 'Signs — Campaign office' }));
  assert.match(noticeWords({ kind: 'week', shifts: short, workspaceName: 'X', tz: TZ, thisWeek: true }).text, /Campaign office\n\+ 1 more — ask us for the full list\n— X$/);
});

test('“Tell everyone on this week’s shifts”: the count first; the write only queues; a job sends, outside any write', async () => {
  at('2030-05-05T19:00:00Z'); // Sunday noon in Surrey, the day before the week
  const mon = await shiftOn('2030-05-06', '06:30', '08:30');
  const wed = await shiftOn('2030-05-08', '06:30', '08:30');
  const phone = ok(await mgr.action('shift.createMany', { kind: 'phone_bank', location: 'Campaign office', days: ['2030-05-08'], start: '18:00', end: '20:00', instructions: 'Use the side door.' })).shifts[0];
  const empty = await shiftOn('2030-05-10', '06:30', '08:30');
  const nextWeek = await shiftOn('2030-05-13', '06:30', '08:30');
  await book(mon, P.asha); await book(wed, P.asha); await book(phone, P.asha);
  await book(mon, P.ben);
  await book(phone, P.cam);
  await book(mon, P.flo); // no email, no phone
  ok(await mgr.action('shift.setStatus', { id: await book(wed, P.dee), status: 'declined' })); // can't make it: not told
  await book(nextWeek, P.eli); // another week

  // The count, before anything is sent.
  const count = ok(await mgr.get('/api/schedule/week?week=2030-05-08'), 'any day of the week names it');
  assert.deepEqual([count.week, count.people, count.shifts], [MON, 4, 3], 'four people on three shifts — not the one who declined, not next week’s');
  assert.deepEqual(count.providers, { email: false, text: false });
  assert.equal(count.last, null);
  assert.deepEqual([count.reminders.on, count.reminders.can_set], [false, true]);

  // Nothing connected: the tap queues, the job runs, and nothing pretends to have sent.
  const off = ok(await mgr.action('shift.tellWeek', { week: MON }));
  assert.deepEqual([off.people, off.shifts, off.week], [4, 3, MON]);
  assert.deepEqual((await noticesOf(off.batch_id)).map((n) => [n.name, n.state]), [['Asha Example', 'asked'], ['Ben Example', 'asked'], ['Cam Example', 'asked'], ['Flo Example', 'asked']],
    'one row a person, waiting');
  const again = await mgr.action('shift.tellWeek', { week: MON });
  assert.equal(again.status, 409, 'a second tap while it is going out');
  assert.match(again.json.error, /still going out/);
  await runJobs();
  assert.deepEqual((await noticesOf(off.batch_id)).map((n) => [n.name, n.state, n.email, n.text]), [
    ['Asha Example', 'done', 'queued', 'queued'], ['Ben Example', 'done', 'queued', 'skipped'],
    ['Cam Example', 'done', 'skipped', 'queued'], ['Flo Example', 'done', 'skipped', 'skipped'],
  ]);
  assert.deepEqual([emails.length, texts.length], [0, 0]);

  // Connected: tapped again, the job sends — one message a person, listing their shifts.
  connect();
  sentInWrite = 0;
  const r = ok(await mgr.action('shift.tellWeek', { week: '2030-05-12' }), 'Sunday is the same week');
  assert.deepEqual([emails.length, texts.length], [0, 0], 'the tap itself sends nothing');
  assert.equal(ok(await mgr.get(`/api/schedule/week?week=${MON}`)).last.waiting, 4);
  assert.ok(await runJobs() >= 1);
  assert.equal(sentInWrite, 0, 'no provider is called while a write is open');
  assert.deepEqual(emails.map((m) => m.to[0]).sort(), [P.asha.email, P.ben.email].sort());
  assert.deepEqual(texts.map((m) => m.To).sort(), ['+16045550151', '+16045550153']);
  const asha = emails.find((m) => m.to[0] === P.asha.email);
  assert.equal(asha.subject, 'Your shifts for the week of May 6');
  assert.match(asha.text, /Monday, May 6 at 6:30 a\.m\. – 8:30 a\.m\.[\s\S]*Wednesday, May 8 at 6:30 a\.m\.[\s\S]*Wednesday, May 8 at 6:00 p\.m\. – 8:00 p\.m\.\nWhere: Campaign office\nInstructions: Use the side door\./);
  assert.equal(asha.key, `shift-notice-${(await rows(`select n.id from shift_notices n where n.batch_id = $1 and n.person_id = $2`, [r.batch_id, P.asha.id]))[0].id}`, 'each email carries its own key');
  const cam = texts.find((m) => m.To === '+16045550153');
  assert.match(cam.Body, /^Your shifts for the week of May 6:\nWed, May 8, 6:00 p\.m\.: Phone bank — Campaign office\n— Tell /);
  assert.ok(!/Burma Shave/.test(cam.Body), 'only their own shifts');

  // How each went, kept per person — and on each booking, as shift.notify keeps it.
  const results = ok(await mgr.get(`/api/schedule/notices/${r.batch_id}`));
  assert.deepEqual(results.people.map((p) => [p.name, p.state, p.email, p.text]), [
    ['Asha Example', 'done', 'sent', 'sent'], ['Ben Example', 'done', 'sent', 'skipped'],
    ['Cam Example', 'done', 'skipped', 'sent'], ['Flo Example', 'done', 'skipped', 'skipped'],
  ]);
  const onMon = ok(await mgr.get(`/api/shifts/${mon.id}`)).assignees;
  assert.deepEqual(onMon.map((a) => [a.name, a.notify_email, a.notify_text, Boolean(a.notified_at)]), [
    ['Asha Example', 'sent', 'sent', true], ['Ben Example', 'sent', 'skipped', true], ['Flo Example', 'skipped', 'skipped', true],
  ]);
  const declined = ok(await mgr.get(`/api/shifts/${wed.id}`)).assignees.find((a) => a.name === 'Dee Example');
  assert.deepEqual([declined.notified_at, declined.notify_email], [null, null], 'never told');
  const last = ok(await mgr.get(`/api/schedule/week?week=${MON}`)).last;
  assert.deepEqual([last.batch_id, last.people, last.waiting, last.reached], [r.batch_id, 4, 0, 3]);
  assert.ok(empty.id && nextWeek.id);

  // On the log: the tap's rows by the person who tapped, each result after.
  const events = await rows(`select action, op, actor_id, payload from events where workspace_id = $1 and entity_type = 'shift_notice' and payload->>'batch_id' = $2 order by seq`, [ws, r.batch_id]);
  assert.deepEqual(events.map((e) => [e.action, e.op]), Array(4).fill(['shift.tellWeek', 'create']));
  // (A number as it is kept or as it is dialled — not a bare "555", which an id can hold by chance.)
  assert.ok(!JSON.stringify(events).includes('@') && !/555-?01\d\d/.test(JSON.stringify(events)), 'no address or number on the log');
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('someone who drops out before their message goes is not told; a week nobody is on has nothing to tell', async () => {
  connect();
  at('2030-05-05T19:00:00Z');
  emails.length = 0; texts.length = 0;
  const r = ok(await mgr.action('shift.tellWeek', { week: MON }));
  // Between the tap and the send: Ben is taken off, Cam's only shift is called off.
  const benOn = (await rows(`select a.id from shift_assignments a where a.workspace_id = $1 and a.person_id = $2`, [ws, P.ben.id]))[0];
  ok(await mgr.action('shift.setStatus', { id: benOn.id, status: 'declined' }));
  const phone = (await rows(`select id from shifts where workspace_id = $1 and kind = 'phone_bank' and deleted_at is null`, [ws]))[0];
  ok(await mgr.action('shift.delete', { id: phone.id }));
  await runJobs();
  assert.deepEqual((await noticesOf(r.batch_id)).map((n) => [n.name, n.email, n.text]), [
    ['Asha Example', 'sent', 'sent'], ['Ben Example', 'skipped', 'skipped'], ['Cam Example', 'skipped', 'skipped'], ['Flo Example', 'skipped', 'skipped'],
  ]);
  assert.deepEqual([emails.map((m) => m.to[0]), texts.map((m) => m.To)], [[P.asha.email], ['+16045550151']]);
  assert.ok(!/Phone bank/.test(emails[0].text), 'a called-off shift is not in the message');
  assert.equal((await noticesOf(r.batch_id)).find((n) => n.name === 'Ben Example').text_note, 'No longer on a shift');

  const none = await mgr.action('shift.tellWeek', { week: '2030-07-01' });
  assert.equal(none.status, 409);
  assert.match(none.json.error, /nobody is on a shift/);
  assert.equal((await mgr.action('shift.tellWeek', { week: 'next week' })).status, 400);
  assert.equal(ok(await mgr.get('/api/schedule/week?week=2030-07-01')).people, 0);
  assert.equal((await mgr.get('/api/schedule/week?week=soon')).status, 400);
});

test('the texting rules hold for a week’s notice: quiet hours, opt-outs, do-not-contact — and email’s own', async () => {
  connect();
  // Sunday 8 pm in Surrey: weekend texts stopped at 6.
  at('2030-05-06T03:00:00Z');
  emails.length = 0; texts.length = 0;
  ok(await mgr.action('person.update', { id: P.dee.id, tags: ['do-not-contact'] }));
  ok(await mgr.action('person.update', { id: P.eli.id, tags: ['do-not-email'] }));
  const tue = await shiftOn('2030-05-07', '16:00', '18:00');
  await book(tue, P.dee); await book(tue, P.eli);
  const count = ok(await mgr.get(`/api/schedule/week?week=${MON}`));
  assert.equal(count.quiet.now, true);
  assert.match(count.quiet.opens, /9 am/);
  const r = ok(await mgr.action('shift.tellWeek', { week: MON }));
  await runJobs();
  const got = Object.fromEntries((await noticesOf(r.batch_id)).map((n) => [n.name, n]));
  assert.deepEqual([got['Asha Example'].email, got['Asha Example'].text], ['sent', 'quiet'], 'the email goes; the text is held and said so');
  assert.match(got['Asha Example'].text_note, /Quiet hours — sending opens at 9 am/);
  assert.deepEqual([got['Dee Example'].email, got['Dee Example'].text], ['opted_out', 'opted_out'], 'do not contact: neither');
  assert.deepEqual([got['Eli Example'].email, got['Eli Example'].text], ['opted_out', 'quiet'], 'do not email: no email');
  assert.equal(texts.length, 0, 'nothing texted at 8 pm on a Sunday');
  assert.deepEqual(emails.map((m) => m.to[0]), [P.asha.email]);
  // A provider that refuses is recorded as it is, and the rest still go.
  at('2030-05-06T19:00:00Z'); // Monday noon
  onEmail = () => new Response('{"message":"no"}', { status: 422 });
  try {
    const f = ok(await mgr.action('shift.tellWeek', { week: MON }));
    await runJobs();
    const failed = Object.fromEntries((await noticesOf(f.batch_id)).map((n) => [n.name, n]));
    assert.deepEqual([failed['Asha Example'].email, failed['Asha Example'].text], ['failed', 'sent']);
    assert.deepEqual([failed['Eli Example'].email, failed['Eli Example'].text], ['opted_out', 'sent']);
  } finally { onEmail = () => new Response('{}', { status: 200 }); }
  ok(await mgr.action('person.update', { id: P.dee.id, tags: [] }));
  ok(await mgr.action('person.update', { id: P.eli.id, tags: [] }));
});

test('a do-not tag typed in capitals, or a reply asking to stop in words, stops a week’s notice by text (lib/reach.js)', async () => {
  connect();
  at('2030-05-06T19:00:00Z'); // Monday noon
  emails.length = 0; texts.length = 0;
  ok(await mgr.action('person.update', { id: P.dee.id, tags: ['Do-Not-Text'] }));
  // Eli replied "Please stop texting me" (flagged asks_stop) and never START.
  const conv = crypto.randomUUID();
  await db.query('insert into texting_conversations (id, workspace_id, person_id, phone) values ($1, $2, $3, $4)', [conv, ws, P.eli.id, '+16045550155']);
  await db.query(
    `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, keyword) values ($1, $2, $3, 'in', '+16045550155', 'Please stop texting me', 'received', 'asks_stop')`,
    [crypto.randomUUID(), ws, conv]);
  // Dee and Eli are on Tuesday's 4–6 pm shift (the test above).
  const r = ok(await mgr.action('shift.tellWeek', { week: MON }));
  await runJobs();
  const got = Object.fromEntries((await noticesOf(r.batch_id)).map((n) => [n.name, n]));
  assert.deepEqual([got['Dee Example'].email, got['Dee Example'].text], ['sent', 'opted_out'], 'Do-Not-Text: the email, no text');
  assert.deepEqual([got['Eli Example'].email, got['Eli Example'].text], ['sent', 'opted_out'], 'asked to stop: the email, no text');
  assert.ok(!texts.some((m) => ['+16045550154', '+16045550155'].includes(m.To)), 'neither number was texted');
  ok(await mgr.action('person.update', { id: P.dee.id, tags: [] }));
  await db.query(`delete from texting_messages where workspace_id = $1 and conversation_id = $2`, [ws, conv]);
  await db.query(`delete from texting_conversations where id = $1`, [conv]);
});

// The email service's list of addresses nothing may email (ext/mail): one
// that bounced for good, or whose owner reported an email as spam.
test('an address that bounced for good or reported spam gets no notice by email (a week’s or a reminder: one sender); the text still goes', async () => {
  connect();
  at('2030-05-06T19:00:00Z'); // Monday noon
  emails.length = 0; texts.length = 0;
  const { newId } = await import('../lib/events.js');
  await db.query(
    `insert into email_suppressions (id, workspace_id, email, reason, source) values ($1, $2, lower($3), 'bounce', 'resend')
     on conflict (workspace_id, email) do update set lifted_at = null`, [newId(), ws, P.eli.email]);
  const r = ok(await mgr.action('shift.tellWeek', { week: MON }));
  await runJobs();
  const got = Object.fromEntries((await noticesOf(r.batch_id)).map((n) => [n.name, n]));
  assert.deepEqual([got['Eli Example'].email, got['Eli Example'].text], ['suppressed', 'sent'], 'no email to the dead address; the text goes');
  assert.equal(got['Asha Example'].email, 'sent', 'everyone else as before');
  assert.ok(!emails.some((m) => m.to[0] === P.eli.email), 'nothing was sent to it');
  const kept = await rows(
    `select a.notify_email from shift_assignments a where a.workspace_id = $1 and a.person_id = $2 and a.notified_at is not null`, [ws, P.eli.id]);
  assert.ok(kept.length > 0 && kept.every((a) => a.notify_email === 'suppressed'), 'and the booking says why');
  // Lifted (the desk's to do): the next notice emails it again.
  await db.query('update email_suppressions set lifted_at = now() where workspace_id = $1 and email = lower($2)', [ws, P.eli.email]);
  emails.length = 0;
  const again = ok(await mgr.action('shift.tellWeek', { week: MON }));
  await runJobs();
  assert.equal((await noticesOf(again.batch_id)).find((n) => n.name === 'Eli Example').email, 'sent');
  assert.ok(emails.some((m) => m.to[0] === P.eli.email));
  await db.query('delete from email_suppressions where workspace_id = $1', [ws]);
});

test('the one-shift Notify follows the same rule: no email to an address that bounced or reported spam; the text still goes', async () => {
  connect();
  at('2030-05-06T19:00:00Z');
  emails.length = 0; texts.length = 0;
  const { newId } = await import('../lib/events.js');
  await db.query(
    `insert into email_suppressions (id, workspace_id, email, reason, source) values ($1, $2, lower($3), 'complaint', 'resend')
     on conflict (workspace_id, email) do update set lifted_at = null`, [newId(), ws, P.eli.email]);
  try {
    const shift = await shiftOn('2030-07-04', '07:00', '08:30'); // outside the week the other tests count
    await book(shift, P.eli);
    await book(shift, P.asha);
    const r = ok(await mgr.action('shift.notify', { shift_id: shift.id }));
    const by = Object.fromEntries(r.notified.map((n) => [n.name, n]));
    assert.deepEqual([by['Eli Example'].email, by['Eli Example'].text], ['suppressed', 'sent']);
    assert.equal(by['Asha Example'].email, 'sent');
    assert.ok(!emails.some((m) => m.to[0] === P.eli.email), 'nothing was sent to it');
    assert.ok(emails.some((m) => m.to[0] === P.asha.email));
  } finally {
    await db.query('delete from email_suppressions where workspace_id = $1', [ws]);
  }
});

test('who may: the desk tells a week; a volunteer only when granted Shifts, and never gets an address or a number', async () => {
  at('2030-05-06T19:00:00Z');
  assert.equal((await vol.action('shift.tellWeek', { week: MON })).status, 403);
  assert.equal((await vol.get(`/api/schedule/week?week=${MON}`)).status, 403);
  const told = ok(await staff.action('shift.tellWeek', { week: MON }), 'staff');
  assert.equal((await vol.get(`/api/schedule/notices/${told.batch_id}`)).status, 403);
  await runJobs();
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: ['shifts'], deny: [] }));
  const seen = ok(await vol.get(`/api/schedule/notices/${told.batch_id}`), 'granted Shifts');
  assert.deepEqual(seen.people.map((p) => [p.name, p.state, p.email, p.text, p.text_note]), [
    ['Asha Example', 'done', null, null, null], ['Dee Example', 'done', null, null, null], ['Eli Example', 'done', null, null, null],
  ], 'who was told — not how each can or can’t be reached (as on a shift’s own page)');
  assert.ok(!JSON.stringify(seen).includes('@') && !JSON.stringify(seen).includes('555-01'));
  const desk = ok(await staff.get(`/api/schedule/notices/${told.batch_id}`)).people;
  assert.deepEqual(Object.keys(desk[0]).sort(), ['email', 'name', 'person_id', 'state', 'text', 'text_note']);
  assert.deepEqual(desk.map((p) => [p.name, p.email, p.text]), [['Asha Example', 'sent', 'sent'], ['Dee Example', 'sent', 'sent'], ['Eli Example', 'sent', 'sent']]);
  assert.ok(!JSON.stringify(desk).includes('@') && !JSON.stringify(desk).includes('555-01'), 'the desk’s copy has no address or number either');
  assert.equal(ok(await vol.get(`/api/schedule/week?week=${MON}`)).reminders.can_set, false);
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: [], deny: [] }));
  assert.equal((await other.get(`/api/schedule/notices/${told.batch_id}`)).status, 404, 'another campaign');
  assert.equal((await mgr.get('/api/schedule/notices/not-an-id')).status, 404);
});

test('a shift under way still counts: who the count names is who is told', async () => {
  connect();
  emails.length = 0; texts.length = 0;
  // Tuesday 5 pm: the 4–6 pm shift (Dee, Eli) is on now; Wednesday's (Asha) is to come; Monday's is over.
  at('2030-05-08T00:00:00Z');
  const count = ok(await mgr.get(`/api/schedule/week?week=${MON}`));
  assert.deepEqual([count.people, count.shifts], [3, 2]);
  const r = ok(await mgr.action('shift.tellWeek', { week: MON }));
  assert.equal(r.people, 3);
  await runJobs();
  assert.deepEqual((await noticesOf(r.batch_id)).map((n) => [n.name, n.email, n.text]),
    [['Asha Example', 'sent', 'sent'], ['Dee Example', 'sent', 'sent'], ['Eli Example', 'sent', 'sent']]);
  assert.match(emails.find((m) => m.to[0] === P.dee.email).text, /Tuesday, May 7 at 4:00 p\.m\. – 6:00 p\.m\./);
});

test('a long list goes a run at a time: the job hands the rest to the next run, and everyone is told once', async () => {
  connect();
  emails.length = 0; texts.length = 0;
  at('2030-05-08T00:00:00Z');
  _setPerRunForTest(2);
  try {
    const r = ok(await mgr.action('shift.tellWeek', { week: MON }));
    assert.equal(r.people, 3);
    const first = await runDueJobs(db, { workspaceId: ws });
    assert.deepEqual([first.ran, first.failed], [1, 0]);
    assert.deepEqual((await noticesOf(r.batch_id)).map((n) => n.state).sort(), ['asked', 'done', 'done'], 'two told, one waiting for the next run');
    assert.equal((await mgr.action('shift.tellWeek', { week: MON })).status, 409, 'still going out');
    await runJobs();
    assert.deepEqual((await noticesOf(r.batch_id)).map((n) => [n.name, n.state, n.email]), [['Asha Example', 'done', 'sent'], ['Dee Example', 'done', 'sent'], ['Eli Example', 'done', 'sent']]);
    assert.deepEqual(emails.map((m) => m.to[0]).sort(), [P.asha.email, P.dee.email, P.eli.email].sort(), 'each once');
    const runs = await rows(`select status from jobs where workspace_id = $1 and kind = 'schedule.tell' and payload->>'batch_id' = $2`, [ws, r.batch_id]);
    assert.deepEqual(runs.map((j) => j.status), ['done', 'done'], 'the tap’s job and the one that carried on');
  } finally { _setPerRunForTest(null); }
});

test('a slow email service never holds the job runner: the notice sends beside the jobs behind it', async () => {
  connect();
  emails.length = 0; texts.length = 0;
  at('2030-05-08T00:00:00Z');
  // The email service takes its time: each answer waits until the test lets it go.
  let release;
  const gate = new Promise((res) => { release = res; });
  onEmail = async () => { await gate; return new Response('{}', { status: 200 }); };
  try {
    const r = ok(await mgr.action('shift.tellWeek', { week: MON }));
    // The runner's own pass (settle: false) is answered while the emails are still waiting.
    const pass = await Promise.race([
      runDueJobs(db, { workspaceId: ws, settle: false }).then(() => 'answered'),
      new Promise((res) => setTimeout(() => res('held'), 1500)),
    ]);
    assert.equal(pass, 'answered', 'the runner went on to the next job');
    release();
    for (let i = 0; i < 50 && (await noticesOf(r.batch_id)).some((n) => n.state !== 'done'); i += 1) await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual((await noticesOf(r.batch_id)).map((n) => [n.name, n.state, n.email]), [['Asha Example', 'done', 'sent'], ['Dee Example', 'done', 'sent'], ['Eli Example', 'done', 'sent']]);
    for (let i = 0; i < 50 && (await rows(`select 1 from jobs where workspace_id = $1 and kind = 'schedule.tell' and status <> 'done'`, [ws])).length; i += 1) await new Promise((res) => setTimeout(res, 20));
    assert.equal((await rows(`select 1 from jobs where workspace_id = $1 and kind = 'schedule.tell' and status <> 'done'`, [ws])).length, 0, 'and its job is done when they are');
  } finally { release(); onEmail = () => new Response('{}', { status: 200 }); }
});

test('a notice whose job gave up doesn’t block the week: the next tap closes what it left and tells them', async () => {
  connect();
  emails.length = 0; texts.length = 0;
  at('2030-05-08T00:00:00Z');
  const dead = ok(await mgr.action('shift.tellWeek', { week: MON }));
  // Its job is parked as failed before it sent anything.
  await db.query(`update jobs set status = 'failed', done_at = now() where workspace_id = $1 and kind = 'schedule.tell' and payload->>'batch_id' = $2`, [ws, dead.batch_id]);
  const again = ok(await mgr.action('shift.tellWeek', { week: MON }), 'not “still going out”: nothing would ever send it');
  assert.deepEqual((await noticesOf(dead.batch_id)).map((n) => [n.state, n.email, n.text]), Array(3).fill(['done', null, null]), 'closed, and never sent late');
  const closed = await rows(`select payload from events where workspace_id = $1 and action = 'shift.tellWeek' and op = 'update' and payload->>'replaced' = 'true'`, [ws]);
  assert.equal(closed.length, 3, 'on the log');
  await runJobs();
  assert.deepEqual((await noticesOf(again.batch_id)).map((n) => [n.name, n.email]), [['Asha Example', 'sent'], ['Dee Example', 'sent'], ['Eli Example', 'sent']]);
  assert.equal(emails.length, 3, 'each told once');
});

test('reminders are off until a manager turns them on; then 6 pm the evening before, inside the texting hours', async () => {
  const texting = { allow_from: 9, allow_until: 21, weekend_from: 10, weekend_until: 18 };
  assert.equal(remindAt('2030-05-06', texting, TZ), '2030-05-06T18:00:00-07:00', 'a weekday: 6 pm');
  assert.equal(remindAt('2030-05-05', texting, TZ), '2030-05-05T17:00:00-07:00', 'a Sunday: texts stop at 6, so 5 pm');
  assert.equal(remindAt('2030-05-04', texting, TZ), '2030-05-04T17:00:00-07:00', 'a Saturday too');
  assert.equal(remindAt('2030-05-06', { ...texting, allow_from: 19, allow_until: 22 }, TZ), '2030-05-06T19:00:00-07:00', 'hours that open later: when they open');
  assert.equal(remindAt('2030-05-06', { ...texting, allow_until: 12 }, TZ), '2030-05-06T11:00:00-07:00', 'hours that close early: the last hour');
  assert.equal(remindAt('2026-11-15', texting, TZ), '2026-11-15T17:00:00-07:00', 'B.C. is on UTC-7 in November too');

  // Off: nothing is queued, and an evening passing sends nothing.
  connect();
  emails.length = 0; texts.length = 0;
  at('2030-05-06T22:00:00Z'); // Monday 3 pm
  assert.equal((await rows(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'schedule.remind'`, [ws]))[0].n, 0);
  assert.equal((await staff.action('shift.reminders', { on: true })).status, 403, 'a manager’s switch');
  assert.equal((await vol.action('shift.reminders', { on: true })).status, 403);

  // On, at 3 pm on a Monday: this evening's goes at 6, and the evenings after are queued.
  const on = ok(await mgr.action('shift.reminders', { on: true }));
  assert.deepEqual([on.on, new Date(on.next_at).toISOString()], [true, '2030-05-07T01:00:00.000Z']);
  const queued = await rows(`select key, run_at, payload from jobs where workspace_id = $1 and kind = 'schedule.remind' order by run_at`, [ws]);
  assert.deepEqual(queued.map((j) => [j.key, new Date(j.run_at).toISOString()]), [
    ['schedule.remind:2030-05-06', '2030-05-07T01:00:00.000Z'],
    ['schedule.remind:2030-05-07', '2030-05-08T01:00:00.000Z'],
    ['schedule.remind:2030-05-08', '2030-05-09T01:00:00.000Z'],
  ]);
  const state = ok(await mgr.get(`/api/schedule/week?week=${MON}`)).reminders;
  assert.deepEqual([state.on, new Date(state.next_at).toISOString(), state.can_set], [true, '2030-05-07T01:00:00.000Z', true]);
  assert.deepEqual((await rows(`select payload from events where workspace_id = $1 and action = 'shift.reminders' order by seq desc limit 1`, [ws]))[0].payload, { shift_reminders: true });
});

test('the evening before: one reminder a person, once per booking, never to someone who can’t make it', async () => {
  connect();
  emails.length = 0; texts.length = 0;
  // Tuesday May 7: Dee and Eli are on the 4 pm shift (the test above); Asha joins a morning one too, Ben can't make it.
  const early = await shiftOn('2030-05-07', '06:30', '08:30');
  const ashaOn = await book(early, P.asha);
  const tue = (await rows(`select id from shifts where workspace_id = $1 and starts_at = '2030-05-07T16:00:00-07:00' and deleted_at is null`, [ws]))[0];
  await book(tue, P.asha);
  ok(await mgr.action('shift.setStatus', { id: await book(early, P.ben), status: 'declined' }));
  ok(await mgr.action('person.update', { id: P.dee.id, tags: ['do-not-text'] }));

  // 6 pm Monday.
  at('2030-05-07T01:00:05Z');
  await due('2030-05-06');
  sentInWrite = 0;
  await runJobs();
  assert.equal(sentInWrite, 0, 'sent outside any write');
  assert.deepEqual(emails.map((m) => m.to[0]).sort(), [P.asha.email, P.dee.email, P.eli.email].sort(), 'one each — not Ben');
  assert.deepEqual(texts.map((m) => m.To).sort(), ['+16045550151', '+16045550155'], 'not the one marked do not text');
  const asha = emails.find((m) => m.to[0] === P.asha.email);
  assert.equal(asha.subject, 'Tomorrow: your 2 shifts');
  assert.match(asha.text, /^A reminder — you’re on tomorrow:\n\nBurma Shave — King George Blvd & 88 Ave\nTuesday, May 7 at 6:30 a\.m\. – 8:30 a\.m\.[\s\S]*Tuesday, May 7 at 4:00 p\.m\. – 6:00 p\.m\./);
  assert.match(asha.key, /^shift-notice-[0-9a-f-]{36}$/);
  const batch = (await rows(`select distinct batch_id from shift_notices where workspace_id = $1 and kind = 'reminder'`, [ws]));
  assert.equal(batch.length, 1);
  assert.deepEqual((await noticesOf(batch[0].batch_id)).map((n) => [n.name, n.state, n.email, n.text]), [
    ['Asha Example', 'done', 'sent', 'sent'], ['Dee Example', 'done', 'sent', 'opted_out'], ['Eli Example', 'done', 'sent', 'sent'],
  ]);
  const onEarly = ok(await mgr.get(`/api/shifts/${early.id}`)).assignees;
  assert.deepEqual(onEarly.map((a) => [a.name, a.notify_email, a.notify_text]), [['Asha Example', 'sent', 'sent'], ['Ben Example', null, null]]);
  // By nobody: the system's own writes, on the log.
  const events = await rows(`select actor_id, op from events where workspace_id = $1 and action = 'shift.remind' order by seq`, [ws]);
  assert.ok(events.length >= 6 && events.every((e) => e.actor_id === null));
  assert.equal((await rows('select reminded_at from shift_assignments where id = $1', [ashaOn]))[0].reminded_at !== null, true);

  // The same evening run again (a retry, a second server): nobody is reminded twice.
  await db.query(`update jobs set status = 'pending', run_at = now() where workspace_id = $1 and key = 'schedule.remind:2030-05-06'`, [ws]);
  const n = [emails.length, texts.length];
  await runJobs();
  assert.deepEqual([emails.length, texts.length], n, 'once per booking');
  // The next evenings stay queued, one each.
  const keys = (await rows(`select key from jobs where workspace_id = $1 and kind = 'schedule.remind' and status = 'pending' order by run_at`, [ws])).map((j) => j.key);
  assert.deepEqual(keys, ['schedule.remind:2030-05-07', 'schedule.remind:2030-05-08', 'schedule.remind:2030-05-09']);
  ok(await mgr.action('person.update', { id: P.dee.id, tags: [] }));
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('a reminder that runs late keeps to the rules; one that runs on another day sends nothing; off stops them', async () => {
  connect();
  emails.length = 0; texts.length = 0;
  const wed = (await rows(`select id from shifts where workspace_id = $1 and starts_at = '2030-05-08T06:30:00-07:00' and deleted_at is null`, [ws]))[0];
  assert.ok(wed, 'Wednesday’s Burma Shave, with Asha on it');
  // Tuesday's run, held up until 9:30 pm: the email goes, the text is quiet.
  at('2030-05-08T04:30:00Z');
  await due('2030-05-07');
  await runJobs();
  assert.deepEqual([emails.map((m) => m.to[0]), texts.length], [[P.asha.email], 0]);
  const late = (await rows(`select n.text, n.text_note from shift_notices n where n.workspace_id = $1 and n.kind = 'reminder' and n.person_id = $2 order by n.created_at desc limit 1`, [ws, P.asha.id]))[0];
  assert.equal(late.text, 'quiet');

  // Thursday's shift; Wednesday's run only happens on Thursday morning (the server was down): too late to say "tomorrow".
  const thu = await shiftOn('2030-05-09', '06:30', '08:30');
  await book(thu, P.eli);
  at('2030-05-09T15:00:00Z'); // Thursday 8 am
  await due('2030-05-08');
  emails.length = 0;
  await runJobs();
  assert.equal(emails.length, 0, 'nothing sent for a day already here');
  // …but the evenings to come are still queued.
  const pending = (await rows(`select key from jobs where workspace_id = $1 and kind = 'schedule.remind' and status = 'pending' order by run_at`, [ws])).map((j) => j.key);
  assert.deepEqual(pending, ['schedule.remind:2030-05-09', 'schedule.remind:2030-05-10', 'schedule.remind:2030-05-11']);

  // Off: the next evening's run sends nothing and queues nothing after it.
  const fri = await shiftOn('2030-05-10', '16:00', '18:00');
  await book(fri, P.eli);
  const off = ok(await mgr.action('shift.reminders', { on: false }));
  assert.deepEqual([off.on, off.next_at], [false, null]);
  at('2030-05-10T01:00:05Z'); // Thursday 6 pm
  await due('2030-05-09');
  await runJobs();
  assert.equal(emails.length, 0, 'off is off');
  assert.equal(ok(await mgr.get(`/api/schedule/week?week=${MON}`)).reminders.on, false);
  // On again on Friday at 7 pm: this evening's hour has passed, so the first goes on Saturday — at 5, a weekend.
  at('2030-05-11T02:00:00Z');
  const on = ok(await mgr.action('shift.reminders', { on: true }));
  assert.equal(new Date(on.next_at).toISOString(), '2030-05-12T00:00:00.000Z', 'Saturday 5 pm');
  ok(await mgr.action('shift.reminders', { on: false }));
});

test('a second tap while the first notice is still sending — everyone already claimed — is refused: nobody is told twice', async () => {
  connect();
  emails.length = 0; texts.length = 0;
  at('2030-06-02T19:00:00Z'); // Sunday noon, the day before the week of June 3
  const s = await shiftOn('2030-06-04', '06:30', '08:30');
  for (const p of [P.asha, P.ben, P.dee]) await book(s, p);
  const first = ok(await mgr.action('shift.tellWeek', { week: '2030-06-03' }));
  // A slow provider: the job has claimed all three (fewer than a batch) and
  // waits on the first email — so not one row is still 'asked'.
  let release;
  const gate = new Promise((r) => { release = r; });
  onEmail = async () => { await gate; return new Response('{}', { status: 200 }); };
  let sending = null;
  try {
    sending = runJobs();
    for (let i = 0; i < 1000 && !emails.length; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual((await noticesOf(first.batch_id)).map((n) => n.state), ['sending', 'sending', 'sending'], 'all claimed, none waiting');
    const again = await mgr.action('shift.tellWeek', { week: '2030-06-03' });
    assert.equal(again.status, 409, 'a second tap mid-send is refused');
    assert.match(again.json.error, /still going out/);
  } finally {
    release();
    await sending;
    onEmail = () => new Response('{}', { status: 200 });
  }
  await runJobs();
  assert.deepEqual(emails.map((m) => m.to[0]).sort(), [P.asha.email, P.ben.email, P.dee.email].sort(), 'each emailed once');
  assert.deepEqual(texts.map((m) => m.To).sort(), ['+16045550151', '+16045550154'], 'each texted once');
  // Once it has gone, another tap is a new notice.
  ok(await mgr.action('shift.tellWeek', { week: '2030-06-03' }));
  await runJobs();
});

test('with neither email nor texting connected an evening marks nobody as reminded', async () => {
  disconnect();
  emails.length = 0; texts.length = 0;
  const sat = await shiftOn('2030-05-18', '10:00', '12:00');
  const on = await book(sat, P.asha);
  at('2030-05-17T22:00:00Z'); // Friday 3 pm
  ok(await mgr.action('shift.reminders', { on: true }));
  at('2030-05-18T01:00:05Z'); // Friday 6 pm
  await due('2030-05-17');
  await runJobs();
  assert.equal((await rows('select reminded_at from shift_assignments where id = $1', [on]))[0].reminded_at, null, 'still to be reminded, once something is connected');
  assert.equal((await rows(`select count(*)::int as n from shift_notices where workspace_id = $1 and kind = 'reminder' and assignment_ids @> $2::jsonb`, [ws, JSON.stringify([on])]))[0].n, 0);
  assert.deepEqual(ok(await mgr.get('/api/schedule/week?week=2030-05-18')).providers, { email: false, text: false }, 'and the week says what is missing');
  ok(await mgr.action('shift.reminders', { on: false }));
});
