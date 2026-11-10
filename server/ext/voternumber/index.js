// A voter number on a person — the number a list of electors gives each
// voter, when it has one. With it a file can name its people for sure:
// "John Smith, 13450 104 Ave" and "SMITH, Jon, 13450 104 Avenue" are one
// record when both carry the same number, and a father and son of one name
// at one door are two.
//
//   persons.voter_number   text, kept as its letters and digits, in
//                          capitals (voterNumber), indexed per campaign
//
//   People → Import        a Voter number column fills it — and the import
//                          matches on it first, before name and address,
//                          when both the row and a person on file have one
//                          (routes/data.js). A person with a different
//                          number is never the row's match.
//   person.voterNumber     { id, voter_number } desk: set, change or clear
//                          it on a profile (More details)
//   GET /persons/:id/voter-number   desk → { voter_number }
//   In the People spreadsheet (ext/reports) and the full export; a merge
//   fills keep's blank from drop (ext/duplicates).
//
// A volunteer never receives it: no read they can make selects it.
import { Hono } from 'hono';
import { z } from 'zod';
import { httpError } from '../../actions/util.js';

// Nullable, no default: adding it to a full list of electors rewrites
// nothing. The index holds only people who have one.
export const sql = `
alter table persons add column if not exists voter_number text;
create index if not exists persons_ws_voter_idx on persons (workspace_id, voter_number)
  where voter_number is not null and deleted_at is null;
`;

const DESK = ['manager', 'treasurer', 'staff'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A voter number as it is kept and compared: its letters and digits, in
// capitals ("123 456-789" and "123456789" are one number), at most 40;
// nothing → null. So is anything that can't be one — fewer than three
// characters, or no digit at all ("1", "yes", "N/A"): a flag column read as
// voter numbers would make one person of everyone who shares the flag.
export const voterNumber = (v) => {
  const n = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 40);
  return n.length >= 3 && /\d/.test(n) ? n : null;
};

export const actions = {
  'person.voterNumber': {
    roles: DESK,
    input: z.object({ id: z.uuid(), voter_number: z.string().max(60).nullish() }),
    handler: async (tx, ctx, input, emit) => {
      const next = voterNumber(input.voter_number);
      // Typed, but not a number we keep: said, never saved as nothing.
      if (!next && String(input.voter_number ?? '').trim()) {
        throw httpError(400, 'That isn’t a voter number: it has three or more letters and digits, at least one of them a digit.');
      }
      const row = (await tx.query(
        `update persons set voter_number = $3, updated_at = now()
          where id = $1 and workspace_id = $2 and deleted_at is null returning id`,
        [input.id, ctx.workspaceId, next],
      )).rows[0];
      if (!row) throw httpError(404, 'person not found');
      emit('person', input.id, 'update', { voter_number: next });
      return { id: input.id, voter_number: next };
    },
  },
};

export const api = new Hono();
api.get('/persons/:id/voter-number', async (c) => {
  const ctx = c.get('ctx');
  if (!DESK.includes(ctx.role)) return c.json({ error: 'volunteers cannot view this' }, 403);
  if (!UUID_RE.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const row = (await c.get('db').query(
    'select voter_number from persons where id = $1 and workspace_id = $2 and deleted_at is null', [c.req.param('id'), ctx.workspaceId],
  )).rows[0];
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ voter_number: row.voter_number || null });
});

export const deskOnlyReads = [/^\/api\/persons\/[^/]+\/voter-number$/];
