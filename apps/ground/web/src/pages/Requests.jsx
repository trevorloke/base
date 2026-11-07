// Requests from the doors — what canvassers asked the office to do about
// someone ("Ask the office" under More at a door). Open ones first, newest
// at the top: the person (to their profile), what it's about, what they
// said, who asked and when; Call (when there's a phone), Profile, and
// "Done ✓", which asks in place what you did (optional) before it marks it
// done. Done ones (the Done pill) say who did it, when and what, with a
// quiet Reopen. Desk only (area People); it needs signal to load and to mark
// anything done. Back says where it came from ("← Today" from Today's
// "3 requests from the doors").
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NeedsSignalLine, NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { KIND_WORDS } from '../components/RequestAsk.jsx';
import './shifts.css';
import './requests.css';

const dialable = (phone) => String(phone || '').replace(/\s*(?:ext\.?|x|#).*$/i, '').replace(/[^\d+]/g, '');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
// "Sat 2:10 pm" this week, "Oct 18 2:10 pm" before that.
const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  const time = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  const day = Date.now() - d.getTime() < 6 * 86400_000
    ? d.toLocaleDateString('en-CA', { weekday: 'short' })
    : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  return `${day.replace(/\.$/, '')} ${time}`;
};
// "4 – 7231 132 St", as the walk list says a door.
const placeOf = (p) => (p.address ? (p.unit ? `${p.unit} – ${p.address}` : p.address) : '');

function Back() {
  const from = useLocation().state?.from;
  return from?.to
    ? <Link className="ops-back" to={from.to}>← {from.label || 'Back'}</Link>
    : <Link className="ops-back" to="/">← Today</Link>;
}

// One row's "Done" asks at a time (the list holds which): the page keeps a
// single yellow button.
function Row({ r, online, busy, onDone, onReopen, confirming, setConfirming }) {
  const [note, setNote] = useState('');
  const id = useId();
  const done = Boolean(r.done_at);
  const place = placeOf(r.person);
  return (
    <li className="ops-item rq-row" data-tone={done ? 'past' : undefined}>
      <div className="ops-row ops-row--static">
        <span className="ops-row__main">
          <span className="ops-row__name">
            <Link to={`/people/${r.person.id}`} className="rq-who">{r.person.name}</Link>
            <span className="rq-kind-word"> · {KIND_WORDS[r.kind] || KIND_WORDS.other}</span>
          </span>
          {r.note && <span className="rq-said">“{r.note}”</span>}
          <span className="ops-row__sub">
            {place && <span>{place}</span>}
            <span title={r.asked_by_name || undefined}>
              {r.asked_by_name ? `asked by ${firstName(r.asked_by_name)} · ` : ''}{when(r.created_at)}
            </span>
          </span>
          {done && (
            <span className="ops-row__sub rq-done-line">
              <span title={r.done_by_name || undefined}>
                done{r.done_by_name ? ` by ${firstName(r.done_by_name)}` : ''} · {when(r.done_at)}{r.done_note ? ` · “${r.done_note}”` : ''}
              </span>
            </span>
          )}
        </span>
      </div>
      {confirming ? (
        <form className="rq-confirm" aria-label={`Done: ${r.person.name}`}
          onSubmit={(e) => { e.preventDefault(); onDone(r, note.trim()).then((ok) => { if (ok) { setConfirming(false); setNote(''); } }); }}>
          <label htmlFor={`${id}-did`} className="rq-sr">What you did</label>
          <input id={`${id}-did`} className="input rq-note" maxLength={500} autoComplete="off" autoFocus
            placeholder="What you did" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="rq-acts">
            <button type="submit" className="btn btn-primary ops-tap" disabled={busy || !online}>Done</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => { setConfirming(false); setNote(''); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="rq-row__acts">
          {!done && r.person.phone && <a className="btn ops-tap" href={`tel:${dialable(r.person.phone)}`}>Call</a>}
          <Link className="btn ops-tap" to={`/people/${r.person.id}`}>Profile</Link>
          {done
            ? <button type="button" className="btn btn-quiet ops-tap" disabled={busy || !online} onClick={() => onReopen(r)}>Reopen</button>
            : <button type="button" className="btn ops-solid ops-tap" disabled={busy || !online} onClick={() => setConfirming(true)}>Done ✓</button>}
        </div>
      )}
    </li>
  );
}

export default function Requests() {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const showDone = params.get('show') === 'done';
  const q = useQuery({
    queryKey: ['requests', showDone ? 'all' : 'open'],
    queryFn: () => apiGet(showDone ? '/requests?open=all' : '/requests'),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [asking, setAsking] = useState(null); // the row whose "Done" is asking
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['requests'] }),
    queryClient.invalidateQueries({ queryKey: ['person'] }),
  ]);
  const say = (t) => {
    clearTimeout(timer.current);
    setToast(t);
    if (t) timer.current = setTimeout(() => setToast(null), t.r ? 7000 : 3000);
  };

  const markDone = async (r, note) => {
    setBusy(true);
    setError(null);
    try {
      await action('request.done', { id: r.id, ...(note ? { note } : {}) });
      await settle();
      say({ text: '✓ Done', r });
      return true;
    } catch (e) {
      setError(/already done/i.test(e.message) ? 'Someone already marked that one done.' : e.message);
      await settle();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const reopen = async (r, fromToast = false) => {
    setBusy(true);
    setError(null);
    try {
      await action('request.reopen', { id: r.id });
      await settle();
      say(fromToast ? null : { text: `Reopened · ${r.person.name}` });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const rows = q.data?.requests ?? [];
  const shown = showDone ? rows.filter((r) => r.done_at) : rows;
  const pick = (done) => setParams(done ? { show: 'done' } : {}, { replace: true });
  return (
    <div className="ops-page rq-page">
      <Back />
      <div className="ops-head"><h1>Requests from the doors</h1></div>
      <div className="rq-pills" role="group" aria-label="Show">
        <button type="button" className={`rq-pill${showDone ? '' : ' is-on'}`} aria-pressed={!showDone} onClick={() => pick(false)}>Open</button>
        <button type="button" className={`rq-pill${showDone ? ' is-on' : ''}`} aria-pressed={showDone} onClick={() => pick(true)}>Done</button>
      </div>
      {noSignal(q) ? <NoSignal /> : (
        <>
          {q.isPending && <p className="muted">Loading…</p>}
          {q.isError && <p className="error" role="alert">{q.error.message}</p>}
        </>
      )}
      {!online && q.isSuccess && <NeedsSignalLine>Marking done needs signal</NeedsSignalLine>}
      {error && <p className="error" role="alert">{error}</p>}
      {q.isSuccess && shown.length === 0 && (
        <p className="ops-empty">{showDone ? 'Nothing done yet.' : 'Nothing waiting from the doors.'}</p>
      )}
      {shown.length > 0 && (
        <ul className="ops-rows">
          {shown.map((r) => <Row key={r.id} r={r} online={online} busy={busy} onDone={markDone} onReopen={(x) => reopen(x)}
            confirming={asking === r.id} setConfirming={(on) => setAsking(on ? r.id : null)} />)}
        </ul>
      )}
      {toast && (
        <div className="toast ops-toast" role="status">
          <span>{toast.text}</span>
          {toast.r && <button type="button" className="btn" disabled={busy || !online} onClick={() => reopen(toast.r, true)}>Undo</button>}
        </div>
      )}
    </div>
  );
}
