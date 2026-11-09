// How two records are compared, as SQL on a column: case and spaces don't
// count, and a phone is its last ten digits (a leading 1 doesn't count).
// The duplicate finder pairs records this way (index.js), and the payments
// add up what may be one donor's gifts the same way (ext/payments
// limits.js), so the two agree on what "the same" is.
export const sameText = (col) => `lower(regexp_replace(trim(coalesce(${col}, '')), '\\s+', ' ', 'g'))`;
export const samePhone = (col) => `right(regexp_replace(coalesce(${col}, ''), '\\D', '', 'g'), 10)`;
// A postal code with no spaces, in capitals (as the website's name and
// postal code match reads it, ext/site people.js).
export const samePostal = (col) => `upper(regexp_replace(coalesce(${col}, ''), '\\s+', '', 'g'))`;
