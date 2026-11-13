// Calendars: anything dated in base.win, into Google, Outlook or Apple.
//
// One item, as a file (the "Add to calendar" button's "Apple & others"):
//   GET /api/calendar/:kind/:id/link   signed in; checks the reader as the
//       item's own screen does, makes the file then, and keeps it under a
//       ticket (tickets.js) → { url: <publicUrl>/cal/once/<ticket>.ics }
//       shift/<uuid>   every role, unless kept out of Shifts; the reader's
//                      own hours on it when they are booked
//       vote/all       every role: the voting days, 404 when none is set
//       filing/<1|2>   the roles that handle money, unless kept out of
//                      Donations (GET /money/filing-dates' rule)
//   GET /cal/once/<22>.ics   no cookie: the kept file, inline (an iPhone
//       opens its Add to Calendar sheet), 10 minutes and 3 reads.
//
// A person's calendar link (their shifts, kept up to date by their app):
//   calendar.feed.make    the live link, or the one there is (duplicate)
//   calendar.feed.renew   "Make a new link": the old one stops, a new one
//   calendar.feed.stop    "Stop this link"
//   calendar.feed.email   emails the link to the login's own address — the
//       phone's way (Google adds links only on a computer). A job sends it,
//       outside the write; 3 an hour.
//   GET /api/calendar/feed   → { feed: { url, webcal, google, created_at } | null, canEmail }
//   GET /cal/<43>.ics   no cookie: their shifts (no instructions, no
//       Details link — the link lives in another company's calendar and may
//       be forwarded), the voting days, and for money roles the filing
//       dates. Who they are and what they may see is read again on every
//       fetch; a stopped link or a member no longer on the campaign answers
//       an empty calendar, so their app clears what it had.
// Nothing here is on a website's domain (not in the site's SHARED list).
import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { icsCalendar, shiftEvent } from '@starbase/shared/ics';
import { getDb } from '../../db/client.js';
import { httpError } from '../../actions/util.js';
import { configuredUrl, icsFileName, ICS_TYPE, shiftAppLink } from '../../lib/calendar.js';
import { newId } from '../../lib/events.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { emailConfigured, sendEmail } from '../../lib/notify.js';
import { whyNot } from '../../lib/reach.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { decide, permsOf } from '../../lib/perms.js';
import { loginEmail } from '../../lib/viewer.js';
import { filingDays, isDesk, myShifts, seesMoney, votingDays } from './content.js';
import { keepFile, readFile } from './tickets.js';

export { sql } from './sql.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const EMAIL_JOB = 'calendar.feed.email';
const EMAILS_AN_HOUR = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const tzOf = (settings) => parseJ(settings, {})?.tz || DEFAULT_TZ;

// ── The link's addresses ──
const feedOut = (row, publicUrl) => {
  const url = `${publicUrl}/cal/${row.token}.ics`;
  return {
    url,
    webcal: url.replace(/^https?:/, 'webcal:'),
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(url)}`,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
};
const liveFeed = async (q, ctx) => (await q.query(
  'select id, token, created_at from calendar_feeds where workspace_id = $1 and user_id = $2 and stopped_at is null',
  [ctx.workspaceId, ctx.user.id],
)).rows[0] || null;
const makeFeed = async (tx, ctx, emit) => {
  const row = { id: newId(), token: randomBytes(32).toString('base64url') }; // 43 characters
  const made = (await tx.query(
    'insert into calendar_feeds (id, workspace_id, user_id, token) values ($1, $2, $3, $4) returning id, token, created_at',
    [row.id, ctx.workspaceId, ctx.user.id, row.token],
  )).rows[0];
  // Never the token on the log: whose link, nothing more.
  emit('calendar_feed', made.id, 'create', { user_id: ctx.user.id });
  return made;
};
const stopFeed = async (tx, ctx, emit, live) => {
  await tx.query('update calendar_feeds set stopped_at = now() where id = $1 and workspace_id = $2', [live.id, ctx.workspaceId]);
  emit('calendar_feed', live.id, 'void', { user_id: ctx.user.id });
};

export const actions = {
  'calendar.feed.make': {
    roles: ALL_ROLES,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const live = await liveFeed(tx, ctx);
      if (live) return { duplicate: true, feed: feedOut(live, ctx.publicUrl) };
      return { feed: feedOut(await makeFeed(tx, ctx, emit), ctx.publicUrl) };
    },
  },
  'calendar.feed.renew': {
    roles: ALL_ROLES,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const live = await liveFeed(tx, ctx);
      if (live) await stopFeed(tx, ctx, emit, live);
      return { feed: feedOut(await makeFeed(tx, ctx, emit), ctx.publicUrl) };
    },
  },
  'calendar.feed.stop': {
    roles: ALL_ROLES,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const live = await liveFeed(tx, ctx);
      if (!live) throw httpError(409, 'There’s no calendar link to stop.');
      await stopFeed(tx, ctx, emit, live);
      return { stopped: true };
    },
  },
  'calendar.feed.email': {
    roles: ALL_ROLES,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const live = await liveFeed(tx, ctx);
      if (!live) throw httpError(409, 'Get your calendar link first.');
      if (!emailConfigured()) throw httpError(409, 'Email isn’t set up for this campaign — use Copy link');
      if (!loginEmail(ctx)) throw httpError(409, 'Your sign-in has no email address — use Copy link');
      // Under the campaign's lock, so two taps can't both be the third.
      const sent = (await tx.query(
        `select count(*)::int as n from events where workspace_id = $1 and entity_type = 'calendar_feed' and entity_id = $2
            and action = 'calendar.feed.email' and server_ts > now() - interval '1 hour'`,
        [ctx.workspaceId, live.id],
      )).rows[0].n;
      if (sent >= EMAILS_AN_HOUR) throw httpError(429, 'We just sent it — check your email');
      const send = newId();
      // No token and no address on the log or in the job: the job reads both.
      emit('calendar_feed', live.id, 'update', { emailed: send });
      await enqueueJob(tx, { workspaceId: ctx.workspaceId, kind: EMAIL_JOB, payload: { feed_id: live.id, at: ctx.publicUrl }, key: `cal-email-${send}` });
      return { queued: true };
    },
    // Committed: the job may start now rather than on the runner's next turn.
    after: async (db, ctx, result) => { runJobsSoon(); return { result }; },
  },
};

// The email with the link — sent by the job, outside any write, once per
// job (its idempotency key). A link stopped since the tap is not sent.
const emailFeed = async (db, job) => {
  const f = (await db.query(
    `select f.token, f.stopped_at, u.email, w.name from calendar_feeds f
       join users u on u.id = f.user_id join workspaces w on w.id = f.workspace_id
      where f.id = $1 and f.workspace_id = $2`,
    [job.payload?.feed_id, job.workspace_id],
  )).rows[0];
  if (!f || f.stopped_at || !f.email || !emailConfigured()) return;
  // Asked for by them, to their own address, so no do-not tag stops it; an
  // address that bounced for good still does (lib/reach.js, sender self).
  if (await whyNot(db, 'email', 'self', { workspaceId: job.workspace_id, email: f.email })) return;
  const at = String(job.payload?.at || configuredUrl() || '').replace(/\/+$/, '');
  const url = `${at}/cal/${f.token}.ics`;
  const res = await sendEmail({
    to: f.email,
    subject: 'Your shifts in your calendar',
    text: [
      'Open Google Calendar on a computer. Beside Other calendars, choose + then From URL. Paste this link:',
      url,
      'Your shifts then appear on your phone too.',
      `— ${f.name}`,
    ].join('\n\n'),
    idempotencyKey: `cal-email-${job.id}`,
  });
  // Tried again by the runner under the same key: the sender drops a repeat.
  if (res.status === 'failed') throw new Error(`the email didn’t send: ${res.detail || 'failed'}`);
};
export const jobs = { [EMAIL_JOB]: emailFeed };

// ── Signed-in reads ──
export const api = new Hono();

api.get('/calendar/feed', async (c) => {
  const ctx = c.get('ctx');
  const live = await liveFeed(c.get('db'), ctx);
  // canEmail: whether "Email me the link" can send (a phone hides it when not).
  return c.json({ feed: live ? feedOut(live, ctx.publicUrl) : null, canEmail: emailConfigured() });
});

const fileAnswer = (c, ctx, { name, events, title }) => {
  const ticket = keepFile(icsCalendar({ name, events }), icsFileName(title));
  return c.json({ url: `${ctx.publicUrl}/cal/once/${ticket}.ics` });
};

api.get('/calendar/:kind/:id/link', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const { kind, id } = c.req.param();
  const tz = ctx.workspace?.settings?.tz || DEFAULT_TZ;
  const name = ctx.workspace.name;
  if (kind === 'shift') {
    if (decide(ctx.perms, 'shifts') === false) return c.json({ error: 'not for you — ask a manager under Admin → Permissions' }, 403);
    if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
    const shift = (await db.query(
      `select s.*, pl.lat as place_lat, pl.lng as place_lng from shifts s left join places pl on pl.id = s.place_id
        where s.id = $1 and s.workspace_id = $2 and s.deleted_at is null`,
      [id, ctx.workspaceId],
    )).rows[0];
    if (!shift) return c.json({ error: 'not found' }, 404);
    // The reader's own booking (the rule of the list's "mine"), for their own hours.
    const email = loginEmail(ctx);
    const booking = email ? (await db.query(
      `select to_jsonb(a)->>'arrive_at' as arrive_at, to_jsonb(a)->>'leave_at' as leave_at
         from shift_assignments a join persons p on p.id = a.person_id
        where a.shift_id = $1 and a.workspace_id = $2 and a.status in ('assigned', 'confirmed')
          and p.deleted_at is null and lower(p.email) = $3
        order by p.created_at limit 1`,
      [shift.id, ctx.workspaceId, email],
    )).rows[0] : null;
    const event = shiftEvent(shift, { tz, booking, appUrl: shiftAppLink(ctx.publicUrl, { desk: isDesk(ctx.role), id: shift.id }) });
    return fileAnswer(c, ctx, { name, events: [event], title: shift.title });
  }
  if (kind === 'vote' && id === 'all') {
    const events = await votingDays(db, ctx.workspaceId, name);
    if (!events.length) return c.json({ error: 'no voting days are set' }, 404);
    return fileAnswer(c, ctx, { name, events, title: 'voting days' });
  }
  if (kind === 'filing' && /^[12]$/.test(id)) {
    if (!seesMoney(ctx.role, ctx.perms)) return c.json({ error: 'for the desk that handles donations' }, 403);
    const [event] = await filingDays(db, ctx.workspaceId, Number(id));
    if (!event) return c.json({ error: 'not found' }, 404);
    return fileAnswer(c, ctx, { name, events: [event], title: event.title });
  }
  return c.json({ error: 'not found' }, 404);
});

// ── No cookie: the file links and the calendar links ──
export const publicRoutes = new Hono();
const perAddress = makeLimiter({ windowMs: 3_600_000, max: 600 });
const perLink = makeLimiter({ windowMs: 3_600_000, max: 120 });
const NOT_FOUND = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const calHeaders = (cache, more = {}) => ({
  'Content-Type': ICS_TYPE, 'Cache-Control': cache, 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', ...more,
});

publicRoutes.use('/cal/*', async (c, next) => {
  if (perAddress(clientIp(c))) return c.text('Too many requests — try again later.', 429, NOT_FOUND);
  await next();
});

publicRoutes.get('/cal/once/:file{[A-Za-z0-9_-]{22}\\.ics}', (c) => {
  const kept = readFile(c.req.param('file').slice(0, -4));
  if (!kept) return c.text('This link has expired — tap Add to calendar again', 404, NOT_FOUND);
  return c.body(kept.body, 200, calHeaders('private, no-store', { 'Content-Disposition': `inline; filename="${kept.filename}"` }));
});

publicRoutes.get('/cal/:file{[A-Za-z0-9_-]{43}\\.ics}', async (c) => {
  const token = c.req.param('file').slice(0, -4);
  if (perLink(token)) return c.text('Too many requests — try again later.', 429, NOT_FOUND);
  const db = await getDb();
  const f = (await db.query(
    `select f.workspace_id, f.stopped_at, u.email, w.name, w.settings, m.role, m.permissions,
            exists (select 1 from candidates c where c.workspace_id = f.workspace_id and c.user_id = f.user_id
                      and c.removed_at is null and m.role = 'volunteer') as candidate
       from calendar_feeds f join users u on u.id = f.user_id join workspaces w on w.id = f.workspace_id
       left join memberships m on m.workspace_id = f.workspace_id and m.user_id = f.user_id
      where f.token = $1`,
    [token],
  )).rows[0];
  if (!f) return c.text('Not found', 404, NOT_FOUND);
  const name = `${f.name} — my shifts`;
  const send = (events) => c.body(icsCalendar({ name, events, refresh: true }), 200, calHeaders('private, max-age=300'));
  // Stopped, or no longer on the campaign: an empty calendar clears theirs.
  if (f.stopped_at || !f.role) return send([]);
  const settings = parseJ(f.settings, {}) || {};
  // A candidate's grants and denies are the Candidates row's, as when they
  // sign in (lib/auth.js loadContext).
  const perms = permsOf(f.candidate ? 'candidate' : f.role, settings, parseJ(f.permissions, {}) || {});
  const tz = tzOf(settings);
  const publicUrl = (configuredUrl() || `${new URL(c.req.url).origin}${c.env?.base || ''}`).replace(/\/$/, '');
  const events = [];
  if (decide(perms, 'shifts') !== false) {
    for (const s of await myShifts(db, f.workspace_id, f.email)) {
      events.push(shiftEvent(s, {
        tz, private: false,
        booking: { arrive_at: s.arrive_at, leave_at: s.leave_at },
        appUrl: shiftAppLink(publicUrl, { desk: isDesk(f.role), id: s.id }),
      }));
    }
  }
  events.push(...await votingDays(db, f.workspace_id, f.name));
  if (seesMoney(f.role, perms)) events.push(...await filingDays(db, f.workspace_id));
  return send(events);
});

// Anything else under /cal/ is no calendar: never the app's own page.
publicRoutes.all('/cal/*', (c) => c.text('Not found', 404, NOT_FOUND));

// The export leaves the link's token out: it is a key.
export const exportTables = [{ table: 'calendar_feeds', omit: ['token'] }];
