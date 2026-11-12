// A candidate's invite and their seat: the invite row (as Team's
// member.invite writes it, with the candidate's id on it), linking an
// account to a seat, and what the app is told about a seat.
//
// Linking is only ever to a volunteer: any other role is the desk, and a
// candidate must never be the desk (lib/auth.js reads a seat only on a
// volunteer, as a second guard).
import { randomBytes, createHash } from 'node:crypto';
import { slateLabel } from '@starbase/shared/canvass';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';

export const ROLE_WORDS = { manager: 'a manager', treasurer: 'a treasurer', staff: 'staff', volunteer: 'a volunteer' };

export const candidateOut = (c) => (c
  ? { id: c.id, name: c.name, office: c.office || null, race: c.race || null, race_label: c.race ? slateLabel(c.race) : null }
  : null);

// The row and its link: 14 days, the token hashed, one live link per email
// (older ones end, on the record). The token never enters the event log.
export const writeInvite = async (tx, ctx, emit, { email, candidateId }) => {
  const token = randomBytes(24).toString('hex');
  const id = newId();
  const replaced = (await tx.query(
    `update invites set expires_at = now()
     where workspace_id = $1 and email = $2 and accepted_at is null and expires_at > now()
     returning id`,
    [ctx.workspaceId, email],
  )).rows;
  for (const r of replaced) emit('invite', r.id, 'void', { email, replaced_by: id });
  const until = (await tx.query(
    `insert into invites (id, workspace_id, email, role, token_hash, created_by, expires_at, candidate_id)
     values ($1, $2, $3, 'volunteer', $4, $5, now() + interval '14 days', $6) returning expires_at`,
    [id, ctx.workspaceId, email, createHash('sha256').update(token).digest('hex'), ctx.user.id, candidateId],
  )).rows[0].expires_at;
  emit('invite', id, 'create', { email, role: 'volunteer', candidate_id: candidateId });
  return { id, token, until, joinUrl: `${ctx.publicUrl || ''}/join/${token}` };
};

// Put an account in a seat now (a member already on the team). Refused for
// any role but volunteer, and for someone already in another seat.
export const linkMember = async (tx, emit, ws, cand, member) => {
  if (member.role !== 'volunteer') {
    throw httpError(409, `${member.name} is ${ROLE_WORDS[member.role] || member.role} — make them a volunteer first`);
  }
  const other = (await tx.query(
    'select name from candidates where workspace_id = $1 and user_id = $2 and removed_at is null and id <> $3',
    [ws, member.user_id, cand.id],
  )).rows[0];
  if (other) throw httpError(409, `${member.name} is already in ${other.name}’s seat`);
  await tx.query('update candidates set user_id = $2 where id = $1', [cand.id, member.user_id]);
  emit('candidate', cand.id, 'update', { linked: member.user_id });
};

// /join (routes/auth.js), inside the join's own write: the seat is taken
// only if the account is a volunteer here once joined — someone made staff
// meanwhile keeps their role and the seat stays empty, on the record.
export const linkOnJoin = async (tx, emit, { workspaceId, candidateId, userId }) => {
  const cand = (await tx.query(
    'select id from candidates where id = $1 and workspace_id = $2 and removed_at is null and user_id is null for update',
    [candidateId, workspaceId],
  )).rows[0];
  if (!cand) return;
  const role = (await tx.query('select role from memberships where user_id = $1 and workspace_id = $2', [userId, workspaceId])).rows[0]?.role;
  if (role !== 'volunteer') {
    emit('candidate', cand.id, 'update', { not_linked: 'role', role });
    return;
  }
  const other = (await tx.query(
    'select 1 from candidates where workspace_id = $1 and user_id = $2 and removed_at is null', [workspaceId, userId],
  )).rows[0];
  if (other) {
    emit('candidate', cand.id, 'update', { not_linked: 'seat' });
    return;
  }
  await tx.query('update candidates set user_id = $2 where id = $1', [cand.id, userId]);
  emit('candidate', cand.id, 'update', { linked: userId });
};
