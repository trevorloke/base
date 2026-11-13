// The keys an import matches people by (routes/data.js candidates), kept
// here so a move (ext/moves) stores its old address's key exactly as the
// importer will compute it from a list's row. SQL, computed on both sides.
//   KEY(col)          lower case, spaces and punctuation dropped
//   NAME_ADDR(n, a)   a name and a street, as one key
export const KEY = (col) => `regexp_replace(lower(${col}), '[^[:alnum:]]+', '', 'g')`;
export const NAME_ADDR = (n, a) => `${KEY(n)} || '|' || ${KEY(a)}`;
