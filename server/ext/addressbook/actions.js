// addressbook.link { person_ids } — the ticked people (already on the list)
// join the caller's own My people, one relationship.add each (its own input
// schema and handler, kind 'other'): nothing else about them changes, and
// nobody is made. Each in its own savepoint with its own events, so one that
// is skipped ("that's you", deleted since the check) leaves nothing behind.
// → { linked, already, skipped: [{ index, why }] }
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { DESK_ROLES } from '../../lib/twostep.js';
import { actions as ties } from '../relationships/actions.js';
import { forDesk } from './api.js';

export const actions = {
  'addressbook.link': {
    roles: DESK_ROLES,
    area: 'people',
    input: z.object({ person_ids: z.array(z.uuid()).min(1).max(200) }).strict(),
    handler: async (tx, ctx, input, emit) => {
      if (!forDesk(ctx)) throw httpError(403, 'For the desk');
      const add = ties['relationship.add'];
      const out = { linked: 0, already: 0, skipped: [] };
      const ids = [...new Set(input.person_ids)];
      for (const [index, personId] of ids.entries()) {
        const parsed = add.input.safeParse({ person_id: personId, kind: 'other' });
        if (!parsed.success) { out.skipped.push({ index, why: parsed.error.issues[0].message }); continue; }
        const mine = [];
        await tx.query('savepoint addressbook_link');
        try {
          const r = await add.handler(tx, ctx, parsed.data, (...ev) => mine.push(ev));
          await tx.query('release savepoint addressbook_link');
          for (const ev of mine) emit(...ev);
          if (r.duplicate) out.already += 1; else out.linked += 1;
        } catch (e) {
          await tx.query('rollback to savepoint addressbook_link');
          await tx.query('release savepoint addressbook_link');
          if (!e.status) throw e;
          out.skipped.push({ index, why: e.message });
        }
      }
      return out;
    },
  },
};
