// Duplicates: two records for one person, found and made one.
//
//   GET /api/duplicates      the desk (the People area). Pairs that look like
//       one person: the same email; the same phone and name; the same name
//       at the same door; or a donor and a record with the same first and
//       last name in the same postal code (an address typed another way:
//       the money forms match only by email, so a donor can be a second
//       record — the rule the payments add up the year's limit by, ext/
//       payments limits.js; read from the donors, through its index
//       persons_same_donor_idx). → { pairs: [{ a, b, why: ['email' |
//       'phone' | 'address' | 'postal'] }], more } — each side with what the
//       desk needs to choose (contacts, gifts, shifts, when it was added).
//       Pairs marked "not the same" stay away. ?with=<person id>[,…]: only
//       the pairs with those records (Donations' Compare in Duplicates: a
//       gift's donor and the records its flag names), so a voter file's
//       other pairs never crowd them out; with more than one, those that a
//       live gift's "possibly the same donor" flag names together pair with
//       each other too ('flag'), whether or not a rule does — the pairs that
//       settle the flag are always there.
//   person.merge  { keep, drop }    desk. Everything that points at `drop`
//       — contacts, gifts and receipts, shifts, signs, lists, answers,
//       relationships, texts, requests, ladders… — moves to `keep`; where
//       `keep` already has the same thing (both on one shift, one list),
//       keep's stays. Keep's blanks are filled from drop (email, phone,
//       address, pin…), tags are joined, and drop leaves the list (deleted,
//       with merged_into, so an old link finds its way). Drop's "Not the
//       same" rulings become keep's. Gifts moved onto one donor are checked
//       against the limit again: a year that is now over is flagged like
//       any crossing gift (and a "Possibly the same donor" flag on the two
//       gives way to it); under on keep alone but over with another record
//       that may be them, a maybe naming it. A maybe with a third record
//       that only drop matched (keep's own phone, address and postal code
//       stand) is cleared, and said, so the desk can check that record.
//       → { keep, drop, filled, moved, flagged: [{ gift_id, year, reason,
//       maybe_same_donor? }], cleared: [{ gift_id, person_id, name,
//       shares, shared }] } — flagged: each such year and slate once, so
//       Duplicates can say over the limit now, or maybe; cleared: the third
//       record, what it shared with drop and those values (its phone,
//       address or postal code), so Duplicates names it and links to it.
//   person.notDuplicate  { a, b }   desk. "Not the same": the pair is not
//       shown again, and never added up for the year's limit; a gift
//       flagged as possibly one donor on them is added up again without
//       the other — the flag goes, or names what is left. → { a, b,
//       rechecked: [{ id, flagged, flag_reason }] }
import { Hono } from 'hono';
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { flagIfOver, maybesAbout, recheckMaybes } from '../../lib/gifts.js';
import { DEFAULT_SLATE } from '@starbase/shared/canvass';
import { sameText, samePhone, samePostal, sharesOf, sharedWords } from './same.js';

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
  // Whose circle a link came from, and who it brought in: keep, now.
  await tx.query('update relationships set from_person = $2 where workspace_id = $1 and from_person = $3', [ws, keep, drop]);
  await tx.query('update relationships set brought_in = $2 where workspace_id = $1 and brought_in = $3', [ws, keep, drop]);
};

// An email someone on the team signs in with: their own record is found by
// it (My people, Count me in), so a merge never takes it away.
const isLoginEmail = async (tx, ws, email) => {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  return !!(await tx.query(
    'select 1 from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and lower(u.email) = $2',
    [ws, e],
  )).rows[0];
};

// voter_number: the list of electors' number (ext/voternumber), as any other blank.
const FILL = ['email', 'phone', 'address', 'house_number', 'unit', 'city', 'postal', 'rating', 'rated_at', 'voted_at', 'voter_number'];

// Drop's "Not the same" rulings become keep's: whoever the desk said isn't
// drop isn't keep either (never keep and keep). Then drop's go.
const moveRulings = async (tx, ws, keep, drop) => {
  await tx.query(
    `insert into person_not_dupes (workspace_id, a, b, created_by, created_at)
     select workspace_id, least($2::uuid, other), greatest($2::uuid, other), created_by, created_at
       from (select workspace_id, case when a = $3 then b else a end as other, created_by, created_at
               from person_not_dupes where workspace_id = $1 and (a = $3 or b = $3)) x
      where other <> $2::uuid
     on conflict do nothing`,
    [ws, keep, drop],
  );
  await tx.query('delete from person_not_dupes where workspace_id = $1 and (a = $2 or b = $2)', [ws, drop]);
};

// The maybes a merge cleared that the desk should hear of: drop matched a
// third record (its phone, address or postal code) that keep doesn't —
// keep's own values stand — so a maybe that named that record, or one on
// that record that named drop, is gone or names others now. Not one over
// on its own record now (said as over), nor a record the desk ruled apart
// from keep (moveRulings). before: maybesAbout, read before the recheck;
// rechecked: what recheckMaybes changed. → [{ gift_id, person_id, name,
// shares, shared }]: the third record by name, what it shared with drop
// and those values as it has them (shared: ['604-555-2222']) — keep may
// not show them, and the name is the donor's too.
const clearedBy = async (tx, ws, { keep, drop }, before, rechecked) => {
  const ours = new Set([keep, drop]);
  const lost = [];
  for (const g of before) {
    const now = rechecked.find((x) => x.id === g.id);
    if (!now || (now.flagged && !now.maybe_same_donor)) continue;
    const names = now.maybe_same_donor || [];
    const had = Array.isArray(g.same_as) ? g.same_as : [];
    if (ours.has(g.person_id)) {
      for (const id of had) if (!ours.has(id) && !names.includes(id)) lost.push({ gift_id: g.id, person_id: id });
    } else if (had.some((id) => ours.has(id)) && !names.includes(keep)) {
      lost.push({ gift_id: g.id, person_id: g.person_id });
    }
  }
  if (!lost.length) return [];
  const ids = [...new Set(lost.map((l) => l.person_id))];
  const apart = new Set((await tx.query(
    'select a, b from person_not_dupes where workspace_id = $1 and (a = $2 or b = $2) and (a = any($3::uuid[]) or b = any($3::uuid[]))',
    [ws, keep, ids],
  )).rows.map((r) => (r.a === keep ? r.b : r.a)));
  const who = new Map((await tx.query(
    `select o.id, o.name, o.phone, o.address, o.postal, ${sharesOf('d', 'o')}
       from persons d join persons o on o.workspace_id = d.workspace_id and o.id = any($3::uuid[])
      where d.workspace_id = $1 and d.id = $2`,
    [ws, drop, ids],
  )).rows.map((r) => [r.id, {
    name: r.name, shares: sharedWords(r), shared: [r.by_phone && r.phone, r.by_address && r.address, r.by_postal && r.postal].filter(Boolean),
  }]));
  return lost.filter((l) => !apart.has(l.person_id) && who.has(l.person_id))
    .map((l) => ({ ...l, ...who.get(l.person_id) }));
};

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
      // Drop's email is a teammate's sign-in: it becomes keep's email, and
      // keep's own is kept beside it.
      const em = (x) => String(x || '').trim().toLowerCase();
      if (em(drop.email) && em(keep.email) && em(drop.email) !== em(keep.email)
        && !(await isLoginEmail(tx, ws, keep.email)) && (await isLoginEmail(tx, ws, drop.email))) {
        filled.email = drop.email;
        attrs.other_email = keep.email;
      }
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
      await moveRulings(tx, ws, keep.id, drop.id);

      // Drop leaves every list; an old link to it finds keep.
      await tx.query(
        `update persons set deleted_at = now(), updated_at = now(), attrs = jsonb_set(attrs, '{merged_into}', to_jsonb($3::text))
          where id = $1 and workspace_id = $2`,
        [drop.id, ws, keep.id],
      );

      // A maybe one donor on these two records is one donor now: checked
      // again. Over on keep alone, it gives way to the plain over-limit
      // reason, and that year is over now: said once, like a crossing gift.
      // One that named a third record only drop matched is said too.
      const before = await maybesAbout(tx, ws, [keep.id, drop.id]);
      const rechecked = await recheckMaybes(tx, ctx.workspace, [keep.id, drop.id], emit);
      const cleared = await clearedBy(tx, ws, { keep: keep.id, drop: drop.id }, before, rechecked);
      const flagged = [];
      const said = new Set();
      const plain = rechecked.filter((g) => g.flagged && !g.maybe_same_donor);
      if (plain.length) {
        const at = (await tx.query(
          `select id, extract(year from date)::int as y, coalesce(slate, $3) as slate from gifts
            where workspace_id = $1 and person_id = $2 and id = any($4::uuid[])`,
          [ws, keep.id, DEFAULT_SLATE, plain.map((g) => g.id)],
        )).rows;
        for (const g of plain) {
          const a = at.find((x) => x.id === g.id);
          if (!a || said.has(`${a.y}:${a.slate}`)) continue;
          said.add(`${a.y}:${a.slate}`);
          flagged.push({ gift_id: g.id, year: a.y, reason: g.flag_reason });
        }
      }

      // One donor now: each year and slate of their gifts against the limit
      // (a year said above is done).
      if (moved.gifts?.moved) {
        const years = (await tx.query(
          `select distinct extract(year from date)::int as y, coalesce(slate, $3) as slate from gifts
            where workspace_id = $1 and person_id = $2 and deleted_at is null`,
          [ws, keep.id, DEFAULT_SLATE],
        )).rows;
        for (const { y, slate } of years) {
          if (said.has(`${y}:${slate}`)) continue;
          const last = (await tx.query(
            `select id, date, flagged from gifts where workspace_id = $1 and person_id = $2 and deleted_at is null
               and coalesce(slate, $4) = $5 and date >= make_date($3, 1, 1) and date < make_date($3 + 1, 1, 1)
             order by date desc, created_at desc limit 1`,
            [ws, keep.id, y, DEFAULT_SLATE, slate],
          )).rows[0];
          if (!last || last.flagged) continue;
          // Under on keep alone, a maybe: over together with another record
          // that may be the same donor (sameAs) — the flag names it.
          const { flagReason, sameAs } = await flagIfOver(tx, ctx.workspace, { id: last.id, person_id: keep.id, date: last.date, donorName: keep.name, slate });
          if (flagReason) {
            const maybe = sameAs ? { maybe_same_donor: sameAs } : {};
            flagged.push({ gift_id: last.id, year: y, reason: flagReason, ...maybe });
            emit('gift', last.id, 'update', { flagged: true, flag_reason: flagReason, ...maybe });
          }
        }
      }

      emit('person', keep.id, 'update', { merged: drop.id, ...filled, tags });
      emit('person', drop.id, 'void', { merged_into: keep.id });
      return { keep: keep.id, drop: drop.id, filled: Object.keys(filled), moved, flagged, cleared };
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
      // Two people: a gift flagged as maybe one donor on these records is
      // added up again without the other.
      const rechecked = await recheckMaybes(tx, ctx.workspace, [a, b], emit);
      return { a, b, rechecked };
    },
  },
};

export const api = new Hono();

api.get('/duplicates', async (c) => {
  const ctx = c.get('ctx');
  // Raw emails, gift counts and tags: the desk only, whatever areas are granted.
  if (!DESK.includes(ctx.role)) return c.json({ error: 'the desk only' }, 403);
  const db = c.get('db');
  const ws = ctx.workspaceId;
  // ?with=<id>[,<id>…]: only the pairs with these records (up to 12).
  const only = c.req.query('with');
  const withIds = only == null ? null : only.split(',').map((s) => s.trim());
  if (withIds && (withIds.length > 12 || !withIds.every((id) => z.string().uuid().safeParse(id).success))) {
    return c.json({ error: 'with: person ids, comma-separated' }, 400);
  }
  const pairs = (await db.query(
    `with p as (
       select id,
              nullif(lower(trim(coalesce(email, ''))), '') as em,
              nullif(${samePhone('phone')}, '') as ph,
              ${sameText('name')} as nm,
              nullif(${sameText('address')}, '') as ad,
              lower(coalesce(unit, '')) as un
         from persons where workspace_id = $1 and deleted_at is null and kind = 'person'
     ), hits as (
       select a.id as a, b.id as b, 'email' as why from p a join p b on a.em = b.em and a.id < b.id
       union all
       select a.id, b.id, 'phone' from p a join p b on a.ph = b.ph and a.nm = b.nm and a.id < b.id where length(a.ph) >= 7
       union all
       select a.id, b.id, 'address' from p a join p b on a.nm = b.nm and a.ad = b.ad and a.un = b.un and a.id < b.id
       union all
       select distinct least(a.id, b.id), greatest(a.id, b.id), 'postal'
         from persons a
         join persons b on b.workspace_id = a.workspace_id and b.deleted_at is null and b.kind = 'person' and b.id <> a.id
          and ${sameText('b.last_name')} = ${sameText('a.last_name')} and ${sameText('b.first_name')} = ${sameText('a.first_name')}
          and ${samePostal('b.postal')} = ${samePostal('a.postal')}
        where a.workspace_id = $1 and a.deleted_at is null and a.kind = 'person'
          and a.id in (select person_id from gifts where workspace_id = $1 and deleted_at is null)
          and ${sameText('a.first_name')} <> '' and ${sameText('a.last_name')} <> '' and length(${samePostal('a.postal')}) >= 6
     )
     ${withIds && withIds.length > 1 ? `, on_flag as (
       select g.person_id as id, g.id as gift from gifts g
        where g.workspace_id = $1 and g.deleted_at is null and g.flagged and g.attrs ? 'maybe_same_donor'
       union
       select e::uuid, g.id from gifts g cross join lateral jsonb_array_elements_text(g.attrs->'maybe_same_donor') e
        where g.workspace_id = $1 and g.deleted_at is null and g.flagged and g.attrs ? 'maybe_same_donor'
     ), named as (
       select distinct x.id as a, y.id as b, 'flag' as why
         from on_flag x join on_flag y on y.gift = x.gift and x.id < y.id
         join persons px on px.id = x.id and px.workspace_id = $1 and px.deleted_at is null and px.kind = 'person'
         join persons py on py.id = y.id and py.workspace_id = $1 and py.deleted_at is null and py.kind = 'person'
        where x.id = any($2::uuid[]) and y.id = any($2::uuid[])
     ), all_hits as (select * from hits union all select * from named)` : ', all_hits as (select * from hits)'}
     select h.a, h.b, array_agg(distinct h.why) as why from all_hits h
      where not exists (select 1 from person_not_dupes n where n.workspace_id = $1 and n.a = h.a and n.b = h.b)${withIds ? `
        and (h.a = any($2::uuid[]) or h.b = any($2::uuid[]))` : ''}
      group by h.a, h.b
      order by count(*) desc, h.a, h.b
      limit ${LIMIT + 1}`,
    withIds ? [ws, withIds] : [ws],
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
