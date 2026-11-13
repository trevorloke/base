// Settings → Services → Google Drive and Sheets (managers; decision 17).
// One job: decide what the desk may do with Drive. Three settings, each
// saved in place with the server's sentence on a refusal:
//   Let the desk use Google Drive          drive.settings { on }
//   Who can send to Google Sheets          drive.settings { sheets } — No one first
//   New Sheets go to                       drive.folder { file_id | null }
// One helper line, by state. Under More: "Try opening Google Drive" (the
// Picker key can only be checked from the website) and going back to each
// person's own Drive. The row's state, missing settings and Check are
// Services' own; with Drive not set up this draws nothing.
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { GoogleLoading } from './GoogleConnect.jsx';
import { DriveConnect, DriveToast, num, useDrive, useDriveToast, usePickFromDrive } from './DriveBits.jsx';
import './google.css';

const WHO = [['off', 'No one'], ['managers', 'Managers'], ['desk', 'Anyone at the desk']];

export default function DrivePanel({ online }) {
  const d = useDrive();
  const qc = useQueryClient();
  const moreId = useId();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(null); // which setting is saving
  const [error, setError] = useState({});
  const [tried, setTried] = useState(null);
  const on = Boolean(d.data?.setup && d.data?.on);
  const picker = usePickFromDrive(on);
  const toast = useDriveToast();
  if (d.data && !d.data.setup) return null;
  if (!d.data) return <div className="drv-panel-s"><GoogleLoading q={d} /></div>;
  const s = d.data;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['drive'] }), qc.invalidateQueries({ queryKey: ['integrations'] })]);
  const save = async (which, name, input) => {
    setBusy(which); setError((e) => ({ ...e, [which]: null }));
    try { await action(name, input); await refresh(); } catch (err) { setError((e) => ({ ...e, [which]: err.message })); } finally { setBusy(null); }
  };
  const change = async () => {
    setError((e) => ({ ...e, folder: null }));
    const docs = await picker.pick('folder');
    if (docs?.length) await save('folder', 'drive.folder', { file_id: docs[0].id });
  };
  const tryOpen = async () => {
    setTried(null);
    const docs = await picker.pick('table');
    setTried(docs === null ? null : '✓ Google Drive opens');
  };
  const folder = s.land?.kind === 'campaign' ? s.land : null;
  const help = !s.domain ? 'Any Google Workspace account can connect. Set your domain under Google sign-in to allow only yours.'
    : !folder ? 'Sheets stay in their Drive when they leave. A shared drive keeps them.' : null;
  return (
    <div className="gg-panel drv-panel-s">
      <div>
        <button type="button" role="switch" className="gg-switch" aria-checked={s.on} disabled={Boolean(busy) || !online}
          onClick={() => save('on', 'drive.settings', { on: !s.on })}>
          <span className="gg-switch__track" aria-hidden="true"><span className="gg-switch__dot" /></span>
          <span>Let the desk use Google Drive</span>
          <span className="gg-switch__state" aria-hidden="true">{s.on ? 'On' : 'Off'}</span>
        </button>
        <p className="gg-hint">{num(s.connected)} {s.connected === 1 ? 'person' : 'people'} connected</p>
        {error.on && <p className="error" role="alert">{error.on}</p>}
      </div>
      {s.on && (
        <>
          <div>
            <h3 id="drv-who">Who can send to Google Sheets</h3>
            <div className="drv-chips" role="radiogroup" aria-labelledby="drv-who">
              {WHO.map(([v, label]) => {
                const needs = v === 'desk' && !folder?.shared;
                return (
                  <button key={v} type="button" role="radio" aria-checked={s.sheets === v} className={`chip drv-chip${s.sheets === v ? ' is-on' : ''}`}
                    disabled={Boolean(busy) || !online || needs} onClick={() => s.sheets !== v && save('sheets', 'drive.settings', { sheets: v })}>
                    {label}{needs && <span className="muted"> · Needs a shared-drive folder</span>}
                  </button>
                );
              })}
            </div>
            {s.sheets === 'off' && <p className="gg-hint">Lists and tables stay in base.win until you choose.</p>}
            {error.sheets && <p className="error" role="alert">{error.sheets}</p>}
          </div>
          <div>
            <h3>New Sheets go to</h3>
            <div className="gg-acts">
              <span>{folder ? `${folder.name}${folder.shared ? ' · shared drive' : ''}` : 'Each person’s own Drive (base.win exports)'}</span>
              {picker.need === 'connect' ? <DriveConnect /> : (
                <button type="button" className="btn btn-quiet" disabled={Boolean(busy) || !online} onClick={change}>
                  {busy === 'folder' ? 'Saving…' : 'Change'}<span className="gg-sr"> where new Sheets go</span>
                </button>
              )}
            </div>
            {error.folder && <p className="error" role="alert">{error.folder}</p>}
          </div>
        </>
      )}
      {help && <p className="gg-hint">{help}</p>}
      <DriveToast text={toast.text} />
      {picker.error && <p className="error" role="alert">{picker.error.replace('Google Drive didn’t open — Try again', 'Google Drive didn’t open — check the GOOGLE_PICKER_KEY websites')}</p>}
      {s.on && (
        <div>
          <button type="button" className="btn btn-quiet disclose" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((v) => !v)}>More</button>
          <div id={moreId} hidden={!more} className="drv-more">
            <div className="gg-acts">
              <button type="button" className="btn btn-quiet" disabled={!online} onClick={tryOpen}>Try opening Google Drive</button>
              {tried && <span className="drv-ok" role="status">{tried}</span>}
            </div>
            {folder && (
              <div className="gg-acts">
                <button type="button" className="btn btn-quiet" disabled={Boolean(busy) || !online} onClick={() => save('folder', 'drive.folder', { file_id: null })}>Use each person’s own Drive</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
