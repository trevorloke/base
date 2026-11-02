// request.* actions. Same contract as every action: zod input, a
// transactional handler, events on the chain.
//
//   request.ask     every role — a canvasser at the door (or a caller on
//                   Calls) puts someone in front of the office. Anyone may
//                   ask about anyone they can read (the directory, the walk
//                   list and Calls hand a volunteer every person — the same
//                   rule as contact.log). Keyed by the phone's client_id: a
//                   replay from the outbox is the same request, once.
//   request.done    desk — dealt with, with an optional note of what was done
//   request.reopen  desk — back on the open list (one that is open stays so)
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';

// The kinds' words live in index.js (KIND_WORDS) and the web's RequestAsk.jsx.
const KINDS = ['call_back', 'volunteer', 'question', 'other'];
const ALL = ['manager', 'treasurer', 'staff', 'volunteer'];
const DESK = ['manager', 'treasurer', 'staff'];
const note = () => z.string().trim().max(500).nullish();

const COLS = 'id, person_id, kind, note, asked_by, created_at, done_at, done_by, done_note, client_id';

const loadRequest = async (tx, ws, id) => {
  const r = (await tx.query(
    `select ${COLS} from door_requests where id = $1 and workspace_id = $2 for update`, [id, ws],
  )).rows[0];
  if (!r) throw httpError(404, 'request not found');
  return r;
};

export const actions = {
  'request.ask': {
    roles: ALL,
    input: z.object({
      person_id: z.uuid(),
      kind: z.enum(KINDS),
      note: note(),
      client_id: z.uuid().nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const p = (await tx.query(
        'select id from persons where id = $1 and workspace_id = $2 and deleted_at is null',
        [input.person_id, ctx.workspaceId],
      )).rows[0];
      if (!p) throw httpError(404, 'person not found');
      if (input.client_id) {
        const dup = (await tx.query(
          `select ${COLS} from door_requests where workspace_id = $1 and client_id = $2`,
          [ctx.workspaceId, input.client_id],
        )).rows[0];
        if (dup) return { request: dup, duplicate: true };
      }
      const id = newId();
      const text = input.note || null;
      const request = (await tx.query(
        `insert into door_requests (id, workspace_id, person_id, kind, note, asked_by, client_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning ${COLS}`,
        [id, ctx.workspaceId, input.person_id, input.kind, text, ctx.user.id, input.client_id || null],
      )).rows[0];
      emit('door_request', id, 'create', {
        id, person_id: input.person_id, kind: input.kind, note: text, client_id: input.client_id || null,
      });
      return { request };
    },
  },

  'request.done': {
    roles: DESK,
    input: z.object({ id: z.uuid(), note: note() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadRequest(tx, ctx.workspaceId, input.id);
      if (cur.done_at) throw httpError(409, 'already done');
      const request = (await tx.query(
        `update door_requests set done_at = now(), done_by = $3, done_note = $4
         where id = $1 and workspace_id = $2 returning ${COLS}`,
        [input.id, ctx.workspaceId, ctx.user.id, input.note || null],
      )).rows[0];
      emit('door_request', input.id, 'update', { done_at: request.done_at, done_note: request.done_note });
      return { request };
    },
  },

  'request.reopen': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadRequest(tx, ctx.workspaceId, input.id);
      // Open already (a second tap): nothing to change, nothing on the log.
      if (!cur.done_at) return { request: cur };
      const request = (await tx.query(
        `update door_requests set done_at = null, done_by = null, done_note = null
         where id = $1 and workspace_id = $2 returning ${COLS}`,
        [input.id, ctx.workspaceId],
      )).rows[0];
      emit('door_request', input.id, 'update', { reopened: true });
      return { request };
    },
  },
};
