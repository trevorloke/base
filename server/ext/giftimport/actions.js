// gift.import · gift.importSettle · gift.importUndo — the gift import's
// writes (index.js says what each is for).
//
// Every gift goes through lib/gifts.js logGift, the one gift path: the
// year's limit is checked with the gift in it, and the gift that takes a
// donor over is flagged exactly as one typed at the desk would be. What is
// different is said on the gift's event and in its attrs (source 'import'):
// the receipts engine issues no number for it, the ladders never start on
// these writes, and Stewardship leaves it out of To thank.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { logGift, voidGift, campaignDay } from '../../lib/gifts.js';
import { capFor, donorYearTotal } from '../../lib/cap.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { DEFAULT_SLATE } from '@starbase/shared/canvass';
import { readRow } from './rows.js';
import { findDonors } from './match.js';

// Who brings a file in and takes one back (the financial agent's people),
// and who settles a gift that waits for a donor (whoever may log a gift).
export const AGENT_ROLES = ['manager', 'treasurer'];
export const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
// The most rows one call carries (the screen sends fewer, to stay under the
// size a request may be: server/index.js), and the most gifts one call
// takes back.
export const CALL_ROWS = 500;
const UNDO_CHUNK = 250;

const uuid = () => z.uuid();
const tzOf = (ws) => ws?.settings?.tz || DEFAULT_TZ;
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
// Tomorrow, on the campaign's calendar.
const latestDay = (ws) => campaignDay(new Date(Date.now() + 86_400_000), tzOf(ws));

// The keys already here → Map: key → the import that holds it. A gift on
// the books, a gift the desk voided since (it stays voided: the file coming
// in again does not bring it back), one waiting for a donor, one left out.
// An import that was taken back holds nothing: its file can come in again.
const keysHeld = async (tx, wsId, keys) => {
  const held = new Map();
  if (!keys.length) return held;
  const rows = (await tx.query(
    `select g.attrs->>'import_key' as key, g.attrs->>'import_id' as import_id
       from gifts g left join gift_imports i on i.workspace_id = g.workspace_id and i.id::text = g.attrs->>'import_id'
      where g.workspace_id = $1 and g.attrs ? 'import_key' and g.attrs->>'import_key' = any($2::text[])
        and (g.deleted_at is null or i.undone_at is null)
     union all
     select r.import_key, r.import_id::text from gift_import_rows r
      where r.workspace_id = $1 and r.import_key = any($2::text[]) and r.status in ('waiting', 'left_out')`,
    [wsId, keys],
  )).rows;
  for (const r of rows) if (!held.has(r.key)) held.set(r.key, r.import_id);
  return held;
};

// One gift from a file, on the books for its donor: through the one gift
// path, then marked as brought in (as ext/payments marks an online gift).
const logImported = async (tx, ws, emit, { personId, importId, r }) => {
  const mark = {
    source: 'import', import_id: importId, import_key: r.key,
    ...(r.import_ref ? { import_ref: r.import_ref } : {}), ...(r.import_receipt ? { import_receipt: r.import_receipt } : {}),
  };
  const { gift } = await logGift(tx, ws, {
    person_id: personId, amount_cents: r.amount_cents, date: r.date, method: r.method || null,
    cadence: 'one-time', slate: r.slate || DEFAULT_SLATE, note: null, ...mark,
  }, emit);
  await tx.query(
    `update gifts set attrs = coalesce(attrs, '{}'::jsonb) || $3::jsonb where id = $1 and workspace_id = $2`,
    [gift.id, ws.id, JSON.stringify(mark)],
  );
  return gift;
};

// What an import holds as things stand: its gifts on the books and what
// still waits for a donor.
export const totalsOf = async (q, wsId, importId) => {
  const g = (await q.query(
    `select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as cents from gifts
      where workspace_id = $1 and attrs ? 'import_id' and attrs->>'import_id' = $2 and deleted_at is null`,
    [wsId, importId],
  )).rows[0];
  const w = (await q.query(
    `select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as cents from gift_import_rows
      where workspace_id = $1 and import_id = $2 and status = 'waiting'`,
    [wsId, importId],
  )).rows[0];
  return { gifts: g.n, cents: Number(g.cents), waiting: w.n, waiting_cents: Number(w.cents) };
};

// The import's own record: looked at before anything is read (an import
// that was taken back takes nothing more), made with its first gift — a
// file that adds nothing leaves no import behind.
const checkImport = async (tx, ctx, id) => {
  const imp = (await tx.query('select workspace_id, undone_at from gift_imports where id = $1', [id])).rows[0];
  if (imp && imp.workspace_id !== ctx.workspaceId) throw httpError(409, 'That import can’t be used — choose the file again.');
  if (imp?.undone_at) throw httpError(409, 'That import was taken back — choose the file again.');
};
const startImport = async (tx, ctx, input, emit) => {
  const made = (await tx.query(
    `insert into gift_imports (id, workspace_id, file_name, created_by) values ($1, $2, $3, $4)
     on conflict (id) do nothing returning file_name`,
    [input.import_id, ctx.workspaceId, String(input.file_name || '').trim().slice(0, 200) || null, ctx.user.id],
  )).rows[0];
  if (made) emit('gift_import', input.import_id, 'create', { file_name: made.file_name });
};

export const actions = {
  // rows: up to CALL_ROWS of the file's rows, in order; a big file comes in
  // several calls under one import_id. dry_run: the same decisions, nothing
  // saved. → { results: one per row, in order — { state: 'new', person_id,
  // person_name, by, name_differs, year, slate, amount_cents, flagged? } ·
  // { state: 'waiting', candidates } · { state: 'already' } (here from an
  // earlier import) · { state: 'resent' } (here from this one: the call
  // came twice) · { state: 'invalid', error } — and counts. The check also
  // answers donors: each matched donor's year on a slate, what is on file
  // and the limit, so the screen can say who the file would take over it.
  // A save answers totals: what the import holds as it stands. }
  'gift.import': {
    roles: AGENT_ROLES,
    input: z.object({
      import_id: uuid(),
      file_name: z.string().max(300).nullish(),
      rows: z.array(z.record(z.string(), z.unknown())).min(1).max(CALL_ROWS),
      dry_run: z.boolean().default(false),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspace;
      const dry = input.dry_run;
      if (!dry) await checkImport(tx, ctx, input.import_id);

      const latest = latestDay(ws);
      const results = input.rows.map(() => null);
      const fresh = [];
      input.rows.forEach((raw, i) => {
        const r = readRow(raw, { latest });
        if (r.error) results[i] = { state: 'invalid', error: r.error };
        else fresh.push({ i, ...r.row });
      });

      // Once only: a key already here is not a new gift — nor is the second
      // of two rows in this call with one key.
      const held = await keysHeld(tx, ws.id, fresh.map((r) => r.key));
      const todo = [];
      for (const r of fresh) {
        if (held.has(r.key)) results[r.i] = { state: !dry && held.get(r.key) === input.import_id ? 'resent' : 'already' };
        else { held.set(r.key, input.import_id); todo.push(r); }
      }

      const found = await findDonors(tx, ws.id, todo);
      if (!dry && todo.length) await startImport(tx, ctx, input, emit);
      for (const r of todo) {
        const m = found.get(r.i);
        if (!m.person) {
          results[r.i] = { state: 'waiting', candidates: m.candidates.length };
          if (dry) continue;
          const id = newId();
          await tx.query(
            `insert into gift_import_rows (id, workspace_id, import_id, row_no, import_key, donor, amount_cents, date, method, slate, import_ref, import_receipt)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [id, ws.id, input.import_id, r.row_no, r.key, JSON.stringify(r.donor), r.amount_cents, r.date, r.method, r.slate, r.import_ref, r.import_receipt],
          );
          emit('gift_import_row', id, 'create', { import_id: input.import_id, row: r.row_no, name: r.donor.name || r.donor.email, amount_cents: r.amount_cents, date: r.date });
          continue;
        }
        const out = {
          state: 'new', person_id: m.person.id, person_name: m.person.name, by: m.by, name_differs: m.name_differs,
          year: Number(r.date.slice(0, 4)), slate: r.slate || DEFAULT_SLATE, amount_cents: r.amount_cents,
        };
        results[r.i] = out;
        if (dry) continue;
        const gift = await logImported(tx, ws, emit, { personId: m.person.id, importId: input.import_id, r });
        Object.assign(out, { gift_id: gift.id, flagged: !!gift.flagged });
      }

      const counts = { new: 0, waiting: 0, already: 0, invalid: 0 };
      for (const r of results) counts[r.state === 'resent' ? 'already' : r.state] += 1;
      return {
        dry_run: dry, results, counts,
        ...(dry ? { donors: await donorYears(tx, ws, results) } : { totals: await totalsOf(tx, ws.id, input.import_id) }),
      };
    },
  },

  // A gift (or a donor's several) that waited: put on a donor a person
  // chose, or left out. ids: the pile's rows. → { settled, person, gifts:
  // [{ id, flagged, flag_reason }] } or { left_out }.
  'gift.importSettle': {
    roles: MONEY_ROLES,
    input: z.object({ ids: z.array(uuid()).min(1).max(CALL_ROWS), person_id: uuid().nullish(), leave_out: z.boolean().default(false) }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspace;
      if (!input.leave_out && !input.person_id) throw httpError(400, 'pick the donor, or leave it out');
      const rows = (await tx.query(
        `select * from gift_import_rows where workspace_id = $1 and id = any($2::uuid[]) and status = 'waiting'
          order by date, created_at, id for update`,
        [ws.id, input.ids],
      )).rows;
      if (!rows.length) throw httpError(409, 'Already settled — nothing left to do here.');
      const done = (r, status, giftId = null) => tx.query(
        `update gift_import_rows set status = $3, gift_id = $4, settled_by = $5, settled_at = now() where id = $1 and workspace_id = $2`,
        [r.id, ws.id, status, giftId, ctx.user.id],
      );
      if (input.leave_out) {
        for (const r of rows) {
          await done(r, 'left_out');
          emit('gift_import_row', r.id, 'update', { status: 'left_out' });
        }
        return { left_out: rows.length };
      }
      const person = (await tx.query(
        'select id, name from persons where id = $1 and workspace_id = $2 and deleted_at is null', [input.person_id, ws.id],
      )).rows[0];
      if (!person) throw httpError(404, 'That person is gone — pick someone else.');
      const gifts = [];
      for (const r of rows) {
        const day = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
        const gift = await logImported(tx, ws, emit, {
          personId: person.id, importId: r.import_id,
          r: { key: r.import_key, amount_cents: Number(r.amount_cents), date: day, method: r.method, slate: r.slate, import_ref: r.import_ref, import_receipt: r.import_receipt },
        });
        await done(r, 'settled', gift.id);
        emit('gift_import_row', r.id, 'update', { status: 'settled', gift_id: gift.id, person_id: person.id });
        gifts.push({ id: gift.id, flagged: !!gift.flagged, flag_reason: gift.flag_reason || null });
      }
      return { settled: rows.length, person, gifts };
    },
  },

  // Take an import back, whole: every gift of it still on the books is
  // voided through the one void path (lib/gifts.js voidGift), and what
  // waited for a donor goes. For a day after it came in. A big one is taken
  // back UNDO_CHUNK gifts a call: → { voided, remaining } — the screen
  // calls again while any remain (one begun in time may finish later).
  'gift.importUndo': {
    roles: AGENT_ROLES,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspace;
      const imp = (await tx.query(
        `select id, undone_at, created_at > now() - interval '24 hours' as fresh from gift_imports
          where id = $1 and workspace_id = $2 for update`,
        [input.id, ws.id],
      )).rows[0];
      if (!imp) throw httpError(404, 'import not found');
      if (!imp.undone_at) {
        if (!imp.fresh) throw httpError(409, 'That import is more than a day old — void its gifts one at a time.');
        await tx.query('update gift_imports set undone_at = now(), undone_by = $3 where id = $1 and workspace_id = $2', [imp.id, ws.id, ctx.user.id]);
        const gone = (await tx.query('delete from gift_import_rows where workspace_id = $1 and import_id = $2 returning id, status', [ws.id, imp.id])).rows;
        emit('gift_import', imp.id, 'void', { waiting_removed: gone.filter((r) => r.status === 'waiting').length });
      }
      const live = (await tx.query(
        `select id from gifts where workspace_id = $1 and attrs ? 'import_id' and attrs->>'import_id' = $2 and deleted_at is null
          order by created_at, id limit ${UNDO_CHUNK + 1}`,
        [ws.id, imp.id],
      )).rows;
      for (const g of live.slice(0, UNDO_CHUNK)) await voidGift(tx, ws, g.id, emit);
      const voided = Math.min(live.length, UNDO_CHUNK);
      return { id: imp.id, voided, remaining: live.length > UNDO_CHUNK ? (await totalsOf(tx, ws.id, imp.id)).gifts : 0 };
    },
  },
};

// Each matched donor's year on a slate, for the rows a call would add (or
// added): what is on file and the limit. → [{ person_id, name, year, slate,
// on_file_cents, cap_cents }] — cap_cents null when no limit is known.
const donorYears = async (tx, ws, results) => {
  const seen = new Map();
  for (const r of results) {
    if (r.state !== 'new') continue;
    const k = `${r.person_id}|${r.year}|${r.slate}`;
    if (!seen.has(k)) seen.set(k, { person_id: r.person_id, name: r.person_name, year: r.year, slate: r.slate });
  }
  const caps = new Map();
  const out = [];
  for (const d of seen.values()) {
    if (!caps.has(d.year)) caps.set(d.year, await capFor(tx, ws.jurisdiction, d.year, parseJ(ws.settings, {})));
    const cap = caps.get(d.year);
    out.push({ ...d, on_file_cents: await donorYearTotal(tx, ws.id, d.person_id, d.year, d.slate), cap_cents: cap ? Number(cap.capCents) : null });
  }
  return out;
};
