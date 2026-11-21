// The operator log: every change made from the control centre, append-only
// and chained the way a campaign's own History is (server/lib/events.js):
// each line's hash covers the line before, so a changed or missing line
// shows. Never a token, a code, a password, a key, or an email other than
// the operator's own.
import { createHash } from 'node:crypto';
import { canonical, chainHash } from '../../server/lib/events.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const lineHash = (prev, row) => chainHash(prev, row.seq, row.action, 'campaign', row.campaign || '', 'create', row.operator_id, row.payload_hash);

// In the caller's transaction; the chain row's lock keeps lines gapless and in order.
export const appendLog = async (tx, { operatorId = null, action, campaign = null, payload = {} }) => {
  const chain = (await tx.query('select seq, last_hash from ops_chain where id = 1 for update')).rows[0];
  const seq = Number(chain.seq) + 1;
  const payloadHash = sha256(canonical(payload));
  const hash = lineHash(chain.last_hash, { seq, action, campaign, operator_id: operatorId, payload_hash: payloadHash });
  await tx.query(`insert into ops_log (seq, operator_id, action, campaign, payload, payload_hash, hash)
    values ($1, $2, $3, $4, $5, $6, $7)`, [seq, operatorId, action, campaign, JSON.stringify(payload), payloadHash, hash]);
  await tx.query('update ops_chain set seq = $1, last_hash = $2 where id = 1', [seq, hash]);
  return seq;
};

// Outside a transaction of the caller's own.
export const log = (db, entry) => db.transaction((tx) => appendLog(tx, entry));

// → { ok: true, lines } | { ok: false, line, lines }: the first line that
// doesn't follow from the one before (a changed line, or a gap where one
// was taken out; the end must match the chain's own count and hash).
export const verifyLog = async (db) => {
  const chain = (await db.query('select seq, last_hash from ops_chain where id = 1')).rows[0];
  const total = Number(chain.seq);
  let prev = '';
  let expect = 1;
  let after = 0;
  for (;;) {
    const rows = (await db.query('select * from ops_log where seq > $1 order by seq limit 1000', [after])).rows;
    if (!rows.length) break;
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq !== expect) return { ok: false, line: expect, lines: total };
      const payloadOk = sha256(canonical(r.payload)) === r.payload_hash;
      if (!payloadOk || lineHash(prev, { ...r, seq }) !== r.hash) return { ok: false, line: seq, lines: total };
      prev = r.hash;
      expect += 1;
      after = seq;
    }
  }
  if (expect - 1 !== total || prev !== chain.last_hash) return { ok: false, line: expect, lines: total };
  return { ok: true, lines: total };
};

export const PAGE = 100;
export const listLog = async (db, { before = null, campaign = null, limit = PAGE } = {}) => (await db.query(
  `select seq, at, action, campaign, payload from ops_log
   where ($1::bigint is null or seq < $1) and ($2::text is null or campaign = $2)
   order by seq desc limit $3`, [before, campaign, limit])).rows;
