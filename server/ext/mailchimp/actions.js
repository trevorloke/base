// mailchimp.push     { list_id, everyone? }   desk: send a list to Mailchimp as a tag, or bring the tag into line again
//                                              (everyone: not only the newsletter's subscribers — the desk's one tick)
// mailchimp.pull     {}                        managers: "Pull now" — read who left and whose address died, now
// mailchimp.connect  {}                        managers: give Mailchimp the address unsubscribes come back to
// Mailchimp is only ever called before or after the write, never inside it;
// the slow work is a job (push.js, pull.js).
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { AudienceError, audienceId, mailchimpOn, MailchimpError } from './mailchimp.js';
import { PULL_JOB, queueDays } from './pull.js';
import { startSync } from './push.js';
import { connect } from './service.js';

const DESK = ['manager', 'treasurer', 'staff'];
const MANAGER = ['manager'];
// The job starts now rather than on the runner's next look.
const startNow = async (db, ctx, result) => { runJobsSoon(); return { result }; };

export const actions = {
  'mailchimp.push': {
    roles: DESK,
    area: 'people',
    input: z.object({ list_id: z.uuid(), everyone: z.boolean().optional() }),
    // Which audience is asked before the write (the account's only one, when none is named).
    before: async () => {
      if (!mailchimpOn()) throw httpError(409, 'Mailchimp isn’t connected here');
      try {
        return { audience: await audienceId() };
      } catch (e) {
        if (e instanceof MailchimpError) throw httpError(e instanceof AudienceError ? 409 : 502, e.message);
        throw e;
      }
    },
    handler: (tx, ctx, input, emit, ready) => startSync(tx, ctx, emit, { ...input, audience: ready.audience }),
    after: startNow,
  },

  'mailchimp.pull': {
    roles: MANAGER,
    input: z.object({}),
    handler: async (tx, ctx) => {
      if (!mailchimpOn()) throw httpError(409, 'Mailchimp isn’t connected here');
      await queueDays(tx, ctx.workspaceId);
      await enqueueJob(tx, { workspaceId: ctx.workspaceId, kind: PULL_JOB, payload: { full: true } });
      return { queued: true };
    },
    after: startNow,
  },

  'mailchimp.connect': {
    roles: MANAGER,
    input: z.object({}),
    before: (db, ctx) => connect(ctx.publicUrl),
    handler: async (tx, ctx, input, emit, ready) => {
      if (ready.ok) await queueDays(tx, ctx.workspaceId);
      // Never the address on the log (it ends in the key's own), never the secret.
      if (ready.made) emit('mailchimp', ctx.workspaceId, 'update', { webhook: 'connected' });
      return { ok: ready.ok, said: ready.said, ...(ready.secret ? { secret: ready.secret } : {}) };
    },
  },
};
