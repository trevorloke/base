// Reads:
//   GET /candidates      managers (the Admin area, lib/perms.js): every seat
//                        with its status — signed in, invited until, or why
//                        an account on the team isn't in it — and the races
//   GET /candidate/home  the signed-in candidate only (anyone else: 404):
//                        their race now, from Path to win. Each part answers
//                        on its own: { unavailable: true }, never a 0.
import { Hono } from 'hono';
import { SLATES, slateLabel } from '@starbase/shared/canvass';
import { raceNow } from '../pathtowin/api.js';
import { ROLE_WORDS } from './invite.js';
import { areasFor } from '../../lib/perms.js';

export const api = new Hono();

api.get('/candidates', async (c) => {
  const ctx = c.get('ctx');
  // The Admin area's; never a candidate's, whatever they were granted.
  if (ctx.candidate || !areasFor(ctx).includes('admin')) return c.json({ error: 'not for you' }, 403);
  const rows = (await c.get('db').query(
    `select c.id, c.name, c.office, c.race, c.email, c.user_id,
            (select max(i.expires_at) from invites i where i.workspace_id = c.workspace_id and i.candidate_id = c.id
               and i.accepted_at is null and i.expires_at > now()) as invited_until,
            m.role as member_role, u.name as member_name
       from candidates c
       left join users u on c.user_id is null and c.email is not null and u.email = c.email
       left join memberships m on m.user_id = u.id and m.workspace_id = c.workspace_id
      where c.workspace_id = $1 and c.removed_at is null
      order by c.position, c.created_at`, [ctx.workspaceId],
  )).rows;
  const candidates = rows.map((r) => ({
    id: r.id, name: r.name, office: r.office, race: r.race, race_label: r.race ? slateLabel(r.race) : null, email: r.email,
    signed_in: Boolean(r.user_id),
    invited_until: r.user_id ? null : r.invited_until,
    // Their email is someone at the desk: a candidate is only ever a volunteer.
    not_linked_reason: !r.user_id && r.member_role && r.member_role !== 'volunteer'
      ? `${r.member_name || r.name} is ${ROLE_WORDS[r.member_role] || r.member_role} — not linked` : null,
  }));
  return c.json({ candidates, slates: SLATES });
});

api.get('/candidate/home', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx.candidate) return c.json({ error: 'not found' }, 404);
  let race = null;
  if (ctx.candidate.race) {
    try {
      race = await raceNow(c.get('db'), ctx, ctx.candidate.race);
    } catch (e) {
      console.error(`candidate home: the race count failed (${e.message})`);
      race = { unavailable: true };
    }
  }
  return c.json({ candidate: { id: ctx.candidate.id, name: ctx.candidate.name }, race });
});
