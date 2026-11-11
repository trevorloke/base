// A call's result, from CallHub to the person.
//
//   readDelivery(raw, type)   the bytes CallHub sent → { body, fields } | null.
//                             JSON or a form; the fields at the top level or
//                             inside `data`; the agent nested or as dotted
//                             or bracketed keys. What its documentation
//                             could not settle is read every way it may come.
//   outcomeFor(said, own)     a disposition (the account's own words) → the
//                             outcome it counts as: the desk's correction,
//                             else the pattern table below
//   fileResult(db, delivery)  one result, once: matched by number against
//                             what this campaign sent, a phone contact on
//                             the person (source 'callhub'), an open phone
//                             bank's number crossed off — or kept unfiled.
//                             Never makes a person.
//   keepUnread(db, raw, type) a delivery base.win could not read as a
//                             result: kept as it came all the same, so what
//                             CallHub really sends can be seen (Check counts
//                             them)
//   refile(tx, emit, ws, push)  the desk changed how a push's results are
//                             read: what is already in follows — only what
//                             the change is about, and all of it can be put
//                             back (a do-not-call tag the table put on comes
//                             off, a rating an answer gave is taken back).
//                             A part at a time; runRefileJob does the rest.
//
// A rating only ever comes from a survey answer the desk mapped
// (callhub.map); nothing here guesses one. Every result is kept as it came
// (callhub_results.raw).
import { createHash } from 'node:crypto';
import { runAction, newId } from '../../lib/events.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { e164, NO_CALL_TAG } from '../texting/rules.js';
import { crossOff, recross } from '../banks/actions.js';
import { loadScale, ratingRefusal } from '../scale/rules.js';
import { tagsOf } from './people.js';

export const RESULT_ACTION = 'callhub.result';
// There is no call id in a delivery, so a result is known by its content;
// the same content within this long is the same call sent again.
const SAME_CALL_MINUTES = 15;
const NOTE_MAX = 2000;

// Words compared loosely: case, spacing and punctuation at the ends don't
// count ("Call back LATER " is "call back later").
export const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s ]+/g, ' ').replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');

// What a result can count as. do_not_call is a refusal that also marks the
// person do-not-call.
export const MAP_OUTCOMES = ['contacted', 'no_answer', 'left_message', 'inaccessible', 'refused', 'moved', 'do_not_call'];
export const contactOutcome = (o) => (o === 'do_not_call' ? 'refused' : o);
// The pattern table: dispositions are each account's own words, so these
// are the common ones; the first that fits wins, and anything else is a
// conversation. The desk corrects a row on the push (callhub.map).
const PATTERNS = [
  ['do_not_call', /\b(do not call|don'?t call|dnc|do not contact|remove|take (me|us|them) off|stop calling)\b/],
  ['inaccessible', /\b(wrong (number|person)|disconnected|not in service|out of service|invalid|bad number)\b/],
  ['moved', /\bmoved\b/],
  ['left_message', /\b(voice ?mail|left (a )?message|message left|machine)\b/],
  ['no_answer', /\b(no answer|not? answered|unanswered|busy|not home|no ?one home|nobody home)\b/],
  ['refused', /\b(refused|refusal|not interested|hung up|hang ?up)\b/],
];
export const outcomeFor = (said, own = null) => {
  const key = norm(said).replace(/[‘’]/g, "'");
  const mine = own && typeof own === 'object' ? own[norm(said)] : null;
  if (MAP_OUTCOMES.includes(mine)) return mine;
  return (PATTERNS.find(([, re]) => re.test(key)) || ['contacted'])[0];
};

// ── Reading a delivery ──
const str = (v, max = 2000) => (v == null || typeof v === 'object' ? '' : String(v).trim().slice(0, max));
const asObject = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && /^\s*\{/.test(v)) { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } }
  return null;
};

// A form's nested keys — "agent.email", "agent[email]",
// "data[agent][email]" — as the objects they stand for. A name that could
// reach into an object's own workings is left out.
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const nested = (src) => {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const path = String(k).split(/[.[\]]+/).filter(Boolean);
    if (path.some((p) => UNSAFE.has(p))) continue;
    if (path.length < 2) {
      // A plain value never replaces what the nested keys already built.
      if (!(asObject(out[k]) && !asObject(v))) out[k] = v;
      continue;
    }
    let at = out;
    for (const part of path.slice(0, -1)) {
      at[part] = { ...(asObject(at[part]) || {}) };
      at = at[part];
    }
    at[path.at(-1)] = v;
  }
  return out;
};

// The fields base.win reads, wherever they sit in what came: inside `data`,
// unless the number or the result is at the top level itself.
export const fieldsOf = (body) => {
  const top = nested(body || {});
  const inner = asObject(top.data) ? nested(asObject(top.data)) : null;
  const flat = inner && !['contact', 'mobile', 'disposition'].some((k) => str(top[k])) ? inner : top;
  const agent = asObject(flat.agent) || (str(flat.agent) ? { username: str(flat.agent) } : {});
  return {
    contact: str(flat.contact, 60), mobile: str(flat.mobile, 60),
    disposition: str(flat.disposition, 200), notes: str(flat.notes ?? flat.note),
    campaign: str(asObject(flat.campaign)?.name ?? flat.campaign, 200), record_url: str(flat.record_url, 500),
    surveys: flat.surveys ?? flat.survey ?? null,
    agent: { id: str(agent.id, 60), username: str(agent.username ?? agent.name, 120), email: str(agent.email, 320).toLowerCase() },
  };
};
const SEEN = ['contact', 'mobile', 'disposition', 'notes', 'campaign', 'record_url'];
export const readDelivery = (raw, type = '') => {
  const text = Buffer.from(raw).toString('utf8').trim();
  if (!text) return null;
  const saysJson = /json/i.test(type);
  let body = null;
  if (saysJson || /^[{[]/.test(text)) { try { body = JSON.parse(text); } catch { body = null; } }
  if (body === null && !saysJson && text.includes('=')) body = Object.fromEntries(new URLSearchParams(text));
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = fieldsOf(body);
  // Nothing of a result in it: not one.
  if (!SEEN.some((k) => fields[k]) && fields.surveys == null && !fields.agent.email && !fields.agent.username) return null;
  return { body, fields };
};

// The survey as question → answer pairs, however CallHub wrote it: a list
// of { question, answer }, of { "Question": "Answer" }, of [question,
// answer], one object, or any of those as JSON text.
const Q_KEYS = ['question', 'key', 'name', 'title', 'label'];
const A_KEYS = ['answer', 'response', 'value', 'choice', 'answers', 'responses'];
const say = (v) => (Array.isArray(v) ? v.map(say).filter(Boolean).join(', ')
  : v != null && typeof v === 'object' ? say(v.answer ?? v.response ?? v.value ?? v.name ?? v.text ?? '')
    : String(v ?? '').replace(/\s+/g, ' ').trim());
export const surveyPairs = (given) => {
  let v = given;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    try { v = JSON.parse(t); } catch { return [['Answers', t.replace(/\s+/g, ' ').slice(0, 300)]]; }
  }
  // A list written as a form ("surveys[0][question]"): its items in order.
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length && Object.keys(v).every((k) => /^\d+$/.test(k))) v = Object.values(v);
  const out = [];
  const pair = (q, a) => { const qq = say(q); const aa = say(a); if (qq && aa) out.push([qq.slice(0, 200), aa.slice(0, 300)]); };
  const one = (item) => {
    if (Array.isArray(item)) { if (item.length >= 2) pair(item[0], item[1]); return; }
    if (!item || typeof item !== 'object') return;
    const qk = Q_KEYS.find((k) => typeof item[k] === 'string' && item[k].trim());
    const ak = A_KEYS.find((k) => item[k] != null && item[k] !== '');
    if (qk && ak) pair(item[qk], item[ak]);
    else for (const [k, val] of Object.entries(item)) pair(k, val);
  };
  if (Array.isArray(v)) v.forEach(one); else one(v);
  return out.slice(0, 20);
};

// The rating a result carries: the mapped question's answer, when the desk
// said what that answer means. Otherwise none — never a guess.
export const ratingFor = (pairs, map) => {
  if (!map?.question || !map.answers) return null;
  const hit = pairs.find(([q]) => norm(q) === map.question);
  return (hit && map.answers[norm(hit[1])]) || null;
};

// The contact's note: one line each, each a sentence, so it reads the same
// where line breaks are kept and where they are not.
const sentence = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const oneLine = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
export const noteFor = (fields, pairs, { credited = false } = {}) => {
  const caller = fields.agent.username || fields.agent.email.split('@')[0] || '';
  const lines = [
    fields.campaign ? `CallHub: ${oneLine(fields.campaign, 120)}` : 'CallHub',
    fields.disposition && `Result: ${oneLine(fields.disposition, 120)}`,
    !credited && caller && `Caller: ${oneLine(caller, 80)}`,
    fields.notes && `Notes: ${oneLine(fields.notes, 1200)}`,
    ...pairs.slice(0, 12).map(([q, a]) => `${q}${/[?:]$/.test(q) ? '' : ':'} ${a}`),
  ].filter(Boolean).map(sentence);
  return lines.join('\n').slice(0, NOTE_MAX);
};

// The same call sent twice has the same key (campaign, number, agent,
// disposition, notes, recording): nothing else in a delivery tells calls apart.
export const keyFor = (fields, phone) => createHash('sha256').update(JSON.stringify([
  norm(fields.campaign), phone || fields.contact || fields.mobile, fields.agent.email || fields.agent.username || fields.agent.id,
  norm(fields.disposition), fields.notes, fields.record_url,
])).digest('hex');

// ── Filing ──
const parseJ = (v, d) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) ?? d; } catch { return d; } };

// The newest push this number went to CallHub in (sent_at: a number still
// waiting to go has not been sent), and the person results go to: the one
// whose name went, else the first by name still on file (a record merged
// since has passed its place on).
const matchOf = async (db, phone) => (await db.query(
  `select c.push_id, c.workspace_id, c.person_id from callhub_contacts c
     join callhub_pushes pu on pu.id = c.push_id
     join persons p on p.id = c.person_id and p.deleted_at is null
    where c.phone = $1 and c.sent_at is not null
    order by pu.created_at desc, c.first_on_number desc, c.position, c.person_id limit 1`, [phone],
)).rows[0] || null;

// Whose tag it is. A result that counts as "do not call" holds the person's
// do-not-call tag (callhub_results.tagged) when it put the tag on, or found
// it on already because another of their results had. A tag nobody's result
// holds is the desk's own — set by hand — and never the table's to take
// off. The other way round, a tag the desk takes off by hand is held by no
// result from then on (forgetHolders, from the events hook in dnc.js).
const held = async (tx, ws, personId) => (await tx.query(
  `select 1 from callhub_results where workspace_id = $1 and person_id = $2 and tagged and mapped = 'do_not_call' limit 1`, [ws, personId],
)).rows.length > 0;
export const forgetHolders = (tx, ws, personIds) => tx.query(
  'update callhub_results set tagged = false where workspace_id = $1 and tagged and person_id = any($2::uuid[])', [ws, personIds],
);

// Two records about to be made one (the personMerging hook, before
// anything moves — while whose result is whose can still be told). A
// call's hold goes with its result to the record kept, so a row put back
// still takes off the tag a call put on, whichever record that was. But a
// tag either record carries with no result holding it was set by hand: on
// the record kept it stays the desk's, so the calls of both let go of
// theirs — a row put back never takes it.
export const onMerging = async (tx, ctx, { keep, drop }) => {
  const ws = ctx.workspaceId;
  const both = [keep, drop];
  const holding = new Set((await tx.query(
    `select distinct person_id from callhub_results where workspace_id = $1 and tagged and mapped = 'do_not_call' and person_id = any($2::uuid[])`,
    [ws, both.map((p) => p.id)],
  )).rows.map((r) => r.person_id));
  if (!holding.size) return;
  const has = (p) => tagsOf(p).includes(NO_CALL_TAG);
  const byHand = both.some((p) => has(p) && !holding.has(p.id));
  // A hold on a record without the tag holds nothing (it came off some way not seen): it goes too.
  const off = both.filter((p) => holding.has(p.id) && (byHand || !has(p))).map((p) => p.id);
  if (off.length) await forgetHolders(tx, ws, off);
};

// A result counts as "do not call". → 'new' (it put the tag on), 'shared'
// (the tag was on already, held by another result — or by one that let go
// of it in this same save: `released`), or null (on already, by hand).
const markNoCall = async (tx, emit, ws, personId, { released = false } = {}) => {
  const p = (await tx.query('select tags from persons where id = $1 and workspace_id = $2 and deleted_at is null for update', [personId, ws])).rows[0];
  if (!p) return null;
  if (tagsOf(p).includes(NO_CALL_TAG)) return (released || await held(tx, ws, personId)) ? 'shared' : null;
  const tags = [...tagsOf(p), NO_CALL_TAG];
  await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [personId, ws, JSON.stringify(tags)]);
  emit('person', personId, 'update', { tags, source: 'callhub' });
  return 'new';
};
// The tag comes off. → whether it was on.
const unmarkNoCall = async (tx, emit, ws, personId) => {
  const p = (await tx.query('select tags from persons where id = $1 and workspace_id = $2 and deleted_at is null for update', [personId, ws])).rows[0];
  if (!p || !tagsOf(p).includes(NO_CALL_TAG)) return false;
  const tags = tagsOf(p).filter((t) => t !== NO_CALL_TAG);
  await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [personId, ws, JSON.stringify(tags)]);
  emit('person', personId, 'update', { tags, source: 'callhub' });
  return true;
};

// The person's rating as their calls and everything else say now. The
// newest call whose answer is mapped rates them — unless something else has
// rated them since (a door knock stands). With no such call they are back
// to what they were before any call rated them: that earlier rating is kept
// on the result of the call that rates them now (rated_over), so a mapping
// made by mistake can be taken back, whatever order things were mapped in.
// → 'rated' | 'unrated' | null (nothing moved)
const CALLS = `callhub_results r join contacts c on c.id = r.contact_id and c.workspace_id = r.workspace_id
  where r.workspace_id = $1 and c.person_id = $2`;
const settleRating = async (tx, ws, personId) => {
  const p = (await tx.query(
    `select rating, to_jsonb(rated_at) #>> '{}' as at from persons where id = $1 and workspace_id = $2 and deleted_at is null for update`, [personId, ws],
  )).rows[0];
  if (!p) return null;
  // Is it a call that rates them now? Then what they were before is on its result.
  const holder = p.at ? (await tx.query(
    `select r.rated_over from ${CALLS} and r.rated_over is not null and c.created_at = $3::timestamptz limit 1`, [ws, personId, p.at],
  )).rows[0] : null;
  const before = holder ? parseJ(holder.rated_over, {}) : { rating: p.rating, at: p.at };
  const base = { rating: before.rating || null, at: before.at || null };
  const top = (await tx.query(
    `select r.id, c.rating, to_jsonb(c.created_at) #>> '{}' as at from ${CALLS} and c.rating is not null
        and ($3::timestamptz is null or c.created_at >= $3::timestamptz) order by c.created_at desc, c.id desc limit 1`, [ws, personId, base.at],
  )).rows[0];
  await tx.query(
    `update callhub_results r set rated_over = null from contacts c
      where c.id = r.contact_id and r.workspace_id = $1 and c.person_id = $2 and r.rated_over is not null and ($3::uuid is null or r.id <> $3)`,
    [ws, personId, top?.id || null],
  );
  if (top) await tx.query('update callhub_results set rated_over = $2::jsonb where id = $1', [top.id, JSON.stringify(base)]);
  const next = top ? { rating: top.rating, at: top.at } : base;
  if (next.rating === (p.rating || null) && next.at === (p.at || null)) return null;
  await tx.query(
    'update persons set rating = $3, rated_at = $4::timestamptz, updated_at = now() where id = $1 and workspace_id = $2', [personId, ws, next.rating, next.at],
  );
  return top ? 'rated' : 'unrated';
};

// One result, once. → { filed: true } | { filed: false } | { duplicate: true }
export const fileResult = async (db, { body, fields }) => {
  // The number: under `contact`, then under `mobile` — the first of them this campaign sent.
  const given = [...new Set([e164(fields.contact), e164(fields.mobile)].filter(Boolean))];
  let phone = given[0] || null;
  let match = null;
  for (const n of given) {
    match = await matchOf(db, n);
    if (match) { phone = n; break; }
  }
  // A result for a number never sent is kept for the desk, with the campaign
  // that last sent anything; a server that never sent anything keeps nothing.
  const ws = match?.workspace_id
    || (await db.query('select workspace_id from callhub_pushes order by created_at desc limit 1')).rows[0]?.workspace_id;
  if (!ws) return { filed: false };
  const key = keyFor(fields, phone);
  const { result } = await runAction(db, { workspaceId: ws, actorId: null, action: RESULT_ACTION }, async (tx, emit) => {
    const again = (await tx.query(
      `select 1 from callhub_results where workspace_id = $1 and key = $2 and created_at > now() - interval '${SAME_CALL_MINUTES} minutes' limit 1`,
      [ws, key],
    )).rows[0];
    if (again) return { duplicate: true };
    const resultId = newId();
    const keep = (extra = {}) => tx.query(
      `insert into callhub_results (id, workspace_id, key, via, push_id, person_id, contact_id, phone, disposition, raw, mapped, tagged)
       values ($1, $2, $3, 'webhook', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [resultId, ws, key, extra.pushId || null, extra.personId || null, extra.contactId || null, phone, fields.disposition || null, JSON.stringify(body),
        extra.mapped || null, Boolean(extra.tagged)],
    );
    const push = match && (await tx.query('select id, outcomes, rating_map from callhub_pushes where id = $1 and workspace_id = $2', [match.push_id, ws])).rows[0];
    const person = push && (await tx.query('select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [match.person_id, ws])).rows[0];
    if (!person) {
      await keep();
      emit('callhub_result', resultId, 'create', { filed: false });
      return { filed: false };
    }
    const mapped = outcomeFor(fields.disposition, parseJ(push.outcomes, {}));
    const outcome = contactOutcome(mapped);
    const pairs = surveyPairs(fields.surveys);
    let rating = ratingFor(pairs, parseJ(push.rating_map, null));
    if (rating && ratingRefusal(await loadScale(tx, ws), rating)) rating = null; // off the campaign's scale since: the answer stays in the note
    // Their own call, in their own numbers: the member who signs in with the agent's email.
    const member = fields.agent.email ? (await tx.query(
      `select u.id from users u join memberships m on m.user_id = u.id and m.workspace_id = $1 where lower(u.email) = $2`,
      [ws, fields.agent.email],
    )).rows[0] : null;
    const contactId = newId();
    const note = noteFor(fields, pairs, { credited: Boolean(member) });
    await tx.query(
      `insert into contacts (id, workspace_id, person_id, channel, outcome, rating, note, source, created_by)
       values ($1, $2, $3, 'phone', $4, $5, $6, 'callhub', $7)`,
      [contactId, ws, person.id, outcome, rating, note, member?.id || null],
    );
    const tagged = mapped === 'do_not_call' && Boolean(await markNoCall(tx, emit, ws, person.id));
    // The call reached that line: everyone on the number is crossed off any
    // open phone bank, by the bank's own rule (a No answer comes back).
    const onNumber = (await tx.query('select distinct person_id from callhub_contacts where workspace_id = $1 and phone = $2', [ws, phone])).rows;
    for (const r of onNumber) {
      await crossOff(tx, { workspaceId: ws, user: { id: member?.id || null } }, { contact: { person_id: r.person_id, channel: 'phone', outcome }, anyCaller: true });
    }
    await keep({ pushId: push.id, personId: person.id, contactId, mapped, tagged });
    // The call's mapped answer rates them now; what they were before is remembered.
    if (rating) await settleRating(tx, ws, person.id);
    emit('contact', contactId, 'create', {
      id: contactId, person_id: person.id, channel: 'phone', outcome, ...(rating ? { rating } : {}), note, source: 'callhub',
      ...(member ? { created_by: member.id } : {}),
    });
    return { filed: true };
  });
  return result;
};

// A delivery that is not a result base.win can read (CallHub's real shape is
// not confirmed): its bytes are kept, unfiled, with the campaign that last
// sent CallHub anything. The same bytes again soon are the same delivery.
const UNREAD_MAX = 20_000;
export const keepUnread = async (db, raw, type = '') => {
  const ws = (await db.query('select workspace_id from callhub_pushes order by created_at desc limit 1')).rows[0]?.workspace_id;
  if (!ws) return { filed: false };
  const key = createHash('sha256').update(raw).digest('hex');
  const { result } = await runAction(db, { workspaceId: ws, actorId: null, action: RESULT_ACTION }, async (tx, emit) => {
    const again = (await tx.query(
      `select 1 from callhub_results where workspace_id = $1 and key = $2 and created_at > now() - interval '${SAME_CALL_MINUTES} minutes' limit 1`, [ws, key],
    )).rows[0];
    if (again) return { duplicate: true };
    const id = newId();
    await tx.query(
      `insert into callhub_results (id, workspace_id, key, via, raw) values ($1, $2, $3, 'webhook', $4)`,
      [id, ws, key, JSON.stringify({ unread: Buffer.from(raw).toString('utf8').slice(0, UNREAD_MAX), type: String(type).slice(0, 120) })],
    );
    emit('callhub_result', id, 'create', { filed: false, read: false });
    return { filed: false };
  });
  return result;
};

// The desk changed a push's outcome table or its support question: the
// results already filed from it follow. Each result remembers how it was
// filed (mapped, tagged, the contact's own outcome and rating), so only the
// ones the change is about are touched, however often the table is saved:
//   · the contact's outcome, and an open phone bank's number with it
//   · "do not call": the people of a row that newly counts as it are tagged;
//     a row that stops counting as it takes its tag off again — from
//     everyone no other result still holds it for, never a tag set by hand
//   · the rating: given where the answer is mapped now, taken back where it
//     no longer is (settleRating)
// At most `refileBatch` results in one write, so a push with thousands of
// results never holds the campaign's other writes up: more says there is a
// rest (runRefileJob does it). Whoever a row put back is about and keeps the
// tag all the same is said, so the desk can look: stay_hand (no call holds
// it — set by hand) and stay_call (another call's result still says so).
// → { changed, tagged, untagged, rated, unrated, more, stay_hand: [person id], stay_call: [person id] }
let refileBatch = 500;
export const _setRefileBatchForTest = (n) => { refileBatch = n; };
export const REFILE_JOB = 'callhub.refile';

export const refile = async (tx, emit, ws, push) => {
  const own = parseJ(push.outcomes, {});
  const map = parseJ(push.rating_map, null);
  const scale = map ? await loadScale(tx, ws) : null;
  // The answers are in the raw result: read only when a rating may move.
  const rates = Boolean(map) || (await tx.query(
    `select 1 from callhub_results r join contacts c on c.id = r.contact_id and c.workspace_id = r.workspace_id
      where r.workspace_id = $1 and r.push_id = $2 and c.rating is not null limit 1`, [ws, push.id],
  )).rows.length > 0;
  const rows = (await tx.query(
    `select r.id as result_id, r.disposition, r.phone, r.mapped, r.tagged, ${rates ? 'r.raw,' : ''}
            c.id, c.person_id, c.outcome, c.rating, c.created_by, to_jsonb(c.created_at) #>> '{}' as at
       from callhub_results r join contacts c on c.id = r.contact_id and c.workspace_id = r.workspace_id
      where r.workspace_id = $1 and r.push_id = $2 order by c.created_at, c.id`, [ws, push.id],
  )).rows;
  const tally = { changed: 0, tagged: 0, untagged: 0, rated: 0, unrated: 0, more: false, stay_hand: [], stay_call: [] };
  const rerate = new Set();
  const released = new Set(); // people a result of theirs held the tag for, and no longer does
  const putBack = new Set(); // people a result of theirs no longer counts as "do not call" for
  let done = 0;
  for (const c of rows) {
    const was = c.mapped || c.outcome;
    const mapped = outcomeFor(c.disposition, own);
    const outcome = contactOutcome(mapped);
    let rating = map ? ratingFor(surveyPairs(fieldsOf(parseJ(c.raw, {})).surveys), map) : null;
    if (rating && ratingRefusal(scale, rating)) rating = null;
    const patch = {};
    if (outcome !== c.outcome) patch.outcome = outcome;
    if ((rating || null) !== (c.rating || null)) patch.rating = rating || null;
    const moved = Object.keys(patch).length > 0;
    if (!moved && mapped === was) continue;
    if (done >= refileBatch) { tally.more = true; break; }
    done += 1;
    if (moved) {
      await tx.query('update contacts set outcome = $3, rating = $4 where id = $1 and workspace_id = $2', [c.id, ws, outcome, rating || null]);
      emit('contact', c.id, 'update', { id: c.id, person_id: c.person_id, ...patch, source: 'callhub' });
      tally.changed += 1;
    }
    let tagged = Boolean(c.tagged);
    if (mapped === 'do_not_call' && was !== 'do_not_call') {
      const mark = await markNoCall(tx, emit, ws, c.person_id, { released: released.has(c.person_id) });
      tagged = Boolean(mark);
      if (mark === 'new') tally.tagged += 1;
    } else if (was === 'do_not_call' && mapped !== 'do_not_call') {
      if (tagged) released.add(c.person_id);
      putBack.add(c.person_id);
      tagged = false;
    }
    await tx.query('update callhub_results set mapped = $2, tagged = $3 where id = $1', [c.result_id, mapped, tagged]);
    if ('rating' in patch) rerate.add(c.person_id);
    if (patch.outcome && c.phone) {
      // The numbers that call settled in an open phone bank follow.
      const onNumber = (await tx.query('select distinct person_id from callhub_contacts where workspace_id = $1 and phone = $2', [ws, c.phone])).rows;
      await recross(tx, ws, { personIds: onNumber.map((r) => r.person_id), at: c.at, was: c.outcome, now: outcome, by: c.created_by || null });
    }
  }
  // Decided once every result of this part has its new reading: the tag
  // comes off whoever no result holds it for any more — someone rung twice
  // with the row's result is one person, untagged once.
  for (const personId of released) {
    if (!(await held(tx, ws, personId)) && await unmarkNoCall(tx, emit, ws, personId)) tally.untagged += 1;
  }
  // Whoever a row put back is about and is still do-not-call: by whose word.
  const still = putBack.size ? (await tx.query(
    'select id from persons where workspace_id = $1 and id = any($2::uuid[]) and deleted_at is null and tags @> $3::jsonb',
    [ws, [...putBack], JSON.stringify([NO_CALL_TAG])],
  )).rows.map((r) => r.id) : [];
  const holding = still.length ? new Set((await tx.query(
    `select distinct person_id from callhub_results where workspace_id = $1 and tagged and mapped = 'do_not_call' and person_id = any($2::uuid[])`, [ws, still],
  )).rows.map((r) => r.person_id)) : new Set();
  for (const personId of still) (holding.has(personId) ? tally.stay_call : tally.stay_hand).push(personId);
  for (const personId of rerate) {
    const how = await settleRating(tx, ws, personId);
    if (how) tally[how] += 1;
  }
  return tally;
};

// The rest of a big push's results, a part at a time, as the person who
// changed the table (the job's payload says who).
export const refileRest = async (tx, ws, pushId, by) => {
  // One at a time: a second save while the rest is still waiting adds nothing.
  const queued = (await tx.query(
    `select 1 from jobs where workspace_id = $1 and kind = $2 and status = 'pending' and payload @> $3::jsonb limit 1`,
    [ws, REFILE_JOB, JSON.stringify({ push_id: pushId })],
  )).rows[0];
  if (!queued) await enqueueJob(tx, { workspaceId: ws, kind: REFILE_JOB, payload: { push_id: pushId, by: by || null } });
};
export const runRefileJob = async (db, job) => {
  const ws = job.workspace_id;
  const { push_id: id, by = null } = job.payload || {};
  const { result } = await runAction(db, { workspaceId: ws, actorId: by, action: 'callhub.map' }, async (tx, emit) => {
    const push = (await tx.query('select * from callhub_pushes where id = $1 and workspace_id = $2 for update', [id, ws])).rows[0];
    if (!push) return { more: false };
    const t = await refile(tx, emit, ws, push);
    if (t.more) await refileRest(tx, ws, id, by);
    return t;
  });
  if (result?.more) runJobsSoon();
};
