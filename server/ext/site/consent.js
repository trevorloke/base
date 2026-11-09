// Yes and no to email and texts — the site's forms and pages, kept in step
// with base.win's own state, and every change on the record:
//
//   base.win's state      email: the newsletter list (subscriptions) and the
//                         do-not-email tag; texts: the do-not-text tag and a
//                         number's STOP (texting_optouts); both: the profile
//                         fields "Email opt-in" / "SMS opt-in" when the
//                         campaign has them
//   consent_events        one row per yes or no, with the words they saw,
//                         where it came from and the address it was about
//
// A form's ticked box is a yes for an address that is new to the list — but
// never puts back someone who left it or is do-not-email / do-not-text /
// do-not-contact: typing an address into a website doesn't prove it's yours
// (the intake API's rule). An unticked box changes nothing. The person's own
// signed link (/preferences, /unsubscribe) changes their state both ways:
// the link reached their inbox, so it is theirs.
//
// base.win's own changes — an unsubscribe link (/u, /bu, /lu), a STOP or
// START text, the desk's Add or Remove on the newsletter list, a
// do-not-email or do-not-text tag — are recorded here too (the events hook,
// consentFromEvents), so the record is whole whichever door it came through.
import { newId } from '../../lib/events.js';
import { actions as fieldActions } from '../fields/actions.js';
import { applyOptOut, isOptedOut } from '../texting/store.js';
import { e164, PHONE_DIGITS_SQL, last10 } from '../texting/rules.js';
import { tagsOf } from './people.js';

const NO_EMAIL = 'do-not-email';
const NO_TEXT = 'do-not-text';
const NO_CONTACT = 'do-not-contact';
const lower = (s) => String(s ?? '').trim().toLowerCase();

export const recordConsent = async (tx, ws, { personId = null, channel, granted, source, wording = null, address = null }, emit) => {
  const id = newId();
  // clock_timestamp(): two in one write keep their order (now() is the write's start).
  await tx.query(
    `insert into consent_events (id, workspace_id, person_id, channel, granted, source, wording, address, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
    [id, ws, personId, channel, granted, source || null, wording, address],
  );
  emit('consent_event', id, 'create', { person_id: personId, channel, granted, source: source || null, address, wording });
  return id;
};

// The last yes or no on record for a person (or, with no person, an address).
export const latestConsent = async (q, ws, { personId = null, address = null, channel }) => (await q.query(
  personId
    ? 'select granted, source, created_at from consent_events where workspace_id = $1 and person_id = $2 and channel = $3 order by created_at desc, id desc limit 1'
    : 'select granted, source, created_at from consent_events where workspace_id = $1 and person_id is null and address = $2 and channel = $3 order by created_at desc, id desc limit 1',
  [ws, personId || address, channel],
)).rows[0] || null;

// "Email opt-in" / "SMS opt-in" (ext/fields standard fields), when the
// campaign has them as yes/no fields.
const OPT_IN = { email: 'email opt-in', sms: 'sms opt-in' };
export const setOptIn = async (tx, ws, personId, channel, value, emit) => {
  if (!personId) return;
  const f = (await tx.query(
    "select id from person_fields where workspace_id = $1 and lower(name) = $2 and kind = 'yesno' and retired_at is null limit 1",
    [ws, OPT_IN[channel]],
  )).rows[0];
  const alive = (await tx.query('select 1 from persons where id = $1 and workspace_id = $2 and deleted_at is null', [personId, ws])).rows[0];
  if (!f || !alive) return;
  await fieldActions['field.values.set'].handler(tx, { workspaceId: ws, user: null }, { person_id: personId, values: [{ field_id: f.id, value }] }, emit);
};

const personTags = async (tx, ws, personId) => (personId
  ? tagsOf((await tx.query('select tags from persons where id = $1 and workspace_id = $2', [personId, ws])).rows[0])
  : []);

// Is this address off-limits to a website form? (They left the list, or
// someone with it is do-not-email or do-not-contact.)
const emailHeld = async (tx, ws, email, personId) => {
  const sub = (await tx.query('select status from subscriptions where workspace_id = $1 and email = $2', [ws, email])).rows[0];
  if (sub?.status === 'unsubscribed') return true;
  const flagged = (await tx.query(
    `select 1 from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null
       and (tags @> '"${NO_EMAIL}"'::jsonb or tags @> '"${NO_CONTACT}"'::jsonb) limit 1`, [ws, email],
  )).rows[0];
  if (flagged) return true;
  const own = await personTags(tx, ws, personId);
  return own.includes(NO_EMAIL) || own.includes(NO_CONTACT);
};
const smsHeld = async (tx, ws, phone, personId) => {
  const num = e164(phone);
  if (num && await isOptedOut(tx, ws, num)) return true;
  const flagged = (await tx.query(
    `select 1 from persons where workspace_id = $1 and deleted_at is null and ${PHONE_DIGITS_SQL('phone')} = $2
       and (tags @> '"${NO_TEXT}"'::jsonb or tags @> '"${NO_CONTACT}"'::jsonb) limit 1`, [ws, last10(phone)],
  )).rows[0];
  if (flagged) return true;
  const own = await personTags(tx, ws, personId);
  return own.includes(NO_TEXT) || own.includes(NO_CONTACT);
};

const subscribe = async (tx, ws, email, name, source, emit, { again = false } = {}) => {
  const sub = (await tx.query('select id, status from subscriptions where workspace_id = $1 and email = $2', [ws, email])).rows[0];
  if (!sub) {
    const id = newId();
    await tx.query(
      `insert into subscriptions (id, workspace_id, email, name, status, source) values ($1, $2, $3, $4, 'subscribed', $5)
       on conflict (workspace_id, email) do nothing`,
      [id, ws, email, name || null, source],
    );
    emit('subscription', id, 'create', { email, name: name || null, source });
  } else if (sub.status !== 'subscribed' && again) {
    await tx.query("update subscriptions set status = 'subscribed', unsubscribed_at = null where id = $1 and workspace_id = $2", [sub.id, ws]);
    emit('subscription', sub.id, 'update', { status: 'subscribed', source });
  }
};

// ── A form's ticked boxes ──
// → { email: 'yes' | 'held' | null, sms: 'yes' | 'held' | null }
export const consentFromForm = async (tx, ws, { personId, name, email, phone, wantsEmail, wantsSms, source, wording }, emit) => {
  const out = { email: null, sms: null };
  const em = lower(email);
  if (wantsEmail && em) {
    if (await emailHeld(tx, ws, em, personId)) out.email = 'held';
    else {
      await subscribe(tx, ws, em, name, source, emit);
      await recordConsent(tx, ws, { personId, channel: 'email', granted: true, source, wording: wording.email, address: em }, emit);
      await setOptIn(tx, ws, personId, 'email', true, emit);
      out.email = 'yes';
    }
  }
  if (wantsSms && phone) {
    if (await smsHeld(tx, ws, phone, personId)) out.sms = 'held';
    else {
      await recordConsent(tx, ws, { personId, channel: 'sms', granted: true, source, wording: wording.sms, address: e164(phone) || phone }, emit);
      await setOptIn(tx, ws, personId, 'sms', true, emit);
      out.sms = 'yes';
    }
  }
  return out;
};

// ── Their own choice, from their signed link ──
export const emailOff = async (tx, ws, { personId, email, source }, emit) => {
  const em = lower(email);
  if (!em) return;
  const sub = (await tx.query('select id, status from subscriptions where workspace_id = $1 and email = $2', [ws, em])).rows[0];
  if (sub && sub.status !== 'unsubscribed') {
    await tx.query("update subscriptions set status = 'unsubscribed', unsubscribed_at = now() where id = $1 and workspace_id = $2", [sub.id, ws]);
    emit('subscription', sub.id, 'update', { status: 'unsubscribed', source });
  }
  // Not on the list (a ladder's or a blast's email reached them): every
  // record with the address is do-not-email, so nothing emails it (as /lu).
  if (!sub) {
    const people = (await tx.query(
      'select id, tags from persons where workspace_id = $1 and (lower(email) = $2 or id = $3) and deleted_at is null', [ws, em, personId],
    )).rows;
    for (const p of people) {
      const tags = tagsOf(p);
      if (tags.includes(NO_EMAIL)) continue;
      const next = [...tags, NO_EMAIL];
      await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [p.id, ws, JSON.stringify(next)]);
      emit('person', p.id, 'update', { tags: next, source });
    }
  }
  await recordConsent(tx, ws, { personId, channel: 'email', granted: false, source, address: em }, emit);
  await setOptIn(tx, ws, personId, 'email', false, emit);
};

export const emailOn = async (tx, ws, { personId, name, email, source, wording }, emit) => {
  const em = lower(email);
  if (!em) return;
  await subscribe(tx, ws, em, name, source, emit, { again: true });
  const people = (await tx.query(
    'select id, tags from persons where workspace_id = $1 and (lower(email) = $2 or id = $3) and deleted_at is null', [ws, em, personId],
  )).rows;
  for (const p of people) {
    const tags = tagsOf(p);
    if (!tags.includes(NO_EMAIL)) continue;
    const next = tags.filter((t) => t !== NO_EMAIL);
    await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [p.id, ws, JSON.stringify(next)]);
    emit('person', p.id, 'update', { tags: next, source });
  }
  await recordConsent(tx, ws, { personId, channel: 'email', granted: true, source, wording, address: em }, emit);
  await setOptIn(tx, ws, personId, 'email', true, emit);
};

// Texts off is a STOP for their number (the texting rules hold every text
// to it, whoever sends); on is a START, and their own do-not-text goes.
export const smsOff = async (tx, ws, { personId, phone, source }, emit) => {
  const num = e164(phone);
  if (num) await applyOptOut(tx, emit, ws, num, { out: true, keyword: 'WEBSITE' });
  const p = (await tx.query('select id, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null', [personId, ws])).rows[0];
  if (p && !tagsOf(p).includes(NO_TEXT)) {
    const next = [...tagsOf(p), NO_TEXT];
    await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [p.id, ws, JSON.stringify(next)]);
    emit('person', p.id, 'update', { tags: next, source });
  }
  await recordConsent(tx, ws, { personId, channel: 'sms', granted: false, source, address: num || phone }, emit);
  await setOptIn(tx, ws, personId, 'sms', false, emit);
};

export const smsOn = async (tx, ws, { personId, phone, source, wording }, emit) => {
  const num = e164(phone);
  if (num && await isOptedOut(tx, ws, num)) await applyOptOut(tx, emit, ws, num, { out: false, keyword: 'WEBSITE' });
  const p = (await tx.query('select id, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null', [personId, ws])).rows[0];
  if (p && tagsOf(p).includes(NO_TEXT)) {
    const next = tagsOf(p).filter((t) => t !== NO_TEXT);
    await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [p.id, ws, JSON.stringify(next)]);
    emit('person', p.id, 'update', { tags: next, source });
  }
  await recordConsent(tx, ws, { personId, channel: 'sms', granted: true, source, wording, address: num || phone }, emit);
  await setOptIn(tx, ws, personId, 'sms', true, emit);
};

// What their preferences page shows, and what it may change: email is on
// when their address is on the list and nothing holds it; texts are on when
// their last word was yes and their number isn't stopped. *Off: already off
// for good (do-not-email or left the list; do-not-text or a STOP) — saving
// "off" again changes nothing.
export const choicesOf = async (q, ws, person) => {
  const em = lower(person.email);
  const tags = tagsOf(person);
  let email = false;
  let emailOffNow = tags.includes(NO_EMAIL);
  if (em) {
    const sub = (await q.query('select status from subscriptions where workspace_id = $1 and email = $2', [ws, em])).rows[0];
    if (sub?.status === 'unsubscribed') emailOffNow = true;
    email = !emailOffNow && sub?.status === 'subscribed';
  }
  let sms = false;
  let smsOffNow = tags.includes(NO_TEXT);
  if (person.phone) {
    const num = e164(person.phone);
    if (num && await isOptedOut(q, ws, num)) smsOffNow = true;
    sms = !smsOffNow && Boolean((await latestConsent(q, ws, { personId: person.id, channel: 'sms' }))?.granted);
  }
  return { email, sms, emailOff: emailOffNow, smsOff: smsOffNow };
};

// ── base.win's own changes (the events hook) ──
// Writes that never speak for a person: the sample campaign, an import.
const QUIET = new Set(['sample.load', 'sample.clear', 'import.persons']);

// One row per person with the address (or one with no person), unless the
// last word on record already says the same.
const note = async (tx, ws, { people, address, channel, granted, source }, emit) => {
  const targets = people.length ? people : [null];
  for (const personId of targets) {
    const last = await latestConsent(tx, ws, { personId, address, channel });
    if (last && last.granted === granted) continue;
    await recordConsent(tx, ws, { personId, channel, granted, source, address }, emit);
    if (!granted && personId) await setOptIn(tx, ws, personId, channel, false, emit);
  }
};
const peopleWithEmail = async (tx, ws, email) => (await tx.query(
  'select id from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null order by created_at limit 20', [ws, email],
)).rows.map((r) => r.id);
const peopleWithPhone = async (tx, ws, phone) => (await tx.query(
  `select id from persons where workspace_id = $1 and deleted_at is null and ${PHONE_DIGITS_SQL('phone')} = $2 order by created_at limit 20`, [ws, last10(phone)],
)).rows.map((r) => r.id);

export const consentFromEvents = async (tx, meta, events) => {
  const action = String(meta.action || '');
  // The site's own writes record their consent themselves, with the words.
  if (action.startsWith('site.') || QUIET.has(action)) return;
  const ws = meta.workspaceId;
  for (const e of events) {
    const p = e.payload || {};
    if (e.entityType === 'subscription') {
      let granted = null;
      if (e.op === 'create') granted = true;
      else if (e.op === 'void' || p.status === 'unsubscribed') granted = false;
      else if (p.status === 'subscribed') granted = true;
      if (granted === null) continue;
      const row = (await tx.query('select email from subscriptions where id = $1 and workspace_id = $2', [e.entityId, ws])).rows[0];
      const email = lower(p.email || row?.email);
      if (!email) continue;
      const source = p.source || (action === 'subscription.add' ? 'desk-added' : action === 'subscription.remove' ? 'desk-removed' : action);
      await note(tx, ws, { people: await peopleWithEmail(tx, ws, email), address: email, channel: 'email', granted, source }, meta.emit);
    } else if (e.entityType === 'texting_optout' && typeof p.opted_out === 'boolean' && p.phone) {
      const source = p.opted_out ? 'text-stop' : 'text-start';
      await note(tx, ws, { people: await peopleWithPhone(tx, ws, p.phone), address: p.phone, channel: 'sms', granted: !p.opted_out, source }, meta.emit);
    } else if (e.entityType === 'person' && e.op === 'update' && Array.isArray(p.tags)) {
      // A do-not-email / do-not-text tag (the desk's, or an unsubscribe's).
      const source = p.source || action;
      if (p.tags.includes(NO_EMAIL)) {
        const r = (await tx.query('select email from persons where id = $1 and workspace_id = $2', [e.entityId, ws])).rows[0];
        await note(tx, ws, { people: [e.entityId], address: lower(r?.email) || null, channel: 'email', granted: false, source }, meta.emit);
      }
      if (p.tags.includes(NO_TEXT)) {
        const r = (await tx.query('select phone from persons where id = $1 and workspace_id = $2', [e.entityId, ws])).rows[0];
        await note(tx, ws, { people: [e.entityId], address: e164(r?.phone) || r?.phone || null, channel: 'sms', granted: false, source }, meta.emit);
      }
    }
  }
};
