// Call time: a candidate on the phone to donors from a bank made for them
// (ext/banks call_banks.candidate_id), and the pledges they hear for the
// treasurer. A pledge is what a donor said — never a gift: the financial
// agent takes the money, and the desk logs the gift as ever.
//
//   calltime.log   { client_id, bank_id, person_id, result, amount_cents?, note? }
//                  the candidate whose call time it is, their own number only.
//                  roles volunteer, no area: a deny of People or Donations on
//                  the Candidates row doesn't stop it (removing the candidate
//                  does). It is a phone call (contact.log, no note: volunteers
//                  read contacts) that crosses off this bank alone, and a row
//                  in calltime_results; the event says has_note, never the note.
//   calltime.drop  { id }   Donations: a pledge that won't come in leaves the list
//
//   GET /calltime/pledges   Donations: the open pledges, each with the gift that came in
//   GET /calltime/seats     Donations (the desk): the candidates a call-time bank can be for
//   GET /calltime/:bankId   the candidate whose bank it is (anyone else 404): the
//                           numbers to call now with what each donor gave, their room,
//                           and the ask — a fixed handful of queries, never one per donor
//   callTimeOf(db, ctx)     the candidate's banks and their week (GET /candidate/home)
//   briefPledges            the brief's money Needs you: calltime_pledges { n, cents }
import { z } from 'zod';
import { Hono } from 'hono';
import { DEFAULT_SLATE } from '@starbase/shared/canvass';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { decide, areasFor } from '../../lib/perms.js';
import { FIELD_ACTIONS } from '../../actions/field.js';
import { roomFor, campaignNow } from '../payments/limits.js';
import { stillOn } from '../banks/numbers.js';
import { roomsFor, pledgedFor, openPledge, giftIn } from './room.js';

const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
const RESULTS = ['pledged', 'no', 'no_answer', 'left_message'];
// What the contact says: a Pledged or a No is a talk.
const OUTCOME = { pledged: 'contacted', no: 'contacted', no_answer: 'no_answer', left_message: 'left_message' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 200;
// $1,250 — cents only when there are some ($929.70).
export const dollars = (cents) => {
  const n = Number(cents || 0) / 100;
  return `$${n.toLocaleString('en-CA', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const slateOf = (ctx) => ctx.candidate?.race || DEFAULT_SLATE;
const NOT_YOURS = 'That’s not on your call time';

// The candidate's own call-time bank, or nothing.
const ownBank = async (q, ctx, bankId) => (ctx.candidate && UUID_RE.test(String(bankId || ''))
  ? (await q.query(
    'select * from call_banks where id = $1 and workspace_id = $2 and deleted_at is null and candidate_id = $3',
    [bankId, ctx.workspaceId, ctx.candidate.id],
  )).rows[0] || null
  : null);

const resultOut = (r) => ({ id: r.id, bank_id: r.bank_id, person_id: r.person_id, result: r.result, amount_cents: r.amount_cents == null ? null : Number(r.amount_cents) });

export const actions = {
  'calltime.log': {
    roles: ['volunteer'],
    input: z.object({
      client_id: z.uuid(),
      bank_id: z.uuid(),
      person_id: z.uuid(),
      result: z.enum(RESULTS),
      amount_cents: z.number().int().min(100).max(10_000_000).nullish(),
      note: z.string().trim().max(1000).nullish().transform((v) => v || null),
    }).refine((v) => v.result !== 'pledged' || v.amount_cents, { message: 'A pledge needs an amount', path: ['amount_cents'] }),
    handler: async (tx, ctx, input, emit) => {
      if (!ctx.candidate) throw httpError(403, NOT_YOURS);
      const ws = ctx.workspaceId;
      // The same answer again (an outbox replay): the first one, once.
      const dup = (await tx.query('select * from calltime_results where workspace_id = $1 and client_id = $2', [ws, input.client_id])).rows[0];
      if (dup) return { result: resultOut(dup), duplicate: true };
      const bank = await ownBank(tx, ctx, input.bank_id);
      if (!bank) throw httpError(403, NOT_YOURS);
      const n = (await tx.query(
        'select done_at from call_bank_numbers where bank_id = $1 and person_id = $2 and assigned_to = $3', [bank.id, input.person_id, ctx.user.id],
      )).rows[0];
      if (!n) throw httpError(403, NOT_YOURS);
      // Answered already (another tab or phone with an old card): once is enough.
      if (n.done_at) throw httpError(409, 'Already called');
      const slate = slateOf(ctx);
      const amount = input.result === 'pledged' ? input.amount_cents : null;
      if (amount) {
        // Within what they may still give, less what the slate's been promised.
        const room = await roomFor(tx, ctx.workspace, input.person_id, slate);
        if (room.roomCents != null) {
          const left = Math.max(0, room.roomCents - await pledgedFor(tx, ctx.workspace, input.person_id, slate));
          if (amount > left) throw httpError(400, `That’s over what they can give this year — up to ${dollars(left)}`);
        }
      }
      // The call itself: a bank call, crossing off this bank alone (ext/banks
      // crossOff), with no words on it.
      const call = await FIELD_ACTIONS['contact.log'].handler(tx, { ...ctx, calltimeBank: bank.id }, {
        person_id: input.person_id, channel: 'phone', outcome: OUTCOME[input.result], note: null, client_id: input.client_id,
      }, emit);
      const id = newId();
      const row = (await tx.query(
        `insert into calltime_results (id, workspace_id, bank_id, person_id, candidate_id, result, amount_cents, slate, said_on, note, client_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
        [id, ws, bank.id, input.person_id, ctx.candidate.id, input.result, amount, slate, campaignNow(ctx.workspace).day, input.note, input.client_id, ctx.user.id],
      )).rows[0];
      emit('calltime_result', id, 'create', {
        bank_id: bank.id, person_id: input.person_id, candidate_id: ctx.candidate.id, result: input.result, amount_cents: amount, has_note: Boolean(input.note),
      });
      return { result: resultOut(row), ...(call.bank ? { bank: call.bank } : {}) };
    },
  },

  'calltime.drop': {
    roles: MONEY_ROLES,
    area: 'money',
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const r = (await tx.query(
        `update calltime_results set dropped_at = now(), dropped_by = $3
          where id = $1 and workspace_id = $2 and result = 'pledged' and dropped_at is null returning id`,
        [input.id, ctx.workspaceId, ctx.user.id],
      )).rows[0];
      if (!r) throw httpError(404, 'pledge not found');
      emit('calltime_result', r.id, 'update', { dropped: true });
      return { id: r.id, dropped: true };
    },
  },
};

// The candidate's call-time banks (open ones), how many are left to call now
// in each, and what they've heard pledged this week.
export const callTimeOf = async (db, ctx) => {
  if (!ctx.candidate) return null;
  const banks = (await db.query(
    `select id, name, list_id from call_banks
      where workspace_id = $1 and candidate_id = $2 and deleted_at is null and closed_at is null order by created_at`,
    [ctx.workspaceId, ctx.candidate.id],
  )).rows;
  // Left to call now, by the same rule as the card (one count per bank: a
  // candidate has one or two).
  for (const b of banks) {
    const params = [b.id, ctx.user.id];
    const still = await stillOn(db, ctx, b, params);
    b.left = (await db.query(
      `select count(*)::int as n from call_bank_numbers n join persons p on p.id = n.person_id
        where n.bank_id = $1 and n.assigned_to = $2 and n.done_at is null and (n.next_at is null or n.next_at <= now()) and ${still}`,
      params,
    )).rows[0].n;
    delete b.list_id;
  }
  const week = (await db.query(
    `select coalesce(sum(amount_cents), 0)::bigint as cents from calltime_results
      where workspace_id = $1 and candidate_id = $2 and result = 'pledged' and dropped_at is null and created_at > now() - interval '7 days'`,
    [ctx.workspaceId, ctx.candidate.id],
  )).rows[0];
  return { banks, left: banks.reduce((s, b) => s + b.left, 0), pledged_week_cents: Number(week.cents) };
};

// The site's donate page, as its links name it: its own domain once there
// is one, else the app's /site/donate — null while there's no live page.
const donateUrl = async (db, ctx) => {
  const page = (await db.query(
    "select 1 from site_pages where workspace_id = $1 and slug = 'donate' and status = 'published' and deleted_at is null",
    [ctx.workspaceId],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (!page) return null;
  const s = (await db.query('select domains from site_settings where workspace_id = $1', [ctx.workspaceId]).catch(() => ({ rows: [] }))).rows[0];
  const domains = typeof s?.domains === 'string' ? JSON.parse(s.domains) : s?.domains || [];
  return domains.length ? `https://${domains[0]}/donate` : `${ctx.publicUrl || ''}/site/donate`;
};

export const api = new Hono();

// Registered before /calltime/:bankId, so "pledges" (and "seats") is never read as a bank.
api.get('/calltime/pledges', async (c) => {
  const ctx = c.get('ctx');
  if (!MONEY_ROLES.includes(ctx.role) || !areasFor(ctx).includes('money')) return c.json({ error: 'not for you' }, 403);
  const { day } = campaignNow(ctx.workspace);
  const rows = (await c.get('db').query(
    `select r.id, r.person_id, p.name as person_name, cd.name as candidate_name, r.amount_cents, r.said_on, r.created_at, r.note, gi.amount_cents as gift_cents, gi.date as gift_date
       from calltime_results r join persons p on p.id = r.person_id left join candidates cd on cd.id = r.candidate_id
       left join lateral (${giftIn('r')}) gi on true
      where r.workspace_id = $1 and r.result = 'pledged' and r.dropped_at is null and r.said_on > $2::date - 60
      order by r.created_at desc limit 500`,
    [ctx.workspaceId, day],
  )).rows;
  const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const pledges = rows.map((r) => ({
    id: r.id, person: { id: r.person_id, name: r.person_name }, candidate: r.candidate_name, amount_cents: Number(r.amount_cents),
    said_at: new Date(r.created_at).toISOString(), said_on: isoDay(r.said_on), note: r.note,
    gift_in: r.gift_cents == null ? null : { amount_cents: Number(r.gift_cents), date: isoDay(r.gift_date) },
  }));
  // Open: no gift in yet. A pledge with its gift in shows "Gift in ✓" a while (until 60 days).
  const open = pledges.filter((p) => !p.gift_in);
  return c.json({ pledges, open: { n: open.length, cents: open.reduce((s, p) => s + p.amount_cents, 0) } });
});

// The candidates a call-time bank can be made for (Phone banks → New:
// "Who calls"): the desk holding Donations, as bank.create checks.
api.get('/calltime/seats', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role === 'volunteer' || !areasFor(ctx).includes('money')) return c.json({ error: 'not for you' }, 403);
  const seats = (await c.get('db').query(
    'select id, name, office from candidates where workspace_id = $1 and removed_at is null order by position, created_at', [ctx.workspaceId],
  )).rows;
  return c.json({ candidates: seats });
});

api.get('/calltime/:bankId', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  const bank = await ownBank(db, ctx, c.req.param('bankId'));
  if (!bank) return c.json({ error: 'not found' }, 404);
  const ws = ctx.workspace;
  const slate = slateOf(ctx);
  const { year } = campaignNow(ws);
  // Still to call as the bank's own lists have it (ext/banks numbers.js).
  const due = '(n.next_at is null or n.next_at <= now())';
  const params = [bank.id, ctx.user.id];
  const still = await stillOn(db, ctx, bank, params);
  const counts = (await db.query(
    `select (count(*) filter (where ${due}))::int as left, (count(*) filter (where not ${due}))::int as later
       from call_bank_numbers n join persons p on p.id = n.person_id
      where n.bank_id = $1 and n.assigned_to = $2 and n.done_at is null and ${still}`, params,
  )).rows[0];
  const people = (await db.query(
    `select p.id, p.name, p.phone, p.city
       from call_bank_numbers n join persons p on p.id = n.person_id
      where n.bank_id = $1 and n.assigned_to = $2 and n.done_at is null and ${due} and ${still}
      order by n.position, p.id limit ${PAGE}`, params,
  )).rows;
  const ids = people.map((p) => p.id);
  // What each gave: this year on the race's slate, ever, and the last gift.
  const giving = new Map((await db.query(
    `select person_id,
            coalesce(sum(amount_cents) filter (where coalesce(slate, $3) = $4 and date >= make_date($5, 1, 1) and date < make_date($5 + 1, 1, 1)), 0)::bigint as year_cents,
            coalesce(sum(amount_cents), 0)::bigint as ever_cents
       from gifts where workspace_id = $1 and person_id = any($2::uuid[]) and deleted_at is null group by person_id`,
    [ctx.workspaceId, ids, DEFAULT_SLATE, slate, year],
  )).rows.map((r) => [r.person_id, r]));
  const last = new Map((await db.query(
    `select distinct on (person_id) person_id, amount_cents, date from gifts
      where workspace_id = $1 and person_id = any($2::uuid[]) and deleted_at is null order by person_id, date desc, id desc`,
    [ctx.workspaceId, ids],
  )).rows.map((r) => [r.person_id, r]));
  const rooms = await roomsFor(db, ws, ids, slate);
  const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const numbers = people.map((p) => {
    const g = giving.get(p.id); const l = last.get(p.id); const room = rooms.get(p.id)?.roomCents ?? null;
    const lastGift = l ? { amount_cents: Number(l.amount_cents), date: day(l.date) } : null;
    let ask = bank.ask_cents != null ? Number(bank.ask_cents) : lastGift?.amount_cents ?? null;
    if (ask != null && room != null) ask = Math.min(ask, room);
    return {
      person_id: p.id, name: p.name, phone: p.phone, city: p.city,
      given_year_cents: Number(g?.year_cents ?? 0), given_ever_cents: Number(g?.ever_cents ?? 0), last_gift: lastGift,
      room_cents: room, ask_cents: ask,
    };
  });
  // What this sitting has come to: calls made and pledges heard on this bank.
  const done = (await db.query(
    `select count(*)::int as calls, coalesce(sum(amount_cents) filter (where result = 'pledged' and dropped_at is null), 0)::bigint as pledged
       from calltime_results where bank_id = $1 and candidate_id = $2`, [bank.id, ctx.candidate.id],
  )).rows[0];
  return c.json({
    bank: { id: bank.id, name: bank.name, script: bank.script, left: counts.left, later: counts.later, closed: Boolean(bank.closed_at) },
    numbers,
    done: { calls: done.calls, pledged_cents: Number(done.pledged) },
    donate_url: await donateUrl(db, ctx),
  });
});

// Donations → Needs you: the pledges still to come in.
export const briefPledges = async (db, ctx, brief) => {
  if (!MONEY_ROLES.includes(ctx.role) || decide(ctx.perms, 'money') === false) return;
  const { day } = campaignNow(ctx.workspace);
  const r = (await db.query(
    `select count(*) filter (where ${openPledge('r', '$2')})::int as n,
            coalesce(sum(r.amount_cents) filter (where ${openPledge('r', '$2')}), 0)::bigint as cents,
            count(*)::int as listed
       from calltime_results r
      where r.workspace_id = $1 and r.result = 'pledged' and r.dropped_at is null and r.said_on > $2::date - 60`,
    [ctx.workspaceId, day],
  )).rows[0];
  // n, cents: still to come in; listed: on the list (a gift in shows there a while).
  brief.calltime_pledges = { n: r.n, cents: Number(r.cents), listed: r.listed };
};
