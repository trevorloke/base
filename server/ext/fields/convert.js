// Turn into a list: a Text field with words on file becomes a Pick one,
// without losing a word (README → Profile fields).
//
//   GET /fields/:id/words   (api.js) its words, grouped by choiceKey, most
//                           people first, at most 500 — refused when they
//                           are mostly different (it doesn't suit a list)
//   field.list.start  { id, choices, display, map: [{ word, to }] }   managers
//                     A word whose choiceKey is a choice's goes to it; the
//                     map says where the others go; null or unmapped are
//                     kept as written, in "<name> as written" (made here,
//                     right after it). The plan is kept on the field
//                     (converting) and a job does the work, a chunk at a
//                     time. While it runs the field takes no new words.
//   field.list.stop   { id }   managers: the plan goes; what's done stays.
//   field.list.step   the job: 1,000 values a chunk, each its own write,
//                     so other writes wait one chunk at most. Each chunk
//                     re-reads the plan: a Stop, or a newer start, wins.
import { z } from 'zod';
import { newId, runAction } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { cancelJobs, enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { choiceKey, suitsList, LIST_TOP, LIST_WORDS_MAX } from '@base-win/shared/fieldlists';
import {
  CHOICE_KEY_SQL, CHOICE_MAX, CHOICES_MAX, FIELDS_MAX, NAME_MAX, TEXT_MAX, cleanName, nameKey, parseJ,
} from './kinds.js';
import { LIST_SEEDS } from './people.js';

export const CHUNK = 1000;
const CHUNKS_PER_RUN = 10;
// The browser suite's handle (e2e-picklists.mjs): smaller chunks and a
// pause between them, so a person can press Stop while one runs.
const PACE = { size: CHUNK, waitMs: 0 };
export const _setPaceForTest = ({ size = CHUNK, waitMs = 0 } = {}) => { PACE.size = size; PACE.waitMs = waitMs; };
const KEY = CHOICE_KEY_SQL("v.value #>> '{}'");
export const ONLY_TEXT = 'Only a Text field can be turned into a list';
export const DOESNT_SUIT = 'Its words are mostly different — it doesn’t suit a list';
const already = (name) => `“${name}” is already being turned into a list`;

// "<name> as written": the Text field, right after a list, that keeps the
// words the list couldn't take (a conversion's; an import's "Keep as
// written"; a move's Undo). One already of that name and kind is reused.
// Private, volunteers and taken off as the list is. → its row.
export const makeAsWritten = async (tx, ctx, field, emit, extra = {}) => {
  const ws = ctx.workspaceId;
  const name = `${cleanName(field.name).slice(0, NAME_MAX - 11)} as written`;
  const had = (await tx.query(
    'select * from person_fields where workspace_id = $1 and lower(name) = $2 order by (retired_at is null) desc, created_at limit 1 for update',
    [ws, nameKey(name)],
  )).rows[0];
  if (had && had.kind === 'text' && (!had.retired_at || field.retired_at)) {
    if (had.as_written_of !== field.id) {
      await tx.query('update person_fields set as_written_of = $3, updated_at = now() where id = $1 and workspace_id = $2', [had.id, ws, field.id]);
      emit('person_field', had.id, 'update', { as_written_of: field.id });
    }
    return { ...had, as_written_of: field.id };
  }
  if (had && !had.retired_at) throw httpError(409, `there’s already a field called “${had.name}”`);
  const n = (await tx.query('select count(*)::int as n from person_fields where workspace_id = $1 and retired_at is null', [ws])).rows[0].n;
  if (!field.retired_at && n >= FIELDS_MAX) {
    throw httpError(400, `A campaign can have up to ${FIELDS_MAX} fields — take one off first, so the words that don’t fit have somewhere to go`);
  }
  // Right after the list: the fields below it move down one.
  const shifted = field.retired_at ? 0 : (await tx.query(
    'update person_fields set position = position + 1, updated_at = now() where workspace_id = $1 and retired_at is null and position > $2 returning id',
    [ws, field.position],
  )).rows.length;
  const f = {
    id: newId(), name, kind: 'text', choices: [], volunteers: !!field.volunteers && !field.sensitive, sensitive: !!field.sensitive,
    position: field.position + 1, as_written_of: field.id,
  };
  await tx.query(
    `insert into person_fields (id, workspace_id, name, kind, choices, volunteers, sensitive, position, as_written_of, retired_at, created_by)
     values ($1, $2, $3, 'text', '[]', $4, $5, $6, $7, $8, $9)`,
    [f.id, ws, f.name, f.volunteers, f.sensitive, f.position, f.as_written_of, field.retired_at || null, ctx.user?.id || null],
  );
  emit('person_field', f.id, 'create', { ...f, retired: !!field.retired_at, shifted, ...extra });
  return { ...f, retired_at: field.retired_at || null };
};

// A field's words, grouped as choices compare (choiceKey), the most common
// spelling of each shown, most people first: { people, distinct, top40,
// words: [{ word, n, key }] } — at most `limit` words. One scan.
export const wordsOf = async (db, ws, fieldId, limit = LIST_WORDS_MAX) => {
  const rows = (await db.query(
    `with g as (
       select ${KEY} as k, mode() within group (order by v.value #>> '{}') as word, count(*)::int as n
         from person_field_values v where v.workspace_id = $1 and v.field_id = $2 group by 1
     ), r as (
       select k, word, n, row_number() over (order by n desc, word) as i, count(*) over () as d, sum(n) over () as people from g
     )
     select k, word, n, i::int as i, d::int as d, people::int as people,
            (select coalesce(sum(n), 0) from r where i <= ${LIST_TOP})::int as top40
       from r where i <= $3 order by i`,
    [ws, fieldId, limit],
  )).rows;
  const one = rows[0];
  return {
    people: one?.people || 0, distinct: one?.d || 0, top40: one?.top40 || 0,
    words: rows.map((r) => ({ word: r.word, n: r.n, key: r.k })),
  };
};
export const suits = (w) => suitsList({ words: w.distinct, top40: w.top40, people: w.people });

const loadText = async (tx, ctx, id) => {
  const f = (await tx.query('select * from person_fields where id = $1 and workspace_id = $2 for update', [id, ctx.workspaceId])).rows[0];
  if (!f) throw httpError(404, 'field not found');
  if (f.retired_at || f.kind !== 'text' || f.as_written_of) throw httpError(409, ONLY_TEXT);
  return f;
};

const MANAGERS = ['manager'];
export const convertActions = {
  'field.list.start': {
    roles: MANAGERS,
    input: z.object({
      id: z.uuid(),
      choices: z.array(z.string().trim().min(1).max(CHOICE_MAX)).min(2).max(CHOICES_MAX),
      display: z.enum(['buttons', 'list']).default('list'),
      map: z.array(z.object({ word: z.string().max(TEXT_MAX), to: z.string().max(CHOICE_MAX).nullable() })).max(LIST_WORDS_MAX).default([]),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const f = await loadText(tx, ctx, input.id);
      if (f.converting) throw httpError(409, already(f.name));
      const choices = input.choices.map(cleanName).filter(Boolean);
      if (choices.length < 2) throw httpError(400, 'add at least two choices');
      if (new Set(choices.map(choiceKey)).size !== choices.length) throw httpError(400, 'two choices are the same');
      const byKey = new Map(choices.map((c) => [choiceKey(c), c]));
      const map = Object.create(null);
      for (const { word, to } of input.map) {
        const hit = to === null ? null : byKey.get(choiceKey(to));
        if (to !== null && !hit) throw httpError(400, `“${word}” → “${to}” isn’t one of the choices`);
        map[choiceKey(word)] = hit;
      }
      // A word spelled as a choice goes to it, whatever the map says.
      for (const [k, c] of byKey) map[k] = c;
      const w = await wordsOf(tx, ws, f.id, LIST_TOP);
      if (!suits(w)) throw httpError(409, DOESNT_SUIT);
      const toKeys = Object.entries(map).filter(([, c]) => c).map(([k]) => k);
      const { total, to_choices: toChoices } = (await tx.query(
        `select count(*)::int as total, (count(*) filter (where ${KEY} = any($3::text[])))::int as to_choices
           from person_field_values v where v.workspace_id = $1 and v.field_id = $2`, [ws, f.id, toKeys],
      )).rows[0];
      const kept = total - toChoices;
      const keep = kept ? await makeAsWritten(tx, ctx, f, emit) : null;
      const plan = {
        key: `field-list-${f.id}-${Date.now()}`, choices, display: input.display, map,
        keep_field_id: keep?.id || null, total, done: 0, kept: 0, by: ctx.user?.id || null, started_at: new Date().toISOString(),
      };
      await tx.query('update person_fields set converting = $3, updated_at = now() where id = $1 and workspace_id = $2', [f.id, ws, JSON.stringify(plan)]);
      emit('person_field', f.id, 'update', { converting: true, choices, display: input.display });
      await enqueueJob(tx, { workspaceId: ws, kind: 'field.list.step', key: plan.key, payload: { field_id: f.id, key: plan.key } });
      return { total, to_choices: toChoices, kept, keep_field_id: plan.keep_field_id };
    },
    after: async (db, ctx, result) => { runJobsSoon(); return { result }; },
  },

  'field.list.stop': {
    roles: MANAGERS,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const f = (await tx.query('select * from person_fields where id = $1 and workspace_id = $2 for update', [input.id, ctx.workspaceId])).rows[0];
      if (!f) throw httpError(404, 'field not found');
      const plan = parseJ(f.converting, null);
      if (!plan) return { stopped: false };
      await tx.query('update person_fields set converting = null, updated_at = now() where id = $1 and workspace_id = $2', [f.id, ctx.workspaceId]);
      await cancelJobs(tx, { workspaceId: ctx.workspaceId, kind: 'field.list.step', where: { field_id: f.id } });
      emit('person_field', f.id, 'update', { converting: false, stopped: true, done: plan.done });
      return { stopped: true, done: plan.done };
    },
  },
};

// The field and its plan, locked — or null when the plan isn't this job's
// any more (stopped, or started again since).
const planFor = async (tx, ws, fieldId, key) => {
  const f = (await tx.query('select * from person_fields where id = $1 and workspace_id = $2 for update', [fieldId, ws])).rows[0];
  const plan = parseJ(f?.converting, null);
  return plan && plan.key === key ? { f, plan } : null;
};
const savePlan = (tx, ws, f, plan) => tx.query(
  'update person_fields set converting = $3, updated_at = now() where id = $1 and workspace_id = $2', [f.id, ws, JSON.stringify(plan)],
);

// One chunk → 'stop' | 'empty' | 'more'.
const chunk = async (tx, ws, fieldId, key, emit) => {
  const got = await planFor(tx, ws, fieldId, key);
  if (!got) return 'stop';
  const { f, plan } = got;
  // In the (field_id, person_id) index's order, after the last chunk's
  // place (plan.after): each chunk reads on from there, never past every
  // value already done — nor through every row of one word most people
  // share, which a (value, id) order had to sort for each chunk. A place
  // kept by an older server (value, id) starts again from the top: what is
  // done is a choice now, or moved, so nothing is done twice.
  const after = plan.after?.person_id || null;
  const rows = (await tx.query(
    `select v.id, v.person_id, v.value, ${KEY} as k from person_field_values v
      where v.workspace_id = $1 and v.field_id = $2 and not (v.value in (select jsonb_array_elements($3::jsonb)))
        ${after ? 'and v.person_id > $4::uuid' : ''}
      order by v.person_id limit ${PACE.size} for update skip locked`,
    after ? [ws, f.id, JSON.stringify(plan.choices), after] : [ws, f.id, JSON.stringify(plan.choices)],
  )).rows;
  if (!rows.length) return 'empty';
  plan.after = { person_id: rows.at(-1).person_id };
  const goesTo = (r) => (Object.hasOwn(plan.map, r.k) ? plan.map[r.k] : null);
  const to = rows.filter(goesTo);
  const keep = rows.filter((r) => !goesTo(r));
  if (to.length) {
    await tx.query(
      `update person_field_values v set value = to_jsonb(x.value), updated_at = now()
         from unnest($2::uuid[], $3::text[]) as x(id, value) where v.id = x.id and v.workspace_id = $1`,
      [ws, to.map((r) => r.id), to.map(goesTo)],
    );
    for (const r of to) {
      emit('person_field_value', r.id, 'update', { field_id: f.id, person_id: r.person_id, value: goesTo(r), was: r.value, converted: true });
    }
  }
  if (keep.length) {
    let keepId = plan.keep_field_id;
    if (keepId && !(await tx.query('select 1 from person_fields where id = $1 and workspace_id = $2', [keepId, ws])).rows[0]) keepId = null;
    if (!keepId) {
      // Words that came in after the start (a move undone): somewhere to go.
      try {
        keepId = (await makeAsWritten(tx, { workspaceId: ws, user: { id: plan.by } }, f, emit)).id;
      } catch (e) {
        if (!e.status) throw e;
        await tx.query('update person_fields set converting = null, updated_at = now() where id = $1 and workspace_id = $2', [f.id, ws]);
        emit('person_field', f.id, 'update', { converting: false, stopped: true, done: plan.done, why: e.message });
        return 'stop';
      }
      plan.keep_field_id = keepId;
    }
    const had = new Map((await tx.query(
      'select id, person_id, value from person_field_values where workspace_id = $1 and field_id = $2 and person_id = any($3::uuid[]) for update',
      [ws, keepId, keep.map((r) => r.person_id)],
    )).rows.map((r) => [r.person_id, r]));
    const ids = keep.map(() => newId());
    const saved = new Map((await tx.query(
      `insert into person_field_values (id, workspace_id, field_id, person_id, value, updated_by)
       select x.id, $1, $2, x.person_id, to_jsonb(x.value), $3 from unnest($4::uuid[], $5::uuid[], $6::text[]) as x(id, person_id, value)
       on conflict (field_id, person_id) do update
         set value = to_jsonb(left((person_field_values.value #>> '{}') || '; ' || (excluded.value #>> '{}'), ${TEXT_MAX})), updated_at = now()
       returning id, person_id, value`,
      [ws, keepId, plan.by, ids, keep.map((r) => r.person_id), keep.map((r) => String(r.value ?? ''))],
    )).rows.map((r) => [r.person_id, r]));
    await tx.query('delete from person_field_values where workspace_id = $1 and id = any($2::uuid[])', [ws, keep.map((r) => r.id)]);
    for (const r of keep) {
      emit('person_field_value', r.id, 'void', { field_id: f.id, person_id: r.person_id, was: r.value, moved_to: keepId });
      const s = saved.get(r.person_id);
      const before = had.get(r.person_id);
      if (before) emit('person_field_value', s.id, 'update', { field_id: keepId, person_id: r.person_id, value: s.value, was: before.value, source: 'list' });
      else emit('person_field_value', s.id, 'create', { id: s.id, field_id: keepId, person_id: r.person_id, value: s.value, source: 'list' });
    }
  }
  plan.done += rows.length;
  plan.kept += keep.length;
  await savePlan(tx, ws, f, plan);
  return 'more';
};

// The last step: anything not yet a choice — a value another write held
// a moment ago included (no skip locked: it waits for it) — means once
// more; nothing left, the field is a Pick one.
const finish = async (tx, ws, fieldId, key, emit) => {
  const got = await planFor(tx, ws, fieldId, key);
  if (!got) return 'stop';
  const { f, plan } = got;
  const left = (await tx.query(
    `select v.id from person_field_values v
      where v.workspace_id = $1 and v.field_id = $2 and not (v.value in (select jsonb_array_elements($3::jsonb)))
      order by v.id limit 1 for update`,
    [ws, f.id, JSON.stringify(plan.choices)],
  )).rows[0];
  // Left behind (held by another write, or come in since): from the start again.
  if (left) { plan.after = null; await savePlan(tx, ws, f, plan); return 'more'; }
  await tx.query(
    `update person_fields set kind = 'choice', choices = $3, display = $4, converting = null, updated_at = now()
      where id = $1 and workspace_id = $2`,
    [f.id, ws, JSON.stringify(plan.choices), plan.display],
  );
  emit('person_field', f.id, 'update', { kind: 'choice', was: 'text', choices: plan.choices, display: plan.display, converted: plan.done, kept: plan.kept });
  const marker = Object.entries(LIST_SEEDS).find(([name]) => nameKey(name) === nameKey(f.name) && name !== 'Faith')?.[1];
  if (marker) await tx.query('insert into fields_seeded (workspace_id, name) values ($1, $2) on conflict do nothing', [ws, marker]);
  return 'done';
};

export const stepJob = async (db, job) => {
  const ws = job.workspace_id;
  const { field_id: fieldId, key } = job.payload || {};
  const plan = parseJ((await db.query('select converting from person_fields where id = $1 and workspace_id = $2', [fieldId, ws])).rows[0]?.converting, null);
  if (!plan || plan.key !== key) return {};
  const act = (fn) => runAction(db, { workspaceId: ws, actorId: plan.by || null, action: 'field.list.step' }, fn);
  for (let i = 0; i < CHUNKS_PER_RUN; i += 1) {
    if (PACE.waitMs && i) await new Promise((r) => { setTimeout(r, PACE.waitMs); });
    const { result } = await act((tx, emit) => chunk(tx, ws, fieldId, key, emit));
    if (result === 'stop') return {};
    if (result === 'empty') {
      const { result: end } = await act((tx, emit) => finish(tx, ws, fieldId, key, emit));
      if (end !== 'more') return {};
    }
  }
  // The runner goes round at once, not at its next tick (again: 1 ms —
  // lib/jobs.js reads a 0 as done).
  runJobsSoon();
  return { again: 1 };
};
