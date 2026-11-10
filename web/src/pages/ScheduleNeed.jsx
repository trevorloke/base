// "We need": how many people a shift wants — a target that never turns
// anyone away, set by tap. Nothing has one until someone taps a number: a
// new shift's card just says who is on it. What the kind usually wants
// (shared/shiftkinds.js) is the first number offered, marked "usual"; a
// shift's own number, when it is none of these, joins them.
//
//   <NeedChips kind={kind} value={null | n} onChange={(n | null) => …} own={shift.need} />
const NEEDS = [1, 2, 3, 4, 5, 6, 8, 10];

export default function NeedChips({ kind, value, onChange, own = null }) {
  const usual = kind?.need || null;
  const rest = [...new Set([...NEEDS, ...(own ? [own] : [])])].filter((n) => n !== usual).sort((a, b) => a - b);
  return (
    <>
      <div className="sch-chips" role="group" aria-label="We need">
        <button type="button" className="sch-chip" aria-pressed={value === null} onClick={() => onChange(null)}>No target</button>
        {usual && (
          <button type="button" className="sch-chip" aria-pressed={value === usual} aria-label={`${usual}, the usual for ${kind.label}`} onClick={() => onChange(usual)}>
            {usual} · usual
          </button>
        )}
        {rest.map((n) => (
          <button key={n} type="button" className="sch-chip" aria-pressed={value === n} onClick={() => onChange(n)}>{n}</button>
        ))}
      </div>
      <span className="ops-meta">A target — nobody is turned away</span>
    </>
  );
}
