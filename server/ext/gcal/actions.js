// Google Calendar, as actions. The person's own are every role's, with no
// area, and act only on the caller's own link (the calendar.feed.* rule);
// the switch is the manager's (Admin).
//
//   gcal.settings { on }   managers: "Shifts in Google Calendar" for the
//                          campaign. On needs Google set up for connections;
//                          off removes everyone's base.win calendar.
//   gcal.on {}             your shifts into Google Calendar with the
//                          connection you already have (a second campaign,
//                          or "Make it again" after deleting it in Google)
//   gcal.stop {}           base.win deletes its calendar from your Google
//                          account; a link it could no longer reach ('left')
//                          is only forgotten here
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { googleSetup } from '../../lib/google/config.js';
import { grantFor } from '../../lib/google/tokens.js';
import { campaignOf, ensurePush, ensureSweep, PURPOSE, SAID } from './push.js';

const EVERYONE = ['manager', 'treasurer', 'staff', 'volunteer'];
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
export const jobsOn = () => process.env.STARBASE_JOBS !== 'off';
const soon = async (db, ctx, result) => { runJobsSoon(); return { result }; };

export const actions = {
  'gcal.settings': {
    roles: ['manager'],
    input: z.object({ on: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const settings = parse((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0].settings);
      if (input.on && !googleSetup().connect) throw httpError(409, 'Set up Google first (Settings → Services → Google)');
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify({ ...settings, gcal: { on: input.on } })]);
      emit('workspace', ws, 'update', { gcal: { on: input.on } });
      let stopping = 0;
      if (input.on) await ensureSweep(tx, ws, (await campaignOf(tx, ws)).tz);
      else {
        // Everyone's base.win calendar goes; with no jobs, nothing can reach
        // Google, so each person is told instead.
        const state = jobsOn() ? 'stopping' : 'left';
        const rows = (await tx.query(
          `update gcal_links set state = $2, said = $3, dirty_at = null, updated_at = now()
            where workspace_id = $1 and state not in ('stopping', 'left') returning user_id`,
          [ws, state, state === 'left' ? SAID.left : null],
        )).rows;
        for (const r of rows) emit('gcal_link', r.user_id, 'update', { state });
        stopping = rows.length;
        if (stopping && jobsOn()) await enqueueJob(tx, { workspaceId: ws, kind: 'gcal.stop', key: `gcal-stop-${newId()}` });
        if (!jobsOn()) await tx.query('delete from gcal_items where workspace_id = $1', [ws]);
      }
      return { on: input.on, stopping };
    },
    after: soon,
  },

  'gcal.on': {
    roles: EVERYONE,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const userId = ctx.user.id;
      const c = await campaignOf(tx, ws);
      if (!c.on || !googleSetup().connect || !jobsOn()) throw httpError(409, 'Google Calendar isn’t on for this campaign');
      const grant = await grantFor(tx, { userId, workspaceId: ws }, PURPOSE);
      if (!grant) throw httpError(409, 'Connect Google Calendar first');
      if (grant.state === 'reconnect') throw httpError(409, 'Reconnect Google first');
      if (grant.state !== 'ok') throw httpError(409, grant.said || 'You can’t use Google Calendar in this campaign');
      const link = (await tx.query('select state from gcal_links where workspace_id = $1 and user_id = $2 for update', [ws, userId])).rows[0];
      if (link?.state === 'stopping') throw httpError(409, 'base.win is still removing your old calendar — try again in a minute');
      if (!link) {
        await tx.query(`insert into gcal_links (workspace_id, user_id, state, dirty_at) values ($1, $2, 'ok', now())`, [ws, userId]);
        emit('gcal_link', userId, 'create', { state: 'ok' });
      } else {
        // From gone (or left): a fresh calendar is made.
        const fresh = link.state === 'gone' || link.state === 'left';
        await tx.query(
          `update gcal_links set state = 'ok', said = null, dirty_at = now(), wait_until = null, updated_at = now()
             ${fresh ? ', calendar_id = null, cal_hash = null' : ''} where workspace_id = $1 and user_id = $2`,
          [ws, userId],
        );
        if (fresh) await tx.query('delete from gcal_items where workspace_id = $1 and user_id = $2', [ws, userId]);
        if (link.state !== 'ok') emit('gcal_link', userId, 'update', { state: 'ok' });
      }
      await ensurePush(tx, ws);
      await ensureSweep(tx, ws, c.tz);
      return { state: 'ok' };
    },
    after: soon,
  },

  'gcal.stop': {
    roles: EVERYONE,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const userId = ctx.user.id;
      const link = (await tx.query('select state from gcal_links where workspace_id = $1 and user_id = $2 for update', [ws, userId])).rows[0];
      if (!link) throw httpError(409, 'Your shifts aren’t in Google Calendar');
      if (link.state === 'left') {
        // base.win can't reach it: only forgotten here.
        await tx.query('delete from gcal_links where workspace_id = $1 and user_id = $2', [ws, userId]);
        emit('gcal_link', userId, 'void', {});
        return { state: null };
      }
      if (!jobsOn() && link.state !== 'stopping') {
        // No background work on this server: nothing can reach Google.
        await tx.query(`update gcal_links set state = 'left', said = $3, dirty_at = null, updated_at = now() where workspace_id = $1 and user_id = $2`, [ws, userId, SAID.left]);
        await tx.query('delete from gcal_items where workspace_id = $1 and user_id = $2', [ws, userId]);
        emit('gcal_link', userId, 'update', { state: 'left' });
        return { state: 'left' };
      }
      if (link.state !== 'stopping') {
        await tx.query(`update gcal_links set state = 'stopping', dirty_at = null, updated_at = now() where workspace_id = $1 and user_id = $2`, [ws, userId]);
        emit('gcal_link', userId, 'update', { state: 'stopping' });
        await enqueueJob(tx, { workspaceId: ws, kind: 'gcal.stop', key: `gcal-stop-${newId()}` });
      }
      return { state: 'stopping' };
    },
    after: soon,
  },
};
