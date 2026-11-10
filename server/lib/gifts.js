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
  // The maybes this donor is in are added up again with this gift in: one
  // naming them says the new total, and one of theirs reads over on their
  // own record once this gift takes them over — never an old total.
  await recheckMaybes(tx, workspace, [input.person_id], emit);
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

// The live gifts flagged as maybes on these records, or naming them →
// [{ id, person_id, date, slate, flag_reason, same_as: [ids it names], name }].
export const maybesAbout = async (tx, workspaceId, personIds) => (await tx.query(
  `select g.id, g.person_id, g.date, g.slate, g.flag_reason, g.attrs->'maybe_same_donor' as same_as, p.name
     from gifts g join persons p on p.id = g.person_id
    where g.workspace_id = $1 and g.deleted_at is null and g.flagged and g.attrs ? 'maybe_same_donor'
      and (g.person_id = any($2::uuid[]) or g.attrs->'maybe_same_donor' ?| $3::text[])
    order by g.date, g.created_at`,
  [workspaceId, personIds, personIds],
)).rows.map((g) => ({ ...g, same_as: typeof g.same_as === 'string' ? JSON.parse(g.same_as) : g.same_as }));

// The maybes on these records' gifts (and on any gift naming them), checked
// again: the desk said two records are different people, or made two one,
// or a gift on them left the books (or came back). Each is added up again
// with what is left: still over together, the reason as it stands now;
// over on its own record now, the plain reason (never less flagged than it
// should be — like every gift logged while a donor is over); neither, the
// flag goes.
// → [{ id, flagged, flag_reason, maybe_same_donor? }], the gifts that changed.
export const recheckMaybes = async (tx, workspace, personIds, emit) => {
  const rows = await maybesAbout(tx, workspace.id, personIds);
  const changed = [];
  for (const g of rows) {
    const flag = await flagOf(tx, workspace, { person_id: g.person_id, date: g.date, donorName: g.name, slate: g.slate });
    if (!flag.cap.checked) continue;
    const had = g.same_as;
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
// Either way, the maybes it was added up in — on its donor's gifts, or
// naming its donor — are added up again as things stand (recheckMaybes),
// so a "together they are at …" never keeps a gift that left the books.
// The desk's void, and a refund or a lost dispute in Stripe (ext/payments
// unbook), come through here. The maybes a void clears are kept with the
// gift (attrs.void_cleared), so its restore — the desk's Undo — puts them
// back. → { id, rechecked }
export const voidGift = async (tx, workspace, id, emit) => {
  const gift = (await tx.query(
    `update gifts set deleted_at = now() where id = $1 and workspace_id = $2 and deleted_at is null returning id, person_id`,
    [id, workspace.id],
  )).rows[0];
  if (!gift) throw httpError(404, 'gift not found');
  emit('gift', id, 'void', {});
  const rechecked = await recheckMaybes(tx, workspace, [gift.person_id], emit);
  const cleared = rechecked.filter((g) => !g.flagged).map((g) => g.id);
  if (cleared.length) {
    await tx.query(
      `update gifts set attrs = jsonb_set(attrs, '{void_cleared}', $3::jsonb) where id = $1 and workspace_id = $2`,
      [id, workspace.id, JSON.stringify(cleared)],
    );
  }
  return { id, rechecked };
};

// A gift back in the books: the gifts whose maybe its void cleared (ids)
// are checked again and flagged again if over again — as things stand, so
// a Not the same ruled since still counts: as a maybe, or over on their
// own record (as every gift of a donor's year over the limit is). One
// voided or flagged since is left as it is.
const flagAgain = async (tx, workspace, ids, emit) => {
  const rows = (await tx.query(
    `select g.id, g.person_id, g.date, g.slate, p.name from gifts g join persons p on p.id = g.person_id
      where g.workspace_id = $1 and g.id = any($2::uuid[]) and g.deleted_at is null and not g.flagged
      order by g.date, g.created_at`,
    [workspace.id, ids],
  )).rows;
  for (const g of rows) {
    const flag = await flagOf(tx, workspace, { person_id: g.person_id, date: g.date, donorName: g.name, slate: g.slate });
    if (!flag.flagReason) continue;
    await setFlag(tx, workspace.id, g.id, flag);
    emit('gift', g.id, 'update', { flagged: true, flag_reason: flag.flagReason, ...(flag.sameAs ? { maybe_same_donor: flag.sameAs } : {}) });
  }
};

export const restoreGift = async (tx, workspace, id, emit) => {
  const gift = (await tx.query(
    `update gifts set deleted_at = null where id = $1 and workspace_id = $2 and deleted_at is not null
     returning id, person_id, date, method, slate, flagged, flag_reason, attrs->'void_cleared' as void_cleared`,
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
  // Every maybe it may be in counts it again, so an Undo leaves Needs you
  // as the void found it: those its void cleared come back if over, and
  // those on its donor or on the records that may be them (ext/payments:
  // sameDonors) — or naming one of them — are added up as things stand,
  // a maybe it kept through its void too.
  const cleared = typeof gift.void_cleared === 'string' ? JSON.parse(gift.void_cleared) : gift.void_cleared;
  if (Array.isArray(cleared)) {
    await tx.query(`update gifts set attrs = attrs - 'void_cleared' where id = $1 and workspace_id = $2`, [id, workspace.id]);
    await flagAgain(tx, workspace, cleared, emit);
  }
  const near = [];
  await runHooks('sameDonors', tx, workspace, { personId: gift.person_id, year: Number(isoDay(gift.date).slice(0, 4)), slate: gift.slate }, near);
  const now = (await recheckMaybes(tx, workspace, [gift.person_id, ...near], emit)).find((g) => g.id === id);
  if (now) return { id, flagged: now.flagged, flag_reason: now.flag_reason };
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
