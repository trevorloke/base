// GET /callhub/preview?list=<id> | ?bank=<id>   desk: before sending — how many numbers would go, for how many
//                                                people, how many are left out, and how many days CallHub needs
// GET /callhub/pushes?list=<id> | ?bank=<id>    desk: what was sent from this list or bank, newest first — how far
//                                                each is (its clock times in words, in the campaign's own time),
//                                                and its results: how many came back, what each of CallHub's
//                                                results counts as, and the survey answers seen
// Never a phone number or a key: counts, CallHub's own words, and — so the
// desk can find and fix them — the names of people whose number CallHub
// would not take, or still holds though nobody here blocks it now.
import { Hono } from 'hono';
import { jobRunnerOn } from '../../lib/jobs.js';
import { timeZone } from '../../lib/org.js';
import { toLocal } from '../../lib/tzsql.js';
import { e164, NO_CALL_TAG, NO_CONTACT_TAG } from '../texting/rules.js';
import { callhubOn } from './callhub.js';
import { heldNumbers } from './dnc.js';
import { audienceOf, notToCall, sourceOf, whoseNumbers } from './people.js';
import { jobLive, pushOut } from './push.js';
import { fieldsOf, norm, outcomeFor, REFILE_JOB, surveyPairs } from './results.js';

export const api = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAILY = 3600; // CallHub's documented limit on contacts a day
const parseJ = (v, d) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) ?? d; } catch { return d; } };
// → { list_id } | { bank_id } | null
const sourceIn = (c) => {
  const list = c.req.query('list');
  const bank = c.req.query('bank');
  if (list && !bank && UUID.test(list)) return { list_id: list };
  if (bank && !list && UUID.test(bank)) return { bank_id: bank };
  return null;
};
const deskOnly = (c) => (c.get('ctx').role === 'volunteer' ? c.json({ error: 'desk only' }, 403) : null);

api.get('/callhub/preview', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  const no = deskOnly(c);
  if (no) return no;
  const from = sourceIn(c);
  if (!from) return c.json({ error: 'a list or a phone bank' }, 400);
  try {
    const src = await sourceOf(db, ctx, from);
    const a = audienceOf(src.rows, await notToCall(db, ctx.workspaceId));
    return c.json({ name: src.name, numbers: a.numbers.length, people: a.people, left_out: a.leftOut, days: Math.max(1, Math.ceil(a.numbers.length / DAILY)) });
  } catch (e) {
    if (e.status) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// A push's results, counted: each of CallHub's results with what it counts
// as (auto: by the pattern table, not the desk's own word; suggested: what
// the pattern table says; people: how many people have that result — who a
// change to the row is about), and each survey question seen with its answers
// and the rating an answer is mapped to (support: the question that rates).
const resultsOf = async (db, ws, push) => {
  const own = parseJ(push.outcomes, {});
  const map = parseJ(push.rating_map, null);
  const byResult = new Map();
  let results = 0;
  const spelt = new Map(); // a result's spellings ("No Answer", "no answer"), when it has more than one
  for (const r of (await db.query(
    `select disposition, count(*)::int as n, count(distinct person_id)::int as people
       from callhub_results where workspace_id = $1 and push_id = $2 group by disposition`, [ws, push.id],
  )).rows) {
    results += r.n;
    const key = norm(r.disposition);
    const row = byResult.get(key) || {
      disposition: String(r.disposition || '').trim(), n: 0, people: 0, outcome: outcomeFor(r.disposition, own), auto: !Object.hasOwn(own, key), suggested: outcomeFor(r.disposition),
    };
    row.n += r.n;
    row.people += r.people;
    byResult.set(key, row);
    spelt.set(key, [...(spelt.get(key) || []), r.disposition]);
  }
  // Someone with the result under two spellings is one person.
  for (const [key, ways] of spelt) {
    if (ways.length < 2) continue;
    byResult.get(key).people = (await db.query(
      `select count(distinct person_id)::int as n from callhub_results
        where workspace_id = $1 and push_id = $2 and (disposition = any($3::text[]) or ($4::boolean and disposition is null))`,
      [ws, push.id, ways.filter((w) => w != null), ways.some((w) => w == null)],
    )).rows[0].n;
  }
  // The questions, from the newest results (their answers are in the raw result).
  const questions = new Map();
  if (results) {
    for (const r of (await db.query(
      'select raw from callhub_results where workspace_id = $1 and push_id = $2 order by created_at desc limit 500', [ws, push.id],
    )).rows) {
      for (const [q, a] of surveyPairs(fieldsOf(parseJ(r.raw, {})).surveys)) {
        const qq = questions.get(norm(q)) || { question: q, answers: new Map() };
        const aa = qq.answers.get(norm(a)) || { answer: a, n: 0, rating: (map?.question === norm(q) && map.answers?.[norm(a)]) || null };
        aa.n += 1;
        qq.answers.set(norm(a), aa);
        questions.set(norm(q), qq);
      }
    }
  }
  const byCount = (x, y) => y.n - x.n || String(x.disposition ?? x.answer).localeCompare(String(y.disposition ?? y.answer), 'en', { sensitivity: 'base' });
  return {
    results,
    dispositions: [...byResult.values()].sort(byCount),
    questions: [...questions.values()].slice(0, 12).map((q) => ({
      question: q.question, support: Boolean(map?.question) && map.question === norm(q.question), answers: [...q.answers.values()].sort(byCount).slice(0, 12),
    })),
    rating: map?.question ? { question: map.label || map.question } : null,
  };
};

// A clock time in words, in the campaign's own time (the clock the
// phonebook's name was stamped with): "3:42 pm" today, "Nov 9, 3:42 pm"
// another day. `tz` is the query's parameter holding the time zone.
const whenWords = (col, tz) => {
  const local = toLocal(col, tz);
  return `case when ${col} is null then null
    when (${local})::date = (${toLocal('now()', tz)})::date then to_char(${local}, 'FMHH12:MI am')
    else to_char(${local}, 'Mon FMDD, FMHH12:MI am') end`;
};
// People are named so the desk can find them: all of them, up to this many
// (the page shows a few and the rest on a tap; `more` counts any beyond).
const NAMED = 100;
const named = (people) => ({ people: people.slice(0, NAMED), more: Math.max(0, people.length - NAMED) });
// Whose numbers CallHub would not take in this push (the first by name on each).
const refusedPeople = async (db, ws, pushId) => (await db.query(
  `select p.id, p.name from callhub_contacts c join persons p on p.id = c.person_id and p.deleted_at is null
    where c.push_id = $1 and c.workspace_id = $2 and c.refused is not null and c.first_on_number
    order by lower(p.name), p.id limit ${NAMED}`, [pushId, ws],
)).rows.map((r) => ({ id: r.id, name: r.name }));

// The campaign's do-not-call numbers CallHub would not take: how many, its
// words for the last, and whose they are (people tagged on that number; a
// number that only replied STOP has nobody). Only what is still wanted
// today: a number whose tag came off again is nothing CallHub needs to
// take. null when there are none.
const notTaken = async (db, ws) => {
  const refused = (await db.query(
    `select phone, category, refused_note from callhub_dnc where workspace_id = $1 and refused is not null and (refused | category) <> category order by sent_at desc`, [ws],
  )).rows;
  if (!refused.length) return null;
  const blocked = await notToCall(db, ws);
  const rows = refused.filter((r) => ((blocked.get(r.phone) || 0) | r.category) !== r.category);
  if (!rows.length) return null;
  const numbers = new Set(rows.map((r) => r.phone));
  const tagged = (await db.query(
    `select id, name, phone from persons where workspace_id = $1 and deleted_at is null and coalesce(phone, '') <> ''
        and (tags @> $2::jsonb or tags @> $3::jsonb) order by lower(name), id`,
    [ws, JSON.stringify([NO_CONTACT_TAG]), JSON.stringify([NO_CALL_TAG])],
  )).rows;
  return { n: rows.length, note: rows[0].refused_note || null, ...named(tagged.filter((p) => numbers.has(e164(p.phone))).map((p) => ({ id: p.id, name: p.name }))) };
};
// The numbers CallHub still holds that nobody here blocks any more, and
// that base.win could not take off itself (dnc.js): how many, and whose
// they are — whoever is on file with the number — so someone can take them
// off in CallHub. null when there are none.
const held = async (db, ws) => {
  const numbers = await heldNumbers(db, ws);
  return numbers.length ? { n: numbers.length, ...named(await whoseNumbers(db, ws, numbers)) } : null;
};
// Whether results already in are still being moved after a change to the push's table.
const moving = async (db, ws, id) => (await db.query(
  `select 1 from jobs where workspace_id = $1 and kind = $2 and status in ('pending', 'running') and payload @> $3::jsonb limit 1`,
  [ws, REFILE_JOB, JSON.stringify({ push_id: id })],
)).rows.length > 0;

api.get('/callhub/pushes', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  const no = deskOnly(c);
  if (no) return no;
  const from = sourceIn(c);
  if (!from) return c.json({ error: 'a list or a phone bank' }, 400);
  const rows = (await db.query(
    `select p.*, u.name as by, ${whenWords('p.sent_at', '$4::text')} as sent_words, ${whenWords('p.resume_at', '$4::text')} as resume_words
       from callhub_pushes p left join users u on u.id = p.created_by
      where p.workspace_id = $1 and p.source_kind = $2 and p.source_id = $3 order by p.created_at desc limit 5`,
    [ws, from.list_id ? 'list' : 'bank', from.list_id || from.bank_id, timeZone()],
  )).rows;
  const pushes = [];
  for (const p of rows) {
    // Still going with no job left to do it: it stopped part-way (Carry on restarts it).
    const stalled = (p.status === 'queued' || p.status === 'sending') && jobRunnerOn() && !(await jobLive(db, ws, p.id));
    pushes.push({
      ...pushOut(p), by: p.by || null, stalled, sent_words: p.sent_words || null, resume_words: p.resume_words || null,
      refused_people: p.refused ? await refusedPeople(db, ws, p.id) : [], moving: await moving(db, ws, p.id),
      ...(await resultsOf(db, ws, p)),
    });
  }
  // running: whether this server does background work at all (STARBASE_JOBS=off: a push waits).
  // not_taken: the campaign's do-not-call numbers CallHub would not take.
  // held: the numbers CallHub still holds that nobody here blocks now.
  return c.json({ on: callhubOn(), running: jobRunnerOn(), pushes, not_taken: await notTaken(db, ws), held: await held(db, ws) });
});
