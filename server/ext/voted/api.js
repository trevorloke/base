// GET /voted/status        anyone: whether GOTV is on (and practice, and
//                          active for this person), the sending rule for
//                          today, their post, the feed's head
// GET /voted/summary       desk: the numbers by band, turf and voting place (summary.js)
// GET /voted/persons/:id   one person's voted_at and their marks (who marked
//                          them only for desk roles); 404 outside a
//                          volunteer's turfs and phone banks while GOTV keeps
//                          them there
// GET /voted/live          SSE, the live feed (live.js)
// GET /voted/changes?since=  the same changes since a feed id: the catch-up read
// GET /gotv/find           a scrutineer's look-up (find.js)
// GET /gotv/places         the voting places, for the pickers (posted people and the desk)
// GET /gotv/open?place_id=&written_at=a,b  for names kept on a phone: each
//                          one's own day, whether its writer is on duty for
//                          it and whether it may reach the office yet
// GET /gotv/posts          desk: who works where, signed in, marks today, look-up flag
// GET /gotv/checks?open=1  desk: To check
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { settingsOf } from './brief.js';
import { gotvFor, isDesk, scopeOf, votedCol, scrutineerOnly } from './state.js';
import { hoursOf, tzOf, today, dayOf, closeAt, sendOpen, votingDays, inWindow } from './clock.js';
import { summaryOf } from './summary.js';
import { subscribe, scopeFor, refreshScope, pingMs, liveCount } from './live.js';
import { findPeople, takeLookup, lookupsOf } from './find.js';
import { mayEnterName, onDuty, WORDS } from './actions.js';
import { notOpenDays } from './posts.js';
import { turfsOfPerson } from './turfindex.js';
import { now } from '../../lib/clock.js';
import { atLocal, localHm } from '../../lib/tzrule.js';
import { startOfDay } from '../../lib/tzsql.js';

export const api = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const NOT_ON = 'GOTV isn’t on.';
const NO_STREAM = 'Who voted doesn’t need the live list';
const CHANGES_MAX = 1000;

// The desk header's line while names are held (decision 26).
const heldLine = (s, on) => {
  if (!on || s.send !== 'after_close' || s.ceo_answer?.allows_live) return null;
  return s.ceo_answer
    ? 'Scrutineers’ names are held until polls close — the Chief Election Officer said no.'
    : 'Scrutineers’ names are held until polls close — Chief Election Officer not asked yet.';
};

const hasList = async (db, ctx) => Boolean((await db.query(
  `select exists (select 1 from turf_members where workspace_id = $1 and user_id = $2)
       or exists (select 1 from call_bank_numbers where workspace_id = $1 and assigned_to = $2 and done_at is null) as yes`,
  [ctx.workspaceId, ctx.user.id],
)).rows[0]?.yes);

const postOf = (g) => ({ role: g.post.role, place: g.post.place_id ? { id: g.post.place_id, name: g.post.place_name } : null });

export const statusOf = async (db, ctx) => {
  const ws = ctx.workspaceId;
  const tz = tzOf(ctx);
  const base = await settingsOf(db, ctx);
  const g = await gotvFor(db, ctx);
  const h = await hoursOf(db, ws);
  const day = today(tz);
  const placeId = g.post?.place_id || null;
  const close = closeAt(h, g.s, day, placeId, tz);
  const feed = (await db.query(
    `select greatest((select max(feed_id) from voted_marks where workspace_id = $1),
                     (select max(feed_id) from gotv_practice where workspace_id = $1)) as f`, [ws],
  )).rows[0]?.f;
  const dutyToday = g.post && (g.group || (votingDays(g.s).includes(day)
    && (!g.post.days?.length || g.post.days.includes(day)) && (g.s.on_day || g.s.auto) && inWindow(h, g.s, day, tz)));
  return {
    ...base,
    practice: g.practice,
    active: g.active,
    send: g.s.send,
    send_open: g.practice || sendOpen(h, g.s, day, placeId, tz),
    closes_at: iso(close),
    // The wall time, by the campaign's rule (a phone's own zone data may be older).
    closes_hm: close ? localHm(close, tz) : null,
    ...(isDesk(ctx) ? { held_line: heldLine(g.s, g.on) } : {}),
    feed: Number(feed || 0),
    on_duty: dutyToday ? postOf(g) : null,
    // The post whatever the day: names written yesterday are judged by their
    // own day (GET /gotv/open), so Who voted still shows them after midnight.
    post: g.post ? postOf(g) : null,
    // When the campaign's today began: "entered today" counts from here.
    today_from: iso(atLocal(day, '00:00', tz)),
    scope: g.s.scope,
    // A volunteer kept to their turfs and phone bank with neither: Today says so.
    // (Two existence reads, not the scope: that is kept a minute, and a
    // status read must not freeze it before a new person reaches the index.)
    ...(g.limited ? { has_list: await hasList(db, ctx) } : {}),
    // A scrutineer with no turf and no calls has nothing to receive live.
    ...(g.post && g.active ? { stream: !(await scrutineerOnly(db, ctx, g)) } : {}),
  };
};

api.get('/voted/status', async (c) => c.json(await statusOf(c.get('db'), c.get('ctx'))));

api.get('/voted/summary', async (c) => {
  const ctx = c.get('ctx');
  const body = await summaryOf(c.get('db'), ctx, c.req.query('practice') === '1');
  return c.json({ ...body, phones_live: liveCount(ctx.workspaceId) });
});

api.get('/voted/persons/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const g = await gotvFor(db, ctx);
  if (g.limited && !(await scopeOf(db, ctx)).ids.has(id)) return c.json({ error: 'not found' }, 404);
  const field = ctx.role === 'volunteer' ? g : null;
  const p = (await db.query(
    `select p.id, ${votedCol(field, 'p')} as voted_at from persons p where p.id = $1 and p.workspace_id = $2 and p.deleted_at is null`, [id, ctx.workspaceId],
  )).rows[0];
  if (!p) return c.json({ error: 'not found' }, 404);
  const desk = ctx.role !== 'volunteer';
  const marks = (await db.query(
    desk
      ? `select m.voted, m.source, m.created_at, u.name as by_name, pl.name as place from voted_marks m left join users u on u.id = m.marked_by
         left join places pl on pl.id = m.place_id
         where m.workspace_id = $1 and m.person_id = $2 order by m.created_at desc, m.id limit 100`
      : `select m.voted, m.source, m.created_at from voted_marks m
         where m.workspace_id = $1 and m.person_id = $2 order by m.created_at desc, m.id limit 100`,
    [ctx.workspaceId, id],
  )).rows;
  return c.json({ voted_at: p.voted_at, marks });
});

// ── The live feed ──
api.get('/voted/live', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const g = await gotvFor(db, ctx);
  if (!g.active) return c.json({ error: NOT_ON }, 409);
  if (await scrutineerOnly(db, ctx, g)) return c.json({ error: NO_STREAM }, 403);
  const scope = await scopeFor(db, ctx, g);
  const since = Number(c.req.header('last-event-id')) || 0;
  const catchUp = since ? await changesSince(db, ctx, g, scope, since) : null;
  const res = streamSSE(c, async (stream) => {
    let done;
    const ended = new Promise((r) => { done = r; });
    const sub = {
      ctx, ...scope, group: g.group || g.on, last: since, queue: new Map(), timer: null, closed: false, at: Date.now(), scopeAt: Date.now(),
      // A phone that stops reading (asleep, a dead connection not yet
      // noticed) never piles messages up here: past 100 unread it is
      // closed, and catches up when it comes back (Last-Event-ID).
      backlog: 0,
      send: (m) => {
        if (sub.closed) return Promise.resolve();
        if (sub.backlog > 100) { sub.close(); return Promise.resolve(); }
        sub.backlog += 1;
        return stream.writeSSE(m).then(() => { sub.backlog -= 1; }, () => sub.close());
      },
      statusOf: (d) => statusOf(d, ctx),
      close: () => { if (sub.closed) return; sub.closed = true; clearTimeout(sub.timer); done(); },
    };
    const leave = subscribe(ctx.workspaceId, sub);
    stream.onAbort(() => sub.close());
    if (catchUp && !catchUp.reload && catchUp.changes.length) sub.send({ event: 'voted', id: String(catchUp.last), data: JSON.stringify(catchUp.changes) });
    else if (catchUp?.reload) sub.send({ event: 'reload', id: String(catchUp.last), data: '{}' });
    // A comment now and every 25 s: under any proxy's idle limit.
    stream.write(': live\n\n').catch(() => sub.close());
    const ping = setInterval(() => {
      if (sub.backlog > 100) { sub.close(); return; }
      stream.write(': ping\n\n').catch(() => sub.close());
      refreshScope(sub).catch(() => {});
    }, pingMs());
    await ended;
    clearInterval(ping);
    leave();
  });
  // Never transformed or buffered on the way (a proxy, compress()).
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
});

// The changes after a feed id, one per person (their value now), in the
// caller's scope; { reload: true } when there are too many or `since` is
// from before today's first mark.
const changesSince = async (db, ctx, g, scope, since) => {
  const ws = ctx.workspaceId;
  const tz = tzOf(ctx);
  const head = Number((await db.query(
    `select greatest((select max(feed_id) from voted_marks where workspace_id = $1),
                     (select max(feed_id) from gotv_practice where workspace_id = $1)) as f`, [ws],
  )).rows[0]?.f || 0);
  const oldest = (await db.query(
    `select min(feed_id) as f from voted_marks where workspace_id = $1 and inserted_at >= ${startOfDay('$2::text')}`, [ws, tz],
  )).rows[0]?.f;
  if (!since || (oldest != null && since < Number(oldest) - 1)) return { reload: true, last: head };
  const field = ctx.role === 'volunteer' ? g : null;
  const real = (await db.query(
    `select m.person_id, m.feed_id, ${votedCol(field, 'p')} as v from voted_marks m join persons p on p.id = m.person_id
      where m.workspace_id = $1 and m.feed_id > $2 order by m.feed_id limit ${CHANGES_MAX + 1}`, [ws, since],
  )).rows;
  const practice = g.group ? (await db.query(
    `select g.person_id, g.feed_id, case when g.voted then g.created_at end as v from gotv_practice g
      where g.workspace_id = $1 and g.feed_id > $2 order by g.feed_id limit ${CHANGES_MAX + 1}`, [ws, since],
  )).rows : [];
  if (real.length + practice.length > CHANGES_MAX) return { reload: true, last: head };
  const out = new Map();
  const inScope = (pid) => scope.all || scope.ids.has(pid) || turfsOfPerson(ws, pid).some((t) => scope.turfs?.has(t));
  for (const r of real) if (inScope(r.person_id)) out.set(`${r.person_id}:0`, { p: r.person_id, v: iso(r.v), x: 0 });
  for (const r of practice) if (inScope(r.person_id)) out.set(`${r.person_id}:1`, { p: r.person_id, v: iso(r.v), x: 1 });
  return { changes: [...out.values()], last: Math.max(head, since) };
};

api.get('/voted/changes', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const g = await gotvFor(db, ctx);
  if (!g.active && !isDesk(ctx)) return c.json({ error: NOT_ON }, 409);
  const since = Math.max(0, Math.floor(Number(c.req.query('since')) || 0));
  return c.json(await changesSince(db, ctx, g, await scopeFor(db, ctx, g), since));
});

// ── Who voted: the scrutineer's look-up and the places ──
api.get('/gotv/find', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const tz = tzOf(ctx);
  const g = await gotvFor(db, ctx);
  if (!isDesk(ctx) && !g.post) return c.json({ error: WORDS.duty }, 403);
  const placeId = c.req.query('place_id') || g.post?.place_id || null;
  if (!placeId || !UUID.test(placeId)) return c.json({ error: WORDS.place }, 400);
  const written = c.req.query('written_at');
  const at = written && !Number.isNaN(Date.parse(written)) ? Math.min(Date.parse(written), now()) : now();
  const practice = c.req.query('practice') === '1';
  try {
    mayEnterName(ctx, g, await hoursOf(db, ctx.workspaceId), { placeId, day: dayOf(at, tz), practice, tz });
  } catch (e) {
    if (e.status) return c.json({ error: e.message }, e.status);
    throw e;
  }
  const limited = takeLookup(ctx.workspaceId, ctx.user.id, tz);
  if (limited) return c.json({ error: limited }, 429);
  const r = await findPeople(db, ctx.workspaceId, c.req.query('q'));
  return c.json(r.body, r.status);
});

// Names kept on a phone are judged by the day they were written, as the
// look-up and the mark judge them: a note from 19:58 is matched at 01:58.
// Reads only; no look-up is spent.
const NOTES_MAX = 200;
api.get('/gotv/open', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const g = await gotvFor(db, ctx);
  const desk = isDesk(ctx);
  if (!desk && !g.post) return c.json({ error: WORDS.duty }, 403);
  const placeId = c.req.query('place_id') || g.post?.place_id || null;
  if (!placeId || !UUID.test(placeId)) return c.json({ error: WORDS.place }, 400);
  const tz = tzOf(ctx);
  const h = await hoursOf(db, ctx.workspaceId);
  const place = h.places.get(placeId);
  if (!place || place.gone) return c.json({ error: WORDS.place }, 400);
  const ats = String(c.req.query('written_at') || '').split(',').filter((t) => t && !Number.isNaN(Date.parse(t))).slice(0, NOTES_MAX);
  const notes = ats.map((written_at) => {
    const day = dayOf(Math.min(Date.parse(written_at), now()), tz);
    const duty = desk || (onDuty(g, h, day, tz, false) && (g.post.role !== 'scrutineer' || g.post.place_id === placeId));
    const close = closeAt(h, g.s, day, placeId, tz);
    return {
      written_at, day, on_duty: duty,
      open: duty && place.closed_on !== day && sendOpen(h, g.s, day, placeId, tz),
      closes_at: iso(close), closes_hm: close ? localHm(close, tz) : null,
    };
  });
  return c.json({ notes });
});

api.get('/gotv/places', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const g = await gotvFor(db, ctx);
  if (!isDesk(ctx) && !g.post) return c.json({ error: WORDS.duty }, 403);
  const tz = tzOf(ctx);
  const h = await hoursOf(db, ctx.workspaceId);
  const day = today(tz);
  const places = [...h.places.values()].filter((p) => !p.gone)
    .map((p) => { const c = closeAt(h, g.s, day, p.id, tz); return { id: p.id, name: p.name, open_today: p.listed && p.days.has(day) && p.closed_on !== day, closes_at: iso(c), closes_hm: c ? localHm(c, tz) : null }; })
    .sort((a, b) => Number(b.open_today) - Number(a.open_today) || a.name.localeCompare(b.name));
  return c.json({ places });
});

api.get('/gotv/posts', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const tz = tzOf(ctx);
  const g = await gotvFor(db, ctx);
  const h = await hoursOf(db, ws);
  const rows = (await db.query(
    `select g.id, g.user_id, u.name, g.role, g.place_id, pl.name as place, g.days, g.appointed, g.created_at,
            exists (select 1 from sessions s where s.user_id = g.user_id and s.workspace_id = g.workspace_id
                      and (s.created_at >= g.created_at or s.created_at > now() - interval '7 days')) as signed_in,
            (select count(*)::int from voted_marks m where m.workspace_id = g.workspace_id and m.marked_by = g.user_id
                      and m.voted and m.undoes is null and m.created_at >= ${startOfDay('$2::text')}) as marks_today
       from gotv_posts g join users u on u.id = g.user_id left join places pl on pl.id = g.place_id
      where g.workspace_id = $1 and g.ended_at is null order by u.name`, [ws, tz],
  )).rows;
  return c.json({
    posts: rows.map((r) => {
      const days = typeof r.days === 'string' ? JSON.parse(r.days) : r.days || [];
      return {
        id: r.id, user_id: r.user_id, name: r.name, role: r.role, place: r.place_id ? { id: r.place_id, name: r.place } : null,
        days, appointed: r.appointed, signed_in: r.signed_in, marks_today: r.marks_today,
        not_open: notOpenDays(h, g.s, { place_id: r.place_id, days }), ...lookupsOf(ws, r.user_id, tz),
      };
    }),
  });
});

api.get('/gotv/checks', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const g = await gotvFor(db, ctx);
  const open = c.req.query('open') === '1';
  const rows = (await db.query(
    `select k.id, k.typed, k.place_id, pl.name as place, k.written_at, u.name as by_name, k.practice, k.resolved_at, k.outcome
       from gotv_checks k left join places pl on pl.id = k.place_id left join users u on u.id = k.by
      where k.workspace_id = $1 and k.practice = $2 ${open ? 'and k.resolved_at is null' : ''}
      order by k.written_at desc limit 500`, [ctx.workspaceId, g.s.practice],
  )).rows;
  return c.json({ checks: rows.map((r) => ({ ...r, written_at: iso(r.written_at), resolved_at: iso(r.resolved_at) })) });
});

// GET /gotv/setup (desk): what the Get out the vote screen's Settings and
// Ready list need — the sending rule, the CEO's answer, who sees who voted,
// each voting day's closing time from the voter guide (and the manager's
// own), who is practising, and the Ready list's lines (ticks and checks).
const READY = [
  ['ceo', 'Chief Election Officer asked: when may scrutineers view the voting book and write names, and may those names leave the voting place before it closes?'],
  ['days', 'Voting days entered'],
  ['hours', 'Voting hours entered (voter guide or override)'],
  ['places', 'Voting places added in the voter guide'],
  ['appointed', 'Every scrutineer appointed in writing'],
  ['signed_in', 'Every scrutineer signed in before the day'],
  ['practice_run', 'Practice run done'],
  ['briefed', 'Runners and scrutineers briefed: sheets leave the voting place only after it closes, until the Chief Election Officer says otherwise; phones away inside; no campaigning within 100 m (verify)'],
  ['no_deploys', 'No deploys on voting days: told whoever deploys'],
];
const PRACTICE_RUN_DAYS = 60;
api.get('/gotv/setup', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const tz = tzOf(ctx);
  const g = await gotvFor(db, ctx);
  const s = g.s;
  const h = await hoursOf(db, ws);
  const day = today(tz);
  const vdays = votingDays(s);
  const days = vdays.map((d) => {
    const guide = h.days.get(d)?.closes || null;
    const dayClose = s.close_override?.[d] || guide;
    const own = [...h.places.values()].filter((p) => !p.gone && p.listed && p.days.get(d)?.closes && p.days.get(d).closes !== dayClose).length;
    return { day: d, kind: d === s.election_day ? 'general' : 'advance', guide_close: guide, override: s.close_override?.[d] || null, places_differ: own };
  });
  const posts = (await db.query(
    `select g.user_id, g.appointed,
            exists (select 1 from sessions x where x.user_id = g.user_id and x.workspace_id = g.workspace_id
                      and (x.created_at >= g.created_at or x.created_at > now() - interval '7 days')) as signed_in
       from gotv_posts g where g.workspace_id = $1 and g.ended_at is null`, [ws],
  )).rows;
  const listed = [...h.places.values()].filter((p) => !p.gone && p.listed).length;
  const ran = s.ready?.practice_run?.at && Date.parse(s.ready.practice_run.at) > now() - PRACTICE_RUN_DAYS * 86_400_000;
  const auto = {
    ceo: Boolean(s.ceo_answer),
    days: Boolean(s.election_day),
    hours: vdays.length > 0 && vdays.every((d) => h.days.has(d) || s.close_override?.[d]),
    places: listed > 0,
    appointed: posts.length > 0 && posts.every((p) => p.appointed),
    signed_in: posts.length > 0 && posts.every((p) => p.signed_in),
    practice_run: Boolean(ran),
  };
  const ready = READY.map(([key, label]) => ({
    key, label, done: key in auto ? auto[key] : Boolean(s.ready?.[key]), tick: !(key in auto),
    ...(key === 'ceo' && s.ceo_answer ? { answer: { allows_live: Boolean(s.ceo_answer.allows_live), note: s.ceo_answer.note || '', at: s.ceo_answer.at || null } } : {}),
  }));
  const ids = [...new Set(s.practice_users)];
  const named = ids.length ? (await db.query('select id, name from users where id = any($1::uuid[])', [ids])).rows : [];
  const held = votingDays(s).includes(day) && !sendOpen(h, s, day, null, tz);
  return c.json({
    send: s.send, ceo_answer: s.ceo_answer, scope: s.scope, released: s.released, practice: s.practice,
    practice_users: named, posts: posts.length, days, ready, voting_day: vdays.includes(day), held_today: held,
    places: listed,
  });
});
