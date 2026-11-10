// The financial agent's filing dates — two of them, each a name and a day
// the agent types in ("Disclosure statement due", Jan 15). Donations counts
// down to each; Today shows the ones within 30 days to the people who
// handle money.
//
// Nothing here knows the law: no date, name or rule comes with the
// product. What is due and when is the financial agent's to confirm with
// Elections BC and to enter.
//
//   filing_dates   (workspace_id, slot 1 | 2) → name, due_on
//
//   filing.dates  { dates: [{ name, due_on } | null, …up to two] }
//                 managers and treasurers: sets both places at once — an
//                 entry left out or left empty clears its place.
//   GET /money/filing-dates   money roles → { dates: [{ slot, name, due_on,
//                 days }], today, can_edit } — days: whole days from today
//                 on the campaign's calendar (negative once it has passed).
//   brief hook    Today's brief.filing: the dates 0 to 30 days away, for
//                 money roles; a volunteer's brief has none.
import { Hono } from 'hono';
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { campaignDay } from '../../lib/gifts.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { decide, mayRun } from '../../lib/perms.js';

export const sql = `
create table if not exists filing_dates (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slot smallint not null check (slot in (1, 2)),
  name text not null,
  due_on date not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, slot)
);
`;

const AGENT_ROLES = ['manager', 'treasurer'];
const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
const TODAY_WITHIN = 30;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const utc = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const realDay = (s) => DAY_RE.test(s) && new Date(utc(s)).toISOString().slice(0, 10) === s;
const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const todayFor = (ctx) => campaignDay(new Date(), ctx.workspace?.settings?.tz || DEFAULT_TZ);

// The campaign's dates, each with the days left as its calendar has today.
const datesOf = async (q, ctx) => {
  const today = todayFor(ctx);
  const rows = (await q.query('select slot, name, due_on from filing_dates where workspace_id = $1 order by slot', [ctx.workspaceId])).rows;
  return {
    today,
    dates: rows.map((r) => {
      const due = dayOf(r.due_on);
      return { slot: Number(r.slot), name: r.name, due_on: due, days: Math.round((utc(due) - utc(today)) / 86_400_000) };
    }),
  };
};

export const actions = {
  'filing.dates': {
    roles: AGENT_ROLES,
    area: 'money',
    input: z.object({
      dates: z.array(z.object({ name: z.string().max(200).nullish(), due_on: z.string().max(40).nullish() }).nullable()).max(2),
    }),
    handler: async (tx, ctx, input, emit) => {
      const next = [0, 1].map((i) => {
        const name = String(input.dates[i]?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const due = String(input.dates[i]?.due_on ?? '').trim();
        if (!name && !due) return null;
        if (!name) throw httpError(400, 'Give the date a name, like “Disclosure statement due”.');
        if (!due) throw httpError(400, `“${name}” needs its date.`);
        if (!realDay(due)) throw httpError(400, `“${name}” needs a date like 2027-01-15.`);
        return { slot: i + 1, name, due_on: due };
      });
      for (const [i, d] of next.entries()) {
        if (!d) {
          await tx.query('delete from filing_dates where workspace_id = $1 and slot = $2', [ctx.workspaceId, i + 1]);
          continue;
        }
        await tx.query(
          `insert into filing_dates (workspace_id, slot, name, due_on, updated_by) values ($1, $2, $3, $4, $5)
           on conflict (workspace_id, slot) do update set name = excluded.name, due_on = excluded.due_on,
             updated_by = excluded.updated_by, updated_at = now()`,
          [ctx.workspaceId, d.slot, d.name, d.due_on, ctx.user.id],
        );
      }
      emit('filing_dates', ctx.workspaceId, 'update', { dates: next.filter(Boolean) });
      return datesOf(tx, ctx);
    },
  },
};

export const api = new Hono();
api.get('/money/filing-dates', async (c) => {
  const ctx = c.get('ctx');
  if (!MONEY_ROLES.includes(ctx.role)) return c.json({ error: 'for the desk that handles donations' }, 403);
  return c.json({ ...(await datesOf(c.get('db'), ctx)), can_edit: mayRun(ctx, 'filing.dates', actions['filing.dates']) });
});

// Today (GET /api/brief): the dates coming within 30 days, for the people
// who handle money and have not been kept out of Donations.
const briefFiling = async (db, ctx, brief) => {
  if (!MONEY_ROLES.includes(ctx.role) || decide(ctx.perms, 'money') === false) return;
  const { dates } = await datesOf(db, ctx);
  brief.filing = dates.filter((d) => d.days >= 0 && d.days <= TODAY_WITHIN).map(({ name, due_on, days }) => ({ name, due_on, days }));
};

export const hooks = { brief: briefFiling };
export const deskOnlyReads = ['/money/filing-dates'];
export const exportTables = ['filing_dates'];
