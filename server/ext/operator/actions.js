// The campaign's consent: "base.win may sign in here" (Settings → Members).
//
//   workspace.operatorEntry { on }   managers: on (the default — a missing
//                                    setting is on) or off. Off also ends
//                                    any visit in progress, in the same
//                                    write. Never from a visit itself
//                                    (OPERATOR_DENIED), and never on the
//                                    demo, whose visitors are strangers.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { demoEmail } from '../../lib/demo.js';

const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

export const actions = {
  'workspace.operatorEntry': {
    roles: ['manager'],
    input: z.object({ on: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      if (demoEmail()) throw httpError(409, 'The demo can’t change this.');
      const cur = (await tx.query('select settings from workspaces where id = $1', [ctx.workspaceId])).rows[0];
      const settings = parseJ(cur.settings, {});
      settings.operatorEntry = input.on;
      await tx.query('update workspaces set settings = $2 where id = $1', [ctx.workspaceId, JSON.stringify(settings)]);
      if (input.on) {
        emit('workspace', ctx.workspaceId, 'update', { operator_entry: true });
        return { on: true };
      }
      const ended = (await tx.query(
        'delete from sessions where workspace_id = $1 and entry is not null returning 1', [ctx.workspaceId],
      )).rows.length;
      emit('workspace', ctx.workspaceId, 'update', { operator_entry: false, ended });
      return { on: false, ended };
    },
  },
};
