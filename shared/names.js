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
