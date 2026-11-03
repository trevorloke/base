// Settings → Services (managers): every outside service Starbase uses, what
// it's for, whether it's set up, and "Check" — one real call to the service
// (GET /api/connections, POST /api/connections/check — ext/connections).
// Keys live in the hosting's settings (Render → the service → Environment),
// never here: a missing one is named, with where it goes. The long version
// is INTEGRATIONS.md.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api.js';
import { NoSignal, noSignal, useOnline } from './NoSignal.jsx';
import './services.css';

const STATE_WORD = { ready: 'Set up', missing: 'Not set up', default: 'Using the free default' };

function Row({ s, online }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const check = async () => {
    setBusy(true);
    setRes(null);
    try { setRes(await apiPost('/connections/check', { key: s.key })); } catch (e) { setRes({ ok: false, said: e.message }); }
    setBusy(false);
  };
  return (
    <li className="sv2-row" data-state={s.state}>
      <div className="sv2-row__main">
        <div className="sv2-row__head">
          <span className="sv2-name">{s.name}</span>
          <span className={`chip sv2-state sv2-state--${s.state}`}>{STATE_WORD[s.state]}{s.launch && s.state === 'missing' ? ' · needed to launch' : ''}</span>
        </div>
        <p className="sv2-for">{s.for}</p>
        {s.detail && <p className="sv2-detail">{s.detail}</p>}
        {s.missing.length > 0 && (
          <p className="sv2-missing">Set in the hosting’s environment: {s.missing.map((k) => <code key={k}>{k}</code>).reduce((a, b) => [a, ' · ', b])}</p>
        )}
        {res && <p className={`sv2-said ${res.ok ? 'is-ok' : 'is-bad'}`} role="status">{res.ok ? '✓ ' : '✕ '}{res.said}</p>}
      </div>
      {s.checkable && (
        <button type="button" className="btn ops-tap sv2-check" disabled={busy || !online} onClick={check}>{busy ? 'Checking…' : 'Check'}</button>
      )}
    </li>
  );
}

export default function Services() {
  const online = useOnline();
  const q = useQuery({ queryKey: ['connections'], queryFn: () => apiGet('/connections') });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError) return noSignal(q.error) ? <NoSignal /> : <p className="error">{q.error.message}</p>;
  const { services, inbound } = q.data;
  const needed = services.filter((s) => s.launch && s.state === 'missing');
  return (
    <div className="sv2">
      <p className="sv2-lead">
        {needed.length
          ? `${needed.length} to set up before launch: ${needed.map((s) => s.name.replace(/ \(.*\)$/, '')).join(', ')}.`
          : 'Everything needed to launch is set up. Check each one to be sure it answers.'}
        {' '}Keys go in the hosting’s settings (Render → the service → Environment), never here.
      </p>
      <ul className="sv2-list">
        {services.map((s) => <Row key={s.key} s={s} online={online} />)}
      </ul>
      <h2 className="sv2-h">Coming in</h2>
      <ul className="sv2-list sv2-in">
        {inbound.map((i) => (
          <li key={i.name} className="sv2-row">
            <div className="sv2-row__main">
              <span className="sv2-name">{i.name}</span>
              <p className="sv2-detail"><code className="sv2-url">{i.url}</code></p>
              <p className="sv2-for">{i.how}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
