// The push: each marked person's base.win calendar made to match what their
// calendar link would carry now (never a replay of events). A job, outside
// any write; every call through GSI's googleFetch, one at a time.
//
//   gcal.push    claims dirty links (busy_until: two servers never push one
//                person at once), oldest first, and reconciles each against
//                gcal_items by hash — an unchanged body costs no call. One
//                run: 60 s or 200 calls; one person: 50 calls a minute. It
//                hands its work back to the runner ({ later }), so no other
//                job waits behind Google. At its end, the next push for the
//                earliest moment someone can go, and the next sweep.
//   gcal.sweep   03:17 in the campaign's time zone: every ok link dirty
//                (drift: a changed address, a merge, a permission change)
//
// The per-event bookkeeping (gcal_items, dirty_at, busy_until, wait_until,
// cal_hash, last_ok_at) is written directly, like the runner's own jobs
// rows: a record of what was copied, not a campaign fact. A link's own life
// (ok, gone, reconnect) goes on the log through runAction.
import { shiftEvent } from '@starbase/shared/ics';
import { newId, runAction } from '../../lib/events.js';
import { enqueueJob } from '../../lib/jobs.js';
import { configuredUrl, shiftAppLink } from '../../lib/calendar.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { decide, permsOf } from '../../lib/perms.js';
import { googleFetch, grantFor, markReconnect } from '../../lib/google/tokens.js';
import { filingDays, isDesk, myShifts, seesMoney, votingDays } from '../calendar/content.js';
import {
  calBase, calBody, dayIn, eventIdOf, hashOf, nextDay, reasonOf, SCOPE_REASONS, toGoogle, wallToUtc,
} from './google.js';

export const PURPOSE = 'calendar.mine';
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
export const SAID = {
  gone: 'You deleted the base.win calendar in Google',
  reconnect: 'Connect Google Calendar again',
  left: 'base.win stopped updating your Google calendar — delete it there or use the calendar link',
};

// Bounds (tests may narrow them).
const BOUNDS = { runMs: 60_000, runCalls: 200, perMinute: 50, claim: 20 };
let clock = () => Date.now();
export const _setGcalForTest = ({ now, ...b } = {}) => {
  if (now !== undefined) clock = now || (() => Date.now());
  Object.assign(BOUNDS, b);
};
export const _resetGcalForTest = () => {
  Object.assign(BOUNDS, { runMs: 60_000, runCalls: 200, perMinute: 50, claim: 20 });
  clock = () => Date.now();
  minute.clear();
  running.clear();
};

// ── What goes in: exactly the calendar link's content (ext/calendar
// index.js /cal/<43>.ics), read fresh ──
export const desiredFor = async (db, ws, userId) => {
  const f = (await db.query(
    `select u.email, w.name, w.settings, m.role, m.permissions,
            exists (select 1 from candidates c where c.workspace_id = w.id and c.user_id = u.id
                      and c.removed_at is null and m.role = 'volunteer') as candidate
       from users u join workspaces w on w.id = $1
       left join memberships m on m.workspace_id = w.id and m.user_id = u.id
      where u.id = $2`,
    [ws, userId],
  )).rows[0];
  const out = new Map();
  if (!f?.role) return out;
  const settings = parseJ(f.settings, {}) || {};
  const tz = settings.tz || DEFAULT_TZ;
  const perms = permsOf(f.candidate ? 'candidate' : f.role, settings, parseJ(f.permissions, {}) || {});
  const entries = [];
  if (decide(perms, 'shifts') !== false) {
    for (const s of await myShifts(db, ws, f.email)) {
      entries.push(shiftEvent(s, {
        tz, private: false,
        booking: { arrive_at: s.arrive_at, leave_at: s.leave_at },
        appUrl: shiftAppLink(configuredUrl(), { desk: isDesk(f.role), id: s.id }),
      }));
    }
  }
  entries.push(...await votingDays(db, ws, f.name));
  if (seesMoney(f.role, perms)) entries.push(...await filingDays(db, ws));
  for (const e of entries) {
    const at = eventIdOf(e.uid);
    if (!at) continue;
    const body = toGoogle(e, at.id);
    // An all-day entry ends at 00:00 of its exclusive end, in the campaign's zone.
    const endsAt = e.allDay ? wallToUtc(e.end, '00:00', tz) : new Date(e.end);
    out.set(at.id, { kind: at.kind, body, hash: hashOf(body), endsAt });
  }
  return out;
};

export const campaignOf = async (db, ws) => {
  const w = (await db.query('select name, settings from workspaces where id = $1', [ws])).rows[0];
  const settings = parseJ(w?.settings, {}) || {};
  return { name: w?.name || '', tz: settings.tz || DEFAULT_TZ, on: settings.gcal?.on === true };
};

// ── A link's life, on the log ──
export const setLinkState = async (db, ws, userId, state, said = null, { action = 'gcal.state', clear = false } = {}) => {
  await runAction(db, { workspaceId: ws, actorId: null, action }, async (tx, emit) => {
    const r = await tx.query(
      `update gcal_links set state = $3, said = $4, busy_until = null, updated_at = now()
         ${clear ? ', calendar_id = null, cal_hash = null, dirty_at = null' : ''}
       where workspace_id = $1 and user_id = $2 and (state <> $3 or said is distinct from $4)`,
      [ws, userId, state, said],
    );
    if (clear) await tx.query('delete from gcal_items where workspace_id = $1 and user_id = $2', [ws, userId]);
    if (r.affectedRows) emit('gcal_link', userId, 'update', { state });
  });
};

// A link left at 'reconnect' while the grant reads ok again: reconnected
// from another campaign, whose log alone heard it. Back to ok, pushed soon.
export const revive = async (db, ws, userId) => {
  const c = await campaignOf(db, ws);
  if (!c.on) return false;
  let back = false;
  await runAction(db, { workspaceId: ws, actorId: null, action: 'gcal.state' }, async (tx, emit) => {
    const r = await tx.query(
      `update gcal_links set state = 'ok', said = null, dirty_at = now(), updated_at = now()
        where workspace_id = $1 and user_id = $2 and state = 'reconnect'`, [ws, userId],
    );
    if (!r.affectedRows) return;
    back = true;
    emit('gcal_link', userId, 'update', { state: 'ok' });
    await ensurePush(tx, ws);
    await ensureSweep(tx, ws, c.tz);
  });
  return back;
};

// ── Jobs: at most one pending push a campaign; the sweep once a date ──
export const ensurePush = async (tx, ws, runAt = null) => {
  // A push waiting for someone's pause is pulled forward: a pause holds back
  // only the person paused.
  if (!runAt) await tx.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'gcal.push' and status = 'pending' and run_at > now()`, [ws]);
  else await tx.query(`update jobs set run_at = least(run_at, $2::timestamptz) where workspace_id = $1 and kind = 'gcal.push' and status = 'pending'`, [ws, runAt]);
  const pending = (await tx.query(`select 1 from jobs where workspace_id = $1 and kind = 'gcal.push' and status = 'pending' limit 1`, [ws])).rows[0];
  // Keys are unique forever, done jobs included: a fresh one each time.
  if (!pending) await enqueueJob(tx, { workspaceId: ws, kind: 'gcal.push', runAt, key: `gcal-push-${newId()}` });
};

export const nextSweepAt = (tz, now = Date.now()) => {
  let day = dayIn(now, tz);
  let at = wallToUtc(day, '03:17', tz);
  if (at.getTime() <= now) { day = nextDay(day); at = wallToUtc(day, '03:17', tz); }
  return { day, at };
};
export const ensureSweep = async (tx, ws, tz) => {
  const { day, at } = nextSweepAt(tz);
  await enqueueJob(tx, { workspaceId: ws, kind: 'gcal.sweep', runAt: at.toISOString(), key: `gcal-sweep-${day}` });
};

const sweep = async (db, job) => {
  const ws = job.workspace_id;
  const c = await campaignOf(db, ws);
  await db.transaction(async (tx) => {
    if (!c.on) return;
    const n = await tx.query(`update gcal_links set dirty_at = now() where workspace_id = $1 and state = 'ok'`, [ws]);
    if (n.affectedRows) await ensurePush(tx, ws);
    await ensureSweep(tx, ws, c.tz);
  });
};

// ── The push ──
const minute = new Map(); // grant id → call times in the last minute
const running = new Set(); // campaigns with a push in this process
const callsInMinute = (grantId) => {
  const now = clock();
  const kept = (minute.get(grantId) || []).filter((t) => now - t < 60_000);
  minute.set(grantId, kept);
  return kept;
};

class Stop extends Error { constructor(why) { super(why); this.why = why; } }

const push = async (db, job) => {
  const ws = job.workspace_id;
  if (running.has(ws)) return { again: 5_000 };
  running.add(ws);
  return { later: run(db, ws).finally(() => running.delete(ws)) };
};

const run = async (db, ws) => {
  const st = { started: clock(), calls: 0, bound: false, serverWide: false, capped: false, logged: new Set() };
  const c = await campaignOf(db, ws);
  const seen = [];
  try {
    while (c.on && !st.bound && !st.serverWide) {
      const claimed = (await db.query(
        `update gcal_links set busy_until = now() + interval '2 minutes'
          where (workspace_id, user_id) in (
            select workspace_id, user_id from gcal_links
             where workspace_id = $1 and dirty_at is not null and state = 'ok'
               and (busy_until is null or busy_until < now()) and (wait_until is null or wait_until < now())
               and not (user_id = any($2::uuid[]))
             order by dirty_at limit $3 for update skip locked)
          returning user_id, dirty_at::text as dirty_at, calendar_id, cal_hash`,
        [ws, seen, BOUNDS.claim],
      )).rows.sort((a, b) => String(a.dirty_at).localeCompare(String(b.dirty_at)));
      if (!claimed.length) break;
      for (const link of claimed) {
        seen.push(link.user_id);
        if (st.bound || st.serverWide) {
          await release(db, ws, link.user_id);
          continue;
        }
        await pushOne(db, ws, c, link, st).catch(async (e) => {
          await release(db, ws, link.user_id);
          throw e;
        });
      }
    }
  } finally {
    if (c.on) {
      await db.transaction(async (tx) => {
        await nextPush(tx, ws, st);
        await ensureSweep(tx, ws, c.tz);
      });
    }
  }
};

const release = (db, ws, userId, extra = '') => db.query(
  `update gcal_links set busy_until = null${extra} where workspace_id = $1 and user_id = $2`, [ws, userId],
);

// The next push, for the earliest moment one of the dirty can go.
const nextPush = async (tx, ws, st) => {
  const rows = (await tx.query(
    `select l.wait_until, g.paused_until from gcal_links l left join google_grants g on g.user_id = l.user_id
      where l.workspace_id = $1 and l.state = 'ok' and l.dirty_at is not null`,
    [ws],
  )).rows;
  if (!rows.length) return;
  const now = Date.now();
  let ms;
  if (st.bound) ms = 1_000;
  else if (st.serverWide) ms = 60_000;
  else {
    const at = (r) => Math.max(now, r.wait_until ? new Date(r.wait_until).getTime() : 0, r.paused_until ? new Date(r.paused_until).getTime() : 0);
    ms = Math.min(...rows.map(at)) - now;
    if (st.capped) ms = Math.min(ms, 30_000);
  }
  ms = Math.min(Math.max(ms, 1_000), 3_600_000);
  await ensurePush(tx, ws, new Date(now + ms).toISOString());
};

const logOnce = (st, ws, code) => {
  if (st.logged.has(code)) return;
  st.logged.add(code);
  console.warn(`gcal: ${code} for a user in ${ws}`);
};

// One call through googleFetch, within the run's and the person's bounds.
const call = async (db, st, grant, method, path, body) => {
  if (st.calls >= BOUNDS.runCalls || clock() - st.started >= BOUNDS.runMs) { st.bound = true; throw new Stop('bound'); }
  const times = callsInMinute(grant.id);
  if (times.length >= BOUNDS.perMinute) { st.capped = true; throw new Stop('cap'); }
  times.push(clock());
  st.calls += 1;
  return googleFetch(db, grant, `${calBase()}${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  }, { retry: 'auth-only' });
};

// What a refusal means for the whole person (null: look at the status).
const personTrouble = async (db, ws, st, grant, r) => {
  const t = r.trouble;
  if (!t) return null;
  if (t.code === 'paused') return new Stop('paused');
  if (t.code === 'client' || t.code === 'unavailable') { st.serverWide = true; logOnce(st, ws, t.code); return new Stop('server'); }
  if (t.code === 'reconnect') {
    await setLinkState(db, ws, grant.userId, 'reconnect', t.said || grant.said || SAID.reconnect);
    return new Stop('reconnect');
  }
  if (t.code === 'denied') {
    const reason = reasonOf(r.body);
    if (SCOPE_REASONS.includes(reason)) {
      await markReconnect(db, grant, SAID.reconnect);
      await setLinkState(db, ws, grant.userId, 'reconnect', SAID.reconnect);
      return new Stop('reconnect');
    }
    if (reason === 'quotaExceeded') {
      logOnce(st, ws, '403 quotaExceeded');
      await db.query(`update gcal_links set wait_until = now() + interval '1 hour' where workspace_id = $1 and user_id = $2`, [ws, grant.userId]);
      return new Stop('wait');
    }
    return null; // that one item's problem
  }
  return new Stop(t.code);
};

const enc = encodeURIComponent;
const itemSet = (db, ws, userId, id, d, hash = d.hash) => db.query(
  `insert into gcal_items (workspace_id, user_id, event_id, kind, ends_at, hash) values ($1, $2, $3, $4, $5, $6)
   on conflict (workspace_id, user_id, event_id) do update set kind = excluded.kind, ends_at = excluded.ends_at, hash = excluded.hash, pushed_at = now()`,
  [ws, userId, id, d.kind, d.endsAt.toISOString(), hash],
);
const itemDrop = (db, ws, userId, id) => db.query('delete from gcal_items where workspace_id = $1 and user_id = $2 and event_id = $3', [ws, userId, id]);

const gone = async (db, ws, userId) => {
  await setLinkState(db, ws, userId, 'gone', SAID.gone, { clear: true });
  return new Stop('gone');
};

const pushOne = async (db, ws, c, link, st) => {
  const userId = link.user_id;
  const grant = await grantFor(db, { userId, workspaceId: ws }, PURPOSE);
  if (!grant || grant.state === 'reconnect') {
    await setLinkState(db, ws, userId, 'reconnect', grant?.said || SAID.reconnect);
    await release(db, ws, userId);
    return;
  }
  // not-allowed, domain: nothing to push here (the team's own change, or
  // GSI's, takes the link on); not left dirty, or the push would come round
  // again every second.
  if (grant.state !== 'ok') { await release(db, ws, userId, ', dirty_at = null'); return; }
  if (grant.pausedUntil && new Date(grant.pausedUntil).getTime() > Date.now()) { await release(db, ws, userId); return; }
  try {
    await reconcile(db, ws, c, link, st, grant);
    // Done: dirty only if marked again meanwhile.
    await db.query(
      `update gcal_links set dirty_at = case when dirty_at = $3::timestamptz then null else dirty_at end,
         busy_until = null, last_ok_at = now() where workspace_id = $1 and user_id = $2`,
      [ws, userId, link.dirty_at],
    );
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    await release(db, ws, userId);
  }
};

const reconcile = async (db, ws, c, link, st, grant) => {
  const userId = link.user_id;
  const cal = calBody(c.name, c.tz);
  const calHash = hashOf(cal);
  let calId = link.calendar_id;
  if (!calId || link.cal_hash !== calHash) {
    const r = calId
      ? await call(db, st, grant, 'PATCH', `/calendars/${enc(calId)}`, cal)
      : await call(db, st, grant, 'POST', '/calendars', cal);
    const stop = await personTrouble(db, ws, st, grant, r);
    if (stop) throw stop;
    if (calId && (r.status === 404 || r.status === 410)) throw await gone(db, ws, userId);
    if (!r.ok || (!calId && !r.body?.id)) {
      logOnce(st, ws, `${r.status} ${reasonOf(r.body) || ''}`.trim());
      await db.query(`update gcal_links set wait_until = now() + interval '1 hour' where workspace_id = $1 and user_id = $2`, [ws, userId]);
      throw new Stop('wait');
    }
    const made = !calId;
    if (made) calId = String(r.body.id);
    // Stopped (or forgotten) while Google was answering: a calendar made
    // just now is deleted again, never left in their Google account.
    const n = await db.query(`update gcal_links set calendar_id = $3, cal_hash = $4, updated_at = now() where workspace_id = $1 and user_id = $2 and state = 'ok'`,
      [ws, userId, calId, calHash]);
    if (!n.affectedRows) {
      if (made) await googleFetch(db, grant, `${calBase()}/calendars/${enc(calId)}`, { method: 'DELETE' }, { retry: 'auth-only' });
      throw new Stop('stopped');
    }
  }

  const want = await desiredFor(db, ws, userId);
  const have = new Map((await db.query(
    'select event_id, hash, ends_at from gcal_items where workspace_id = $1 and user_id = $2', [ws, userId],
  )).rows.map((r) => [r.event_id, r]));
  const events = `/calendars/${enc(calId)}/events`;
  const q = '?sendUpdates=none';

  const insert = async (id, d) => {
    let r = await call(db, st, grant, 'POST', `${events}${q}`, d.body);
    let stop = await personTrouble(db, ws, st, grant, r);
    if (stop) throw stop;
    if (r.status === 404) throw await gone(db, ws, userId);
    if (r.status === 409) {
      // The id exists, maybe as a deleted event: confirmed brings it back.
      r = await call(db, st, grant, 'PUT', `${events}/${enc(id)}${q}`, d.body);
      stop = await personTrouble(db, ws, st, grant, r);
      if (stop) throw stop;
    }
    if (r.ok) return itemSet(db, ws, userId, id, d);
    if (r.status === 403) {
      logOnce(st, ws, `403 ${reasonOf(r.body) || 'forbidden'}`);
      return itemSet(db, ws, userId, id, d, `refused:${d.hash}`);
    }
    logOnce(st, ws, String(r.status));
    return null;
  };

  for (const [id, d] of want) {
    const h = have.get(id);
    if (h && (h.hash === d.hash || h.hash === `refused:${d.hash}`)) continue;
    if (!h) { await insert(id, d); continue; }
    const r = await call(db, st, grant, 'PUT', `${events}/${enc(id)}${q}`, d.body);
    const stop = await personTrouble(db, ws, st, grant, r);
    if (stop) throw stop;
    if (r.ok) await itemSet(db, ws, userId, id, d);
    else if (r.status === 404 || r.status === 410) await insert(id, d); // deleted in Google: base.win's copy goes back
    // That one event's problem (moved to another calendar, say): not tried
    // again until the shift changes — forgotten, it would be sent on every push.
    else if (r.status === 403) { logOnce(st, ws, `403 ${reasonOf(r.body) || 'forbidden'}`); await itemSet(db, ws, userId, id, d, `refused:${d.hash}`); }
    else logOnce(st, ws, String(r.status));
  }
  const keepAfter = Date.now() - 29 * 86_400_000;
  for (const [id, h] of have) {
    if (want.has(id)) continue;
    // A past shift only fell out of the 30-day window: never deleted.
    if (new Date(h.ends_at).getTime() < keepAfter) { await itemDrop(db, ws, userId, id); continue; }
    const r = await call(db, st, grant, 'DELETE', `${events}/${enc(id)}${q}`);
    const stop = await personTrouble(db, ws, st, grant, r);
    if (stop) throw stop;
    if (r.ok || r.status === 404 || r.status === 410) await itemDrop(db, ws, userId, id);
    else if (r.status === 403) { logOnce(st, ws, `403 ${reasonOf(r.body) || 'forbidden'}`); await itemDrop(db, ws, userId, id); }
    else logOnce(st, ws, String(r.status));
  }
};

export const pushJobs = { 'gcal.push': push, 'gcal.sweep': sweep };
