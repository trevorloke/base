// A name as it's written, with the surname in bold: "Kevin <b>Smith</b>".
// Lists run A–Z by last name (server/lib/az.js), so the bold part is what
// the order follows. The element's text is the plain name. No surname, or a
// name that doesn't end with it (an org, an odd import): the name as written.
import './name-az.css';

export default function NameAz({ person }) {
  const name = String(person?.name ?? '');
  const last = String(person?.last_name ?? '').trim();
  if (!last || last.length >= name.length || !name.endsWith(last)) return name;
  const head = name.slice(0, name.length - last.length);
  // "Jo Van Sample": the surname starts a word, never the middle of one.
  if (!/\s$/.test(head)) return name;
  return <>{head}<b className="name-az">{last}</b></>;
}
