// GET /passes (any role): { open, past }.
//   open   the open pass — { id, name, kind, who, list_id, tries,
//          started_at, stats } — or null. Every role reads it: the field app
//          says which pass is on and what it's for. list_name (the List it
//          walks) is the desk's: a volunteer gets the doors, not the list.
//   past   ended passes, newest first (at most 50), each with stats — the
//          desk's; a volunteer gets [].
//   stats  over the pass's door knocks (contacts.pass_id):
//          doors_knocked   distinct doors (address + unit, as the walk list
//                          groups them; the person when they have no address)
//          talked          knocks with a conversation ('contacted')
//          support_found   people a knock in this pass rated 1 or 2
import { Hono } from 'hono';
import { openPass } from './rule.js';

export const api = new Hono();
const COLS = 'id, name, kind, who, list_id, tries, started_at, ended_at';
const ZERO = { doors_knocked: 0, talked: 0, support_found: 0 };

// pass id → stats, for the ids given (one query for all of them).
const statsFor = async (db, ws, ids) => {
  const out = new Map();
  if (!ids.length) return out;
  const { rows } = await db.query(
    `select c.pass_id,
            count(distinct case when nullif(trim(p.address), '') is null then p.id::text
                                else lower(trim(p.address)) || '|' || lower(trim(coalesce(p.unit, ''))) end)::int as doors_knocked,
            (count(*) filter (where c.outcome = 'contacted'))::int as talked,
            (count(distinct c.person_id) filter (where c.rating in ('1', '2')))::int as support_found
       from contacts c join persons p on p.id = c.person_id
      where c.workspace_id = $1 and c.channel = 'door' and c.pass_id = any($2::uuid[])
      group by c.pass_id`,
    [ws, ids],
  );
  for (const r of rows) out.set(r.pass_id, { doors_knocked: r.doors_knocked, talked: r.talked, support_found: r.support_found });
  return out;
};

api.get('/passes', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const desk = ctx.role !== 'volunteer';
  const open = await openPass(db, ws);
  const past = desk
    ? (await db.query(
      `select ${COLS} from canvass_passes where workspace_id = $1 and ended_at is not null order by ended_at desc limit 50`, [ws],
    )).rows
    : [];
  const stats = await statsFor(db, ws, [...(open ? [open.id] : []), ...past.map((p) => p.id)]);
  // The lists' names, for the desk (a deleted list keeps its name here).
  const listIds = desk ? [...new Set([open, ...past].map((p) => p?.list_id).filter(Boolean))] : [];
  const names = new Map(listIds.length ? (await db.query(
    'select id, name, deleted_at from lists where workspace_id = $1 and id = any($2::uuid[])', [ws, listIds],
  )).rows.map((l) => [l.id, l]) : []);
  const withStats = (p) => ({
    ...p, stats: stats.get(p.id) || ZERO,
    ...(desk && p.list_id ? { list_name: names.get(p.list_id)?.name || null, list_gone: !names.get(p.list_id) || !!names.get(p.list_id).deleted_at } : {}),
  });
  return c.json({ open: open ? withStats(open) : null, past: past.map(withStats) });
});
