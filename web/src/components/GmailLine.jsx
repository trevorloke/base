// Your profile → Google → Gmail (ext/gmail): drawn by GSI's GoogleCard,
// only when GET /api/gmail answers with Google set up and Gmail on here.
// A 403 (a volunteer, or staff denied Outreach) draws nothing.
//
//   <GmailLine purpose="gmail.send" />  under the "Send from your Gmail"
//       row once connected: how many sent today, and "Send me a test";
//       paused: until when. Needs reconnecting: GSI's card says it.
//   <GmailLine />  in the card otherwise: what it's for, and Connect Gmail
//       (GSI's start link: never a primary — Profile's is Two-step's).
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { appMode } from '../mode.js';
import { useOnline } from './NoSignal.jsx';
import { StartLink, googleBlocked, useGoogle } from './GoogleConnect.jsx';
import { appName, googleStart, herePath } from './google.js';
import { pauseClock, useGmail } from './EmailSheet.jsx';
import './gmail.css';

function SendTest({ online }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const go = async () => {
    setBusy(true); setSaid(null);
    try {
      const r = await action('gmail.test', {});
      setSaid(r.status === 'sent' ? { ok: true, text: 'Test sent — check your inbox' } : { ok: false, text: r.said || 'Gmail didn’t send it' });
    } catch (e) {
      setSaid({ ok: false, text: e.message });
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['gmail'] });
    }
  };
  return (
    <>
      <button type="button" className="btn btn-quiet" disabled={busy || !online} onClick={go}>{busy ? 'Sending…' : 'Send me a test'}</button>
      <p className={`gm-test-said${said?.ok ? ' is-ok' : ''}`} role="status">{said?.text || ''}</p>
    </>
  );
}

export default function GmailLine({ purpose }) {
  const qc = useQueryClient();
  const q = useGmail();
  const g = useGoogle();
  const online = useOnline();
  // GSI's card changed the connection (Disconnect, Reconnect): read Gmail's side again.
  const seen = useRef(g.dataUpdatedAt);
  useEffect(() => {
    if (seen.current !== g.dataUpdatedAt) { seen.current = g.dataUpdatedAt; qc.invalidateQueries({ queryKey: ['gmail'] }); }
  }, [g.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.error?.status === 403) return null;
  const d = q.data;
  if (!d) {
    // Once, outside the row: "Loading…" or "Unavailable — Try again".
    if (purpose) return null;
    return q.isError ? (
      <p className="gm-pline">Gmail: Unavailable — <button type="button" className="btn btn-quiet" onClick={() => q.refetch()}>Try again</button></p>
    ) : <p className="gm-pline muted">Gmail: Loading…</p>;
  }
  if (!d.setup || !d.on) return null;
  const me = d.me;

  if (purpose) {
    if (!me.connected || me.trouble === 'reconnect') return null;
    if (me.trouble === 'paused') return <p className="gm-pline">Gmail asked us to wait until {pauseClock(me)}.</p>;
    return (
      <div className="gm-count">
        <p className="gm-count__n"><strong>{me.sentToday.toLocaleString('en-CA')}</strong> sent today <span className="muted">of {d.dailyMax.toLocaleString('en-CA')}</span></p>
        <SendTest online={online} />
      </div>
    );
  }

  if (me.connected) return null;
  const blocked = googleBlocked(g.data);
  const href = googleStart('connect', { app: appName(appMode()), purpose: 'gmail.send', back: herePath() });
  return (
    <div className="gm-connect">
      <p className="gg-line-main">Send email from your own Gmail, from a person’s page.</p>
      {d.review === 'unreviewed' && <p className="gm-hint">Google will warn that it hasn’t reviewed base.win. That’s expected here — continue past it.</p>}
      {blocked ? <p className="muted">{blocked}</p> : <div className="gg-acts"><StartLink href={href} online={online}>Connect Gmail</StartLink></div>}
    </div>
  );
}
