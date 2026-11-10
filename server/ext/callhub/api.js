// GET /callhub/preview?list=<id> | ?bank=<id>   desk: before sending — how many numbers would go, for how many
//                                                people, how many are left out, and how many days CallHub needs
// GET /callhub/pushes?list=<id> | ?bank=<id>    desk: what was sent from this list or bank, newest first — how far
//                                                each is, and its results: how many came back, what each of
//                                                CallHub's results counts as, and the survey answers seen
// Never a phone number, a name or a key: counts and CallHub's own words only.
import { Hono } from 'hono';
import { jobRunnerOn } from '../../lib/jobs.js';
import { callhubOn } from './callhub.js';
import { audienceOf, notToCall, sourceOf } from './people.js';
import { jobLive, pushOut } from './push.js';
import { fieldsOf, norm, outcomeFor, surveyPairs } from './results.js';

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
// the pattern table says), and each survey question seen with its answers
// and the rating an answer is mapped to (support: the question that rates).
const resultsOf = async (db, ws, push) => {
  const own = parseJ(push.outcomes, {});
  const map = parseJ(push.rating_map, null);
  const byResult = new Map();
  let results = 0;
  for (const r of (await db.query(
    'select disposition, count(*)::int as n from callhub_results where workspace_id = $1 and push_id = $2 group by disposition', [ws, push.id],
  )).rows) {
    results += r.n;
    const key = norm(r.disposition);
    const row = byResult.get(key) || {
      disposition: String(r.disposition || '').trim(), n: 0, outcome: outcomeFor(r.disposition, own), auto: !Object.hasOwn(own, key), suggested: outcomeFor(r.disposition),
    };
    row.n += r.n;
    byResult.set(key, row);
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

api.get('/callhub/pushes', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  const no = deskOnly(c);
  if (no) return no;
  const from = sourceIn(c);
  if (!from) return c.json({ error: 'a list or a phone bank' }, 400);
  const rows = (await db.query(
    `select p.*, u.name as by from callhub_pushes p left join users u on u.id = p.created_by
      where p.workspace_id = $1 and p.source_kind = $2 and p.source_id = $3 order by p.created_at desc limit 5`,
    [ws, from.list_id ? 'list' : 'bank', from.list_id || from.bank_id],
  )).rows;
  const pushes = [];
  for (const p of rows) {
    // Still going with no job left to do it: it stopped part-way (Carry on restarts it).
    const stalled = (p.status === 'queued' || p.status === 'sending') && jobRunnerOn() && !(await jobLive(db, ws, p.id));
    pushes.push({ ...pushOut(p), by: p.by || null, stalled, ...(await resultsOf(db, ws, p)) });
  }
  // running: whether this server does background work at all (STARBASE_JOBS=off: a push waits).
  return c.json({ on: callhubOn(), running: jobRunnerOn(), pushes });
});
