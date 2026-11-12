// Call time's numbers are the candidate's own: every number not yet called
// in their call-time banks is handed to the account in their seat — at the
// bank's making (ext/banks), when someone takes the seat, and back to nobody
// when it empties. userId null: nobody's. Returns how many moved.
export const handCallTime = async (tx, ws, candidateId, userId, bankId = null) => {
  const r = await tx.query(
    `update call_bank_numbers n set assigned_to = $3::uuid, assigned_at = case when $3::uuid is null then null else now() end
       from call_banks b
      where b.id = n.bank_id and b.workspace_id = $1 and b.candidate_id = $2 and b.deleted_at is null
        and ($4::uuid is null or b.id = $4::uuid)
        and n.done_at is null and n.assigned_to is distinct from $3::uuid`,
    [ws, candidateId, userId || null, bankId],
  );
  return r.affectedRows ?? r.rowCount ?? 0;
};
