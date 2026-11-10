// How two records are compared, as SQL on a column: case and spaces don't
// count, and a phone is its last ten digits (a leading 1 doesn't count).
// The duplicate finder pairs records this way (index.js), and the payments
// add up what may be one donor's gifts the same way (ext/payments
// limits.js), so the two agree on what "the same" is.
export const sameText = (col) => `lower(regexp_replace(trim(coalesce(${col}, '')), '\\s+', ' ', 'g'))`;
export const samePhone = (col) => `right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10)`;
// A postal code in capitals with its letters and digits only, so "V3T 2C3",
// "v3t2c3" and "V3T-2C3" (the website's form takes a hyphen) are one code.
export const samePostal = (col) => `upper(regexp_replace(coalesce(${col}, ''), '[^A-Za-z0-9]+', '', 'g'))`;

// What record `o` shares with record `d` (table aliases), as columns: the
// same phone (seven digits or more), street address or whole postal code
// → by_phone, by_address, by_postal. In words: sharedWords.
export const sharesOf = (d, o) => `
  length(${samePhone(`${d}.phone`)}) >= 7 and ${samePhone(`${o}.phone`)} = ${samePhone(`${d}.phone`)} as by_phone,
  ${sameText(`${d}.address`)} <> '' and ${sameText(`${o}.address`)} = ${sameText(`${d}.address`)} as by_address,
  length(${samePostal(`${d}.postal`)}) >= 6 and ${samePostal(`${o}.postal`)} = ${samePostal(`${d}.postal`)} as by_postal`;

// "a", "a and b", "a, b and c".
export const listed = (words) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] || '');
// "phone", "address and postal code" — '' when they share none of them.
export const sharedWords = (o) => listed([o.by_phone && 'phone', o.by_address && 'address', o.by_postal && 'postal code'].filter(Boolean));
