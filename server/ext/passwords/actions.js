// member.passwordLink { user_id } — managers: a link for someone on the team
// to choose a new password, for when they can't use Forgot password. It
// works once, for 24 hours. With email set up it is emailed to them after
// the write and never shown (so nobody else can use it); without, the
// manager gets it to pass on.
//
// Not for: yourself, another manager (they use Forgot password), base.win
// support (no password), anyone in another campaign on this server too
// (another campaign's manager doesn't set their password), the public demo,
// or a campaign with no address (STARBASE_PUBLIC_URL) to build it from.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { demoEmail } from '../../lib/demo.js';
import { emailConfigured } from '../../lib/notify.js';
import { LIVE_MAX, MANAGER_HOURS, makeLink, managerEmail, publicBase, resetLink, sendLink } from './reset.js';

export const actions = {
  'member.passwordLink': {
    roles: ['manager'],
    input: z.object({ user_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      if (demoEmail()) throw httpError(409, 'The demo can’t make password links.');
      if (!publicBase()) throw httpError(409, 'Set the campaign’s address first (STARBASE_PUBLIC_URL).');
      if (input.user_id === ctx.user.id) throw httpError(409, 'For your own, use Forgot your password? on the sign-in screen.');
      const m = (await tx.query(
        `select m.role, u.name, u.email, u.support from memberships m join users u on u.id = m.user_id
          where m.user_id = $1 and m.workspace_id = $2`,
        [input.user_id, ctx.workspaceId],
      )).rows[0];
      if (!m) throw httpError(404, 'member not found');
      if (m.support) throw httpError(409, 'base.win support has no password here.');
      if (m.role === 'manager') throw httpError(409, 'A manager resets their own: Forgot your password?');
      const elsewhere = (await tx.query('select 1 from memberships where user_id = $1 and workspace_id <> $2 limit 1', [input.user_id, ctx.workspaceId])).rows[0];
      if (elsewhere) throw httpError(409, `${m.name} is in another campaign on this server too: they use Forgot your password?`);
      const made = await makeLink(tx, input.user_id, { madeBy: ctx.user.id, minutes: MANAGER_HOURS * 60 });
      if (!made) throw httpError(409, `${m.name} already has ${LIVE_MAX} links that still work. Use one, or wait for one to run out.`);
      // That a link was made, by whom (the event's actor) — never the link.
      emit('user', input.user_id, 'update', { password_link: true });
      return { made, to: m.email, name: m.name };
    },
    // Committed: the email, outside the campaign's lock. The link itself
    // goes back only when there is no sender.
    after: async (db, ctx, { made, to, name }) => {
      const link = resetLink(made.token);
      if (!emailConfigured()) return { result: { link, name, hours: MANAGER_HOURS } };
      const words = managerEmail({ campaign: ctx.workspace.name, manager: ctx.user.name, link });
      const r = await sendLink({ to, ...made, words });
      if (!r.sent) throw httpError(502, `The email to ${name} didn’t go. Try again in a minute.`);
      return { result: { emailed: true, name, hours: MANAGER_HOURS } };
    },
  },
};
