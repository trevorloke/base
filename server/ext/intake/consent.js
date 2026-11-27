// A no that came from the campaign's website (POST /in/v1/consent), applied
// here the way base.win's own unsubscribe and STOP are — inside the caller's
// write, so every change is on the event log as the key's maker.
//
//   email   acts on the address, as every unsubscribe here does: the list
//           row is marked unsubscribed, or (never on the list) every record
//           with the address is do-not-email. An address with no list row
//           gets one that says "unsubscribed" — the tombstone — so nothing
//           later puts it on the list or emails it, whoever is imported
//           with it afterwards.
//   sms     a STOP for the number (held for a number nobody has yet), and
//           do-not-text on everyone with it; with an email, texts off for
//           each record with that address too.
//
// Only a no is applied. A yes ("grant") changes nothing: saying yes again
// is done where the person sees the wording. A deletion on the website is a
// no on that channel and nothing more: base.win deletes nobody by itself.
// Their own later yes stands: a no that happened before it changes nothing.
// Applying the same no twice changes nothing the second time.
//
// → { outcome, people }
//   applied        someone on file, or on the list, was turned off (people: how many)
//   tombstone      nobody to turn off; the address or number is held from now on
//   already        it was already off; nothing written
//   superseded     they said yes themselves after it happened; nothing written
//   grant-ignored  a yes; nothing written
//   no-address     email, with no email in the body
//   no-match       texts, with neither a number that can be dialled nor a record with the address
import { newId } from '../../lib/events.js';
import { stillOn } from '../mail/webhook.js';
import { emailOff, ownYesAfter, recordConsent, smsOff } from '../site/consent.js';
import { applyOptOut, isOptedOut } from '../texting/store.js';
import { e164 } from '../texting/rules.js';
import { WEBSITE_KEYWORD } from './website.js';

const NO_EMAIL = 'do-not-email';
const NO_TEXT = 'do-not-text';
const tagsOf = (p) => (typeof p?.tags === 'string' ? JSON.parse(p.tags) : (p?.tags || []));

const emailNo = async (tx, ws, { email, at, source }, emit) => {
  if (!email) return { outcome: 'no-address', people: 0 };
  if (await ownYesAfter(tx, ws, 'email', email, at)) return { outcome: 'superseded', people: 0 };
  const on = await stillOn(tx, ws, email);
  let people = 0;
  if (on) {
    // Everyone on file with the address whose email is on (a household shares
    // one) — or, with no such record, the one who subscribed.
    const who = (await tx.query(
      `select id, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null order by created_at, id`, [ws, email],
    )).rows;
    people = Math.max(1, who.filter((p) => !tagsOf(p).includes(NO_EMAIL)).length);
    await emailOff(tx, ws, { personId: who[0]?.id || null, email, source }, emit);
  }
  // The tombstone: an address with no list row gets one that says no.
  const held = (await tx.query('select 1 from subscriptions where workspace_id = $1 and email = $2', [ws, email])).rows.length > 0;
  if (!held) {
    const id = newId();
    await tx.query(
      `insert into subscriptions (id, workspace_id, email, status, source, unsubscribed_at) values ($1, $2, $3, 'unsubscribed', 'website', $4)
       on conflict (workspace_id, email) do nothing`,
      [id, ws, email, at],
    );
    emit('subscription', id, 'create', { email, status: 'unsubscribed', source });
    if (!on) await recordConsent(tx, ws, { personId: null, channel: 'email', granted: false, source, address: email }, emit);
  }
  return { outcome: on ? 'applied' : held ? 'already' : 'tombstone', people };
};

const smsNo = async (tx, ws, { email, phone, at, source }, emit) => {
  const num = e164(phone);
  // A START from the number, or their own yes, after it happened.
  const yesSince = async (n) => Boolean(n) && ((await tx.query(
    'select 1 from texting_optouts where workspace_id = $1 and phone = $2 and opted_out = false and changed_at > $3::timestamptz', [ws, n, at],
  )).rows.length > 0 || await ownYesAfter(tx, ws, 'sms', n, at));
  if (await yesSince(num)) return { outcome: 'superseded', people: 0 };
  let people = 0;
  let changed = false;
  if (num && !(await isOptedOut(tx, ws, num))) {
    people += (await applyOptOut(tx, emit, ws, num, { out: true, keyword: WEBSITE_KEYWORD })).people;
    changed = true;
  }
  // With an email: texts off for each record with that address (the oldest 20).
  const records = email ? (await tx.query(
    'select id, phone, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null order by created_at, id limit 20', [ws, email],
  )).rows : [];
  let stood = 0;
  for (const p of records) {
    const theirs = e164(p.phone);
    // Their number, when it is another one: its own START or yes stands too.
    if (theirs !== num && await yesSince(theirs)) { stood += 1; continue; }
    const row = (await tx.query('select tags from persons where id = $1 and workspace_id = $2', [p.id, ws])).rows[0];
    if (tagsOf(row).includes(NO_TEXT) && (!theirs || await isOptedOut(tx, ws, theirs))) continue; // already off
    await smsOff(tx, ws, { personId: p.id, phone: p.phone, source, keyword: WEBSITE_KEYWORD }, emit);
    people += 1;
    changed = true;
  }
  if (changed) return { outcome: people ? 'applied' : 'tombstone', people };
  if (!num && !records.length) return { outcome: 'no-match', people: 0 };
  return { outcome: records.length && stood === records.length && !num ? 'superseded' : 'already', people: 0 };
};

// c: the body, already inside the schema (index.js consentIn).
export const applyWebsiteConsent = async (tx, ws, c, emit) => {
  if (c.action === 'grant') return { outcome: 'grant-ignored', people: 0 };
  const source = `website-${c.reason}`;
  // A time later than now is read as now.
  const at = new Date(Math.min(new Date(c.at).getTime(), Date.now())).toISOString();
  const said = { email: c.email || null, phone: c.phone || null, at, source };
  return c.channel === 'email' ? emailNo(tx, ws, said, emit) : smsNo(tx, ws, said, emit);
};
