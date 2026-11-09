// People → Duplicates: the line after Merge, from person.merge's answer
// (flagged: one entry for each year the record made one is now over the
// limit for). Over on that record alone: "over the donation limit now";
// only over together with another record that may be the same donor (the
// flag names it, maybe_same_donor): "maybe over the donation limit".
// Plain JS (no JSX) so the server's tests can check it.
export const mergedSaid = (name, r) => {
  const flags = Array.isArray(r?.flagged) ? r.flagged : [];
  const tail = flags.some((f) => !f.maybe_same_donor?.length) ? ' — over the donation limit now, flagged in Donations'
    : flags.length ? ' — maybe over the donation limit together with another record, flagged in Donations'
      : '';
  return `✓ ${name}: one record${tail}`;
};
