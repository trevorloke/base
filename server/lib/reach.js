// Who may be emailed, texted or called — the one place that decides.
//
// Every send asks here: an email or a text to a list, the newsletter, a
// press release, a ladder's steps, a shift's text, a phone bank — and so do
// a list's own numbers (can be emailed · texted · called). README.md says
// the same in words ("Who may be emailed, texted or called").
//
// Each channel is a list of reasons NOT to, in the order they are checked.
// A reason holds for every sender on its channel unless it says otherwise
// (only / skip): the senders do differ today — an email to a list goes to
// everyone on it who hasn't said no, the newsletter and a ladder only to
// subscribers — and whether that should change is the campaign's call (and
// its counsel's), not the code's. A new reason (an address that bounced, a
// do-not-call tag) is one more line in its channel.
//
//   senders   email: list · newsletter · press · ladder · shift (a shift's
//                    notice, reminder or Notify, to someone booked on it) ·
//                    self (a link someone asked for, to their own address)
//             text:  list · ladder · shift (a shift's notice or reminder)
//             call:  bank (and the Call links: shared/canvass.js noCalls)
//   mayReach(channel, sender, cols)  SQL, true for someone the sender may
//                                    reach: for a WHERE, a FILTER, a column
//   whyNot(q, channel, sender, who)  the first reason one person may not be
//                                    reached, or null — as a send goes, so
//                                    it also reads the reasons only checked
//                                    then (atSend)
//   person(alias, ws)                a persons row's columns; ws is the SQL
//                                    for the campaign's id (a parameter:
//                                    the look-ups are then made once, not
//                                    once per person)
//   address(email, ws)               an address on its own (a newsletter-
//                                    list row, a send's recipient): no
//                                    person, so no tags and no phone
import { notSuppressed } from './mail/index.js';

export const NO_CONTACT = 'do-not-contact';
export const NO_EMAIL = 'do-not-email';
export const NO_TEXT = 'do-not-text';
export const NO_CALL = 'do-not-call';

// ── SQL pieces ──
const blank = (x) => `coalesce(btrim(${x}), '') = ''`;
// A tag whatever its capitals ("Do-Not-Contact" typed at the desk counts).
const tagged = (c, tag) => `lower(${c.tags}::text) like '%"${tag}"%'`;
// A phone as typed, its extension dropped ("604-555-0101 ext 2"), then its
// digits — the same reading as the texting rules' e164() and
// PHONE_DIGITS_SQL (ext/texting/rules.js; a test holds them together).
const dial = (phone) => `regexp_replace(coalesce(${phone}, ''), '\\s*(ext\\.?|x|#).*$', '', 'i')`;
const digits = (phone) => `regexp_replace(${dial(phone)}, '\\D', '', 'g')`;
export const last10 = (phone) => `right(${digits(phone)}, 10)`;
const plus = (phone) => `btrim(${dial(phone)}) like '+%'`;
// A number that can be dialled: ten digits (area code 2–9), eleven with the
// 1, or + and 8 to 15 digits — read straight off the number as dialled, so
// each row is read once (a city's voter file is 300,000 of them).
export const dialable = (phone) => `(case when ${dial(phone)} ~ '^ *\\+' then ${dial(phone)} ~ '^ *\\+\\D*(\\d\\D*){8,15}$'
  else ${dial(phone)} ~ '^\\D*([2-9]\\D*(\\d\\D*){9}|1\\D*(\\d\\D*){10})$' end)`;
export const e164Sql = (phone) => `(case when not ${dialable(phone)} then null when ${plus(phone)} then '+' || ${digits(phone)}
  when length(${digits(phone)}) = 10 then '+1' || ${digits(phone)} else '+' || ${digits(phone)} end)`;
export const emailKey = (email) => `lower(btrim(coalesce(${email}, '')))`;
// The address is on the newsletter list with this status.
const onNewsletter = (c, status) => `${emailKey(c.email)} in (select lower(s.email) from subscriptions s where s.workspace_id = ${c.ws} and s.status = '${status}')`;

// ── The reasons ──
export const RULES = {
  email: [
    { code: 'no_email', sql: (c) => blank(c.email) },
    // The address bounced for good or reported spam (ext/mail's suppression
    // list, lib/mail notSuppressed), until the desk lifts it — for every
    // sender: no email can reach it.
    { code: 'suppressed', sql: (c) => `not ${notSuppressed(c.ws, c.email)}` },
    // They left the newsletter list (their own link, or the desk's Remove).
    // Not for a shift they booked, or a link they asked for: neither is
    // the newsletter.
    { code: 'unsubscribed', skip: ['press', 'shift', 'self'], sql: (c) => onNewsletter(c, 'unsubscribed') },
    // A press release honours both (a reporter who left the newsletter
    // still gets releases: they leave the media list by its own link). A
    // link someone asked for themselves goes whatever their tags.
    { code: 'do_not_email', skip: ['newsletter', 'self'], sql: (c) => tagged(c, NO_EMAIL) },
    { code: 'do_not_contact', skip: ['newsletter', 'self'], sql: (c) => tagged(c, NO_CONTACT) },
    // They used a release's own unsubscribe link (ext/media leave.js): a
    // row of theirs says so, or of anyone with their address — so a tag the
    // desk puts back, a merge or a fresh record never sends them another.
    { code: 'left_media', only: ['press'], sql: (c) => `exists (select 1 from media_contacts m join persons x on x.workspace_id = m.workspace_id and x.id = m.person_id
        where m.workspace_id = ${c.ws} and m.left_how = 'link' and (m.person_id = ${c.id} or ${emailKey('x.email')} = ${emailKey(c.email)}))` },
    // Only to people who said yes: an address on the newsletter list.
    { code: 'no_consent', only: ['newsletter', 'ladder'], sql: (c) => `not (${onNewsletter(c, 'subscribed')})` },
  ],
  text: [
    { code: 'do_not_contact', sql: (c) => tagged(c, NO_CONTACT) },
    { code: 'do_not_text', sql: (c) => tagged(c, NO_TEXT) },
    { code: 'no_phone', sql: (c) => blank(c.phone) },
    { code: 'bad_number', sql: (c) => `not ${dialable(c.phone)}` },
    // The number replied STOP (ext/texting), whoever carries it now.
    { code: 'opted_out', sql: (c) => `${last10(c.phone)} in (select right(regexp_replace(o.phone, '\\D', '', 'g'), 10) from texting_optouts o where o.workspace_id = ${c.ws} and o.opted_out)` },
    // Asked to stop in words ("please stop texting me") and no START since:
    // the Inbox only flags it for a person, and nobody reads the thread
    // before one of these sends.
    { code: 'asked_to_stop', atSend: true, sql: (c) => `exists (select 1 from texting_messages m
        where m.workspace_id = ${c.ws} and m.phone = ${e164Sql(c.phone)} and m.direction = 'in' and m.keyword = 'asks_stop'
          and not exists (select 1 from texting_messages s where s.workspace_id = m.workspace_id and s.phone = m.phone
                           and s.direction = 'in' and s.keyword = 'start' and s.created_at > m.created_at))` },
    // Their last word on a website form was no to texts (SITE.md consent).
    { code: 'no_text_consent', only: ['ladder'], atSend: true, sql: (c) => `(select e.granted from consent_events e
        where e.workspace_id = ${c.ws} and e.person_id = ${c.id} and e.channel = 'sms' order by e.created_at desc limit 1) is false` },
  ],
  call: [
    { code: 'no_phone', sql: (c) => blank(c.phone) },
    { code: 'do_not_contact', sql: (c) => tagged(c, NO_CONTACT) },
    // Said no to calls (the desk, or a CallHub result: ext/callhub).
    { code: 'do_not_call', sql: (c) => tagged(c, NO_CALL) },
  ],
};

// "Asked not to be called" (do-not-call or do-not-contact, whatever the
// capitals) — a column for a screen that offers a Call (shared/canvass.js
// noCalls reads it as no_call), where a row carries no tags.
export const noCallSql = (alias = 'p') => `(${tagged({ tags: `${alias}.tags` }, NO_CALL)} or ${tagged({ tags: `${alias}.tags` }, NO_CONTACT)})`;

const rulesFor = (channel, sender, { atSend = false } = {}) => {
  const rules = RULES[channel];
  if (!rules) throw new Error(`no such channel: ${channel}`);
  return rules.filter((r) => (!r.only || r.only.includes(sender)) && !(r.skip || []).includes(sender) && (atSend || !r.atSend));
};

export const person = (alias = 'p', ws = '$1') => ({
  ws, id: `${alias}.id`, email: `${alias}.email`, phone: `${alias}.phone`, tags: `${alias}.tags`,
});
export const address = (email, ws = '$1') => ({ ws, id: 'null::uuid', email, phone: 'null::text', tags: "'[]'::jsonb" });

export const mayReach = (channel, sender, cols = person()) => `(${rulesFor(channel, sender).map((r) => `not (${r.sql(cols)})`).join(' and ')})`;
// The first reason as a column (null: may reach), for a screen that says
// why someone won't get a send (Media → Contacts).
// atSend: the reasons only checked as a send goes too (a screen about to
// offer one by hand).
export const whyNotSql = (channel, sender, cols = person(), { atSend = false } = {}) => `(case ${rulesFor(channel, sender, { atSend }).map((r) => `when (${r.sql(cols)}) then '${r.code}'`).join(' ')} end)`;

// One person, as the send is about to go. who: { workspaceId, email, phone,
// tags, personId } — the address or number on the send itself (it may have
// changed on the person since), and the person's tags as they are now.
export const whyNot = async (q, channel, sender, who) => {
  const values = {
    ws: [who.workspaceId, 'uuid'], id: [who.personId || null, 'uuid'], email: [who.email ?? null, 'text'],
    phone: [who.phone ?? null, 'text'], tags: [JSON.stringify(Array.isArray(who.tags) ? who.tags : []), 'jsonb'],
  };
  // Only what a reason reads becomes a parameter (the database refuses one nobody uses).
  const params = [];
  const at = {};
  const cols = {};
  for (const k of Object.keys(values)) {
    Object.defineProperty(cols, k, { get: () => {
      if (!at[k]) { params.push(values[k][0]); at[k] = `$${params.length}::${values[k][1]}`; }
      return at[k];
    } });
  }
  const rules = rulesFor(channel, sender, { atSend: true });
  const sql = `select case ${rules.map((r) => `when (${r.sql(cols)}) then '${r.code}'`).join(' ')} end as why`;
  return (await q.query(sql, params)).rows[0]?.why || null;
};
