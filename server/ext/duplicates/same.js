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
