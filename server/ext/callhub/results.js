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
//                             read: what is already in follows.
//
// A rating only ever comes from a survey answer the desk mapped
// (callhub.map); nothing here guesses one. Every result is kept as it came
// (callhub_results.raw).
import { createHash } from 'node:crypto';
import { runAction, newId } from '../../lib/events.js';
import { e164, NO_CALL_TAG } from '../texting/rules.js';
import { crossOff } from '../banks/actions.js';
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

const markNoCall = async (tx, emit, ws, personId) => {
  const p = (await tx.query('select tags from persons where id = $1 and workspace_id = $2 and deleted_at is null for update', [personId, ws])).rows[0];
  if (!p || tagsOf(p).includes(NO_CALL_TAG)) return;
  const tags = [...tagsOf(p), NO_CALL_TAG];
  await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [personId, ws, JSON.stringify(tags)]);
  emit('person', personId, 'update', { tags, source: 'callhub' });
};

// One result, once. → { filed: true } | { filed: false } | { duplicate: true }
export const fileResult = async (db, { body, fields }) => {
  const phone = e164(fields.contact) || e164(fields.mobile);
  const match = phone ? await matchOf(db, phone) : null;
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
      `insert into callhub_results (id, workspace_id, key, via, push_id, person_id, contact_id, phone, disposition, raw)
       values ($1, $2, $3, 'webhook', $4, $5, $6, $7, $8, $9)`,
      [resultId, ws, key, extra.pushId || null, extra.personId || null, extra.contactId || null, phone, fields.disposition || null, JSON.stringify(body)],
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
    if (rating) await tx.query('update persons set rating = $3, rated_at = now(), updated_at = now() where id = $1 and workspace_id = $2', [person.id, ws, rating]);
    if (mapped === 'do_not_call') await markNoCall(tx, emit, ws, person.id);
    // The call reached that line: everyone on the number is crossed off any
    // open phone bank, by the bank's own rule (a No answer comes back).
    const onNumber = (await tx.query('select distinct person_id from callhub_contacts where workspace_id = $1 and phone = $2', [ws, phone])).rows;
    for (const r of onNumber) {
      await crossOff(tx, { workspaceId: ws, user: { id: member?.id || null } }, { contact: { person_id: r.person_id, channel: 'phone', outcome }, anyCaller: true });
    }
    await keep({ pushId: push.id, personId: person.id, contactId });
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
// results already filed from it follow — the contact's outcome, and its
// rating where the answer is mapped now. A person's own rating moves only
// when nothing newer has rated them (a door knock since stands), and a
// rating is never taken away. → how many contacts changed.
export const refile = async (tx, emit, ws, push) => {
  const own = parseJ(push.outcomes, {});
  const map = parseJ(push.rating_map, null);
  const scale = map ? await loadScale(tx, ws) : null;
  const rows = (await tx.query(
    `select r.disposition, r.raw, c.id, c.person_id, c.outcome, c.rating, c.created_at
       from callhub_results r join contacts c on c.id = r.contact_id and c.workspace_id = r.workspace_id
      where r.workspace_id = $1 and r.push_id = $2 order by c.created_at, c.id`, [ws, push.id],
  )).rows;
  let changed = 0;
  for (const c of rows) {
    const mapped = outcomeFor(c.disposition, own);
    const outcome = contactOutcome(mapped);
    let rating = map ? ratingFor(surveyPairs(fieldsOf(parseJ(c.raw, {})).surveys), map) : null;
    if (rating && ratingRefusal(scale, rating)) rating = null;
    const patch = {};
    if (outcome !== c.outcome) patch.outcome = outcome;
    if (rating && rating !== c.rating) patch.rating = rating;
    if (mapped === 'do_not_call') await markNoCall(tx, emit, ws, c.person_id);
    if (!Object.keys(patch).length) continue;
    await tx.query('update contacts set outcome = $3, rating = $4 where id = $1 and workspace_id = $2', [c.id, ws, outcome, patch.rating || c.rating]);
    if (patch.rating) {
      await tx.query(
        `update persons set rating = $3, rated_at = $4, updated_at = now()
          where id = $1 and workspace_id = $2 and deleted_at is null and (rated_at is null or rated_at <= $4)`,
        [c.person_id, ws, patch.rating, c.created_at],
      );
    }
    emit('contact', c.id, 'update', { id: c.id, person_id: c.person_id, ...patch, source: 'callhub' });
    changed += 1;
  }
  return changed;
};
