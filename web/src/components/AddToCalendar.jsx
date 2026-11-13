// "Add to calendar" — one quiet button on a thing with a date (a shift's
// page, GOTV's voting days, a filing date). Tapping it opens three choices
// in place:
//   Google           a link that opens Google Calendar with the event filled in
//   Outlook          the same for Outlook.com
//   Apple & others   a file Apple Calendar (and every other calendar app)
//                    adds — a short-lived link the server makes when the
//                    choices open (GET /api/calendar/<kind>/<id>/link), so
//                    it needs no cookie: an iPhone home-screen app hands
//                    links to Safari, which has none. A plain link, never
//                    `download`: iOS opens its Add sheet for it.
// event: the screen's own data as a calendar event (shared/ics.js), for the
// Google and Outlook links; none (voting days with none still to come)
// leaves only the file. disabled: a "Count me in" still on this phone.
// No signal (or still on the phone): the choices are off, "Needs signal".
import { useEffect, useRef, useState } from 'react';
import { googleLink, outlookLink } from '@starbase/shared/ics';
import { apiGet } from '../api.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';
import './calendar.css';

export default function AddToCalendar({ kind, id, event = null, disabled = false, label = 'Add to calendar' }) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState({ state: 'idle', url: null });
  const toggleRef = useRef(null);
  const asked = useRef(0);
  const off = disabled || !online;

  // A fresh file link each time the choices open (they last 10 minutes).
  const fetchLink = () => {
    const n = ++asked.current;
    setFile({ state: 'loading', url: null });
    apiGet(`/calendar/${kind}/${id}/link`)
      .then((r) => { if (asked.current === n) setFile({ state: 'ready', url: r.url }); })
      .catch(() => { if (asked.current === n) setFile({ state: 'failed', url: null }); });
  };
  const show = (on) => {
    setOpen(on);
    if (on && !off) fetchLink();
  };
  // Signal back with the choices open: fetch the link then.
  useEffect(() => { if (open && !off && file.state === 'idle') fetchLink(); }, [open, off]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) { asked.current += 1; setFile({ state: 'idle', url: null }); } }, [open]);

  const onKey = (e) => {
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); toggleRef.current?.focus(); }
  };
  const panel = `cal-${kind}-${id}`;
  const status = !open ? '' : off ? 'Needs signal' : file.state === 'loading' ? 'Calendar choices open — Loading…'
    : file.state === 'failed' ? 'Calendar choices open — Apple & others unavailable' : 'Calendar choices open';

  return (
    <div className="cal-add" onKeyDown={onKey}>
      <button type="button" ref={toggleRef} className="btn btn-quiet cal-tap" aria-expanded={open} aria-controls={panel}
        onClick={() => show(!open)}>
        {label}
      </button>
      <span className="cal-sr" role="status" aria-live="polite">{status}</span>
      {open && (
        <div id={panel} className="cal-choices" role="group" aria-label={label}>
          <div className="cal-row">
            {event && (off
              ? <button type="button" className="btn cal-choice" disabled>Google</button>
              : <a className="btn cal-choice" href={googleLink(event)} target="_blank" rel="noopener noreferrer">Google</a>)}
            {event && (off
              ? <button type="button" className="btn cal-choice" disabled>Outlook</button>
              : <a className="btn cal-choice" href={outlookLink(event)} target="_blank" rel="noopener noreferrer">Outlook</a>)}
            {!off && file.state === 'ready' ? (
              <a className="btn cal-choice" href={file.url}>Apple &amp; others</a>
            ) : !off && file.state === 'failed' ? (
              <button type="button" className="btn cal-choice" onClick={fetchLink}>Unavailable — Try again</button>
            ) : (
              <button type="button" className="btn cal-choice" disabled>{off ? 'Apple & others' : 'Loading…'}</button>
            )}
          </div>
          {off ? <NeedsSignalLine>Needs signal</NeedsSignalLine>
            : file.state === 'failed' ? <p className="cal-help">The file for Apple &amp; others didn’t load — Try again.</p>
              : <p className="cal-help">Apple &amp; others opens a file your calendar adds.</p>}
        </div>
      )}
    </div>
  );
}
