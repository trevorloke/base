// Gmail: one email, written by one staff member, to one person, from their
// own Gmail — and Email as a way someone was reached, logged by hand. One
// purpose on GSI's Google connection (lib/google/, ext/google): no OAuth
// route, token table, key or revoke of its own. Campaign mail (newsletters,
// lists, releases) stays on Resend or SendGrid (lib/mail).
//
//   sql.js       contacts may be reached by 'email'; gmail_sends
//   actions.js   gmail.send · gmail.test · gmail.settings
//   send.js      the message, the call through googleFetch, Gmail's answers
//                in plain words, the gmail.settle job
//   api.js       GET /api/gmail
//   service.js   the Services row "Gmail (send as yourself)"
import { definePurpose } from '../../lib/google/purposes.js';
import { settleJob } from './send.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
definePurpose('gmail.send', {
  label: 'Send from your Gmail',
  scopes: [GMAIL_SCOPE],
  roles: ['manager', 'treasurer', 'staff'],
  area: 'outreach',
  // Gmail follows the campaign's Google domain rule (GSI's; no rule of its own).
  domain: (s) => s.google?.domain || null,
});

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export const jobs = { 'gmail.settle': settleJob };
export const deskOnlyReads = [/^\/api\/gmail(\/|$)/];
export const exportTables = ['gmail_sends'];
