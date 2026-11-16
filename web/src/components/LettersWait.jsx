// Settings → Campaign (managers), under Media: how long a writer waits for a
// paper that wants a letter only for itself before Send it offers another
// (settings.letters.wait_days, 3–60, 10 by default; letter.settings).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';

export default function LettersWait({ me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const current = Number(me?.workspace?.settings?.letters?.wait_days) || 10;
  const [days, setDays] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const n = Number(days);
  const ok = Number.isInteger(n) && n >= 3 && n <= 60;
  const save = async (e) => {
    e.preventDefault();
    if (!ok || n === current) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await action('letter.settings', { wait_days: n });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <>
      <h2 className="ot-sec-h">Media</h2>
      <form className="ot-invite" onSubmit={save}>
        <label htmlFor="lt-wait">Wait before another paper (days)</label>
        <input id="lt-wait" className="input" type="number" inputMode="numeric" min={3} max={60} value={days}
          onChange={(e) => { setDays(e.target.value); setSaved(false); }} style={{ maxWidth: '8rem' }} />
        <button type="submit" className="btn ot-btn-tap" disabled={busy || !online || !ok || n === current}>Save</button>
      </form>
      <p className="muted">A letter sent to a paper that wants it only for itself waits this long before it can go to another.</p>
      {!ok && <p className="error" role="alert">Between 3 and 60 days</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {saved && <p className="muted" role="status">✓ Saved — {current} days.</p>}
    </>
  );
}
