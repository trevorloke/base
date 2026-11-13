// Gmail, as actions:
//
//   gmail.send { person_id, subject, body, client_key }   one email to one
//       person from your own Gmail. The write checks and records; the send
//       is its `after`, outside the campaign's write (deliver, send.js).
//   gmail.test {}               the same to your own address ("Send me a
//                               test"): counts toward the cap, never in History
//   gmail.settings { on?, review? }   managers (so Admin): the campaign's
//                               switch, and how Google is set up for base.win
//                               (only words: base.win can't read it)
//
// Events carry { person_id, status } only: never a subject, a body or an
// address (gmail_sends keeps those, off the hash-chained log).
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { enqueueJob } from '../../lib/jobs.js';
import { newId } from '../../lib/events.js';
import { makeLimiter } from '../../lib/guard.js';
import { whyNot } from '../../lib/reach.js';
import { googleSetup } from '../../lib/google/config.js';
import { tokenPaused } from '../../lib/google/flow.js';
import { grantFor } from '../../lib/google/tokens.js';
import { REACH_WORDS, WORDS, apiOffNow, dailyMax, deliver, oneAddress } from './send.js';

export const DESK = ['manager', 'treasurer', 'staff'];
const MANAGER = ['manager'];
export const REVIEWS = ['internal', 'unreviewed', 'reviewed'];
const SETTLE_MS = 15 * 60_000;
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
export const gmailSettings = (settings) => {
  const g = parse(settings).gmail || {};
  return { on: g.on === true, review: REVIEWS.includes(g.review) ? g.review : null };
};

// Ten a minute a person, whatever the cap says.
const perMinute = makeLimiter({ windowMs: 60_000, max: 10 });
export const _resetLimiterForTest = (userId) => perMinute.clear(userId);

// Sends that count toward the cap: this person's, both kinds, every
// campaign on this server, over the last 24 hours.
export const sentToday = async (q, userId) => (await q.query(
  `select count(*)::int as n from gmail_sends
   where user_id = $1 and created_at > now() - interval '24 hours' and status in ('sending','sent','unsure')`,
  [userId],
)).rows[0].n;

// Control characters: none in a subject; a message keeps its line breaks and tabs.
const NO_CONTROL = /^[^\x00-\x1f\x7f]*$/;
const BODY_OK = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/;

// Steps 2–6 of a send: the campaign's switch, the grant, pauses, the cap,
// the per-minute limit. → the grant.
const ready = async (tx, ctx) => {
  if (!DESK.includes(ctx.role)) throw httpError(403, `role '${ctx.role}' may not send from Gmail`);
  if (!googleSetup().connect) throw httpError(409, WORDS.notSetUp);
  const ws = (await tx.query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0];
  if (!gmailSettings(ws?.settings).on) throw httpError(409, WORDS.off);
  const grant = await grantFor(tx, { userId: ctx.user.id, workspaceId: ctx.workspaceId }, 'gmail.send');
  if (!grant) throw httpError(409, WORDS.connect);
  if (grant.state === 'reconnect') throw httpError(409, grant.said ? `${WORDS.reconnect} (${grant.said})` : WORDS.reconnect);
  if (grant.state !== 'ok') throw httpError(409, grant.said || WORDS.reconnect);
  if (grant.pausedUntil && new Date(grant.pausedUntil).getTime() > Date.now()) throw httpError(429, WORDS.waitUntil(grant.pausedUntil));
  if (apiOffNow() || tokenPaused()) throw httpError(503, WORDS.broken);
  const max = dailyMax();
  if (await sentToday(tx, ctx.user.id) >= max) throw httpError(429, WORDS.cap(max));
  if (perMinute(ctx.user.id)) throw httpError(429, 'That’s ten in a minute — wait a minute, then send again');
  return grant;
};

// The row, its settle job (in the same write), and its event.
const record = async (tx, ctx, emit, row) => {
  const id = newId();
  await tx.query(
    `insert into gmail_sends (id, workspace_id, kind, person_id, user_id, client_key, to_email, from_email, subject, body, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'sending')`,
    [id, ctx.workspaceId, row.kind, row.personId, ctx.user.id, row.clientKey, row.to, row.from, row.subject, row.body],
  );
  await enqueueJob(tx, {
    workspaceId: ctx.workspaceId, kind: 'gmail.settle', key: `gmail-settle-${id}`,
    runAt: new Date(Date.now() + SETTLE_MS).toISOString(), payload: { id },
  });
  emit('gmail_send', id, 'create', { ...(row.personId ? { person_id: row.personId } : {}), status: 'sending' });
  return { id, status: 'sending', go: true };
};

// After the write: the send, unless this was a replay.
const sendNow = async (db, ctx, result) => {
  if (!result.go) return { result };
  return deliver(db, ctx, result.id);
};

export const actions = {
  'gmail.send': {
    roles: DESK,
    input: z.object({
      person_id: z.uuid(),
      subject: z.string().trim().min(1, 'Write a subject').max(200).regex(NO_CONTROL, 'a subject is one line'),
      body: z.string().max(10_000).regex(BODY_OK, 'plain text only').refine((s) => s.trim().length > 0, 'Write a message'),
      client_key: z.uuid(),
    }),
    handler: async (tx, ctx, input, emit) => {
      // 1. The same send again (a double tap, a retry): the row it made.
      const dup = (await tx.query(
        'select id, status, said from gmail_sends where workspace_id = $1 and client_key = $2', [ctx.workspaceId, input.client_key],
      )).rows[0];
      if (dup) return { id: dup.id, status: dup.status, ...(dup.said ? { said: dup.said } : {}), duplicate: true };
      // 2–6.
      const grant = await ready(tx, ctx);
      // 7. The person, and whether they may be emailed one to one.
      const p = (await tx.query(
        'select id, email, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null', [input.person_id, ctx.workspaceId],
      )).rows[0];
      if (!p) throw httpError(404, 'person not found');
      const why = await whyNot(tx, 'email', 'direct', { workspaceId: ctx.workspaceId, email: p.email, tags: parse(p.tags), personId: p.id });
      if (why) throw httpError(409, REACH_WORDS[why] || 'They can’t be emailed');
      // 8. One bare address, exactly.
      const to = oneAddress(p.email);
      if (!to) throw httpError(409, WORDS.badAddress);
      // 9–11.
      return record(tx, ctx, emit, {
        kind: 'person', personId: p.id, clientKey: input.client_key, to, from: grant.email, subject: input.subject, body: input.body,
      });
    },
    after: sendNow,
  },

  'gmail.test': {
    roles: DESK,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const grant = await ready(tx, ctx);
      return record(tx, ctx, emit, {
        kind: 'test', personId: null, clientKey: newId(), to: grant.email, from: grant.email,
        subject: 'Test from base.win', body: 'This is a test from base.win. If you can read it, sending from your Gmail works.',
      });
    },
    after: sendNow,
  },

  'gmail.settings': {
    roles: MANAGER,
    input: z.object({ on: z.boolean().optional(), review: z.enum(REVIEWS).nullable().optional() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const settings = parse((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0].settings);
      const now = gmailSettings(settings);
      const next = {
        on: input.on === undefined ? now.on : input.on,
        review: input.review === undefined ? now.review : input.review,
      };
      if (next.on && !now.on && !googleSetup().connect) throw httpError(409, 'Set up Google first — Settings → Services → Google');
      if (next.on && !next.review) throw httpError(400, 'Say how Google is set up for base.win');
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify({ ...settings, gmail: next })]);
      emit('workspace', ws, 'update', { gmail: next });
      return next;
    },
  },
};
