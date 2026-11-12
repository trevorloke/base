// More rules a saved filter can hold — People filters, so a list, a send, a
// phone bank and a sweep made from one get them too (lib/audience.js
// personsWhere; the keys are in its FILTER_KEYS):
//   gave=year          gave this calendar year (the campaign's own day)
//   gave=lapsed        gave in an earlier year, and not this one
//   gave=never         never gave
//   gave=min:500       gave at least $500 in one calendar year, any year
//   member=now         a membership running today
//   member=lapsed      a membership that ended, and none running
//   answer=<question>:<value>   their latest answer to that survey question:
//                      a choice's label · yes | no · 1–5 · any (answered it)
//   shift=came:30      checked in at a shift that started in the last 30 days
//   shift=missed:30    marked a no-show at one
//   since=2026-10-01   added to base.win on or after that day
// (On another list, or not: list= and notlist= — ext/lists.)
// A value it doesn't understand matches nobody, never everybody. A volunteer
// never sorts people by money, memberships, answers or attendance: for them
// those four match nobody.
//
// Each rule is found through an index on a city's voter file — written as
// "exists" on the person's own rows (a look-up from the person, or a join
// the planner starts from the small table), and min: as one pass over the
// gifts. The indexes on the core's tables are below; the surveys' is in
// ext/surveys/sql.js; memberships already have theirs. When someone was
// added is a block-range index: people are added in time order, it costs
// little to keep, and it is never a way to read people in order (an
// ordinary one on created_at was: other look-ups then walked the whole
// campaign through it).
//
//   GET /audience/choices   desk: what the rule builder offers that the
//       screens can't know — { year, questions: [{ id, text, kind, options,
//       survey }] } (questions still on a survey that isn't archived)
import { Hono } from 'hono';
import { decide } from '../../lib/perms.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { fromLocal } from '../../lib/tzsql.js';

export const sql = `
create index if not exists gifts_ws_person_date_idx on gifts (workspace_id, person_id, date) where deleted_at is null;
create index if not exists sassign_ws_person_idx on shift_assignments (workspace_id, person_id);
create index if not exists persons_created_brin_idx on persons using brin (created_at) where deleted_at is null;
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const tzOf = (ctx) => {
  const tz = ctx.workspace?.settings?.tz || DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
};
// Today, YYYY-MM-DD, in the campaign's own day.
export const todayOf = (ctx, now = new Date()) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tzOf(ctx), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
// A real day on the calendar (a month 13 is not one; nor is a year the database can't hold).
const isDay = (s) => {
  if (!YMD.test(s) || s < '1900-01-01') return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const GIFT = 'from gifts g where g.workspace_id = p.workspace_id and g.person_id = p.id and g.deleted_at is null';
const TERM = 'from member_terms t where t.workspace_id = p.workspace_id and t.person_id = p.id and t.voided_at is null';

const gaveWhere = (v, ctx, next) => {
  const y0 = `${todayOf(ctx).slice(0, 4)}-01-01`;
  if (v === 'year') return ` and exists (select 1 ${GIFT} and g.date >= ${next(y0)}::date)`;
  if (v === 'lapsed') {
    const from = next(y0);
    return ` and exists (select 1 ${GIFT} and g.date < ${from}::date) and not exists (select 1 ${GIFT} and g.date >= ${from}::date)`;
  }
  if (v === 'never') return ` and not exists (select 1 ${GIFT})`;
  const m = /^min:(\d{1,7})$/.exec(v);
  if (m && Number(m[1]) > 0) {
    // One pass over the gifts, by donor and year — never a sum per person on the list.
    return ` and p.id in (select g.person_id from gifts g where g.workspace_id = ${next(ctx.workspaceId)}::uuid and g.deleted_at is null
               group by g.person_id, date_part('year', g.date) having sum(g.amount_cents) >= ${next(Number(m[1]) * 100)}::bigint)`;
  }
  return null;
};

const memberWhere = (v, ctx, next) => {
  if (v !== 'now' && v !== 'lapsed') return null;
  const day = next(todayOf(ctx));
  if (v === 'now') return ` and exists (select 1 ${TERM} and t.starts_on <= ${day}::date and t.ends_on >= ${day}::date)`;
  return ` and exists (select 1 ${TERM} and t.ends_on < ${day}::date) and not exists (select 1 ${TERM} and t.ends_on >= ${day}::date)`;
};

// Their latest answer to the question (as the survey's results count it)
// is this one.
const answerWhere = async (v, db, ctx, next) => {
  const at = v.indexOf(':');
  const id = at > 0 ? v.slice(0, at).toLowerCase() : '';
  const want = at > 0 ? v.slice(at + 1).trim() : '';
  if (!UUID_RE.test(id) || !want) return null;
  const q = (await db.query('select id, kind, options, retired_options from survey_questions where id = $1 and workspace_id = $2', [id, ctx.workspaceId])).rows[0];
  if (!q) return null;
  let value = null;
  if (want !== 'any') {
    if (q.kind === 'yesno' && (want === 'yes' || want === 'no')) value = `r.value = ${next(JSON.stringify(want === 'yes'))}::jsonb`;
    else if (q.kind === 'scale' && /^[1-5]$/.test(want)) value = `r.value = ${next(want)}::jsonb`;
    else if (q.kind === 'choice' || q.kind === 'choices') {
      if (![...parseJ(q.options, []), ...parseJ(q.retired_options, [])].includes(want)) return null;
      value = `r.value ${q.kind === 'choices' ? '@>' : '='} ${next(JSON.stringify(want))}::jsonb`;
    } else return null;
  }
  const qid = next(q.id);
  return ` and exists (select 1 from survey_responses r
             where r.workspace_id = p.workspace_id and r.person_id = p.id and r.question_id = ${qid}::uuid${value ? ` and ${value}` : ''}
               and not exists (select 1 from survey_responses n
                                where n.workspace_id = r.workspace_id and n.person_id = r.person_id and n.question_id = r.question_id
                                  and (n.created_at, n.id) > (r.created_at, r.id)))`;
};

const SHIFT_STATUS = { came: 'completed', missed: 'no_show' };
const shiftWhere = (v, next) => {
  const m = /^(came|missed):(\d{1,3})$/.exec(v);
  const days = m ? Number(m[2]) : 0;
  if (!m || days < 1 || days > 730) return null;
  return ` and exists (select 1 from shift_assignments a join shifts s on s.id = a.shift_id
             where a.workspace_id = p.workspace_id and a.person_id = p.id and a.status = ${next(SHIFT_STATUS[m[1]])}
               and s.deleted_at is null and s.starts_at <= now() and s.starts_at >= now() - make_interval(days => ${next(days)}::int))`;
};

const personsWhere = async (db, ctx, query, w) => {
  const next = (v) => { w.params.push(v); return `$${w.params.length}`; };
  const add = (sql) => { w.where += sql ?? ' and false'; };
  const desk = ctx.role !== 'volunteer';
  // Who gave is the Donations area's: a desk role the manager denied it
  // can't sort People by it (it matches nobody) — but a saved list read on
  // their behalf (a send, a count) is read whole, as the desk saved it.
  const money = desk && (Boolean(ctx.listTrail?.length) || (!ctx.perms || decide(ctx.perms, 'money') !== false));

  const gave = str(query?.gave, 20).toLowerCase();
  if (gave) add(money ? gaveWhere(gave, ctx, next) : null);
  const member = str(query?.member, 10).toLowerCase();
  if (member) add(desk ? memberWhere(member, ctx, next) : null);
  const answer = str(query?.answer);
  if (answer) add(desk ? await answerWhere(answer, db, ctx, next) : null);
  const shift = str(query?.shift, 12).toLowerCase();
  if (shift) add(desk ? shiftWhere(shift, next) : null);

  const since = str(query?.since, 10);
  if (since) add(isDay(since) ? ` and p.created_at >= ${fromLocal(`${next(since)}::date::timestamp`, `${next(tzOf(ctx))}::text`)}` : null);
};

export const hooks = { personsWhere };

export const api = new Hono();
api.get('/audience/choices', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role === 'volunteer') return c.json({ error: 'desk only' }, 403);
  const { rows } = await c.get('db').query(
    `select q.id, q.kind, q.text, q.options, s.name as survey
       from survey_questions q join surveys s on s.id = q.survey_id
      where q.workspace_id = $1 and q.removed_at is null and s.archived_at is null
      order by s.created_at desc, q.position, q.created_at limit 200`, [ctx.workspaceId],
  );
  return c.json({
    year: Number(todayOf(ctx).slice(0, 4)),
    questions: rows.map((q) => ({ id: q.id, kind: q.kind, text: q.text, survey: q.survey, options: parseJ(q.options, []) })),
  });
});
export const deskOnlyReads = ['/audience/choices'];
