// Lit drops — "Left lit" at the door.
//
// A lit drop (a piece hung on the door, nobody talked to) is its own
// outcome, 'left_lit', logged through contact.log like any knock: the walk
// list's "Left lit" logs it for everyone at the door (the outbox, so it
// works with no signal), the map's door card for the person picked there.
// It finishes a door like any door contact, sets no rating, and is never
// counted as Reached; Today counts the doors lit this week on its own
// ("You N · Team N doors lit this week"), and Reports → Contacts by week
// has a Lit column.
//
//   sql.js      contacts.outcome takes 'left_lit' (the core check is widened)
//
// No actions, no api, no tables of its own.
import { sql } from './sql.js';

export { sql };

// Today (GET /api/brief): field.lit — distinct doors with a door contact
// left lit in the last 7 days, the door being the address + unit (the walk
// list's grouping), or the person when they have no address, exactly as the
// core's field.doors counts it — and field.mine.lit, the same over the
// contacts the signed-in person logged. field.doors already counts these
// doors too (a lit door was visited).
export const briefLit = async (db, ctx, body) => {
  const r = (await db.query(
    `select count(distinct w.door)::int as lit,
            count(distinct w.door) filter (where w.created_by = $2)::int as mine
     from (
       select c.created_by,
              case when nullif(trim(p.address), '') is null then p.id::text
                   else lower(trim(p.address)) || '|' || lower(trim(coalesce(p.unit, ''))) end as door
       from contacts c join persons p on p.id = c.person_id
       where c.workspace_id = $1 and c.channel = 'door' and c.outcome = 'left_lit'
         and c.created_at >= now() - interval '7 days'
     ) w`,
    [ctx.workspaceId, ctx.user.id],
  )).rows[0];
  body.field = body.field || {};
  body.field.lit = r.lit;
  body.field.mine = { ...(body.field.mine || {}), lit: r.mine };
};

export const hooks = { brief: briefLit };
