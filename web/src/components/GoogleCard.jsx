// Your profile → Google: sign in with your Google account as well as your
// password (link, unlink), and the Google account base.win's features use
// for you (connected as …, one row per purpose, Disconnect, Reconnect).
// Not drawn when this server has neither Google sign-in nor connections.
// Every link goes to the server's start route and comes back here with
// ?google=<what happened>, said once.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { appMode } from '../mode.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';
import { appName, googleStart, herePath } from './google.js';
import {
  DisconnectButton, GoogleLoading, GoogleNote, StartLink, googleBlocked, useGoogle, useGoogleReturn,
} from './GoogleConnect.jsx';
import './google.css';

// One line a feature adds under its own purpose's row (GML's GmailLine
// under 'gmail.send'): a component taking { purpose }, drawing nothing
// unless it has something to say.
export const PURPOSE_LINES = {};

function Unlink({ online, onDone }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      await action('google.unlink', {});
      setAsking(false);
      onDone('Unlinked. Sign in with your password.');
      await Promise.all([qc.invalidateQueries({ queryKey: ['google'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <>
      {asking ? (
        <div className="gg-confirm" role="group" aria-label="Unlink Google">
          <span>Unlink Google? You’ll sign in with your password.</span>
          <button type="button" className="btn gg-danger" disabled={busy || !online} onClick={go}>{busy ? 'Unlinking…' : 'Unlink'}</button>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="btn btn-quiet" disabled={!online} onClick={() => setAsking(true)}>Unlink</button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

export default function GoogleCard() {
  const q = useGoogle();
  const online = useOnline();
  const code = useGoogleReturn();
  const [note, setNote] = useState(null);
  // Whether Google sign-in is on here, from the sign-in already loaded
  // (/auth/me): while /api/google loads, a server without Google draws
  // nothing rather than a "Loading…" card that then vanishes. A failed read
  // always draws the card ("Unavailable — Try again"): /auth/me knows only
  // sign-in, and connections may be on with sign-in off.
  const knownOn = useQueryClient().getQueryData(['me'])?.google?.on === true;
  const d = q.data;
  if (d && !d.setup.signin && !d.setup.connect) return null;
  const head = <div className="ts-head"><h2 className="ts-h">Google</h2></div>;
  if (!d) return (knownOn || q.isError) ? <section className="ts-card gg-card" aria-label="Google">{head}<GoogleLoading q={q} /></section> : null;

  const app = appName(appMode());
  const back = herePath();
  const blocked = googleBlocked(d);
  const login = d.me.login;
  const grant = d.me.grant;
  const shown = d.purposes.filter((p) => p.mine && !p.ownCard);
  const domain = d.rules.domain;
  const linkHref = googleStart('link', { app, back });
  const reconnectHref = grant?.purposes?.[0] ? googleStart('connect', { app, back, purpose: grant.purposes[0] }) : null;
  const say = (words) => setNote(words);

  return (
    <section className="ts-card gg-card" aria-label="Google">
      {head}
      <GoogleNote code={note ? null : code} data={d} note={note} />
      {d.setup.signin && (login ? (
        <>
          <p className="gg-line-main">Linked to <strong>{login.email}</strong></p>
          {domain && login.hd !== domain && <p><span className="chip chip-warn">Not at {domain} — sign in with your password</span></p>}
          <div className="gg-acts"><Unlink online={online} onDone={say} /></div>
        </>
      ) : !d.rules.signin ? (
        <p className="gg-line-main muted">Google sign-in is turned off for this campaign.</p>
      ) : (
        <>
          <p className="gg-line-main">Sign in with your Google account as well as your password.</p>
          {blocked ? <p className="muted">{blocked}</p> : (
            <div className="gg-acts"><StartLink href={linkHref} online={online}>Link Google account</StartLink></div>
          )}
        </>
      ))}
      {grant && (
        <>
          <h3 className="gg-h3">Connections</h3>
          <p className="gg-line-main">Connected as <strong>{grant.email}</strong></p>
          {grant.state === 'reconnect' && (
            <>
              <p><span className="chip chip-warn">Needs reconnecting</span> {grant.said}</p>
              {blocked ? <p className="muted">{blocked}</p> : reconnectHref && (
                <div className="gg-acts"><StartLink href={reconnectHref} online={online}>Reconnect</StartLink></div>
              )}
            </>
          )}
          {shown.length > 0 && (
            <ul className="gg-list">
              {shown.map((p) => {
                const Line = PURPOSE_LINES[p.key];
                return (
                  <li key={p.key} className="gg-item">
                    <span className="gg-item__name">{p.label}</span>
                    <DisconnectButton purpose={p.key} label={p.label} online={online} onDone={say} />
                    {(p.state === 'not-allowed' || p.state === 'domain') && p.said && <p className="gg-said">{p.said}</p>}
                    {Line && <Line purpose={p.key} />}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {!online && <NeedsSignalLine>Google needs signal</NeedsSignalLine>}
    </section>
  );
}
