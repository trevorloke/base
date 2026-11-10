// A service's "Connect" on Settings → Services (managers): the one step
// that changes something at the service — telling it where to send what
// comes back to base.win. Check, beside it, only ever reads.
// The row says which action it is (s.connect: { action, label }); the
// answer is { ok, said }, shown the way Check's is. onDone: it worked — the
// row drops what an earlier Check said, which is no longer true.
import { useState } from 'react';
import { action } from '../api.js';
import './service-connect.css';

export default function ServiceConnect({ connect, online, onDone }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const run = async () => {
    setBusy(true);
    setRes(null);
    try {
      const r = await action(connect.action, {});
      setRes(r);
      if (r.ok) onDone?.();
    } catch (e) { setRes({ ok: false, said: e.message }); }
    setBusy(false);
  };
  return (
    <div className="svc-connect">
      <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={run}>{busy ? 'Connecting…' : connect.label}</button>
      {res && <p className={`sv2-said ${res.ok ? 'is-ok' : 'is-bad'}`} role="status">{res.ok ? '✓ ' : '✕ '}{res.said}</p>}
    </div>
  );
}
