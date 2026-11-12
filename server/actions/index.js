// The Action registry — the only write path. Each action declares its name,
// the roles allowed to invoke it, a zod input contract, and a transactional
// handler that performs typed table writes and emits events. A few also
// have an `after` step — async (db, ctx, result) => ({ result, lastSeq? }) —
// run once the handler has committed, for work that must not hold the
// campaign lock (sending email); each of its writes is a runAction of its
// own. One may have an `answer` — (ctx, result) => what this person may
// read of it — applied as the result leaves the server, never inside the
// handler (other server code calls handlers and needs the whole result).
// The palette, buttons, and the public API all call the same registry
// via POST /api/actions/:name; there is no other way to mutate campaign data.
import { civic, streetOf } from '../lib/address.js';
import { z } from 'zod';
import { zodFor } from '@starbase/shared/registry';
import { newId } from '../lib/events.js';
import { logGift, voidGift, restoreGift } from '../lib/gifts.js';
import { FIELD_ACTIONS, personFieldExtensions } from './field.js';
import { ORGANIZE_ACTIONS } from './organize.js';
import { httpError } from './util.js';
import { forViewer, isMoneyTag } from '../lib/viewer.js';
import { extActions } from '../ext.js';
export { httpError };

const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
const PEOPLE_ROLES = ['manager', 'treasurer', 'staff'];

const personInput = z.object({
  kind: z.enum(['person', 'org']).default('person'),
  name: z.string().trim().min(1).max(300),
  email: z.string().email().max(320).nullish(),
  phone: z.string().max(40).nullish(),
  address: z.string().max(1000).nullish(),
  house_number: z.string().max(20).nullish(),
  ...personFieldExtensions,
});

const rowToPerson = (r) => ({
  id: r.id, kind: r.kind, name: r.name, first_name: r.first_name ?? null, middle_name: r.middle_name ?? null, last_name: r.last_name ?? null, email: r.email,
  phone: r.phone, address: r.address, house_number: r.house_number, unit: r.unit, city: r.city, postal: r.postal,
  lat: r.lat, lng: r.lng,
  tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || []),
  socials: typeof r.socials === 'string' ? JSON.parse(r.socials) : (r.socials || {}),
});

// What the browser gets back from a save (routes/api.js applies an action's
// `answer` as the result leaves the server): a person row like any other,
// so a volunteer given People never gets someone else's email or a money
// tag in it (lib/viewer.js). Server code that calls the handler itself (the
// membership form) still gets the whole row.
const seenByViewer = (ctx, r) => ({ ...r, person: forViewer(ctx)(r.person) });

export const ACTIONS = {
  'person.create': {
    roles: PEOPLE_ROLES,
    // id: optional, made on the phone (the offline outbox) so a person added
    // with no signal can be knocked before they reach the server, and a
    // replay after a lost response is the same person, never a second one.
    // name: the whole name — or leave it out and send first_name / last_name.
    input: personInput.extend({ id: z.uuid().nullish(), name: z.string().trim().max(300).nullish() }),
    handler: async (tx, ctx, { id: clientId, ...input }, emit) => {
      const parts = [input.first_name, input.middle_name, input.last_name].map((x) => String(x ?? '').trim()).filter(Boolean);
      if (!String(input.name ?? '').trim()) input.name = parts.join(' ');
      if (!input.name) throw httpError(400, 'a name, or a first or last name');
      if (clientId) {
        const cur = (await tx.query('select * from persons where id = $1', [clientId])).rows[0];
        if (cur && cur.workspace_id !== ctx.workspaceId) throw httpError(409, 'that id is already taken');
        if (cur) return { person: rowToPerson(cur), duplicate: true };
      }
      const id = clientId || newId();
      // The house number and the street, however they came (lib/address.js).
      Object.assign(input, civic(input));
      await tx.query(
        `insert into persons (id, workspace_id, kind, name, email, phone, address, house_number, unit, city, postal, lat, lng, tags, socials, first_name, last_name, middle_name)
         values ($1, $2, $3, $4, $5, $6, $7, $15, $8, $9, $10, $11, $12, $13, $14, $16, $17, $18)`,
        [id, ctx.workspaceId, input.kind, input.name, input.email || null,
         input.phone || null, input.address || null, input.unit || null,
         input.city || null, input.postal || null, input.lat ?? null, input.lng ?? null,
         JSON.stringify(input.tags || []), JSON.stringify(input.socials || {}), input.house_number,
         input.first_name || null, input.last_name || null, input.middle_name || null],
      );
      // The names as the database settled them (ext/names).
      const named = (await tx.query('select name, first_name, middle_name, last_name from persons where id = $1', [id])).rows[0];
      Object.assign(input, named);
      const payload = { id, ...input };
      emit('person', id, 'create', payload);
      return { person: payload };
    },
    // A row already on file is read, not written: a volunteer gets it as any other read.
    answer: (ctx, r) => (r.duplicate ? seenByViewer(ctx, r) : r),
  },

  'person.update': {
    roles: PEOPLE_ROLES,
    input: personInput.partial().extend({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const { id, ...patch } = input;
      const cur = (await tx.query(
        'select * from persons where id = $1 and workspace_id = $2 and deleted_at is null',
        [id, ctx.workspaceId],
      )).rows[0];
      if (!cur) throw httpError(404, 'person not found');
      // A volunteer (given People) saves what they were shown, which isn't
      // everything (lib/viewer.js): an email on file they never see is kept
      // whatever they send (they may add one only where there is none), and
      // a money tag kept from them stays on.
      if (ctx.role === 'volunteer') {
        const shown = forViewer(ctx)(rowToPerson(cur));
        if ('email' in patch && cur.email && !shown.email) delete patch.email;
        if (Array.isArray(patch.tags)) {
          const hidden = rowToPerson(cur).tags.filter(isMoneyTag);
          patch.tags = [...patch.tags.filter((t) => !isMoneyTag(t)), ...hidden];
        }
      }
      const next = { ...rowToPerson(cur), ...patch };
      // A new street or house number: the two parts settle together (a new
      // street keeps the house number only if the patch says so).
      if ('address' in patch || 'house_number' in patch) {
        // A new number alone goes onto the street as it was, not onto the old line.
        const street = 'address' in patch ? patch.address : streetOf(cur.house_number, cur.address);
        Object.assign(next, civic({ house_number: 'house_number' in patch ? patch.house_number : ('address' in patch ? null : cur.house_number), address: street }));
      }
      // A changed address makes the old pin wrong: drop it (the person lands in
      // the map's "place" list) unless the same patch supplies new coordinates.
      const addrChanged = (('address' in patch || 'house_number' in patch) && (next.address || null) !== (cur.address || null))
        || ('unit' in patch && (patch.unit || null) !== (cur.unit || null));
      if (addrChanged && !('lat' in patch) && !('lng' in patch)) { next.lat = null; next.lng = null; }
      // Names: first, middle or last sent → the whole follows; the whole alone → it is
      // split again (ext/names). Neither sent: as they were.
      const namesSent = 'first_name' in patch || 'middle_name' in patch || 'last_name' in patch;
      await tx.query(
        `update persons set kind = $3, name = $4, email = $5, phone = $6, address = $7,
           unit = $8, city = $9, postal = $10, lat = $11, lng = $12, tags = $13, socials = $14, house_number = $15,
           first_name = $16, last_name = $17, middle_name = $18, updated_at = now()
         where id = $1 and workspace_id = $2`,
        [id, ctx.workspaceId, next.kind, next.name, next.email || null,
         next.phone || null, next.address || null, next.unit || null,
         next.city || null, next.postal || null, next.lat ?? null, next.lng ?? null,
         JSON.stringify(next.tags || []), JSON.stringify(next.socials || {}), next.house_number || null,
         namesSent ? (next.first_name || null) : cur.first_name, namesSent ? (next.last_name || null) : cur.last_name,
         namesSent ? (next.middle_name || null) : cur.middle_name],
      );
      const named = (await tx.query('select name, first_name, middle_name, last_name from persons where id = $1', [id])).rows[0];
      Object.assign(next, named);
      if (namesSent || 'name' in patch) Object.assign(patch, named);
      emit('person', id, 'update', { ...patch, ...(('address' in patch || 'house_number' in patch) ? { address: next.address, house_number: next.house_number } : {}) });
      return { person: next };
    },
    answer: seenByViewer,
  },

  'gift.log': {
    roles: MONEY_ROLES,
    input: zodFor('gift'),
    handler: (tx, ctx, input, emit) => logGift(tx, ctx.workspace, input, emit),
  },

  // A void is an event, never a delete: the gift leaves every total but stays
  // in the books, and restore brings it back (lib/gifts.js). Answers { id,
  // rechecked } (the maybes added up again without it); restore answers
  // { id, flagged, flag_reason }.
  'gift.void': {
    roles: MONEY_ROLES,
    input: z.object({ id: z.uuid() }),
    handler: (tx, ctx, input, emit) => voidGift(tx, ctx.workspace, input.id, emit),
  },

  'gift.restore': {
    roles: MONEY_ROLES,
    input: z.object({ id: z.uuid() }),
    handler: (tx, ctx, input, emit) => restoreGift(tx, ctx.workspace, input.id, emit),
  },

  ...FIELD_ACTIONS,
  ...ORGANIZE_ACTIONS,
  ...extActions(),
};

const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
