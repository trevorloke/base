// Who lives there, after a move: the people on file at the new address
// (there) and still at the old one (left), A–Z by last name, at most 50,
// never the mover. Same address = the same street line (lower case), unit
// and city, as the door card tells doors apart ("the same words in another
// city are another door"); lower(address) is indexed (persons_ws_addr_idx).
//
// A volunteer always gets left (the old door was in their turf: they could
// move the person only so), and there only when someone in it has a pin
// inside a turf they walk — never because of what they typed or sent, so a
// typed address never shows who lives somewhere else. Desk roles (and a
// volunteer granted People) get both, and whether a phone is on file.
import { decide } from '../../lib/perms.js';
import { azKey } from '../../lib/az.js';
import { inMyTurf } from '../core/index.js';

const LIMIT = 50;

export const mayMoveAnyone = (ctx) => ctx.role !== 'volunteer' || decide(ctx.perms, 'people') === true;

const at = async (db, ctx, moverId, address, unit, city) => {
  if (!address) return [];
  return (await db.query(
    `select p.id, p.name, p.rating, coalesce(p.phone, '') <> '' as phone_on_file, p.lat, p.lng
       from persons p
      where p.workspace_id = $1 and p.deleted_at is null and p.id <> $2
        and lower(p.address) = lower($3)
        and coalesce(lower(btrim(p.unit)), '') = coalesce(lower(btrim($4::text)), '')
        and coalesce(lower(btrim(p.city)), '') = coalesce(lower(btrim($5::text)), '')
      order by ${azKey('p')} limit ${LIMIT}`,
    [ctx.workspaceId, moverId, address, unit || null, city || null],
  )).rows;
};

const shape = (desk) => (r) => {
  const hasPin = r.lat != null && r.lng != null;
  return desk
    ? { id: r.id, name: r.name, rating: r.rating ?? null, phone_on_file: !!r.phone_on_file, has_pin: hasPin }
    : { id: r.id, name: r.name, rating: r.rating ?? null, has_pin: hasPin };
};

// move: a person_moves row. → { there, left, there_hidden }
export const doorLists = async (db, ctx, move) => {
  const desk = mayMoveAnyone(ctx);
  const left = (await at(db, ctx, move.person_id, move.from_address, move.from_unit, move.from_city)).map(shape(desk));
  if (move.result !== 'new') return { there: null, left, there_hidden: false };
  const rows = await at(db, ctx, move.person_id, move.to_address, move.to_unit, move.to_city);
  if (!desk) {
    let seen = false;
    for (const r of rows) {
      if (r.lat != null && r.lng != null && await inMyTurf(db, ctx, r.lat, r.lng)) { seen = true; break; }
    }
    if (!seen) return { there: null, left, there_hidden: true };
  }
  return { there: rows.map(shape(desk)), left, there_hidden: false };
};
