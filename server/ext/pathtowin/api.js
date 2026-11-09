// GET /api/pathtowin — the desk (the Data area, lib/perms.js; volunteers
// only when given it). Where the campaign stands against what it needs:
//
//   election   { day, from: 'gotv' | 'here' | null, days_left, weeks_left }
//              — GOTV & voting days' election day when it has one, else the
//              one set here
//   races      per slate (shared/canvass.js SLATES, in order): { code,
//              label, set, how, votes, supporters_needed, inputs, …pace }
//              (rules.js winNumber · paceOf)
//   standing   everyone on file by rating band, now
//   trend      the last 12 weeks, the oldest first (rules.js trendFrom)
//   last4      supporters gained, net, over the last 4 weeks
//   turfs      ranked, best first, with their score's parts and reasons
//              (rules.js rankTurfs); campaign_rate: the turfs' average
//              supporters per 100 doors knocked
//   rules      the score's numbers, for the screen's "How the score works"
//   settings   what's saved; can_edit: may this person change it
//   computed_at  when the counts were made (kept a minute: below)
//
// The counts (standing, trend, turfs) are kept for a minute per campaign
// (STARBASE_PTW_CACHE_MS; 0 turns it off), so a desk reloading the screen
// never recounts 300,000 people. ?fresh=1 counts again now. Drawing,
// changing or removing a turf, an import and the sample drop the kept copy
// (index.js); a saved number never needs a recount — the races are worked
// out on every read from the kept counts.
import { Hono } from 'hono';
import { SLATES } from '@starbase/shared/canvass';
import { mayRun } from '../../lib/perms.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { standing, statsReady, todayOf, trendRows, turfRows } from './numbers.js';
import { RULES, WEEKS, PACE_WEEKS, winNumber, paceOf, trendFrom, gainedOver, rankTurfs, daysBetween, isDay } from './rules.js';
import { actions, readSettings } from './actions.js';

export const api = new Hono();

const zoneOf = (tz) => {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ }); return tz || DEFAULT_TZ; } catch { return DEFAULT_TZ; }
};
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const cacheMs = () => {
  const v = Number(process.env.STARBASE_PTW_CACHE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
};

// workspace id → { key, at, promise }: one count at a time per campaign; a
// second reader while it runs waits for the same answer.
const kept = new Map();
export const forget = (ws) => { kept.delete(ws); };

const count = async (db, ws, today, tz) => {
  await statsReady(db);
  const [stand, rows, turfs] = await Promise.all([
    standing(db, ws),
    trendRows(db, ws, today, tz),
    turfRows(db, ws, tz),
  ]);
  const trend = trendFrom(rows, today, WEEKS);
  const ranked = rankTurfs(turfs, { today });
  return {
    standing: stand,
    trend,
    last4: gainedOver(trend, PACE_WEEKS),
    turfs: ranked.turfs,
    campaign_rate: ranked.campaign_rate,
    computed_at: new Date().toISOString(),
  };
};

export const countsFor = (db, ws, today, tz, { fresh = false } = {}) => {
  const key = `${today}|${tz}`;
  const hit = kept.get(ws);
  const ttl = cacheMs();
  // Joined while it runs (fresh or not); kept a minute once it's done.
  if (hit && hit.key === key && (!hit.done || (!fresh && Date.now() - hit.at < ttl))) return hit.promise;
  const entry = { key, at: Date.now(), done: false };
  entry.promise = count(db, ws, today, tz).then(
    (v) => { entry.done = true; entry.at = Date.now(); if (!ttl && kept.get(ws) === entry) kept.delete(ws); return v; },
    (e) => { if (kept.get(ws) === entry) kept.delete(ws); throw e; },
  );
  kept.set(ws, entry);
  return entry.promise;
};

api.get('/pathtowin', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const tz = zoneOf(ctx.workspace?.settings?.tz);
  const today = await todayOf(db, tz);
  const saved = await readSettings(db, ws);
  const gotv = (await db.query('select election_day from voted_settings where workspace_id = $1', [ws]).catch(() => ({ rows: [] }))).rows[0];
  const gotvDay = dateOnly(gotv?.election_day);
  const day = gotvDay || saved.election_day;
  const n = await countsFor(db, ws, today, tz, { fresh: c.req.query('fresh') === '1' });
  const races = SLATES.map((s) => {
    const inputs = saved.races[s.code] || null;
    const win = winNumber(inputs);
    const pace = win ? paceOf({ found: n.standing.supporters, needed: win.supporters, today, electionDay: day, last4: n.last4 }) : null;
    return {
      code: s.code,
      label: s.label,
      set: Boolean(win),
      how: win?.how ?? inputs?.how ?? null,
      votes: win?.votes ?? null,
      supporters_needed: win?.supporters ?? null,
      inputs,
      ...(pace || {}),
    };
  });
  const daysLeft = isDay(day) ? daysBetween(today, day) : null;
  return c.json({
    today,
    tz,
    election: {
      day: day || null,
      from: gotvDay ? 'gotv' : saved.election_day ? 'here' : null,
      days_left: daysLeft,
      weeks_left: daysLeft != null ? Math.round((daysLeft / 7) * 10) / 10 : null,
    },
    races,
    standing: n.standing,
    trend: n.trend,
    last4: n.last4,
    per_week_last4: n.last4 / PACE_WEEKS,
    turfs: n.turfs,
    campaign_rate: n.campaign_rate,
    rules: { ...RULES, weeks: WEEKS, pace_weeks: PACE_WEEKS },
    settings: saved,
    can_edit: mayRun(ctx, 'pathtowin.save', actions['pathtowin.save']),
    computed_at: n.computed_at,
  });
});
