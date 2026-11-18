// GOTV's day clock: every time question on a voting day, answered in one
// place, by the one clock tests can move (lib/clock.js now()) and B.C.'s
// rule (lib/tzrule.js atLocal), so GOTV and the voter guide flip together.
//
//   hoursOf(db, ws)        the voter guide's hours: vote_days, and each
//                          voting place's own days, hours and closed_on
//                          (places.kind = 'voting'; VG's tables, read only)
//   votingDays(s)          GOTV's days: advance_days and election_day
//   closeAt(h, s, D, P, tz)  when day D's voting closes at place P (ms), or
//                          null: the place's own closes for D, then the
//                          manager's close_override[D], then vote_days.
//                          No place: the latest close over the places open
//                          on D (a place closed on D is left out), so
//                          nothing is sent before every place has closed.
//   windowEnd(h, s, D, tz) the end of D's work window: the later of noon the
//                          next day and the next voting day's first opening
//                          (07:00 when not entered), at most 7 days after
//                          the last voting day
//   sendOpen(h, s, D, P, tz, at)  a name written on D at P may reach the
//                          office: send 'live', D released, or past D's close
//
// Base.win never assumes hours: with none entered, closeAt is null and names
// wait for a manager's "Polls are closed — send names now" (released).
import { now } from '../../lib/clock.js';
import { atLocal, localDay, nextDay } from '../../lib/tzrule.js';
import { DEFAULT_TZ } from '../../lib/org.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^\d{2}:\d{2}$/;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

export const tzOf = (ctx) => {
  const tz = ctx?.workspace?.settings?.tz || DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
};
// The campaign day of a moment (ms or an ISO string).
export const dayOf = (at, tz) => localDay(typeof at === 'number' ? at : Date.parse(at), tz);
export const today = (tz) => localDay(now(), tz);

// The guide's hours, kept 5 s per campaign; any guide or place write drops
// them (live.js, after commit).
const KEEP_MS = 5_000;
const kept = new Map(); // ws → { at, hours }
export const forgetHours = (ws) => { if (ws) kept.delete(ws); else kept.clear(); };
export const hoursOf = async (db, ws) => {
  const hit = kept.get(ws);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.hours;
  const days = new Map();
  for (const r of (await db.query(
    "select to_char(day, 'YYYY-MM-DD') as day, opens, closes from vote_days where workspace_id = $1 and deleted_at is null", [ws],
  )).rows) days.set(r.day, { opens: r.opens, closes: r.closes });
  const places = new Map();
  for (const r of (await db.query(
    `select p.id, p.name, p.deleted_at is not null as gone, i.place_id is not null as listed, i.days,
            to_char(i.closed_on, 'YYYY-MM-DD') as closed_on
       from places p left join vote_place_info i on i.place_id = p.id
      where p.workspace_id = $1 and p.kind = 'voting'`, [ws],
  )).rows) {
    const own = new Map();
    for (const d of parseJ(r.days, [])) if (d && DAY_RE.test(d.day)) own.set(d.day, { opens: d.opens || null, closes: d.closes || null });
    places.set(r.id, { id: r.id, name: r.name, gone: r.gone, listed: r.listed, days: own, closed_on: r.closed_on || null });
  }
  const hours = { days, places };
  kept.set(ws, { at: Date.now(), hours });
  return hours;
};

export const votingDays = (s) => {
  const out = new Set((s?.advance_days || []).filter((d) => DAY_RE.test(d)));
  if (s?.election_day) out.add(dateOnly(s.election_day));
  return [...out].sort();
};

const overrideOf = (s, day) => {
  const v = parseJ(s?.close_override, {})?.[day];
  return HM_RE.test(v || '') ? v : null;
};
// One place's closing wall time for D, or null.
const placeClose = (h, s, day, place) => place?.days.get(day)?.closes || overrideOf(s, day) || h.days.get(day)?.closes || null;
// The places with voting on D: listed in the guide with D among their days,
// not removed, not closed that day.
export const placesOpenOn = (h, day) => [...h.places.values()].filter((p) => !p.gone && p.listed && p.days.has(day) && p.closed_on !== day);

export const closeAt = (h, s, day, placeId, tz) => {
  const place = placeId ? h.places.get(placeId) : null;
  if (place && !place.gone) {
    const hm = placeClose(h, s, day, place);
    return hm ? atLocal(day, hm, tz) : null;
  }
  const open = placesOpenOn(h, day);
  if (!open.length) {
    const hm = overrideOf(s, day) || h.days.get(day)?.closes || null;
    return hm ? atLocal(day, hm, tz) : null;
  }
  let latest = null;
  for (const p of open) {
    const hm = placeClose(h, s, day, p);
    if (!hm) return null; // one place with no closing time: none can be said
    const at = atLocal(day, hm, tz);
    if (latest === null || at > latest) latest = at;
  }
  return latest;
};

// The first opening of a voting day: the guide's day, or 07:00 when not
// entered (never earlier than the earliest place's own opening).
const openAt = (h, day, tz) => {
  let hm = h.days.get(day)?.opens || null;
  for (const p of h.places.values()) {
    const o = p.days.get(day)?.opens;
    if (!p.gone && o && (!hm || o < hm)) hm = o;
  }
  return atLocal(day, hm || '07:00', tz);
};

export const windowEnd = (h, s, day, tz) => {
  const days = votingDays(s);
  let end = atLocal(nextDay(day), '12:00', tz);
  const next = days.find((d) => d > day);
  if (next) end = Math.max(end, openAt(h, next, tz));
  const last = days.at(-1) || day;
  let cap = last;
  for (let i = 0; i < 8; i += 1) cap = nextDay(cap); // midnight ending the 7th day after
  return Math.min(end, atLocal(cap, '00:00', tz));
};
// Inside D's work window: from D's 00:00 to windowEnd.
export const inWindow = (h, s, day, tz, at = now()) => at >= atLocal(day, '00:00', tz) && at < windowEnd(h, s, day, tz);

export const releasedDays = (s) => parseJ(s?.released, []).filter((d) => DAY_RE.test(d));

export const sendOpen = (h, s, day, placeId, tz, at = now()) => {
  if (s?.send === 'live') return true;
  if (releasedDays(s).includes(day)) return true;
  const close = closeAt(h, s, day, placeId, tz);
  return close !== null && at >= close;
};

// When an election-day code's sign-in ends: the end of the work window of
// the post's last voting day (or of the campaign's, for a post on every
// day), as an ISO time; null (the usual 30 days) when no day is set. The
// session itself never lasts more than 30 days (lib/auth.js).
export const codeSessionEnds = async (db, ctx, userId) => {
  const ws = ctx.workspaceId;
  const s = (await db.query('select election_day, advance_days, close_override from voted_settings where workspace_id = $1', [ws])).rows[0];
  const post = (await db.query('select days from gotv_posts where workspace_id = $1 and user_id = $2 and ended_at is null', [ws, userId])).rows[0];
  const settings = { election_day: s?.election_day ? dateOnly(s.election_day) : null, advance_days: parseJ(s?.advance_days, []), close_override: parseJ(s?.close_override, {}) };
  const own = parseJ(post?.days, []).filter((d) => DAY_RE.test(d)).sort();
  const days = own.length ? own : votingDays(settings);
  const last = days.at(-1);
  if (!last) return null;
  const tz = tzOf(ctx);
  return new Date(windowEnd(await hoursOf(db, ws), settings, last, tz)).toISOString();
};
