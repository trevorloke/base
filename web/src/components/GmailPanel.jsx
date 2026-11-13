// Settings → Services → Gmail (send as yourself), managers: how Google is set
// up for base.win (only words — base.win can't read it from Google), the
// campaign's switch, GSI's domain rule read-only, and who has connected.
// No Check: each person's "Send me a test" proves sending (ext/gmail).
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { useGmail } from './EmailSheet.jsx';
import './google.css';
import './gmail.css';

const REVIEWS = [
  { key: 'internal', label: 'Workspace only (Internal)', hint: (domain) => (domain ? `Only @${domain} Google accounts can connect. No Google review.` : 'Only your Workspace’s Google accounts can connect. No Google review.') },
  { key: 'unreviewed', label: 'Not reviewed by Google yet', hint: () => 'Google hasn’t reviewed base.win: staff will see a warning, and no more than 100 people can ever connect.' },
  { key: 'reviewed', label: 'Reviewed by Google', hint: () => 'Anyone on the desk can connect.' },
];

export default function GmailPanel({ online }) {
  const qc = useQueryClient();
  const q = useGmail();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [more, setMore] = useState(false);
  if (q.error?.status === 403) return null;
  if (!q.data) {
    return q.isError
      ? <p className="gm-pline">Unavailable — <button type="button" className="btn btn-quiet" onClick={() => q.refetch()}>Try again</button></p>
      : <p className="gm-pline muted">Loading…</p>;
  }
  const d = q.data;
  if (!d.setup) return <p className="gm-pline">Set up Google first — the Google row above.</p>;
  const save = async (input) => {
    setBusy(true); setError(null);
    try {
      await action('gmail.settings', input);
      await Promise.all([qc.invalidateQueries({ queryKey: ['gmail'] }), qc.invalidateQueries({ queryKey: ['connections'] })]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const people = d.people || [];
  return (
    <div className="gg-panel gm-panel">
      <div role="group" aria-labelledby={`${id}-rh`}>
        <h3 id={`${id}-rh`}>How is Google set up for base.win?</h3>
        <ul className="gm-reviews">
          {REVIEWS.map((r) => (
            <li key={r.key}>
              <button type="button" className="chip gm-review" aria-pressed={d.review === r.key} disabled={busy || !online}
                aria-describedby={`${id}-${r.key}`} onClick={() => save({ review: r.key })}>{r.label}</button>
              <p className="gg-hint" id={`${id}-${r.key}`}>{r.hint(d.domain)}</p>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <button type="button" role="switch" className="gg-switch" aria-checked={d.on} disabled={busy || !online}
          onClick={() => save({ on: !d.on })}>
          <span className="gg-switch__track" aria-hidden="true"><span className="gg-switch__dot" /></span>
          <span>Let the desk send from their own Gmail</span>
          <span className="gg-switch__state" aria-hidden="true">{d.on ? 'On' : 'Off'}</span>
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <p className="gg-hint">
        {d.domain
          ? `Only Google accounts at ${d.domain} — change it under Google`
          : 'Any Google account can connect. Personal Gmail has lower sending limits and can’t be managed by the campaign.'}
      </p>
      <div>
        <p className="gm-pline"><strong>{people.length.toLocaleString('en-CA')}</strong> connected</p>
        {people.length > 0 && (
          <>
            <button type="button" className="disclose" aria-expanded={more} aria-controls={`${id}-more`} onClick={() => setMore((v) => !v)}>More</button>
            <ul id={`${id}-more`} className="gm-people" hidden={!more}>
              {people.map((p) => <li key={`${p.name}-${p.email}`}>{p.name} · <span className="muted">{p.email}</span></li>)}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
