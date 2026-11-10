// Desk reads for ladders (mounted under /api, signed in). Volunteers are
// refused all of them — here and by deskOnlyReads in index.js.
//
//   GET /ladders                    the list with counts, open follow-ups,
//                                   engagement levels, and the builder's
//                                   pickers (tags, what the website offers,
//                                   surveys)
//   GET /ladders/followups          open follow-ups (+ the last done): who
//                                   has each and its clock, by organizer
//                                   (?who=<user id> | none narrows the list),
//                                   and the time to first contact over 30 days
//   GET /ladders/followups/count    { open, overdue } for Today
//   GET /ladders/:id                one ladder + who's on it, and where
//   GET /persons/:id/ladders        a person's level and their ladders
import { Hono } from 'hono';
import { emailConfigured, textConfigured } from '../../lib/notify.js';
import { TRIGGERS, GOALS, parseJson } from './shape.js';
import { levelFor, levelCounts } from './levels.js';
import { WEB_KINDS, WEB_WORDS, campaignOf, campaignWords, campaignsOf } from '../webdid/words.js';

export const api = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

api.use('/ladders/*', async (c, next) => {
  if (c.get('ctx').role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  await next();
});
api.use('/ladders', async (c, next) => {
  if (c.get('ctx').role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  await next();
});

// What the builder can point a trigger at: tags in use, what can be done on
// the website (each kind, and each petition or pledge), and the surveys.
const options = async (db, ws) => ({
  tags: (await db.query(
    `select t, count(*)::int as n from persons p, jsonb_array_elements_text(
       case when jsonb_typeof(p.tags) = 'array' then p.tags else '[]'::jsonb end) as t
     where p.workspace_id = $1 and p.deleted_at is null and t <> 'sample'
     group by t order by n desc, t limit 100`, [ws],
  )).rows.map((r) => r.t),
  web: [
    ...WEB_KINDS.map((k) => ({ value: k, label: WEB_WORDS[k] })),
    ...(await campaignsOf(db, ws)).map((c) => ({ value: `campaign:${c.id}`, label: campaignWords(c) })),
  ],
  surveys: (await db.query(
    'select id, name from surveys where workspace_id = $1 and archived_at is null order by created_at desc limit 100', [ws],
  )).rows.map((r) => ({ value: r.id, label: r.name })),
});

// What a trigger names, in words: the tag ("host"), what was done on the
// website ("Signed a petition", "Signed: SkyTrain to Langley"), the survey.
const triggerWhat = (l, opts) => {
  const ref = l.trigger_ref || null;
  if (!ref) return null;
  if (l.trigger_kind === 'web') {
    return opts?.web?.find((o) => o.value === ref)?.label || (campaignOf(ref) ? 'Signed a petition or pledge (no longer listed)' : WEB_WORDS[ref] || ref);
  }
  if (l.trigger_kind === 'survey') return opts?.surveys?.find((o) => o.value === ref)?.label || 'A survey (archived)';
  return ref;
};

const ladderOut = (l, opts) => ({
  id: l.id,
  name: l.name,
  trigger: { kind: l.trigger_kind, ref: l.trigger_ref || null, label: TRIGGERS[l.trigger_kind]?.label || l.trigger_kind, what: triggerWhat(l, opts) },
  goal: l.goal ? { kind: l.goal, label: GOALS[l.goal]?.label || l.goal } : null,
  steps: parseJson(l.steps, []),
  active: l.active,
  reentry: l.reentry,
  created_at: l.created_at,
});

// In progress (on it, paused included) · finished (reached: by the goal) ·
// waiting on email or texting, per ladder.
const runCounts = async (db, ws, ladderId = null) => Object.fromEntries((await db.query(
  `select ladder_id,
     (count(*) filter (where status <> 'done'))::int as in_progress,
     (count(*) filter (where status = 'done'))::int as finished,
     (count(*) filter (where status = 'done' and r.log -> -1 ->> 'result' = 'goal'))::int as reached,
     (count(*) filter (where status <> 'done' and wait = 'email'))::int as waiting_email,
     (count(*) filter (where status <> 'done' and wait = 'text'))::int as waiting_text
   from ladder_runs r join persons p on p.id = r.person_id and p.deleted_at is null
   where r.workspace_id = $1 and ($2::uuid is null or r.ladder_id = $2)
   group by ladder_id`,
  [ws, ladderId],
)).rows.map((r) => [r.ladder_id, r]));

api.get('/ladders', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const opts = await options(db, ws);
  const rows = (await db.query(
    'select * from ladders where workspace_id = $1 and deleted_at is null order by created_at', [ws],
  )).rows;
  const counts = await runCounts(db, ws);
  const open = (await db.query(
    "select count(*)::int as n from ladder_followups where workspace_id = $1 and status = 'open'", [ws],
  )).rows[0].n;
  return c.json({
    ladders: rows.map((l) => ({
      ...ladderOut(l, opts),
      inProgress: counts[l.id]?.in_progress || 0,
      finished: counts[l.id]?.finished || 0,
      reached: counts[l.id]?.reached || 0,
      waitingEmail: counts[l.id]?.waiting_email || 0,
      waitingText: counts[l.id]?.waiting_text || 0,
    })),
    followups: open,
    levels: await levelCounts(db, ws),
    emailConfigured: emailConfigured(),
    textConfigured: textConfigured(),
    options: opts,
  });
});

// What the card shows of each thing they did (never the rows it came from).
const DID_KEYS = ['kind', 'from', 'words', 'roles', 'availability', 'note', 'topic', 'message', 'shift', 'place', 'asked_by', 'source', 'at'];
const didOf = (detail) => (parseJson(detail, {})?.did || []).map((d) => Object.fromEntries(DID_KEYS.filter((k) => d?.[k] != null).map((k) => [k, d[k]])));
const followupRow = (r) => ({
  id: r.id, text: r.text, status: r.status, created_at: r.created_at, done_at: r.done_at,
  kind: r.kind || 'ladder',
  did: didOf(r.detail),
  due_at: r.due_at || null,
  routed: r.routed || null,
  assigned: r.assigned_to ? { id: r.assigned_to, name: r.assigned_name || 'Someone who left' } : null,
  contacted_at: r.contacted_at || null,
  done_by_name: r.done_by_name || null,
  // tags: so the list offers no Call for someone tagged do-not-call.
  person: { id: r.person_id, name: r.person_name, phone: r.person_phone, tags: parseJson(r.person_tags, []) },
  ladder: r.ladder_id ? { id: r.ladder_id, name: r.ladder_name } : null,
});

api.get('/ladders/followups/count', async (c) => {
  const ctx = c.get('ctx');
  const r = (await c.get('db').query(
    `select count(*)::int as n, (count(*) filter (where f.due_at < now()))::int as overdue
     from ladder_followups f join persons p on p.id = f.person_id
     where f.workspace_id = $1 and f.status = 'open' and p.deleted_at is null`, [ctx.workspaceId],
  )).rows[0];
  return c.json({ open: r.n, overdue: r.overdue });
});

const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATS_DAYS = 30;

api.get('/ladders/followups', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  // ?who=<user id>: one organizer's; ?who=none: those nobody has yet.
  const who = c.req.query('who') || '';
  const params = [ws];
  let mine = '';
  if (who === 'none') mine = ' and f.assigned_to is null';
  else if (UUID_ANY.test(who)) { params.push(who); mine = ` and f.assigned_to = $${params.length}`; }
  const sel = `select f.*, p.name as person_name, p.phone as person_phone, p.tags as person_tags, l.name as ladder_name,
      a.name as assigned_name, d.name as done_by_name
    from ladder_followups f join persons p on p.id = f.person_id and p.deleted_at is null
    left join ladders l on l.id = f.ladder_id
    left join users a on a.id = f.assigned_to
    left join users d on d.id = f.done_by
    where f.workspace_id = $1`;
  const open = (await db.query(`${sel}${mine} and f.status = 'open' order by f.due_at nulls last, f.created_at limit 500`, params)).rows;
  const done = (await db.query(`${sel}${mine} and f.status = 'done' order by f.done_at desc limit 50`, params)).rows;
  // Open ones by organizer: who has how many, how many past their day.
  const by = (await db.query(
    `select f.assigned_to as id, u.name, count(*)::int as open,
            (count(*) filter (where f.due_at < now()))::int as overdue
     from ladder_followups f join persons p on p.id = f.person_id and p.deleted_at is null
     left join users u on u.id = f.assigned_to
     where f.workspace_id = $1 and f.status = 'open'
     group by f.assigned_to, u.name
     order by (f.assigned_to is null), count(*) desc, u.name`,
    [ws],
  )).rows.map((r) => ({ id: r.id || null, name: r.id ? r.name || 'Someone who left' : null, open: r.open, overdue: r.overdue }));
  // Speed to lead over the last 30 days: how long until someone first
  // reached them, and how many inside the day.
  const s = (await db.query(
    `select count(*)::int as made,
            (count(*) filter (where f.contacted_at is not null))::int as reached,
            (count(*) filter (where f.contacted_at is not null and f.contacted_at <= f.created_at + interval '24 hours'))::int as in_a_day,
            (count(*) filter (where f.status = 'open'))::int as waiting,
            percentile_cont(0.5) within group (order by extract(epoch from f.contacted_at - f.created_at))
              filter (where f.contacted_at is not null) as median_s
     from ladder_followups f join persons p on p.id = f.person_id and p.deleted_at is null
     where f.workspace_id = $1 and f.kind is not null and f.created_at > now() - make_interval(days => $2::int)`,
    [ws, STATS_DAYS],
  )).rows[0];
  return c.json({
    open: open.map(followupRow),
    done: done.map(followupRow),
    by,
    stats: {
      days: STATS_DAYS,
      made: s.made,
      reached: s.reached,
      in_a_day: s.in_a_day,
      waiting: s.waiting,
      median_hours: s.median_s == null ? null : Math.round((Number(s.median_s) / 3600) * 10) / 10,
    },
  });
});

// Where a run is, from its row and log: what the screens need to say it.
const runOut = (r, steps) => {
  const log = parseJson(r.log, []);
  return {
    id: r.id,
    status: r.status,
    step: Number(r.step),
    steps: steps.length,
    stepKind: steps[r.step]?.kind || null,
    wait: r.wait || null,
    next_at: r.next_at || null,
    last: log.length ? log[log.length - 1] : null,
    skipped: log.filter((e) => e.result === 'skipped').map((e) => ({ step: e.step, kind: e.kind, reason: e.reason })),
    // What each step did (kind, result, reason, when) — no addresses, no
    // message text. 'Sending' shows only while it's the latest word.
    log: log.filter((e, i) => e.result !== 'sending' || i === log.length - 1).slice(-20).map((e) => ({ step: e.step, kind: e.kind, result: e.result, reason: e.reason || null, tag: e.tag || null, until: e.until || null, goal: e.goal || null, at: e.at })),
    started_at: r.started_at,
    finished_at: r.finished_at || null,
  };
};

api.get('/ladders/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const l = (await db.query(
    'select * from ladders where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!l) return c.json({ error: 'not found' }, 404);
  const opts = await options(db, ctx.workspaceId);
  const ladder = ladderOut(l, opts);
  const runs = (await db.query(
    `select r.*, p.name as person_name from ladder_runs r join persons p on p.id = r.person_id and p.deleted_at is null
     where r.workspace_id = $1 and r.ladder_id = $2
     order by (r.status = 'done'), r.started_at desc limit 500`,
    [ctx.workspaceId, l.id],
  )).rows;
  const counts = (await runCounts(db, ctx.workspaceId, l.id))[l.id];
  // Email steps go only to these: addresses on the list as subscribed.
  const emailYes = (await db.query(
    "select count(*)::int as n from subscriptions where workspace_id = $1 and status = 'subscribed'", [ctx.workspaceId],
  )).rows[0].n;
  return c.json({
    ladder: {
      ...ladder,
      inProgress: counts?.in_progress || 0,
      finished: counts?.finished || 0,
      reached: counts?.reached || 0,
      waitingEmail: counts?.waiting_email || 0,
      waitingText: counts?.waiting_text || 0,
    },
    people: runs.map((r) => ({ ...runOut(r, ladder.steps), person: { id: r.person_id, name: r.person_name } })),
    emailConfigured: emailConfigured(),
    textConfigured: textConfigured(),
    emailYes,
    campaign: ctx.workspace?.name || '',
    options: opts,
  });
});

api.get('/persons/:id/ladders', async (c) => {
  const id = c.req.param('id');
  const ctx = c.get('ctx');
  if (ctx.role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const db = c.get('db');
  const level = await levelFor(db, ctx.workspaceId, id);
  if (!level) return c.json({ error: 'not found' }, 404);
  const runs = (await db.query(
    `select r.*, l.name as ladder_name, l.steps as ladder_steps, l.active as ladder_active
     from ladder_runs r join ladders l on l.id = r.ladder_id and l.deleted_at is null
     where r.workspace_id = $1 and r.person_id = $2 order by r.started_at desc limit 50`,
    [ctx.workspaceId, id],
  )).rows;
  const open = (await db.query(
    `select f.id, f.text, f.created_at, f.due_at, f.kind, u.name as assigned_name from ladder_followups f
     left join users u on u.id = f.assigned_to
     where f.workspace_id = $1 and f.person_id = $2 and f.status = 'open' order by f.created_at`,
    [ctx.workspaceId, id],
  )).rows.map((f) => ({ id: f.id, text: f.text, created_at: f.created_at, due_at: f.due_at || null, kind: f.kind || 'ladder', assigned_name: f.assigned_name || null }));
  return c.json({
    level,
    runs: runs.map((r) => ({
      ...runOut(r, parseJson(r.ladder_steps, [])),
      ladder: { id: r.ladder_id, name: r.ladder_name, active: r.ladder_active },
    })),
    followups: open,
    emailConfigured: emailConfigured(),
    textConfigured: textConfigured(),
  });
});
