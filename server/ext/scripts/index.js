// Scripts — what to say. One for the door, one for the phone, written at the
// desk (/scripts) and shown on the walk list's door, the map's door card and
// the Calls card, filled in with {{first_name}}, {{my_name}} and
// {{campaign}} on the phone.
//
//   GET  /api/scripts      any role → { door: { body, updated_at } | null,
//                          phone, gotv_door, gotv_phone: … } (kept on the
//                          phone: it shows with no signal). While GOTV mode
//                          is on, a GOTV script is said instead of its twin.
//   script.save            desk roles (the outreach area): { context, body };
//                          an empty body takes that script away
// Each save is on the event log, so what a script said on a day is known.
import { Hono } from 'hono';
import { z } from 'zod';
import { newId } from '../../lib/events.js';

export const sql = `
create table if not exists door_scripts (
  id uuid not null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  context text not null check (context in ('door', 'phone', 'gotv_door', 'gotv_phone')),
  body text not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, context)
);
-- GOTV scripts (what to say while GOTV mode is on): a check made before
-- them is swapped once, as litdrop widens contacts.outcome.
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'door_scripts'::regclass and conname = 'door_scripts_context_check'
             and pg_get_constraintdef(oid) not like '%gotv_door%') then
    alter table door_scripts drop constraint door_scripts_context_check;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'door_scripts'::regclass and conname = 'door_scripts_context_check') then
    alter table door_scripts add constraint door_scripts_context_check check (context in ('door', 'phone', 'gotv_door', 'gotv_phone'));
  end if;
end $$;
`;

const DESK = ['manager', 'treasurer', 'staff'];
// door / phone, and their GOTV twins: said instead while GOTV mode is on.
const CONTEXTS = ['door', 'phone', 'gotv_door', 'gotv_phone'];

export const actions = {
  'script.save': {
    roles: DESK,
    input: z.object({ context: z.enum(CONTEXTS), body: z.string().max(4000) }),
    handler: async (tx, ctx, input, emit) => {
      const body = input.body.replace(/\r\n/g, '\n').trim();
      const cur = (await tx.query('select id from door_scripts where workspace_id = $1 and context = $2', [ctx.workspaceId, input.context])).rows[0];
      if (!body) {
        if (cur) {
          await tx.query('delete from door_scripts where workspace_id = $1 and context = $2', [ctx.workspaceId, input.context]);
          emit('door_script', cur.id, 'void', { context: input.context });
        }
        return { context: input.context, script: null };
      }
      const id = cur?.id || newId();
      const row = (await tx.query(
        `insert into door_scripts (id, workspace_id, context, body, updated_by) values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, context) do update set body = excluded.body, updated_by = excluded.updated_by, updated_at = now()
         returning body, updated_at`,
        [id, ctx.workspaceId, input.context, body, ctx.user.id],
      )).rows[0];
      emit('door_script', id, cur ? 'update' : 'create', { context: input.context, body });
      return { context: input.context, script: row };
    },
  },
};

export const api = new Hono();
api.get('/scripts', async (c) => {
  const rows = (await c.get('db').query(
    'select context, body, updated_at from door_scripts where workspace_id = $1', [c.get('ctx').workspaceId],
  )).rows;
  const of = (k) => { const r = rows.find((x) => x.context === k); return r ? { body: r.body, updated_at: r.updated_at } : null; };
  return c.json(Object.fromEntries(CONTEXTS.map((k) => [k, of(k)])));
});

export const exportTables = ['door_scripts'];
