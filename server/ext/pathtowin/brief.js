// Today's win number (GET /api/brief → goal), for the desk people who may
// open Path to win (desk roles with the Data area): supporters found
// against the first race in the race list (STARBASE_SLATES order) whose
// numbers are saved, with the days left and the weekly pace to get there.
//
//   set:   { set: true, race, label, supporters, needed, still, pct,
//            days_left, per_week_needed, others }
//   unset: { set: false, supporters, can_set }   (only managers save it)
//   a failure: { unavailable: true } — the brief never fails for it
//
// Supporters come from the brief's own count by rating ('1' + '2', the
// same rule as Path to win's standing), so this adds no count over the
// people: two saved-settings reads and the campaign's today (todayOf, the
// same clock as Path to win and a candidate's Your race). The last four
// weeks' pace needs the trend count, so it stays on Path to win.
import { SLATES } from '@starbase/shared/canvass';
import { areasFor } from '../../lib/perms.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { readSettings } from './actions.js';
import { todayOf } from './numbers.js';
import { winNumber, paceOf } from './rules.js';

// What it reads, by name, so a test can make one fail.
export const deps = { readSettings, todayOf };

const zoneOf = (tz) => {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ }); return tz || DEFAULT_TZ; } catch { return DEFAULT_TZ; }
};
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

export const briefGoal = async (db, ctx, body) => {
  if (ctx.role === 'volunteer' || !areasFor(ctx).includes('data')) return;
  const supporters = (Number(body.ratings?.['1']) || 0) + (Number(body.ratings?.['2']) || 0);
  try {
    const ws = ctx.workspaceId;
    const saved = await deps.readSettings(db, ws);
    const set = SLATES.map((s) => ({ s, win: winNumber(saved.races[s.code] || null) })).filter((r) => r.win);
    if (!set.length) {
      body.goal = { set: false, supporters, can_set: ctx.role === 'manager' };
      return;
    }
    const { s, win } = set[0];
    const today = await deps.todayOf(db, zoneOf(ctx.workspace?.settings?.tz));
    const gotv = (await db.query('select election_day from voted_settings where workspace_id = $1', [ws])).rows[0];
    const day = dateOnly(gotv?.election_day) || saved.election_day;
    const pace = paceOf({ found: supporters, needed: win.supporters, today, electionDay: day, last4: 0 });
    body.goal = {
      set: true,
      race: s.code,
      label: s.label,
      supporters,
      needed: win.supporters,
      still: pace.still,
      pct: pace.pct,
      days_left: pace.days_left,
      per_week_needed: pace.per_week_needed,
      others: set.length - 1,
    };
  } catch (e) {
    console.error('brief: path to win unavailable:', e.message);
    body.goal = { unavailable: true };
  }
};
