// GoogleConnect: the one way a feature (Gmail, Drive, Calendar) asks a
// person to connect their Google account for its purpose. It reads
// GET /api/google, so it knows whether Google is set up here, whether this
// person may use the purpose, and how their connection stands.
//
//   <GoogleConnect purpose="gmail.send" label="Connect Gmail" />
//     purpose  the key the feature gave definePurpose (server)
//     label    the button's words (default "Connect Google")
//     back     where Google's return lands (default: this screen)
//
// Never a primary button: the screen it sits on decides its one primary.
// Also here, for GoogleCard: useGoogle(), DisconnectButton, and
// GoogleNote (what ?google=<code> says, once).
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { adminHref, appMode } from '../mode.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';
import { GOOD, INSTALLED, appName, clockTime, googleHere, googleStart, googleWords, herePath } from './google.js';
import './google.css';

export const useGoogle = () => useQuery({ queryKey: ['google'], queryFn: () => apiGet('/google') });

// "Loading…", or "Unavailable — Try again": never a missing block.
export function GoogleLoading({ q }) {
  if (q.isError) {
    return (
      <p className="gg-line-main">Unavailable — <button type="button" className="btn-link" onClick={() => q.refetch()}>Try again</button></p>
    );
  }
  return <p className="gg-line-main muted">Loading…</p>;
}

// A link that starts a Google flow, or the same words disabled with no signal.
export function StartLink({ href, online, children, className = 'btn btn-quiet gg-link' }) {
  if (!online) return <button type="button" className={className.replace('gg-link', '')} disabled>{children}</button>;
  return <a className={className} href={href}>{children}</a>;
}

const DISCONNECTED = {
  shared: 'base.win stopped using it. Google still lists base.win until you disconnect everything.',
  gone: 'Disconnected. Google no longer lets base.win in.',
  noJobs: 'Disconnected here. Remove base.win in your Google Account too — this server can’t tell Google right now.',
};

// "Disconnect", then in place "Stop using Google for <label>? Disconnect · Cancel".
export function DisconnectButton({ purpose, label, online, onDone }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await action('google.disconnect', { purpose });
      setAsking(false);
      onDone?.(r.still_at_google ? DISCONNECTED.shared : r.jobs === false ? DISCONNECTED.noJobs : DISCONNECTED.gone);
      await qc.invalidateQueries({ queryKey: ['google'] });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (!asking) {
    return (
      <>
        <button type="button" className="btn btn-quiet" disabled={!online || busy} onClick={() => setAsking(true)}>Disconnect<span className="gg-sr"> {label}</span></button>
        {error && <p className="error" role="alert">{error}</p>}
      </>
    );
  }
  return (
    <div className="gg-confirm" role="group" aria-label={`Disconnect ${label}`}>
      <span>Stop using Google for {label}?</span>
      <button type="button" className="btn gg-danger" disabled={busy || !online} onClick={go}>{busy ? 'Disconnecting…' : 'Disconnect'}</button>
      <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// What Google's return said (?google=<code>), once: the address loses it
// so a reload doesn't repeat it.
export function useGoogleReturn() {
  const [code] = useState(() => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('google')));
  useEffect(() => {
    if (!code) return;
    const u = new URL(window.location.href);
    u.searchParams.delete('google');
    window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
  }, [code]);
  return code;
}

export function GoogleNote({ code, data, note }) {
  if (note) return <p className="gg-note is-ok" role="status">{note}</p>;
  if (!code) return null;
  const words = googleWords(code, {
    where: 'profile', domain: data?.rules?.domain, address: data?.at?.address, email: data?.me?.grant?.email,
  });
  return <p className={`gg-note ${GOOD.includes(code) ? 'is-ok' : 'is-bad'}`} role="status">{words}</p>;
}

// Wrong address / installed app: one line instead of any Google button.
export const googleBlocked = (data) => {
  if (!googleHere()) return INSTALLED;
  if (data?.at && data.at.right === false) return googleWords('wrong-address', { address: data.at.address });
  return null;
};

export default function GoogleConnect({ purpose, label = 'Connect Google', back }) {
  const q = useGoogle();
  const online = useOnline();
  // Google's return lands back on this screen (back=), so this screen says
  // what happened — "Connected", or why not — once, as Your profile does.
  const code = useGoogleReturn();
  const [note, setNote] = useState(null);
  if (!q.data) return <div className="gg-connect"><GoogleLoading q={q} /></div>;
  const d = q.data;
  const said = <GoogleNote code={note ? null : code} data={d} note={note} />;
  if (!d.setup.connect) {
    return (
      <div className="gg-connect">
        {said}
        <p className="muted">Google isn’t set up for this campaign. A manager can set it up in Settings → Services.
          {d.setup.why && <> <a href={adminHref('/settings/services')}>Open Services</a></>}</p>
      </div>
    );
  }
  const p = d.purposes.find((x) => x.key === purpose);
  // Not this person's to connect: nothing, unless Google's return has
  // something to say about it ("You can't connect this.").
  if (!p) return code ? <div className="gg-connect">{said}</div> : null;
  const app = appName(appMode());
  const href = googleStart('connect', { app, purpose, back: back || herePath() });
  const blocked = googleBlocked(d);
  const grant = d.me.grant;
  const paused = grant?.pausedUntil && new Date(grant.pausedUntil) > new Date() ? grant.pausedUntil : null;
  let body;
  if (p.mine && grant?.state === 'reconnect') {
    body = (
      <>
        <p><span className="chip chip-warn">Needs reconnecting</span> {grant.said}</p>
        {blocked ? <p className="muted">{blocked}</p> : <div className="gg-acts"><StartLink href={href} online={online}>Reconnect</StartLink></div>}
      </>
    );
  } else if (p.mine && (p.state === 'not-allowed' || p.state === 'domain')) {
    body = (
      <>
        <p className="muted">{p.said}</p>
        <div className="gg-acts"><DisconnectButton purpose={purpose} label={p.label} online={online} onDone={setNote} /></div>
      </>
    );
  } else if (p.mine) {
    body = (
      <>
        <div className="gg-acts">
          <span>Connected as <strong>{grant?.email}</strong></span>
          <DisconnectButton purpose={purpose} label={p.label} online={online} onDone={setNote} />
        </div>
        {paused && <p className="muted">Google asked base.win to wait — try again after {clockTime(paused)}</p>}
      </>
    );
  } else {
    body = blocked ? <p className="muted">{blocked}</p> : <div className="gg-acts"><StartLink href={href} online={online}>{label}</StartLink></div>;
  }
  return (
    <div className="gg-connect">
      {said}
      {body}
      {!online && <NeedsSignalLine>Google needs signal</NeedsSignalLine>}
    </div>
  );
}
