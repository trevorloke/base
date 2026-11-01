// The one way a gift enters the books: desk entry. Inserts the gift and runs the entity-keyed cap check inside
// the caller's transaction; the SUM already includes this gift, so the exact
// crossing record is the one flagged.
import { newId } from './events.js';
import { checkCap } from './cap.js';
import { httpError } from '../actions/util.js';
import { DEFAULT_SLATE, slateLabel } from '@starbase/shared/canvass';

export const logGift = async (tx, workspace, input, emit) => {
  const donor = (await tx.query(
    'select id, name from persons where id = $1 and workspace_id = $2 and deleted_at is null',
    [input.person_id, workspace.id],
  )).rows[0];
  if (!donor) throw httpError(400, 'donor not found in this workspace — create the person first');

  const id = newId();
  const slate = input.slate || DEFAULT_SLATE;
  await tx.query(
    `insert into gifts (id, workspace_id, person_id, amount_cents, date, method, cadence, note, slate)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, workspace.id, input.person_id, input.amount_cents, input.date,
     input.method || null, input.cadence || 'one-time', input.note || null, slate],
  );

  const { cap, flagReason } = await flagIfOver(tx, workspace, { id, person_id: input.person_id, date: input.date, donorName: donor.name, slate });
  const payload = { id, ...input, slate, flagged: !!flagReason, flag_reason: flagReason };
  emit('gift', id, 'create', payload);
  return { gift: payload, compliance: cap };
};

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Run the cap check for a live gift's donor and year; if the donor is over,
// flag this gift with the reason. Shared by a new gift and a restored one.
const flagIfOver = async (tx, workspace, { id, person_id, date, donorName, slate }) => {
  const cap = await checkCap(tx, {
    workspaceId: workspace.id,
    personId: person_id,
    date: isoDay(date),
    jurisdiction: workspace.jurisdiction,
    settings: workspace.settings,
    slate,
  });
  let flagReason = null;
  if (cap.checked && cap.over) {
    // The desk reads the numbers out of this sentence (Money: parseOver).
    flagReason = `${donorName} is at $${(cap.totalCents / 100).toFixed(2)} for ${cap.year} — over the $${(cap.capCents / 100).toFixed(2)} limit on the ${slateLabel(slate).toLowerCase()} slate (${cap.source})`;
    await tx.query(
      'update gifts set flagged = true, flag_reason = $3 where id = $1 and workspace_id = $2',
      [id, workspace.id, flagReason],
    );
  }
  return { cap, flagReason };
};

// ── Voids and restores ──
// A void is an event, never a delete: the gift leaves every total but stays
// in the books; restore brings it back and runs the cap check again.
export const voidGift = async (tx, workspaceId, id, emit) => {
  const gift = (await tx.query(
    `update gifts set deleted_at = now() where id = $1 and workspace_id = $2 and deleted_at is null returning id`,
    [id, workspaceId],
  )).rows[0];
  if (!gift) throw httpError(404, 'gift not found');
  emit('gift', id, 'void', {});
  return { id };
};

export const restoreGift = async (tx, workspace, id, emit) => {
  const gift = (await tx.query(
    `update gifts set deleted_at = null where id = $1 and workspace_id = $2 and deleted_at is not null
     returning id, person_id, date, method, slate, flagged, flag_reason`,
    [id, workspace.id],
  )).rows[0];
  if (!gift) throw httpError(404, 'gift not found in trash');

  // Back in the books: the donor's year total counts it again, so the cap
  // check runs again — a restore that takes a donor over the limit is flagged
  // like any other crossing gift.
  let flag = null;
  if (!gift.flagged) {
    const donor = (await tx.query('select name from persons where id = $1 and workspace_id = $2', [gift.person_id, workspace.id])).rows[0];
    const { flagReason } = await flagIfOver(tx, workspace, { id, person_id: gift.person_id, date: gift.date, donorName: donor?.name || 'This donor', slate: gift.slate });
    flag = flagReason;
  }
  emit('gift', id, 'restore', flag ? { flagged: true, flag_reason: flag } : {});
  return { id, flagged: !!flag || !!gift.flagged, flag_reason: flag || gift.flag_reason || null };
};

// "2026-10-21" — the calendar day it is at `when` in the campaign's time zone
// (a card payment at 7:30 pm Pacific on Oct 21 is the 21st, not the UTC
// 22nd; Dec 31 evening stays in its own year). Unknown zone → Vancouver.
export const campaignDay = (when, timeZone = 'America/Vancouver') => {
  const d = when instanceof Date ? when : new Date(when);
  const fmt = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  let parts;
  try { parts = fmt(timeZone || 'America/Vancouver'); } catch { parts = fmt('America/Vancouver'); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
