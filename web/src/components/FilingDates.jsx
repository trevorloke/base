// The financial agent's filing dates on Donations (server/ext/filingdates):
// two of them, each a name and a day the agent types in. No law, date or
// name comes with the product — what is due and when is the agent's to
// confirm and enter.
//   FilingCountdown   under the big number: each date, counted down ("66
//                     days left · Disclosure statement due · Jan 15, 2027"),
//                     from the brief Donations already reads (filingAll),
//                     each with its own "Add to calendar" until it's past
//   FilingDatesForm   Donations → More → Filing dates: the two names and
//                     days, one Save (filing.dates) — managers and treasurers
// Today shows the ones within 30 days under Coming up (pages/Today.jsx).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { countdown, filingDay, filingSoon } from './FilingWords.js';
import { useOnline } from './NoSignal.jsx';
import { dayEvent } from '@starbase/shared/ics';
import AddToCalendar from './AddToCalendar.jsx';
import './filing-dates.css';

export function FilingCountdown({ dates }) {
  if (!Array.isArray(dates) || !dates.length) return null;
  return (
    <ul className="fl-count" aria-label="Filing dates">
      {dates.map((d) => {
        const c = countdown(d.days);
        return (
          <li key={d.slot} className={`fl-count__item${d.days < 0 ? ' is-past' : filingSoon(d.days) ? ' is-soon' : ''}`}>
            <span className="fl-count__n">{c.n}{c.word && <span className="fl-count__word"> {c.word}</span>}</span>
            <span className="fl-count__what">
              <span className="fl-count__name">{d.name}</span>
              <span className="fl-count__day">{filingDay(d.due_on)}</span>
            </span>
            {/* Under the row on a phone, the card's whole width (not a column beside the number). */}
            {d.days >= 0 && (
              <div className="fl-count__cal">
                <AddToCalendar kind="filing" id={d.slot}
                  event={dayEvent({ uid: `filing-${d.slot}-${d.due_on}@base.win`, title: d.name, day: String(d.due_on).slice(0, 10) })} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const rowsOf = (dates) => [1, 2].map((slot) => {
  const d = (dates || []).find((x) => Number(x.slot) === slot);
  return { name: d?.name || '', due_on: d?.due_on || '' };
});

export function FilingDatesForm({ dates }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const [rows, setRows] = useState(() => rowsOf(dates));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const set = (i, k) => (e) => { setSaid(null); setError(null); setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x))); };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await action('filing.dates', {
        dates: rows.map((r) => (r.name.trim() || r.due_on ? { name: r.name.trim(), due_on: r.due_on || null } : null)),
      });
      setRows(rowsOf(res.dates));
      setSaid('✓ Saved');
      await queryClient.invalidateQueries({ queryKey: ['brief'] });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="fl-form" onSubmit={save} aria-label="Filing dates">
      <p className="ops-meta">The dates your financial agent must meet. Donations counts down to each.</p>
      {rows.map((r, i) => (
        <div className="form-row" key={i}>
          <div className="field fl-form__name">
            <label htmlFor={`fl-name-${i}`}>{i === 0 ? 'What’s due' : 'A second date (optional)'}</label>
            <input id={`fl-name-${i}`} className="input" maxLength={80} autoComplete="off"
              placeholder={i === 0 ? 'e.g. Disclosure statement due' : ''} value={r.name} onChange={set(i, 'name')} />
          </div>
          <div className="field fl-form__day">
            <label htmlFor={`fl-day-${i}`}>Date</label>
            <input id={`fl-day-${i}`} className="input mono" type="date" value={r.due_on} onChange={set(i, 'due_on')} />
          </div>
        </div>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn ops-solid ops-tap" disabled={busy || !online}>{busy ? 'Saving…' : 'Save dates'}</button>
        <span className="fl-form__said" role="status">{said || (!online ? 'Needs signal' : '')}</span>
      </div>
    </form>
  );
}
