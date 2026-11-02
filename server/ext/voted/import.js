// The import's Voted column (lib/hooks.js importRows): a file from the
// campaign's website — the poll-book or strike file — with a column that
// says who has voted. The screen sends it as the row's `voted`.
//   check(raw)   blank → nothing; 1 · yes · y · true · t · x · voted (any
//                case) or a date → voted; 0 · no · n · false · f → not
//                voted; anything else refuses the row ("voted: 1/0, yes/no
//                or a date").
//   apply(…)     a file only ever marks: a person not yet marked gets
//                voted_at now, a mark from the file, and a person update on
//                the books; one already marked is left as they are; a 0
//                never un-marks anyone. Says 'voted' for the decision.
import { newId } from '../../lib/events.js';

const YES = new Set(['1', 'yes', 'y', 'true', 't', 'x', 'voted']);
const NO = new Set(['0', 'no', 'n', 'false', 'f']);
// A date, as files write them: 2026-10-17 (with a time or not), 17/10/2026,
// 10-17-2026, Oct 17, 2026, 17 Oct 2026.
const DATE_RE = /^(\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}.*)?|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|[a-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2} [a-z]{3,9}\.?,? \d{4})$/i;
export const WORDS = 'voted: 1/0, yes/no or a date';

export const readVoted = (v) => {
  if (v === undefined || v === null || v === '') return { value: null };
  if (v === true) return { value: true };
  if (v === false) return { value: false };
  if (typeof v === 'number') return v === 1 ? { value: true } : v === 0 ? { value: false } : { error: WORDS };
  const s = String(v).trim().toLowerCase();
  if (!s) return { value: null };
  if (YES.has(s)) return { value: true };
  if (NO.has(s)) return { value: false };
  if (DATE_RE.test(s)) return { value: true };
  return { error: WORDS };
};

export const importRows = async (db, ctx, extras) => {
  const ws = ctx.workspaceId;
  extras.push({
    check(raw) { return readVoted(raw?.voted); },
    async apply(tx, personId, value, { write }, emit) {
      if (value !== true) return [];
      // A person the dry run would add is not on file yet: they would be marked.
      const cur = (await tx.query('select voted_at from persons where id = $1 and workspace_id = $2', [personId, ws])).rows[0];
      if (cur?.voted_at) return [];
      if (write) {
        const id = newId();
        const row = (await tx.query(
          'update persons set voted_at = now(), updated_at = now() where id = $1 and workspace_id = $2 and voted_at is null returning voted_at',
          [personId, ws],
        )).rows[0];
        if (!row) return []; // marked meanwhile: theirs stays
        await tx.query(
          `insert into voted_marks (id, workspace_id, person_id, voted, source, marked_by) values ($1, $2, $3, true, 'file', $4)`,
          [id, ws, personId, ctx.user?.id || null],
        );
        emit('voted_mark', id, 'create', { id, person_id: personId, voted: true, source: 'file', client_id: null });
        emit('person', personId, 'update', { voted_at: new Date(row.voted_at).toISOString(), source: 'file' });
      }
      return ['voted'];
    },
  });
};
