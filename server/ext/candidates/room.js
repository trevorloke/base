// Room for call time: what a donor may still give this year on a slate,
// less what the slate has already been promised on call time.
//
//   room = the year's limit − gifts this year on the slate − what running
//          monthly gifts will still take this year (payments/limits.js
//          roomFor's rules, exactly) − open call-time pledges on the slate
//
// An open pledge: said on call time (any candidate's), not dropped, no gift
// in from that donor on that slate since the day it was said, and said in
// the last 60 days (PLEDGE_DAYS). The pledge list, the brief and the room
// all read it through openPledge below.
//
//   roomsFor(q, ws, personIds, slate)   Map id → { givenCents, committedCents, pledgedCents, roomCents }
//                                       — the card list: the limit read once, then one grouped
//                                       query each for gifts, monthly gifts and pledges
//   pledgedFor(q, ws, personId, slate)  one donor's open pledges (calltime.log, with roomFor)
import { capFor } from '../../lib/cap.js';
import { campaignNow } from '../payments/limits.js';
import { DEFAULT_SLATE } from '@starbase/shared/canvass';

export const PLEDGE_DAYS = 60;

// r: calltime_results; day: the campaign's today as a SQL parameter. The
// donor's gift that came in (gift_in) is the first one on or after the day
// it was said — on that very day, only one logged after the pledge (a gift
// they'd already given that morning isn't the one promised).
export const giftIn = (r) => `select g.amount_cents, g.date from gifts g
   where g.workspace_id = ${r}.workspace_id and g.person_id = ${r}.person_id and g.deleted_at is null
     and coalesce(g.slate, '${DEFAULT_SLATE}') = ${r}.slate
     and (g.date > ${r}.said_on or (g.date = ${r}.said_on and g.created_at >= ${r}.created_at))
   order by g.date, g.created_at limit 1`;
export const openPledge = (r, day) => `${r}.result = 'pledged' and ${r}.dropped_at is null
  and ${r}.said_on > ${day}::date - ${PLEDGE_DAYS} and not exists (${giftIn(r)})`;

export const pledgedFor = async (q, ws, personId, slate = DEFAULT_SLATE) => {
  const { day } = campaignNow(ws);
  return Number((await q.query(
    `select coalesce(sum(r.amount_cents), 0)::bigint as cents from calltime_results r
      where r.workspace_id = $1 and r.person_id = $2 and r.slate = $3 and ${openPledge('r', '$4')}`,
    [ws.id, personId, slate || DEFAULT_SLATE, day],
  )).rows[0].cents);
};

// roomFor (payments/limits.js) for many donors at once, less open pledges.
export const roomsFor = async (q, ws, personIds, slate = DEFAULT_SLATE, { now = new Date() } = {}) => {
  const out = new Map();
  if (!personIds.length) return out;
  const s = slate || DEFAULT_SLATE;
  const { day, year, monthIndex } = campaignNow(ws, now);
  const rule = await capFor(q, ws.jurisdiction, year, ws.settings || {});
  const capCents = rule ? Number(rule.capCents) : null;
  const byPerson = async (sql, params) => new Map((await q.query(sql, params)).rows.map((r) => [r.person_id, r]));
  const given = await byPerson(
    `select person_id, coalesce(sum(amount_cents), 0)::bigint as total from gifts
      where workspace_id = $1 and person_id = any($2::uuid[]) and deleted_at is null and coalesce(slate, $3) = $4
        and date >= make_date($5, 1, 1) and date < make_date($5 + 1, 1, 1) group by person_id`,
    [ws.id, personIds, DEFAULT_SLATE, s, year],
  );
  const pledges = (await q.query(
    `select person_id, amount_cents, starts_on from gift_pledges
      where workspace_id = $1 and person_id = any($2::uuid[]) and stopped_at is null and coalesce(slate, $3) = $4`,
    [ws.id, personIds, DEFAULT_SLATE, s],
  )).rows;
  const month = day.slice(0, 7);
  const paid = pledges.length ? await byPerson(
    `select distinct person_id from gifts where workspace_id = $1 and person_id = any($2::uuid[]) and deleted_at is null
        and cadence = 'monthly' and coalesce(slate, $3) = $4 and to_char(date, 'YYYY-MM') = $5`,
    [ws.id, [...new Set(pledges.map((p) => p.person_id))], DEFAULT_SLATE, s, month],
  ) : new Map();
  const said = await byPerson(
    `select r.person_id, coalesce(sum(r.amount_cents), 0)::bigint as cents from calltime_results r
      where r.workspace_id = $1 and r.person_id = any($2::uuid[]) and r.slate = $3 and ${openPledge('r', '$4')}
      group by r.person_id`,
    [ws.id, personIds, s, day],
  );
  for (const id of personIds) {
    let committedCents = 0;
    for (const p of pledges) {
      if (p.person_id !== id) continue;
      // As roomFor: each payment left this year, this month's until it has come in.
      const start = p.starts_on instanceof Date ? p.starts_on.toISOString().slice(0, 7) : String(p.starts_on).slice(0, 7);
      const firstMonth = start > month ? Number(start.slice(5, 7)) - 1 : monthIndex;
      const left = start.slice(0, 4) > String(year) ? 0 : Math.max(0, 12 - firstMonth - (start <= month && paid.has(id) ? 1 : 0));
      committedCents += Number(p.amount_cents) * left;
    }
    const givenCents = Number(given.get(id)?.total ?? 0);
    const pledgedCents = Number(said.get(id)?.cents ?? 0);
    out.set(id, {
      capCents, givenCents, committedCents, pledgedCents,
      roomCents: capCents == null ? null : Math.max(0, capCents - givenCents - committedCents - pledgedCents),
    });
  }
  return out;
};
