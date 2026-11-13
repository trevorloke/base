// Settings → Services → Google (managers): the redirect address to paste
// into Google Cloud, the campaign's Google sign-in rules (on or off; only
// accounts at one Workspace domain), and, under More, disconnecting every
// Google account. The row's state and Check come from Services itself.
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { GoogleLoading, useGoogle } from './GoogleConnect.jsx';
import './google.css';

// One line another Google feature adds here (GCA's GcalSwitch): a
// component taking { online }.
export const PANEL_LINES = [];

function Copy({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
  };
  return <button type="button" className="btn btn-quiet" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}<span className="gg-sr"> the redirect address</span></button>;
}

function Domain({ rules, online, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(rules.domain || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async (domain) => {
    setBusy(true); setError(null);
    try {
      await action('google.settings', { domain });
      setEditing(false);
      await onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div>
      <h3 id="gg-domain-h">Only Google accounts at</h3>
      {!editing ? (
        <div className="gg-acts">
          <span>{rules.domain || 'Any Google account'}</span>
          <button type="button" className="btn btn-quiet" disabled={!online} onClick={() => { setValue(rules.domain || ''); setEditing(true); setError(null); }}>Change<span className="gg-sr"> the Google domain</span></button>
        </div>
      ) : (
        <form className="gg-domain-form" onSubmit={(e) => { e.preventDefault(); save(value.trim() || null); }}>
          <div className="field">
            <label htmlFor="gg-domain">Domain</label>
            <input id="gg-domain" className="input" value={value} placeholder="example.org" maxLength={253} autoCapitalize="none" spellCheck={false}
              onChange={(e) => setValue(e.target.value)} aria-describedby="gg-domain-hint" />
          </div>
          <button type="submit" className="btn btn-quiet" disabled={busy || !online}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
          {rules.domain && <button type="button" className="btn btn-quiet" disabled={busy || !online} onClick={() => save(null)}>Any Google account</button>}
        </form>
      )}
      <p className="gg-hint" id="gg-domain-hint">Applies to signing in with Google. Others still sign in with their password.</p>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Forget({ online }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await action('google.forget', {});
      setAsking(false);
      setSaid(`Disconnected ${Number(r.disconnected || 0).toLocaleString('en-CA')} ${r.disconnected === 1 ? 'account' : 'accounts'}`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['google'] }), qc.invalidateQueries({ queryKey: ['connections'] })]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div>
      {asking ? (
        <div className="gg-confirm" role="group" aria-label="Disconnect every Google account">
          <span>Disconnect every Google account for this campaign? People will have to connect again.</span>
          <button type="button" className="btn gg-danger" disabled={busy || !online} onClick={go}>{busy ? 'Disconnecting…' : 'Disconnect all'}</button>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="btn btn-quiet gg-danger" disabled={!online} onClick={() => { setAsking(true); setSaid(null); }}>Disconnect every Google account</button>
      )}
      {said && <p className="gg-note is-ok" role="status">{said}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export default function GooglePanel({ s, online }) {
  const qc = useQueryClient();
  const q = useGoogle();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const moreId = useId();
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['google'] }), qc.invalidateQueries({ queryKey: ['auth-setup'] }), qc.invalidateQueries({ queryKey: ['me'] }),
  ]);
  const lines = (s.lines || []).filter((l) => !s.redirect || !l.includes(s.redirect));
  const setSignin = async (on) => {
    setBusy(true); setError(null);
    try { await action('google.settings', { signin: on }); await refresh(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="gg-panel">
      {lines.length > 0 && <ul className="gg-lines">{lines.map((l) => <li key={l}>{l}</li>)}</ul>}
      {s.redirect && (
        <div>
          <h3>Redirect address</h3>
          <div className="gg-acts"><code className="gg-url">{s.redirect}</code><Copy value={s.redirect} /></div>
          <p className="gg-hint">Paste into Google Cloud → Clients → Authorized redirect URIs. Change it there before changing this server’s public address.</p>
        </div>
      )}
      {s.state !== 'missing' && (!q.data ? <GoogleLoading q={q} /> : (
        <>
          <div>
            <button type="button" role="switch" className="gg-switch" aria-checked={q.data.rules.signin} disabled={busy || !online}
              aria-describedby="gg-signin-hint" onClick={() => setSignin(!q.data.rules.signin)}>
              <span className="gg-switch__track" aria-hidden="true"><span className="gg-switch__dot" /></span>
              <span>Team can sign in with Google</span>
            </button>
            <p className="gg-hint" id="gg-signin-hint">Everyone keeps their password.</p>
            {error && <p className="error" role="alert">{error}</p>}
          </div>
          <Domain key={q.data.rules.domain || ''} rules={q.data.rules} online={online} onSaved={refresh} />
          {PANEL_LINES.map((Line, i) => <Line key={i} online={online} />)}
          <div>
            <button type="button" className="disclose" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((v) => !v)}>More</button>
            <div id={moreId} hidden={!more}><Forget online={online} /></div>
          </div>
        </>
      ))}
    </div>
  );
}
