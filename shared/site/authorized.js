// "Authorized by …": one rule for every channel base.win sends or draws.
//
// The one source is the website's own settings (Website → Settings): the
// financial agent's name and how to reach them (org.agentName,
// org.agentContact), else the line as it was typed before they were asked
// for (org.authorizationLine, English only), plus the translations a
// manager approved (site_legal_words, key authorizedBy, only while it is of
// the running code's English). While those boxes are empty nothing shows
// anywhere and nothing is held.
//
// CHANNELS says, for every way base.win reaches people, whether the line
// goes on it. The kind is our working classification, not legal advice:
// the owner or a lawyer can re-class any row. Every row an owner or a
// lawyer is asked about carries owner: true (the owner's list in
// docs/AUTHORIZED.md is these rows). The structural tests
// (server/test/authorized-channels.test.js) hold every sender and every
// page drawer in the code to a row here: `senders` are the files that send
// a message or draw a public page for that row, `hooks` the files that ask
// this rule for the line, and `via`, for a sender that is not a hook, the
// hook its words go through (it imports that hook, or is drawn by it).
//
// Pure: no database. The website's renderer (browser and server) and the
// server both import it. One way only: this file reads wording.js
// (LEGAL_ENGLISH), never the reverse; wording.js keeps its own
// authorizedBy(), and a test proves the two say the same.
import { LEGAL_ENGLISH, fillSlots } from './wording.js';
import { digestWords, tidy } from './legal-words.js';

export const KINDS = ['advertising', 'unclear', 'transactional', 'internal', 'outside'];
export const INCLUDES = ['when-set', 'first-text', 'never', 'copy'];
export const FORMS = ['html-footer', 'email-footer', 'sms', 'ics', 'share-text', 'meta', 'copy'];

// The delivery code itself (it hands a message to the provider and knows
// nothing of what is in it): every file that calls it is in a row below.
export const DELIVERY = ['server/lib/notify.js', 'server/lib/mail/index.js', 'server/ext/texting/twilio.js'];

const row = (r) => Object.freeze({ owner: false, senders: [], hooks: [], ...r });
export const CHANNELS = Object.freeze({
  site: row({
    what: 'Every page of the website, the main site and the other websites',
    kind: 'advertising', include: 'when-set', form: 'html-footer',
    senders: ['server/ext/site/render/index.js', 'server/ext/site/public.js'],
    hooks: ['shared/site/components/shell.js', 'shared/site/components/context.js'],
    via: {
      'server/ext/site/render/index.js': 'shared/site/components/context.js',
      'server/ext/site/public.js': 'shared/site/components/context.js',
    },
  }),
  'site-plain-public': row({
    what: 'The plain public pages: coming soon, a closed website',
    kind: 'advertising', include: 'when-set', form: 'html-footer',
    senders: ['server/ext/site/public.js'],
    hooks: ['server/ext/site/public.js'],
  }),
  'site-plain-own': row({
    what: 'A supporter’s own pages: email preferences, unsubscribe, a link that expired',
    kind: 'unclear', owner: true, include: 'when-set', form: 'html-footer',
    senders: ['server/ext/site/public.js'],
    hooks: ['server/ext/site/public.js'],
  }),
  embed: row({
    what: 'The voter guide in another website’s frame',
    kind: 'advertising', include: 'when-set', form: 'html-footer',
    senders: ['shared/site/components/voteguide.js', 'shared/site/components/templates.js'],
    hooks: ['shared/site/components/voteguide.js'],
    via: { 'shared/site/components/templates.js': 'shared/site/components/voteguide.js' },
  }),
  ics: row({
    what: 'Calendar files: events.ics and one event’s .ics',
    kind: 'unclear', owner: true, include: 'when-set', form: 'ics',
    senders: ['server/ext/site/calendar.js'],
    hooks: ['server/ext/site/calendar.js'],
  }),
  'share-card': row({
    what: 'A page’s link preview (the card drawn when a link is pasted)',
    kind: 'unclear', owner: true, include: 'when-set', form: 'meta',
    senders: ['server/ext/site/render/index.js'],
    hooks: ['server/ext/site/render/index.js'],
  }),
  'share-sheet': row({
    what: 'A supporter’s “I signed …” share words',
    kind: 'unclear', owner: true, include: 'when-set', form: 'share-text',
    senders: ['shared/site/components/share.js', 'shared/site/components/form.js', 'shared/site/components/islands.js'],
    hooks: ['shared/site/components/modules.js', 'shared/site/components/templates.js'],
    via: {
      'shared/site/components/share.js': 'shared/site/components/modules.js',
      'shared/site/components/form.js': 'shared/site/components/modules.js',
      'shared/site/components/islands.js': 'shared/site/components/modules.js',
    },
  }),
  'share-kit': row({
    what: 'Share kits: the campaign’s posts for staff and volunteers to share',
    kind: 'advertising', owner: true, include: 'when-set', form: 'share-text',
    note: 'Each kit’s own tick box is no longer offered; its saved choice is kept, never overwritten.',
    hooks: ['server/ext/socials/share.js', 'server/ext/socials/share-api.js'],
  }),
  'email-list': row({
    what: 'Newsletters, email blasts, an A/B test and the rest that goes to its winner',
    kind: 'advertising', include: 'when-set', form: 'email-footer',
    senders: ['server/ext/abtests/send.js', 'server/ext/abtests/winner.js'],
    hooks: ['server/ext/abtests/send.js', 'server/ext/abtests/winner.js'],
  }),
  'email-press': row({
    what: 'Press releases to the media list',
    kind: 'unclear', owner: true, include: 'when-set', form: 'email-footer',
    note: 'Press releases have carried the line since before this rule.',
    senders: ['server/ext/abtests/send.js'],
    hooks: ['server/ext/abtests/send.js'],
  }),
  'email-test': row({
    what: 'A test copy to the person writing the email',
    kind: 'internal', preview: true, include: 'when-set', form: 'email-footer',
    senders: ['server/actions/field.js'],
    hooks: ['server/actions/field.js'],
  }),
  'email-ladder': row({
    what: 'Automatic follow-up emails (ladders)',
    kind: 'advertising', include: 'when-set', form: 'email-footer',
    senders: ['server/ext/ladders/engine.js'],
    hooks: ['server/ext/ladders/engine.js'],
  }),
  'sms-list': row({
    what: 'Text blasts to a list',
    kind: 'advertising', include: 'when-set', form: 'sms',
    senders: ['server/ext/texting/blast.js', 'server/ext/abtests/send.js'],
    hooks: ['server/ext/texting/blast.js'],
    via: { 'server/ext/abtests/send.js': 'server/ext/texting/blast.js' },
  }),
  'sms-ladder': row({
    what: 'Automatic follow-up texts (ladders)',
    kind: 'advertising', include: 'when-set', form: 'sms',
    senders: ['server/ext/ladders/engine.js'],
    hooks: ['server/ext/ladders/engine.js'],
  }),
  'sms-one': row({
    what: 'Texts one person sends from the Inbox or the Calls card (the first text only)',
    kind: 'unclear', owner: true, include: 'first-text', form: 'sms',
    senders: ['server/ext/texting/actions.js'],
    hooks: ['server/ext/texting/actions.js'],
  }),
  'email-one': row({
    what: 'A staffer’s own Gmail sent through base.win (as a signature line)',
    kind: 'unclear', owner: true, include: 'when-set', form: 'email-footer',
    senders: ['server/ext/gmail/send.js'],
    hooks: ['server/ext/gmail/actions.js'],
    via: { 'server/ext/gmail/send.js': 'server/ext/gmail/actions.js' },
  }),
  mailchimp: row({
    what: 'Emails built inside Mailchimp',
    kind: 'outside', include: 'copy', form: 'copy',
    hooks: ['web/src/components/SendToMailchimp.jsx', 'web/src/pages/WebsiteSettings.jsx'],
  }),
  ads: row({
    what: 'Paid ads on the ad platforms',
    kind: 'outside', include: 'copy', form: 'copy',
    hooks: ['web/src/pages/WebsiteSettings.jsx'],
  }),
  print: row({
    what: 'Flyers, signs and door hangers printed elsewhere',
    kind: 'outside', include: 'copy', form: 'copy',
    hooks: ['web/src/pages/WebsiteSettings.jsx'],
  }),
  letters: row({
    what: 'Letters to the editor (the writer sends them)',
    kind: 'outside', owner: true, include: 'never', form: null,
  }),
  calls: row({
    what: 'Live calls (the Twilio bridge, CallHub)',
    kind: 'outside', include: 'never', form: null,
  }),
  shift: row({
    what: 'Shift notices and reminders',
    kind: 'transactional', include: 'never', form: null,
    senders: ['server/actions/field.js', 'server/ext/schedule/tell.js'],
  }),
  receipts: row({
    what: 'Receipts and refunds',
    kind: 'transactional', include: 'never', form: null,
    senders: ['server/ext/receipts/core.js', 'server/ext/receipts/engine.js', 'server/ext/payments/refunds.js'],
  }),
  account: row({
    what: 'Invites, passwords, two-step sign-in, the calendar-feed link, replies about a letter',
    kind: 'internal', include: 'never', form: null,
    senders: [
      'server/actions/field.js', 'server/ext/candidates/actions.js', 'server/ext/passwords/reset.js',
      'server/ext/twostep/locked.js', 'server/ext/calendar/index.js', 'server/ext/letters/actions.js',
    ],
  }),
  office: row({
    what: 'Walk lists, quick reports, exports, ladder webhooks',
    kind: 'internal', include: 'never', form: null,
  }),
});
export const CHANNEL_IDS = Object.keys(CHANNELS);
// The rows an owner or a lawyer is asked about.
export const OWNER_ROWS = CHANNEL_IDS.filter((id) => CHANNELS[id].owner);

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
// The fields the rule reads, by any of the names a caller has them under.
const fieldsOf = (org) => {
  const o = org && typeof org === 'object' ? org : {};
  return {
    name: clean(o.agentName ?? o.agent_name),
    contact: clean(o.agentContact ?? o.agent_contact),
    line: clean(o.authorizationLine ?? o.authorization ?? o.authorized_by),
    from: clean(o.authorizedFrom ?? o.authorized_from),
  };
};

// The one test for "is it set": 'set' (a name and a way to reach them),
// 'partial' (a name only, or only the line as typed before), 'empty'.
export const authorizedSet = (org) => {
  const f = fieldsOf(org);
  if (f.name && f.contact) return 'set';
  if (f.name || f.line) return 'partial';
  return 'empty';
};

// A financial agent is named: what a translated line needs (a language is
// offered on the website only then).
export const agentNamed = (org) => Boolean(fieldsOf(org).name);

// The English: the template's words filled, else the old free line, else ''.
const englishOf = (f) => (f.name ? tidy(fillSlots(LEGAL_ENGLISH.authorizedBy, { agent: f.name, contact: f.contact })) : f.line);

// "YYYY-MM-DD" today in the campaign's time zone.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v) => {
  if (!DAY.test(String(v ?? ''))) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const today = (now, tz) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
};
// The "needed from" date (org.authorizedFrom, campaign time): how loudly a
// missing line is shown. Empty: never. level 'soon' within 14 days of it,
// 'due' on and after it; daysLeft counts whole days from today.
export const SOON_DAYS = 14;
export const neededFrom = (org, now = new Date(), tz = 'America/Vancouver') => {
  const from = fieldsOf(org).from;
  if (!isDay(from)) return { from: null, required: false, daysLeft: null, level: null };
  const daysLeft = Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${today(now, tz)}T00:00:00Z`)) / 86_400_000);
  const level = daysLeft <= 0 ? 'due' : daysLeft <= SOON_DAYS ? 'soon' : null;
  return { from, required: level === 'due', daysLeft, level };
};

// The one answer.
//   org     site_settings.org (any of the names: agentName or agent_name, …)
//   channel a CHANNELS key; an unknown one throws, so a typo can't skip it
//   lang    the page's or message's language; legal: { [lang]: digest }
//           (legal-words.js digestOf), only that language's is read
//   slots   more slot values for the translation (the agent's are filled here)
//   tz      the campaign's time zone, for the "needed from" date
// → { include, en, local, status, required, warn, form, channel }
//   warn: null | { level: 'soon' | 'due', gap: 'missing' | 'partial', from }
export function authorizedLine(org, { channel, lang = 'en', legal = {}, slots = null, now = new Date(), tz = 'America/Vancouver' } = {}) {
  const c = Object.hasOwn(CHANNELS, String(channel)) ? CHANNELS[channel] : null;
  if (!c) throw new Error(`authorizedLine: unknown channel '${channel}' (shared/site/authorized.js CHANNELS)`);
  const f = fieldsOf(org);
  const en = englishOf(f);
  const status = authorizedSet(org);
  const include = (c.include === 'when-set' || c.include === 'first-text') && en !== '';
  let local = null;
  if (include && lang && lang !== 'en' && f.name) {
    const w = digestWords(legal?.[lang], lang, 'authorizedBy', { ...(slots || {}), agent: f.name, contact: f.contact });
    if (w.lang === lang && w.text) local = { text: w.text, lang };
  }
  const need = neededFrom(org, now, tz);
  const gap = status === 'empty' ? 'missing' : status === 'partial' ? 'partial' : null;
  const warn = need.level && gap ? { level: need.level, gap, from: need.from } : null;
  return { channel, include, en: include ? en : (c.include === 'copy' ? en : ''), local, status, required: need.required, warn, form: c.form };
}

// A send after the "needed from" date with no line at all asks first (the
// desk's "Send without it"); a partial line only warns.
export const needsConfirm = (a) => Boolean(a?.warn && a.warn.level === 'due' && a.warn.gap === 'missing');

// Ready-made shapes, so no channel formats its own.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// The words: the English, then the approved translation on its own line.
export const authorizedText = (a) => (a?.include ? [a.en, a.local?.text].filter(Boolean).join('\n') : '');
// The HTML: one <p> for the English (lang="en" when the page is another
// language's or a translation follows) and one for the translation.
export const authorizedHtml = (a, { cls = 'footer-authorization', pageLang = 'en' } = {}) => {
  if (!a?.include) return '';
  const enLang = pageLang !== 'en' || a.local ? ' lang="en"' : '';
  return `<p class="${esc(cls)}"${enLang}>${esc(a.en)}</p>${a.local ? `<p class="${esc(cls)}" lang="${esc(a.local.lang)}">${esc(a.local.text)}</p>` : ''}`;
};
// A text's line(s), each on its own line: "\n<English>[\n<translation>]".
export const authorizedSms = (a) => (a?.include ? `\n${authorizedText(a)}` : '');
