// The one way a gift enters the books: desk entry. Inserts the gift and runs the entity-keyed cap check inside
// the caller's transaction; the SUM already includes this gift, so the exact
// crossing record is the one flagged. Under the limit on its own record, a
// feature may still flag it (the underLimit hook: other records that may
// be the same donor, over together) — whatever door the gift came in by.
import { newId } from './events.js';
import { checkCap } from './cap.js';
import { runHooks } from './hooks.js';
import { httpError } from '../actions/util.js';
import { DEFAULT_SLATE, slateLabel } from '@starbase/shared/canvass';
import { DEFAULT_TZ } from './org.js';

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

  const { cap, flagReason, sameAs } = await flagIfOver(tx, workspace, { id, person_id: input.person_id, date: input.date, donorName: donor.name, slate });
  const payload = { id, ...input, slate, flagged: !!flagReason, flag_reason: flagReason, ...(sameAs ? { maybe_same_donor: sameAs } : {}) };
  emit('gift', id, 'create', payload);
  return { gift: payload, compliance: cap };
};

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Why a live gift is over the limit, as things stand → { cap, flagReason,
// sameAs }: over on its donor's own record; else, under it, a maybe — over
// together with other records that may be the same donor (the underLimit
// hook; sameAs: those records); else nothing.
const flagOf = async (tx, workspace, { person_id, date, donorName, slate }) => {
  const cap = await checkCap(tx, {
    workspaceId: workspace.id,
    personId: person_id,
    date: isoDay(date),
    jurisdiction: workspace.jurisdiction,
    settings: workspace.settings,
    slate,
  });
  if (cap.checked && cap.over) {
    // The desk reads the numbers out of this sentence (Money: parseOver).
    const flagReason = `${donorName} is at $${(cap.totalCents / 100).toFixed(2)} for ${cap.year} — over the $${(cap.capCents / 100).toFixed(2)} limit on the ${slateLabel(slate).toLowerCase()} slate (${cap.source})`;
    return { cap, flagReason, sameAs: null };
  }
  const out = {};
  if (cap.checked) await runHooks('underLimit', tx, workspace, { personId: person_id, slate, cap }, out);
  return { cap, flagReason: out.flagReason || null, sameAs: out.flagReason && out.sameAs?.length ? out.sameAs : null };
};

// A gift's flag as it now stands: the reason, and for a maybe the other
// records it names (attrs.maybe_same_donor), which the desk can say are
// different people (Donations: Not the same person).
const setFlag = (tx, workspaceId, id, { flagReason, sameAs }) => tx.query(
  `update gifts set flagged = $3, flag_reason = $4,
          attrs = case when $5::jsonb is null then attrs - 'maybe_same_donor' else jsonb_set(attrs, '{maybe_same_donor}', $5::jsonb) end
    where id = $1 and workspace_id = $2`,
  [id, workspaceId, !!flagReason, flagReason || null, sameAs ? JSON.stringify(sameAs) : null],
);

// Run the cap check for a live gift's donor and year; if the donor is over,
// flag this gift with the reason — or, under it, if they may be over
// together with other records. Shared by a new gift and a restored one.
export const flagIfOver = async (tx, workspace, gift) => {
  const flag = await flagOf(tx, workspace, gift);
  if (flag.flagReason) await setFlag(tx, workspace.id, gift.id, flag);
  return flag;
};

// The maybes on these records' gifts (and on any gift naming them), checked
// again: the desk said two records are different people, or made two one.
// Each is added up again with what is left: still over together, the
// reason as it stands now; over on its own record now, the plain reason
// (never less flagged than it should be); neither, the flag goes.
// → [{ id, flagged, flag_reason, maybe_same_donor? }], the gifts that changed.
export const recheckMaybes = async (tx, workspace, personIds, emit) => {
  const rows = (await tx.query(
    `select g.id, g.person_id, g.date, g.slate, g.flag_reason, g.attrs->'maybe_same_donor' as same_as, p.name
       from gifts g join persons p on p.id = g.person_id
      where g.workspace_id = $1 and g.deleted_at is null and g.flagged and g.attrs ? 'maybe_same_donor'
        and (g.person_id = any($2::uuid[]) or g.attrs->'maybe_same_donor' ?| $3::text[])
      order by g.date, g.created_at`,
    [workspace.id, personIds, personIds],
  )).rows;
  const changed = [];
  for (const g of rows) {
    const flag = await flagOf(tx, workspace, { person_id: g.person_id, date: g.date, donorName: g.name, slate: g.slate });
    if (!flag.cap.checked) continue;
    const had = typeof g.same_as === 'string' ? JSON.parse(g.same_as) : g.same_as;
    if (flag.flagReason === g.flag_reason && JSON.stringify(flag.sameAs) === JSON.stringify(had)) continue;
    await setFlag(tx, workspace.id, g.id, flag);
    const change = { flagged: !!flag.flagReason, flag_reason: flag.flagReason, ...(flag.sameAs ? { maybe_same_donor: flag.sameAs } : {}) };
    emit('gift', g.id, 'update', change);
    changed.push({ id: g.id, ...change });
  }
  return changed;
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
  let sameAs = null;
  if (!gift.flagged) {
    const donor = (await tx.query('select name from persons where id = $1 and workspace_id = $2', [gift.person_id, workspace.id])).rows[0];
    ({ flagReason: flag, sameAs } = await flagIfOver(tx, workspace, { id, person_id: gift.person_id, date: gift.date, donorName: donor?.name || 'This donor', slate: gift.slate }));
  }
  emit('gift', id, 'restore', flag ? { flagged: true, flag_reason: flag, ...(sameAs ? { maybe_same_donor: sameAs } : {}) } : {});
  return { id, flagged: !!flag || !!gift.flagged, flag_reason: flag || gift.flag_reason || null };
};

// "2026-10-21" — the calendar day it is at `when` in the campaign's time zone
// (a card payment at 7:30 pm Pacific on Oct 21 is the 21st, not the UTC
// 22nd; Dec 31 evening stays in its own year). Unknown zone → Vancouver.
export const campaignDay = (when, timeZone = DEFAULT_TZ) => {
  const d = when instanceof Date ? when : new Date(when);
  const fmt = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  let parts;
  try { parts = fmt(timeZone || DEFAULT_TZ); } catch { parts = fmt(DEFAULT_TZ); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
