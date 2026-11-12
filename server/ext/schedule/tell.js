// Telling people about their shifts without a tap per shift.
//
// shift.tellWeek { week }   "Tell everyone on this week's shifts" (desk).
//     `week`: any day of it. Everyone holding a spot on a shift of that week
//     still to come gets ONE message listing their own shifts. The write
//     sends nothing: it makes one shift_notices row a person ('asked') and
//     queues the job that sends them. 409 while that week's last notice is
//     still going out, or when nobody is on a shift that week.
//     → { batch_id, week, people, shifts }
// shift.reminders { on }    "Remind people the evening before" (managers) —
//     off until one turns it on. → { on, next_at }
//
// weekState(db, ctx, day)   the count before a week's notice is sent, how
//     its last one went, and the reminders' switch (GET /schedule/week).
// noticeResults(db, ws, batchId)   one notice, a person a row — names and
//     how each went, never an address or a number (GET /schedule/notices/:id);
//     a volunteer granted Shifts gets the names only.
//
// The evening before (REMIND_JOB — one per campaign evening, keyed by its
// day so an evening runs once): at 6 pm on the campaign's clock, or an hour
// before that day's texting hours close when they close by 6 (weekends),
// everyone booked on a shift tomorrow gets one reminder. A booking is
// reminded once (shift_assignments.reminded_at, set in the same write that
// queues its message); someone who can't make it is never reminded. Each
// run queues the next three evenings first, so one bad evening never ends
// them; while the switch is off a run does nothing and queues nothing, and
// with neither email nor texting connected it marks nobody as reminded.
//
// Sending (TELL_JOB) follows the newsletter's phases, never holding the
// campaign's lock while a provider is called:
//   1. claim   a few 'asked' rows → 'sending', committed before any call.
//              What to say is read here, as things stand: someone no longer
//              on any of those shifts (can't make it, taken off, called off)
//              is closed and told nothing.
//   2. send    each one's email (with its own idempotency key) and text,
//              outside any write. The texting rules hold for the text —
//              opt-outs, do-not-text, do-not-contact, quiet hours — and
//              do-not-email / do-not-contact for the email, which also
//              never goes to an address that bounced for good or reported
//              spam (the suppression list, ext/mail): 'suppressed'.
//   3. record  how each went on the row, and on each booking as shift.notify
//              keeps it (notified_at, notify_email, notify_text).
// A crash leaves the claimed few 'sending' — never sent again by itself (a
// text has no key to send twice safely) — and the rest 'asked': the job
// carries on with those. Every write is on the event log: a week's by the
// person who tapped, a reminder's by nobody (the system).
import { z } from 'zod';
import { addDays, dayOf, fmtIn, instantOf, isDay, weekStart, weekdayIndex } from '@starbase/shared/dayparts';
import { pinPoint, whereWords } from '@starbase/shared/shiftkinds';
import { httpError } from '../../actions/util.js';
import { newId, runAction } from '../../lib/events.js';
import { runHooks } from '../../lib/hooks.js';
import { enqueueJob, jobRunnerOn, runJobsSoon } from '../../lib/jobs.js';
import { emailConfigured, sendEmail, sendText, textConfigured } from '../../lib/notify.js';
import { notSuppressed } from '../../lib/mail/index.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { mayRun } from '../../lib/perms.js';
// One clock for "when is it" in a send: the texting rules' own (their quiet
// hours read it, and the tests set it).
import { MAX_BODY, now } from '../texting/rules.js';
import { quietState, settingsFor as textingSettings } from '../texting/store.js';
import { dayInput, inParts, tzOf } from './rules.js';

export const TELL_JOB = 'schedule.tell';
export const REMIND_JOB = 'schedule.remind';
const TELL_ACTION = 'shift.tellWeek';
const REMIND_ACTION = 'shift.remind';
const DESK = ['manager', 'treasurer', 'staff'];
// Holding a spot, as the core counts room; booked is the same without
// "Here" (nobody checked in needs reminding).
const HOLD = ['assigned', 'confirmed', 'completed'];
const BOOKED = ['assigned', 'confirmed'];
const onIt = (kind) => (kind === 'reminder' ? BOOKED : HOLD);
const NO_EMAIL_TAGS = ['do-not-email', 'do-not-contact'];
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const pad = (n) => String(n).padStart(2, '0');

// ── The words ──
// One person's shifts as one message, soonest first. The email says
// everything; the text keeps to a line a shift (a text is paid by length).
const LONG = { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const SHORT = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const TIME = { hour: 'numeric', minute: '2-digit' };
const TEXT_LINES = 8;
export const noticeWords = ({ kind, shifts, workspaceName, tz = DEFAULT_TZ, thisWeek = true, week = null }) => {
  const n = shifts.length;
  const head = kind === 'reminder' ? 'A reminder — you’re on tomorrow'
    : thisWeek || !week ? 'Your shifts this week'
      : `Your shifts for the week of ${fmtIn(instantOf(week, '12:00', tz), tz, { month: 'long', day: 'numeric' })}`;
  const subject = kind !== 'reminder' ? head : n === 1 ? `Tomorrow: ${shifts[0].title}` : `Tomorrow: your ${n} shifts`;
  // A place nobody has named is its map, never its coordinates as words.
  const block = (s) => [
    s.title,
    fmtIn(s.starts_at, tz, LONG) + (s.ends_at ? ` – ${fmtIn(s.ends_at, tz, TIME)}` : ''),
    s.location ? `Where: ${whereWords(s.location)}` : null,
    s.instructions ? `Instructions: ${s.instructions}` : null,
    s.link ? `Details: ${s.link}` : null,
  ].filter(Boolean).join('\n');
  // A made name already says where ("Burma Shave — King George Blvd & 88 Ave").
  const line = (s) => {
    const where = !s.location ? ''
      : pinPoint(s.location) ? `, ${whereWords(s.location)}`
        : !String(s.title).toLowerCase().includes(String(s.location).toLowerCase()) ? `, ${s.location}` : '';
    return `${fmtIn(s.starts_at, tz, SHORT)}: ${s.title}${where}`;
  };
  // The text is built to its length rather than cut: a shift's line goes in
  // whole (its map link with it) or not at all, what doesn't fit is counted
  // in "+ N more", and the sign-off always ends it.
  const textOf = (k) => [`${head}:`, ...shifts.slice(0, k).map(line),
    ...(k < n ? [`+ ${n - k} more — ask us for the full list`] : []), `— ${workspaceName}`].join('\n');
  let k = Math.min(n, TEXT_LINES);
  while (k > 0 && textOf(k).length > MAX_BODY) k -= 1;
  return {
    subject,
    email: [`${head}:`, ...shifts.map(block), `— ${workspaceName}`].join('\n\n'),
    text: textOf(k).slice(0, MAX_BODY),
  };
};

// ── When a reminder goes ──
// 6 pm on the campaign's clock — moved inside that day's texting hours when
// 6 pm is outside them: an hour before they close (weekends close at 6), or
// when they open. `texting`: ext/texting's settings.
const remindHour = (day, texting) => {
  const weekend = weekdayIndex(day) >= 5;
  const from = weekend ? texting.weekend_from : texting.allow_from;
  const until = weekend ? texting.weekend_until : texting.allow_until;
  return Math.min(Math.max(18, from), until - 1);
};
export const remindAt = (day, texting, tz) => instantOf(day, `${pad(remindHour(day, texting))}:00`, tz);
// The first evening whose hour hasn't come yet.
const nextEvening = (texting, tz) => {
  const t = now();
  const today = dayOf(t, tz);
  return Date.parse(remindAt(today, texting, tz)) > t.getTime() ? today : addDays(today, 1);
};
const remindKey = (day) => `${REMIND_JOB}:${day}`;
// The next three evenings, each queued once (a key a campaign evening).
const AHEAD = 3;
const queueReminders = async (q, ws, tz) => {
  const texting = await textingSettings(q, ws);
  const first = nextEvening(texting, tz);
  for (let i = 0; i < AHEAD; i += 1) {
    const day = addDays(first, i);
    await enqueueJob(q, { workspaceId: ws, kind: REMIND_JOB, runAt: remindAt(day, texting, tz), payload: { day }, key: remindKey(day) });
  }
  return remindAt(first, texting, tz);
};

// ── Who is on a week ──
// Every booking that holds a spot on a shift of the week still to come.
const weekBookings = async (q, ws, monday, tz) => (await q.query(
  `select a.id, a.person_id, a.shift_id
     from shift_assignments a
     join shifts s on s.id = a.shift_id and s.deleted_at is null
     join persons p on p.id = a.person_id and p.deleted_at is null
    where a.workspace_id = $1 and a.status = any($2::text[])
      and s.starts_at >= $3 and s.starts_at < $4 and coalesce(s.ends_at, s.starts_at) >= $5
    order by s.starts_at, a.id`,
  [ws, HOLD, instantOf(monday, '00:00', tz), instantOf(addDays(monday, 7), '00:00', tz), now().toISOString()],
)).rows;

const insertNotices = (tx, ws, { kind, batchId, week = null, userId = null }, list) => inParts(list, 25, (part) => tx.query(
  `insert into shift_notices (id, workspace_id, kind, batch_id, week, person_id, assignment_ids, created_by)
   select x.id, $1, $2, $3, $4::date, x.person_id, x.assignment_ids, $5
     from jsonb_to_recordset($6::jsonb) as x(id uuid, person_id uuid, assignment_ids jsonb)`,
  [ws, kind, batchId, week, userId, JSON.stringify(part)],
));
// One row a person, from their bookings in order.
const byPerson = (bookings) => {
  const ids = new Map();
  for (const b of bookings) ids.set(b.person_id, [...(ids.get(b.person_id) || []), b.id]);
  return [...ids].map(([person_id, assignment_ids]) => ({ id: newId(), person_id, assignment_ids }));
};

// ── Sending ──
// A run sends to a hundred people, or for five minutes when a provider is
// slow to answer — well inside the ten after which the job runner takes a
// running job for dead — and the next run carries on.
const PER_RUN = 100;
const RUN_MS = 5 * 60_000;
const BATCH = 10;
let perRun = PER_RUN;
export const _setPerRunForTest = (n) => { perRun = n || PER_RUN; };
const GONE = 'No longer on a shift';
const jobCtx = async (db, ws) => {
  const w = (await db.query('select name, settings from workspaces where id = $1', [ws])).rows[0];
  return w ? { workspaceId: ws, workspace: { name: w.name, settings: parseJ(w.settings, {}) || {} } } : null;
};

const deliver = async (db, ctx, batchId, { actorId = null, action = TELL_ACTION, max = perRun } = {}) => {
  const ws = ctx.workspaceId;
  const tz = tzOf(ctx);
  const act = (fn) => runAction(db, { workspaceId: ws, actorId, action }, fn);
  const started = Date.now();
  let claimed = 0;
  for (;;) {
    if (claimed >= max || Date.now() - started >= RUN_MS) {
      const left = (await db.query(`select 1 from shift_notices where workspace_id = $1 and batch_id = $2 and state = 'asked' limit 1`, [ws, batchId])).rows;
      return { more: left.length > 0 };
    }
    const t = now();
    const today = dayOf(t, tz);
    const { result: go } = await act(async (tx, emit) => {
      const asked = (await tx.query(
        `select id, kind, week, person_id, assignment_ids from shift_notices
          where workspace_id = $1 and batch_id = $2 and state = 'asked'
          order by created_at, id limit $3 for update skip locked`,
        [ws, batchId, Math.min(BATCH, max - claimed)],
      )).rows;
      const out = [];
      for (const n of asked) {
        const person = (await tx.query(
          `select p.id, p.name, p.email, p.phone, p.tags, ${notSuppressed('p.workspace_id', 'p.email')} as can_email
             from persons p where p.id = $1 and p.workspace_id = $2 and p.deleted_at is null`, [n.person_id, ws],
        )).rows[0];
        // What to say, as things stand now: their shifts of these that are
        // not over (as the count before the tap counted them). A reminder
        // is for tomorrow: one whose day has come is too late to send.
        const shifts = person ? (await tx.query(
          `select a.id as assignment_id, s.title, s.starts_at, s.ends_at, s.location, s.instructions, s.link
             from shift_assignments a join shifts s on s.id = a.shift_id and s.deleted_at is null
            where a.workspace_id = $1 and a.id = any($2::uuid[]) and a.status = any($3::text[])
              and coalesce(s.ends_at, s.starts_at) >= $4 and ($5::timestamptz is null or s.starts_at >= $5)
            order by s.starts_at, s.id`,
          [ws, parseJ(n.assignment_ids, []), onIt(n.kind), t.toISOString(),
            n.kind === 'reminder' ? instantOf(addDays(today, 1), '00:00', tz) : null],
        )).rows : [];
        if (!shifts.length) {
          await tx.query(
            `update shift_notices set state = 'done', email = 'skipped', text = 'skipped', text_note = $3, sent_at = now() where id = $1 and workspace_id = $2`,
            [n.id, ws, GONE],
          );
          emit('shift_notice', n.id, 'update', { state: 'done', email: 'skipped', text: 'skipped', gone: true });
          continue;
        }
        await tx.query(`update shift_notices set state = 'sending' where id = $1 and workspace_id = $2`, [n.id, ws]);
        emit('shift_notice', n.id, 'update', { state: 'sending' });
        out.push({ id: n.id, kind: n.kind, week: dateOnly(n.week), person, shifts });
      }
      return { rows: out, empty: asked.length === 0 };
    });
    if (go.empty) return { more: false };
    for (const n of go.rows) {
      claimed += 1;
      const words = noticeWords({
        kind: n.kind, shifts: n.shifts, workspaceName: ctx.workspace.name, tz, week: n.week, thisWeek: n.week === weekStart(today),
      });
      const tags = parseJ(n.person.tags, []) || [];
      let email = { status: 'skipped' };
      if (n.person.email) {
        email = NO_EMAIL_TAGS.some((x) => tags.includes(x)) ? { status: 'opted_out' }
          // Read at the claim, a moment ago: an address on the suppression list.
          : !n.person.can_email ? { status: 'suppressed' }
          : await sendEmail({ to: n.person.email, subject: words.subject, text: words.email, idempotencyKey: `shift-notice-${n.id}` });
      }
      // The texting rules (ext/texting) decide, as for shift.notify: never an
      // opted-out or do-not-text number, never in quiet hours.
      let text = { status: 'skipped' };
      if (n.person.phone) {
        const guard = { to: n.person.phone, status: null, detail: null };
        await runHooks('textOut', db, ctx, { phone: n.person.phone, personId: n.person.id, kind: 'shift' }, guard);
        text = guard.status ? { status: guard.status, detail: guard.detail } : await sendText({ to: guard.to, body: words.text });
      }
      const note = ['opted_out', 'quiet'].includes(text.status) ? text.detail || null : null;
      await act(async (tx, emit) => {
        const r = await tx.query(
          `update shift_notices set state = 'done', email = $3, text = $4, text_note = $5, sent_at = now()
            where id = $1 and workspace_id = $2 and state = 'sending'`,
          [n.id, ws, email.status, text.status, note],
        );
        if (!r.affectedRows) return;
        await tx.query(
          `update shift_assignments set notified_at = now(), notify_email = $3, notify_text = $4 where workspace_id = $1 and id = any($2::uuid[])`,
          [ws, n.shifts.map((s) => s.assignment_id), email.status, text.status],
        );
        emit('shift_notice', n.id, 'update', { state: 'done', email: email.status, text: text.status });
      });
    }
  }
};

// The job that sends a notice's rows, a run at a time (PER_RUN, RUN_MS), the
// next run straight away — other background work isn't kept waiting.
const runTellJob = async (db, job) => {
  const { batch_id: batchId, actor_id: actorId = null, action } = job.payload || {};
  const ctx = await jobCtx(db, job.workspace_id);
  if (!ctx || !batchId) return;
  const run = await deliver(db, ctx, batchId, { actorId, action: action === REMIND_ACTION ? REMIND_ACTION : TELL_ACTION });
  if (run.more) {
    await enqueueJob(db, { workspaceId: job.workspace_id, kind: TELL_JOB, payload: job.payload });
    runJobsSoon();
  }
};

// One campaign evening (payload.day): everyone booked for tomorrow.
const runRemindJob = async (db, job) => {
  const ws = job.workspace_id;
  const ctx = await jobCtx(db, ws);
  if (!ctx) return;
  const on = (await db.query('select remind from schedule_settings where workspace_id = $1', [ws])).rows[0]?.remind;
  if (!on) return;
  const tz = tzOf(ctx);
  // The evenings to come first, so a failure below never ends them.
  await queueReminders(db, ws, tz);
  const day = job.payload?.day;
  const t = now();
  // Run on another day (the server was down at its hour): "tomorrow" would
  // be wrong by now, so nothing is sent.
  if (!isDay(day) || dayOf(t, tz) !== day) return;
  // Neither email nor texting connected: nobody could be reached, so no
  // booking is marked as reminded (GET /schedule/week says what is missing).
  if (!emailConfigured() && !textConfigured()) return;
  const tomorrow = addDays(day, 1);
  const { result: queued } = await runAction(db, { workspaceId: ws, actorId: null, action: REMIND_ACTION }, async (tx, emit) => {
    // Claimed and queued in one write: a booking is reminded once.
    const due = (await tx.query(
      `update shift_assignments a set reminded_at = now()
         from shifts s, persons p
        where a.workspace_id = $1 and s.id = a.shift_id and s.deleted_at is null and p.id = a.person_id and p.deleted_at is null
          and a.status = any($2::text[]) and a.reminded_at is null
          and s.starts_at >= $3 and s.starts_at < $4
        returning a.id, a.person_id, s.starts_at`,
      [ws, BOOKED, instantOf(tomorrow, '00:00', tz), instantOf(addDays(tomorrow, 1), '00:00', tz)],
    )).rows.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at) || String(a.id).localeCompare(String(b.id)));
    if (!due.length) return 0;
    const batchId = newId();
    const list = byPerson(due);
    await insertNotices(tx, ws, { kind: 'reminder', batchId }, list);
    for (const r of list) emit('shift_notice', r.id, 'create', { batch_id: batchId, kind: 'reminder', day: tomorrow, person_id: r.person_id, assignment_ids: r.assignment_ids });
    await enqueueJob(tx, { workspaceId: ws, kind: TELL_JOB, payload: { batch_id: batchId, action: REMIND_ACTION } });
    return list.length;
  });
  if (queued) runJobsSoon();
};

export const jobs = { [TELL_JOB]: runTellJob, [REMIND_JOB]: runRemindJob };

// ── The writes ──
export const tellActions = {
  'shift.tellWeek': {
    roles: DESK,
    input: z.object({ week: dayInput() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const monday = weekStart(input.week);
      // Two taps must not tell everyone twice: while the last notice for
      // this week still has people waiting or mid-send (a short list is
      // claimed whole at once) and a job sending them, wait.
      const going = (await tx.query(
        `select 1 from shift_notices n
          where n.workspace_id = $1 and n.kind = 'week' and n.week = $2::date and n.state in ('asked', 'sending')
            and exists (select 1 from jobs j where j.workspace_id = n.workspace_id and j.kind = $3 and j.status in ('pending', 'running')
                         and j.payload->>'batch_id' = n.batch_id::text)
          limit 1`,
        [ws, monday, TELL_JOB],
      )).rows[0];
      if (going) throw httpError(409, 'this week’s notice is still going out — give it a minute');
      const bookings = await weekBookings(tx, ws, monday, tzOf(ctx));
      if (!bookings.length) throw httpError(409, 'nobody is on a shift still to come that week');
      // What an older notice never got to send (its job gave up) is closed:
      // this one tells them.
      const stale = (await tx.query(
        `update shift_notices set state = 'done' where workspace_id = $1 and kind = 'week' and week = $2::date and state = 'asked' returning id`,
        [ws, monday],
      )).rows;
      for (const n of stale) emit('shift_notice', n.id, 'update', { state: 'done', replaced: true });
      const batchId = newId();
      const list = byPerson(bookings);
      await insertNotices(tx, ws, { kind: 'week', batchId, week: monday, userId: ctx.user.id }, list);
      for (const r of list) emit('shift_notice', r.id, 'create', { batch_id: batchId, kind: 'week', week: monday, person_id: r.person_id, assignment_ids: r.assignment_ids });
      await enqueueJob(tx, { workspaceId: ws, kind: TELL_JOB, payload: { batch_id: batchId, actor_id: ctx.user.id }, key: `${TELL_JOB}:${batchId}` });
      return { batch_id: batchId, week: monday, people: list.length, shifts: new Set(bookings.map((b) => b.shift_id)).size };
    },
    // Committed: the job sends, starting now.
    after: async (db, ctx, result) => { runJobsSoon(); return { result }; },
  },

  // A campaign-wide switch — it makes the campaign email and text people
  // every evening — so a manager's (lib/perms.js: the Admin area).
  'shift.reminders': {
    roles: ['manager'],
    input: z.object({ on: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      await tx.query(
        `insert into schedule_settings (workspace_id, remind, updated_by, updated_at) values ($1, $2, $3, now())
         on conflict (workspace_id) do update set remind = excluded.remind, updated_by = excluded.updated_by, updated_at = now()`,
        [ws, input.on, ctx.user.id],
      );
      emit('workspace', ws, 'update', { shift_reminders: input.on });
      // On: the evenings to come are queued (off: those already queued find
      // the switch off when their hour comes, and do nothing).
      return { on: input.on, next_at: input.on ? await queueReminders(tx, ws, tzOf(ctx)) : null };
    },
  },
};

// ── The reads ──
export const weekState = async (db, ctx, day) => {
  const ws = ctx.workspaceId;
  const tz = tzOf(ctx);
  const monday = weekStart(day);
  const bookings = await weekBookings(db, ws, monday, tz);
  const last = (await db.query(
    `select n.batch_id, min(n.created_at) as at, count(*)::int as people,
            (count(*) filter (where n.state = 'asked'))::int as waiting,
            (count(*) filter (where n.state = 'sending'))::int as unsure,
            (count(*) filter (where n.email = 'sent' or n.text = 'sent'))::int as reached
       from shift_notices n where n.workspace_id = $1 and n.kind = 'week' and n.week = $2::date
      group by n.batch_id order by min(n.created_at) desc, n.batch_id limit 1`,
    [ws, monday],
  )).rows[0];
  const on = Boolean((await db.query('select remind from schedule_settings where workspace_id = $1', [ws])).rows[0]?.remind);
  const texting = await textingSettings(db, ws);
  // When the next reminders go: the first of the coming evenings that has
  // its job waiting — null when none has (nothing would send them).
  let nextAt = null;
  if (on) {
    const first = nextEvening(texting, tz);
    const days = Array.from({ length: AHEAD }, (_, i) => addDays(first, i));
    const waiting = new Set((await db.query(
      `select key from jobs where workspace_id = $1 and kind = $2 and status in ('pending', 'running') and key = any($3::text[])`,
      [ws, REMIND_JOB, days.map(remindKey)],
    )).rows.map((j) => j.key));
    const day0 = days.find((d) => waiting.has(remindKey(d)));
    nextAt = day0 ? remindAt(day0, texting, tz) : null;
  }
  const quiet = textConfigured() ? quietState(texting, ctx.workspace) : null;
  return {
    week: monday,
    people: new Set(bookings.map((b) => b.person_id)).size,
    shifts: new Set(bookings.map((b) => b.shift_id)).size,
    // What is connected, and whether this server sends in the background
    // at all (STARBASE_JOBS=off: notices wait).
    providers: { email: emailConfigured(), text: textConfigured() },
    jobs: jobRunnerOn(),
    quiet: quiet ? { now: quiet.now, opens: quiet.opens } : null,
    last: last ? { batch_id: last.batch_id, at: iso(last.at), people: last.people, waiting: last.waiting, unsure: last.unsure, reached: last.reached } : null,
    reminders: { on, next_at: nextAt, can_set: mayRun(ctx, 'shift.reminders', tellActions['shift.reminders']) },
  };
};

// `full`: with how each person's email and text went. A volunteer (granted
// Shifts) gets the names only, as on a shift's own page: how someone can or
// can't be reached is the desk's to know.
export const noticeResults = async (db, ws, batchId, { full = true } = {}) => {
  const rows = (await db.query(
    `select n.kind, n.week, n.created_at, n.person_id, p.name, n.state, n.email, n.text, n.text_note
       from shift_notices n join persons p on p.id = n.person_id
      where n.workspace_id = $1 and n.batch_id = $2 order by lower(p.name), n.id`,
    [ws, batchId],
  )).rows;
  if (!rows.length) return null;
  return {
    batch_id: batchId, kind: rows[0].kind, week: dateOnly(rows[0].week), at: iso(rows[0].created_at),
    people: rows.map((r) => ({
      person_id: r.person_id, name: r.name, state: r.state,
      email: full ? r.email : null, text: full ? r.text : null, text_note: full ? r.text_note : null,
    })),
  };
};
