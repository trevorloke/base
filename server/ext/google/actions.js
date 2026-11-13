// Google sign-in and connections, as actions (the route pair in routes.js
// writes google.link and google.connect itself, on Google's return):
//
//   google.unlink {}                 your own sign-in link goes; your other
//                                    sessions end (every account keeps its
//                                    password, so nobody is locked out)
//   google.unlinkMember { user_id }  managers: a lost or taken-over Google
//                                    account; not for someone in another
//                                    campaign on this server too
//   google.settings { signin?, domain? }   managers: Google sign-in on or
//                                    off; only Google accounts at one
//                                    Workspace domain (your own link at it
//                                    first)
//   google.disconnect { purpose }    your own connection stops being used
//                                    for it; revoked at Google when nothing
//                                    is left (lib/google/tokens.js)
//   google.forget {}                 managers: every member's connection
//                                    who is in no other campaign here
//
// Nothing about a Google account goes on the chain: google_login payloads
// are {} or { by: 'manager' }; google_grant's are pinned (tokens.js).
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { grantRowOf, removePurposes } from '../../lib/google/tokens.js';
import { signinRules } from '../../lib/google/config.js';
import { jobRunnerOn } from '../../lib/jobs.js';

const EVERYONE = ['manager', 'treasurer', 'staff', 'volunteer'];
const MANAGER = ['manager'];
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

export const actions = {
  'google.unlink': {
    roles: EVERYONE,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query('delete from google_logins where user_id = $1', [ctx.user.id]);
      if (n.affectedRows === 0) throw httpError(404, 'your account isn’t linked to Google');
      // Signed in with Google elsewhere: those devices sign in again.
      const ended = await tx.query('delete from sessions where user_id = $1 and token_hash <> $2', [ctx.user.id, ctx.session || '']);
      emit('google_login', ctx.user.id, 'void', {});
      return { linked: false, signed_out_elsewhere: ended.affectedRows };
    },
  },

  'google.unlinkMember': {
    roles: MANAGER,
    input: z.object({ user_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const member = (await tx.query('select 1 from memberships where user_id = $1 and workspace_id = $2', [input.user_id, ctx.workspaceId])).rows[0];
      if (!member) throw httpError(404, 'member not found');
      // Their link opens every campaign they're in: one campaign's manager
      // doesn't take it away from another's.
      const elsewhere = (await tx.query('select 1 from memberships where user_id = $1 and workspace_id <> $2 limit 1', [input.user_id, ctx.workspaceId])).rows[0];
      if (elsewhere) throw httpError(409, 'they belong to another campaign on this server too — ask them to unlink it on Your profile');
      const n = await tx.query('delete from google_logins where user_id = $1', [input.user_id]);
      if (n.affectedRows === 0) throw httpError(404, 'they don’t sign in with Google');
      await tx.query('delete from sessions where user_id = $1 and workspace_id = $2', [input.user_id, ctx.workspaceId]);
      emit('google_login', input.user_id, 'void', { by: 'manager' });
      return { user_id: input.user_id };
    },
  },

  'google.settings': {
    roles: MANAGER,
    input: z.object({
      signin: z.boolean().optional(),
      domain: z.string().trim().toLowerCase().max(253).regex(DOMAIN_RE, 'a domain such as example.org').nullable().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const settings = parse((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0].settings);
      const now = signinRules(settings);
      const next = {
        signin: input.signin === undefined ? now.signin : input.signin,
        domain: input.domain === undefined ? now.domain : (input.domain || null),
      };
      // Only a real Google Workspace domain, and never one that would shut
      // the manager setting it out of Google sign-in.
      if (next.domain && next.domain !== now.domain) {
        const mine = (await tx.query('select hd from google_logins where user_id = $1', [ctx.user.id])).rows[0];
        if (mine?.hd !== next.domain) throw httpError(409, `Link your own Google account at ${next.domain} first (Your profile)`);
      }
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify({ ...settings, google: next })]);
      emit('workspace', ws, 'update', { google: next });
      return next;
    },
  },

  'google.disconnect': {
    roles: EVERYONE,
    input: z.object({ purpose: z.string().min(1).max(60) }),
    handler: async (tx, ctx, input, emit) => {
      const row = await grantRowOf(tx, ctx.user.id, { lock: true });
      if (!row || !row.purposes.includes(input.purpose)) throw httpError(404, 'you aren’t connected for that');
      const r = await removePurposes(tx, emit, row, [input.purpose], { workspaceId: ctx.workspaceId });
      return { still_at_google: r.still_at_google, deleted: r.deleted, jobs: jobRunnerOn() };
    },
  },

  'google.forget': {
    roles: MANAGER,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const users = (await tx.query(
        `select g.user_id from google_grants g
         join memberships m on m.user_id = g.user_id and m.workspace_id = $1
         where not exists (select 1 from memberships o where o.user_id = g.user_id and o.workspace_id <> $1)`,
        [ctx.workspaceId],
      )).rows.map((r) => r.user_id);
      let n = 0;
      for (const userId of users) {
        const row = await grantRowOf(tx, userId, { lock: true });
        if (!row) continue;
        await removePurposes(tx, emit, row, row.purposes, { workspaceId: ctx.workspaceId });
        n += 1;
      }
      return { disconnected: n };
    },
  },
};
