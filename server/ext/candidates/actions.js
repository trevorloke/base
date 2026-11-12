// Candidates, kept by managers (Settings → Candidates). Every one is
// roles: ['manager'] with no area of its own, so lib/perms.js counts it the
// Admin area's.
//
//   candidate.save   { id?, name, office?, race?, email? } — make or edit a seat
//   candidate.invite { id } — a join link (emailed after the write commits),
//                    or, for someone already on the team, their seat now
//   candidate.unlink { id } — the account leaves the seat; it stays a volunteer
//   candidate.remove { id } — the seat goes (and its account leaves it); their call time closes
import { z } from 'zod';
import { SLATE_CODES } from '@starbase/shared/canvass';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { sendEmail } from '../../lib/notify.js';
import { writeInvite, linkMember } from './invite.js';
import { handCallTime } from './hand.js';

const MANAGER = ['manager'];
const uuid = () => z.uuid();
const text = (max) => z.string().trim().max(max).nullish().transform((v) => v || null);

// A candidate never keeps the seats, even one given the Admin area.
const notACandidate = (ctx) => { if (ctx.candidate) throw httpError(403, 'not for you'); };

export const loadCandidate = async (tx, ws, id, { lock = false } = {}) => {
  const c = (await tx.query(
    `select * from candidates where id = $1 and workspace_id = $2 and removed_at is null${lock ? ' for update' : ''}`, [id, ws],
  )).rows[0];
  if (!c) throw httpError(404, 'candidate not found');
  return c;
};

// The invite's email, after the write has committed: never a send inside
// the campaign's write (IMPL-RULES 7). The answer says whether it went.
const sendInvite = async (db, ctx, result) => {
  if (!result.mail) return { result };
  const { mail, ...rest } = result;
  const sent = await sendEmail({
    to: mail.to,
    subject: `Join ${ctx.workspace.name} on base.win`,
    text: `${ctx.user.name} invited you to ${ctx.workspace.name}’s app as a candidate.\n\nSet your password and get started: ${rest.joinUrl}\n\nThis link expires in 14 days.`,
  });
  return { result: { ...rest, email: sent.status } };
};

export const actions = {
  'candidate.save': {
    roles: MANAGER,
    input: z.object({
      id: uuid().optional(),
      name: z.string().trim().min(1).max(120),
      office: text(80),
      race: text(30),
      email: z.union([z.literal(''), z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(320))]).nullish()
        .transform((v) => v || null),
    }),
    handler: async (tx, ctx, input, emit) => {
      notACandidate(ctx);
      const ws = ctx.workspaceId;
      if (input.race && !SLATE_CODES.includes(input.race)) throw httpError(400, 'Pick a race from the list');
      const fields = { name: input.name, office: input.office, race: input.race, email: input.email };
      if (input.id) {
        await loadCandidate(tx, ws, input.id, { lock: true });
        await tx.query('update candidates set name = $3, office = $4, race = $5, email = $6 where id = $1 and workspace_id = $2',
          [input.id, ws, fields.name, fields.office, fields.race, fields.email]);
        emit('candidate', input.id, 'update', fields);
        return { candidate: { id: input.id, ...fields } };
      }
      const id = newId();
      const position = (await tx.query('select coalesce(max(position), 0) + 1 as n from candidates where workspace_id = $1', [ws])).rows[0].n;
      await tx.query('insert into candidates (id, workspace_id, name, office, race, email, position) values ($1, $2, $3, $4, $5, $6, $7)',
        [id, ws, fields.name, fields.office, fields.race, fields.email, position]);
      emit('candidate', id, 'create', fields);
      return { candidate: { id, ...fields } };
    },
  },

  'candidate.invite': {
    roles: MANAGER,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      notACandidate(ctx);
      const ws = ctx.workspaceId;
      const cand = await loadCandidate(tx, ws, input.id, { lock: true });
      if (!cand.email) throw httpError(409, 'Add their email first');
      if (cand.user_id) throw httpError(409, `${cand.name} is already signed in`);
      // Already on the team: no invite — their seat now (volunteers only).
      const member = (await tx.query(
        `select m.user_id, m.role, u.name from memberships m join users u on u.id = m.user_id
         where m.workspace_id = $1 and u.email = $2`, [ws, cand.email],
      )).rows[0];
      if (member) {
        await linkMember(tx, emit, ws, cand, member);
        return { id: cand.id, linked: true };
      }
      const inv = await writeInvite(tx, ctx, emit, { email: cand.email, candidateId: cand.id });
      return { id: cand.id, linked: false, invited_until: inv.until, joinUrl: inv.joinUrl, mail: { to: cand.email } };
    },
    after: sendInvite,
  },

  'candidate.unlink': {
    roles: MANAGER,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      notACandidate(ctx);
      const cand = await loadCandidate(tx, ctx.workspaceId, input.id, { lock: true });
      if (cand.user_id) {
        await tx.query('update candidates set user_id = null where id = $1', [cand.id]);
        await handCallTime(tx, ctx.workspaceId, cand.id, null);
        emit('candidate', cand.id, 'update', { unlinked: cand.user_id });
      }
      return { id: cand.id, unlinked: Boolean(cand.user_id) };
    },
  },

  'candidate.remove': {
    roles: MANAGER,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      notACandidate(ctx);
      const ws = ctx.workspaceId;
      const cand = await loadCandidate(tx, ws, input.id, { lock: true });
      await tx.query('update candidates set removed_at = now(), user_id = null where id = $1', [cand.id]);
      await handCallTime(tx, ws, cand.id, null);
      // Their call time closes: nobody else may call it (ext/banks notCallTime).
      const closed = (await tx.query(
        `update call_banks set closed_at = now(), updated_at = now()
         where workspace_id = $1 and candidate_id = $2 and deleted_at is null and closed_at is null returning id`,
        [ws, cand.id],
      )).rows;
      for (const b of closed) emit('call_bank', b.id, 'update', { closed: true });
      // A link still out for this seat stops working.
      const ended = (await tx.query(
        `update invites set expires_at = now()
         where workspace_id = $1 and candidate_id = $2 and accepted_at is null and expires_at > now() returning id, email`,
        [ws, cand.id],
      )).rows;
      for (const r of ended) emit('invite', r.id, 'void', { email: r.email });
      emit('candidate', cand.id, 'void', { name: cand.name });
      return { id: cand.id };
    },
  },
};
