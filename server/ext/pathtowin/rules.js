// Path to win — the arithmetic, with no database, so every sum is checked by
// hand in the tests (server/test/pathtowin.test.js):
//
//   winNumber(race)        votes needed to win a race, and the supporters to
//                          find for them — from the campaign's own numbers,
//                          never from any jurisdiction's rules
//   paceOf({ … })          what's still needed, the weekly pace to election
//                          day, the last 4 weeks' pace and where it leads
//   trendFrom(rows, today) the week-by-week counts, from when each rating
//                          began and ended (numbers.js reads them)
//   rankTurfs(rows, …)     each turf's score out of 100, in four parts that
//                          add up, each with its reason in plain words
//
// The score, as the screen says it: up to 60 points for supporters still to
// find (doors not yet knocked × supporters per 100 doors knocked), up to 30
// for persuadables left (people rated 3), up to 10 for time since the last
// knock (4 weeks or more, or never: all 10) — each part compared with the
// campaign's other turfs. A turf with under 20 doors knocked uses the
// average of all the turfs for its supporters per 100 doors.

export const WEEKS = 12;     // the trend: this many weeks, the oldest first
export const PACE_WEEKS = 4; // "the pace of the last 4 weeks"
export const RULES = Object.freeze({
  minKnocked: 20, // under this many doors knocked, a turf uses the turfs' average rate
  find: 60,       // points for supporters still to find
  persuade: 30,   // points for persuadables left
  rest: 10,       // points for time since the last knock
  restDays: 28,   // knocked this long ago or more (or never): all the rest points
  next: 60,       // a score this high or more: work it next
  soon: 30,       // this high or more: soon; under it: later
});
export const PRIORITIES = ['next', 'soon', 'later', 'done'];

// ── Numbers as typed ──
// A percent as typed (0.1 to 100, one decimal at most) → tenths of a
// percent (1 to 1000), or null. Whole-number arithmetic from there on, so
// 400,000 × 30% × 25% is exactly 30,000.
export const tenths = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const t = Math.round(n * 10);
  return t >= 1 && t <= 1000 && Math.abs(n * 10 - t) < 1e-6 ? t : null;
};
const whole = (v) => (Number.isInteger(v) && v > 0 ? v : null);

// { votes, supporters, how } — or null when the race isn't set.
//   direct:  votes as typed
//   worked:  eligible voters × expected turnout × share needed, rounded up
//            (part of a vote short is a vote short)
// supporters: the votes ÷ the share of supporters who vote (vote_rate),
// rounded up; with no vote_rate, one supporter found is one vote.
export const winNumber = (race) => {
  if (!race || typeof race !== 'object') return null;
  let votes = null;
  if (race.how === 'direct') votes = whole(race.votes);
  else if (race.how === 'worked') {
    const e = whole(race.eligible);
    const t = tenths(race.turnout);
    const s = tenths(race.share);
    if (e && t && s) votes = Math.ceil((e * t * s) / 1e6);
  }
  if (!votes) return null;
  const r = tenths(race.vote_rate);
  return { votes, supporters: r ? Math.ceil((votes * 1000) / r) : votes, how: race.how };
};

// ── Dates (YYYY-MM-DD, the campaign's days) ──
export const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// ── The pace ──
// found: supporters identified now · needed: supporters needed (winNumber)
// last4: the net supporters gained over the last 4 weeks (trend).
//   still            how many more to find (0 once there)
//   days_left        days from today to election day (null: no day set)
//   per_week_needed  still ÷ the weeks left, rounded up (null with no
//                    election day ahead)
//   per_week_last4   the last 4 weeks' gain ÷ 4
//   projected        where the last 4 weeks' pace leads by election day
//   on_pace          the last 4 weeks' pace keeps up (true once there;
//                    null with no election day ahead)
export const paceOf = ({ found, needed, today, electionDay, last4 }) => {
  const still = Math.max(0, needed - found);
  const daysLeft = electionDay && isDay(electionDay) && isDay(today) ? daysBetween(today, electionDay) : null;
  // A quarter of a whole number: exact (52, 0.25), never rounded here.
  const perWeekLast4 = (Number(last4) || 0) / PACE_WEEKS;
  const ahead = daysLeft != null && daysLeft > 0;
  const perWeekNeeded = ahead ? Math.ceil((still * 7) / daysLeft) : null;
  const projected = ahead ? Math.max(0, found + Math.floor(perWeekLast4 * (daysLeft / 7))) : null;
  return {
    found,
    needed,
    still,
    pct: needed > 0 ? Math.min(100, Math.floor((100 * found) / needed)) : 0,
    days_left: daysLeft,
    weeks_left: daysLeft != null ? Math.round((daysLeft / 7) * 10) / 10 : null,
    per_week_needed: perWeekNeeded,
    per_week_last4: perWeekLast4,
    projected,
    on_pace: still === 0 ? true : perWeekNeeded == null ? null : perWeekLast4 >= perWeekNeeded,
  };
};

// ── The week-by-week trend ──
// rows: [{ band, w, n }] — each rating's start (+1) and its end (−1, when a
// newer rating replaced it), counted by band (support · undecided ·
// opposed) and by how many weeks ago it happened (w: 0 = the 7 days to
// today, … WEEKS = that long ago or more). The count at the end of a week is
// everything that started then or before, less what ended by then.
// → the WEEKS weeks, the oldest first: { start, end, supporters,
//   persuadables, opposed, gained } (gained: supporters, net, that week).
export const BANDS = ['support', 'undecided', 'opposed'];
export const trendFrom = (rows, today, weeks = WEEKS) => {
  const delta = Object.fromEntries(BANDS.map((b) => [b, new Array(weeks + 1).fill(0)]));
  for (const r of rows || []) {
    const w = Number(r.w);
    if (delta[r.band] && Number.isInteger(w) && w >= 0 && w <= weeks) delta[r.band][w] += Number(r.n) || 0;
  }
  const level = (band, k) => delta[band].slice(k).reduce((a, b) => a + b, 0);
  const points = [];
  for (let k = weeks - 1; k >= 0; k -= 1) {
    const end = addDays(today, -7 * k);
    points.push({
      start: addDays(end, -6),
      end,
      supporters: level('support', k),
      persuadables: level('undecided', k),
      opposed: level('opposed', k),
      gained: delta.support[k],
    });
  }
  return points;
};
// The supporters gained, net, over the last `n` weeks of a trend.
export const gainedOver = (points, n = PACE_WEEKS) => points.slice(-n).reduce((a, p) => a + p.gained, 0);

// ── The turfs ──
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-CA');
// 18.25 → "18.3"; 18 → "18"; 4.5 → "4.5"
export const rateText = (r) => (r == null ? '' : (Math.round(r * 10) / 10).toLocaleString('en-CA', { maximumFractionDigits: 1 }));
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${Math.round(n) === 1 ? one : many}`;

// The reasons, in the screen's words, each with its points.
const findWords = (t) => {
  if (!t.doors) return 'Nobody on the map inside this turf yet';
  if (!t.doors_left) return 'Every door knocked';
  if (t.rate_from === 'turf') return `${plural(t.doors_left, 'door')} not yet knocked × ${rateText(t.rate)} supporters per 100 doors ≈ ${plural(t.to_find, 'supporter')} to find`;
  if (t.rate_from === 'campaign') return `${plural(t.doors_left, 'door')} not yet knocked × ${rateText(t.rate)} per 100 doors (your turfs’ average — under ${RULES.minKnocked} knocked here) ≈ ${plural(t.to_find, 'supporter')} to find`;
  return `${plural(t.doors_left, 'door')} not yet knocked (no doors knocked anywhere yet)`;
};
const persuadeWords = (t) => (t.persuadables ? `${plural(t.persuadables, 'persuadable')} left (rated 3)` : 'No persuadables left');
const restWords = (t) => {
  if (t.days_since == null) return 'Never knocked';
  if (t.days_since === 0) return 'Knocked today';
  return `Last knocked ${plural(t.days_since, 'day')} ago`;
};

// rows: per turf { id, name, color, polygon, doors, knocked, people,
// supporters, persuadables, opposed, sup_at_knocked, last_at, last_day }
// (numbers.js; last_day: the last knock's day in the campaign's zone)
// → { turfs (ranked, best first), campaign_rate }. Each turf adds:
//   doors_left, rate (supporters per 100 doors knocked: its own once
//   RULES.minKnocked doors are knocked, else the turfs' average) and
//   rate_from ('turf' | 'campaign' | null), to_find (doors_left × rate ÷
//   100), days_since (campaign days since the last knock, null: never),
//   parts { find, persuade, rest } (whole points), score (their sum),
//   priority ('next' | 'soon' | 'later' | 'done'), rank, reasons.
export const rankTurfs = (rows, { today }) => {
  const sum = (k) => rows.reduce((a, t) => a + (Number(t[k]) || 0), 0);
  const knockedAll = sum('knocked');
  const campaignRate = knockedAll > 0 ? (100 * sum('sup_at_knocked')) / knockedAll : null;
  const base = rows.map((t) => {
    const doors = Number(t.doors) || 0;
    const knocked = Number(t.knocked) || 0;
    const doorsLeft = Math.max(0, doors - knocked);
    const own = knocked >= RULES.minKnocked ? (100 * (Number(t.sup_at_knocked) || 0)) / knocked : null;
    const rate = own ?? campaignRate;
    const lastDay = isDay(t.last_day) ? t.last_day : null;
    return {
      ...t,
      doors,
      knocked,
      doors_left: doorsLeft,
      rate,
      rate_from: own != null ? 'turf' : campaignRate != null ? 'campaign' : null,
      to_find: rate != null ? (doorsLeft * rate) / 100 : null,
      days_since: lastDay ? Math.max(0, daysBetween(lastDay, today)) : null,
      last_at: t.last_at ? new Date(t.last_at).toISOString() : null,
    };
  });
  // With no doors knocked anywhere, doors left stand in for supporters to find.
  const measure = (t) => (campaignRate != null ? t.to_find : t.doors_left);
  const maxFind = Math.max(0, ...base.map(measure));
  const maxPers = Math.max(0, ...base.map((t) => Number(t.persuadables) || 0));
  const out = base.map((t) => {
    const done = t.doors_left === 0 && !(Number(t.persuadables) > 0);
    const parts = done ? { find: 0, persuade: 0, rest: 0 } : {
      find: maxFind > 0 ? Math.round((RULES.find * measure(t)) / maxFind) : 0,
      persuade: maxPers > 0 ? Math.round((RULES.persuade * (Number(t.persuadables) || 0)) / maxPers) : 0,
      rest: Math.round((RULES.rest * Math.min(t.days_since ?? RULES.restDays, RULES.restDays)) / RULES.restDays),
    };
    const score = parts.find + parts.persuade + parts.rest;
    const priority = done ? 'done' : score >= RULES.next ? 'next' : score >= RULES.soon ? 'soon' : 'later';
    const reasons = done
      ? [{ key: 'done', points: 0, text: t.doors ? 'Nothing left to do: every door knocked, no persuadables' : 'Nobody on the map inside this turf yet' }]
      : [
        { key: 'find', points: parts.find, text: findWords(t) },
        { key: 'persuade', points: parts.persuade, text: persuadeWords(t) },
        { key: 'rest', points: parts.rest, text: restWords(t) },
      ];
    return { ...t, parts, score, priority, reasons, _m: measure(t) || 0 };
  });
  out.sort((a, b) => (b.score - a.score) || (b._m - a._m) || (b.doors_left - a.doors_left)
    || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  return {
    campaign_rate: campaignRate,
    turfs: out.map(({ _m, ...t }, i) => ({ ...t, rank: i + 1 })),
  };
};
