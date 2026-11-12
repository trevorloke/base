// Email that hears back — what the email sender (lib/mail: Resend or
// SendGrid) says after it takes an email, and the addresses the campaign
// must not email again.
//
//   sql.js       the sender's side of each email on blast_recipients; each
//                delivery event once (mail_events); email_suppressions
//   webhook.js   POST /hooks/mail/:provider (public, signed, each event once):
//                delivered, bounced, complained — a bounce or a complaint
//                puts the address on the suppression list
//   service.js   Email on Settings → Services (ext/connections): the row,
//                where delivery events go, and Check
//   domain.js    the "Sending domain" panel there: GET /api/mail/domain,
//                mail.domain.add, mail.domain.check (managers)
//
// Who can be emailed honours the list everywhere through one SQL fragment
// (lib/mail notSuppressed): a list's reach, the newsletter, a row at the
// moment it is sent, a ladder's email step.
// Keys only in the host's environment: RESEND_WEBHOOK_SECRET,
// SENDGRID_WEBHOOK_PUBLIC_KEY (lib/mail has each sender's own).
export { sql } from './sql.js';
export { publicRoutes } from './webhook.js';
export { api, actions } from './domain.js';

// SendGrid posts its events in batches that run to hundreds of kilobytes;
// Resend posts one event at a time, well inside the ordinary limit.
export const bodyMax = { '/hooks/mail/sendgrid': 1024 * 1024 };

// In the full export: the addresses not to email, and why.
export const exportTables = ['email_suppressions'];
