// Follow up — the organizer's own people to reach (server/ext/followups:
// a new volunteer, a website message, an RSVP from someone new, routed to
// whoever knows them, else their turf's organizer, else the managers). On
// both Todays, above everything else, only when there is one. Each row: the
// name, what they did, and the 24-hour clock ("21 h left"; red once it's
// past: "Overdue · 3 h"). A row opens in place (FollowupReach.jsx, loaded
// on the first tap): what they said, one tap to call or text, and how it
// went — logging it closes the follow-up, here and for the desk.
import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import './followups.css';

const Reach = lazy(() => import('./FollowupReach.jsx'));

export const FOLLOWUPS_KEY = ['followups', 'mine'];
const MIN = 60_000;
const HOUR = 3_600_000;

// The clock in words: short on the row, whole for a screen reader.
export const clockOf = (dueAt, now) => {
  if (!dueAt) return null;
  const left = new Date(dueAt).getTime() - now;
  const abs = Math.abs(left);
  const hours = Math.floor(abs / HOUR);
  const mins = Math.max(1, Math.round(abs / MIN));
  const short = abs >= HOUR ? `${hours} h` : `${mins} min`;
  const long = abs >= HOUR ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  return left >= 0
    ? { text: `${short} left`, label: `${long} left to reach them`, late: false }
    : { text: `Overdue · ${short}`, label: `Overdue by ${long}`, late: true };
};

// Now, by the server's clock (a phone set wrong still counts the day right),
// moving on every minute.
const useNow = (serverNow, fetchedAt) => {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const skew = serverNow && fetchedAt ? new Date(serverNow).getTime() - fetchedAt : 0;
  return tick + (Number.isFinite(skew) ? skew : 0);
};

function Row({ f, now, open, onToggle, me, onLogged }) {
  const clock = clockOf(f.due_at, now);
  const bodyId = useId();
  return (
    <li className="fu-item" data-open={open || undefined} data-late={clock?.late || undefined}>
      <button type="button" className="fu-row" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={onToggle}>
        <span className="fu-row__main">
          <span className="fu-row__name">{f.person.name}</span>
          <span className="fu-row__did">{f.text}</span>
        </span>
        {clock && (
          <span className={`fu-clock${clock.late ? ' is-late' : ''}`}>
            <span aria-hidden="true">{clock.text}</span>
            <span className="fu-sr">{clock.label}</span>
          </span>
        )}
      </button>
      {open && (
        <div id={bodyId}>
          <Suspense fallback={<p className="fu-wait">Opening…</p>}>
            <Reach f={f} me={me} onLogged={onLogged} />
          </Suspense>
        </div>
      )}
    </li>
  );
}

// The first few, the most urgent first; the rest one tap away.
const SHOW = 5;

export default function FollowupsToday({ me }) {
  const q = useQuery({
    queryKey: FOLLOWUPS_KEY,
    queryFn: () => apiGet('/followups/mine'),
    // A new one arrives with the next look; the clock moves by itself.
    refetchInterval: 5 * MIN,
  });
  const [open, setOpen] = useState(null);
  const [said, setSaid] = useState(null);
  const [all, setAll] = useState(false);
  // Logged: the row goes, so the keyboard lands back on the heading.
  const headRef = useRef(null);
  const now = useNow(q.data?.now, q.dataUpdatedAt);
  const list = q.data?.followups ?? [];
  const shown = all ? list : list.slice(0, SHOW);
  useEffect(() => {
    if (!said) return undefined;
    const t = setTimeout(() => setSaid(null), 12_000);
    return () => clearTimeout(t);
  }, [said]);
  if (!list.length && !said) return null;
  const late = list.filter((f) => clockOf(f.due_at, now)?.late).length;
  return (
    <section className="today-section fu" aria-labelledby="fu-h">
      <h2 className="today-h fu-h" id="fu-h" ref={headRef} tabIndex={-1}>
        Follow up{list.length > 0 && <span className="fu-h__n">· {list.length}</span>}
        {late > 0 && <span className="fu-h__late"> · {late} overdue</span>}
      </h2>
      {said && <p className="fu-said" role="status">{said}</p>}
      {list.length > 0 && (
        <ul className="fu-rows">
          {shown.map((f) => (
            <Row key={f.id} f={f} now={now} me={me} open={open === f.id}
              onToggle={() => setOpen(open === f.id ? null : f.id)}
              onLogged={(words) => { setOpen(null); setSaid(words); requestAnimationFrame(() => headRef.current?.focus()); }} />
          ))}
        </ul>
      )}
      {list.length > shown.length && (
        <button type="button" className="fu-all" onClick={() => setAll(true)}>
          Show all {list.length}
        </button>
      )}
    </section>
  );
}
