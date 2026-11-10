// Today's "Needs you" (GET /api/brief, the desk's): the shifts in the next
// seven days that are short of the people they want — by their target
// ("need"), or by their limit where a shift from before targets has one
// (shared/shiftkinds.js shortBy: the same rule on every screen). A shift
// with neither wants no number, so it is never listed: no maximum doesn't
// mean nobody is watching.
//   body.shortShifts = [{ id, title, kind, role, location, starts_at,
//                         ends_at, need, capacity, filled, short }]
// soonest first, twenty at most; short: how many more it wants. Volunteers
// don't get it — their Today is their own shifts.
import { shortBy } from '@starbase/shared/shiftkinds';

export const briefShortShifts = async (db, ctx, body) => {
  if (ctx.role === 'volunteer') return;
  const rows = (await db.query(
    `select x.* from (
       select s.id, s.title, s.kind, s.role, s.location, s.starts_at, s.ends_at, s.need, s.capacity,
              (select count(*)::int from shift_assignments a
                where a.shift_id = s.id and a.status in ('assigned', 'confirmed', 'completed')) as filled
         from shifts s
        where s.workspace_id = $1 and s.deleted_at is null
          and s.starts_at >= now() and s.starts_at < now() + interval '7 days'
          and coalesce(s.need, s.capacity) is not null
     ) x
     where x.filled < coalesce(x.need, x.capacity)
     order by x.starts_at, x.id limit 20`,
    [ctx.workspaceId],
  )).rows;
  body.shortShifts = rows.map((s) => ({ ...s, short: shortBy(s) }));
};
