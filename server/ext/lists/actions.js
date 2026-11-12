// list.create    { name, kind: 'filter' | 'people', filter?, person_ids?, note? }
// list.snapshot  { name, filter? | list_id?, note? }   a hand-picked list of exactly the people a
//                                                      filter (or another list) names right now
// list.update    { id, name?, filter?, note? }
// list.delete    { id }
// list.add       { id, person_ids: [] }     a hand-picked list
// list.remove    { id, person_ids: [] }
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { DESK_RULES, cleanFilter, joinWhere } from '../../lib/audience.js';
import { decide } from '../../lib/perms.js';
import { loadList, whereFor } from './audience.js';

const DESK = ['manager', 'treasurer', 'staff'];
const filterInput = () => z.record(z.string().max(40), z.string().max(400)).optional();
const ids = () => z.array(z.uuid()).min(1).max(5000);

// The list to change. A volunteer given the People area changes only a
// list of their own (by_volunteer): the desk's may be under a sweep or a
// phone bank handed to them, and re-pointing it would read it out to them.
const loadMine = async (tx, ctx, id) => {
  const row = (await tx.query('select * from lists where id = $1 and workspace_id = $2 and deleted_at is null for update', [id, ctx.workspaceId])).rows[0];
  if (!row) throw httpError(404, 'list not found');
  if (ctx.role === 'volunteer' && !(row.by_volunteer && row.created_by === ctx.user.id)) throw httpError(403, 'only the desk can change this list');
  return row;
};
// Only people in this campaign go on a list.
const ownPeople = async (tx, ws, list) => (await tx.query(
  'select id from persons where workspace_id = $1 and deleted_at is null and id = any($2::uuid[])', [ws, list],
)).rows.map((r) => r.id);
// A volunteer given the People area may make lists — never one that sorts
// people by what only the desk may know (gifts, memberships, answers,
// shifts, the desk's own lists), whoever reads it later. Their other rules
// are read with a volunteer's eyes (by_volunteer — audience.js whereFor).
const deskRulesOnly = (ctx, filter) => {
  if (ctx.role === 'volunteer' && DESK_RULES.some((k) => filter?.[k])) {
    throw httpError(403, 'only the desk can make a list by gifts, memberships, answers, shifts, another list or people they know');
  }
  if (filter?.gave && ctx.perms && decide(ctx.perms, 'money') === false) {
    throw httpError(403, 'only someone with Donations can make a list by gifts');
  }
};
// Who is on a hand-picked list changed: its numbers are counted again (audience.js listCounts).
const touch = (tx, ws, id) => tx.query('update lists set updated_at = now() where id = $1 and workspace_id = $2', [id, ws]);

export const actions = {
  'list.create': {
    roles: DESK,
    input: z.object({
      name: z.string().trim().min(1).max(120),
      kind: z.enum(['filter', 'people']),
      filter: filterInput(),
      person_ids: z.array(z.uuid()).max(5000).optional(),
      note: z.string().max(2000).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const id = newId();
      const filter = input.kind === 'filter' ? cleanFilter(input.filter || {}) : {};
      deskRulesOnly(ctx, filter);
      await tx.query(
        'insert into lists (id, workspace_id, name, kind, filter, note, created_by, by_volunteer) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, ws, input.name, input.kind, JSON.stringify(filter), input.note || null, ctx.user.id, ctx.role === 'volunteer'],
      );
      let added = 0;
      if (input.kind === 'people' && input.person_ids?.length) {
        for (const pid of await ownPeople(tx, ws, input.person_ids)) {
          await tx.query('insert into list_members (list_id, workspace_id, person_id) values ($1, $2, $3) on conflict do nothing', [id, ws, pid]);
          added += 1;
        }
      }
      emit('list', id, 'create', { name: input.name, kind: input.kind, filter, added });
      return { list: { id, name: input.name, kind: input.kind, filter, note: input.note || null }, added };
    },
  },

  // "Save these people as they are now": everyone a filter (or a list)
  // names at this moment, put on a new hand-picked list in one statement —
  // the whole voter file if that is what it names. Who they are stays
  // fixed from here on, whatever changes about them.
  'list.snapshot': {
    roles: DESK,
    input: z.object({
      name: z.string().trim().min(1).max(120),
      filter: filterInput(),
      list_id: z.uuid().optional(),
      note: z.string().max(2000).nullish(),
    }).refine((v) => !(v.list_id && v.filter), 'a filter or a list, not both'),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      // A copy of a list is a read of it: lists are the desk's to read.
      if (input.list_id && ctx.role === 'volunteer') throw httpError(403, 'only the desk can copy a list');
      const from = input.list_id ? await loadList(tx, ws, input.list_id) : null;
      if (input.list_id && !from) throw httpError(404, 'list not found');
      const filter = from ? null : cleanFilter(input.filter || {});
      deskRulesOnly(ctx, filter);
      const id = newId();
      await tx.query(
        `insert into lists (id, workspace_id, name, kind, filter, note, created_by, by_volunteer) values ($1, $2, $3, 'people', '{}', $4, $5, $6)`,
        [id, ws, input.name, input.note || null, ctx.user.id, ctx.role === 'volunteer'],
      );
      const params = [id];
      const where = joinWhere(params, await whereFor(tx, ctx, { list: from, filter }));
      const r = await tx.query(
        `insert into list_members (list_id, workspace_id, person_id)
         select $1::uuid, p.workspace_id, p.id from persons p where ${where}`, params,
      );
      const added = r.affectedRows ?? r.rowCount ?? 0;
      const asOf = from ? { list_id: from.id, list_name: from.name } : { filter };
      emit('list', id, 'create', { name: input.name, kind: 'people', filter: {}, added, as_of: asOf });
      return { list: { id, name: input.name, kind: 'people', filter: {}, note: input.note || null }, added };
    },
  },

  'list.update': {
    roles: DESK,
    input: z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120).optional(), filter: filterInput(), note: z.string().max(2000).nullish() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadMine(tx, ctx, input.id);
      const filter = input.filter !== undefined && cur.kind === 'filter' ? cleanFilter(input.filter) : (typeof cur.filter === 'string' ? JSON.parse(cur.filter) : cur.filter);
      if (input.filter !== undefined) deskRulesOnly(ctx, filter);
      // Whoever saves the rule, it is read with their eyes from here on.
      const byVolunteer = input.filter !== undefined && cur.kind === 'filter' ? ctx.role === 'volunteer' : cur.by_volunteer;
      await tx.query(
        'update lists set name = $3, filter = $4, note = $5, by_volunteer = $6, updated_at = now() where id = $1 and workspace_id = $2',
        [cur.id, ctx.workspaceId, input.name ?? cur.name, JSON.stringify(filter), input.note === undefined ? cur.note : input.note, byVolunteer],
      );
      const out = { id: cur.id, name: input.name ?? cur.name, kind: cur.kind, filter, note: input.note === undefined ? cur.note : input.note };
      emit('list', cur.id, 'update', out);
      return { list: out };
    },
  },

  'list.delete': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadMine(tx, ctx, input.id);
      // The open pass's walk lists are this list's people (ext/passes): gone, they would all be empty.
      const walking = (await tx.query(
        'select name from canvass_passes where workspace_id = $1 and ended_at is null and list_id = $2', [ctx.workspaceId, cur.id],
      )).rows[0];
      if (walking) throw httpError(409, `The pass “${walking.name}” walks this list — end the pass first`);
      // An open phone bank made from it leaves out whoever has left the list
      // (ext/banks): gone, they would all be back on the callers' lists.
      const calling = (await tx.query(
        'select name from call_banks where workspace_id = $1 and deleted_at is null and closed_at is null and list_id = $2 order by created_at limit 1',
        [ctx.workspaceId, cur.id],
      )).rows[0];
      if (calling) throw httpError(409, `The phone bank “${calling.name}” calls this list — close it first`);
      await tx.query('update lists set deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2', [cur.id, ctx.workspaceId]);
      emit('list', cur.id, 'void', {});
      return { id: cur.id };
    },
  },

  'list.add': {
    roles: DESK,
    input: z.object({ id: z.uuid(), person_ids: ids() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadMine(tx, ctx, input.id);
      if (cur.kind !== 'people') throw httpError(400, 'a saved filter names its own people — change the filter instead');
      let added = 0;
      for (const pid of await ownPeople(tx, ctx.workspaceId, input.person_ids)) {
        const r = await tx.query('insert into list_members (list_id, workspace_id, person_id) values ($1, $2, $3) on conflict do nothing', [cur.id, ctx.workspaceId, pid]);
        added += r.affectedRows || 0;
      }
      if (added) {
        await touch(tx, ctx.workspaceId, cur.id);
        emit('list', cur.id, 'update', { added, person_ids: input.person_ids.slice(0, 50) });
      }
      return { added };
    },
  },

  'list.remove': {
    roles: DESK,
    input: z.object({ id: z.uuid(), person_ids: ids() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadMine(tx, ctx, input.id);
      if (cur.kind !== 'people') throw httpError(400, 'a saved filter names its own people — change the filter instead');
      const r = await tx.query('delete from list_members where list_id = $1 and workspace_id = $2 and person_id = any($3::uuid[])', [cur.id, ctx.workspaceId, input.person_ids]);
      const removed = r.affectedRows || 0;
      if (removed) {
        await touch(tx, ctx.workspaceId, cur.id);
        emit('list', cur.id, 'update', { removed, person_ids: input.person_ids.slice(0, 50) });
      }
      return { removed };
    },
  },
};
