// CallHub — a dialer for a room of callers. The campaign keeps choosing who
// to call in base.win: a list or a phone bank is sent to a CallHub
// phonebook, and every call's result comes back onto the person.
// INTEGRATIONS.md ("Phone dialer — CallHub") says how to set it up, and
// what could not be confirmed against CallHub's own documentation.
//
//   callhub.js   settings, CallHub over plain fetch, the address results
//                come back to (its last part made from the API key)
//   people.js    who goes: a dialable number, never do-not-contact or
//                do-not-call, one contact per number; the campaign's own
//                do-not-call list as numbers
//   push.js      callhub.push (the tap) and its job: the phonebook, the
//                do-not-call numbers, then a contact a second within
//                CallHub's daily limit; waits and resumes by itself
//   dnc.js       the campaign's do-not-call numbers at CallHub: with each
//                push, and when someone is newly marked (an events hook
//                queues the callhub.dnc job)
//   results.js   a delivery read every way it may come; the result →
//                outcome table; one phone contact per result, once; a
//                rating only from a survey answer the desk mapped; a change
//                to the table moves what is already in, and can be put back
//   webhook.js   POST /hooks/callhub/<key> (public; also allowed on the
//                campaign's website domain — ext/site/public.js)
//   api.js       GET /api/callhub/preview, /api/callhub/pushes (desk)
//   actions.js   callhub.push · callhub.resume · callhub.map · callhub.connect
//   service.js   the row on Settings → Services: Check, and Connect
//
// Only the phone, first and last name and city leave base.win — never a
// rating, a tag or a note. Keys only in the host's environment:
// CALLHUB_API_KEY, CALLHUB_API_BASE.
import { registerIntegration } from '../integrations/index.js';
import { callhubOn } from './callhub.js';
import { DNC_JOB, onEvents, runDncJob } from './dnc.js';
import { PUSH_JOB, runPushJob } from './push.js';
import { onMerging, REFILE_JOB, runRefileJob } from './results.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes } from './webhook.js';

export const jobs = { [PUSH_JOB]: runPushJob, [DNC_JOB]: runDncJob, [REFILE_JOB]: runRefileJob };
// personMerging: two records made one keep each call's hold on a tag (results.js).
export const hooks = { events: onEvents, personMerging: onMerging };
// In the full export: what was sent where, and every result as it came.
export const exportTables = ['callhub_pushes', 'callhub_contacts', 'callhub_dnc', 'callhub_results'];
export const deskOnlyReads = [/^\/api\/callhub(\/|$)/];

// The desk's "is CallHub on?" (GET /api/integrations): a list's and a phone
// bank's page offer "Send to CallHub" only then.
registerIntegration('callhub', callhubOn);
