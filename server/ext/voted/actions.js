// vote.mark      { person_id, voted?, source?, client_id? }   anyone: this person has voted (or, voted:false, has not after all)
// vote.settings  { on, election_day? }                        managers: Election day on or off, and the date
//
// vote.mark is append-only like a knock: a mark is a new row in voted_marks
// and persons.voted_at follows it (now() for voted, null for a take-back).
// A volunteer may mark anyone they can already read — the walk list, the
// door card and Calls hand them the person, as contact.log does. There is
// no Election-day gate on the server: a mark saved on a phone with no
// signal before the office flipped the switch must still land; the screens
// decide when to offer the button. client_id (the outbox's own id) dedupes
// a replay: the same id answers { duplicate: true } and writes nothing.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const MANAGER_ONLY = ['manager'];
const uuid = () => z.uuid();
const iso = (d) => (d ? new Date(d).toISOString() : null);

export const actions = {
  'vote.mark': {
    roles: ALL_ROLES,
    input: z.object({
      person_id: uuid(),
      voted: z.boolean().default(true),
      source: z.enum(['door', 'phone', 'desk']).default('door'),
      client_id: uuid().nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const person = (await tx.query(
        'select id from persons where id = $1 and workspace_id = $2 and deleted_at is null',
        [input.person_id, ws],
      )).rows[0];
      if (!person) throw httpError(404, 'person not found');
      if (input.client_id) {
        const dup = (await tx.query(
          'select person_id, voted from voted_marks where workspace_id = $1 and client_id = $2',
          [ws, input.client_id],
        )).rows[0];
        if (dup) return { person_id: dup.person_id, voted: Boolean(dup.voted), duplicate: true };
      }
      const id = newId();
      await tx.query(
        `insert into voted_marks (id, workspace_id, person_id, voted, source, marked_by, client_id)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ws, input.person_id, input.voted, input.source, ctx.user.id, input.client_id || null],
      );
      const row = (await tx.query(
        `update persons set voted_at = case when $3 then now() else null end, updated_at = now()
         where id = $1 and workspace_id = $2 returning voted_at`,
        [input.person_id, ws, input.voted],
      )).rows[0];
      const voted_at = iso(row?.voted_at);
      emit('voted_mark', id, 'create', { id, person_id: input.person_id, voted: input.voted, source: input.source, client_id: input.client_id || null });
      emit('person', input.person_id, 'update', { voted_at, source: input.source });
      return { person_id: input.person_id, voted: input.voted, voted_at };
    },
  },

  'vote.settings': {
    roles: MANAGER_ONLY,
    input: z.object({
      on: z.boolean(),
      // Left out: the date stays as it is; null clears it.
      election_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-17').nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const keepDay = input.election_day === undefined;
      const row = (await tx.query(
        `insert into voted_settings (workspace_id, on_day, election_day, updated_at) values ($1, $2, $3, now())
         on conflict (workspace_id) do update
           set on_day = excluded.on_day,
               election_day = case when $4 then voted_settings.election_day else excluded.election_day end,
               updated_at = now()
         returning on_day, election_day`,
        [ws, input.on, input.election_day || null, keepDay],
      )).rows[0];
      const election_day = row.election_day
        ? (row.election_day instanceof Date ? row.election_day.toISOString().slice(0, 10) : String(row.election_day).slice(0, 10))
        : null;
      emit('workspace', ws, 'update', { election_day_mode: input.on, election_day });
      return { on: Boolean(row.on_day), election_day };
    },
  },
};
