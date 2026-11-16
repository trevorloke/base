// What other writes do to a move.
//
//   events        a real new address clears "Address unknown": the desk's
//                 Edit details, the website's forms, the intake API — any
//                 person write with an address that is not a move's own or
//                 an import's (an import never fills a moved person's
//                 address: routes/data.js). Only 'unknown': Passed away's
//                 statuses are never cleared this way.
//   brief         Today's "Moved — needs an address", for desk roles that
//                 hold People: { moved: { open } }. A failure leaves it out
//                 (one line in the log); Today never fails because of it.
//   sampleLoaded  the sample's three movers (lib/sample.js SAMPLE_MOVERS).
import { areasFor } from '../../lib/perms.js';
import { newId } from '../../lib/events.js';
import { SAMPLE_MOVERS } from '../../lib/sample.js';
import { movedCounts } from './open.js';
import { applyMove } from './actions.js';

export const clearUnknown = async (tx, meta, events) => {
  const ids = [...new Set(events
    .filter((e) => e.entityType === 'person' && (e.op === 'create' || e.op === 'update')
      && typeof e.payload?.address === 'string' && e.payload.address.trim()
      && !['move', 'import'].includes(e.payload.source))
    .map((e) => e.entityId))];
  if (!ids.length) return;
  const cleared = (await tx.query(
    `update persons set address_status = null
      where workspace_id = $1 and id = any($2::uuid[]) and address_status = 'unknown' and address is not null
      returning id`,
    [meta.workspaceId, ids],
  )).rows;
  for (const r of cleared) meta.emit('person', r.id, 'update', { address_status: null, source: 'move' });
};

export const briefMoved = async (db, ctx, body) => {
  if (ctx.role === 'volunteer' || !areasFor(ctx).includes('people')) return;
  try {
    body.moved = { open: (await movedCounts(db, ctx.workspaceId)).open };
  } catch (e) {
    console.error('brief: moved count unavailable:', e.message);
  }
};

// One tapped Moved and moved to another sample door, one tapped Moved and
// marked Address unknown, one tapped Moved with no address yet (so Needs an
// address is not empty). Their Moved knocks are the sample's (ids.contacts),
// so Clear takes them; the moves go with the people.
export const sampleMovers = async (tx, ctx, { people, emit, ids }) => {
  const knock = async (who) => {
    const cid = newId();
    await tx.query(
      `insert into contacts (id, workspace_id, person_id, channel, outcome, created_by, created_at)
       values ($1, $2, $3, 'door', 'moved', $4, now())`,
      [cid, ctx.workspaceId, people[who], ctx.user.id],
    );
    if (ids?.contacts) ids.contacts.push(cid);
    emit('contact', cid, 'create', { person_id: people[who], outcome: 'moved', sample: true });
  };
  const row = async (who) => (await tx.query('select * from persons where id = $1 and workspace_id = $2 for update', [people[who], ctx.workspaceId])).rows[0];
  const { moved, to, unknown, open } = SAMPLE_MOVERS;
  if (![moved, to, unknown, open].every((k) => people[k])) return;
  for (const who of [moved, unknown, open]) await knock(who);
  const there = await row(to);
  await applyMove(tx, ctx, await row(moved), { to: { address: there.address, unit: there.unit, city: there.city, lat: there.lat, lng: there.lng } }, emit);
  await applyMove(tx, ctx, await row(unknown), { unknown: true }, emit);
};
