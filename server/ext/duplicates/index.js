// Duplicates: two records for one person, found and made one.
//
//   GET /api/duplicates      the desk (the People area). Pairs that look like
//       one person: the same email; the same phone and name; or the same
//       name at the same door. → { pairs: [{ a, b, why: ['email' | 'phone' |
//       'address'] }], more } — each side with what the desk needs to choose
//       (contacts, gifts, shifts, when it was added). Pairs marked "not the
//       same" stay away.
//   person.merge  { keep, drop }    desk. Everything that points at `drop`
//       — contacts, gifts and receipts, shifts, signs, lists, answers,
//       relationships, texts, requests, ladders… — moves to `keep`; where
//       `keep` already has the same thing (both on one shift, one list),
//       keep's stays. Keep's blanks are filled from drop (email, phone,
//       address, pin…), tags are joined, and drop leaves the list (deleted,
//       with merged_into, so an old link finds its way). Gifts moved onto
//       one donor are checked against the limit again: a year that is now
//       over is flagged like any crossing gift.
//   person.notDuplicate  { a, b }   desk. "Not the same": the pair is not
//       shown again.
import { Hono } from 'hono';
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { flagIfOver } from '../../lib/gifts.js';
import { DEFAULT_SLATE } from '@starbase/shared/canvass';

export const sql = `
create table if not exists person_not_dupes (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  a uuid not null,
  b uuid not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (workspace_id, a, b),
  check (a < b)
);
`;

const DESK = ['manager', 'treasurer', 'staff'];
const uuid = () => z.string().uuid();
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const LIMIT = 100;

// Every column that names a person, in every table but persons itself:
// read from the database, so a feature added later is merged too.
const personColumns = async (tx) => (await tx.query(
  `select c.table_name as t, c.column_name as col,
          exists (select 1 from information_schema.columns w
                  where w.table_schema = c.table_schema and w.table_name = c.table_name and w.column_name = 'workspace_id') as has_ws
     from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = current_schema() and c.data_type = 'uuid'
      and c.column_name in ('person_id', 'person_a', 'person_b')
      and c.table_name not in ('persons', 'relationships')
    order by c.table_name, c.column_name`,
)).rows;

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Move one table's rows from drop to keep. All at once if nothing clashes;
// otherwise row by row, and a row keep already has (a unique key) goes.
const moveRows = async (tx, ws, { t, col, has_ws: hasWs }, keep, drop) => {
  const where = `${q(col)} = $2${hasWs ? ' and workspace_id = $3' : ''}`;
  const params = hasWs ? [keep, drop, ws] : [keep, drop];
  await tx.query('savepoint merge_all');
  try {
    const r = await tx.query(`update ${q(t)} set ${q(col)} = $1 where ${where}`, params);
    await tx.query('release savepoint merge_all');
    return { moved: r.affectedRows ?? r.rowCount ?? 0, dropped: 0 };
  } catch {
    await tx.query('rollback to savepoint merge_all');
  }
  const rows = (await tx.query(
    `select ctid::text as c from ${q(t)} where ${q(col)} = $1${hasWs ? ' and workspace_id = $2' : ''}`,
    hasWs ? [drop, ws] : [drop],
  )).rows;
  let moved = 0;
  let dropped = 0;
  for (const { c } of rows) {
    await tx.query('savepoint merge_row');
    try {
      await tx.query(`update ${q(t)} set ${q(col)} = $1 where ctid = $2::tid`, [keep, c]);
      await tx.query('release savepoint merge_row');
      moved += 1;
    } catch {
      await tx.query('rollback to savepoint merge_row');
      await tx.query(`delete from ${q(t)} where ctid = $1::tid`, [c]);
      dropped += 1;
    }
  }
  return { moved, dropped };
};

// Relationships are pairs in order (person_a < person_b), one live pair at
// most: drop's become keep's, re-ordered; keep–drop itself goes.
const moveRelationships = async (tx, ws, keep, drop) => {
  const exists = (await tx.query(`select to_regclass('relationships') is not null as ok`)).rows[0].ok;
  if (!exists) return;
  const rows = (await tx.query(
    `select id, person_a, person_b, removed_at from relationships where workspace_id = $1 and (person_a = $2 or person_b = $2)`,
    [ws, drop],
  )).rows;
  for (const r of rows) {
    const other = r.person_a === drop ? r.person_b : r.person_a;
    if (other === keep) {
      await tx.query('delete from relationships where id = $1', [r.id]);
      continue;
    }
    const [a, b] = keep < other ? [keep, other] : [other, keep];
    const clash = !r.removed_at && (await tx.query(
      'select 1 from relationships where workspace_id = $1 and person_a = $2 and person_b = $3 and removed_at is null and id <> $4',
      [ws, a, b, r.id],
    )).rows[0];
    if (clash) await tx.query('delete from relationships where id = $1', [r.id]);
    else await tx.query('update relationships set person_a = $2, person_b = $3 where id = $1', [r.id, a, b]);
  }
};

const FILL = ['email', 'phone', 'address', 'house_number', 'unit', 'city', 'postal', 'rating', 'rated_at', 'voted_at'];

export const actions = {
  'person.merge': {
    roles: DESK,
    input: z.object({ keep: uuid(), drop: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      if (input.keep === input.drop) throw httpError(400, 'that is the same record');
      const both = (await tx.query(
        'select * from persons where workspace_id = $1 and id = any($2::uuid[]) and deleted_at is null for update',
        [ws, [input.keep, input.drop]],
      )).rows;
      const keep = both.find((p) => p.id === input.keep);
      const drop = both.find((p) => p.id === input.drop);
      if (!keep || !drop) throw httpError(404, 'one of them is gone — reload');

      // Keep's record: its own values stand; blanks come from drop.
      const filled = {};
      for (const k of FILL) if ((keep[k] == null || keep[k] === '') && drop[k] != null && drop[k] !== '') filled[k] = drop[k];
      if (keep.lat == null && drop.lat != null) { filled.lat = drop.lat; filled.lng = drop.lng; }
      const tags = [...new Set([...parseJ(keep.tags, []), ...parseJ(drop.tags, [])])];
      const socials = { ...parseJ(drop.socials, {}), ...parseJ(keep.socials, {}) };
      const attrs = { ...parseJ(drop.attrs, {}), ...parseJ(keep.attrs, {}) };
      delete attrs.merged_into;
      const sets = Object.keys(filled).map((k, i) => `${q(k)} = $${i + 6}`);
      await tx.query(
        `update persons set tags = $3, socials = $4, attrs = $5, updated_at = now()${sets.length ? `, ${sets.join(', ')}` : ''}
          where id = $1 and workspace_id = $2`,
        [keep.id, ws, JSON.stringify(tags), JSON.stringify(socials), JSON.stringify(attrs), ...Object.values(filled)],
      );

      // Everything that points at drop.
      const moved = {};
      for (const c of await personColumns(tx)) {
        const r = await moveRows(tx, ws, c, keep.id, drop.id);
        if (r.moved || r.dropped) moved[c.t] = r;
      }
      await moveRelationships(tx, ws, keep.id, drop.id);
      await tx.query('delete from person_not_dupes where workspace_id = $1 and (a = $2 or b = $2)', [ws, drop.id]);

      // Drop leaves every list; an old link to it finds keep.
      await tx.query(
        `update persons set deleted_at = now(), updated_at = now(), attrs = jsonb_set(attrs, '{merged_into}', to_jsonb($3::text))
          where id = $1 and workspace_id = $2`,
        [drop.id, ws, keep.id],
      );

      // One donor now: each year and slate of their gifts against the limit.
      const flagged = [];
      if (moved.gifts?.moved) {
        const years = (await tx.query(
          `select distinct extract(year from date)::int as y, coalesce(slate, $3) as slate from gifts
            where workspace_id = $1 and person_id = $2 and deleted_at is null`,
          [ws, keep.id, DEFAULT_SLATE],
        )).rows;
        for (const { y, slate } of years) {
          const last = (await tx.query(
            `select id, date, flagged from gifts where workspace_id = $1 and person_id = $2 and deleted_at is null
               and coalesce(slate, $4) = $5 and date >= make_date($3, 1, 1) and date < make_date($3 + 1, 1, 1)
             order by date desc, created_at desc limit 1`,
            [ws, keep.id, y, DEFAULT_SLATE, slate],
          )).rows[0];
          if (!last || last.flagged) continue;
          const { flagReason } = await flagIfOver(tx, ctx.workspace, { id: last.id, person_id: keep.id, date: last.date, donorName: keep.name, slate });
          if (flagReason) {
            flagged.push({ gift_id: last.id, year: y, reason: flagReason });
            emit('gift', last.id, 'update', { flagged: true, flag_reason: flagReason });
          }
        }
      }

      emit('person', keep.id, 'update', { merged: drop.id, ...filled, tags });
      emit('person', drop.id, 'void', { merged_into: keep.id });
      return { keep: keep.id, drop: drop.id, filled: Object.keys(filled), moved, flagged };
    },
  },

  'person.notDuplicate': {
    roles: DESK,
    input: z.object({ a: uuid(), b: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      if (input.a === input.b) throw httpError(400, 'that is the same record');
      const [a, b] = input.a < input.b ? [input.a, input.b] : [input.b, input.a];
      const n = (await tx.query(
        'select count(*)::int as n from persons where workspace_id = $1 and id = any($2::uuid[])', [ctx.workspaceId, [a, b]],
      )).rows[0].n;
      if (n !== 2) throw httpError(404, 'person not found');
      await tx.query(
        `insert into person_not_dupes (workspace_id, a, b, created_by) values ($1, $2, $3, $4) on conflict do nothing`,
        [ctx.workspaceId, a, b, ctx.user.id],
      );
      emit('person', a, 'update', { not_duplicate_of: b });
      return { a, b };
    },
  },
};

export const api = new Hono();

api.get('/duplicates', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const pairs = (await db.query(
    `with p as (
       select id,
              nullif(lower(trim(coalesce(email, ''))), '') as em,
              nullif(right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10), '') as ph,
              lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) as nm,
              nullif(lower(regexp_replace(trim(coalesce(address, '')), '\\s+', ' ', 'g')), '') as ad,
              lower(coalesce(unit, '')) as un
         from persons where workspace_id = $1 and deleted_at is null and kind = 'person'
     ), hits as (
       select a.id as a, b.id as b, 'email' as why from p a join p b on a.em = b.em and a.id < b.id
       union all
       select a.id, b.id, 'phone' from p a join p b on a.ph = b.ph and a.nm = b.nm and a.id < b.id where length(a.ph) >= 7
       union all
       select a.id, b.id, 'address' from p a join p b on a.nm = b.nm and a.ad = b.ad and a.un = b.un and a.id < b.id
     )
     select h.a, h.b, array_agg(distinct h.why) as why from hits h
      where not exists (select 1 from person_not_dupes n where n.workspace_id = $1 and n.a = h.a and n.b = h.b)
      group by h.a, h.b
      order by count(*) desc, h.a, h.b
      limit ${LIMIT + 1}`,
    [ws],
  )).rows;
  const more = pairs.length > LIMIT;
  const shown = pairs.slice(0, LIMIT);
  const ids = [...new Set(shown.flatMap((p) => [p.a, p.b]))];
  const people = new Map((await db.query(
    `select p.id, p.name, p.email, p.phone, p.address, p.unit, p.city, p.tags, p.rating, p.created_at,
            (select count(*)::int from contacts x where x.person_id = p.id and x.workspace_id = p.workspace_id) as contacts,
            (select count(*)::int from gifts g where g.person_id = p.id and g.workspace_id = p.workspace_id and g.deleted_at is null) as gifts,
            (select count(*)::int from shift_assignments s where s.person_id = p.id and s.workspace_id = p.workspace_id) as shifts
       from persons p where p.workspace_id = $1 and p.id = any($2::uuid[])`,
    [ws, ids],
  )).rows.map((r) => [r.id, { ...r, tags: parseJ(r.tags, []) }]));
  const order = (x) => (Array.isArray(x) ? x : String(x || '').replace(/[{}]/g, '').split(',').filter(Boolean));
  return c.json({
    pairs: shown.map((p) => ({ a: people.get(p.a), b: people.get(p.b), why: order(p.why) })).filter((p) => p.a && p.b),
    more,
  });
});

export const deskOnlyReads = ['/duplicates'];
export const exportTables = ['person_not_dupes'];
