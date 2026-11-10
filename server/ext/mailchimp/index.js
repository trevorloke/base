// Mailchimp — for a campaign that already builds its emails there. The
// audience is still chosen in base.win: a list is sent to Mailchimp as a tag
// of the audience, and a no in either place is a no in both.
// INTEGRATIONS.md ("Mailchimp") says how to set it up, and what could not
// be confirmed against Mailchimp's own documentation.
//
//   mailchimp.js  settings, Mailchimp over plain fetch, the address its
//                 webhook calls (its last part made from the API key)
//   push.js       mailchimp.push (the tap) and its job: new addresses join
//                 the audience (never changing anyone already there), the tag
//                 is brought into line; only email, first and last name go
//   pull.js       Mailchimp → here: unsubscribed turns email off, cleaned
//                 suppresses the address; the daily job, Pull now, and the
//                 one address a webhook was about
//   optout.js     here → Mailchimp: an unsubscribe, a do-not-email tag or a
//                 dead address here unsubscribes the member there (an events
//                 hook queues the job); nobody is ever put back
//   webhook.js    POST /hooks/mailchimp/<key> (public; also allowed on the
//                 campaign's website domain — ext/site/public.js): a hint
//   api.js        GET /api/lists/:id/mailchimp (desk), GET /api/mailchimp (managers)
//   actions.js    mailchimp.push · mailchimp.pull · mailchimp.connect
//   service.js    the row on Settings → Services: Check, and Connect
//
// Keys only in the host's environment: MAILCHIMP_API_KEY,
// MAILCHIMP_AUDIENCE_ID, MAILCHIMP_WEBHOOK_SECRET.
import { registerIntegration } from '../integrations/index.js';
import { mailchimpOn } from './mailchimp.js';
import { onEvents, runOptoutJob } from './optout.js';
import { MEMBER_JOB, OPTOUT_JOB, PULL_JOB, runMemberJob, runPullJob } from './pull.js';
import { SYNC_JOB, runSyncJob } from './push.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './webhook.js';

export const jobs = { [SYNC_JOB]: runSyncJob, [PULL_JOB]: runPullJob, [MEMBER_JOB]: runMemberJob, [OPTOUT_JOB]: runOptoutJob };
export const hooks = { events: onEvents };
// In the full export: which lists went to which tag, and how far consent is in step.
export const exportTables = ['mailchimp_syncs', 'mailchimp_state'];
export const deskOnlyReads = ['/mailchimp'];

// The desk's "is Mailchimp on?" (GET /api/integrations): a list's page
// offers "Send to Mailchimp" only then.
registerIntegration('mailchimp', mailchimpOn);
