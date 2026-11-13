// vote.mark      { person_id, voted?, source?, client_id? }   anyone: this person has voted (or, voted:false, has not after all)
// vote.settings  { on, election_day?, advance_days?, auto? }  managers: GOTV mode on by hand, election day,
//                                                             the advance-voting days, and whether it turns itself on for them
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
import { forgetCounts } from './brief.js';

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
      // When it was tapped (a phone's outbox sends it): a mark that waited
      // with no signal keeps its own time and day.
      client_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).max(40).nullish(),
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
      // The mark's time: its tap, never later than now.
      const tapped = input.client_at ? Date.parse(input.client_at) : NaN;
      const at = new Date(Number.isNaN(tapped) ? Date.now() : Math.min(tapped, Date.now())).toISOString();
      // A mark tapped before the person's latest one (it waited on a phone
      // while someone else changed it) goes in the history but changes
      // nothing: the latest tap wins, not the latest to arrive.
      const latest = (await tx.query(
        'select max(created_at) as at from voted_marks where workspace_id = $1 and person_id = $2', [ws, input.person_id],
      )).rows[0]?.at;
      const stale = latest && new Date(latest) > new Date(at);
      const id = newId();
      await tx.query(
        `insert into voted_marks (id, workspace_id, person_id, voted, source, marked_by, client_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ws, input.person_id, input.voted, input.source, ctx.user.id, input.client_id || null, at],
      );
      // Marked again: they voted when first marked, not now.
      const row = stale
        ? (await tx.query('select voted_at from persons where id = $1 and workspace_id = $2', [input.person_id, ws])).rows[0]
        : (await tx.query(
          `update persons set voted_at = case when $3 then coalesce(voted_at, $4::timestamptz) else null end, updated_at = now()
           where id = $1 and workspace_id = $2 returning voted_at`,
          [input.person_id, ws, input.voted, at],
        )).rows[0];
      const voted_at = iso(row?.voted_at);
      emit('voted_mark', id, 'create', { id, person_id: input.person_id, voted: input.voted, source: input.source, client_id: input.client_id || null });
      emit('person', input.person_id, 'update', { voted_at, source: input.source });
      return { person_id: input.person_id, voted: input.voted, voted_at };
    },
    // Committed: the volunteers' kept GOTV numbers count again (brief.js).
    after: async (db, ctx, result) => { forgetCounts(ctx.workspaceId); return { result }; },
  },

  'vote.settings': {
    roles: MANAGER_ONLY,
    input: z.object({
      on: z.boolean(),
      // Left out: the date stays as it is; null clears it.
      election_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-17').nullish(),
      // GOTV mode: the advance-voting days, and whether the mode turns
      // itself on for them and election day. Left out: as they are.
      advance_days: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-08')).max(30).optional(),
      auto: z.boolean().optional(),
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
      const extra = {};
      if (input.advance_days !== undefined) extra.advance_days = [...new Set(input.advance_days)].sort();
      if (input.auto !== undefined) extra.auto = input.auto;
      if ('advance_days' in extra) await tx.query('update voted_settings set advance_days = $2 where workspace_id = $1', [ws, JSON.stringify(extra.advance_days)]);
      if ('auto' in extra) await tx.query('update voted_settings set auto = $2 where workspace_id = $1', [ws, extra.auto]);
      emit('workspace', ws, 'update', { election_day_mode: input.on, election_day, ...extra });
      return { on: Boolean(row.on_day), election_day, ...extra };
    },
  },
};
