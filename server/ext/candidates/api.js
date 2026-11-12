// Reads:
//   GET /candidates      managers (the Admin area, lib/perms.js): every seat
//                        with its status — signed in, invited until, or why
//                        an account on the team isn't in it — and the races
//   GET /candidate/home  the signed-in candidate only (anyone else: 404):
//                        their race now, from Path to win. Each part answers
//                        on its own: { unavailable: true }, never a 0 — and
//                        their call time (calltime.js): banks, left, pledged this week
import { Hono } from 'hono';
import { SLATES, slateLabel } from '@starbase/shared/canvass';
import { raceNow } from '../pathtowin/api.js';
import { ROLE_WORDS } from './invite.js';
import { areasFor } from '../../lib/perms.js';
import { api as calltime, callTimeOf } from './calltime.js';

export const api = new Hono();
api.route('/', calltime);

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
  // Call time, for those who have it: numbers not yet called, and the
  // pledges heard that haven't been dropped.
  const db = c.get('db');
  const toCall = new Map((await db.query(
    `select b.candidate_id, count(n.person_id) filter (where n.done_at is null)::int as left from call_banks b
       left join call_bank_numbers n on n.bank_id = b.id
      where b.workspace_id = $1 and b.candidate_id is not null and b.deleted_at is null and b.closed_at is null
      group by b.candidate_id`, [ctx.workspaceId],
  )).rows.map((r) => [r.candidate_id, r.left]));
  const pledged = new Map((await db.query(
    `select candidate_id, coalesce(sum(amount_cents), 0)::bigint as cents from calltime_results
      where workspace_id = $1 and result = 'pledged' and dropped_at is null group by candidate_id`, [ctx.workspaceId],
  )).rows.map((r) => [r.candidate_id, Number(r.cents)]));
  const candidates = rows.map((r) => ({
    id: r.id, name: r.name, office: r.office, race: r.race, race_label: r.race ? slateLabel(r.race) : null, email: r.email,
    signed_in: Boolean(r.user_id),
    invited_until: r.user_id ? null : r.invited_until,
    // Their email is someone at the desk: a candidate is only ever a volunteer.
    not_linked_reason: !r.user_id && r.member_role && r.member_role !== 'volunteer'
      ? `${r.member_name || r.name} is ${ROLE_WORDS[r.member_role] || r.member_role} — not linked` : null,
    calltime: toCall.has(r.id) || pledged.has(r.id) ? { left: toCall.get(r.id) ?? 0, pledged_cents: pledged.get(r.id) ?? 0 } : null,
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
  // Call time: their banks and how many are left to call now.
  let callTime;
  try {
    callTime = await callTimeOf(c.get('db'), ctx);
  } catch (e) {
    console.error(`candidate home: call time failed (${e.message})`);
    callTime = { unavailable: true };
  }
  return c.json({ candidate: { id: ctx.candidate.id, name: ctx.candidate.name }, race, calltime: callTime });
});
