// bank.create   { name, script?, person_ids[] | list_id }   desk: a bank from people picked by hand, or from a List
//                                                     (ext/lists) — everyone on it who can be called, however many;
//                                                     who leaves the list later leaves the calls not yet made (numbers.js)
//                                                     who can be called: lib/reach.js — a phone, not do-not-contact, not do-not-call
// bank.update   { id, name?, script?, closed? }       desk
// bank.remove   { id }                                desk: void (nothing else moves)
// bank.add      { id, person_ids[] }                  desk: more numbers
// bank.topup    { id }                                desk: a bank made from a list takes in whoever has joined the list since
//                                                     (from a list: the desk's alone, never a volunteer given the People area)
// bank.assign   { id, user_id | team_id, count? }     desk: hand the next numbers to one caller, or split them across a team
// bank.release  { id, user_id?, person_id? }          desk: take unfinished numbers back (one person's, or one number)
// bank.done     { id, person_id, outcome? }           anyone: cross a number off without a call (wrong number, asked not to call)
// bank.callback { id, person_id, at }                 anyone (their number): back on their list at that time
// A No answer in a bank brings the number back after the bank's retry_hours,
// up to max_tries calls; any other outcome crosses it off (crossOff).
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { mayReach, person } from '../../lib/reach.js';
import { loadList, whereFor } from '../lists/audience.js';
import { addFromList, bankCounts, stillOn } from './numbers.js';

const DESK = ['manager', 'staff', 'treasurer'];
const ALL = ['manager', 'treasurer', 'staff', 'volunteer'];
const uuid = () => z.uuid();
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// Numbers picked by hand come 5,000 to a call; a bank made from a list has no such limit.
const MAX_NUMBERS = 5000;
// How many to hand out: any number — more than are left hands out what is left.
const MAX_HAND = 100_000_000;
// How a No answer comes back: after this many hours (0: never), up to this many calls.
const RETRY = { retry_hours: z.number().int().min(0).max(72).optional(), max_tries: z.number().int().min(1).max(5).optional() };

const bankOf = async (tx, ws, id) => {
  const b = (await tx.query('select * from call_banks where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  if (!b) throw httpError(404, 'phone bank not found');
  return b;
};
// A bank made from a list reads the list as the desk does (numbers.js), so
// making one — or taking in who joined since — is the desk's, whatever a
// volunteer has been given: handed to themselves, it would read the list out.
const deskReadsLists = (ctx) => {
  if (ctx.role === 'volunteer') throw httpError(403, 'only the desk can make a phone bank from a list');
};
// The people who can be called (lib/reach.js decides: a phone, not do-not-contact,
// not do-not-call).
const callable = async (tx, ws, ids) => (await tx.query(
  `select p.id from persons p where p.workspace_id = $1 and p.id = any($2::uuid[]) and p.deleted_at is null
     and ${mayReach('call', 'bank', person('p', '$1'))}`,
  [ws, ids],
)).rows.map((r) => r.id);
const addNumbers = async (tx, ws, bankId, personIds) => {
  const ok = await callable(tx, ws, [...new Set(personIds)]);
  const start = Number((await tx.query('select coalesce(max(position), 0) as p from call_bank_numbers where bank_id = $1', [bankId])).rows[0].p);
  let added = 0;
  for (let i = 0; i < ok.length; i++) {
    const r = await tx.query(
      'insert into call_bank_numbers (bank_id, workspace_id, person_id, position) values ($1, $2, $3, $4) on conflict do nothing',
      [bankId, ws, ok[i], start + i + 1],
    );
    added += r.affectedRows ?? r.rowCount ?? 0;
  }
  return { added, skipped: personIds.length - ok.length };
};
// The bank's numbers as they stand (numbers.js): open leaves out anyone no longer to call.
const counts = async (tx, ctx, bank) => {
  const { gone, ...c } = await bankCounts(tx, ctx, bank);
  return bank.list_id ? { ...c, gone } : c;
};

export const actions = {
  'bank.create': {
    roles: DESK,
    input: z.object({
      name: z.string().max(120), script: z.string().max(20_000).nullish(),
      person_ids: z.array(uuid()).max(MAX_NUMBERS).optional(), list_id: uuid().optional(), ...RETRY,
    }).refine((v) => !(v.list_id && v.person_ids?.length), 'a list, or people picked by hand — not both'),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const name = clean(input.name);
      if (!name) throw httpError(400, 'a phone bank needs a name');
      if (input.list_id) deskReadsLists(ctx);
      const list = input.list_id ? await loadList(tx, ws, input.list_id) : null;
      if (input.list_id && !list) throw httpError(404, 'list not found');
      const id = newId();
      await tx.query('insert into call_banks (id, workspace_id, name, script, created_by, retry_hours, max_tries, list_id) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, ws, name, input.script || null, ctx.user.id, input.retry_hours ?? 4, input.max_tries ?? 3, list?.id || null]);
      const bank = { id, list_id: list?.id || null };
      let added; let skipped;
      if (list) {
        // The server reads the list itself: everyone on it who can be called, however many.
        added = await addFromList(tx, ctx, bank, list);
        const { where, params } = await whereFor(tx, ctx, { list });
        skipped = (await tx.query(`select count(*)::int as n from persons p where ${where}`, params)).rows[0].n - added;
      } else ({ added, skipped } = await addNumbers(tx, ws, id, input.person_ids || []));
      emit('call_bank', id, 'create', { name, numbers: added, ...(list ? { list_id: list.id, list_name: list.name } : {}) });
      return {
        bank: {
          id, name, script: input.script || null, retry_hours: input.retry_hours ?? 4, max_tries: input.max_tries ?? 3,
          list_id: bank.list_id, list_name: list?.name || null, ...(await counts(tx, ctx, bank)),
        },
        added, skipped,
      };
    },
  },
  'bank.update': {
    roles: DESK,
    input: z.object({ id: uuid(), name: z.string().max(120).optional(), script: z.string().max(20_000).nullish(), closed: z.boolean().optional(), ...RETRY }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const name = input.name === undefined ? b.name : clean(input.name);
      if (!name) throw httpError(400, 'a phone bank needs a name');
      const script = input.script === undefined ? b.script : (input.script || null);
      const closed = input.closed === undefined ? !!b.closed_at : input.closed;
      // A closed bank outlives its list (list.delete). Reopened without it,
      // everyone who had left the list would be back on the calls.
      if (b.closed_at && !closed && b.list_id && !(await loadList(tx, ctx.workspaceId, b.list_id))) {
        throw httpError(409, 'The list this bank called is gone — make a new bank');
      }
      const retry = input.retry_hours ?? b.retry_hours;
      const tries = input.max_tries ?? b.max_tries;
      await tx.query('update call_banks set name = $2, script = $3, closed_at = case when $4 then coalesce(closed_at, now()) else null end, retry_hours = $5, max_tries = $6, updated_at = now() where id = $1',
        [b.id, name, script, closed, retry, tries]);
      emit('call_bank', b.id, 'update', { name, closed, retry_hours: retry, max_tries: tries });
      return { bank: { id: b.id, name, script, closed, retry_hours: retry, max_tries: tries } };
    },
  },
  'bank.remove': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      await tx.query('update call_banks set deleted_at = now(), updated_at = now() where id = $1', [b.id]);
      emit('call_bank', b.id, 'void', {});
      return { removed: true };
    },
  },
  'bank.add': {
    roles: DESK,
    input: z.object({ id: uuid(), person_ids: z.array(uuid()).min(1).max(MAX_NUMBERS) }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const { added, skipped } = await addNumbers(tx, ctx.workspaceId, b.id, input.person_ids);
      emit('call_bank', b.id, 'update', { added });
      return { added, skipped, ...(await counts(tx, ctx, b)) };
    },
  },
  // Whoever has joined the bank's list since it was made (or last topped
  // up) and can be called: added after the numbers already there.
  'bank.topup': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      deskReadsLists(ctx);
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const list = b.list_id ? await loadList(tx, ctx.workspaceId, b.list_id) : null;
      if (!list) throw httpError(409, b.list_id ? 'the list this phone bank was made from is gone' : 'this phone bank wasn’t made from a list');
      const added = await addFromList(tx, ctx, b, list);
      if (added) emit('call_bank', b.id, 'update', { added, list_id: list.id });
      return { added, ...(await counts(tx, ctx, b)) };
    },
  },
  'bank.assign': {
    roles: DESK,
    input: z.object({ id: uuid(), user_id: uuid().optional(), team_id: uuid().optional(), count: z.number().int().min(1).max(MAX_HAND).optional() })
      .refine((v) => !!v.user_id !== !!v.team_id, 'a caller or a team'),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const b = await bankOf(tx, ws, input.id);
      if (b.closed_at) throw httpError(409, 'this phone bank is closed');
      let callers;
      if (input.user_id) {
        const m = (await tx.query('select 1 from memberships where workspace_id = $1 and user_id = $2', [ws, input.user_id])).rows[0];
        if (!m) throw httpError(404, 'that person is not on the campaign');
        callers = [input.user_id];
      } else {
        const t = (await tx.query('select id from teams where id = $1 and workspace_id = $2 and deleted_at is null', [input.team_id, ws])).rows[0];
        if (!t) throw httpError(404, 'team not found');
        callers = (await tx.query('select user_id from team_members where team_id = $1 order by created_at', [input.team_id])).rows.map((r) => r.user_id);
        if (!callers.length) throw httpError(400, 'nobody is on that team yet');
      }
      // Only numbers still to call are handed out (numbers.js: off the list, or
      // do-not-contact since, stay behind) — in the bank's order, in turn across
      // the callers, and in one statement however many there are.
      const params = [b.id];
      const still = await stillOn(tx, ctx, b, params);
      params.push(callers, input.count ?? null);
      const who = `$${params.length - 1}::uuid[]`;
      const rows = (await tx.query(
        `with next as (
           select n.person_id, row_number() over (order by n.position, n.person_id) as rn
             from call_bank_numbers n join persons p on p.id = n.person_id
            where n.bank_id = $1 and n.assigned_to is null and n.done_at is null and ${still}
            order by n.position, n.person_id limit $${params.length}::int),
         handed as (
           update call_bank_numbers n set assigned_to = c.user_id, assigned_at = now()
             from next join unnest(${who}) with ordinality c(user_id, i) on c.i = 1 + (next.rn - 1) % cardinality(${who})
            where n.bank_id = $1 and n.person_id = next.person_id
           returning n.assigned_to)
         select assigned_to as user_id, count(*)::int as n from handed group by assigned_to`, params,
      )).rows;
      const given = Object.fromEntries(rows.map((r) => [r.user_id, r.n]));
      const take = rows.reduce((sum, r) => sum + r.n, 0);
      emit('call_bank', b.id, 'update', { assigned: take, to: Object.keys(given) });
      return { handed: take, given, ...(await counts(tx, ctx, b)) };
    },
  },
  'bank.release': {
    roles: DESK,
    input: z.object({ id: uuid(), user_id: uuid().optional(), person_id: uuid().optional() }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const r = await tx.query(
        `update call_bank_numbers set assigned_to = null, assigned_at = null where bank_id = $1 and done_at is null and assigned_to is not null
           and ($2::uuid is null or assigned_to = $2) and ($3::uuid is null or person_id = $3)`,
        [b.id, input.user_id || null, input.person_id || null],
      );
      const released = r.affectedRows ?? r.rowCount ?? 0;
      emit('call_bank', b.id, 'update', { released });
      return { released, ...(await counts(tx, ctx, b)) };
    },
  },
  'bank.done': {
    roles: ALL,
    input: z.object({ id: uuid(), person_id: uuid(), outcome: z.string().max(40).nullish() }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const n = (await tx.query('select assigned_to, done_at from call_bank_numbers where bank_id = $1 and person_id = $2', [b.id, input.person_id])).rows[0];
      if (!n) throw httpError(404, 'that number is not in this phone bank');
      if (ctx.role === 'volunteer' && n.assigned_to !== ctx.user.id) throw httpError(403, 'that number is not yours');
      if (n.done_at) return { done: true, already: true };
      await tx.query('update call_bank_numbers set done_at = now(), done_by = $3, outcome = $4 where bank_id = $1 and person_id = $2', [b.id, input.person_id, ctx.user.id, clean(input.outcome) || 'skipped']);
      emit('call_bank', b.id, 'update', { done: input.person_id, by: ctx.user.id });
      return { done: true };
    },
  },
  'bank.callback': {
    roles: ALL,
    input: z.object({ id: uuid(), person_id: uuid(), at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).max(40) }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const n = (await tx.query('select assigned_to, done_at from call_bank_numbers where bank_id = $1 and person_id = $2', [b.id, input.person_id])).rows[0];
      if (!n) throw httpError(404, 'that number is not in this phone bank');
      if (ctx.role === 'volunteer' && n.assigned_to !== ctx.user.id) throw httpError(403, 'that number is not yours');
      if (n.done_at) throw httpError(409, 'that number is done');
      const at = new Date(input.at);
      const now = Date.now();
      if (Number.isNaN(at.getTime()) || at.getTime() < now - 60_000 || at.getTime() > now + 14 * 86_400_000) {
        throw httpError(400, 'a time in the next two weeks');
      }
      await tx.query('update call_bank_numbers set next_at = $3 where bank_id = $1 and person_id = $2', [b.id, input.person_id, at.toISOString()]);
      emit('call_bank', b.id, 'update', { callback: input.person_id, at: at.toISOString(), by: ctx.user.id });
      return { back_at: at.toISOString() };
    },
  },
};

// A phone call logged by the caller a number was handed to crosses it off
// in every open phone bank it is in (contactLogged hook).
// A No answer comes back instead, after the bank's retry_hours, until its
// max_tries calls are spent (reply.bank says when: the Calls card's toast).
// anyCaller: the call was made outside base.win (the dialer, ext/callhub) —
// whoever the number was handed to, it has been called; ctx.user may be
// nobody then.
export const crossOff = async (tx, ctx, { contact, reply, anyCaller = false }) => {
  if (!contact?.person_id || contact.channel !== 'phone') return;
  const outcome = String(contact.outcome || 'contacted');
  const by = ctx.user?.id || null;
  const rows = (await tx.query(
    `select n.bank_id, n.tries, b.retry_hours, b.max_tries from call_bank_numbers n
       join call_banks b on b.id = n.bank_id and b.workspace_id = $1 and b.deleted_at is null
      where n.person_id = $3 and n.done_at is null and ($4::boolean or n.assigned_to = $2 or n.assigned_to is null)`,
    [ctx.workspaceId, by, contact.person_id, anyCaller],
  )).rows;
  for (const r of rows) {
    const tries = Number(r.tries) + 1;
    if (outcome === 'no_answer' && Number(r.retry_hours) > 0 && tries < Number(r.max_tries)) {
      const back = (await tx.query(
        `update call_bank_numbers set tries = $3, next_at = now() + make_interval(hours => $4::int)
          where bank_id = $1 and person_id = $2 returning next_at`,
        [r.bank_id, contact.person_id, tries, Number(r.retry_hours)],
      )).rows[0];
      if (reply) reply.bank = { back_at: new Date(back.next_at).toISOString(), tries, max_tries: Number(r.max_tries) };
    } else {
      await tx.query(
        'update call_bank_numbers set tries = $3, done_at = now(), done_by = $4, outcome = $5 where bank_id = $1 and person_id = $2',
        [r.bank_id, contact.person_id, tries, by, outcome],
      );
    }
  }
};

// A call made outside base.win was read differently after the fact (the
// desk corrected what one of the dialer's results counts as, ext/callhub):
// the numbers that very call settled follow, by the same rule. `at` is when
// the call was filed — a number is touched only if that call crossed it off
// (done at that moment) or sent it back (due the bank's hours after it).
export const recross = async (tx, ws, { personIds, at, was, now, by = null }) => {
  if (!personIds?.length || was === now) return;
  const rows = (await tx.query(
    `select n.bank_id, n.person_id, n.tries, n.done_at, b.retry_hours, b.max_tries from call_bank_numbers n
       join call_banks b on b.id = n.bank_id and b.workspace_id = $1 and b.deleted_at is null
      where n.person_id = any($2::uuid[])
        and ((n.done_at = $3::timestamptz and n.outcome = $4)
          or (n.done_at is null and $4 = 'no_answer' and n.next_at = $3::timestamptz + make_interval(hours => b.retry_hours)))`,
    [ws, personIds, at, was],
  )).rows;
  for (const r of rows) {
    const comesBack = now === 'no_answer' && Number(r.retry_hours) > 0 && Number(r.tries) < Number(r.max_tries);
    if (comesBack) {
      await tx.query(
        `update call_bank_numbers set done_at = null, done_by = null, outcome = null, next_at = $3::timestamptz + make_interval(hours => $4::int)
          where bank_id = $1 and person_id = $2`, [r.bank_id, r.person_id, at, Number(r.retry_hours)],
      );
    } else {
      await tx.query(
        'update call_bank_numbers set done_at = $3::timestamptz, done_by = coalesce(done_by, $4), outcome = $5 where bank_id = $1 and person_id = $2',
        [r.bank_id, r.person_id, at, by, now],
      );
    }
  }
};
