// pass.start · pass.end · pass.update — desk roles (a volunteer given Map &
// turfs may run them too: lib/perms.js mayRun). Every change is an event on
// the canvass_pass entity. A pass on a list is the desk's alone.
//
//   pass.start   ends the open pass (if any) and starts the new one in one
//                transaction — the one-open-pass index never trips. Answers
//                { pass, ended } (ended: the id of the pass it closed, or null).
//   pass.end     404 when the id isn't this campaign's; 409 when it's over already.
//   pass.update  name, who, list and tries of an open pass (the same 404 / 409).
// list_id: the pass walks one List (ext/lists) — only doors with someone on
// it, as the list stands each time a walk list loads; who still applies on
// top (All doors unless said). 404 when the list isn't this campaign's.
import { z } from 'zod';
import { KIND_CODES, WHO_CODES, TRIES_MAX } from '@starbase/shared/passes';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { openPass } from './rule.js';
import { loadList } from '../lists/audience.js';

const DESK = ['manager', 'treasurer', 'staff'];
const COLS = 'id, name, kind, who, list_id, tries, started_at, ended_at, created_by, created_at';
// The list a pass is to walk, checked; its name rides on the answer.
// Pointing a pass at a list is the desk's, whatever a volunteer has been
// given: the walk lists would read the list out to them.
const listFor = async (tx, ctx, id) => {
  if (!id) return null;
  if (ctx.role === 'volunteer') throw httpError(403, 'only the desk can point a pass at a list');
  const list = await loadList(tx, ctx.workspaceId, id);
  if (!list) throw httpError(404, 'list not found');
  return list;
};
const name = () => z.string().trim().min(1).max(120);
const who = () => z.enum(WHO_CODES);
const tries = () => z.number().int().min(1).max(TRIES_MAX);

const passRow = async (tx, ws, id) => (await tx.query(
  `select ${COLS} from canvass_passes where id = $1 and workspace_id = $2`, [id, ws],
)).rows[0] || null;

const endPass = async (tx, ws, id, emit) => {
  const r = (await tx.query(
    'update canvass_passes set ended_at = now() where id = $1 and workspace_id = $2 and ended_at is null returning ended_at',
    [id, ws],
  )).rows[0];
  emit('canvass_pass', id, 'update', { ended_at: r?.ended_at ?? new Date() });
};

// The pass to change: this campaign's, and still open.
const openOrThrow = async (tx, ws, id) => {
  const cur = await passRow(tx, ws, id);
  if (!cur) throw httpError(404, 'pass not found');
  if (cur.ended_at) throw httpError(409, 'this pass is already over');
  return cur;
};

export const actions = {
  'pass.start': {
    roles: DESK,
    input: z.object({
      name: name(),
      kind: z.enum(KIND_CODES),
      who: who().default('all'),
      list_id: z.uuid().nullish(),
      tries: tries().default(2),
    }),
    handler: async (tx, ctx, input, emit) => {
      const list = await listFor(tx, ctx, input.list_id);
      const open = await openPass(tx, ctx.workspaceId);
      if (open) await endPass(tx, ctx.workspaceId, open.id, emit);
      const id = newId();
      await tx.query(
        `insert into canvass_passes (id, workspace_id, name, kind, who, tries, created_by, list_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.workspaceId, input.name, input.kind, input.who, input.tries, ctx.user.id, list?.id || null],
      );
      const pass = await passRow(tx, ctx.workspaceId, id);
      emit('canvass_pass', id, 'create', {
        id, name: pass.name, kind: pass.kind, who: pass.who, tries: pass.tries, started_at: pass.started_at,
        ...(list ? { list_id: list.id, list_name: list.name } : {}),
      });
      return { pass: { ...pass, list_name: list?.name || null }, ended: open ? open.id : null };
    },
  },

  'pass.end': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, { id }, emit) => {
      await openOrThrow(tx, ctx.workspaceId, id);
      await endPass(tx, ctx.workspaceId, id, emit);
      return { pass: await passRow(tx, ctx.workspaceId, id) };
    },
  },

  'pass.update': {
    roles: DESK,
    input: z.object({
      id: z.uuid(),
      name: name().optional(),
      who: who().optional(),
      // null: every door again (within who); left out: as it was.
      list_id: z.uuid().nullable().optional(),
      tries: tries().optional(),
    }),
    handler: async (tx, ctx, { id, ...patch }, emit) => {
      const cur = await openOrThrow(tx, ctx.workspaceId, id);
      // A list is checked when it is picked; one left as it was is not looked up again.
      const picked = await listFor(tx, ctx, patch.list_id);
      const listId = patch.list_id === undefined ? cur.list_id : (picked?.id || null);
      const next = { name: patch.name ?? cur.name, who: patch.who ?? cur.who, tries: patch.tries ?? cur.tries };
      await tx.query(
        'update canvass_passes set name = $3, who = $4, tries = $5, list_id = $6 where id = $1 and workspace_id = $2',
        [id, ctx.workspaceId, next.name, next.who, next.tries, listId],
      );
      emit('canvass_pass', id, 'update', patch);
      const list = listId ? (picked || await loadList(tx, ctx.workspaceId, listId)) : null;
      return { pass: { ...(await passRow(tx, ctx.workspaceId, id)), list_name: list?.name || null } };
    },
  },
};
