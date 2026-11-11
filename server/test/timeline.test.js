// One history per person (server/ext/timeline): GET /api/persons/:id/timeline.
//   · every source lands on the one list once, newest first, in the words
//     the screens use — knocks and calls (an outside dialer's too), texts,
//     emails with their first open and click, a ladder's email, website
//     forms, gifts with their voids and refunds, memberships, shifts, survey
//     answers, signs, voted marks, yes and no to email and texts, a merge;
//   · each role sees what its own reads already give it: a volunteer never a
//     gift, an email, a website form, an answer or anyone else's texts;
//     money only for money roles, and never for one denied Donations;
//   · pages (a cursor, however many share one moment) and the chips' groups;
//   · bounces and spam complaints once those columns exist, and without them;
//   · every read finds one person's rows through an index, and a person with
//     thousands of contacts stays quick.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { campaign, member } from './site-helpers.js';
import { Client } from './helpers.js';
import { seedHistory } from './timeline-seed.js';

let db, mgr, ws, mgrId, S;
let vol, staff, treasurer, otherVol, noMoney, noOutreach, granted;
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const line = (j) => ok(j).entries.map((e) => [e.kind, e.title]);
const all = (who, id = S.dev.id, q = '') => who.get(`/api/persons/${id}/timeline?limit=100${q}`);
const kinds = (j) => [...new Set(j.entries.map((e) => e.kind))].sort();

before(async () => {
  ({ db, mgr, ws, user: { id: mgrId } } = await campaign());
  vol = await member(mgr, 'volunteer', 'Sam Volunteer');
  otherVol = await member(mgr, 'volunteer', 'Uma Volunteer');
  staff = await member(mgr, 'staff', 'Stef Staff');
  treasurer = await member(mgr, 'treasurer', 'Tess Treasurer');
  noMoney = await member(mgr, 'staff', 'Nia Staff');
  noOutreach = await member(mgr, 'staff', 'Omar Staff');
  granted = await member(mgr, 'volunteer', 'Gus Volunteer');
  ok(await mgr.action('permission.member.set', { user_id: noMoney.id, grant: [], deny: ['money'] }));
  ok(await mgr.action('permission.member.set', { user_id: noOutreach.id, grant: [], deny: ['outreach'] }));
  ok(await mgr.action('permission.member.set', { user_id: granted.id, grant: ['people', 'money', 'outreach'], deny: [] }));
  S = await seedHistory({ db, mgr, mgrId, vol: vol.client, volId: vol.id, ws });
});

test('a manager: every source once, newest first, in the screens’ words', async () => {
  const j = ok(await all(mgr));
  assert.deepEqual(j.entries.map((e) => [e.kind, e.title]), S.expected);
  assert.equal(j.next, null, 'all of it fits one page of 100');
  assert.deepEqual(j.groups, ['field', 'messages', 'website', 'money', 'shifts']);
  // Newest first, each with a time and an id of its own.
  const times = j.entries.map((e) => Date.parse(e.at));
  assert.ok(times.every((t, i) => Number.isFinite(t) && (i === 0 || times[i - 1] >= t)), 'in order');
  assert.equal(new Set(j.entries.map((e) => e.id)).size, j.entries.length);
  const of = (kind, title) => j.entries.find((e) => e.kind === kind && (!title || e.title === title));

  // History's own entries, worded as they were: the channel, the outcome
  // or the rating, who logged it, the note.
  const knock = of('door', 'Rated 2');
  assert.deepEqual([knock.group, knock.label, knock.rating, knock.by, knock.detail], ['field', 'Door', '2', 'Avery Chen', 'Wants a lawn sign']);
  assert.deepEqual([of('door', 'No answer').label, of('door', 'No answer').detail, of('door', 'No answer').by], ['Door', 'From an imported list', null]);
  assert.deepEqual([of('in_person').label, of('in_person').title, of('in_person').detail], ['In person', 'Talked', 'At the market']);
  assert.deepEqual([of('mainstreet').label, of('mainstreet').rating, of('mainstreet').by], ['Mainstreeting', '1', 'Sam Volunteer']);
  // A call an outside dialer logged says so.
  assert.deepEqual([of('phone', 'Talked').label, of('phone', 'Talked').by, of('phone', 'Talked').detail], ['Phone', 'CallHub', 'Will vote early']);
  assert.equal(of('phone', 'No answer').by, 'Sam Volunteer');

  const answers = of('answers');
  assert.deepEqual([answers.group, answers.label, answers.detail, answers.link], ['field', 'Survey', 'Will you take a sign? Yes · Top issue? Transit', '#answers']);
  assert.deepEqual([of('sign', 'Asked for · Lawn sign').by, of('sign', 'Asked for · Lawn sign').detail, of('sign', 'Put up · Lawn sign').by], ['Sam Volunteer', 'By the driveway', 'Avery Chen']);
  assert.equal(of('sign').link, '#signs');
  assert.deepEqual([of('voted').label, of('voted').detail, of('voted').by], ['Voted', 'At the door', 'Sam Volunteer']);

  // Messages: texts with their words and thread, emails with their subject.
  const out = of('text_out', 'Delivered');
  assert.deepEqual([out.group, out.label, out.by, out.link], ['messages', 'Text', 'Avery Chen', `/inbox/${S.mgrThread}`]);
  assert.match(out.detail, /^Hi Dev, it’s Avery/);
  assert.deepEqual([of('text_in').detail, of('text_in').by], ['Yes please', null]);
  const emails = j.entries.filter((e) => e.kind === 'email').map((e) => e.detail);
  assert.deepEqual(emails, ['Welcome, Dev · New subscribers', 'Canvass this Saturday', 'October update']);
  assert.deepEqual([of('email_open').detail, of('email_click').detail], ['October update', 'October update · example.org/october']);
  assert.ok(j.entries.filter((e) => e.kind.startsWith('email')).every((e) => e.group === 'messages' && e.label === 'Email'));
  assert.deepEqual(j.entries.filter((e) => e.kind === 'consent').map((e) => [e.label, e.group]), [['Email', 'messages'], ['Text', 'messages'], ['Email', 'messages']]);

  // The website, by kind.
  assert.deepEqual(j.entries.filter((e) => e.kind === 'web').map((e) => [e.label, e.group]), Array(3).fill(['Website', 'website']));
  assert.equal(of('web', 'Sent a message').detail, 'Transit: When does the 96 B-Line run late?');

  // Money: gifts, a void, a refund, memberships.
  assert.deepEqual([of('gift', '$100.00 · Cheque').detail, of('gift', '$100.00 · Cheque').day, of('gift', '$100.00 · Cheque').link], ['At the spring dinner', true, '#gifts']);
  assert.ok(['gift', 'gift_void', 'refund', 'member', 'member_end'].every((k) => j.entries.filter((e) => e.kind === k).every((e) => e.group === 'money')));
  assert.equal(j.entries.filter((e) => e.kind === 'gift_void').length, 1, 'a refunded gift has its refund, not a second void');
  assert.equal(of('member', 'Joined · 1 year').by, 'Avery Chen');
  assert.match(of('member', 'Joined · 1 year').detail, /^To \w{3} \d{1,2}, \d{4} · Paper form$/);
  assert.equal(of('member_end').day, true);

  // Shifts link to the shift; a merge says who did it.
  assert.deepEqual([of('shift_came').link, of('shift_came').group, of('shift_came').label], [`/shifts/${S.cameTo.id}`, 'shifts', 'Shift']);
  assert.match(of('shift_booked', 'Booked · Phone night').detail, /^\w{3}, \w{3} \d{1,2} · Newton Library$/);
  assert.deepEqual([of('merge').by, of('merge').detail, of('merge').group, of('merge').label], ['Avery Chen', 'With the record for Dev Exampel', 'other', 'Record']);
});

test('the desk’s other roles see what a manager sees', async () => {
  assert.deepEqual(line(await all(staff.client)), S.expected);
  assert.deepEqual(line(await all(treasurer.client)), S.expected);
});

test('a volunteer: knocks and calls, signs, shifts, voted marks and their own texts — nothing else', async () => {
  const j = ok(await all(vol.client));
  assert.deepEqual(kinds(j), ['door', 'in_person', 'mainstreet', 'phone', 'shift_booked', 'shift_came', 'shift_missed', 'sign', 'text_out', 'voted']);
  assert.deepEqual(j.groups, ['field', 'messages', 'shifts']);
  // Their own thread only: never the manager's texts with the same person.
  assert.deepEqual(j.entries.filter((e) => e.group === 'messages').map((e) => [e.kind, e.link]), [['text_out', `/inbox/${S.volThread}`]]);
  // Who marked a vote and who put up a sign are the desk's to see.
  assert.equal(j.entries.find((e) => e.kind === 'voted').by, null);
  assert.ok(j.entries.filter((e) => e.kind === 'sign').every((e) => e.by === null));
  // What a profile already gives them: who knocked, and the note.
  assert.equal(j.entries.find((e) => e.kind === 'door' && e.title === 'Rated 2').detail, 'Wants a lawn sign');
  const text = JSON.stringify(j);
  for (const never of ['dev@example.org', '$', 'Cheque', 'October update', 'B-Line', 'Top issue', 'Unsubscribed', 'Exampel', 'Joined', 'Welcome']) {
    assert.ok(!text.includes(never), `a volunteer never receives “${never}”`);
  }
  // Another volunteer has no texts with them at all.
  const other = ok(await all(otherVol.client));
  assert.ok(!other.entries.some((e) => e.group === 'messages'));
  // A chip that isn't theirs is refused, not answered empty.
  for (const g of ['money', 'website']) assert.equal((await all(vol.client, S.dev.id, `&group=${g}`)).status, 403, g);
});

test('a volunteer given areas still gets a volunteer’s history', async () => {
  const j = ok(await all(granted.client));
  assert.deepEqual(j.groups, ['field', 'messages', 'shifts']);
  assert.ok(!j.entries.some((e) => ['money', 'website', 'other'].includes(e.group)));
  assert.ok(!j.entries.some((e) => e.group === 'messages'), 'no texts of their own with Dev');
});

test('money only for money roles: staff denied Donations get no gift, refund or membership', async () => {
  const j = ok(await all(noMoney.client));
  assert.deepEqual(j.groups, ['field', 'messages', 'website', 'shifts']);
  assert.ok(!j.entries.some((e) => e.group === 'money'));
  assert.deepEqual(j.entries.map((e) => [e.kind, e.title]), S.expected.filter(([k]) => !['gift', 'gift_void', 'refund', 'member', 'member_end'].includes(k)));
  assert.equal((await all(noMoney.client, S.dev.id, '&group=money')).status, 403);
  assert.ok(!JSON.stringify(j).includes('$'));
});

test('texts and emails are Outreach’s: staff denied it get neither', async () => {
  const j = ok(await all(noOutreach.client));
  assert.deepEqual(j.groups, ['field', 'website', 'money', 'shifts']);
  assert.ok(!j.entries.some((e) => e.group === 'messages'));
});

test('the money forms on the website are money too', async () => {
  // A donation form sent (its checkout never paid): the action alone.
  await db.query(
    `insert into site_actions (id, workspace_id, person_id, kind, payload, created_at)
     values ($1, $2, $3, 'donate', $4, now() - interval '46 days')`,
    [randomUUID(), ws, S.dev.id, JSON.stringify({ amount_cents: 2500, cadence: 'monthly' })],
  );
  const form = (j) => j.entries.find((e) => e.kind === 'web' && e.title === 'Filled in the donation form');
  assert.deepEqual([form(ok(await all(mgr))).detail, form(ok(await all(mgr))).group], ['$25.00 a month', 'website']);
  assert.equal(form(ok(await all(noMoney.client))), undefined);
  await db.query("delete from site_actions where workspace_id = $1 and kind = 'donate'", [ws]);
});

test('someone else’s campaign, a person who is gone, a bad id: not found', async () => {
  const stranger = new Client();
  await stranger.signup({ workspaceName: 'Another campaign' });
  assert.equal((await all(stranger)).status, 404);
  assert.equal((await all(mgr, S.twin.id)).status, 404, 'the record that was merged away');
  assert.equal((await all(mgr, 'not-an-id')).status, 404);
  assert.equal((await new Client().get(`/api/persons/${S.dev.id}/timeline`)).status, 401);
});

test('pages: a cursor walks the whole history once, whatever the page size', async () => {
  for (const size of [1, 4, 7, 50]) {
    const seen = [];
    let before = '';
    for (let i = 0; i < 100; i += 1) {
      const j = ok(await mgr.get(`/api/persons/${S.dev.id}/timeline?limit=${size}${before}`));
      assert.ok(j.entries.length <= size);
      seen.push(...j.entries);
      if (!j.next) break;
      assert.equal(j.entries.length, size, 'a page with more to come is full');
      before = `&before=${encodeURIComponent(j.next)}`;
    }
    assert.deepEqual(seen.map((e) => [e.kind, e.title]), S.expected, `pages of ${size}`);
    assert.equal(new Set(seen.map((e) => e.id)).size, S.expected.length);
  }
  assert.equal((await mgr.get(`/api/persons/${S.dev.id}/timeline?before=nonsense`)).status, 400);
  assert.equal(ok(await mgr.get(`/api/persons/${S.dev.id}/timeline`)).entries.length, S.expected.length, '50 a page unless asked');
});

test('the chips: each group alone, in order, and All holds them all', async () => {
  const whole = ok(await all(mgr)).entries;
  const counts = {};
  for (const g of ['field', 'messages', 'website', 'money', 'shifts']) {
    const j = ok(await all(mgr, S.dev.id, `&group=${g}`));
    assert.ok(j.entries.length > 0 && j.entries.every((e) => e.group === g), g);
    assert.deepEqual(j.entries.map((e) => e.id), whole.filter((e) => e.group === g).map((e) => e.id), `${g}: the same entries, the same order`);
    counts[g] = j.entries.length;
  }
  assert.deepEqual(counts, { field: 11, messages: 11, website: 3, money: 8, shifts: 4 });
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0) + 1, whole.length, 'and the merge, under All only');
  assert.deepEqual(ok(await all(mgr, S.dev.id, '&group=all')).entries.map((e) => e.id), whole.map((e) => e.id));
  assert.equal((await all(mgr, S.dev.id, '&group=bogus')).status, 400);
});

test('bounced and marked as spam: shown once the email service’s columns exist, quiet without them', async () => {
  const { forgetEmailColumns } = await import('../ext/timeline/sources.js');
  const cols = async () => (await db.query(
    `select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'blast_recipients' and column_name in ('bounced_at', 'complained_at')`,
  )).rows.length;
  const emailKinds = async () => kinds(ok(await all(mgr, S.dev.id, '&group=messages'))).filter((k) => k.startsWith('email'));
  if (await cols() === 0) {
    // As main is today: no such columns, and the history reads as before.
    assert.deepEqual(await emailKinds(), ['email', 'email_click', 'email_open']);
    await db.exec(`alter table blast_recipients add column if not exists bounced_at timestamptz;
                   alter table blast_recipients add column if not exists bounce_detail text;
                   alter table blast_recipients add column if not exists complained_at timestamptz;`);
    forgetEmailColumns();
  }
  assert.equal(await cols(), 2);
  // The columns are there and empty: nothing new to say.
  assert.deepEqual(await emailKinds(), ['email', 'email_click', 'email_open']);
  await db.query(
    `update blast_recipients set bounced_at = sent_at + interval '5 minutes', bounce_detail = 'Mailbox full' where id = $1`, [S.listRow.id],
  );
  await db.query(`update blast_recipients set complained_at = sent_at + interval '3 hours' where id = $1`, [S.newsRow.id]);
  const j = ok(await all(mgr, S.dev.id, '&group=messages'));
  const said = j.entries.filter((e) => ['email_bounce', 'email_spam'].includes(e.kind)).map((e) => [e.kind, e.label, e.title, e.detail]);
  assert.deepEqual(said, [
    ['email_bounce', 'Email', 'Bounced', 'Canvass this Saturday · Mailbox full'],
    ['email_spam', 'Email', 'Marked as spam', 'October update'],
  ]);
  // In its place in time: just after the send it is about.
  const ids = j.entries.map((e) => e.kind);
  assert.ok(ids.indexOf('email_spam') < ids.indexOf('email_click') && ids.indexOf('email_bounce') < ids.lastIndexOf('email'));
  assert.ok(!ok(await all(vol.client)).entries.some((e) => e.kind.startsWith('email')), 'still never a volunteer’s');
  await db.query('update blast_recipients set bounced_at = null, bounce_detail = null, complained_at = null where workspace_id = $1', [ws]);
});

test('one person’s rows come through an index, never a walk over everyone’s', async () => {
  const { SOURCES } = await import('../ext/timeline/sources.js');
  const asked = [];
  const recording = { query: (sql, params) => { asked.push({ sql, params }); return db.query(sql, params); } };
  const viewer = { desk: true, money: true, outreach: true, userId: mgrId };
  for (const s of SOURCES) await s.read(recording, { ws, person: { id: S.dev.id, name: 'Dev Example', email: 'dev@example.org' }, viewer, before: null, limit: 51, tz: 'America/Vancouver', campaign: 'Imagine Surrey' });
  // (Which delivery columns exist is asked once and remembered: not a person's read.)
  const seen = asked.filter((s) => !/information_schema/.test(s.sql));
  assert.equal(seen.length, SOURCES.length, 'one read per source');
  const BIG = ['persons', 'contacts', 'blast_recipients', 'events', 'texting_messages', 'texting_conversations', 'site_actions', 'consent_events',
    'gifts', 'stripe_payments', 'member_terms', 'shift_assignments', 'survey_responses', 'signs', 'voted_marks', 'ladder_runs'];
  for (const s of seen) {
    const plan = await db.transaction(async (tx) => {
      await tx.query('set local enable_seqscan = off');
      return (await tx.query(`explain ${s.sql}`, s.params)).rows.map((r) => Object.values(r)[0]).join('\n');
    });
    for (const t of BIG) assert.ok(!new RegExp(`Seq Scan on ${t}\\b`).test(plan), `${t} is read through an index:\n${s.sql.replace(/\s+/g, ' ').slice(0, 200)}\n${plan}`);
  }
});

test('a person with thousands of contacts, among many people’s: the first page stays quick', async () => {
  const busy = ok(await mgr.action('person.create', { name: 'Busy Example' })).person;
  // 20,000 other people with three contacts each, and 5,000 on this one.
  await db.query(
    `insert into persons (id, workspace_id, name) select gen_random_uuid(), $1, 'Voter ' || g || ' Example' from generate_series(1, 20000) g`, [ws],
  );
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, created_at)
     select gen_random_uuid(), $1, p.id, 'door', 'no_answer', now() - make_interval(days => k)
       from persons p cross join generate_series(1, 3) k where p.workspace_id = $1 and p.name like 'Voter %'`, [ws],
  );
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, note, created_at)
     select gen_random_uuid(), $1, $2, case when g % 2 = 0 then 'door' else 'phone' end, 'no_answer', 'Try ' || g, now() - make_interval(mins => g)
       from generate_series(1, 5000) g`, [ws, busy.id],
  );
  await db.query('analyze contacts');
  const t0 = performance.now();
  const first = ok(await mgr.get(`/api/persons/${busy.id}/timeline`));
  const firstMs = performance.now() - t0;
  assert.equal(first.entries.length, 50);
  assert.deepEqual(first.entries.slice(0, 3).map((e) => e.detail), ['Try 1', 'Try 2', 'Try 3']);
  const t1 = performance.now();
  const second = ok(await mgr.get(`/api/persons/${busy.id}/timeline?before=${encodeURIComponent(first.next)}`));
  const secondMs = performance.now() - t1;
  assert.deepEqual(second.entries.slice(0, 2).map((e) => e.detail), ['Try 51', 'Try 52']);
  console.log(`  5,000 contacts on one person: first page ${Math.round(firstMs)} ms, next page ${Math.round(secondMs)} ms`);
  // Generous for the in-memory database (several times slower than a hosted one).
  const budget = Number(process.env.TIMELINE_MS) || 1500;
  assert.ok(firstMs < budget && secondMs < budget, `first ${Math.round(firstMs)} ms, next ${Math.round(secondMs)} ms`);
  // The read itself, as the database chooses to run it with nothing forced:
  // this person's contacts through their own index, never everyone's.
  const { SOURCES } = await import('../ext/timeline/sources.js');
  let sent = null;
  await SOURCES.find((s) => s.key === 'contacts').read(
    { query: (sql, params) => { sent = { sql, params }; return db.query(sql, params); } },
    { ws, person: busy, viewer: { desk: true }, before: null, limit: 51, tz: 'America/Vancouver', campaign: '' },
  );
  const plan = (await db.query(`explain ${sent.sql}`, sent.params)).rows.map((r) => Object.values(r)[0]).join('\n');
  assert.match(plan, /contacts_ws_person_idx/, plan);
  assert.doesNotMatch(plan, /Seq Scan on contacts/, plan);
});

test('the indexes this feature adds are there', async () => {
  const names = (await db.query(
    `select indexname from pg_indexes where schemaname = current_schema() and indexname = any($1::text[])`,
    [['gifts_ws_person_idx', 'signs_ws_person_idx', 'sassign_ws_person_idx', 'brecip_ws_person_idx', 'brecip_ws_email_idx', 'stripe_payments_person_idx']],
  )).rows.map((r) => r.indexname).sort();
  assert.deepEqual(names, ['brecip_ws_email_idx', 'brecip_ws_person_idx', 'gifts_ws_person_idx', 'sassign_ws_person_idx', 'signs_ws_person_idx', 'stripe_payments_person_idx']);
});
