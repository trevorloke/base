// "Needs an address": people the team tapped Moved on whose latest own
// contact is still Moved and who have no move (a new address, or Address
// unknown) since that tap. One SQL fragment for the People filter
// (moved=open), the counts (Today, Reports) and the id set (Reports), so the
// three never disagree. It starts from contacts_moved_idx (the team's own
// Moved knocks, never an imported list's history): Postgres makes the "in"
// a semi-join driven from that small set, so the rest runs once per moved
// person, not once per person on file.
//   movedOpenWhere('p', '$1')  a condition on persons p of workspace $1
export const movedOpenWhere = (a = 'p', ws = '$1') => `${a}.id in (select c.person_id from contacts c
      where c.workspace_id = ${ws} and c.outcome = 'moved' and c.source is null)
  and (select c2.outcome from contacts c2
        where c2.workspace_id = ${a}.workspace_id and c2.person_id = ${a}.id and c2.source is null
        order by c2.created_at desc limit 1) = 'moved'
  and not exists (select 1 from person_moves m
        where m.workspace_id = ${a}.workspace_id and m.person_id = ${a}.id and m.undone_at is null
          and m.created_at >= (select max(c3.created_at) from contacts c3
                                where c3.workspace_id = ${a}.workspace_id and c3.person_id = ${a}.id
                                  and c3.outcome = 'moved' and c3.source is null))`;

// { open, unknown }: Needs an address, and Address unknown.
export const movedCounts = async (db, ws) => (await db.query(
  `select (select count(*)::int from persons p where p.workspace_id = $1 and p.deleted_at is null and ${movedOpenWhere('p', '$1')}) as open,
          (select count(*)::int from persons p where p.workspace_id = $1 and p.deleted_at is null and p.address_status = 'unknown') as unknown`,
  [ws],
)).rows[0];

// The ids of Needs an address, by id; after: the last id of the page before;
// limit: how many (none = all).
export const movedOpenIds = async (db, ws, { after = null, limit = null } = {}) => {
  const params = [ws];
  let extra = '';
  if (after) { params.push(after); extra += ` and p.id > $${params.length}::uuid`; }
  let lim = '';
  if (limit) { params.push(Math.max(1, Math.floor(Number(limit)))); lim = ` limit $${params.length}`; }
  return (await db.query(
    `select p.id from persons p where p.workspace_id = $1 and p.deleted_at is null and ${movedOpenWhere('p', '$1')}${extra}
      order by p.id${lim}`,
    params,
  )).rows.map((r) => r.id);
};
