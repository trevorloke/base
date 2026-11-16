// Names in parts — used where a name is typed (Add a person, Edit, the
// door, mainstreeting), imported, or sent by the website.
//
// A first name with a second word or an initial is a first name and a
// middle name: "Mary Anne" → Mary · Anne, "John A." → John · A.,
// "Mary-Anne Jo" → Mary-Anne · Jo. A hyphenated name is one name
// ("Mary-Anne", "Mary - Anne" → Mary-Anne). A nickname in brackets
// ("Robert (Bob)") is left as typed.
// → { first, middle } when it splits, else null.
export const splitFirst = (raw) => {
  const s = String(raw ?? '').trim().replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ');
  if (!s.includes(' ') || /[(),]/.test(s)) return null;
  const [first, ...rest] = s.split(' ');
  return { first, middle: rest.join(' ') };
};

// First, middle and last → the whole name, as the database writes it.
export const joinName = (...parts) => parts.map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');

// People's own search box (lib/audience.js, and offline KeptCopies.js):
// letters, spaces, commas, apostrophes, dots and hyphens only, in two words
// or more on spaces and commas ("smith kevin", "Smith, Kevin") → the words,
// at most six, each to be somewhere in the name; anything else → null (one
// string, as typed).
export const nameWords = (q) => {
  const s = String(q ?? '').trim();
  if (!/^[\p{L}\s,.'’-]+$/u.test(s)) return null;
  const words = s.split(/[\s,]+/).filter(Boolean);
  return words.length >= 2 ? words.slice(0, 6) : null;
};

// One way to fold a name, for finding people and putting them in A–Z order.
// The database's person_fold (server/db/schema.js) is built from these same
// two strings, so the server and the browser agree letter for letter,
// whatever the database's collation.
//
// FOLD_FROM → FOLD_TO, one for one: every letter of Latin-1 Supplement
// (U+00C0–00FF), Latin Extended-A (U+0100–017F) and the Vietnamese block
// (U+1EA0–1EF9) whose NFD form is one ASCII letter and combining marks only,
// to that letter in lower case; and Đ đ Ð ð → d, Ł ł → l, Ø ø → o, Ħ ħ → h,
// ı → i, Ŧ ŧ → t, ſ → s. Then four marks dropped (nothing opposite them):
// ' ’ ʼ and the full stop — "D'Souza" → dsouza, "St. Pierre" → st pierre.
// Left as they are (no one-letter spelling): Æ æ Þ þ ß Ĳ ĳ ĸ Ŀ ŀ ŉ Ŋ ŋ Œ œ.
// Written out once by that rule (never worked out at run time). Never change
// them: indexes are built on the database's copy. A different fold is a new
// name (person_fold2) with new indexes.
export const FOLD_FROM = "ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝàáâãäåçèéêëìíîïðñòóôõöøùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĴĵĶķĹĺĻļĽľŁłŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹ'’ʼ.";
export const FOLD_TO = "aaaaaaceeeeiiiidnoooooouuuuyaaaaaaceeeeiiiidnoooooouuuuyyaaaaaaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiiijjkkllllllllnnnnnnoooooorrrrrrssssssssttttttuuuuuuuuuuuuwwyyyzzzzzzsaaaaaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeeiiiioooooooooooooooooooooooouuuuuuuuuuuuuuyyyyyyyy";

const FOLD = new Map([...FOLD_FROM].map((ch, i) => [ch, FOLD_TO[i] ?? '']));

// A stored name, folded: what person_fold(name) gives on the server. ASCII
// letters only are lowered (as the server's lower(… collate "C")), runs of
// space, tab and line breaks become one space, and the ends are trimmed.
export const foldName = (s) => [...String(s ?? '')].map((ch) => (FOLD.has(ch) ? FOLD.get(ch) : ch)).join('')
  .replace(/[A-Z]/g, (ch) => ch.toLowerCase())
  .replace(/[ \t\n\r]+/g, ' ')
  .replace(/^ | $/g, '');

// A term someone typed or pasted: composed first, so "José" typed with a
// separate accent folds as "jose" does. Never stored or indexed.
export const foldTerm = (s) => foldName(String(s ?? '').normalize('NFC'));

// A–Z by last name (an organisation or a one-word name by its whole name),
// then the whole name, then the id — the server's order (server/lib/az.js),
// compared as code units as its collate "C" compares bytes.
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
export const azSort = (a, b) => cmp(foldName(a.last_name || a.name), foldName(b.last_name || b.name))
  || cmp(foldName(a.name), foldName(b.name))
  || cmp(String(a.id ?? ''), String(b.id ?? ''));
