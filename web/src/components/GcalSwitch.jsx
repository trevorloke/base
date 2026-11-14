// Settings → Services → Google (managers): "Shifts in Google Calendar"
// on or off (gcal.settings; server/ext/gcal). Off by default: the owner
// adds the Calendar permission in Google Cloud first. Turning it off removes
// everyone's base.win calendar from their Google account, so it confirms in
// place — unless nobody is connected. GooglePanel draws it (PANEL_LINES).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet, ApiError } from '../api.js';
import { GoogleLoading } from './GoogleConnect.jsx';
import './gcal.css';

// Google Cloud → Google Auth Platform → Data access, where a project's
// permissions are added.
const CLOUD_SCOPES = 'https://console.cloud.google.com/auth/scopes';

const fmtN = (n) => Number(n || 0).toLocaleString('en-CA');
const said = (m) => { const t = String(m || ''); return t.charAt(0).toUpperCase() + t.slice(1); };

export default function GcalSwitch({ online }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gcal'], queryFn: () => apiGet('/gcal'), retry: false });
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  // An older server (404), or not a manager: nothing here.
  if (q.isError && q.error instanceof ApiError && q.error.status === 404) return null;
  if (q.data && !q.data.manager) return null;
  if (!q.data) return <div className="gc-switch"><h3>Shifts in Google Calendar</h3><GoogleLoading q={q} /></div>;
  const { on, people } = q.data.manager;
  const set = async (next) => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await action('gcal.settings', { on: next });
      setAsking(false);
      if (!next && r?.stopping) setNote(`Removing ${fmtN(r.stopping)} ${r.stopping === 1 ? 'calendar' : 'calendars'} from Google`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['gcal'] }), qc.invalidateQueries({ queryKey: ['connections'] })]);
    } catch (err) { setError(said(err.message)); } finally { setBusy(false); }
  };
  return (
    <div className="gc-switch">
      <div>
        <button type="button" role="switch" className="gg-switch" aria-checked={on} disabled={busy || !online || asking}
          aria-describedby="gc-switch-hint" onClick={() => (on && people > 0 ? setAsking(true) : set(!on))}>
          <span className="gg-switch__track" aria-hidden="true"><span className="gg-switch__dot" /></span>
          <span>Shifts in Google Calendar</span>
          <span className="gg-switch__state" aria-hidden="true">{on ? 'On' : 'Off'}</span>
        </button>
      </div>
      {/* The permission is added in the campaign's Google Cloud project
          (Google Auth Platform → Data access); GOING-LIVE §3 has the steps. */}
      <p className="gg-hint" id="gc-switch-hint">
        <a className="gc-hint-link" href={CLOUD_SCOPES} target="_blank" rel="noopener noreferrer">Add the Calendar permission in Google Cloud</a> first (Going live §3).
      </p>
      {on && <p className="gc-people">{fmtN(people)} {people === 1 ? 'person' : 'people'} connected</p>}
      {asking && (
        <div className="gg-confirm" role="group" aria-label="Turn off Shifts in Google Calendar">
          <span>Turn off? Everyone’s base.win calendar is removed from their Google Calendar.</span>
          <div className="gc-acts">
            <button type="button" className="btn gg-danger" disabled={busy || !online} onClick={() => set(false)}>{busy ? 'Turning off…' : 'Turn off'}</button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </div>
      )}
      {note && <p className="gg-note is-ok" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
