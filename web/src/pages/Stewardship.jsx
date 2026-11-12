// Stewardship (/money/stewardship — the desk that handles donations): every
// gift thanked, and soon; donors who gave before and not this year; a next
// step for the ones who matter (ext/stewardship).
//   To thank      each gift no one has thanked, oldest first, with how many
//                 days it has waited — Called · Emailed · Note · Letter
//                 marks it.
//   Next steps    one per donor, with a date; the due ones first; Done.
//   Lapsed        gave in an earlier year and not this one.
//   Top donors    this year's biggest, and when they were last thanked.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet, fmtMoney } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import './shifts.css';
import './stewardship.css';
import { noCalls, noCallsWord } from '@starbase/shared/canvass';

const HOWS = [['call', 'Called'], ['email', 'Emailed'], ['note', 'Note'], ['letter', 'Letter']];
const fmtDay = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const waited = (days) => (days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`);

function StepForm({ personId, current, onDone }) {
  const [step, setStep] = useState(current?.step || '');
  const [due, setDue] = useState(current?.due_on || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await action('donor.step', { person_id: personId, step: step.trim() || null, due_on: due || null }); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <form className="sw-step-form" onSubmit={save}>
      <input className="input" aria-label="Next step" autoFocus maxLength={300} placeholder="Coffee after the debate" value={step} onChange={(e) => setStep(e.target.value)} />
      <input className="input mono" type="date" aria-label="By when" value={due} onChange={(e) => setDue(e.target.value)} />
      <button type="submit" className="btn ops-tap" disabled={busy || !step.trim()}>Save</button>
      <button type="button" className="btn btn-quiet ops-tap" onClick={onDone}>Cancel</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function Donor({ id, name }) {
  return <Link className="sw-name" to={`/people/${id}`}>{name}</Link>;
}

export default function Stewardship() {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: ['stewardship'], queryFn: () => apiGet('/stewardship') });
  const [busy, setBusy] = useState(null);
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const [stepFor, setStepFor] = useState(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['stewardship'] });

  const thank = async (g, how, label) => {
    setBusy(g.gift_id); setError(null);
    try {
      await action('gift.thank', { gift_id: g.gift_id, how });
      setSaid(`✓ ${g.name} — ${label.toLowerCase()}`);
      refresh();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const doneStep = async (s) => {
    setBusy(s.person_id);
    try { await action('donor.step', { person_id: s.person_id, step: null }); refresh(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const head = (
    <>
      <Link to="/money" className="ops-back">← Donations</Link>
      <h1>Stewardship</h1>
    </>
  );
  if (!q.data) return <div className="ops-page sw-page">{head}{noSignal(q) ? <NoSignal /> : q.isError ? <p className="error">{q.error.message}</p> : <p className="muted">Loading…</p>}</div>;
  const d = q.data;
  const stepOf = Object.fromEntries(d.steps.map((s) => [s.person_id, s]));
  const stepButton = (personId) => (stepFor === personId
    ? <StepForm personId={personId} current={stepOf[personId]} onDone={() => { setStepFor(null); refresh(); }} />
    : <button type="button" className="btn btn-quiet ops-tap" disabled={!online} onClick={() => setStepFor(personId)}>{stepOf[personId] ? 'Change next step' : 'Next step…'}</button>);

  return (
    <div className="ops-page sw-page">
      {head}
      <p className="sw-sum">
        <strong className="mono">{d.counts.to_thank}</strong> to thank{d.counts.overdue > 0 && <> · <strong className="mono sw-warn">{d.counts.overdue}</strong> waiting more than two days</>}
        {' · '}<strong className="mono">{d.counts.due}</strong> next steps due · <strong className="mono">{d.counts.lapsed}</strong> lapsed
      </p>
      {said && <p className="ops-done" role="status">{said}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <section className="sw-sec" aria-labelledby="sw-thank">
        <div className="sw-sec__head">
          <h2 id="sw-thank">To thank</h2>
        </div>
        {d.to_thank.length === 0 ? <p className="ops-empty">Everyone has been thanked.</p> : (
          <ul className="sw-list">
            {d.to_thank.map((g) => (
              <li key={g.gift_id} className="card sw-row">
                <div className="sw-row__main">
                  <Donor id={g.person_id} name={g.name} />
                  <span className="mono">{fmtMoney(g.amount_cents)}</span>
                  <span className="muted">{fmtDay(g.date)} · <span className={g.days > 2 ? 'sw-warn' : ''}>waiting {waited(g.days)}</span></span>
                  <span className="muted sw-reach">
                    {g.phone && (noCalls(g) ? <span>{g.phone} · {noCallsWord(g)}</span> : <a href={`tel:${g.phone}`}>{g.phone}</a>)}
                    {g.email && <a href={`mailto:${g.email}`}>{g.email}</a>}
                    {!g.has_address && <span>no mailing address</span>}
                  </span>
                </div>
                <div className="sw-acts" role="group" aria-label={`Thank ${g.name}`}>
                  {HOWS.map(([how, label]) => (
                    <button key={how} type="button" className="btn ops-tap" disabled={busy === g.gift_id || !online} onClick={() => thank(g, how, label)}>{label}</button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sw-sec" aria-labelledby="sw-steps">
        <h2 id="sw-steps">Next steps</h2>
        {d.steps.length === 0 ? <p className="ops-empty">None yet — add one from a donor below.</p> : (
          <ul className="sw-list">
            {d.steps.map((s) => (
              <li key={s.person_id} className="card sw-row">
                <div className="sw-row__main">
                  <Donor id={s.person_id} name={s.name} />
                  <span>{s.step}</span>
                  {s.due_on && <span className={s.due ? 'sw-warn' : 'muted'}>{s.due ? 'due ' : 'by '}{fmtDay(s.due_on)}</span>}
                </div>
                <div className="sw-acts">
                  <button type="button" className="btn ops-tap" disabled={busy === s.person_id || !online} onClick={() => doneStep(s)}>Done</button>
                  {stepButton(s.person_id)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sw-sec" aria-labelledby="sw-lapsed">
        <h2 id="sw-lapsed">Lapsed</h2>
        <p className="ops-meta">Gave in an earlier year, not yet this one.</p>
        {d.lapsed.length === 0 ? <p className="ops-empty">No one.</p> : (
          <ul className="sw-list">
            {d.lapsed.map((p) => (
              <li key={p.person_id} className="card sw-row">
                <div className="sw-row__main">
                  <Donor id={p.person_id} name={p.name} />
                  <span className="muted">last gave {fmtDay(p.last_date)}{p.last_year_cents > 0 && <> · <span className="mono">{fmtMoney(p.last_year_cents)}</span> last year</>} · <span className="mono">{fmtMoney(p.ever_cents)}</span> in all</span>
                  <span className="muted sw-reach">{p.phone && (noCalls(p) ? <span>{p.phone} · {noCallsWord(p)}</span> : <a href={`tel:${p.phone}`}>{p.phone}</a>)}{p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}</span>
                </div>
                <div className="sw-acts">{stepButton(p.person_id)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sw-sec" aria-labelledby="sw-top">
        <h2 id="sw-top">Top donors this year</h2>
        {d.top.length === 0 ? <p className="ops-empty">No gifts yet this year.</p> : (
          <ul className="sw-list">
            {d.top.map((p) => (
              <li key={p.person_id} className="card sw-row">
                <div className="sw-row__main">
                  <Donor id={p.person_id} name={p.name} />
                  <span className="mono">{fmtMoney(p.year_cents)}</span>
                  <span className="muted">{p.gifts} {p.gifts === 1 ? 'gift' : 'gifts'} · {p.last_thanked ? `thanked ${fmtDay(p.last_thanked)}` : 'not thanked yet'}{p.step && ` · next: ${p.step}`}</span>
                </div>
                <div className="sw-acts">{stepButton(p.person_id)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
