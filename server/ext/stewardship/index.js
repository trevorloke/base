// Stewardship — looking after the people who give: every gift thanked, and
// soon; donors who gave before and not this year brought back; a next step
// for the ones who matter most. For the desk that handles money (the
// Donations area).
//
//   gift_thanks      one per gift: how it was thanked (a call, an email, a
//                    handwritten note, a letter, or in person), by whom, when
//   donor_steps      a donor's next step and its date ("Coffee after the
//                    debate", Nov 20) — one per donor, replaced when done
//
//   gift.thank      { gift_id, how, note? }        money roles
//   gift.unthank    { gift_id }                    money roles: taken back
//   donor.step      { person_id, step?, due_on? }  money roles: set or clear
//
//   GET /stewardship   money roles →
//     { to_thank:  [gifts not thanked, oldest first — donor, amount, date,
//                   days since, phone, email, has an address],
//       lapsed:    [donors who gave in an earlier year and not this one —
//                   last gift, given last year, ever],
//       steps:     [next steps, the due ones first],
//       top:       [this year's biggest donors — given this year, last
//                   thanked],
//       counts }
import { Hono } from 'hono';
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { noCallSql } from '../../lib/reach.js';

export const sql = `
create table if not exists gift_thanks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  gift_id uuid not null references gifts(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  how text not null check (how in ('call', 'email', 'note', 'letter', 'in_person')),
  note text,
  thanked_by uuid references users(id),
  thanked_at timestamptz not null default now(),
  unique (workspace_id, gift_id)
);
create index if not exists gift_thanks_person_idx on gift_thanks (workspace_id, person_id);
create table if not exists donor_steps (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  step text not null,
  due_on date,
  set_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, person_id)
);
`;

const MONEY = ['manager', 'treasurer', 'staff'];
export const HOWS = ['call', 'email', 'note', 'letter', 'in_person'];
const uuid = () => z.uuid();

// Thank a gift (once; a second thanks replaces the first).
export const thankGift = async (tx, ctx, { giftId, how, note = null }, emit) => {
  const g = (await tx.query(
    'select id, person_id from gifts where id = $1 and workspace_id = $2 and deleted_at is null', [giftId, ctx.workspaceId],
  )).rows[0];
  if (!g) throw httpError(404, 'gift not found');
  const id = newId();
  const row = (await tx.query(
    `insert into gift_thanks (id, workspace_id, gift_id, person_id, how, note, thanked_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (workspace_id, gift_id) do update set how = excluded.how, note = excluded.note,
       thanked_by = excluded.thanked_by, thanked_at = now()
     returning id, thanked_at`,
    [id, ctx.workspaceId, g.id, g.person_id, how, note, ctx.user.id],
  )).rows[0];
  emit('gift_thanks', row.id, 'update', { gift_id: g.id, how });
  return { gift_id: g.id, how, thanked_at: row.thanked_at };
};

export const actions = {
  'gift.thank': {
    roles: MONEY,
    input: z.object({ gift_id: uuid(), how: z.enum(HOWS), note: z.string().trim().max(500).nullish() }),
    handler: (tx, ctx, input, emit) => thankGift(tx, ctx, { giftId: input.gift_id, how: input.how, note: input.note || null }, emit),
  },
  'gift.unthank': {
    roles: MONEY,
    input: z.object({ gift_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const r = (await tx.query('delete from gift_thanks where workspace_id = $1 and gift_id = $2 returning id', [ctx.workspaceId, input.gift_id])).rows[0];
      if (r) emit('gift_thanks', r.id, 'void', { gift_id: input.gift_id });
      return { gift_id: input.gift_id, thanked: false };
    },
  },
  'donor.step': {
    roles: MONEY,
    input: z.object({
      person_id: uuid(),
      step: z.string().trim().max(300).nullish(),
      due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-20').nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const p = (await tx.query('select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [input.person_id, ctx.workspaceId])).rows[0];
      if (!p) throw httpError(404, 'person not found');
      if (!input.step) {
        await tx.query('delete from donor_steps where workspace_id = $1 and person_id = $2', [ctx.workspaceId, p.id]);
        emit('person', p.id, 'update', { next_step: null });
        return { person_id: p.id, step: null };
      }
      await tx.query(
        `insert into donor_steps (workspace_id, person_id, step, due_on, set_by) values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, person_id) do update set step = excluded.step, due_on = excluded.due_on, set_by = excluded.set_by, updated_at = now()`,
        [ctx.workspaceId, p.id, input.step, input.due_on || null, ctx.user.id],
      );
      emit('person', p.id, 'update', { next_step: input.step, next_step_on: input.due_on || null });
      return { person_id: p.id, step: input.step, due_on: input.due_on || null };
    },
  },
};

const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

export const api = new Hono();
api.get('/stewardship', async (c) => {
  const ctx = c.get('ctx');
  if (!MONEY.includes(ctx.role)) return c.json({ error: 'for the desk that handles donations' }, 403);
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const toThank = (await db.query(
    `select g.id as gift_id, g.amount_cents, g.date, g.method, g.cadence, p.id as person_id, p.name, p.phone, p.email, ${noCallSql('p')} as no_call,
            (p.address is not null and trim(p.address) <> '') as has_address,
            (current_date - g.date)::int as days
       from gifts g join persons p on p.id = g.person_id and p.deleted_at is null
      where g.workspace_id = $1 and g.deleted_at is null
        and not exists (select 1 from gift_thanks t where t.workspace_id = g.workspace_id and t.gift_id = g.id)
        -- A gift brought in from another tool's file (ext/giftimport) was thanked there, or long ago.
        and coalesce(g.attrs->>'source', '') <> 'import'
      order by g.date, g.created_at limit 500`,
    [ws],
  )).rows.map((r) => ({ ...r, date: day(r.date), amount_cents: Number(r.amount_cents) }));
  const lapsed = (await db.query(
    `select p.id as person_id, p.name, p.phone, p.email, ${noCallSql('p')} as no_call, max(g.date) as last_date,
            coalesce(sum(g.amount_cents) filter (where extract(year from g.date) = extract(year from current_date) - 1), 0)::bigint as last_year_cents,
            sum(g.amount_cents)::bigint as ever_cents
       from gifts g join persons p on p.id = g.person_id and p.deleted_at is null
      where g.workspace_id = $1 and g.deleted_at is null
      group by p.id, p.name, p.phone, p.email, p.tags
     having max(g.date) < date_trunc('year', current_date)
      order by last_year_cents desc, ever_cents desc limit 200`,
    [ws],
  )).rows.map((r) => ({ ...r, last_date: day(r.last_date), last_year_cents: Number(r.last_year_cents), ever_cents: Number(r.ever_cents) }));
  const steps = (await db.query(
    `select s.person_id, p.name, p.phone, p.email, ${noCallSql('p')} as no_call, s.step, s.due_on, (s.due_on is not null and s.due_on <= current_date) as due
       from donor_steps s join persons p on p.id = s.person_id and p.deleted_at is null
      where s.workspace_id = $1 order by s.due_on nulls last, s.updated_at`,
    [ws],
  )).rows.map((r) => ({ ...r, due_on: day(r.due_on) }));
  const top = (await db.query(
    `select p.id as person_id, p.name, sum(g.amount_cents)::bigint as year_cents, count(*)::int as gifts,
            (select max(t.thanked_at) from gift_thanks t where t.workspace_id = $1 and t.person_id = p.id) as last_thanked,
            (select s.step from donor_steps s where s.workspace_id = $1 and s.person_id = p.id) as step
       from gifts g join persons p on p.id = g.person_id and p.deleted_at is null
      where g.workspace_id = $1 and g.deleted_at is null and g.date >= date_trunc('year', current_date)
      group by p.id, p.name order by year_cents desc limit 25`,
    [ws],
  )).rows.map((r) => ({ ...r, year_cents: Number(r.year_cents) }));
  return c.json({
    to_thank: toThank, lapsed, steps, top,
    counts: { to_thank: toThank.length, overdue: toThank.filter((g) => g.days > 2).length, lapsed: lapsed.length, due: steps.filter((s) => s.due).length },
  });
});

export const exportTables = ['gift_thanks', 'donor_steps'];
