// Relationship reads, mounted under /api (signed in).
//
//   GET /relationships/mine          any role: "My people" — the signed-in
//       person's own circle (their record is the one with their login email):
//       { me: { id, name } | null, people: [{ id, kind, note, close, brought_in,
//       linked_at, last_at, person }] }. Each person goes through the
//       volunteer rule (lib/viewer.js): no one else's email, no money tags.
//       last_at: when the signed-in user last logged a contact with them.
//   GET /persons/:id/knows           desk: a profile's Knows — { knows: [{ id,
//       kind, note, close, linked_at, person: { id, name, rating, dnc } }], brought_in_by:
//       { id, name } | null, nudge: { id, name } | null, same_as: [{ id, name }] }.
//       nudge: for someone undecided or not rated yet, a supporter (rated 1,
//       then 2) who knows them — never for someone tagged do-not-contact, and
//       never naming a supporter who is. same_as: who a volunteer's add may
//       have doubled (attrs.maybe_same_as, either way round — actions.js).
//       dnc: asked not to be contacted (lib/reach.js NO_CONTACT, any capitals).
//   GET /relationships/key?ids=a,b,…  desk: the key ties of up to 20 people
//       (a Calls card and the next in the queue) — { ties: { [id]: { n, top:
//       [{ id, kind, close, person: { id, name, rating } }] } } }. top: the
//       first two in shared/ties.js rankTies (never someone asked not to be
//       contacted); n: all their live links to people on the list, those
//       too. Someone with none: { n: 0, top: [] }; someone not on this
//       campaign's list is absent. More than 20 ids, or a bad one: 400.
//   GET /relationships/connected     desk: Most connected — { people: [{ id,
//       name, rating, knows, supporters, brought_in }] }, most links first.
//       supporters: how many of the people they know are rated 1 or 2.
//       brought_in: how many people came in through them (removed links
//       too: "Brought in by" stays true).
//
// Volunteers read only their own circle: the others are desk-only reads
// (index.js) and each handler checks the role again — TIE_READERS, so a
// volunteer granted People (past deskOnlyReads) still never reads them.
// /key and /connected are the People area's (lib/perms.js); /mine is in no
// area on purpose, so My people stays with anyone denied People.
import { Hono } from 'hono';
import { rankTies } from '@starbase/shared/ties';
import { NO_CONTACT } from '../../lib/reach.js';
import { azKey } from '../../lib/az.js';
import { selfPerson } from './match.js';
import { PERSON_COLS, personOut } from './actions.js';
import { TIE_READERS } from './index.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDesk = (c) => TIE_READERS.includes(c.get('ctx').role);
const refuse = (c) => c.json({ error: 'volunteers cannot view this' }, 403);
const SUPPORT = `('1', '2')`;
const CONNECTED_MAX = 200;
const KEY_MAX = 20;
const KEY_TOP = 2;
// Asked not to be contacted, whatever the capitals (as lib/reach.js reads it).
export const dncSql = (alias) => `(lower(${alias}.tags::text) like '%"${NO_CONTACT}"%')`;

// The other end of each live link of person $2, people still on the list.
const LINKS_OF = `relationships r
  join persons p on p.id = (case when r.person_a = $2 then r.person_b else r.person_a end) and p.deleted_at is null
  where r.workspace_id = $1 and r.removed_at is null and (r.person_a = $2 or r.person_b = $2)`;

export const myPeopleCount = async (db, ctx) => {
  const me = await selfPerson(db, ctx, null);
  if (!me) return 0;
  return (await db.query(`select count(*)::int as n from ${LINKS_OF}`, [ctx.workspaceId, me.id])).rows[0].n;
};

api.get('/relationships/mine', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const me = await selfPerson(db, ctx, null);
  if (!me) return c.json({ me: null, people: [] });
  const cols = PERSON_COLS.split(',').map((s) => `p.${s.trim()}`).join(', ');
  const rows = (await db.query(
    `select r.id as link_id, r.kind, r.note as link_note, r.close as link_close, r.brought_in, r.created_at as linked_at, ${cols},
            (select max(k.created_at) from contacts k
             where k.workspace_id = r.workspace_id and k.person_id = p.id and k.created_by = $3) as last_at
     from ${LINKS_OF}
     order by ${azKey('p')}`,
    [ctx.workspaceId, me.id, ctx.user.id],
  )).rows;
  const view = personOut(ctx);
  return c.json({
    me: { id: me.id, name: me.name },
    people: rows.map((r) => ({
      id: r.link_id,
      kind: r.kind,
      note: r.link_note ?? null,
      close: Boolean(r.link_close),
      brought_in: r.brought_in === r.id,
      linked_at: r.linked_at,
      last_at: r.last_at ?? null,
      person: view(r),
    })),
  });
});

api.get('/persons/:id/knows', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const person = (await db.query(
    `select id, rating, ${dncSql('persons')} as dnc, attrs->>'maybe_same_as' as same from persons
     where id = $1 and workspace_id = $2 and deleted_at is null`, [id, ws],
  )).rows[0];
  if (!person) return c.json({ error: 'not found' }, 404);
  const rows = (await db.query(
    `select r.id, r.kind, r.note, r.close, r.created_at as linked_at, p.id as pid, p.name, p.last_name, p.rating, ${dncSql('p')} as dnc
     from ${LINKS_OF}
     order by ${azKey('p')}`,
    [ws, id],
  )).rows;
  const knows = rows.map((r) => ({
    id: r.id, kind: r.kind, note: r.note ?? null, close: Boolean(r.close), linked_at: r.linked_at,
    person: { id: r.pid, name: r.name, last_name: r.last_name ?? null, rating: r.rating ?? null, dnc: Boolean(r.dnc) },
  }));
  // Who brought them in: the other end of the link that added them (kept
  // even if that link was later removed).
  const by = (await db.query(
    `select p.id, p.name from relationships r
     join persons p on p.id = (case when r.person_a = $2 then r.person_b else r.person_a end) and p.deleted_at is null
     where r.workspace_id = $1 and r.brought_in = $2
     order by r.created_at limit 1`,
    [ws, id],
  )).rows[0] || null;
  let nudge = null;
  if ((person.rating == null || person.rating === '3') && !person.dnc) {
    const s = knows
      .filter((k) => (k.person.rating === '1' || k.person.rating === '2') && !k.person.dnc)
      .sort((x, y) => x.person.rating.localeCompare(y.person.rating) || new Date(y.linked_at) - new Date(x.linked_at))[0];
    if (s) nudge = { id: s.person.id, name: s.person.name };
  }
  // A volunteer's add that may have doubled someone: the one it may be, or
  // the ones that may be them.
  const sameAs = (await db.query(
    `select id, name from persons
     where workspace_id = $1 and deleted_at is null and id <> $2
       and (id = $3::uuid or (attrs ? 'maybe_same_as' and attrs->>'maybe_same_as' = $2::text))
     order by created_at, id limit 5`,
    [ws, id, UUID_RE.test(person.same || '') ? person.same : null],
  )).rows.map((r) => ({ id: r.id, name: r.name }));
  return c.json({ knows, brought_in_by: by, nudge, same_as: sameAs });
});

api.get('/relationships/connected', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const ctx = c.get('ctx');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), CONNECTED_MAX);
  const rows = (await c.get('db').query(
    `with ends as (
       select person_a as who, person_b as other from relationships where workspace_id = $1 and removed_at is null
       union all
       select person_b, person_a from relationships where workspace_id = $1 and removed_at is null
     ), top as (
       select p.id, p.name, p.rating, count(*)::int as knows,
              (count(*) filter (where o.rating in ${SUPPORT}))::int as supporters
       from ends e
       join persons p on p.id = e.who and p.deleted_at is null
       join persons o on o.id = e.other and o.deleted_at is null
       group by p.id, p.name, p.rating
       order by knows desc, supporters desc, ${azKey('p')}
       limit $2
     ), brought as (
       select from_person as who, count(*)::int as n from relationships
       where workspace_id = $1 and brought_in is not null and from_person = any(select id from top)
       group by from_person
     )
     select t.*, coalesce(b.n, 0) as brought_in from top t left join brought b on b.who = t.id
     order by t.knows desc, t.supporters desc, lower(t.name), t.id`,
    [ctx.workspaceId, limit],
  )).rows;
  return c.json({
    people: rows.map((r) => ({
      id: r.id, name: r.name, rating: r.rating ?? null, knows: r.knows, supporters: r.supporters, brought_in: r.brought_in,
    })),
  });
});

api.get('/relationships/key', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const ctx = c.get('ctx');
  const asked = String(c.req.query('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (asked.length > KEY_MAX) return c.json({ error: `at most ${KEY_MAX} people at a time` }, 400);
  if (!asked.every((id) => UUID_RE.test(id))) return c.json({ error: 'ids: people’s ids, with commas' }, 400);
  const ids = [...new Set(asked.map((id) => id.toLowerCase()))];
  if (!ids.length) return c.json({ ties: {} });
  // Each end through its own index (relationships_a_idx, _b_idx); the people
  // asked about are read once, so someone with no links still answers.
  const rows = (await c.get('db').query(
    `select w.id as who, e.id, e.kind, e.close, e.linked_at, e.pid, e.name, e.rating, e.dnc
     from persons w
     left join (
       select l.who, l.id, l.kind, l.close, l.linked_at, o.id as pid, o.name, o.rating, ${dncSql('o')} as dnc
       from (
         select r.person_a as who, r.person_b as other, r.id, r.kind, r.close, r.created_at as linked_at from relationships r
         where r.workspace_id = $1 and r.removed_at is null and r.person_a = any($2::uuid[])
         union all
         select r.person_b, r.person_a, r.id, r.kind, r.close, r.created_at from relationships r
         where r.workspace_id = $1 and r.removed_at is null and r.person_b = any($2::uuid[])
       ) l
       join persons o on o.id = l.other and o.deleted_at is null
     ) e on e.who = w.id
     where w.workspace_id = $1 and w.id = any($2::uuid[]) and w.deleted_at is null`,
    [ctx.workspaceId, ids],
  )).rows;
  const by = {};
  for (const r of rows) {
    by[r.who] ||= [];
    if (r.id) {
      by[r.who].push({
        id: r.id, kind: r.kind, close: Boolean(r.close), linked_at: r.linked_at,
        person: { id: r.pid, name: r.name, last_name: r.last_name ?? null, rating: r.rating ?? null, dnc: Boolean(r.dnc) },
      });
    }
  }
  const ties = {};
  for (const [who, list] of Object.entries(by)) {
    ties[who] = {
      n: list.length,
      top: rankTies(list).slice(0, KEY_TOP).map((t) => ({
        id: t.id, kind: t.kind, close: t.close, person: { id: t.person.id, name: t.person.name, rating: t.person.rating },
      })),
    };
  }
  return c.json({ ties });
});
