// pass.start · pass.end · pass.update — desk roles (a volunteer given Map &
// turfs may run them too: lib/perms.js mayRun). Every change is an event on
// the canvass_pass entity.
//
//   pass.start   ends the open pass (if any) and starts the new one in one
//                transaction — the one-open-pass index never trips. Answers
//                { pass, ended } (ended: the id of the pass it closed, or null).
//   pass.end     404 when the id isn't this campaign's; 409 when it's over already.
//   pass.update  name, who and tries of an open pass (the same 404 / 409).
import { z } from 'zod';
import { KIND_CODES, WHO_CODES, TRIES_MAX } from '@starbase/shared/passes';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { openPass } from './rule.js';

const DESK = ['manager', 'treasurer', 'staff'];
const COLS = 'id, name, kind, who, tries, started_at, ended_at, created_by, created_at';
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
      tries: tries().default(2),
    }),
    handler: async (tx, ctx, input, emit) => {
      const open = await openPass(tx, ctx.workspaceId);
      if (open) await endPass(tx, ctx.workspaceId, open.id, emit);
      const id = newId();
      await tx.query(
        `insert into canvass_passes (id, workspace_id, name, kind, who, tries, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.workspaceId, input.name, input.kind, input.who, input.tries, ctx.user.id],
      );
      const pass = await passRow(tx, ctx.workspaceId, id);
      emit('canvass_pass', id, 'create', {
        id, name: pass.name, kind: pass.kind, who: pass.who, tries: pass.tries, started_at: pass.started_at,
      });
      return { pass, ended: open ? open.id : null };
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
      tries: tries().optional(),
    }),
    handler: async (tx, ctx, { id, ...patch }, emit) => {
      const cur = await openOrThrow(tx, ctx.workspaceId, id);
      const next = { name: patch.name ?? cur.name, who: patch.who ?? cur.who, tries: patch.tries ?? cur.tries };
      await tx.query(
        'update canvass_passes set name = $3, who = $4, tries = $5 where id = $1 and workspace_id = $2',
        [id, ctx.workspaceId, next.name, next.who, next.tries],
      );
      emit('canvass_pass', id, 'update', patch);
      return { pass: await passRow(tx, ctx.workspaceId, id) };
    },
  },
};
