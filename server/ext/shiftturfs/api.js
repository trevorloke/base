// GET /shiftturfs            every live shift's turfs: { shifts: { [shift_id]: [{ id, name, color }] } }
// GET /shiftturfs/:shiftId   one shift's: { turfs: [{ id, name, color }] }; the desk
//                            also gets no_sign_in: the assignment ids of people on
//                            it (assigned or confirmed) with no app sign-in, who
//                            can't get its walk lists on a phone (not counting
//                            anyone the crew board put on "No walk list")
// Any role (area shifts, lib/perms.js): turf names and colours only — no
// doors, no people. Under /shiftturfs, not /shifts/…: routes/api.js answers
// /shifts/:id (and 404s anything under it) before feature routes mount.
import { Hono } from 'hono';

export const api = new Hono();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const turfOut = (r) => ({ id: r.id, name: r.name, color: r.color || null });
const TURFS_OF = `select st.shift_id, t.id, t.name, t.color from shift_turfs st
  join shifts s on s.id = st.shift_id and s.deleted_at is null
  join turfs t on t.id = st.turf_id and t.deleted_at is null
  where st.workspace_id = $1`;

api.get('/shiftturfs', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(`${TURFS_OF} order by t.created_at, t.id`, [ctx.workspaceId]);
  const shifts = {};
  for (const r of rows) (shifts[r.shift_id] ||= []).push(turfOut(r));
  return c.json({ shifts });
});

api.get('/shiftturfs/:shiftId', async (c) => {
  const id = c.req.param('shiftId');
  if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const shift = (await db.query(
    'select id from shifts where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!shift) return c.json({ error: 'not found' }, 404);
  const turfs = (await db.query(`${TURFS_OF} and st.shift_id = $2 order by t.created_at, t.id`, [ctx.workspaceId, id])).rows.map(turfOut);
  if (ctx.role === 'volunteer') return c.json({ turfs });
  const noSignIn = (await db.query(
    `select a.id from shift_assignments a join persons p on p.id = a.person_id
     where a.workspace_id = $1 and a.shift_id = $2 and a.status in ('assigned', 'confirmed')
       and not exists (select 1 from shift_crew c where c.assignment_id = a.id and c.placed = 'none')
       and not exists (
         select 1 from users u join memberships m on m.user_id = u.id and m.workspace_id = $1
         where p.email is not null and lower(u.email) = lower(p.email))`,
    [ctx.workspaceId, id],
  )).rows.map((r) => r.id);
  return c.json({ turfs, no_sign_in: noSignIn });
});
