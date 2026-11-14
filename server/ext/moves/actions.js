// "They moved": a new address, or Address unknown — and its Undo.
//
//   person.move    any role (area People, as contact.log). Desk roles, and
//                  a volunteer granted People, may move anyone; any other
//                  volunteer only someone whose pin is in a turf they walk.
//                  One transaction: the move is kept (person_moves: where
//                  from, every part, so Undo can put it back), the door's
//                  own fields come off (they describe the old door), and
//                  the person goes to the new address — or, unknown, off
//                  every door, the map and walk lists, the old address kept
//                  on the move. A replay of the phone's client_id is the
//                  same move, never a second.
//   person.unmove  desk only (and a volunteer granted People): the newest
//                  move, while the address is still what it left.
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { settleAddress } from '../../lib/address.js';
import { forViewer } from '../../lib/viewer.js';
import { NAME_ADDR } from '../../lib/matchkeys.js';
import { DOOR_FIELDS } from '../fields/people.js';
import { inMyTurf } from '../core/index.js';
import { doorLists, mayMoveAnyone } from './lists.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const PEOPLE_ROLES = ['manager', 'treasurer', 'staff'];
// doorOf's test (routes/api.js): within about 50 m is the same door.
const NEAR = 0.0005;
const parseJ = (v, fb) => (typeof v === 'string' ? JSON.parse(v) : (v ?? fb));
const low = (s) => String(s ?? '').trim().toLowerCase();

const PICK = 'Pick a new address or Address unknown';
const OFFICE = 'Only the office can change this address';

const moveInput = z.object({
  person_id: z.uuid(),
  to: z.object({
    address: z.string().trim().min(1).max(200),
    unit: z.string().trim().max(20).nullish(),
    city: z.string().trim().max(80).nullish(),
    postal: z.string().trim().max(10).nullish(),
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
  }).optional(),
  unknown: z.literal(true).optional(),
  client_id: z.uuid().nullish(),
  contact_client_id: z.uuid().nullish(),
});

// What the caller gets back about the person: a row like any person row,
// through what a volunteer may read (lib/viewer.js).
const personOut = (ctx, r) => forViewer(ctx)({
  id: r.id, name: r.name, first_name: r.first_name ?? null, last_name: r.last_name ?? null, email: r.email,
  phone: r.phone, address: r.address, house_number: r.house_number, unit: r.unit, city: r.city, postal: r.postal,
  lat: r.lat, lng: r.lng, tags: parseJ(r.tags, []), address_status: r.address_status ?? null,
});
const moveOut = (m) => ({ id: m.id, reason: m.reason, result: m.result, created_at: m.created_at });

// A volunteer's pin for the new address is kept only when it is a door
// already on file: a live person (not the mover) at the same street, unit
// and city with a pin within NEAR of it. Anything else is placed on the
// server after the save (ext/addresses), so a pin made up on the phone gets
// nothing.
const pinOnFile = async (tx, ctx, moverId, to, lat, lng) => !!(await tx.query(
  `select 1 from persons p where p.workspace_id = $1 and p.deleted_at is null and p.id <> $2
      and lower(btrim(p.address)) = lower(btrim($3))
      and coalesce(lower(btrim(p.unit)), '') = coalesce(lower(btrim($4::text)), '')
      and coalesce(lower(btrim(p.city)), '') = coalesce(lower(btrim($5::text)), '')
      and p.lat between $6::float8 - ${NEAR} and $6::float8 + ${NEAR}
      and p.lng between $7::float8 - ${NEAR} and $7::float8 + ${NEAR}
    limit 1`,
  [ctx.workspaceId, moverId, to.address, to.unit || null, to.city || null, lat, lng],
)).rows[0];

// The door's own fields (House notes, Building notes, Access type,
// Dwelling type) come off, each voided as field.values.set voids one;
// what they said is kept on the move for Undo. Home phone stays.
const takeDoorFields = async (tx, ctx, personId, emit) => {
  const rows = (await tx.query(
    `select v.id, v.field_id, v.value from person_field_values v join person_fields f on f.id = v.field_id
      where v.workspace_id = $1 and v.person_id = $2 and lower(f.name) = any($3::text[])
      for update of v`,
    [ctx.workspaceId, personId, DOOR_FIELDS],
  )).rows;
  for (const r of rows) {
    await tx.query('delete from person_field_values where id = $1 and workspace_id = $2', [r.id, ctx.workspaceId]);
    emit('person_field_value', r.id, 'void', { field_id: r.field_id, person_id: personId, was: r.value, source: 'move' });
  }
  return rows.map((r) => ({ field_id: r.field_id, value: r.value }));
};

// The move itself, for person.move and the sample. cur: the person's row,
// locked. → the person_moves row.
export const applyMove = async (tx, ctx, cur, input, emit) => {
  const desk = mayMoveAnyone(ctx);
  let next;
  let keepPin = false;
  if (input.to) {
    const to = input.to;
    const s = settleAddress(cur, { address: to.address, unit: to.unit || null });
    // No city typed: the one on file, or, for someone marked Address unknown
    // (whose city went with the old door), the one they had before that.
    const city = to.city || cur.city || (cur.address_status === 'unknown' ? (await tx.query(
      `select from_city from person_moves where workspace_id = $1 and person_id = $2 and undone_at is null and from_city is not null
        order by created_at desc, id desc limit 1`,
      [ctx.workspaceId, cur.id],
    )).rows[0]?.from_city : null) || null;
    next = {
      address: s.address, house_number: s.house_number, unit: to.unit || null,
      city, postal: to.postal || null,
    };
    if (low(next.address) === low(cur.address) && low(next.unit) === low(cur.unit) && low(next.city) === low(cur.city)) {
      throw httpError(409, 'That’s the address on file already');
    }
    if (to.lat != null && to.lng != null) {
      keepPin = desk || await pinOnFile(tx, ctx, cur.id, next, to.lat, to.lng);
    }
    Object.assign(next, keepPin ? { lat: to.lat, lng: to.lng } : { lat: null, lng: null }, { address_status: null });
  } else {
    if (cur.address == null && cur.address_status === 'unknown') throw httpError(409, 'Address unknown is on file already');
    next = { address: null, house_number: null, unit: null, city: null, postal: null, lat: null, lng: null, address_status: 'unknown' };
  }
  const contactId = input.contact_client_id ? (await tx.query(
    'select id from contacts where workspace_id = $1 and person_id = $2 and client_id = $3 limit 1',
    [ctx.workspaceId, cur.id, input.contact_client_id],
  )).rows[0]?.id || null : null;
  const fromDoor = await takeDoorFields(tx, ctx, cur.id, emit);
  const id = newId();
  const result = input.to ? 'new' : 'unknown';
  const move = (await tx.query(
    `insert into person_moves (id, workspace_id, person_id, reason, result,
        from_address, from_house_number, from_unit, from_city, from_postal, from_lat, from_lng, from_status, from_key, from_door,
        to_address, to_house_number, to_unit, to_city, to_postal, contact_id, client_id, created_by)
     select $1::uuid, $2::uuid, p.id, 'moved', $4::text, p.address, p.house_number, p.unit, p.city, p.postal, p.lat, p.lng, p.address_status,
            case when p.address is null then null else ${NAME_ADDR('p.name', 'p.address')} end, $5::jsonb,
            $6::text, $7::text, $8::text, $9::text, $10::text, $11::uuid, $12::uuid, $13::uuid
       from persons p where p.id = $3 and p.workspace_id = $2
     returning *`,
    [id, ctx.workspaceId, cur.id, result, JSON.stringify(fromDoor),
     input.to ? next.address : null, input.to ? next.house_number : null, input.to ? next.unit : null,
     input.to ? next.city : null, input.to ? next.postal : null, contactId, input.client_id || null, ctx.user?.id || null],
  )).rows[0];
  await tx.query(
    `update persons set address = $3, house_number = $4, unit = $5, city = $6, postal = $7, lat = $8, lng = $9,
        address_status = $10, updated_at = now()
      where id = $1 and workspace_id = $2`,
    [cur.id, ctx.workspaceId, next.address, next.house_number, next.unit, next.city, next.postal, next.lat, next.lng, next.address_status],
  );
  const { from_key: _key, ...logged } = move;
  emit('person_move', id, 'create', { ...logged, from_door: parseJ(move.from_door, []) });
  emit('person', cur.id, 'update', {
    address: next.address, house_number: next.house_number, unit: next.unit, city: next.city, postal: next.postal,
    address_status: next.address_status, source: 'move', move_id: id,
    // With a pin the follow-ups follow it to its turf; without one the
    // address is placed after the write (ext/addresses placeOnSave).
    ...(keepPin ? { lat: next.lat, lng: next.lng } : {}),
  });
  return move;
};

const loadPerson = async (tx, ctx, id) => (await tx.query(
  'select * from persons where id = $1 and workspace_id = $2 and deleted_at is null for update', [id, ctx.workspaceId],
)).rows[0];

export const actions = {
  'person.move': {
    roles: ALL_ROLES,
    input: moveInput,
    handler: async (tx, ctx, input, emit) => {
      // Exactly one of the two, and a pin is both halves or neither: said
      // here in words, not as the input check's.
      if (!!input.to === !!input.unknown) throw httpError(400, PICK);
      if (input.to && (input.to.lat == null) !== (input.to.lng == null)) throw httpError(400, 'pin needs both lat and lng');
      if (input.client_id) {
        const had = (await tx.query(
          'select * from person_moves where workspace_id = $1 and client_id = $2', [ctx.workspaceId, input.client_id],
        )).rows[0];
        if (had) {
          const p = (await tx.query('select * from persons where id = $1 and workspace_id = $2', [had.person_id, ctx.workspaceId])).rows[0];
          return { move: moveOut(had), person: p ? personOut(ctx, p) : null, duplicate: true, ...(await doorLists(tx, ctx, had)) };
        }
      }
      const cur = await loadPerson(tx, ctx, input.person_id);
      if (!cur) throw httpError(404, 'person not found');
      if (!mayMoveAnyone(ctx) && (cur.lat == null || cur.lng == null || !(await inMyTurf(tx, ctx, cur.lat, cur.lng)))) {
        throw httpError(403, OFFICE);
      }
      const move = await applyMove(tx, ctx, cur, input, emit);
      const p = (await tx.query('select * from persons where id = $1', [cur.id])).rows[0];
      return { move: moveOut(move), person: personOut(ctx, p), ...(await doorLists(tx, ctx, move)) };
    },
  },

  'person.unmove': {
    roles: PEOPLE_ROLES,
    input: z.object({ move_id: z.uuid() }),
    handler: async (tx, ctx, { move_id: moveId }, emit) => {
      const m = (await tx.query(
        'select * from person_moves where id = $1 and workspace_id = $2', [moveId, ctx.workspaceId],
      )).rows[0];
      if (!m) throw httpError(404, 'that move is not on file');
      const cur = await loadPerson(tx, ctx, m.person_id);
      if (!cur) throw httpError(404, 'person not found');
      const newest = (await tx.query(
        `select id from person_moves where workspace_id = $1 and person_id = $2 and undone_at is null
          order by created_at desc, id desc limit 1`,
        [ctx.workspaceId, m.person_id],
      )).rows[0];
      if (m.undone_at || newest?.id !== m.id) throw httpError(409, 'Undo the newest change first');
      const still = m.result === 'new'
        ? low(cur.address) === low(m.to_address) && low(cur.unit) === low(m.to_unit) && low(cur.city) === low(m.to_city)
        : cur.address == null && cur.address_status === 'unknown';
      if (!still) throw httpError(409, 'The address has changed since — edit it in Details instead');
      await tx.query(
        `update persons set address = $3, house_number = $4, unit = $5, city = $6, postal = $7, lat = $8, lng = $9,
            address_status = $10, updated_at = now()
          where id = $1 and workspace_id = $2`,
        [cur.id, ctx.workspaceId, m.from_address, m.from_house_number, m.from_unit, m.from_city, m.from_postal,
         m.from_lat, m.from_lng, m.from_status],
      );
      // The door's fields come back where nothing has been written since,
      // and only to a field still in use.
      const restored = [];
      for (const d of parseJ(m.from_door, [])) {
        const vid = newId();
        const row = (await tx.query(
          `insert into person_field_values (id, workspace_id, field_id, person_id, value, updated_by)
           select $1, $2, f.id, $3, $5::jsonb, $6 from person_fields f
            where f.id = $4 and f.workspace_id = $2 and f.retired_at is null
           on conflict (field_id, person_id) do nothing
           returning id`,
          [vid, ctx.workspaceId, cur.id, d.field_id, JSON.stringify(d.value), ctx.user?.id || null],
        )).rows[0];
        if (row) {
          restored.push(d.field_id);
          emit('person_field_value', vid, 'create', { id: vid, field_id: d.field_id, person_id: cur.id, value: d.value, source: 'move' });
        }
      }
      const undone = (await tx.query(
        `update person_moves set undone_at = now(), undone_by = $3 where id = $1 and workspace_id = $2 returning undone_at`,
        [m.id, ctx.workspaceId, ctx.user?.id || null],
      )).rows[0];
      emit('person_move', m.id, 'update', { undone: true, person_id: cur.id });
      // With the old pin (or none): the old address is not looked up again.
      emit('person', cur.id, 'update', {
        address: m.from_address, house_number: m.from_house_number, unit: m.from_unit, city: m.from_city, postal: m.from_postal,
        lat: m.from_lat, lng: m.from_lng, address_status: m.from_status, source: 'move', move_id: m.id, undone: true,
      });
      const p = (await tx.query('select * from persons where id = $1', [cur.id])).rows[0];
      return { move: { ...moveOut(m), undone_at: undone.undone_at }, person: personOut(ctx, p), restored };
    },
  },
};
