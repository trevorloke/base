// A sheet over the week (schedule.css): up from the bottom on a phone, a
// panel at the right on a desk. The week under it stays where it was.
//
//   <Sheet title="Add shifts" onClose={…} foot={<button …/>}>…</Sheet>
//
// Opening it puts the focus on its title — never in a text field, so no
// keyboard comes up on a phone. Tab stays inside it, Escape or a tap
// outside closes it, and the focus goes back to what opened it. `foot`
// stays in view under the part that scrolls: the sheet's one main button.
//
//   <Unavailable what="Places" onRetry={…} />   a read that failed, said so:
//   "Places unavailable" and "Try again" — never an empty list in its place.
import { useEffect, useId, useRef } from 'react';
import './schedule.css';

const CAN_FOCUS = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

export default function Sheet({ title, sub = null, onClose, foot = null, children }) {
  const titleId = useId();
  const boxRef = useRef(null);
  const titleRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    titleRef.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape') { closeRef.current(); return; }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const els = [...boxRef.current.querySelectorAll(CAN_FOCUS)].filter((el) => el.getClientRects().length > 0);
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0];
      const last = els[els.length - 1];
      const at = document.activeElement;
      if (!boxRef.current.contains(at)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (at === first || at === titleRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <>
      <div className="sch-scrim" onClick={() => onClose()} aria-hidden="true" />
      <section ref={boxRef} className="sch-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="sch-sheet__head">
          <div className="sch-sheet__titles">
            <h2 id={titleId} ref={titleRef} tabIndex={-1}>{title}</h2>
            {sub && <p className="sch-sheet__sub">{sub}</p>}
          </div>
          <button type="button" className="btn btn-quiet sch-x" aria-label="Close" onClick={() => onClose()}>✕</button>
        </header>
        <div className="sch-sheet__body">{children}</div>
        {foot && <footer className="sch-sheet__foot">{foot}</footer>}
      </section>
    </>
  );
}

export function Unavailable({ what = null, onRetry }) {
  return (
    <p className="sch-unavailable" role="alert">
      <span>{what ? `${what} unavailable` : 'Unavailable'}</span>
      <button type="button" className="btn ops-tap" onClick={onRetry}>Try again</button>
    </p>
  );
}
