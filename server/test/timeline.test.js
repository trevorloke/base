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
  assert.deepEqual([of('merge').by, of('merge').detail, of('merge').group, of('merge').label], ['Avery Chen', 'With the record for Dev Exampel', 'other', 'Merged']);
});

test('an entry leads to Gifts only when Gifts lists its gift: never one voided, refunded or never booked', async () => {
  const links = async () => ok(await all(mgr, S.dev.id, '&group=money')).entries.map((e) => [e.title, e.link]);
  // The profile's Gifts lists the gifts on the books: the cheque. The cash
  // voided and the card refunded are off it, so their entries lead nowhere.
  assert.deepEqual(await links(), [
    ['Renewed · 4 years', null], ['Membership ended', null], ['Refunded · $200.00', null], ['$200.00 · Card · void', null],
    ['Voided · $50.00', null], ['$50.00 · Cash · void', null], ['$100.00 · Cheque', '#gifts'], ['Joined · 1 year', null],
  ]);
  // A payment whose gift is still on the books (its dispute still open)
  // leads to it; one over the limit, never booked as a gift, doesn't.
  const disputed = randomUUID();
  const over = randomUUID();
  await db.query(
    `insert into stripe_payments (id, workspace_id, person_id, gift_id, kind, cadence, amount_cents, paid_at, paid_on, status, over_limit)
     values ($1, $2, $3, $4, 'donation', 'once', 10000, now() - interval '2 days', current_date - 2, 'disputed', false),
            ($5, $2, $3, null, 'donation', 'once', 150000, now() - interval '2 days', current_date - 2, 'over_limit', true)`,
    [disputed, ws, S.dev.id, S.cheque.id, over],
  );
  try {
    const pay = ok(await all(mgr, S.dev.id, '&group=money')).entries.filter((e) => e.id.startsWith('pay:'));
    assert.deepEqual(Object.fromEntries(pay.map((e) => [e.title, e.link])), {
      'Disputed · $100.00': '#gifts', 'Over the limit — refunding · $1,500.00': null, 'Refunded · $200.00': null,
    });
  } finally {
    await db.query('delete from stripe_payments where id = any($1::uuid[])', [[disputed, over]]);
  }
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
  // A cursor made by hand whose time the database can't read back (a year
  // outside 0001–9999, or not the time a page gives) is refused like any
  // other bad cursor, never a 500; the years it can read, it reads.
  const page = (at) => mgr.get(`/api/persons/${S.dev.id}/timeline?before=${encodeURIComponent(`${at}~x`)}`);
  for (const at of ['+010000-01-01T00:00:00Z', '-000001-01-01T00:00:00Z', '+275760-01-01T00:00:00Z', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59-01:00', 'Nov 11 2026']) {
    assert.equal((await page(at)).status, 400, at);
  }
  assert.deepEqual(ok(await page('0001-01-01T00:00:00.000Z')).entries, []);
  assert.equal(ok(await page('9999-12-31T23:59:59.999Z')).entries.length, S.expected.length);
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
  // Without the columns (a campaign whose email service doesn't report back;
  // where that feature adds them at boot, they are taken away for this part).
  await db.exec(`alter table blast_recipients drop column if exists bounced_at;
                 alter table blast_recipients drop column if exists bounce_detail;
                 alter table blast_recipients drop column if exists complained_at;`);
  forgetEmailColumns();
  assert.equal(await cols(), 0);
  assert.deepEqual(await emailKinds(), ['email', 'email_click', 'email_open'], 'the history reads as it did');
  // With them, as the email service's feature adds them.
  await db.exec(`alter table blast_recipients add column if not exists bounced_at timestamptz;
                 alter table blast_recipients add column if not exists bounce_detail text;
                 alter table blast_recipients add column if not exists complained_at timestamptz;`);
  forgetEmailColumns();
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
  // The email service's own doors to "no" say where it came from (a spam
  // complaint ends the yes; an unsubscribe in Mailchimp comes back).
  const { runAction } = await import('../lib/events.js');
  const { recordConsent } = await import('../ext/site/consent.js');
  const wordsFor = async (source) => {
    const { result: id } = await runAction(db, { workspaceId: ws, actorId: null, action: 'test.consent' }, (tx, emit) => recordConsent(
      tx, ws, { personId: S.dev.id, channel: 'email', granted: false, source, address: 'dev@example.org' }, emit,
    ));
    const found = ok(await all(mgr, S.dev.id, '&group=messages')).entries.find((e) => e.id === `consent:${id}`);
    await db.query('delete from consent_events where id = $1', [id]);
    return found && [found.label, found.title];
  };
  assert.deepEqual(await wordsFor('complaint'), ['Email', 'Off the email list — marked as spam']);
  assert.deepEqual(await wordsFor('mailchimp-unsubscribe'), ['Email', 'Unsubscribed in Mailchimp']);
  assert.deepEqual(await wordsFor('desk-removed'), ['Email', 'Taken off the email list']);
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

// Each big table's read must find the one person (or the one row it joins
// to) through its index: an index condition on these, never the campaign
// alone and never a walk over the table.
const STRAIGHT_TO = {
  persons: /\bid = /, contacts: /person_id = /, survey_responses: /person_id = /, signs: /person_id = /, events: /entity_id = /,
  voted_marks: /person_id = /, texting_conversations: /person_id = /, texting_messages: /conversation_id = /,
  blast_recipients: /person_id = |lower\(/, ladder_runs: /person_id = /, consent_events: /person_id = /, site_actions: /person_id = /,
  gifts: /person_id = |\bid = /, stripe_payments: /person_id = |gift_id = /, member_terms: /person_id = /, shift_assignments: /person_id = /,
};
// The plan's scans: [{ table, index, cond }] (a seq scan has no index).
const scansOf = (plan) => {
  const lines = plan.split('\n');
  const out = [];
  let heap = null;
  lines.forEach((l, i) => {
    const seq = l.match(/Seq Scan on (\w+)/);
    if (seq) out.push({ table: seq[1], index: null, cond: '' });
    heap = l.match(/Bitmap Heap Scan on (\w+)/)?.[1] ?? heap;
    const ix = l.match(/Index (?:Only )?Scan(?: Backward)? using (\w+) on (\w+)/) || l.match(/Bitmap Index Scan on (\w+)()/);
    if (!ix) return;
    const rest = lines.slice(i + 1);
    const next = rest.findIndex((x) => /^\s*->\s/.test(x));
    const cond = (next === -1 ? rest : rest.slice(0, next)).find((x) => /Index Cond:/.test(x)) || '';
    out.push({ table: ix[2] || heap, index: ix[1], cond });
  });
  return out;
};

test('a person with thousands of contacts, among 20,000 people with histories of their own: quick, and each read goes straight to them', async () => {
  const busy = { ...ok(await mgr.action('person.create', { name: 'Busy Example', email: 'busy@example.org' })).person, email: 'busy@example.org' };
  // 20,000 other people with three contacts each, and 5,000 on this one.
  await db.query(
    `insert into persons (id, workspace_id, name, email) select gen_random_uuid(), $1, 'Voter ' || g || ' Example', 'voter' || g || '@example.org' from generate_series(1, 20000) g`, [ws],
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
  // Everyone else's gifts, signs (each on the log), shifts, emails (to a
  // list, and the newsletter's to an address), forms, yes and no, texts,
  // answers, ladders, memberships, voted marks, refunds and log events —
  // and one of each for them.
  const voters = `select id, email, row_number() over (order by name) as n from persons where workspace_id = $1 and name like 'Voter %'`;
  const seq0 = Number((await db.query('select coalesce(max(seq), 0) + 1000000 as s from events where workspace_id = $1', [ws])).rows[0].s);
  for (const sql of [
    `insert into gifts (id, workspace_id, person_id, amount_cents, date, method, cadence)
       select gen_random_uuid(), $1, v.id, 5000, current_date - 30, 'cheque', 'one-time' from (${voters}) v where v.n % 10 = 0
       union all select gen_random_uuid(), $1, $2, 2500, current_date - 3, 'cash', 'one-time'`,
    `insert into signs (id, workspace_id, person_id, kind, status)
       select gen_random_uuid(), $1, v.id, 'lawn', 'installed' from (${voters}) v where v.n % 10 = 1
       union all select gen_random_uuid(), $1, $2, 'lawn', 'installed'`,
    `insert into events (workspace_id, seq, action, entity_type, entity_id, op, payload, payload_hash, hash)
       select $1, ${seq0} + row_number() over (), case when k = 0 then 'sign.place' else 'sign.update' end, 'sign', s.id,
              case when k = 0 then 'create' else 'update' end, case when k = 0 then '{}'::jsonb else '{"status":"installed"}'::jsonb end, 'x', 'x'
         from signs s join persons p on p.id = s.person_id cross join (values (0), (1)) v(k)
        where s.workspace_id = $1 and (p.name like 'Voter %' or p.id = $2)`,
    `insert into events (workspace_id, seq, action, entity_type, entity_id, op, payload, payload_hash, hash)
       select $1, ${seq0} + 100000 + v.n, 'person.update', 'person', v.id, 'update', '{}', 'x', 'x' from (${voters}) v where $2::uuid is not null`,
    `insert into shifts (id, workspace_id, title, starts_at) select gen_random_uuid(), $1, 'Shift ' || g, now() - make_interval(days => g) from generate_series(1, 10) g where $2::uuid is not null`,
    `insert into shift_assignments (id, workspace_id, shift_id, person_id, status)
       select gen_random_uuid(), $1, s.id, v.id, 'completed' from (${voters}) v cross join (select id from shifts where workspace_id = $1 and title like 'Shift %') s where v.n % 100 = 2
       union all select gen_random_uuid(), $1, (select id from shifts where workspace_id = $1 and title = 'Shift 1'), $2, 'completed'`,
    `insert into blasts (id, workspace_id, kind, subject, body, status, sent_at)
       select gen_random_uuid(), $1, k, 'Bulk ' || k, 'Hello', 'sent', now() - interval '20 days' from unnest(array['eblast', 'eblast', 'newsletter']) k where $2::uuid is not null`,
    `insert into blast_recipients (id, workspace_id, blast_id, email, person_id, status, sent_at)
       select gen_random_uuid(), $1, b.id, v.email, v.id, 'sent', now() - interval '20 days'
         from (select id from blasts where workspace_id = $1 and subject = 'Bulk eblast') b cross join (${voters}) v where v.n % 2 = 0
       union all select gen_random_uuid(), $1, b.id, 'busy@example.org', $2, 'sent', now() - interval '20 days' from blasts b where b.workspace_id = $1 and b.subject = 'Bulk eblast'`,
    `insert into blast_recipients (id, workspace_id, blast_id, email, status, sent_at)
       select gen_random_uuid(), $1, b.id, v.email, 'sent', now() - interval '10 days'
         from (select id from blasts where workspace_id = $1 and subject = 'Bulk newsletter') b cross join (${voters}) v where v.n % 4 = 3 and $2::uuid is not null
       union all select gen_random_uuid(), $1, b.id, 'busy@example.org', 'sent', now() - interval '10 days' from blasts b where b.workspace_id = $1 and b.subject = 'Bulk newsletter'`,
    `insert into site_actions (id, workspace_id, person_id, kind, payload)
       select gen_random_uuid(), $1, v.id, 'petition', '{}'::jsonb from (${voters}) v where v.n % 10 = 4
       union all select gen_random_uuid(), $1, $2, 'contact', '{"message":"Hello"}'::jsonb`,
    `insert into consent_events (id, workspace_id, person_id, channel, granted, source)
       select gen_random_uuid(), $1, v.id, 'email', true, 'website-newsletter' from (${voters}) v where v.n % 10 = 5
       union all select gen_random_uuid(), $1, $2, 'sms', false, 'text-stop'`,
    `insert into texting_conversations (id, workspace_id, person_id, phone)
       select gen_random_uuid(), $1, v.id, '+16045550100' from (${voters}) v where v.n % 20 = 6
       union all select gen_random_uuid(), $1, $2, '+16045550199'`,
    `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status)
       select gen_random_uuid(), $1, c.id, 'out', c.phone, 'Hi ' || k, 'delivered' from texting_conversations c cross join generate_series(1, 3) k
        where c.workspace_id = $1 and $2::uuid is not null and c.phone in ('+16045550100', '+16045550199')`,
    `insert into voted_marks (id, workspace_id, person_id, source)
       select gen_random_uuid(), $1, v.id, 'door' from (${voters}) v where v.n % 10 = 7
       union all select gen_random_uuid(), $1, $2, 'desk'`,
    `insert into member_terms (id, workspace_id, person_id, term_years, starts_on, ends_on, source)
       select gen_random_uuid(), $1, v.id, 1, current_date - 400, current_date - 35, 'paper' from (${voters}) v where v.n % 20 = 8
       union all select gen_random_uuid(), $1, $2, 4, current_date - 30, current_date + 1400, 'website'`,
    `insert into stripe_payments (id, workspace_id, person_id, kind, cadence, amount_cents, paid_at, paid_on, status, refunded_cents)
       select gen_random_uuid(), $1, v.id, 'donation', 'once', 2000, now() - interval '9 days', current_date - 9, 'refunded', 2000 from (${voters}) v where v.n % 50 = 9
       union all select gen_random_uuid(), $1, $2, 'donation', 'once', 2000, now() - interval '9 days', current_date - 9, 'refunded', 2000`,
    `insert into events (workspace_id, seq, action, entity_type, entity_id, op, payload, payload_hash, hash)
       select $1, ${seq0} + 200000 + row_number() over (), 'payment.refunded', 'payment', sp.id, 'update', '{"status":"refunded"}', 'x', 'x'
         from stripe_payments sp join persons p on p.id = sp.person_id where sp.workspace_id = $1 and (p.name like 'Voter %' or p.id = $2)`,
    `with s as (insert into surveys (id, workspace_id, name) values (gen_random_uuid(), $1, 'Bulk survey') returning id),
          q as (insert into survey_questions (id, workspace_id, survey_id, kind, text) select gen_random_uuid(), $1, s.id, 'yesno', 'Sign?' from s returning id, survey_id)
     insert into survey_responses (id, workspace_id, survey_id, question_id, contact_id, person_id, value)
       select gen_random_uuid(), $1, q.survey_id, q.id, c.id, c.person_id, 'true' from q
         cross join (select distinct on (c.person_id) c.id, c.person_id from contacts c join persons p on p.id = c.person_id
                      where c.workspace_id = $1 and (p.name like 'Voter %' or p.id = $2) order by c.person_id, c.created_at) c`,
    `with l as (insert into ladders (id, workspace_id, name, trigger_kind, steps) values (gen_random_uuid(), $1, 'Bulk ladder', 'newsletter', '[{"kind":"email","subject":"Hello"}]') returning id)
     insert into ladder_runs (id, workspace_id, ladder_id, person_id, status, log)
       select gen_random_uuid(), $1, l.id, v.id, 'done', '[{"step":0,"kind":"email","result":"sent","at":"2026-10-01T17:00:00.000Z"}]'
         from l cross join (select id from (${voters}) v where v.n % 20 = 10 union all select $2::uuid) v`,
  ]) await db.query(sql, [ws, busy.id]);
  await db.query('analyze');
  const t0 = performance.now();
  const first = ok(await mgr.get(`/api/persons/${busy.id}/timeline`));
  const firstMs = performance.now() - t0;
  assert.equal(first.entries.length, 50);
  // Their knocks and calls ("Try 1" the newest) among everything else, and
  // the next page carries on from the last one shown.
  const tries = (j) => j.entries.filter((e) => /^Try \d+$/.test(e.detail || '')).map((e) => Number(e.detail.slice(4)));
  assert.deepEqual(tries(first).slice(0, 3), [1, 2, 3]);
  const t1 = performance.now();
  const second = ok(await mgr.get(`/api/persons/${busy.id}/timeline?before=${encodeURIComponent(first.next)}`));
  const secondMs = performance.now() - t1;
  assert.equal(second.entries.length, 50);
  assert.deepEqual(tries(second).slice(0, 2), [tries(first).at(-1) + 1, tries(first).at(-1) + 2]);
  console.log(`  5,000 contacts on one person: first page ${Math.round(firstMs)} ms, next page ${Math.round(secondMs)} ms`);
  // Generous for the in-memory database (several times slower than a hosted one).
  const budget = Number(process.env.TIMELINE_MS) || 1500;
  assert.ok(firstMs < budget && secondMs < budget, `first ${Math.round(firstMs)} ms, next ${Math.round(secondMs)} ms`);
  // Every source's read, as the database chooses to run it with nothing
  // forced: each big table through an index straight to this person (or to
  // the one row a join needs), never everyone's.
  const { SOURCES } = await import('../ext/timeline/sources.js');
  const viewer = { desk: true, money: true, outreach: true, userId: mgrId };
  const found = {};
  for (const s of SOURCES) {
    let sent = null;
    const got = await s.read(
      { query: (sql, params) => { if (!/information_schema/.test(sql)) sent = { sql, params }; return db.query(sql, params); } },
      { ws, person: busy, viewer, before: null, limit: 51, tz: 'America/Vancouver', campaign: '' },
    );
    found[s.key] = got.length;
    const plan = (await db.query(`explain ${sent.sql}`, sent.params)).rows.map((r) => Object.values(r)[0]).join('\n');
    for (const scan of scansOf(plan).filter((x) => STRAIGHT_TO[x.table])) {
      assert.ok(scan.index && STRAIGHT_TO[scan.table].test(scan.cond), `${s.key}: ${scan.table} ${scan.index ? `by ${scan.index} on ${scan.cond.trim()}` : 'walked'}\n${plan}`);
    }
  }
  assert.match(JSON.stringify(found), /"contacts":51/);
  assert.ok(Object.entries(found).filter(([k]) => k !== 'merges').every(([, n]) => n > 0), `one of each for them: ${JSON.stringify(found)}`);
});

test('the indexes this feature adds are there', async () => {
  const names = (await db.query(
    `select indexname from pg_indexes where schemaname = current_schema() and indexname = any($1::text[])`,
    [['gifts_ws_person_idx', 'signs_ws_person_idx', 'sassign_ws_person_idx', 'brecip_ws_person_idx', 'brecip_ws_email_idx', 'stripe_payments_person_idx']],
  )).rows.map((r) => r.indexname).sort();
  assert.deepEqual(names, ['brecip_ws_email_idx', 'brecip_ws_person_idx', 'gifts_ws_person_idx', 'sassign_ws_person_idx', 'signs_ws_person_idx', 'stripe_payments_person_idx']);
});
