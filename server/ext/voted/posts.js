// Who works where on voting days, and how they sign in on the day.
//
//   gotv.post.set     { user_id, role, place_id?, days?, appointed? }  manager:
//                     a scrutineer at one voting place (the voter guide's), or
//                     a runner carrying any place's sheets; one open post each
//   gotv.post.end     { id }  manager: ends the post and every sign-in code
//                     session made for that person
//   gotv.signin.code  { user_id }  manager: a link and QR that sign that
//                     person in to Who voted only, once, within 15 minutes
//   gotv.practice.clear {}  manager: wipes practice marks and practice checks
//   gotv.find.allow   { user_id }  manager: 2,000 more look-ups today
//
// Each checks ctx.role === 'manager' itself: these make sessions for other
// people and steer a legal hold, so an Admin-area grant is not enough.
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { qrSvgPath } from '../../lib/qr.js';
import { hoursOf, votingDays } from './clock.js';
import { rowOf } from './state.js';
import { allowMore } from './find.js';

const ONLY = 'Only a manager can do this';
const managerOnly = (ctx) => { if (ctx.role !== 'manager') throw httpError(403, ONLY); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SIGNIN_MINUTES = 15;
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

// The days a post covers that its place has no voting on.
export const notOpenDays = (h, s, post) => {
  const place = post.place_id ? h.places.get(post.place_id) : null;
  if (!place || !place.listed) return [];
  const days = post.days?.length ? post.days : votingDays(s);
  return days.filter((d) => !place.days.has(d));
};

export const postActions = {
  'gotv.post.set': {
    roles: ['manager'],
    input: z.object({
      user_id: z.uuid(),
      role: z.enum(['scrutineer', 'runner']),
      place_id: z.uuid().nullish(),
      days: z.array(z.string().regex(DAY, 'a date like 2026-10-17')).max(30).optional(),
      appointed: z.boolean().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      managerOnly(ctx);
      const ws = ctx.workspaceId;
      const m = (await tx.query(
        'select m.role, u.email, u.name from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 and m.user_id = $2',
        [ws, input.user_id],
      )).rows[0];
      if (!m) throw httpError(404, 'They aren’t in this campaign');
      if (m.role !== 'volunteer') throw httpError(400, 'Scrutineers are volunteers — change their role first.');
      const h = await hoursOf(tx, ws);
      const place = input.place_id ? h.places.get(input.place_id) : null;
      if ((input.role === 'scrutineer' && !input.place_id) || (input.place_id && (!place || place.gone))) {
        throw httpError(400, 'Pick a voting place from the voter guide’s list');
      }
      const cur = (await tx.query('select * from gotv_posts where workspace_id = $1 and user_id = $2 and ended_at is null', [ws, input.user_id])).rows[0];
      const days = input.days ? [...new Set(input.days)].sort() : (cur ? (typeof cur.days === 'string' ? JSON.parse(cur.days) : cur.days) : []);
      const appointed = input.appointed ?? cur?.appointed ?? false;
      const place_id = input.place_id || null;
      let id;
      if (cur) {
        id = cur.id;
        await tx.query('update gotv_posts set role = $3, place_id = $4, days = $5, appointed = $6 where id = $1 and workspace_id = $2',
          [id, ws, input.role, place_id, JSON.stringify(days), appointed]);
        emit('gotv_post', id, 'update', { user_id: input.user_id, role: input.role, place_id, days, appointed });
      } else {
        id = newId();
        await tx.query(
          `insert into gotv_posts (id, workspace_id, user_id, role, place_id, days, appointed, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, ws, input.user_id, input.role, place_id, JSON.stringify(days), appointed, ctx.user.id],
        );
        emit('gotv_post', id, 'create', { id, user_id: input.user_id, role: input.role, place_id, days, appointed });
      }
      // The Volunteers screens say the same: their scrutineer or runner role.
      const person = (await tx.query(
        'select id from persons where workspace_id = $1 and lower(email) = lower($2) and deleted_at is null order by created_at limit 1', [ws, m.email],
      )).rows[0];
      if (person) {
        const has = (await tx.query('select 1 from volunteer_roles where workspace_id = $1 and person_id = $2 and role = $3', [ws, person.id, input.role])).rows[0];
        if (!has) {
          const rid = newId();
          const detail = place?.name || null;
          await tx.query('insert into volunteer_roles (id, workspace_id, person_id, role, detail) values ($1, $2, $3, $4, $5)', [rid, ws, person.id, input.role, detail]);
          emit('volunteer_role', rid, 'create', { id: rid, person_id: person.id, role: input.role, detail, source: 'gotv' });
        }
      }
      const s = await rowOf(tx, ws);
      return { post: { id, user_id: input.user_id, role: input.role, place_id, days, appointed }, not_open: notOpenDays(h, s, { place_id, days }) };
    },
  },

  'gotv.post.end': {
    roles: ['manager'],
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      managerOnly(ctx);
      const ws = ctx.workspaceId;
      const row = (await tx.query('update gotv_posts set ended_at = now() where id = $1 and workspace_id = $2 and ended_at is null returning user_id', [input.id, ws])).rows[0];
      if (!row) throw httpError(404, 'That post has ended already');
      const gone = (await tx.query("delete from sessions where workspace_id = $1 and user_id = $2 and scope = 'gotv'", [ws, row.user_id])).affectedRows;
      emit('gotv_post', input.id, 'update', { ended: true, user_id: row.user_id, signins_ended: gone });
      return { id: input.id, ended: true };
    },
  },

  'gotv.signin.code': {
    roles: ['manager'],
    input: z.object({ user_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      managerOnly(ctx);
      const ws = ctx.workspaceId;
      const post = (await tx.query('select id from gotv_posts where workspace_id = $1 and user_id = $2 and ended_at is null', [ws, input.user_id])).rows[0];
      if (!post) throw httpError(400, 'Give them a post first (Scrutineers → Add a scrutineer)');
      const token = randomBytes(32).toString('hex');
      const id = newId();
      await tx.query(
        `insert into gotv_signin (token_hash, id, workspace_id, user_id, created_by, expires_at)
         values ($1, $2, $3, $4, $5, now() + interval '${SIGNIN_MINUTES} minutes')`,
        [hashToken(token), id, ws, input.user_id, ctx.user.id],
      );
      // The token is never in an event or a log: only who it is for.
      emit('gotv_signin', id, 'create', { user_id: input.user_id });
      const url = `${ctx.publicUrl || ''}/go/${token}`;
      const { d, size } = qrSvgPath(url);
      const qr_svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
      return { url, qr_svg, minutes: SIGNIN_MINUTES };
    },
  },

  'gotv.practice.clear': {
    roles: ['manager'],
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      managerOnly(ctx);
      const ws = ctx.workspaceId;
      const n = (await tx.query('delete from gotv_practice where workspace_id = $1', [ws])).affectedRows
        + (await tx.query('delete from gotv_checks where workspace_id = $1 and practice', [ws])).affectedRows;
      emit('workspace', ws, 'update', { practice_cleared: n });
      return { practice_cleared: n };
    },
  },

  'gotv.find.allow': {
    roles: ['manager'],
    input: z.object({ user_id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      managerOnly(ctx);
      emit('gotv_post', input.user_id, 'update', { lookups_allowed: 2000 });
      return { user_id: input.user_id, allowed: 2000 };
    },
    after: async (db, ctx, result) => { allowMore(ctx.workspaceId, result.user_id, 2000); return { result }; },
  },
};
