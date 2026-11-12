// Relationships — relational organizing: who knows whom.
//
// A link says two people in the directory know each other ("Priya knows
// Sam"), with a kind (Family · Friend · Neighbour · Work · Community · Other)
// and an optional short note. Links are undirected and deduped; removing one
// is an action too. A volunteer keeps "My people" — the people they know —
// adds someone new (found first by the dedupe rules, else added, "Brought in
// by" them), and reaches them from there: Call or Text (the Calls card) or a
// talk in person, logged through contact.log (channel 'in_person'), so counts,
// ladders and surveys work as for any other contact. The desk sees a
// profile's Knows (with a nudge naming a supporter who knows an undecided
// voter) and People → Most connected. A tie can be marked close; the key
// ties (shared/ties.js) show when someone is pulled up; and People, lists
// and sends can pick people by who they know (knows=, below).
//
//   sql.js      the relationships table; contacts.channel takes 'in_person'
//   match.js    the signed-in person's record; who is already on the list
//   actions.js  relationship.add · relationship.update · relationship.remove
//   api.js      GET /api/relationships/mine (any role) and the desk-only reads
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { myPeopleCount } from './api.js';
import { decide } from '../../lib/perms.js';

// Who reads other people's ties: a profile's Knows, the key read, Most
// connected and the knows= rule. One line for a new role (a candidate).
export const TIE_READERS = ['manager', 'treasurer', 'staff'];

// Today: the in-person talks of the last 7 days — inPerson: { week, mine }
// beside the core's field counts (doors, calls, texts; field.week already
// counts every contact, these too) — and how many people the signed-in
// person knows (myPeople: "My people · 6").
const brief = async (db, ctx, body) => {
  const r = (await db.query(
    `select count(*)::int as n, (count(*) filter (where created_by = $2))::int as mine from contacts
     where workspace_id = $1 and channel = 'in_person' and created_at >= now() - interval '7 days'`,
    [ctx.workspaceId, ctx.user.id],
  )).rows[0];
  body.inPerson = { week: r.n, mine: r.mine };
  body.myPeople = await myPeopleCount(db, ctx);
};

// knows= — People, lists, sends, banks and passes (lib/audience.js FILTER_KEYS):
//   supporter   knows someone rated 1 or 2
//   donor       knows someone with a gift (the Donations area's, as gave=)
//   volunteer   knows someone tagged volunteer or holding a volunteer role
//   any         knows anyone (a live link)
//   person:<id> knows that person
// Anything else, or someone not in this campaign, matches nobody. Only
// TIE_READERS sort by it, and only with People — but a list the desk saved
// is read whole wherever it is read (a send, a count), as gave= is. A
// volunteer, granted People or not, gets nobody; so does a list a volunteer
// made (read with a volunteer's eyes: ext/lists audience.js).
// From the small table: each end of a live link through its own index.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const knowsSql = (ws, cond, person = null) => `p.id in (
     select r.person_a from relationships r join persons o on o.id = r.person_b
      where r.workspace_id = ${ws} and r.removed_at is null and o.deleted_at is null${person ? ` and r.person_b = ${person}` : ''} and ${cond}
     union all
     select r.person_b from relationships r join persons o on o.id = r.person_a
      where r.workspace_id = ${ws} and r.removed_at is null and o.deleted_at is null${person ? ` and r.person_a = ${person}` : ''} and ${cond}
   )`;
const personsWhere = async (db, ctx, query, w) => {
  const v = String(query?.knows ?? '').trim().slice(0, 60);
  if (!v) return;
  const next = (x) => { w.params.push(x); return `$${w.params.length}`; };
  const add = (sql) => { w.where += sql ? ` and ${sql}` : ' and false'; };
  const desk = TIE_READERS.includes(ctx.role);
  const people = desk && (Boolean(ctx.listTrail?.length) || !ctx.perms || decide(ctx.perms, 'people') !== false);
  if (!people) return add(null);
  const money = Boolean(ctx.listTrail?.length) || !ctx.perms || decide(ctx.perms, 'money') !== false;
  if (v === 'supporter') return add(knowsSql('$1', `o.rating in ('1', '2')`));
  if (v === 'donor') {
    return add(money ? knowsSql('$1', 'exists (select 1 from gifts g where g.workspace_id = o.workspace_id and g.person_id = o.id and g.deleted_at is null)') : null);
  }
  if (v === 'volunteer') {
    return add(knowsSql('$1', `(o.tags @> '["volunteer"]'::jsonb
        or exists (select 1 from volunteer_roles vr where vr.workspace_id = o.workspace_id and vr.person_id = o.id))`));
  }
  if (v === 'any') return add(knowsSql('$1', 'true'));
  const m = /^person:(.+)$/.exec(v);
  if (m && UUID_RE.test(m[1])) return add(knowsSql('$1', 'true', `${next(m[1].toLowerCase())}::uuid`));
  return add(null);
};

export const hooks = { brief, personsWhere };

// In the full export: every link, removed ones included.
export const exportTables = ['relationships'];

// Volunteers read only their own circle (/relationships/mine). A profile's
// Knows, the key ties and Most connected are desk reads.
export const deskOnlyReads = [
  '/persons/:id/knows',
  '/relationships/connected',
  '/relationships/key',
];
