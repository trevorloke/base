// A manager's Today (GET /api/brief): base.win support's visits in the last
// seven days, newest first, at most three — so a visit is never a surprise.
export const briefSupport = async (db, ctx, body) => {
  if (ctx.role !== 'manager') return;
  const rows = (await db.query(
    `select used_at from operator_entries
     where workspace_id = $1 and user_id is not null and used_at > now() - interval '7 days'
     order by used_at desc limit 3`,
    [ctx.workspaceId],
  )).rows;
  if (rows.length) body.supportVisits = rows.map((r) => ({ at: r.used_at }));
};
