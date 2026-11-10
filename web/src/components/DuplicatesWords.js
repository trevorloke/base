// People → Duplicates: the line after Merge, from person.merge's answer
// (flagged: one entry for each year and slate the record made one is now
// over the limit for). Over on that record alone: "over the donation limit now";
// only over together with another record that may be the same donor (the
// flag names it, maybe_same_donor): "maybe over the donation limit". A maybe
// the merge cleared (cleared: a third record only the record merged in
// matched) names that record by what it shared, as it has it ("Ph One
// (same phone: 604-555-2222)") — it has the donor's name, and the kept
// record may not show that phone — and on the screen it is a link to it,
// so the desk can check it.
// Plain JS (no JSX) so the server's tests can check it.

// "a", "a and b", "a, b and c" — the items left as they are (words or links).
const listed = (items) => items.flatMap((x, i) => (i === 0 ? [x] : [i === items.length - 1 ? ' and ' : ', ', x]));

const clearedWho = (c) => {
  const values = Array.isArray(c.shared) && c.shared.length ? `: ${c.shared.join(', ')}` : '';
  return `${c.name}${c.shares ? ` (same ${c.shares}${values})` : ''}`;
};

// The line in parts: words, and each record to check as { id, text } (a
// link to /people/<id>).
export const mergedParts = (name, r) => {
  const flags = Array.isArray(r?.flagged) ? r.flagged : [];
  const over = flags.some((f) => !f.maybe_same_donor?.length) ? 'over the donation limit now, flagged in Donations'
    : flags.length ? 'maybe over the donation limit together with another record, flagged in Donations'
      : '';
  const gone = [...new Map((Array.isArray(r?.cleared) ? r.cleared : []).map((c) => [c.person_id, c])).values()];
  const cleared = gone.length
    ? ['no longer flagged as possibly the same donor as ', ...listed(gone.map((c) => ({ id: c.person_id, text: clearedWho(c) }))),
      `: check ${gone.length === 1 ? 'that record' : 'those records'}`]
    : [];
  const tail = [over ? [over] : [], cleared].filter((t) => t.length).flatMap((t, i) => (i ? ['; ', ...t] : t));
  return [`✓ ${name}: one record`, ...(tail.length ? [' — ', ...tail] : [])];
};

export const mergedSaid = (name, r) => mergedParts(name, r).map((p) => (typeof p === 'string' ? p : p.text)).join('');
