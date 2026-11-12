// Which of a person's ties matter most — one order for the server's key
// read (ext/relationships GET /relationships/key) and the screens' key line,
// so the profile and the Calls card always name the same people first.
//
//   rankTies([{ kind, close, linked_at, person: { id, name, rating, dnc } }])
//     → a new array: the ties whose other end may be contacted (dnc dropped),
//       close first; then someone rated 1 or 2; then family, friend,
//       neighbour, work, community, other; then the newest; then by name.
export const TIE_KINDS = ['family', 'friend', 'neighbour', 'work', 'community', 'other'];

const kindAt = (k) => {
  const i = TIE_KINDS.indexOf(k);
  return i < 0 ? TIE_KINDS.length : i;
};
const supporter = (t) => (t.person?.rating === '1' || t.person?.rating === '2' ? 0 : 1);
const when = (t) => {
  const ms = t.linked_at ? new Date(t.linked_at).getTime() : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
};
const nameOf = (t) => String(t.person?.name ?? '').toLowerCase();
const idOf = (t) => String(t.person?.id ?? '');

export const rankTies = (ties) => (Array.isArray(ties) ? ties : [])
  .filter((t) => t && !t.person?.dnc)
  .sort((x, y) => (Number(Boolean(y.close)) - Number(Boolean(x.close)))
    || (supporter(x) - supporter(y))
    || (kindAt(x.kind) - kindAt(y.kind))
    || (when(y) - when(x))
    || (nameOf(x) < nameOf(y) ? -1 : nameOf(x) > nameOf(y) ? 1 : 0)
    || (idOf(x) < idOf(y) ? -1 : idOf(x) > idOf(y) ? 1 : 0));
