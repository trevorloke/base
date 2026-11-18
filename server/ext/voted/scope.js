// What routes/api.js asks of GOTV for the reads and writes it serves:
//
//   gotvRead(db, ctx)          this person's GOTV state (state.js gotvFor)
//   rowLimit(db, ctx, params)  " and p.id = any($n)" for a volunteer kept to
//                              their turfs and phone banks while GOTV is on
//                              (the person list and its count), else ''
//   GOTV_LOCKED, gotvLockMs    the writes that never wait more than 5 s for
//                              the campaign's lock while GOTV is on or in
//                              practice: a mark, an undo, a check, a knock
import { gotvFor, scopeOf } from './state.js';

export const gotvRead = (db, ctx) => gotvFor(db, ctx);

export const rowLimit = async (db, ctx, params) => {
  const g = ctx.gotv || await gotvFor(db, ctx);
  if (!g.limited) return '';
  params.push([...(await scopeOf(db, ctx)).ids]);
  return ` and p.id = any($${params.length}::uuid[])`;
};

export const GOTV_LOCKED = new Set(['vote.mark', 'vote.undo', 'gotv.check', 'contact.log']);
export const LOCK_MS = () => Number(process.env.STARBASE_GOTV_LOCK_MS) || 5_000;
export const gotvLockMs = async (db, ctx) => {
  const g = await gotvFor(db, ctx);
  return g.on || g.practice ? LOCK_MS() : undefined;
};
