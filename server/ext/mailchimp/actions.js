// mailchimp.push     { list_id, everyone?, agree?, shown? }  desk: send a list to Mailchimp as a tag, or bring the tag into line again
//                                                             (everyone: not only the newsletter's subscribers — the desk's one tick)
// mailchimp.pull     { agree?, shown? }                      managers: "Pull now" — read who left and whose address died, now
// mailchimp.connect  {}                                      managers: give Mailchimp the address unsubscribes come back to
// The first pull from an audience waits for a person's yes (pull.js,
// firstOf): until then Pull now and Send only count what it would turn off
// here, and say so (Send counts afresh each time). `agree` (the audience's
// id, as the question showed it) with `shown` (its numbers) is the yes —
// refused when the count has changed since. Connect starts the count, so the
// question is there as soon as it is connected.
// Mailchimp is only ever called before or after the write, never inside it;
// the slow work is a job (push.js, pull.js).
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { AudienceError, audienceId, mailchimpOn, MailchimpError } from './mailchimp.js';
import { firstOf, PULL_JOB, queueDays, sayYes } from './pull.js';
import { startSync } from './push.js';
import { connect } from './service.js';

const DESK = ['manager', 'treasurer', 'staff'];
const MANAGER = ['manager'];
const AGREE = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional();
const COUNT = z.number().int().min(0).max(100_000_000);
const SHOWN = z.object({ unsubscribed: COUNT, cleaned: COUNT }).optional();
// The job starts now rather than on the runner's next look.
const startNow = async (db, ctx, result) => { runJobsSoon(); return { result }; };
// Which audience, asked before the write (the account's only one, when none
// is named) — and a yes is only ever for the one in use.
const audienceFor = async (agree) => {
  if (!mailchimpOn()) throw httpError(409, 'Mailchimp isn’t connected here');
  let audience;
  try {
    audience = await audienceId();
  } catch (e) {
    if (e instanceof MailchimpError) throw httpError(e instanceof AudienceError ? 409 : 502, e.message);
    throw e;
  }
  if (agree && agree !== audience) throw httpError(409, 'Mailchimp’s audience has changed since — look again');
  return audience;
};

export const actions = {
  'mailchimp.push': {
    roles: DESK,
    area: 'people',
    input: z.object({ list_id: z.uuid(), everyone: z.boolean().optional(), agree: AGREE, shown: SHOWN }),
    before: async (db, ctx, input) => {
      // The desk only, as for downloading the list: a volunteer granted People
      // works in that area (the area's deny still stops staff), but never sends
      // the campaign's addresses out of it.
      if (!DESK.includes(ctx.role)) throw httpError(403, `role '${ctx.role}' may not perform mailchimp.push`);
      return { audience: await audienceFor(input.agree) };
    },
    handler: (tx, ctx, input, emit, ready) => startSync(tx, ctx, emit, { ...input, audience: ready.audience }),
    after: startNow,
  },

  'mailchimp.pull': {
    roles: MANAGER,
    input: z.object({ agree: AGREE, shown: SHOWN }),
    before: async (db, ctx, input) => (input.agree ? { audience: await audienceFor(input.agree) } : {}),
    handler: async (tx, ctx, input, emit, ready) => {
      if (!mailchimpOn()) throw httpError(409, 'Mailchimp isn’t connected here');
      if (input.agree) await sayYes(tx, emit, ctx.workspaceId, ready.audience, input.shown);
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
      if (ready.ok) {
        await queueDays(tx, ctx.workspaceId);
        // The first pull from this audience asks first: what it would turn
        // off here is counted now, so the question is there at once.
        const first = ready.audience ? await firstOf(tx, ctx.workspaceId, ready.audience) : null;
        if (first && !first.counting) await enqueueJob(tx, { workspaceId: ctx.workspaceId, kind: PULL_JOB, payload: { full: true } });
      }
      // Never the address on the log (it ends in the key's own), never the secret.
      if (ready.made) emit('mailchimp', ctx.workspaceId, 'update', { webhook: 'connected' });
      return { ok: ready.ok, said: ready.said, ...(ready.secret ? { secret: ready.secret } : {}) };
    },
    after: startNow,
  },
};
