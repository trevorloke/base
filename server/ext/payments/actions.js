// payment.ack — a treasurer's "Got it" on an online payment that needed
// them (refunded over the limit, refunded or partly refunded in Stripe, a
// lost dispute, a donor whose record was gone). It leaves Needs you; the
// payment and its history stay.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { MONEY_ROLES } from './api.js';

export const actions = {
  'payment.ack': {
    roles: MONEY_ROLES,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, { id }, emit) => {
      const r = (await tx.query(
        `update stripe_payments set acknowledged_at = now(), acknowledged_by = $3, updated_at = now()
          where id = $1 and workspace_id = $2 and acknowledged_at is null returning id, status`,
        [id, ctx.workspaceId, ctx.user?.id || null],
      )).rows[0];
      if (!r) {
        const had = (await tx.query('select 1 from stripe_payments where id = $1 and workspace_id = $2', [id, ctx.workspaceId])).rows[0];
        if (!had) throw httpError(404, 'payment not found');
        return { id, already: true };
      }
      emit('payment', id, 'update', { acknowledged: true, status: r.status });
      return { id };
    },
  },
};
