// vote.mark      { person_id, voted?, source?, client_id?, client_at?, place_id?, practice? }
//                anyone: this person has voted (or, voted:false, has not after all)
// vote.undo      { client_id } a scrutineer or runner takes back their own mark
//                (15 minutes from when it reached the office); the desk, any
// vote.settings  { on?, mode?, election_day?, advance_days?, auto?, practice_users?, send?,
//                  close_override?, release?, ceo_answer?, scope?, ready? }
//                managers: GOTV mode, its days, practice and the sending rule
// gotv.check     { typed, place_id, written_at, client_id?, practice? } a name
//                a scrutineer could not match, for the office's To check
// gotv.check.resolve { id, person_id?, outcome } desk: marked or not ours
// (gotv.post.*, gotv.signin.code and gotv.practice.clear: posts.js)
//
// vote.mark is append-only like a knock: a mark is a new row in voted_marks
// and persons.voted_at follows it (now() for voted, null for a take-back).
// A volunteer may mark anyone they can already read — the walk list, the
// door card and Calls hand them the person, as contact.log does. There is
// no Election-day gate on the server: a mark saved on a phone with no
// signal before the office flipped the switch must still land; the screens
// decide when to offer the button. client_id (the outbox's own id) dedupes
// a replay: the same id answers { duplicate: true } and writes nothing.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { forgetCounts } from './brief.js';
import { now } from '../../lib/clock.js';
import { gotvFor, isDesk, scopeOf, rowOf, onNow } from './state.js';
import { hoursOf, tzOf, dayOf, today, votingDays, inWindow, sendOpen } from './clock.js';
import { postActions } from './posts.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const MANAGER_ONLY = ['manager'];
const uuid = () => z.uuid();
const iso = (d) => (d ? new Date(d).toISOString() : null);

// GOTV mode's days, and the switch when `on` is given: the body of
// vote.settings, shared with the voter guide's publish (ext/voteguide,
// "Also use these days for GOTV mode"), which leaves the switch as it is.
// One 'workspace update' event either way — GOTV's listener reads it as a
// settings commit. Left out: election_day, advance_days and auto stay as
// they are (null clears election day).
export const saveVotingDays = async (tx, ctx, input, emit) => {
  const ws = ctx.workspaceId;
  const keepDay = input.election_day === undefined;
  const keepOn = input.on === undefined;
  const row = (await tx.query(
    `insert into voted_settings (workspace_id, on_day, election_day, updated_at) values ($1, $2, $3, now())
     on conflict (workspace_id) do update
       set on_day = case when $5 then voted_settings.on_day else excluded.on_day end,
           election_day = case when $4 then voted_settings.election_day else excluded.election_day end,
           updated_at = now()
     returning on_day, election_day`,
    [ws, Boolean(input.on), input.election_day || null, keepDay, keepOn],
  )).rows[0];
  const election_day = row.election_day
    ? (row.election_day instanceof Date ? row.election_day.toISOString().slice(0, 10) : String(row.election_day).slice(0, 10))
    : null;
  const extra = {};
  if (input.advance_days !== undefined) extra.advance_days = [...new Set(input.advance_days)].sort();
  if (input.auto !== undefined) extra.auto = input.auto;
  if ('advance_days' in extra) await tx.query('update voted_settings set advance_days = $2 where workspace_id = $1', [ws, JSON.stringify(extra.advance_days)]);
  if ('auto' in extra) await tx.query('update voted_settings set auto = $2 where workspace_id = $1', [ws, extra.auto]);
  emit('workspace', ws, 'update', { ...(keepOn ? {} : { election_day_mode: input.on }), election_day, ...extra });
  return { on: Boolean(row.on_day), election_day, ...extra };
};

// The words people see when GOTV refuses something (decisions 9–17).
export const WORDS = {
  manager: 'Only a manager can do this',
  held: 'Names go to the office after polls close.',
  scrutineer: 'A name from a voting place is a scrutineer’s mark',
  place: 'Pick a voting place from the voter guide’s list',
  notPlace: 'That isn’t your voting place',
  closed: 'That voting place is closed today',
  duty: 'Only a scrutineer or runner on duty can do this',
  office: 'Ask the office to change this',
  list: 'This person isn’t on your list.',
  practiceOver: 'Practice is over — nothing was saved',
  practiceOn: 'GOTV is on today — practice another day',
  tooLate: 'Too late to undo here — ask the office.',
  ceo: 'First record the Chief Election Officer’s answer (Ready list)',
};
const UNDO_MS = 15 * 60_000;
const READY_KEYS = ['briefed', 'no_deploys'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// What a non-desk caller gets back from a mark, an undo or a check: the
// same bytes whether the person was voted already, new, or a replay — so
// a scrutineer never learns who else voted (decision 13).
export const bare = (client_id) => ({ ok: true, client_id: client_id || null });
const answerOf = (ctx, r) => (isDesk(ctx) ? r : bare(r.client_id));

// A voting place of this campaign, not removed: VG's places.kind = 'voting'.
const votingPlace = (h, id) => {
  const p = id ? h.places.get(id) : null;
  if (!p || p.gone) throw httpError(400, WORDS.place);
  return p;
};

// On duty for day D: an open post, D a voting day in the post's days (or
// every day), GOTV not switched off with auto off, now inside D's window.
// In practice: an open post, practice on, and today.
const onDuty = (g, h, day, tz, practice) => {
  const post = g.post;
  if (!post) return false;
  if (practice) return g.practice && day === today(tz);
  if (!votingDays(g.s).includes(day)) return false;
  if (post.days?.length && !post.days.includes(day)) return false;
  if (!g.s.on_day && !g.s.auto) return false;
  return inWindow(h, g.s, day, tz);
};

// Who may send a name seen at a voting place, for day D at place P, and
// whether it may reach the office yet. Throws the words; returns the place.
export const mayEnterName = (ctx, g, h, { placeId, day, practice, tz }) => {
  const desk = isDesk(ctx);
  const place = votingPlace(h, placeId);
  if (!desk) {
    if (!onDuty(g, h, day, tz, practice)) throw httpError(403, WORDS.duty);
    if (g.post.role === 'scrutineer' && g.post.place_id !== placeId) throw httpError(403, WORDS.notPlace);
  }
  if (practice) {
    if (!g.practice) throw httpError(409, WORDS.practiceOver);
    if (!g.group) throw httpError(403, WORDS.duty);
  }
  if (place.closed_on === day) throw httpError(409, WORDS.closed);
  // Practice is always live, so the drill shows the live path.
  if (!practice && !sendOpen(h, g.s, day, placeId, tz)) throw httpError(409, WORDS.held);
  return place;
};

// A mark's time: its tap (or when the name was written), never later than now.
const markTime = (client_at) => {
  const t = client_at ? Date.parse(client_at) : NaN;
  return new Date(Number.isNaN(t) ? now() : Math.min(t, now())).toISOString();
};

// persons.voted_at from the person's marks, the undone ones and the undos
// left out: the first voted time of the latest standing run of "voted", or
// null when the latest standing mark is a take-back.
export const recomputeVoted = async (tx, ws, personId) => {
  const marks = (await tx.query(
    `select m.voted, m.created_at from voted_marks m
      where m.workspace_id = $1 and m.person_id = $2 and m.undoes is null
        and not exists (select 1 from voted_marks u where u.workspace_id = m.workspace_id and u.undoes = m.id)
      order by m.created_at, m.inserted_at`, [ws, personId],
  )).rows;
  let at = null;
  for (const m of marks) at = m.voted ? (at || m.created_at) : null;
  const row = (await tx.query(
    'update persons set voted_at = $3, updated_at = now() where id = $1 and workspace_id = $2 returning voted_at', [personId, ws, at],
  )).rows[0];
  return row?.voted_at ?? null;
};

// May this volunteer mark this person? While GOTV is active and kept to
// turfs: in their scope, or someone they added at a door in the last day.
const onMyList = async (tx, ctx, personId) => {
  const scope = await scopeOf(tx, ctx);
  if (scope.ids.has(personId)) return true;
  return Boolean((await tx.query(
    `select 1 from events where workspace_id = $1 and entity_type = 'person' and entity_id = $2 and op = 'create'
        and actor_id = $3 and server_ts > now() - interval '24 hours' limit 1`,
    [ctx.workspaceId, personId, ctx.user.id],
  )).rows[0]);
};

// One mark, real or practice — vote.mark's body, shared with To check's
// "marked" (gotv.check.resolve).
export const markCore = async (tx, ctx, input, emit) => {
  const ws = ctx.workspaceId;
  const desk = isDesk(ctx);
  const tz = tzOf(ctx);
  const source = input.source || 'door';
  if (input.place_id && source !== 'scrutineer') throw httpError(400, WORDS.scrutineer);
  if (source === 'scrutineer' && !input.place_id) throw httpError(400, WORDS.place);
  const person = (await tx.query(
    'select id from persons where id = $1 and workspace_id = $2 and deleted_at is null',
    [input.person_id, ws],
  )).rows[0];
  if (!person) throw httpError(404, 'person not found');
  const practice = Boolean(input.practice);
  // A replay of a mark already saved is that mark, whatever has changed since.
  const table = practice ? 'gotv_practice' : 'voted_marks';
  if (input.client_id) {
    const dup = (await tx.query(
      `select person_id, voted, feed_id from ${table} where workspace_id = $1 and client_id = $2`,
      [ws, input.client_id],
    )).rows[0];
    if (dup) {
      const cur = practice ? null : (await tx.query('select voted_at from persons where id = $1', [dup.person_id])).rows[0];
      return { person_id: dup.person_id, voted: Boolean(dup.voted), voted_at: iso(cur?.voted_at), feed_id: Number(dup.feed_id), duplicate: true, client_id: input.client_id };
    }
  }
  const g = await gotvFor(tx, ctx);
  const at = markTime(input.client_at);
  const day = dayOf(at, tz);
  if (source === 'scrutineer') {
    if (input.voted === false && !desk) throw httpError(403, WORDS.office);
    mayEnterName(ctx, g, await hoursOf(tx, ws), { placeId: input.place_id, day, practice, tz });
  } else if (practice) {
    if (!g.practice) throw httpError(409, WORDS.practiceOver);
    if (!g.group) throw httpError(403, WORDS.duty);
  }
  if (!desk && source !== 'scrutineer' && g.limited && !(await onMyList(tx, ctx, input.person_id))) {
    throw httpError(403, WORDS.list);
  }
  const id = newId();
  if (practice) {
    const row = (await tx.query(
      `insert into gotv_practice (id, workspace_id, person_id, voted, source, place_id, marked_by, client_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning feed_id`,
      [id, ws, input.person_id, input.voted, source, input.place_id || null, ctx.user.id, input.client_id || null, at],
    )).rows[0];
    const feed_id = Number(row.feed_id);
    emit('gotv_practice', id, 'create', { id, person_id: input.person_id, voted: input.voted, source, place_id: input.place_id || null, client_id: input.client_id || null, feed_id, at });
    return { person_id: input.person_id, voted: input.voted, voted_at: input.voted ? at : null, feed_id, practice: true, client_id: input.client_id || null };
  }
  // A mark tapped before the person's latest one (it waited on a phone
  // while someone else changed it) goes in the history but changes
  // nothing: the latest tap wins, not the latest to arrive.
  const latest = (await tx.query(
    'select max(created_at) as at from voted_marks where workspace_id = $1 and person_id = $2', [ws, input.person_id],
  )).rows[0]?.at;
  const stale = latest && new Date(latest) > new Date(at);
  const feed_id = Number((await tx.query(
    `insert into voted_marks (id, workspace_id, person_id, voted, source, marked_by, client_id, created_at, place_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning feed_id`,
    [id, ws, input.person_id, input.voted, source, ctx.user.id, input.client_id || null, at, input.place_id || null],
  )).rows[0].feed_id);
  // Marked again: they voted when first marked, not now.
  const row = stale
    ? (await tx.query('select voted_at from persons where id = $1 and workspace_id = $2', [input.person_id, ws])).rows[0]
    : (await tx.query(
      `update persons set voted_at = case when $3 then coalesce(voted_at, $4::timestamptz) else null end, updated_at = now()
       where id = $1 and workspace_id = $2 returning voted_at`,
      [input.person_id, ws, input.voted, at],
    )).rows[0];
  const voted_at = iso(row?.voted_at);
  emit('voted_mark', id, 'create', { id, person_id: input.person_id, voted: input.voted, source, client_id: input.client_id || null, place_id: input.place_id || null, feed_id });
  emit('person', input.person_id, 'update', { voted_at, source });
  return { person_id: input.person_id, voted: input.voted, voted_at, feed_id, client_id: input.client_id || null };
};

const managerOnly = (ctx) => { if (ctx.role !== 'manager') throw httpError(403, WORDS.manager); };
const jsonb = (v) => JSON.stringify(v);

export const actions = {
  'vote.mark': {
    roles: ALL_ROLES,
    input: z.object({
      person_id: uuid(),
      voted: z.boolean().default(true),
      source: z.enum(['door', 'phone', 'desk', 'scrutineer']).default('door'),
      client_id: uuid().nullish(),
      // When it was tapped (a phone's outbox sends it), or when a scrutineer
      // wrote the name: a mark that waited keeps its own time and day.
      client_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).max(40).nullish(),
      // The voting place a scrutineer's or runner's name was seen at.
      place_id: uuid().nullish(),
      // Set by the phone at the tap from the status it held.
      practice: z.boolean().default(false),
    }),
    handler: async (tx, ctx, input, emit) => {
      const r = await markCore(tx, ctx, input, emit);
      if (isDesk(ctx)) delete r.client_id;
      return r;
    },
    answer: answerOf,
    bareFor: (ctx) => !isDesk(ctx),
    // Committed: the volunteers' kept GOTV numbers count again (brief.js).
    after: async (db, ctx, result) => { forgetCounts(ctx.workspaceId); return { result }; },
  },

  'vote.undo': {
    roles: ALL_ROLES,
    // client_id: the mark's own (the phone made it); the desk may name a
    // mark by its id instead. A replay of an undo already done is done.
    input: z.object({ client_id: uuid().nullish(), id: uuid().nullish() }).refine((v) => v.client_id || v.id, 'which mark'),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const desk = isDesk(ctx);
      if (input.id && !desk) throw httpError(403, WORDS.office);
      const g = await gotvFor(tx, ctx);
      if (!desk && !g.post) throw httpError(403, WORDS.duty);
      const by = input.id ? ['id', input.id] : ['client_id', input.client_id];
      let table = 'voted_marks';
      let mark = (await tx.query(`select * from voted_marks where workspace_id = $1 and ${by[0]} = $2 and undoes is null`, [ws, by[1]])).rows[0];
      if (!mark) {
        table = 'gotv_practice';
        mark = (await tx.query(`select * from gotv_practice where workspace_id = $1 and ${by[0]} = $2 and undoes is null`, [ws, by[1]])).rows[0];
      }
      if (!mark || (!desk && mark.marked_by !== ctx.user.id)) throw httpError(404, 'That mark isn’t one of yours');
      const done = (await tx.query(`select id from ${table} where workspace_id = $1 and undoes = $2`, [ws, mark.id])).rows[0];
      if (done) return { person_id: mark.person_id, undone: true, duplicate: true, client_id: mark.client_id };
      // The 15 minutes run from when it reached the office (the database's
      // own clock, as inserted_at is), not from when the name was written.
      const late = (await tx.query(`select now() - $1::timestamptz > interval '${UNDO_MS / 60_000} minutes' as late`, [mark.inserted_at])).rows[0].late;
      if (!desk && late) throw httpError(409, WORDS.tooLate);
      const id = newId();
      const at = new Date(now()).toISOString();
      const feed_id = Number((await tx.query(
        `insert into ${table} (id, workspace_id, person_id, voted, source, marked_by, created_at, place_id, undoes)
         values ($1, $2, $3, false, $4, $5, $6, $7, $8) returning feed_id`,
        [id, ws, mark.person_id, mark.source, ctx.user.id, at, mark.place_id, mark.id],
      )).rows[0].feed_id);
      const payload = { id, person_id: mark.person_id, voted: false, source: mark.source, undoes: mark.id, place_id: mark.place_id, feed_id };
      if (table === 'gotv_practice') {
        emit('gotv_practice', id, 'create', payload);
        return { person_id: mark.person_id, undone: true, practice: true, feed_id, client_id: mark.client_id };
      }
      const voted_at = iso(await recomputeVoted(tx, ws, mark.person_id));
      emit('voted_mark', id, 'create', payload);
      emit('person', mark.person_id, 'update', { voted_at, source: mark.source });
      return { person_id: mark.person_id, undone: true, voted_at, feed_id, client_id: mark.client_id };
    },
    answer: answerOf,
    bareFor: (ctx) => !isDesk(ctx),
    after: async (db, ctx, result) => { forgetCounts(ctx.workspaceId); return { result }; },
  },

  'gotv.check': {
    roles: ALL_ROLES,
    input: z.object({
      typed: z.string().trim().min(2, 'Type at least 2 letters').max(120),
      place_id: uuid(),
      written_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).max(40).nullish(),
      client_id: uuid().nullish(),
      practice: z.boolean().default(false),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const tz = tzOf(ctx);
      const g = await gotvFor(tx, ctx);
      const at = markTime(input.written_at);
      mayEnterName(ctx, g, await hoursOf(tx, ws), { placeId: input.place_id, day: dayOf(at, tz), practice: input.practice, tz });
      if (input.client_id) {
        const dup = (await tx.query('select id from gotv_checks where workspace_id = $1 and client_id = $2', [ws, input.client_id])).rows[0];
        if (dup) return { id: dup.id, duplicate: true, client_id: input.client_id };
      }
      const id = newId();
      await tx.query(
        `insert into gotv_checks (id, workspace_id, typed, place_id, by, written_at, practice, client_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ws, input.typed, input.place_id, ctx.user.id, at, input.practice, input.client_id || null],
      );
      emit('gotv_check', id, 'create', { id, typed: input.typed, place_id: input.place_id, written_at: at, practice: input.practice });
      return { id, client_id: input.client_id || null };
    },
    answer: answerOf,
    bareFor: (ctx) => !isDesk(ctx),
  },

  'gotv.check.resolve': {
    roles: ['manager', 'treasurer', 'staff'],
    input: z.object({ id: uuid(), person_id: uuid().nullish(), outcome: z.enum(['marked', 'not_ours']) }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const row = (await tx.query('select * from gotv_checks where id = $1 and workspace_id = $2', [input.id, ws])).rows[0];
      if (!row) throw httpError(404, 'That name is gone — reload');
      if (row.resolved_at) return { id: row.id, outcome: row.outcome, duplicate: true };
      let mark = null;
      if (input.outcome === 'marked') {
        if (!input.person_id) throw httpError(400, 'Pick the person');
        mark = await markCore(tx, ctx, {
          person_id: input.person_id, voted: true, source: 'scrutineer', place_id: row.place_id,
          client_at: new Date(row.written_at).toISOString(), practice: row.practice,
        }, emit);
      }
      await tx.query(
        'update gotv_checks set resolved_at = now(), resolved_by = $3, person_id = $4, outcome = $5 where id = $1 and workspace_id = $2',
        [row.id, ws, ctx.user.id, input.person_id || null, input.outcome],
      );
      emit('gotv_check', row.id, 'update', { outcome: input.outcome, person_id: input.person_id || null });
      return { id: row.id, outcome: input.outcome, mark };
    },
    after: async (db, ctx, result) => { forgetCounts(ctx.workspaceId); return { result }; },
  },

  'vote.settings': {
    roles: MANAGER_ONLY,
    input: z.object({
      // Old clients send on with every save of the days; on:true is mode on.
      on: z.boolean().optional(),
      mode: z.enum(['off', 'practice', 'on']).optional(),
      // Left out: the date stays as it is; null clears it.
      election_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-17').nullish(),
      // GOTV mode: the advance-voting days, and whether the mode turns
      // itself on for them and election day. Left out: as they are.
      advance_days: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-08')).max(30).optional(),
      auto: z.boolean().optional(),
      // The rest is a manager's alone (decision 11), Admin area or not.
      practice_users: z.array(uuid()).max(500).optional(),
      send: z.enum(['after_close', 'live']).optional(),
      close_override: z.record(z.string().regex(DAY), z.string().regex(/^\d{2}:\d{2}$/, 'a time like 20:00').nullable()).optional(),
      release: z.literal(true).optional(),
      ceo_answer: z.object({ allows_live: z.boolean(), note: z.string().trim().max(300).default('') }).optional(),
      scope: z.enum(['turfs', 'campaign']).optional(),
      ready: z.object({ key: z.enum(READY_KEYS), done: z.boolean() }).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const tz = tzOf(ctx);
      const managerKeys = ['mode', 'practice_users', 'send', 'close_override', 'release', 'ceo_answer', 'scope', 'ready'];
      if (managerKeys.some((k) => input[k] !== undefined)) managerOnly(ctx);
      // on:true from an old client is mode on: saveVotingDays sets the
      // switch, and a practice running ends (below) — one event as before
      // unless practice had to end.
      const mode = input.mode;
      const out = {};
      // The days, auto and the plain switch: as before (saveVotingDays).
      const dayKeys = ['election_day', 'advance_days', 'auto'];
      if (dayKeys.some((k) => input[k] !== undefined) || (input.on !== undefined && !input.mode)) {
        const days = { ...Object.fromEntries(dayKeys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) };
        if (input.on !== undefined && !input.mode) days.on = input.on;
        Object.assign(out, await saveVotingDays(tx, ctx, days, emit));
      }
      await tx.query('insert into voted_settings (workspace_id) values ($1) on conflict (workspace_id) do nothing', [ws]);
      const s = (await tx.query('select * from voted_settings where workspace_id = $1 for update', [ws])).rows[0];
      const change = {};
      const set = async (col, value, cast = '') => { await tx.query(`update voted_settings set ${col} = $2${cast}, updated_at = now() where workspace_id = $1`, [ws, value]); };
      if (!mode && input.on === true && s.practice) {
        await tx.query('update voted_settings set practice = false where workspace_id = $1', [ws]);
        const n = (await tx.query('delete from gotv_practice where workspace_id = $1', [ws])).affectedRows
          + (await tx.query('delete from gotv_checks where workspace_id = $1 and practice', [ws])).affectedRows;
        Object.assign(change, { mode: 'on', practice: false, practice_cleared: n });
      }
      if (mode) {
        const wasPractice = Boolean(s.practice);
        if (mode === 'practice') {
          const row = await rowOf(tx, ws);
          const fresh = { ...row, on_day: Boolean(s.on_day), auto: s.auto !== false, election_day: row.election_day, advance_days: row.advance_days };
          if (onNow(fresh, tz)) throw httpError(409, WORDS.practiceOn);
        }
        await tx.query('update voted_settings set on_day = $2, practice = $3, updated_at = now() where workspace_id = $1', [ws, mode === 'on', mode === 'practice']);
        change.mode = mode;
        if (wasPractice && mode !== 'practice') {
          const n = (await tx.query('delete from gotv_practice where workspace_id = $1', [ws])).affectedRows
            + (await tx.query('delete from gotv_checks where workspace_id = $1 and practice', [ws])).affectedRows;
          change.practice = false;
          change.practice_cleared = n;
        } else if (mode === 'practice') change.practice = true;
        out.mode = mode;
      }
      if (input.practice_users) {
        const ids = [...new Set(input.practice_users)];
        const members = (await tx.query('select user_id from memberships where workspace_id = $1 and user_id = any($2::uuid[])', [ws, ids])).rows.map((r) => r.user_id);
        if (members.length !== ids.length) throw httpError(400, 'Pick people from this campaign');
        await set('practice_users', ids, '::uuid[]');
        change.practice_users = ids;
      }
      let ceo = s.ceo_answer ? (typeof s.ceo_answer === 'string' ? JSON.parse(s.ceo_answer) : s.ceo_answer) : null;
      let send = s.send;
      if (input.ceo_answer) {
        ceo = { allows_live: input.ceo_answer.allows_live, note: input.ceo_answer.note, by: ctx.user.id, at: new Date(now()).toISOString() };
        await set('ceo_answer', jsonb(ceo), '::jsonb');
        change.ceo_answer = ceo;
        // A recorded no takes live sending back at once.
        if (!ceo.allows_live && send === 'live') { send = 'after_close'; await set('send', send); change.send = send; }
      }
      if (input.send) {
        if (input.send === 'live' && !ceo?.allows_live) throw httpError(400, WORDS.ceo);
        await set('send', input.send);
        change.send = input.send;
      }
      if (input.close_override) {
        const cur = (typeof s.close_override === 'string' ? JSON.parse(s.close_override) : s.close_override) || {};
        for (const [d, hm] of Object.entries(input.close_override)) { if (hm) cur[d] = hm; else delete cur[d]; }
        await set('close_override', jsonb(cur), '::jsonb');
        change.close_override = cur;
      }
      if (input.release) {
        const cur = (typeof s.released === 'string' ? JSON.parse(s.released) : s.released) || [];
        const next = [...new Set([...cur, today(tz)])].sort();
        await set('released', jsonb(next), '::jsonb');
        change.released = next;
      }
      if (input.scope) { await set('scope', input.scope); change.scope = input.scope; }
      if (input.ready) {
        const cur = (typeof s.ready === 'string' ? JSON.parse(s.ready) : s.ready) || {};
        if (input.ready.done) cur[input.ready.key] = { by: ctx.user.id, at: new Date(now()).toISOString() };
        else delete cur[input.ready.key];
        await set('ready', jsonb(cur), '::jsonb');
        change.ready = cur;
      }
      if (Object.keys(change).length) emit('workspace', ws, 'update', change);
      return { ...out, ...change };
    },
  },

  ...postActions,
};
