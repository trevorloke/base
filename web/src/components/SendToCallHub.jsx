// "Send to CallHub" on a list's page and a phone bank's page (ext/callhub).
//   <SendToCallHub kind="list" id={id} />  ·  <SendToCallHub kind="bank" id={id} />
// Shown only when CallHub is on (GET /api/integrations): nothing at all
// otherwise. A tap asks first — how many numbers go, how many people are
// left out — then the sending happens in the background and the line under
// it says how far it is ("Sending · 850 of 2,000", "Sent", or "Stopped:
// CallHub said … · Carry on"). Once calls are made, how many results came
// back; under "What each result counts as", CallHub's own results with the
// outcome each is filed as (filled in by pattern, yours to change), and the
// survey question whose answers rate people — none until someone picks it.
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { offeredCodes, ratingText } from '@starbase/shared/scale';
import { ApiError, action, apiGet } from '../api.js';
import { useOnline } from './NoSignal.jsx';
import { useScale } from './scale.js';
// The shared .ops-* pieces (48px buttons, the quiet line): a phone bank's page doesn't load them itself.
import '../pages/shifts.css';
import './send-to-callhub.css';

const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const plural = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many);
const errorText = (e) => (e instanceof ApiError ? e.message : 'No signal — try again');
// The outcomes a result can be filed as, in the Calls screen's own words.
const OUTCOMES = [
  ['contacted', 'Talked'], ['no_answer', 'No answer'], ['left_message', 'Left message'], ['inaccessible', 'Wrong number'],
  ['refused', 'Refused'], ['moved', 'Moved'], ['do_not_call', 'Do not call'],
];
// "3:42 pm" today, "Tue 3:42 pm" another day.
const whenWord = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('en-CA', today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
const active = (p) => p && (p.status === 'queued' || p.status === 'sending');

function Unavailable({ onRetry }) {
  return <p className="ch-line" role="status">Unavailable — <button type="button" className="btn-link" onClick={onRetry}>Try again</button></p>;
}

// What each of CallHub's results counts as, and the question that rates.
function Results({ p, online, onChanged }) {
  const scale = useScale();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const save = async (input) => {
    setBusy(true); setError(null); setSaid(null);
    try {
      const r = await action('callhub.map', { id: p.id, ...input });
      setSaid(r.changed ? `Saved · ${num(r.changed)} ${plural(r.changed, 'result')} already in moved too` : 'Saved');
      onChanged();
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const support = p.questions.find((q) => q.support) || null;
  const picked = support?.question || p.rating?.question || '';
  const questions = picked && !p.questions.some((q) => q.question === picked) ? [...p.questions, { question: picked, answers: [] }] : p.questions;
  // The whole table for the question goes each time: what the selects show.
  const answersNow = (change = {}) => Object.fromEntries((support?.answers || []).map((a) => [a.answer, a.rating || null]).concat(Object.entries(change)));
  return (
    <div className="ch-results">
      <ul className="ch-map">
        {p.dispositions.map((d, i) => (
          <li key={d.disposition || '—'} className="ch-map__row">
            <label htmlFor={`${uid}-d${i}`} className="ch-map__name">{d.disposition || 'No result given'} <span className="ops-meta">{num(d.n)}</span></label>
            <select id={`${uid}-d${i}`} className="input ch-select" value={d.outcome} disabled={busy || !online}
              onChange={(e) => save({ outcomes: { [d.disposition]: e.target.value === d.suggested ? null : e.target.value } })}>
              {OUTCOMES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {questions.length > 0 && (
        <div className="ch-rate">
          <div className="field">
            <label htmlFor={`${uid}-q`}>Support question</label>
            <select id={`${uid}-q`} className="input ch-select" value={picked} disabled={busy || !online}
              onChange={(e) => save({ rating: e.target.value ? { question: e.target.value, answers: {} } : null })}>
              <option value="">None — nobody is rated from a call</option>
              {questions.map((q) => <option key={q.question} value={q.question}>{q.question}</option>)}
            </select>
          </div>
          {support && (
            <ul className="ch-map">
              {support.answers.map((a, i) => (
                <li key={a.answer} className="ch-map__row">
                  <label htmlFor={`${uid}-a${i}`} className="ch-map__name">{a.answer} <span className="ops-meta">{num(a.n)}</span></label>
                  <select id={`${uid}-a${i}`} className="input ch-select" value={a.rating || ''} disabled={busy || !online}
                    onChange={(e) => save({ rating: { question: picked, answers: answersNow({ [a.answer]: e.target.value || null }) } })}>
                    <option value="">Doesn’t rate</option>
                    {offeredCodes(scale).map((code) => <option key={code} value={code}>{ratingText(scale, code)}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="ops-meta" role="status" aria-live="polite">{busy ? 'Saving…' : said || 'A change also moves the results already in.'}</p>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Push({ p, running, online, onChanged }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const carryOn = async () => {
    setBusy(true); setError(null);
    try { await action('callhub.resume', { id: p.id }); onChanged(); } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const stopped = p.status === 'failed' || p.stalled;
  const pct = p.total ? Math.min(100, Math.round((p.sent / p.total) * 100)) : 0;
  let line;
  if (stopped) line = <><strong>Stopped</strong>: {p.note || 'it stopped part-way'}</>;
  else if (p.status === 'sent') line = <><strong>Sent</strong> · {num(p.sent)} {plural(p.sent, 'number')}{p.sent_at ? ` · ${whenWord(p.sent_at)}` : ''}</>;
  else if (p.status === 'queued') line = <><strong>Waiting</strong> · {running ? 'starting…' : 'background work is off on this server'}</>;
  else {
    line = (
      <><strong>Sending</strong> · {num(p.sent)} of {num(p.total)}
        {p.note ? ` · ${p.note}` : ''}{p.resume_at ? ` · carries on ${whenWord(p.resume_at)}` : ''}</>
    );
  }
  return (
    <li className="ch-push" data-status={stopped ? 'stopped' : p.status}>
      <p className="ch-line ch-status" role="status" aria-live="polite">{line}</p>
      {active(p) && !stopped && <span className="ch-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>}
      {stopped && <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={carryOn}>{busy ? 'Starting…' : 'Carry on'}</button>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="ops-meta ch-book">Phonebook in CallHub: “{p.name}”{p.skipped ? ` · ${num(p.skipped)} left out` : ''}{p.by ? ` · sent by ${p.by}` : ''}</p>
      {p.results > 0 ? (
        <>
          <p className="ch-line"><strong>{num(p.results)}</strong> {plural(p.results, 'result')} back</p>
          <button type="button" className="disclose" aria-expanded={open} aria-controls={`${uid}-r`} onClick={() => setOpen((v) => !v)}>What each result counts as</button>
          {open && <div id={`${uid}-r`}><Results p={p} online={online} onChanged={onChanged} /></div>}
        </>
      ) : p.status === 'sent' && <p className="ops-meta">Next: start the calling campaign on this phonebook in CallHub.</p>}
    </li>
  );
}

export default function SendToCallHub({ kind, id }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const on = useQuery({ queryKey: ['integrations'], queryFn: () => apiGet('/integrations'), staleTime: 5 * 60_000, retry: false });
  const isOn = Boolean(on.data?.callhub ?? on.data?.integrations?.callhub);
  const key = ['callhub', kind, id];
  const pushes = useQuery({
    queryKey: key,
    queryFn: () => apiGet(`/callhub/pushes?${kind}=${id}`),
    enabled: isOn,
    // While it is sending, every few seconds; after, results trickle in.
    refetchInterval: (q) => ((q.state.data?.pushes || []).some(active) ? 3000 : 30_000),
  });
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [earlier, setEarlier] = useState(false);
  const uid = useId();
  const preview = useQuery({
    queryKey: [...key, 'preview'],
    queryFn: () => apiGet(`/callhub/preview?${kind}=${id}`),
    enabled: isOn && asking,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (!isOn) return null;
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    // Results re-filed change people's histories and a bank's numbers.
    queryClient.invalidateQueries({ queryKey: ['persons'] });
    queryClient.invalidateQueries({ queryKey: ['banks'] });
  };
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await action('callhub.push', kind === 'list' ? { list_id: id } : { bank_id: id });
      setAsking(false);
      refresh();
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const list = pushes.data?.pushes || [];
  const going = list.some((p) => active(p) && !p.stalled);
  const pv = preview.data;
  return (
    <section className="ch" aria-label="CallHub">
      <div className="ch-head">
        <h2 className="ch-title">CallHub</h2>
        {!asking && (
          <button type="button" className="btn ops-tap" disabled={!online || going} onClick={() => { setError(null); setAsking(true); }}>
            {list.length ? 'Send again' : 'Send to CallHub'}
          </button>
        )}
      </div>
      {asking && (
        <div className="ch-ask">
          {preview.isError ? <Unavailable onRetry={() => preview.refetch()} />
            : !pv ? <p className="ch-line" role="status">Counting…</p> : (
              <>
                <p className="ch-line" role="status">
                  <strong>{num(pv.numbers)}</strong> {plural(pv.numbers, 'number')} to send{pv.left_out ? ` · ${num(pv.left_out)} left out` : ''}
                </p>
                <p className="ops-meta">
                  {pv.numbers ? `Only names, numbers and cities go.${pv.days > 1 ? ` About ${num(pv.days)} days: CallHub takes 3,600 a day.` : ''}`
                    : 'Nobody here has a number that can be called.'}
                </p>
              </>
            )}
          <div className="ops-actions">
            <button type="button" className="btn ops-solid ops-tap" disabled={busy || !online || !pv?.numbers} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
            <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {pushes.isError && !pushes.data ? <Unavailable onRetry={() => pushes.refetch()} />
        : !pushes.data ? <p className="ch-line" role="status">Loading…</p>
          : !list.length && !asking && <p className="ops-meta">Sends this {kind === 'list' ? 'list' : 'phone bank'} to CallHub’s dialer. Each call’s result comes back onto the person.</p>}
      {list.length > 0 && (
        <ul className="ch-pushes">
          <Push p={list[0]} running={pushes.data.running} online={online} onChanged={refresh} />
        </ul>
      )}
      {list.length > 1 && (
        <>
          <button type="button" className="disclose" aria-expanded={earlier} aria-controls={`${uid}-e`} onClick={() => setEarlier((v) => !v)}>
            Earlier · {num(list.length - 1)}
          </button>
          {earlier && (
            <ul className="ch-pushes" id={`${uid}-e`}>
              {list.slice(1).map((p) => <Push key={p.id} p={p} running={pushes.data.running} online={online} onChanged={refresh} />)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
