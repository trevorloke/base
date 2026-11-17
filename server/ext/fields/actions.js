// Profile field actions. Every change is one runAction: table writes + events
// on the hash chain. Managers define fields; the desk fills them in.
//
//   field.create      { name, kind, choices?, volunteers? }          managers
//   field.update      { id, name?, kind?, choices?, volunteers? }    managers
//                     kind: any change while nothing is filled in; once a
//                     value exists it can only become Text (every value is
//                     rewritten as its words — nothing is lost); anything
//                     else is refused, because the values on file would no
//                     longer fit (add a new field instead).
//                     choices: add, reorder, or drop an unused one; a
//                     choice someone has stays (it is refused, never
//                     silently emptied).
//   field.reorder     { ids }   every field on the profile, in the new order
//   field.retire      { id }    "Take off": it stops showing on profiles,
//                               filters and imports; every value stays (and
//                               in the export)
//   field.restore     { id }    "Bring back", at the end of the list
//   field.values.set  { person_id, values: [{ field_id, value }] }   desk
//                     value null or "" clears it. Each value is checked
//                     against its field (kinds.js); one that doesn't fit
//                     refuses the whole save, with the field's name.
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import {
  KINDS, HAS_CHOICES, NAME_MAX, CHOICE_MAX, CHOICES_MAX, FIELDS_MAX,
  choicesOf, choiceKey, cleanName, nameKey, parseJ, parseValue, valueError, showValue, sameValue,
} from './kinds.js';
import { splits } from '@starbase/shared/fieldlists';
import { addStandardFields, convertingRefusal } from './people.js';
import { convertActions } from './convert.js';

const MANAGERS = ['manager'];
const DESK = ['manager', 'treasurer', 'staff'];

const nameIn = () => z.string().trim().min(1).max(NAME_MAX);
const choicesIn = () => z.array(z.string().trim().min(1).max(CHOICE_MAX)).max(CHOICES_MAX);
// A value as sent: words (Long text up to NOTE_MAX, checked by kind), a
// number, yes/no, a list (Pick several), or null to clear.
const valueIn = () => z.union([z.string().max(8000), z.number(), z.boolean(), z.null(), z.array(z.string().max(200)).max(CHOICES_MAX)]);

// sensitive: "Private". display: how a Pick one draws ('buttons' | 'list').
// as_written_of: the list whose leftover words this Text field keeps.
// converting: { done, total } while a Text field is being turned into a
// list (convert.js), else null.
export const fieldOut = (f) => {
  const plan = parseJ(f.converting, null);
  return {
    id: f.id, name: f.name, kind: f.kind, choices: choicesOf(f), volunteers: !!f.volunteers,
    position: f.position, retired: !!f.retired_at,
    sensitive: !!f.sensitive, display: f.display || 'buttons', as_written_of: f.as_written_of || null,
    converting: plan ? { done: Number(plan.done) || 0, total: Number(plan.total) || 0 } : null,
  };
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const LIST_ONLY_PICK_ONE = 'Only a Pick one field can be a scroll-down list';
const PRIVATE_NOT_VOLUNTEERS = 'A private field can’t be shown to volunteers';
const splitWords = (c) => `“${c}” has a comma or slash in it, which Pick several reads as two choices — change its words first`;
// The settings a kind allows: a scroll-down list is a Pick one's; a Private
// field is never the volunteers'; a Pick several choice never splits.
const checkSettings = ({ kind, display, sensitive, volunteers, choices, was = [] }) => {
  if (display === 'list' && kind !== 'choice') throw httpError(400, LIST_ONLY_PICK_ONE);
  if (sensitive && volunteers) throw httpError(400, PRIVATE_NOT_VOLUNTEERS);
  if (kind === 'choices') {
    const bad = choices.find((c) => splits(c) && !was.includes(c));
    if (bad) throw httpError(400, splitWords(bad));
  }
};

const loadField = async (tx, ctx, id) => {
  const f = (await tx.query(
    'select * from person_fields where id = $1 and workspace_id = $2 for update', [id, ctx.workspaceId],
  )).rows[0];
  if (!f) throw httpError(404, 'field not found');
  return f;
};
const liveField = async (tx, ctx, id) => {
  const f = await loadField(tx, ctx, id);
  if (f.retired_at) throw httpError(409, `“${f.name}” is taken off — bring it back first`);
  return f;
};

// Names (stored trimmed, single-spaced) are unique among the fields on the
// profile, in any case.
const checkName = async (tx, ctx, name, exceptId = null) => {
  const taken = (await tx.query(
    `select name from person_fields where workspace_id = $1 and retired_at is null and ($3::uuid is null or id <> $3)
       and lower(name) = $2 limit 1`,
    [ctx.workspaceId, nameKey(name), exceptId],
  )).rows[0];
  if (taken) throw httpError(409, `there’s already a field called “${taken.name}”`);
};

// Pick one and Pick several need two or more different choices; the other kinds none.
const cleanChoices = (kind, list) => {
  if (!HAS_CHOICES.has(kind)) {
    if (list?.length) throw httpError(400, 'only Pick one and Pick several fields have choices');
    return [];
  }
  const out = (list || []).map(cleanName).filter(Boolean);
  if (out.length < 2) throw httpError(400, 'add at least two choices');
  if (new Set(out.map(choiceKey)).size !== out.length) throw httpError(400, 'two choices are the same');
  return out;
};

// Every value on file for a field, people taken off the list included: they
// are still on record, and a change must fit them too.
const valuesOf = async (tx, ctx, fieldId) => (await tx.query(
  'select id, person_id, value from person_field_values where workspace_id = $1 and field_id = $2 order by created_at, id for update',
  [ctx.workspaceId, fieldId],
)).rows.map((r) => ({ ...r, value: r.value ?? null }));


export const actions = {
  'field.create': {
    roles: MANAGERS,
    input: z.object({
      name: nameIn(),
      kind: z.enum(KINDS),
      choices: choicesIn().optional(),
      volunteers: z.boolean().default(false),
      sensitive: z.boolean().default(false),
      display: z.enum(['buttons', 'list']).default('buttons'),
    }),
    handler: async (tx, ctx, input, emit) => {
      const name = cleanName(input.name);
      await checkName(tx, ctx, name);
      const choices = cleanChoices(input.kind, input.choices);
      checkSettings({ ...input, choices });
      const { n, top } = (await tx.query(
        `select count(*)::int as n, coalesce(max(position), -1)::int as top from person_fields
         where workspace_id = $1 and retired_at is null`, [ctx.workspaceId],
      )).rows[0];
      if (n >= FIELDS_MAX) throw httpError(400, `a campaign can have up to ${FIELDS_MAX} fields`);
      const id = newId();
      await tx.query(
        `insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position, created_by, sensitive, display)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, ctx.workspaceId, name, input.kind, JSON.stringify(choices), input.volunteers, top + 1, ctx.user?.id || null, input.sensitive, input.display],
      );
      const field = fieldOut({
        id, name, kind: input.kind, choices, volunteers: input.volunteers, position: top + 1, sensitive: input.sensitive, display: input.display,
      });
      emit('person_field', id, 'create', field);
      return { field };
    },
  },

  'field.update': {
    roles: MANAGERS,
    input: z.object({
      id: z.uuid(),
      name: nameIn().optional(),
      kind: z.enum(KINDS).optional(),
      choices: choicesIn().optional(),
      volunteers: z.boolean().optional(),
      sensitive: z.boolean().optional(),
      display: z.enum(['buttons', 'list']).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await liveField(tx, ctx, input.id);
      if (cur.converting) throw httpError(409, convertingRefusal(cur.name));
      const name = input.name !== undefined ? cleanName(input.name) : cur.name;
      if (nameKey(name) !== nameKey(cur.name)) await checkName(tx, ctx, name, cur.id);
      const kind = input.kind ?? cur.kind;
      const was = choicesOf(cur);
      const values = await valuesOf(tx, ctx, cur.id);

      // A new kind: free while nothing is filled in; with values, only Text or
      // Long text (Text ↔ Long text both ways), or Pick one → Pick several.
      const canTurn = kind === 'text' || kind === 'note' || (cur.kind === 'choice' && kind === 'choices');
      if (kind !== cur.kind && values.length && !canTurn) {
        const people = new Set(values.map((v) => v.person_id)).size;
        throw httpError(409, `“${cur.name}” is filled in for ${plural(people, 'person', 'people')} — it can only become Text or Long text now. Add a new field instead.`);
      }
      const choices = cleanChoices(kind, HAS_CHOICES.has(kind) ? input.choices ?? (HAS_CHOICES.has(cur.kind) ? was : []) : input.choices);
      // Pick one → Pick several: no choice may read as two.
      if (cur.kind === 'choice' && kind === 'choices') {
        const bad = choices.find(splits);
        if (bad) throw httpError(409, splitWords(bad));
      }
      const volunteers = input.volunteers ?? !!cur.volunteers;
      const sensitive = input.sensitive ?? !!cur.sensitive;
      if (input.display === 'list' && kind !== 'choice') throw httpError(400, LIST_ONLY_PICK_ONE);
      const display = kind === 'choice' ? (input.display ?? (cur.kind === 'choice' ? cur.display || 'buttons' : 'buttons')) : 'buttons';
      checkSettings({ kind, display, sensitive, volunteers, choices, was: cur.kind === 'choices' ? was : choices });
      // A choice someone has stays on the list.
      if (HAS_CHOICES.has(kind) && HAS_CHOICES.has(cur.kind)) {
        const used = new Map();
        for (const v of values) for (const one of Array.isArray(v.value) ? v.value : [v.value]) used.set(one, (used.get(one) || 0) + 1);
        for (const [label, n] of used) {
          if (!choices.includes(label)) {
            throw httpError(409, `“${label}” is filled in for ${plural(n, 'person', 'people')} — it stays`);
          }
        }
      }

      // To Text or Long text: each value becomes its words (Yes / No, 2.5) —
      // kept, readable, filterable. Pick one → Pick several: a list of one.
      let converted = 0;
      if (kind !== cur.kind && (kind === 'text' || kind === 'note' || kind === 'choices')) {
        for (const v of values) {
          const words = kind === 'choices' ? (Array.isArray(v.value) ? v.value : [v.value])
            : kind === 'text' ? showValue(cur.kind, v.value).replace(/\s+/g, ' ') : showValue(cur.kind, v.value);
          if (sameValue(words, v.value)) continue;
          await tx.query(
            'update person_field_values set value = $3, updated_at = now() where id = $1 and workspace_id = $2',
            [v.id, ctx.workspaceId, JSON.stringify(words)],
          );
          emit('person_field_value', v.id, 'update', { field_id: cur.id, person_id: v.person_id, value: words, was: v.value, converted: true });
          converted += 1;
        }
      }
      await tx.query(
        `update person_fields set name = $3, kind = $4, choices = $5, volunteers = $6, sensitive = $7, display = $8, updated_at = now()
         where id = $1 and workspace_id = $2`,
        [cur.id, ctx.workspaceId, name, kind, JSON.stringify(choices), volunteers, sensitive, display],
      );
      const patch = { ...input };
      delete patch.id;
      if (kind !== cur.kind) Object.assign(patch, { was: cur.kind, converted });
      if (!HAS_CHOICES.has(kind) && HAS_CHOICES.has(cur.kind)) patch.choices = [];
      if (display !== (cur.display || 'buttons')) patch.display = display;
      emit('person_field', cur.id, 'update', patch);
      // Its "as written" words are as private as it is.
      if (sensitive !== !!cur.sensitive) {
        for (const r of (await tx.query(
          `update person_fields set sensitive = $3, volunteers = volunteers and not $3, updated_at = now()
            where workspace_id = $1 and as_written_of = $2 returning id`, [ctx.workspaceId, cur.id, sensitive],
        )).rows) emit('person_field', r.id, 'update', { sensitive, ...(sensitive ? { volunteers: false } : {}), as_written_of: cur.id });
      }
      return { field: fieldOut({ ...cur, name, kind, choices, volunteers, sensitive, display }), converted };
    },
  },

  'field.reorder': {
    roles: MANAGERS,
    input: z.object({ ids: z.array(z.uuid()).min(1).max(FIELDS_MAX) }),
    handler: async (tx, ctx, input, emit) => {
      const cur = (await tx.query(
        'select id from person_fields where workspace_id = $1 and retired_at is null for update', [ctx.workspaceId],
      )).rows.map((r) => r.id);
      const same = cur.length === input.ids.length && new Set(input.ids).size === input.ids.length
        && input.ids.every((id) => cur.includes(id));
      if (!same) throw httpError(409, 'the fields changed — reload and try again');
      for (const [i, id] of input.ids.entries()) {
        await tx.query('update person_fields set position = $3, updated_at = now() where id = $1 and workspace_id = $2',
          [id, ctx.workspaceId, i]);
      }
      emit('workspace', ctx.workspaceId, 'update', { person_fields_order: input.ids });
      return { order: input.ids };
    },
  },

  // Take off: off every profile, filter and import; every value kept.
  'field.retire': {
    roles: MANAGERS,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const f = await liveField(tx, ctx, input.id);
      await tx.query('update person_fields set retired_at = now(), updated_at = now() where id = $1 and workspace_id = $2',
        [f.id, ctx.workspaceId]);
      const kept = (await tx.query(
        'select count(*)::int as n from person_field_values where workspace_id = $1 and field_id = $2', [ctx.workspaceId, f.id],
      )).rows[0].n;
      emit('person_field', f.id, 'update', { retired: true, name: f.name, values_kept: kept });
      return { field: { ...fieldOut(f), retired: true }, kept };
    },
  },

  'field.restore': {
    roles: MANAGERS,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const f = await loadField(tx, ctx, input.id);
      if (!f.retired_at) return { field: fieldOut(f) };
      await checkName(tx, ctx, f.name, f.id);
      const { n, top } = (await tx.query(
        `select count(*)::int as n, coalesce(max(position), -1)::int as top from person_fields
         where workspace_id = $1 and retired_at is null`, [ctx.workspaceId],
      )).rows[0];
      if (n >= FIELDS_MAX) throw httpError(400, `a campaign can have up to ${FIELDS_MAX} fields`);
      await tx.query(
        'update person_fields set retired_at = null, position = $3, updated_at = now() where id = $1 and workspace_id = $2',
        [f.id, ctx.workspaceId, top + 1],
      );
      emit('person_field', f.id, 'update', { retired: false });
      return { field: fieldOut({ ...f, retired_at: null, position: top + 1 }) };
    },
  },

  // Imagine Surrey's standard fields (people.js), for a campaign set up
  // before they existed. Already there: nothing changes.
  'field.standard': {
    roles: MANAGERS,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => ({ added: await addStandardFields(tx, ctx, emit) }),
  },
  ...convertActions,

  'field.values.set': {
    roles: DESK,
    input: z.object({
      person_id: z.uuid(),
      values: z.array(z.object({ field_id: z.uuid(), value: valueIn() })).min(1).max(FIELDS_MAX),
    }),
    handler: async (tx, ctx, input, emit) => {
      const person = (await tx.query(
        'select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [input.person_id, ctx.workspaceId],
      )).rows[0];
      if (!person) throw httpError(404, 'person not found');
      const ids = input.values.map((v) => v.field_id);
      if (new Set(ids).size !== ids.length) throw httpError(400, 'one value per field');
      const fields = new Map((await tx.query(
        `select * from person_fields where workspace_id = $1 and id in (select (jsonb_array_elements_text($2::jsonb))::uuid)`,
        [ctx.workspaceId, JSON.stringify(ids)],
      )).rows.map((f) => [f.id, f]));
      // Check everything first: one value that doesn't fit saves nothing.
      const checked = input.values.map(({ field_id: fid, value }) => {
        const f = fields.get(fid);
        if (!f) throw httpError(400, 'that field is not in this campaign');
        if (f.retired_at) throw httpError(409, `“${f.name}” is taken off`);
        // A Private field is the office's to record, whatever areas a
        // volunteer has been granted.
        if (f.sensitive && !DESK.includes(ctx.role)) throw httpError(403, `Only the office records ${f.name}`);
        if (f.converting) throw httpError(409, convertingRefusal(f.name));
        const p = parseValue(f, value);
        if (p.error) throw httpError(400, valueError(f, p.error));
        return { f, value: p.empty ? null : p.value };
      });
      const prior = new Map((await tx.query(
        `select id, field_id, value from person_field_values
         where workspace_id = $1 and person_id = $2 and field_id in (select (jsonb_array_elements_text($3::jsonb))::uuid)
         for update`,
        [ctx.workspaceId, person.id, JSON.stringify(ids)],
      )).rows.map((r) => [r.field_id, { ...r, value: r.value ?? null }]));
      let changed = 0;
      const out = [];
      for (const { f, value } of checked) {
        const was = prior.get(f.id);
        out.push({ field_id: f.id, value });
        if (sameValue(was?.value ?? null, value)) continue;
        changed += 1;
        if (value === null) {
          await tx.query('delete from person_field_values where id = $1 and workspace_id = $2', [was.id, ctx.workspaceId]);
          emit('person_field_value', was.id, 'void', { field_id: f.id, person_id: person.id, was: was.value });
        } else if (was) {
          await tx.query(
            `update person_field_values set value = $3, sample = false, updated_by = $4, updated_at = now()
             where id = $1 and workspace_id = $2`,
            [was.id, ctx.workspaceId, JSON.stringify(value), ctx.user?.id || null],
          );
          emit('person_field_value', was.id, 'update', { field_id: f.id, person_id: person.id, value, was: was.value });
        } else {
          const id = newId();
          await tx.query(
            `insert into person_field_values (id, workspace_id, field_id, person_id, value, updated_by)
             values ($1, $2, $3, $4, $5, $6)`,
            [id, ctx.workspaceId, f.id, person.id, JSON.stringify(value), ctx.user?.id || null],
          );
          emit('person_field_value', id, 'create', { id, field_id: f.id, person_id: person.id, value });
        }
      }
      return { person_id: person.id, values: out, changed };
    },
  },
};
