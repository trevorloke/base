// Email on Settings → Services (ext/connections lists it): the row's name
// follows the sender in use (lib/mail), with the settings that sender needs,
// where its delivery events go (the webhook address to paste at the sender
// and the events to tick), and Check — reads only, never a send:
//   the key works · MAIL_FROM's domain is verified at the sender · the domain
//   has a DMARC record (base.win's own lookup) · bounces and complaints come
//   back here. Each shortfall is one sentence saying what to do.
import { activeProvider, chosenProvider, hookOn, mailFrom, providerByKey } from '../../lib/mail/index.js';
import { dmarcOf } from '../../lib/mail/dns.js';

const FOR = 'Invites, newsletters, press releases, ladder emails, shift alerts, donation receipts';
const env = (k) => String(process.env[k] || '').trim();
const has = (k) => Boolean(env(k));
// A sender base.win doesn't know (MAIL_PROVIDER mistyped): said, never guessed.
const unknown = () => `MAIL_PROVIDER is “${env('MAIL_PROVIDER')}”`;

// Where the sender posts its delivery events. No secret in it: the
// signature is the lock (ext/mail/webhook.js).
export const hookUrl = (base, p) => `${String(base || '').replace(/\/+$/, '')}/hooks/mail/${p.key}`;

export const emailService = (base) => {
  const p = chosenProvider();
  const row = { key: 'email', for: FOR, launch: true, checkable: true };
  if (!p) {
    return { ...row, name: 'Email', missing: ['MAIL_PROVIDER'], set: [], state: 'missing', detail: `${unknown()}: set it to resend or sendgrid, or take it away` };
  }
  const missing = p.needs.filter((k) => !has(k));
  return {
    ...row,
    name: `Email (${p.name})`,
    missing,
    set: p.needs.filter(has),
    state: missing.length ? 'missing' : 'ready',
    detail: has('MAIL_FROM') ? `From ${env('MAIL_FROM')}` : p.noFrom,
    // Once it can send: where its delivery events go, and its domain's records.
    // `hook`, not `webhook` (the name Stripe's row uses for the same block):
    // a page cached from before this row had one prints Stripe's own sentence
    // over whatever comes as `webhook`. Under another name it shows nothing.
    ...(activeProvider() === p ? {
      hook: { url: hookUrl(base, p), events: p.hook.events, where: p.hook.where, ...(hookOn(p) ? {} : { note: p.hook.secret }) },
      domainPanel: true,
    } : {}),
  };
};

// "Coming in" (Settings → Services): the address the sender calls.
export const emailInbound = (base) => {
  const p = chosenProvider() || providerByKey('resend');
  return { name: `${p.name} — delivered, bounced, spam complaints`, url: hookUrl(base, p), how: `Set by hand: ${p.hook.where}, with the events under Email (above)` };
};

export const checkEmail = async (db, base) => {
  const p = chosenProvider();
  if (!p) return { ok: false, said: `${unknown()}: base.win knows resend and sendgrid` };
  if (!has(p.needs[0])) return { ok: false, said: `${p.needs[0]} isn’t set` };
  const { domain } = mailFrom();
  // SendGrid's webhook settings can't be read: an event that came in is the proof.
  const eventsSeen = (await db.query('select 1 from mail_events where provider = $1 limit 1', [p.key])).rows.length > 0;
  const [res, dmarc] = await Promise.all([p.check({ domain, hookUrl: hookUrl(base, p), eventsSeen }), domain ? dmarcOf(domain) : null]);
  // The key or the domain isn't right yet: that comes first, alone.
  if (!res.verified) return { ok: res.ok, said: res.said };
  const good = [];
  const todo = [];
  if (dmarc?.found) good.push('DMARC is in');
  else if (dmarc?.found === false) todo.push('There’s no DMARC record yet: add the one under Sending domain.');
  if (res.hook) todo.push(res.hook);
  else if (res.hookKnown) good.push('bounces and complaints come back here');
  // The lookup itself failed: not known, so not counted against it.
  if (dmarc && dmarc.found === null) todo.push('DMARC couldn’t be looked up just now.');
  return {
    ok: res.ok && !(dmarc?.found === false) && !res.hook,
    said: todo.length ? `${res.said}. ${todo.join(' ')}` : [res.said, ...good].join(' · '),
  };
};
