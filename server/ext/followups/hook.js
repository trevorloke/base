// Speed to lead, as an events hook (lib/hooks.js): every write's events,
// inside its transaction, before they are chained. Three passes, in order:
//
//   1. close   a contact logged with someone (contact.log — a door, a call,
//              a text, in person, mainstreeting) closes their open
//              follow-ups when the organizer who has it logged it (any
//              outcome), or anyone talked with them. A talk also marks the
//              "Wants to volunteer" door requests it came from done ("Followed
//              up by Ana Example — on the phone"), so the office isn't asked
//              twice. Only follow-ups from before this write: Mainstreeting's
//              own talk never closes the volunteer follow-up it makes.
//   2. open    what makes a follow-up:
//                site_action create (SITE.md)  volunteer → 'volunteer',
//                  contact → 'message', rsvp → 'rsvp' when they're new (a
//                  person made by this write, or someone never contacted and
//                  on no other shift)
//                door_request create, kind volunteer — the door's "Wants to
//                  volunteer" (request.ask), Mainstreeting's, the membership
//                  form's "I'd like to volunteer" (both ask through
//                  request.ask), the intake API's volunteer: true — and the
//                  intake API's message (kind other, from the website)
//              One open follow-up per person: a second thing they do joins
//              it (detail.did) and keeps its clock and organizer. Never for
//              someone marked do not contact, or a teammate (they're in).
//              Routed by route.js; due a day after it was made.
//   3. pin     a person placed on the map after their follow-up went to the
//              office (the address lookup runs just after the save): a turf
//              organizer takes it, while nobody has reached them yet.
//   4. leave   a teammate removed from the campaign: their open follow-ups
//              go to whoever the rules pick now (a ladder's, to a manager).
//              A teammate made a volunteer: a ladder's they had goes to a
//              manager (a volunteer never holds one); the rest stay theirs.
//
// What the follow-ups write joins the chain with the write (as
// 'ladder_followup' / 'door_request' events). A fault here never costs the
// write itself: it runs under a savepoint and is skipped as a whole. Imports
// and the sample campaign make none.
import { newId } from '../../lib/events.js';
import { hasTable } from '../webdid/words.js';
import { officeOf, routeFollowup, teammateOf, turfOrganizer } from './route.js';
import { didWords, summary } from './words.js';

const QUIET = new Set(['sample.load', 'sample.clear', 'import.persons']);
const DID_KEEP = 10;
const DNC = 'do-not-contact';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A door request's write → where it came from.
const FROM_ACTION = { 'request.ask': 'door', 'mainstreet.meet': 'mainstreet', 'membership.enter': 'membership', 'intake.person': 'website' };
const SITE_KIND = { volunteer: 'volunteer', contact: 'message', rsvp: 'rsvp' };
const TALKED_HOW = {
  door: 'at the door', phone: 'on the phone', text: 'by text', in_person: 'in person', mainstreet: 'in person',
};

const parse = (v, d) => {
  try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; }
};
const str = (v, n) => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return s ? s.slice(0, n) : null;
};
// What someone wrote, its lines kept (a message in paragraphs).
const words = (v, n) => {
  const s = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : '';
  return s ? s.slice(0, n) : null;
};
const nameOf = async (tx, userId) => (userId
  ? (await tx.query('select name from users where id = $1', [userId])).rows[0]?.name || null
  : null);

// ── 1. close ──

// The door requests a follow-up came from, done: someone talked with them.
const closeRequests = async (tx, ws, f, by, channel, emits) => {
  const ids = (parse(f.detail, {}).did || []).map((d) => d.request_id).filter((id) => UUID.test(String(id || '')));
  if (!ids.length) return;
  const who = (await nameOf(tx, by)) || 'the campaign';
  const note = `Followed up by ${who}${TALKED_HOW[channel] ? ` — ${TALKED_HOW[channel]}` : ''}`.slice(0, 500);
  const rows = (await tx.query(
    `update door_requests set done_at = now(), done_by = $3, done_note = $4
     where workspace_id = $1 and id = any($2::uuid[]) and done_at is null returning id, done_at`,
    [ws, ids, by, note],
  )).rows;
  for (const r of rows) emits.push(['door_request', r.id, 'update', { done_at: r.done_at, done_note: note }]);
};

const closeOnContacts = async (tx, meta, events, emits) => {
  const ws = meta.workspaceId;
  const by = meta.actorId || null;
  for (const e of events) {
    if (e.entityType !== 'contact' || (e.op !== 'create' && e.op !== 'update')) continue;
    const p = e.payload || {};
    if (p.sample || !p.person_id || !p.outcome) continue;
    const talked = p.outcome === 'contacted';
    // Speed to lead's own; a ladder's only when it was handed to whoever logged this.
    const open = (await tx.query(
      `select id, kind, assigned_to, detail from ladder_followups
       where workspace_id = $1 and person_id = $2 and status = 'open' and (kind is not null or assigned_to = $3)
       for update`,
      [ws, p.person_id, by],
    )).rows;
    for (const f of open) {
      const mine = Boolean(by) && f.assigned_to === by;
      if (!mine && !(talked && f.kind)) continue;
      await tx.query(
        `update ladder_followups set status = 'done', done_at = now(), done_by = $3,
           contact_id = $4, contacted_at = coalesce(contacted_at, now()), contacted_by = coalesce(contacted_by, $3)
         where id = $1 and workspace_id = $2`,
        [f.id, ws, by, e.entityId],
      );
      emits.push(['ladder_followup', f.id, 'update', {
        status: 'done', closed_by: 'contact', contact_id: e.entityId, outcome: p.outcome, channel: p.channel || null,
      }]);
      if (talked) await closeRequests(tx, ws, f, by, p.channel, emits);
    }
  }
};

// ── 2. open ──

// Someone new to the campaign: made by this write, or never contacted and
// on no shift but the one this write booked.
const isNew = async (tx, ws, personId, made, booked) => {
  if (made.has(personId)) return true;
  if ((await tx.query('select 1 from contacts where workspace_id = $1 and person_id = $2 limit 1', [ws, personId])).rows[0]) return false;
  return !(await tx.query(
    'select 1 from shift_assignments where workspace_id = $1 and person_id = $2 and not (id = any($3::uuid[])) limit 1',
    [ws, personId, [...booked]],
  )).rows[0];
};

// What a website form said, from its site_actions row (the site server's,
// SITE.md: the form's fields in payload) — or, failing that, the event.
const fromSite = async (tx, ws, kind, e) => {
  const row = (await hasTable(tx, 'site_actions'))
    ? (await tx.query('select payload, referrer_id, source from site_actions where id = $1 and workspace_id = $2', [e.entityId, ws])).rows[0]
    : null;
  const form = parse(row?.payload, {}) || {};
  const get = (k) => form[k] ?? e.payload?.[k];
  const did = { kind, from: 'website', at: new Date().toISOString(), site_action_id: e.entityId };
  if (kind === 'volunteer') {
    const roles = get('roles');
    if (Array.isArray(roles)) did.roles = roles.map((r) => str(r, 60)).filter(Boolean).slice(0, 10);
    const free = str(get('availability'), 300);
    if (free) did.availability = free;
    const note = words(get('note'), 1000);
    if (note) did.note = note;
  } else if (kind === 'message') {
    const topic = str(get('topic'), 60);
    if (topic) did.topic = topic;
    const message = words(get('message'), 2000);
    if (message) did.message = message;
  } else if (kind === 'rsvp') {
    const sid = String(get('shift_id') || '');
    const s = UUID.test(sid) ? (await tx.query(
      'select id, title, starts_at from shifts where id = $1 and workspace_id = $2', [sid, ws],
    )).rows[0] : null;
    if (s) did.shift = { id: s.id, title: s.title, starts_at: s.starts_at };
  }
  const source = str(row?.source ?? e.payload?.source, 60);
  if (source) did.source = source;
  return { did, referrerId: e.payload?.referrer_id || row?.referrer_id || null };
};

// A door request: who asked, where they were met, what the website said.
const fromRequest = async (tx, meta, e) => {
  const p = e.payload || {};
  const from = p.from === 'website' || String(meta.action).startsWith('site.') ? 'website' : FROM_ACTION[meta.action] || 'door';
  const kind = p.kind === 'volunteer' ? 'volunteer' : from === 'website' && str(p.note, 10) ? 'message' : null;
  if (!kind) return null;
  const did = { kind, from, at: new Date().toISOString(), request_id: e.entityId };
  const note = str(p.note, 1000);
  if (from === 'mainstreet') {
    const m = /^Met mainstreeting at (.+)$/.exec(note || '');
    if (m) did.place = m[1].slice(0, 120);
  } else if (from === 'website') {
    // The intake API's "From the website (source): what they wrote".
    const text = (note || '').replace(/^From the website(?: \([^)]*\))?:?\s*/, '').trim();
    if (text) did[kind === 'message' ? 'message' : 'note'] = text;
  } else if (from === 'door') {
    if (note) did.note = note;
    const asker = await nameOf(tx, meta.actorId);
    if (asker) did.asked_by = asker;
  }
  return { did, referrerId: null };
};

// One write that says the same thing twice — a website form that also files
// a "Wants to volunteer" request, say — is one thing they did: the second
// only adds the row it came from (so a talk closes that request too).
const sameWrite = (list, did, mine) => list.findIndex((d, i) => mine.has(i) && d.kind === did.kind && d.from === did.from);

const upsert = async (tx, meta, { personId, did, referrerId }, emits, made) => {
  const ws = meta.workspaceId;
  const person = (await tx.query(
    'select id, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null', [personId, ws],
  )).rows[0];
  if (!person) return;
  const tags = parse(person.tags, []);
  if (Array.isArray(tags) && tags.some((t) => String(t).trim().toLowerCase() === DNC)) return;
  if (await teammateOf(tx, ws, personId)) return;
  const entry = { ...did, words: didWords(did) };
  const open = (await tx.query(
    `select id, detail from ladder_followups
     where workspace_id = $1 and person_id = $2 and status = 'open' and kind is not null
     order by created_at limit 1 for update`,
    [ws, personId],
  )).rows[0];
  if (open) {
    const detail = parse(open.detail, {}) || {};
    const had = Array.isArray(detail.did) ? detail.did : [];
    const mine = made.get(open.id) || new Set();
    const twin = sameWrite(had, did, mine);
    if (twin >= 0) {
      const merged = had.map((d, i) => (i === twin ? { ...entry, ...d, ...(did.request_id ? { request_id: did.request_id } : {}), ...(did.site_action_id ? { site_action_id: did.site_action_id } : {}) } : d));
      await tx.query('update ladder_followups set detail = $3 where id = $1 and workspace_id = $2',
        [open.id, ws, JSON.stringify({ ...detail, did: merged })]);
      return;
    }
    const list = [...had, entry].slice(0, DID_KEEP);
    if (list.length > had.length) made.set(open.id, new Set([...mine, list.length - 1]));
    const text = summary(list);
    await tx.query('update ladder_followups set detail = $3, text = $4 where id = $1 and workspace_id = $2',
      [open.id, ws, JSON.stringify({ ...detail, did: list }), text]);
    emits.push(['ladder_followup', open.id, 'update', { added: did.kind, from: did.from, text }]);
    return;
  }
  const route = await routeFollowup(tx, ws, personId, { referrerId: UUID.test(String(referrerId || '')) ? referrerId : null });
  const id = newId();
  const text = summary([entry]);
  await tx.query(
    `insert into ladder_followups (id, workspace_id, ladder_id, run_id, person_id, text, kind, detail, assigned_to, routed, due_at)
     values ($1, $2, null, null, $3, $4, $5, $6, $7, $8, now() + interval '24 hours')`,
    [id, ws, personId, text, did.kind, JSON.stringify({ did: [entry] }), route?.userId || null, route?.routed || null],
  );
  made.set(id, new Set([0]));
  emits.push(['ladder_followup', id, 'create', {
    person_id: personId, kind: did.kind, from: did.from, text, assigned_to: route?.userId || null, routed: route?.routed || null,
  }]);
};

const openFromSources = async (tx, meta, events, emits) => {
  const ws = meta.workspaceId;
  const people = new Set(events.filter((e) => e.entityType === 'person' && e.op === 'create').map((e) => e.entityId));
  const booked = new Set(events.filter((e) => e.entityType === 'shift_assignment' && e.op === 'create').map((e) => e.entityId));
  // Follow-ups this write made or added to: id → the did entries it added.
  const made = new Map();
  // The website's own action first: it carries the referral that routes it.
  const order = [...events].sort((a, b) => (b.entityType === 'site_action') - (a.entityType === 'site_action'));
  for (const e of order) {
    if (e.op !== 'create') continue;
    const p = e.payload || {};
    if (p.sample || !p.person_id) continue;
    let found = null;
    if (e.entityType === 'site_action' && SITE_KIND[p.kind]) {
      const kind = SITE_KIND[p.kind];
      if (kind === 'rsvp' && !(await isNew(tx, ws, p.person_id, people, booked))) continue;
      found = await fromSite(tx, ws, kind, e);
    } else if (e.entityType === 'door_request') {
      found = await fromRequest(tx, meta, e);
    }
    if (found) await upsert(tx, meta, { personId: p.person_id, ...found }, emits, made);
  }
};

// ── 3. pin ──

const rerouteOnPin = async (tx, meta, events, emits) => {
  const ws = meta.workspaceId;
  const ids = [...new Set(events
    .filter((e) => e.entityType === 'person' && e.op === 'update' && e.payload?.lat != null && e.payload?.lng != null)
    .map((e) => e.entityId))];
  if (!ids.length) return;
  const rows = (await tx.query(
    `select id, person_id, assigned_to from ladder_followups
     where workspace_id = $1 and person_id = any($2::uuid[]) and status = 'open' and kind is not null
       and routed = 'office' and contacted_at is null
     for update`,
    [ws, ids],
  )).rows;
  for (const f of rows) {
    const to = await turfOrganizer(tx, ws, f.person_id);
    if (!to || to.userId === f.assigned_to) continue;
    await tx.query("update ladder_followups set assigned_to = $3, routed = 'turf' where id = $1 and workspace_id = $2", [f.id, ws, to.userId]);
    emits.push(['ladder_followup', f.id, 'update', { assigned_to: to.userId, routed: 'turf', from: f.assigned_to || null, reason: 'pin' }]);
  }
};

// ── 4. someone leaves the team, or is made a volunteer ──

// Someone removed: their open follow-ups go to whoever the rules pick now
// (they can no longer see them); a ladder's own, to a manager. Someone made
// a volunteer (member.setRole): a ladder's own goes to a manager — a
// volunteer never holds one (it can say they gave) — and their speed-to-lead
// follow-ups stay theirs.
const madeVolunteer = (e) => e.entityType === 'membership' && e.op === 'update' && e.payload?.role === 'volunteer';
const handBack = async (tx, meta, events, emits) => {
  const ws = meta.workspaceId;
  const gone = events.filter((e) => e.entityType === 'membership' && e.op === 'void').map((e) => e.entityId);
  const volunteers = events.filter(madeVolunteer).map((e) => e.entityId).filter((id) => UUID.test(String(id || '')));
  if (!gone.length && !volunteers.length) return;
  const rows = (await tx.query(
    `select id, person_id, kind, assigned_to from ladder_followups
     where workspace_id = $1 and status = 'open'
       and (assigned_to = any($2::uuid[]) or (kind is null and assigned_to = any($3::uuid[])))
     for update`,
    [ws, gone, volunteers],
  )).rows;
  for (const f of rows) {
    const left = gone.includes(f.assigned_to);
    const to = f.kind ? await routeFollowup(tx, ws, f.person_id) : await officeOf(tx, ws);
    await tx.query('update ladder_followups set assigned_to = $3, routed = $4 where id = $1 and workspace_id = $2',
      [f.id, ws, to?.userId || null, to?.userId ? to.routed : null]);
    emits.push(['ladder_followup', f.id, 'update', {
      assigned_to: to?.userId || null, routed: to?.routed || null, from: f.assigned_to, reason: left ? 'left' : 'role',
    }]);
  }
};

// Any event this hook reads: most writes have none and cost nothing.
const touches = (e) => (e.op === 'create' && (e.entityType === 'site_action' || e.entityType === 'door_request'))
  || (e.entityType === 'contact' && (e.op === 'create' || e.op === 'update'))
  || (e.entityType === 'person' && e.op === 'update' && e.payload?.lat != null)
  || (e.entityType === 'membership' && e.op === 'void')
  || madeVolunteer(e);

export const onEvents = async (tx, meta, events) => {
  if (QUIET.has(meta.action) || !events.some(touches)) return;
  await tx.query('savepoint followups_hook');
  try {
    const emits = [];
    await closeOnContacts(tx, meta, events, emits);
    await openFromSources(tx, meta, events, emits);
    await rerouteOnPin(tx, meta, events, emits);
    await handBack(tx, meta, events, emits);
    await tx.query('release savepoint followups_hook');
    for (const e of emits) meta.emit(...e);
  } catch (err) {
    await tx.query('rollback to savepoint followups_hook');
    await tx.query('release savepoint followups_hook');
    console.error('follow-ups: skipped —', err.message);
  }
};
