// Reports and exports, for the desk (the data area).
//   GET /reports                 the campaign in numbers: people by rating, tags, cities,
//                                people added by week, contacts by week and channel,
//                                donations by month, the newsletter list, sends
//   GET /reports/:name.csv       one of them as a spreadsheet
//   GET /export/:dataset.csv     a whole table as a spreadsheet: people, gifts,
//                                subscribers, contacts, lists (and members,
//                                for a campaign that has a membership)
// Volunteers are refused all of it. The full JSON export stays at GET /export.
import { Hono } from 'hono';
import { csvResponse } from '../../lib/csv.js';
import { DATASETS, REPORTS, datasetRows, hasDataset, MONEY_REPORTS, MONEY_DATASETS, hasMoney } from './rows.js';
import { mountQuick } from './quick.js';

export const api = new Hono();
const DESK = ['manager', 'treasurer', 'staff'];
const refuse = (c) => c.json({ error: 'desk only' }, 403);
const noMoney = (c) => c.json({ error: 'not for you — ask a manager under Admin → Permissions' }, 403);

const totals = async (db, ws) => {
  const one = async (sql) => (await db.query(sql, [ws])).rows[0];
  const p = await one(`select count(*)::int as total, (count(*) filter (where rating is not null))::int as rated,
    (count(*) filter (where email is not null))::int as with_email, (count(*) filter (where phone is not null))::int as with_phone
    from persons where workspace_id = $1 and deleted_at is null`);
  const c = await one(`select count(*)::int as total, (count(*) filter (where created_at > now() - interval '7 days'))::int as week from contacts where workspace_id = $1`);
  const g = await one(`select count(*)::int as gifts, coalesce(sum(amount_cents), 0)::bigint as cents, count(distinct person_id)::int as donors
    from gifts where workspace_id = $1 and deleted_at is null and date >= date_trunc('year', current_date)`);
  const s = await one(`select (count(*) filter (where status = 'subscribed'))::int as subscribed, (count(*) filter (where status = 'unsubscribed'))::int as unsubscribed from subscriptions where workspace_id = $1`);
  return {
    people: p, contacts: c, donations: { gifts: g.gifts, cents: Number(g.cents), donors: g.donors },
    newsletter: s,
  };
};

api.get('/reports', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  if (!DESK.includes(ctx.role)) return refuse(c);
  const money = hasMoney(ctx);
  const out = { totals: await totals(db, ws), reports: {} };
  // Same key and shape without Donations, so a tab still on the old page
  // (it reads t.donations.cents unguarded) shows $0.00 until it reloads.
  if (!money) out.totals.donations = { gifts: null, cents: null, donors: null, hidden: true };
  for (const [name, fn] of Object.entries(REPORTS)) {
    if (!money && MONEY_REPORTS.includes(name)) continue;
    out.reports[name] = await fn(db, ws, ctx);
  }
  return c.json(out);
});

// Quick reports (quick.js) on their own prefix, before /reports/:name.
mountQuick(api);

api.get('/reports/:name', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const name = c.req.param('name').replace(/\.csv$/, '');
  const fn = REPORTS[name];
  if (!fn) return c.json({ error: 'no such report' }, 404);
  if (MONEY_REPORTS.includes(name) && !hasMoney(ctx)) return noMoney(c);
  const r = await fn(db, ctx.workspaceId, ctx);
  return csvResponse(c, `report-${name}`, r.head, r.rows);
});

api.get('/export/:dataset', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const name = c.req.param('dataset').replace(/\.csv$/, '');
  if (!hasDataset(name)) return c.json({ error: 'no such export' }, 404);
  if (MONEY_DATASETS.includes(name) && !hasMoney(ctx)) return noMoney(c);
  // Private profile fields (Faith): a manager's download, when asked for.
  const privateToo = c.req.query('private') === '1';
  if (privateToo && ctx.role !== 'manager') return c.json({ error: 'Only a manager can download private fields' }, 403);
  const { head, rows } = await datasetRows(db, ctx.workspaceId, name, { privateToo });
  return csvResponse(c, `base-win-${name}`, head, rows);
});
export const DATASET_NAMES = Object.keys(DATASETS);
export const REPORT_NAMES = Object.keys(REPORTS);
