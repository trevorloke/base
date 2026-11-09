// People → Duplicates: the line after Merge, from person.merge's answer
// (flagged: one entry for each year and slate the record made one is now
// over the limit for). Over on that record alone: "over the donation limit now";
// only over together with another record that may be the same donor (the
// flag names it, maybe_same_donor): "maybe over the donation limit". A maybe
// the merge cleared (cleared: a third record only the record merged in
// matched) names that record, so the desk can check it.
// Plain JS (no JSX) so the server's tests can check it.
const listed = (words) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] || '');

export const mergedSaid = (name, r) => {
  const flags = Array.isArray(r?.flagged) ? r.flagged : [];
  const over = flags.some((f) => !f.maybe_same_donor?.length) ? 'over the donation limit now, flagged in Donations'
    : flags.length ? 'maybe over the donation limit together with another record, flagged in Donations'
      : '';
  const gone = [...new Map((Array.isArray(r?.cleared) ? r.cleared : []).map((c) => [c.person_id, c])).values()];
  const who = listed(gone.map((c) => `${c.name}${c.shares ? ` (same ${c.shares})` : ''}`));
  const cleared = gone.length
    ? `no longer flagged as possibly the same donor as ${who}: check ${gone.length === 1 ? 'that record' : 'those records'}`
    : '';
  const tail = [over, cleared].filter(Boolean).join('; ');
  return `✓ ${name}: one record${tail ? ` — ${tail}` : ''}`;
};
