// Organizing actions: turfs (draw, assign, walk).
import { z } from 'zod';
import { newId } from '../lib/events.js';
import { httpError } from './util.js';

const DESK_ROLES = ['manager', 'treasurer', 'staff'];
const uuid = () => z.uuid();
const isoTs = () => z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'expected ISO timestamp');
const latlng = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const slug = () => z.string().trim().regex(/^[a-z0-9-]{2,60}$/, 'lowercase letters, digits, dashes');

export const ORGANIZE_ACTIONS = {
  // ── Turfs ──
  'turf.create': {
    roles: DESK_ROLES,
    input: z.object({
      name: z.string().trim().min(1).max(200),
      polygon: z.array(latlng).min(3).max(500),
      color: z.string().max(20).nullish(),
      notes: z.string().max(2000).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const id = newId();
      await tx.query(
        'insert into turfs (id, workspace_id, name, polygon, color, notes) values ($1, $2, $3, $4, $5, $6)',
        [id, ctx.workspaceId, input.name, JSON.stringify(input.polygon), input.color || null, input.notes || null],
      );
      emit('turf', id, 'create', input);
      return { turf: { id, ...input } };
    },
  },

  'turf.update': {
    roles: DESK_ROLES,
    input: z.object({
      id: uuid(),
      name: z.string().trim().min(1).max(200).nullish(),
      polygon: z.array(latlng).min(3).max(500).nullish(),
      color: z.string().max(20).nullish(),
      notes: z.string().max(2000).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query(
        `update turfs set name = coalesce($3, name), polygon = coalesce($4, polygon),
           color = coalesce($5, color), notes = coalesce($6, notes)
         where id = $1 and workspace_id = $2 and deleted_at is null`,
        [input.id, ctx.workspaceId, input.name || null, input.polygon ? JSON.stringify(input.polygon) : null,
         input.color || null, input.notes ?? null],
      );
      if (n.affectedRows === 0) throw httpError(404, 'turf not found');
      const { id, ...patch } = input;
      emit('turf', id, 'update', patch);
      return { id };
    },
  },

  'turf.delete': {
    roles: DESK_ROLES,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query(
        'update turfs set deleted_at = now() where id = $1 and workspace_id = $2 and deleted_at is null',
        [input.id, ctx.workspaceId],
      );
      if (n.affectedRows === 0) throw httpError(404, 'turf not found');
      emit('turf', input.id, 'void', {});
      return { id: input.id };
    },
  },

  // One person, or a whole team (ext/admin: everyone on it now).
  'turf.assign': {
    roles: DESK_ROLES,
    input: z.object({ turf_id: uuid(), user_id: uuid().optional(), team_id: uuid().optional() })
      .refine((v) => Boolean(v.user_id) !== Boolean(v.team_id), 'a person or a team'),
    handler: async (tx, ctx, input, emit) => {
      const turf = (await tx.query(
        'select id from turfs where id = $1 and workspace_id = $2 and deleted_at is null', [input.turf_id, ctx.workspaceId],
      )).rows[0];
      if (!turf) throw httpError(404, 'turf not found');
      let users = [];
      if (input.team_id) {
        const team = (await tx.query('select id from teams where id = $1 and workspace_id = $2 and deleted_at is null', [input.team_id, ctx.workspaceId])).rows[0];
        if (!team) throw httpError(404, 'team not found');
        users = (await tx.query('select user_id from team_members where team_id = $1', [team.id])).rows.map((r) => r.user_id);
        if (!users.length) throw httpError(400, 'nobody is on that team yet');
      } else {
        const member = (await tx.query(
          'select 1 from memberships where user_id = $1 and workspace_id = $2', [input.user_id, ctx.workspaceId],
        )).rows[0];
        if (!member) throw httpError(400, 'that person is not on the team — invite them first');
        users = [input.user_id];
      }
      let added = 0;
      for (const uid of users) {
        const n = await tx.query(
          `insert into turf_members (workspace_id, turf_id, user_id) values ($1, $2, $3) on conflict do nothing`,
          [ctx.workspaceId, input.turf_id, uid],
        );
        added += n.affectedRows;
      }
      emit('turf', input.turf_id, 'update', input.team_id ? { assigned_team: input.team_id, assigned: users } : { assigned: input.user_id });
      return { ...input, added };
    },
  },

  'turf.unassign': {
    roles: DESK_ROLES,
    input: z.object({ turf_id: uuid(), user_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      await tx.query(
        'delete from turf_members where turf_id = $1 and user_id = $2 and workspace_id = $3',
        [input.turf_id, input.user_id, ctx.workspaceId],
      );
      emit('turf', input.turf_id, 'update', { unassigned: input.user_id });
      return input;
    },
  },

  // ── Campaign events + RSVPs ──

};
