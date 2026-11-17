// Profile field reads, mounted under /api (signed in).
//
//   GET /fields               desk: every field — on the profile first (in
//                             order), then taken off — with how many people
//                             have it filled in, each choice's count, and the
//                             most common values of a Text or Number field
//                             (the People filter offers those)
//   GET /fields/:id           any role: one field's name and kind, for the
//                             words on a People / Calls filter chip. A
//                             volunteer only gets a field on the profile
//                             marked "Volunteers can see this" (any other
//                             is not found) — the same names their profiles
//                             already show them.
//   GET /persons/:id/fields   any role: this person's fields and values.
//                             The desk gets every field on the profile (empty
//                             ones too, to fill in); a volunteer only the
//                             filled-in ones a manager marked "Volunteers can
//                             see this", and only their words.
//
// Counts are of every value on record (a person since taken off the list
// included): the same count that keeps a field's kind fixed. /fields is a
// desk-only read (index.js) and the handler checks the role again.
import { Hono } from 'hono';
import { fieldOut } from './actions.js';
import { CHOICE_KEY_SQL } from './kinds.js';
import { LIST_TOP, LIST_WORDS_MAX } from '@starbase/shared/fieldlists';
import { DOESNT_SUIT, ONLY_TEXT, suits, wordsOf } from './convert.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMON_MAX = 8;

api.get('/fields', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const fields = (await db.query(
    `select f.*, (select count(*)::int from person_field_values v
                  where v.workspace_id = f.workspace_id and v.field_id = f.id) as filled
     from person_fields f where f.workspace_id = $1
     order by (f.retired_at is not null), f.position, f.created_at`,
    [ws],
  )).rows;
  // Each choice's count (Pick one, Yes/No): a few rows per field.
  const counts = (await db.query(
    `select v.field_id, v.value, count(*)::int as n from person_field_values v
     join person_fields f on f.id = v.field_id and f.kind in ('choice', 'yesno')
     where v.workspace_id = $1 group by v.field_id, v.value
     union all
     select v.field_id, e.value, count(*)::int from person_field_values v
     join person_fields f on f.id = v.field_id and f.kind = 'choices'
     cross join lateral jsonb_array_elements(case when jsonb_typeof(v.value) = 'array' then v.value else '[]'::jsonb end) e
     where v.workspace_id = $1 group by v.field_id, e.value`,
    [ws],
  )).rows;
  // What a filter can find (Text, Number): the most common values on people
  // still on the list — text as choices compare ("punjabi" and "Punjabi"
  // are one). From the same scan, for Text: how many different words (d)
  // and how many people the 40 most common cover (top) — whether it suits
  // a list (convert.js).
  const grouped = (await db.query(
    `select field_id, kind, words, n, r::int as r, d::int as d, people::int as people, top::int as top from (
       select v.field_id, f.kind, min(v.value #>> '{}') as words, count(*)::int as n,
              row_number() over (partition by v.field_id order by count(*) desc, min(v.value #>> '{}')) as r,
              count(*) over (partition by v.field_id) as d,
              sum(count(*)) over (partition by v.field_id) as people,
              sum(count(*)) over (partition by v.field_id order by count(*) desc, min(v.value #>> '{}') rows between unbounded preceding and current row) as top
       from person_field_values v
       join persons p on p.id = v.person_id and p.deleted_at is null
       join person_fields f on f.id = v.field_id and f.kind in ('text', 'number')
       where v.workspace_id = $1
       group by v.field_id, f.kind, case when f.kind = 'text' then ${CHOICE_KEY_SQL("v.value #>> '{}'")} else v.value #>> '{}' end
     ) t where r <= $2 or r = least(d, $3) order by field_id, r`,
    [ws, COMMON_MAX, LIST_TOP],
  )).rows;
  const common = grouped.filter((r) => r.r <= COMMON_MAX);
  return c.json({
    fields: fields.map((f) => {
      const out = { ...fieldOut(f), filled: f.filled };
      if (f.kind === 'choice' || f.kind === 'choices' || f.kind === 'yesno') {
        out.uses = counts.filter((r) => r.field_id === f.id).map((r) => ({ value: r.value, n: r.n }));
      }
      if (f.kind === 'text' || f.kind === 'number') {
        out.common = common.filter((r) => r.field_id === f.id)
          .map((r) => ({ value: r.kind === 'number' ? Number(r.words) : r.words, n: r.n }));
      }
      if (f.kind === 'text') {
        const last = grouped.find((r) => r.field_id === f.id && r.r === Math.min(r.d, LIST_TOP));
        Object.assign(out, { words: last?.d || 0, top40: last?.top || 0 });
        out.suits = suits({ distinct: out.words, top40: out.top40, people: last?.people || 0 });
      }
      return out;
    }),
  });
});

// Turn into a list (convert.js): a Text field's words, grouped as choices
// compare, most people first, at most 500 — managers only.
api.get('/fields/:id/words', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'only a manager can turn a field into a list' }, 403);
  const db = c.get('db');
  const f = (await db.query('select * from person_fields where id = $1 and workspace_id = $2', [id, ctx.workspaceId])).rows[0];
  if (!f) return c.json({ error: 'not found' }, 404);
  if (f.retired_at || f.kind !== 'text' || f.as_written_of) return c.json({ error: ONLY_TEXT }, 409);
  const w = await wordsOf(db, ctx.workspaceId, f.id, LIST_WORDS_MAX);
  if (!suits(w)) return c.json({ error: DOESNT_SUIT }, 409);
  const shown = w.words.reduce((m, x) => m + x.n, 0);
  return c.json({
    field: { id: f.id, name: f.name, kind: f.kind },
    people: w.people, distinct: w.distinct,
    words: w.words.map(({ word, n }) => ({ word, n })),
    rest: { distinct: w.distinct - w.words.length, people: w.people - shown },
  });
});

api.get('/fields/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const f = (await c.get('db').query(
    'select id, name, kind, volunteers, retired_at from person_fields where id = $1 and workspace_id = $2', [id, ctx.workspaceId],
  )).rows[0];
  if (!f || (ctx.role === 'volunteer' && (!f.volunteers || f.retired_at))) return c.json({ error: 'not found' }, 404);
  return c.json({ field: { id: f.id, name: f.name, kind: f.kind } });
});

api.get('/persons/:id/fields', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const person = (await db.query(
    'select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!person) return c.json({ error: 'not found' }, 404);
  const desk = ctx.role !== 'volunteer';
  const rows = (await db.query(
    `select f.*, v.value, v.updated_at as value_at, u.name as by_name
     from person_fields f
     left join person_field_values v on v.field_id = f.id and v.person_id = $2
     left join users u on u.id = v.updated_by
     where f.workspace_id = $1 and f.retired_at is null ${desk ? '' : 'and f.volunteers and not f.sensitive and v.id is not null'}
     order by f.position, f.created_at`,
    [ctx.workspaceId, person.id],
  )).rows;
  if (!desk) {
    return c.json({
      fields: rows.map((f) => ({ id: f.id, name: f.name, kind: f.kind, value: f.value ?? null })),
      edit: false,
    });
  }
  return c.json({
    fields: rows.map((f) => ({
      ...fieldOut(f), value: f.value ?? null, at: f.value_at || null, by_name: f.by_name || null,
    })),
    edit: true,
  });
});
