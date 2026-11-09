// Follow-ups — every open one, for the desk: speed to lead's new volunteers,
// website messages and new RSVPs (each with a named organizer and a 24-hour
// clock), and the staff tasks ladders made ("Call Ana to say thanks").
//   The big number, how many are past their day, and — over the last 30
//   days — how fast people were first reached ("first reached in 3 h,
//   typically · 9 of 10 within a day").
//   Who has them: one row per organizer ("Rae Example · 3 · 1 overdue"), and
//   "Not handed to anyone" for a ladder's tasks; a tap shows only theirs
//   (?who=, so the address keeps it).
//   One row each: what they did, who and who has it, the clock; Call (when
//   there's a phone), Done, and "Hand to…" (another organizer — a ladder's
//   own tasks to the desk only). Done says so in a toast with Undo; done
//   ones fold away under "Done · N". Back says where it came from ("← Today"
//   from Today's "2 follow-ups", else "← Ladders"). Desk only.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { LadBack, fmtWhen } from '../components/LaddersBits.jsx';
import { clockOf } from '../components/FollowupsToday.jsx';
import './shifts.css';
import './ladders.css';

const dialable = (phone) => String(phone || '').replace(/\s*(?:ext\.?|x|#).*$/i, '').replace(/[^\d+]/g, '');
const ROUTED = {
  brought_in: 'brought them in', knows: 'knows them', turf: 'on their turf', office: 'the office', desk: 'handed over',
};
const hoursWords = (h) => (h == null ? null : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.round(h)} h`);

// "First reached in 3 h, typically · 9 of 10 within a day · 2 waiting".
function Pace({ stats }) {
  if (!stats?.made) return null;
  const bits = [
    stats.median_hours != null ? `First reached in ${hoursWords(stats.median_hours)}, typically` : null,
    stats.reached ? `${stats.in_a_day} of ${stats.reached} within a day` : 'Nobody reached yet',
    stats.waiting ? `${stats.waiting} waiting` : null,
  ].filter(Boolean);
  return <p className="lad-pace"><span className="lad-label">Last {stats.days} days</span>{bits.join(' · ')}</p>;
}

function HandTo({ f, members, onHand, busy }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const id = useId();
  // A ladder's own task can be about money: it stays with the desk.
  const who = members.filter((m) => m.id !== f.assigned?.id && (f.kind !== 'ladder' || m.role !== 'volunteer'));
  if (!open) return <button type="button" className="btn btn-quiet ops-tap" onClick={() => setOpen(true)}>Hand to…</button>;
  return (
    <form className="lad-hand" onSubmit={async (e) => { e.preventDefault(); if (to && await onHand(f, to)) setOpen(false); }}>
      <label className="lad-label" htmlFor={id}>Hand to</label>
      <select id={id} className="input lad-select" value={to} onChange={(e) => setTo(e.target.value)} required>
        <option value="" disabled>Pick someone</option>
        {who.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <button type="submit" className="btn ops-solid ops-tap" disabled={busy || !to}>Hand over</button>
      <button type="button" className="btn btn-quiet ops-tap" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

function Row({ f, onDone, onHand, busy, members, now }) {
  const open = f.status === 'open';
  const clock = open ? clockOf(f.due_at, now) : null;
  // A ladder's task reads as the task ("Call Ana to say thanks"); speed to
  // lead's as the person, then what they did.
  const lead = f.kind !== 'ladder';
  return (
    <li className="ops-item lad-fu" data-tone={open ? undefined : 'past'} data-late={clock?.late || undefined}>
      <div className="ops-row ops-row--static">
        <span className="ops-row__main">
          <span className="ops-row__name">{lead ? <Link className="lad-fu__who" to={`/people/${f.person.id}`}>{f.person.name}</Link> : f.text}</span>
          <span className="ops-row__sub">
            {lead ? <span>{f.text}</span> : <Link to={`/people/${f.person.id}`}>{f.person.name}</Link>}
            {f.ladder && <span>{f.ladder.name}</span>}
            {open && f.assigned && <span>{f.assigned.name} has it{ROUTED[f.routed] ? ` (${ROUTED[f.routed]})` : ''}</span>}
            {open && !f.assigned && <span>Not handed to anyone</span>}
            {!open && <span>{f.contacted_at ? 'Reached' : 'Done'}{f.done_by_name ? ` by ${f.done_by_name}` : ''} · {fmtWhen(f.done_at)}</span>}
            {open && !clock && <span>{fmtWhen(f.created_at)}</span>}
          </span>
        </span>
        {clock && (
          <span className={`lad-clock${clock.late ? ' is-late' : ''}`}>
            <span aria-hidden="true">{clock.text}</span><span className="lad-sr">{clock.label}</span>
          </span>
        )}
      </div>
      <div className="lad-fu__acts">
        {open && f.person.phone && <a className="btn ops-tap" href={`tel:${dialable(f.person.phone)}`}>Call</a>}
        {open
          ? <button type="button" className="btn ops-solid ops-tap" disabled={busy} onClick={() => onDone(f, true)}>Done</button>
          : <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => onDone(f, false)}>Not done</button>}
        {open && members.length > 1 && <HandTo f={f} members={members} onHand={onHand} busy={busy} />}
      </div>
    </li>
  );
}

export default function LaddersFollowups() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const who = params.get('who') || '';
  const q = useQuery({
    queryKey: ['ladders', 'followups', who],
    queryFn: () => apiGet(`/ladders/followups${who ? `?who=${encodeURIComponent(who)}` : ''}`),
  });
  const members = useQuery({ queryKey: ['members'], queryFn: () => apiGet('/members'), staleTime: 60_000 }).data?.members ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const timer = useRef(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['ladders'] }),
    queryClient.invalidateQueries({ queryKey: ['followups'] }),
    queryClient.invalidateQueries({ queryKey: ['person'] }),
  ]);
  const mark = async (f, done) => {
    setBusy(true);
    setError(null);
    try {
      await action('ladder.followupDone', { id: f.id, done });
      await refresh();
      clearTimeout(timer.current);
      setToast(done ? { text: `Done · ${f.person.name}`, f } : null);
      if (done) timer.current = setTimeout(() => setToast(null), 7000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const hand = async (f, userId) => {
    setBusy(true);
    setError(null);
    try {
      const r = await action('ladder.followupAssign', { id: f.id, user_id: userId });
      await refresh();
      clearTimeout(timer.current);
      setToast({ text: `${f.person.name} · ${r.assigned_to?.name || 'handed over'} has it` });
      timer.current = setTimeout(() => setToast(null), 7000);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  // Keep where this came from ("← Today") while the filter changes.
  const pick = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('who', id); else next.delete('who');
    setParams(next, { replace: true, state: location.state });
  };

  const open = q.data?.open ?? [];
  const done = q.data?.done ?? [];
  const by = q.data?.by ?? [];
  const total = by.reduce((n, b) => n + b.open, 0);
  const late = by.reduce((n, b) => n + b.overdue, 0);
  return (
    <div className="ops-page lad-page">
      <LadBack />
      <div className="ops-head"><h1>Follow-ups</h1></div>
      {noSignal(q) ? <NoSignal /> : (
        <>
          {q.isPending && <p className="muted">Loading…</p>}
          {q.isError && <p className="error" role="alert">{q.error.message}</p>}
        </>
      )}
      {q.isSuccess && (
        <p className="ops-hero">
          <span className="n">{total}</span><span className="sub">to do</span>
          {late > 0 && <span className="lad-late">{late} overdue</span>}
        </p>
      )}
      {q.isSuccess && <Pace stats={q.data.stats} />}
      {by.length > 0 && (
        <section className="lad-by" aria-labelledby="lad-by-h">
          <h2 className="lad-h" id="lad-by-h">Who has them</h2>
          <div className="lad-by__list" role="group" aria-label="Show the follow-ups of">
            <button type="button" className="lad-by__pick" aria-pressed={!who} onClick={() => pick('')}>
              Everyone <span className="mono">{total}</span>
            </button>
            {by.map((b) => (
              <button key={b.id || 'none'} type="button" className="lad-by__pick" aria-pressed={who === (b.id || 'none')}
                onClick={() => pick(b.id || 'none')}>
                {b.name || 'Not handed to anyone'} <span className="mono">{b.open}</span>
                {b.overdue > 0 && <span className="lad-by__late"> · {b.overdue} overdue</span>}
              </button>
            ))}
          </div>
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {q.isSuccess && open.length === 0 && <p className="ops-empty">Nothing to follow up.</p>}
      {open.length > 0 && (
        <ul className="ops-rows">
          {open.map((f) => <Row key={f.id} f={f} onDone={mark} onHand={hand} busy={busy} members={members} now={now} />)}
        </ul>
      )}
      {done.length > 0 && (
        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={showDone} aria-controls="lad-fu-done"
            onClick={() => setShowDone((v) => !v)}>
            Done · {done.length}
          </button>
          {showDone && <ul id="lad-fu-done" className="ops-rows ops-more-body">{done.map((f) => <Row key={f.id} f={f} onDone={mark} onHand={hand} busy={busy} members={members} now={now} />)}</ul>}
        </div>
      )}
      {toast && (
        <div className="toast ops-toast" role="status">
          <span>{toast.text}</span>
          {toast.f && <button type="button" className="btn" disabled={busy} onClick={() => mark(toast.f, false)}>Undo</button>}
        </div>
      )}
    </div>
  );
}
