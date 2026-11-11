// Gift import reads (signed in; mounted under /api; the Donations area).
// Money roles only — and volunteers are refused both paths by deskOnlyReads
// before a handler runs.
//   GET /gifts/imports           what waits for a donor (how many gifts, how
//                                much), the files brought in (latest first:
//                                its gifts on the books, what still waits,
//                                whether it can still be taken back), and
//                                whether this person may bring one in
//   GET /gifts/imports/waiting   the pile, a donor at a time as the file
//                                names them: their gifts, and the records
//                                they could be (as things stand now) — and
//                                the gifts left out, latest first, to bring
//                                back (gift.importBringBack)
import { Hono } from 'hono';
import { decide, mayRun } from '../../lib/perms.js';
import { actions, MONEY_ROLES } from './actions.js';
import { findDonors } from './match.js';

export const api = new Hono();

const deskOnly = async (c, next) => {
  if (!MONEY_ROLES.includes(c.get('ctx').role)) return c.json({ error: 'volunteers cannot view this' }, 403);
  await next();
};
api.use('/gifts/imports', deskOnly);
api.use('/gifts/imports/*', deskOnly);

const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const PILE_MAX = 300;
const OUT_MAX = 100;
const squash = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
// Rows that name one donor the same way are that donor's gifts.
const donorKey = (d) => [squash(d.name), squash(d.email), String(d.phone || '').replace(/\D+/g, ''), squash(d.address), squash(d.postal).replace(/[^a-z0-9]/g, '')].join('|');

api.get('/gifts/imports', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const waiting = (await db.query(
    `select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as cents from gift_import_rows
      where workspace_id = $1 and status = 'waiting'`,
    [ctx.workspaceId],
  )).rows[0];
  const imports = (await db.query(
    `select i.id, i.file_name, i.created_at, i.undone_at, u.name as by_name,
            i.created_at > now() - interval '24 hours' as fresh,
            (select count(*)::int from gifts g where g.workspace_id = i.workspace_id and g.attrs ? 'import_id'
               and g.attrs->>'import_id' = i.id::text and g.deleted_at is null) as gifts,
            (select coalesce(sum(g.amount_cents), 0)::bigint from gifts g where g.workspace_id = i.workspace_id and g.attrs ? 'import_id'
               and g.attrs->>'import_id' = i.id::text and g.deleted_at is null) as cents,
            (select count(*)::int from gift_import_rows r where r.workspace_id = i.workspace_id and r.import_id = i.id and r.status = 'waiting') as waiting
       from gift_imports i left join users u on u.id = i.created_by
      where i.workspace_id = $1 order by i.created_at desc, i.id limit 20`,
    [ctx.workspaceId],
  )).rows;
  const canImport = mayRun(ctx, 'gift.import', actions['gift.import']);
  return c.json({
    can_import: canImport,
    waiting: { gifts: waiting.n, cents: Number(waiting.cents) },
    imports: imports.map((i) => ({
      id: i.id, file_name: i.file_name, created_at: i.created_at, by_name: i.by_name || null,
      gifts: i.gifts, cents: Number(i.cents), waiting: i.waiting, undone_at: i.undone_at || null,
      // For a day, by those who may; one being taken back that still has gifts on the books can be finished.
      can_undo: canImport && (i.undone_at ? i.gifts > 0 : !!i.fresh),
    })),
  });
});

api.get('/gifts/imports/waiting', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const rows = (await db.query(
    `select r.id, r.row_no, r.donor, r.amount_cents, r.date, r.method, r.slate, r.import_receipt, i.file_name
       from gift_import_rows r join gift_imports i on i.id = r.import_id
      where r.workspace_id = $1 and r.status = 'waiting' order by r.created_at, r.row_no, r.id limit ${PILE_MAX + 1}`,
    [ctx.workspaceId],
  )).rows.map((r) => ({ ...r, donor: parseJ(r.donor, {}) }));
  const groups = new Map();
  for (const r of rows.slice(0, PILE_MAX)) {
    const k = donorKey(r.donor);
    if (!groups.has(k)) groups.set(k, { donor: r.donor, gifts: [], cents: 0 });
    const g = groups.get(k);
    g.gifts.push({
      id: r.id, row: r.row_no, amount_cents: Number(r.amount_cents), date: dayOf(r.date), method: r.method || null,
      slate: r.slate || null, receipt: r.import_receipt || null, file_name: r.file_name || null,
    });
    g.cents += Number(r.amount_cents);
  }
  const list = [...groups.values()];
  // Who each could be, as the records stand now (a merge since, a new email).
  const found = await findDonors(db, ctx.workspaceId, list.map((g, i) => ({ i, donor: g.donor })));
  // Left out — by mistake, perhaps: listed so it can be brought back.
  const outAll = (await db.query(
    `select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as cents from gift_import_rows
      where workspace_id = $1 and status = 'left_out'`,
    [ctx.workspaceId],
  )).rows[0];
  const out = outAll.n ? (await db.query(
    `select r.id, r.row_no, r.donor, r.amount_cents, r.date, r.method, i.file_name
       from gift_import_rows r join gift_imports i on i.id = r.import_id
      where r.workspace_id = $1 and r.status = 'left_out' order by r.settled_at desc nulls last, r.id limit ${OUT_MAX}`,
    [ctx.workspaceId],
  )).rows : [];
  return c.json({
    groups: list.map((g, i) => {
      const m = found.get(i);
      // One sure record now (someone was added, two were made one): still a person's tap.
      const candidates = m.person ? [{ id: m.person.id, name: m.person.name, why: m.by === 'email' ? 'same email' : `same name and ${m.by}` }] : m.candidates;
      return { ...g, gifts: g.gifts.sort((a, b) => a.date.localeCompare(b.date)), candidates };
    }),
    more: rows.length > PILE_MAX,
    left_out: {
      gifts: outAll.n, cents: Number(outAll.cents),
      items: out.map((r) => ({
        id: r.id, row: r.row_no, donor: parseJ(r.donor, {}), amount_cents: Number(r.amount_cents), date: dayOf(r.date),
        method: r.method || null, file_name: r.file_name || null,
      })),
    },
  });
});

export const deskOnlyReads = [/^\/api\/gifts\/imports(\/.*)?$/];

// Donations → Needs you (GET /api/brief; money roles not kept out of
// Donations): how many gifts from a file wait for a donor, and how much — on
// the read the screen already makes, so the pile is never a block that goes
// missing by itself.
export const briefWaiting = async (db, ctx, brief) => {
  if (!MONEY_ROLES.includes(ctx.role) || decide(ctx.perms, 'money') === false) return;
  const w = (await db.query(
    `select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as cents from gift_import_rows
      where workspace_id = $1 and status = 'waiting'`,
    [ctx.workspaceId],
  )).rows[0];
  brief.giftsWaiting = { gifts: w.n, cents: Number(w.cents) };
};
