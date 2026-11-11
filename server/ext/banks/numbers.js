// Which of a bank's numbers are still to call, as things stand — one rule
// for the caller's list, the desk's counts and handing out:
//   · the person can be called (lib/reach.js: a phone, not do-not-contact —
//     whatever that place says tomorrow), and is still on file;
//   · in a bank made from a list, they are still on the list. Someone who
//     votes, opts out or is rated off it leaves the calls not yet made, at
//     once and with no write; a call already logged stays logged. If the
//     list itself is deleted, the bank keeps the numbers it has.
//
//   stillOn(db, ctx, bank, params)      SQL (persons p), its params added
//   bankCounts(db, ctx, bank)           { total, assigned, done, open, gone }
//   callersOf(db, ctx, bank)            [{ user_id, name, total, done }] — a
//                                       caller's total: done, or still theirs to call
//   addFromList(tx, ctx, bank, list)    everyone on the list who can be
//                                       called and isn't in the bank yet,
//                                       after the numbers already there
import { mayReach, person } from '../../lib/reach.js';
import { loadList, onListSql } from '../lists/audience.js';

export const stillOn = async (db, ctx, bank, params) => {
  params.push(ctx.workspaceId);
  const ws = `$${params.length}::uuid`;
  const list = bank.list_id ? await loadList(db, ctx.workspaceId, bank.list_id) : null;
  const on = list ? ` and coalesce(${await onListSql(db, ctx, list, params)}, false)` : '';
  return `(p.workspace_id = ${ws} and p.deleted_at is null and ${mayReach('call', 'bank', person('p', ws))}${on})`;
};

// total: every number in the bank; done: called (or skipped); assigned: in
// a caller's hands, done or not; open: nobody's yet and still to call;
// gone: not called and no longer to call (off the list, or can't be called).
export const bankCounts = async (db, ctx, bank) => {
  const params = [bank.id];
  const still = await stillOn(db, ctx, bank, params);
  return (await db.query(
    `select count(*)::int as total, count(n.assigned_to)::int as assigned, count(n.done_at)::int as done,
            (count(*) filter (where n.assigned_to is null and n.done_at is null and x.still))::int as open,
            (count(*) filter (where n.done_at is null and not x.still))::int as gone
       from call_bank_numbers n join persons p on p.id = n.person_id
       cross join lateral (select ${still} as still) x
      where n.bank_id = $1`, params,
  )).rows[0];
};

export const callersOf = async (db, ctx, bank) => {
  const params = [bank.id];
  const still = await stillOn(db, ctx, bank, params);
  return (await db.query(
    `select n.assigned_to as user_id, u.name, (count(*) filter (where n.done_at is not null or ${still}))::int as total, count(n.done_at)::int as done
       from call_bank_numbers n join persons p on p.id = n.person_id join users u on u.id = n.assigned_to
      where n.bank_id = $1 group by n.assigned_to, u.name`, params,
  )).rows.sort((a, z) => a.name.localeCompare(z.name));
};

export const addFromList = async (tx, ctx, bank, list) => {
  const start = Number((await tx.query('select coalesce(max(position), 0) as p from call_bank_numbers where bank_id = $1', [bank.id])).rows[0].p);
  const params = [bank.id, ctx.workspaceId, start];
  const on = await onListSql(tx, ctx, list, params);
  const r = await tx.query(
    `insert into call_bank_numbers (bank_id, workspace_id, person_id, position)
     select $1::uuid, p.workspace_id, p.id, $3::int + row_number() over (order by lower(p.name), p.id)
       from persons p
      where p.workspace_id = $2::uuid and p.deleted_at is null and ${on}
        and ${mayReach('call', 'bank', person('p', '$2::uuid'))}
        and not exists (select 1 from call_bank_numbers n where n.bank_id = $1::uuid and n.person_id = p.id)`,
    params,
  );
  return r.affectedRows ?? r.rowCount ?? 0;
};
