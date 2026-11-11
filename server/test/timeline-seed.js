// One person with every kind of entry a profile's History shows
// (server/ext/timeline): "Dev Example". Each is written the way the product
// writes it — its own action where there is one, the rows a service's answer
// leaves where it takes an outside service (a text, a card refund) — and
// then put at a set time, so the order is known. timeline.test.js reads it
// back; a scratch server uses it to look at the screen.
//
//   seedHistory({ db, mgr, mgrId, vol, volId, ws }) → { dev, expected, … }
//   expected: every entry a manager sees, newest first, as [kind, title].
import { randomUUID } from 'node:crypto';
import { runAction } from '../lib/events.js';
import { campaignDay } from '../lib/gifts.js';
import { recordConsent } from '../ext/site/consent.js';
import { send } from './site-helpers.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TZ = 'America/Vancouver';

const ok = (r, what = '') => {
  if (r.status !== 200) throw new Error(`${what} ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

// Stand in for the email service while fn runs: every email is taken.
export const withEmail = async (fn) => {
  const realFetch = globalThis.fetch;
  const had = Object.hasOwn(process.env, 'RESEND_API_KEY');
  const old = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.resend.com/')
    ? new Response('{"id":"msg"}', { status: 200 })
    : realFetch(url, init));
  try { return await fn(); } finally {
    globalThis.fetch = realFetch;
    if (had) process.env.RESEND_API_KEY = old; else delete process.env.RESEND_API_KEY;
  }
};

export const seedHistory = async ({ db, mgr, mgrId, vol, volId, ws }) => {
  // Whole seconds, so a time reads back exactly; days at noon keep clear of midnight.
  const now = Math.floor(Date.now() / 1000) * 1000;
  const ago = (ms) => new Date(now - ms);
  const day = (n) => campaignDay(ago(n * DAY), TZ);
  const setAt = (table, col, id, when) => db.query(`update ${table} set ${col} = $2 where id = $1`, [id, when.toISOString()]);
  // An event's time on the log (not part of its hash): what History reads
  // for a sign's steps, a refund and a merge.
  const logAt = (type, id, op, when) => db.query(
    'update events set server_ts = $5 where workspace_id = $1 and entity_type = $2 and entity_id = $3 and op = $4',
    [ws, type, id, op, when.toISOString()],
  );
  const system = (action, fn) => runAction(db, { workspaceId: ws, actorId: null, action }, fn);

  const dev = ok(await mgr.action('person.create', {
    name: 'Dev Example', email: 'dev@example.org', phone: '604-555-0142', address: '13450 104 Ave', city: 'Surrey', postal: 'V3T 1V8',
  })).person;

  // ── Memberships: joined 400 days ago (a year, ended), renewed 20 days ago ──
  const joined = ok(await mgr.action('membership.enter', {
    person_id: dev.id, term: 1, signed: true, signed_on: day(400), citizenship: 'citizen', opt_in: false,
  }), 'join').membership;
  await setAt('member_terms', 'created_at', joined.id, ago(398 * DAY));
  const renewed = ok(await mgr.action('membership.enter', {
    person_id: dev.id, term: 4, signed: true, signed_on: day(20), citizenship: 'citizen', opt_in: false,
  }), 'renew').membership;
  await setAt('member_terms', 'created_at', renewed.id, ago(20 * DAY - 2 * HOUR));

  // ── Gifts: a cheque keyed later; cash, then voided; a card gift refunded ──
  const cheque = ok(await mgr.action('gift.log', {
    person_id: dev.id, amount_cents: 10000, date: day(300), method: 'cheque', cadence: 'one-time', note: 'At the spring dinner',
  }), 'cheque').gift;
  await setAt('gifts', 'created_at', cheque.id, ago(297 * DAY));
  const cash = ok(await mgr.action('gift.log', { person_id: dev.id, amount_cents: 5000, date: day(90), method: 'cash', cadence: 'one-time' }), 'cash').gift;
  await setAt('gifts', 'created_at', cash.id, ago(90 * DAY - HOUR));
  ok(await mgr.action('gift.void', { id: cash.id }), 'void');
  await setAt('gifts', 'deleted_at', cash.id, ago(80 * DAY));
  const card = ok(await mgr.action('gift.log', { person_id: dev.id, amount_cents: 20000, date: day(70), method: 'card', cadence: 'one-time', note: 'Paid online' }), 'card').gift;
  await setAt('gifts', 'created_at', card.id, ago(70 * DAY - 3 * HOUR));
  // The card payment as it stands after Stripe's refund (ext/payments
  // apply.js refunded): the row, the gift out of the books, the event.
  const paymentId = randomUUID();
  await db.query(
    `insert into stripe_payments (id, workspace_id, person_id, gift_id, kind, cadence, amount_cents, paid_at, paid_on, status, refunded_cents)
     values ($1, $2, $3, $4, 'donation', 'once', 20000, $5, $6, 'refunded', 20000)`,
    [paymentId, ws, dev.id, card.id, ago(70 * DAY - 3 * HOUR).toISOString(), day(70)],
  );
  ok(await mgr.action('gift.void', { id: card.id }), 'refund void');
  await setAt('gifts', 'deleted_at', card.id, ago(65 * DAY));
  await system('payment.refunded', async (tx, emit) => { emit('payment', paymentId, 'update', { status: 'refunded', refunded_cents: 20000, full: true, source: 'stripe' }); });
  await logAt('payment', paymentId, 'update', ago(65 * DAY));

  // ── The website: the newsletter (and its yes to email), a petition, a message ──
  const formsAt = async (kind, when) => {
    const row = (await db.query(
      'select id from site_actions where workspace_id = $1 and person_id = $2 and kind = $3 order by created_at desc limit 1', [ws, dev.id, kind],
    )).rows[0];
    if (!row) throw new Error(`no ${kind} action for Dev: the form matched someone else`);
    await setAt('site_actions', 'created_at', row.id, when);
    return row.id;
  };
  ok(await send('newsletter', { first_name: 'Dev', last_name: 'Example', email: 'dev@example.org', consent_email: true }), 'newsletter form');
  await formsAt('newsletter', ago(50 * DAY));
  await db.query(
    "update consent_events set created_at = $3 where workspace_id = $1 and person_id = $2 and channel = 'email' and granted",
    [ws, dev.id, ago(50 * DAY - 1000).toISOString()],
  );
  const petition = ok(await mgr.get('/api/site/campaigns')).campaigns.find((c) => c.kind === 'petition');
  ok(await send('petition', { first_name: 'Dev', last_name: 'Example', email: 'dev@example.org', campaign: petition.id }), 'petition form');
  await formsAt('petition', ago(45 * DAY));
  ok(await send('contact', { first_name: 'Dev', last_name: 'Example', email: 'dev@example.org', topic: 'Transit', message: 'When does the 96 B-Line run late?' }), 'contact form');
  await formsAt('contact', ago(44 * DAY));

  // ── Email: a newsletter (opened, a link clicked) and an email to a list ──
  const { news, eblast } = await withEmail(async () => ({
    news: ok(await mgr.action('blast.send', { kind: 'newsletter', subject: 'October update', body: 'Hello — read more: https://example.org/october' }), 'newsletter').blast,
    eblast: ok(await mgr.action('blast.send', { kind: 'eblast', subject: 'Canvass this Saturday', body: 'Join us on Saturday.', audience: { filter: { q: 'Dev Example' } } }), 'eblast').blast,
  }));
  const recipient = async (blastId) => (await db.query(
    'select id, status, person_id from blast_recipients where workspace_id = $1 and blast_id = $2 and (person_id = $3 or lower(email) = $4)',
    [ws, blastId, dev.id, 'dev@example.org'],
  )).rows[0];
  const newsRow = await recipient(news.id);
  const listRow = await recipient(eblast.id);
  if (newsRow?.status !== 'sent' || listRow?.status !== 'sent') throw new Error(`the emails did not send: ${JSON.stringify([newsRow, listRow])}`);
  await db.query(
    `update blast_recipients set sent_at = $2, opens = 2, first_open_at = $3, last_open_at = $3, clicks = 1, first_click_at = $4, last_click_at = $4, first_click_n = 1
      where id = $1`,
    [newsRow.id, ago(40 * DAY).toISOString(), ago(40 * DAY - HOUR).toISOString(), ago(40 * DAY - 2 * HOUR).toISOString()],
  );
  await setAt('blast_recipients', 'sent_at', listRow.id, ago(30 * DAY));

  // ── A ladder's email ──
  const ladder = ok(await mgr.action('ladder.create', {
    name: 'New subscribers', trigger: { kind: 'newsletter' },
    steps: [{ kind: 'email', subject: 'Welcome, {{first_name}}', body: 'Glad you’re here.' }],
  }), 'ladder').ladder;
  const runId = randomUUID();
  await db.query(
    `insert into ladder_runs (id, workspace_id, ladder_id, person_id, step, status, log, finished_at)
     values ($1, $2, $3, $4, 1, 'done', $5, now())`,
    [runId, ws, ladder.id, dev.id, JSON.stringify([
      { step: 0, kind: 'email', result: 'sending', at: ago(28 * DAY + 1000).toISOString() },
      { step: 0, kind: 'email', result: 'sent', at: ago(28 * DAY).toISOString() },
      { step: 1, kind: 'end', result: 'finished', at: ago(28 * DAY).toISOString() },
    ])],
  );

  // ── Shifts: one they came to, one they missed ──
  const shiftOf = async (title, startsAgo, bookedAgo, status) => {
    const s = ok(await mgr.action('shift.create', { title, location: 'Newton Library', starts_at: ago(startsAgo).toISOString() }), 'shift').shift;
    const a = ok(await mgr.action('shift.assign', { shift_id: s.id, person_id: dev.id }), 'assign').assignment;
    ok(await mgr.action('shift.setStatus', { id: a.id, status }), 'status');
    await setAt('shift_assignments', 'created_at', a.id, ago(bookedAgo));
    return s;
  };
  const cameTo = await shiftOf('Saturday canvass', 22 * DAY, 25 * DAY, 'completed');
  const missed = await shiftOf('Phone night', 12 * DAY, 15 * DAY, 'no_show');

  // ── Doors and calls ──
  const contact = async (who, input, when) => {
    const c = ok(await who.action('contact.log', { person_id: dev.id, ...input }), 'contact').contact;
    await setAt('contacts', 'created_at', c.id, when);
    return c;
  };
  await contact(vol, { channel: 'phone', outcome: 'no_answer' }, ago(10 * DAY));
  // A call an outside dialer logged (contacts.source), credited to no one here.
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, note, source, created_at)
     values ($1, $2, $3, 'phone', 'contacted', 'Will vote early', 'callhub', $4)`,
    [randomUUID(), ws, dev.id, ago(9 * DAY).toISOString()],
  );
  await contact(mgr, { channel: 'in_person', outcome: 'contacted', note: 'At the market' }, ago(8 * DAY));
  await contact(vol, { channel: 'mainstreet', outcome: 'contacted', rating: '1' }, ago(7 * DAY));
  await db.query(
    `insert into contacts (id, workspace_id, person_id, channel, outcome, note, source, created_at)
     values ($1, $2, $3, 'door', 'no_answer', 'From an imported list', 'import', $4)`,
    [randomUUID(), ws, dev.id, ago(6 * DAY).toISOString()],
  );

  // ── Texts through the campaign's number: the manager's thread (out, then
  // their reply) and one the volunteer started ──
  const thread = async (startedBy, texts) => {
    const id = randomUUID();
    await db.query('insert into texting_conversations (id, workspace_id, person_id, phone, started_by) values ($1, $2, $3, $4, $5)',
      [id, ws, dev.id, '+16045550142', startedBy]);
    for (const [direction, body, status, when] of texts) {
      await db.query(
        `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, first, sent_by, created_at)
         values ($1, $2, $3, $4, '+16045550142', $5, $6, false, $7, $8)`,
        [randomUUID(), ws, id, direction, body, status, direction === 'out' ? startedBy : null, when.toISOString()],
      );
    }
    return id;
  };
  const mgrThread = await thread(mgrId, [
    ['out', 'Hi Dev, it’s Avery with the campaign. Can we count on you?', 'delivered', ago(5 * DAY)],
    ['in', 'Yes please', 'received', ago(5 * DAY - 10 * 60_000)],
  ]);
  const volThread = await thread(volId, [['out', 'Hi Dev, it’s Sam. See you Saturday?', 'sent', ago(5 * DAY - HOUR)]]);

  // ── A lawn sign: asked for, then put up ──
  const sign = ok(await vol.action('sign.place', { kind: 'lawn', person_id: dev.id, note: 'By the driveway' }), 'sign').sign;
  ok(await mgr.action('sign.update', { id: sign.id, status: 'installed' }), 'sign up');
  await setAt('signs', 'created_at', sign.id, ago(4 * DAY));
  await logAt('sign', sign.id, 'create', ago(4 * DAY));
  await logAt('sign', sign.id, 'update', ago(3 * DAY));

  // ── No to texts (a STOP), then no to email (their unsubscribe link) ──
  const consent = async (input, when) => {
    const { result: id } = await system('test.consent', (tx, emit) => recordConsent(tx, ws, { personId: dev.id, ...input }, emit));
    await setAt('consent_events', 'created_at', id, when);
  };
  await consent({ channel: 'sms', granted: false, source: 'text-stop', address: '+16045550142' }, ago(2 * DAY));
  await consent({ channel: 'email', granted: false, source: 'unsubscribe-link', address: 'dev@example.org' }, ago(2 * DAY - HOUR));

  // ── Marked as voted, at the door ──
  ok(await vol.action('vote.mark', { person_id: dev.id, source: 'door' }), 'voted');
  await db.query('update voted_marks set created_at = $3 where workspace_id = $1 and person_id = $2', [ws, dev.id, ago(DAY).toISOString()]);

  // ── A second record for them (one old call on it), made one with this one ──
  const twin = ok(await mgr.action('person.create', { name: 'Dev Exampel', phone: '604-555-0142' })).person;
  const old = ok(await mgr.action('contact.log', { person_id: twin.id, channel: 'phone', outcome: 'refused' }), 'twin call').contact;
  await setAt('contacts', 'created_at', old.id, ago(11 * DAY));
  ok(await mgr.action('person.merge', { keep: dev.id, drop: twin.id }), 'merge');
  await db.query(
    "update events set server_ts = $3 where workspace_id = $1 and entity_type = 'person' and entity_id = $2 and action = 'person.merge'",
    [ws, dev.id, ago(3 * HOUR).toISOString()],
  );

  // ── Today's knock: rated, a note, two survey answers in the same visit ──
  const survey = ok(await mgr.action('survey.create', { name: 'Fall survey' }), 'survey').survey;
  const q1 = ok(await mgr.action('survey.question.add', { survey_id: survey.id, kind: 'yesno', text: 'Will you take a sign?' }), 'q1').question;
  const q2 = ok(await mgr.action('survey.question.add', { survey_id: survey.id, kind: 'text', text: 'Top issue?' }), 'q2').question;
  const knock = await contact(mgr, {
    channel: 'door', outcome: 'contacted', rating: '2', note: 'Wants a lawn sign',
    answers: [{ question_id: q1.id, value: true }, { question_id: q2.id, value: 'Transit' }],
  }, ago(HOUR));
  await db.query('update survey_responses set created_at = $2 where contact_id = $1', [knock.id, ago(HOUR).toISOString()]);

  // Everything a manager sees, newest first. Two written in one moment (the
  // knock and its answers; the newsletter form and its yes) are told apart
  // by their kind, as the timeline orders them.
  const expected = [
    ['door', 'Rated 2'],
    ['answers', 'Answered · Fall survey'],
    ['merge', 'Two records made one'],
    ['voted', 'Marked as voted'],
    ['consent', 'Unsubscribed from email'],
    ['consent', 'Replied STOP'],
    ['sign', 'Put up · Lawn sign'],
    ['sign', 'Asked for · Lawn sign'],
    ['text_out', 'Sent'],
    ['text_in', 'Received'],
    ['text_out', 'Delivered'],
    ['door', 'No answer'],
    ['mainstreet', 'Rated 1'],
    ['in_person', 'Talked'],
    ['phone', 'Talked'],
    ['phone', 'No answer'],
    ['phone', 'Refused'],
    ['shift_missed', 'Didn’t show up · Phone night'],
    ['shift_booked', 'Booked · Phone night'],
    ['member', 'Renewed · 4 years'],
    ['shift_came', 'Came · Saturday canvass'],
    ['shift_booked', 'Booked · Saturday canvass'],
    ['email', 'Sent'],
    ['email', 'Sent'],
    ['member_end', 'Membership ended'],
    ['email_click', 'Clicked a link'],
    ['email_open', 'Opened'],
    ['email', 'Sent'],
    ['web', 'Sent a message'],
    ['web', `Signed: ${petition.title}`],
    ['consent', 'Said yes to email'],
    ['web', 'Signed up for the newsletter'],
    ['refund', 'Refunded · $200.00'],
    ['gift', '$200.00 · Card · void'],
    ['gift_void', 'Voided · $50.00'],
    ['gift', '$50.00 · Cash · void'],
    ['gift', '$100.00 · Cheque'],
    ['member', 'Joined · 1 year'],
  ];
  return { dev, twin, expected, petition, cameTo, missed, mgrThread, volThread, sign, ladder, survey, news, eblast, newsRow, listRow, cheque, cash, card, paymentId, joined, renewed };
};
