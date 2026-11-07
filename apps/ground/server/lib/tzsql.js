// The campaign's clock in SQL, whatever the database's own copy of the
// time-zone rules says. B.C. stays on UTC-7 all year from March 8, 2026
// (no fall-back on Nov 1, 2026: tzdata 2026 and later). A database whose
// rules are older — PGlite's, or an older Postgres — still falls back,
// and then "today" in SQL starts an hour after the server's own today
// (lib/tzcheck.js says the same for Node). So for America/Vancouver the
// SQL here applies the new rule itself from that moment on, and the
// database's rules before it (where every copy agrees).
//   toLocal(x, p)    a timestamptz expression → the campaign's wall-clock time
//   fromLocal(x, p)  a wall-clock timestamp expression → the moment (timestamptz)
// p is the SQL for the zone's name, e.g. '$3::text'.
const BC = "'America/Vancouver'";
const SINCE_UTC = "timestamptz '2026-03-08 10:00:00+00'"; // 3 a.m. PDT, the last spring-forward
const SINCE_LOCAL = "timestamp '2026-03-08 03:00:00'";
const UTC7 = "interval '-07:00'";

export const toLocal = (x, p) => `(case when ${p} = ${BC} and (${x}) >= ${SINCE_UTC} then (${x}) at time zone ${UTC7} else (${x}) at time zone ${p} end)`;
export const fromLocal = (x, p) => `(case when ${p} = ${BC} and (${x}) >= ${SINCE_LOCAL} then (${x}) at time zone ${UTC7} else (${x}) at time zone ${p} end)`;
// The start of the campaign's today, n days back (0: today), as a moment.
export const startOfDay = (p, back = 0) => fromLocal(`date_trunc('day', ${toLocal('now()', p)})${back ? ` - interval '${Number(back)} days'` : ''}`, p);
