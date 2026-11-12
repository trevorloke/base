// Email senders — one small file each (resend.js, sendgrid.js), and here the
// one in use. lib/notify.js exports sendEmail and emailConfigured from here,
// so nothing that sends email knows which sender it is.
//
//   MAIL_PROVIDER   resend | sendgrid. Unset: whichever has its key, Resend
//                   first — a deployment with only RESEND_API_KEY is as it
//                   always was. A sender that is named but not set up is
//                   never quietly swapped for the other one.
//
// What each sender file says about itself:
//   key, name          'sendgrid', 'SendGrid'
//   needs              its settings, the key first (Settings → Services
//                      names what is missing); hookNeeds: what its delivery
//                      events need
//   idempotent         true: a repeat with the same key is never a second copy
//   ready()            can send now
//   send(msg)          one email; never throws
//                      msg: { from, to, subject, text, html?, headers?,
//                             attachments?, idempotencyKey?, ref? }
//                      ref: base.win's own id for this email — it is sent
//                      along so it comes back on every delivery event
//                      → { sent, status: 'sent' | 'failed', id?, detail?, unknown? }
//   verify(raw, headers) · parse(raw, headers)
//                      a delivery event's signature over the exact bytes,
//                      and the events in base.win's kinds (ext/mail/webhook.js)
//   domain.get/add/check(name)   the sender's domain and its DNS records
//   check({ domain, hookUrl, eventsSeen })   Settings → Services' Check
//   hook               { events, where, secret }: what to set at the sender
import resend from './resend.js';
import sendgrid from './sendgrid.js';
import { env, has, mailFrom, noAnswer, parseFrom } from './common.js';

export { mailFrom, parseFrom } from './common.js';

const ORDER = [resend, sendgrid];
export const providerByKey = (key) => ORDER.find((p) => p.key === key) || null;
const named = () => env('MAIL_PROVIDER').toLowerCase();
// Each sender's first setting is its key.
const keyed = (p) => has(p.needs[0]);

// The sender Settings → Services names: the one MAIL_PROVIDER says (null
// when base.win doesn't know that name), else the one with a key, else Resend.
export const chosenProvider = () => (named() ? providerByKey(named()) : ORDER.find(keyed) || resend);
// The sender in use, or null: nothing can be sent.
export const activeProvider = () => {
  const p = chosenProvider();
  return p && p.ready() ? p : null;
};
export const emailConfigured = () => !!activeProvider();
// Whether a sender's delivery events can be checked (its signing setting is there).
export const hookOn = (p) => !!p && p.hookNeeds.every(has);

// The words when email isn't connected (the Email screen keys on them).
export const NO_PROVIDER = 'no email provider configured (set RESEND_API_KEY)';

// `html` is optional: sent alongside the plain-text part when given.
// `idempotencyKey` is optional: Resend sends a key it has seen in the last
// day only once, so a retry after an unknown outcome never doubles up (a
// sender without one says so: idempotent false).
// `ref` is optional: base.win's own id for this email (a blast's recipient
// row); it comes back on the sender's delivery events.
// `headers` is optional: extra mail headers (List-Unsubscribe and
// List-Unsubscribe-Post on newsletters and ladder emails). `attachments`:
// [{ filename, content (base64), content_type? }].
// `from` is optional: a From as typed ('"Name" <addr>'), one of the
// campaign's From addresses (ext/senders) a send recorded; absent, MAIL_FROM.
// → { sent, status: 'sent' | 'failed' | 'queued', provider?, id?, detail?, unknown? }
//   'queued': no sender is set up — nothing was sent and nothing sends by
//   itself. unknown: the sender never answered — it may or may not have
//   sent it. id: the sender's own id for the email.
export const sendEmail = async ({ from, to, subject, text, html, idempotencyKey, headers, attachments, ref }) => {
  const p = activeProvider();
  if (!p) return { sent: false, status: 'queued', detail: NO_PROVIDER };
  let res;
  try {
    res = await p.send({ from: from ? parseFrom(from) : mailFrom(), to, subject, text, html, idempotencyKey, headers, attachments, ref });
  } catch (e) {
    res = noAnswer(e);
  }
  return { ...res, provider: p.key };
};

// "This address is not on the campaign's suppression list" — SQL, for every
// place that decides who can be emailed: a list's reach (ext/lists), the
// newsletter's and the press list's audience, a row at the moment it is
// sent (ext/abtests), a ladder's email step. The list is email_suppressions
// (ext/mail): an address that bounced for good or reported spam, until the
// desk lifts it. `ws` and `email` are SQL expressions naming the row being
// decided — a $n, or a column WITH its table's alias (s.email): a bare
// "email" in here would be the suppression's own.
export const notSuppressed = (ws, email) => `not exists (select 1 from email_suppressions sup
  where sup.workspace_id = ${ws} and sup.email = lower(trim(${email})) and sup.lifted_at is null)`;
