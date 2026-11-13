// Your profile → "Your shifts in Google Calendar" (every role, both apps;
// server/ext/gcal). base.win makes one calendar of its own in the person's
// Google account and keeps their shifts in it within a minute of any change.
// It sits just before the calendar link card, so the one-step way comes
// first, and it is the only place to stop it (GSI's Google card draws no
// row for it).
//   Drawn when the person has a link (any state), or the campaign has it on;
//   for a manager with it off, one line saying where to turn it on.
//   Not connected        GoogleConnect "Connect Google Calendar"
//   Connected, no link   "Keep my shifts in Google Calendar" (gcal.on)
//   ok / updating        as whom, "12 shifts · 2 dates · Updated 2 min ago", Stop
//   gone                 "Make it again" (gcal.on) · Stop
//   reconnect            the chip, why, Reconnect · Stop (when the Google
//                        connection itself needs it, the Google card's
//                        Reconnect, pointed to)
//   stopping             "Removing the base.win calendar…"
//   left (or it's off)   what to do, and OK (gcal.stop forgets it here)
// Stop confirms in place. After gcal.on, with a calendar link too, it offers
// in place to stop the link so shifts don't show twice.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet, ApiError } from '../api.js';
import { adminHref, appMode } from '../mode.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';
import GoogleConnect, { StartLink, googleBlocked, useGoogle, useGoogleReturn } from './GoogleConnect.jsx';
import { appName, clockTime, googleStart, herePath } from './google.js';
import './google.css';
import './gcal.css';

const PURPOSE = 'calendar.mine';
const TITLE = 'Your shifts in Google Calendar';
const fmtN = (n) => Number(n || 0).toLocaleString('en-CA');
const said = (m) => { const t = String(m || ''); return t.charAt(0).toUpperCase() + t.slice(1); };
export const LEFT = 'base.win stopped updating your Google calendar — delete it there or use the calendar link.';

// "Updated just now" · "Updated 2 min ago" · "Updated at 2:30 pm" · "Updated Nov 3".
export const updatedWords = (iso, now = Date.now()) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return 'Updated just now';
  if (min < 60) return `Updated ${min} min ago`;
  if (new Date(t).toDateString() === new Date(now).toDateString()) return `Updated at ${clockTime(iso)}`;
  return `Updated ${new Date(t).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`;
};

const countLine = (link) => {
  const parts = [`${fmtN(link.shifts)} ${link.shifts === 1 ? 'shift' : 'shifts'}`];
  if (link.days) parts.push(`${fmtN(link.days)} ${link.days === 1 ? 'date' : 'dates'}`);
  return parts.join(' · ');
};

// "Reconnect", straight to Google for this purpose (or why it can't start here).
function Reconnect({ online }) {
  const g = useGoogle();
  if (!g.data) return null;
  const blocked = googleBlocked(g.data);
  if (blocked) return <p className="muted">{blocked}</p>;
  const href = googleStart('connect', { app: appName(appMode()), purpose: PURPOSE, back: herePath() });
  return <StartLink href={href} online={online}>Reconnect</StartLink>;
}

export default function GcalCard({ me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const code = useGoogleReturn();
  const q = useQuery({
    queryKey: ['gcal'],
    queryFn: () => apiGet('/gcal'),
    retry: false,
    // While base.win is writing or removing, the card follows it.
    refetchInterval: (query) => (['updating', 'stopping'].includes(query.state.data?.link?.state) ? 4000 : false),
  });
  const feed = useQuery({ queryKey: ['calendar-feed'], queryFn: () => apiGet('/calendar/feed'), retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [asking, setAsking] = useState(false);
  const [offerFeed, setOfferFeed] = useState(false);
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const cardRef = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const tell = (text) => {
    setToast(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 6000);
  };
  // Opened from the command bar (/profile#gcal): bring the card up.
  useEffect(() => {
    if (window.location.hash === '#gcal' && q.data) cardRef.current?.scrollIntoView({ block: 'start' });
  }, [q.data]);
  // Back from Google with the link made by the connect itself.
  const [welcomed, setWelcomed] = useState(false);
  useEffect(() => {
    if (welcomed || code !== 'connected' || !q.data?.link) return;
    setWelcomed(true);
    if (q.data.link.state === 'ok' || q.data.link.state === 'updating') {
      tell('Connected — your shifts are on their way');
      setOfferFeed(true);
    }
  }, [code, q.data, welcomed]);

  // The background work changed the link (made, removed, needs reconnecting):
  // the Google connection it rests on may have changed with it.
  const linkState = q.data ? (q.data.link?.state || 'none') : null;
  const seen = useRef(linkState);
  useEffect(() => {
    if (!linkState || seen.current === linkState) return;
    const was = seen.current;
    seen.current = linkState;
    if (was) qc.invalidateQueries({ queryKey: ['google'] });
  }, [linkState, qc]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['gcal'] }), qc.invalidateQueries({ queryKey: ['google'] })]);
  const run = async (name, after) => {
    setBusy(true); setError(null);
    try {
      await action(name, {});
      await after?.();
      await refresh();
    } catch (err) {
      setError(said(err.message));
    } finally {
      setBusy(false);
    }
  };

  // An older server: nothing. A read still on its way: nothing yet (most
  // campaigns have this off, so a "Loading…" card would only vanish).
  if (q.isError && q.error instanceof ApiError && q.error.status === 404) return null;
  const head = <div className="ts-head"><h2 className="ts-h">{TITLE}</h2></div>;
  if (q.isError) {
    return (
      <section className="ts-card gc-card" id="gcal" ref={cardRef} aria-label={TITLE}>
        {head}
        <p className="ts-line">Unavailable — <button type="button" className="btn btn-quiet ts-btn" onClick={() => q.refetch()}>Try again</button></p>
      </section>
    );
  }
  if (!q.data) return null;
  const d = q.data;
  const link = d.link;
  const role = me?.admin_role || me?.role;

  if (!link && !d.available) {
    if (role !== 'manager' || !d.manager) return null;
    return (
      <section className="ts-card gc-card gc-card--off" id="gcal" ref={cardRef} aria-label={TITLE}>
        {head}
        {d.why === 'jobs-off' ? (
          <p className="ts-line muted">Background work is off on this server, so Google Calendar can’t update.</p>
        ) : (
          <p className="ts-line muted">Google Calendar is off for this campaign. Turn it on in{' '}
            <a href={adminHref('/settings/services')}>Settings → Services → Google</a>.</p>
        )}
      </section>
    );
  }

  const off = busy || !online;
  const reconnectGrant = d.google.state === 'reconnect';
  const stop = asking ? (
    <div className="gg-confirm" role="group" aria-label="Stop Google Calendar">
      <span>{reconnectGrant
        ? 'Stop? base.win can’t reach Google now, so delete its calendar there yourself.'
        : 'Stop? base.win’s calendar is removed from your Google Calendar.'}</span>
      <button type="button" className="btn gg-danger" disabled={off}
        onClick={() => run('gcal.stop', () => { setAsking(false); setOfferFeed(false); tell(reconnectGrant ? 'Stopped' : 'Removing the base.win calendar'); })}>
        {busy ? 'Stopping…' : 'Stop'}
      </button>
      <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
    </div>
  ) : (
    <button type="button" className="btn btn-quiet ts-btn" disabled={off} onClick={() => setAsking(true)}>Stop<span className="gg-sr"> Google Calendar</span></button>
  );
  const keep = (label) => (
    <button type="button" className="btn btn-quiet ts-btn" disabled={off}
      onClick={() => run('gcal.on', () => { if (feed.data?.feed) setOfferFeed(true); })}>
      {busy ? 'Starting…' : label}
    </button>
  );

  let body;
  if (!link) {
    body = !d.google.connected || reconnectGrant ? (
      <>
        <p className="ts-line">Updated within a minute of any change. Only base.win’s own calendar.</p>
        <GoogleConnect purpose={PURPOSE} label="Connect Google Calendar" back="/profile" />
      </>
    ) : (
      <>
        <p className="ts-line">Updated within a minute of any change. Only base.win’s own calendar.</p>
        <div className="ts-row">{keep('Keep my shifts in Google Calendar')}</div>
      </>
    );
  } else if (link.state === 'stopping') {
    body = <p className="ts-line" role="status">Removing the base.win calendar…</p>;
  } else if (link.state === 'left' || !d.available) {
    body = (
      <>
        <p className="ts-line">{LEFT}</p>
        <div className="ts-row">
          <button type="button" className="btn btn-quiet ts-btn" disabled={off} onClick={() => run('gcal.stop')}>OK</button>
        </div>
      </>
    );
  } else if (link.state === 'gone') {
    body = (
      <>
        <p className="ts-line">You deleted the base.win calendar in Google.</p>
        <div className="ts-row">{keep('Make it again')}{stop}</div>
      </>
    );
  } else if (reconnectGrant) {
    // The Google connection itself: the Google card below says why and
    // carries the one Reconnect.
    body = (
      <>
        <p className="ts-line"><span className="chip chip-warn">Needs reconnecting</span> Reconnect under Google, below.</p>
        <div className="ts-row">{stop}</div>
      </>
    );
  } else if (link.state === 'reconnect') {
    body = (
      <>
        <p className="ts-line"><span className="chip chip-warn">Needs reconnecting</span>{link.said ? ` ${link.said}` : ''}</p>
        <div className="ts-row"><Reconnect online={online} />{stop}</div>
      </>
    );
  } else {
    const updating = link.state === 'updating';
    body = (
      <>
        {d.google.email && <p className="ts-line gc-who">In Google Calendar as <strong>{d.google.email}</strong></p>}
        <p className="gc-count">
          <span>{countLine(link)}</span>
          <span className="muted"> · {updating ? 'Updating…' : (updatedWords(link.updated_at) || 'Updating…')}</span>
        </p>
        {link.paused_until && <p className="ts-line muted">Google asked base.win to wait — trying again at {clockTime(link.paused_until)}</p>}
        <div className="ts-row">{stop}</div>
      </>
    );
  }

  // The offer already says it worked: no toast over its buttons.
  const offering = offerFeed && feed.data?.feed && link && !['stopping', 'left'].includes(link.state);
  return (
    <section className="ts-card gc-card" id="gcal" ref={cardRef} aria-label={TITLE}>
      {head}
      {body}
      {offering && (
        <div className="gg-confirm gc-offer" role="group" aria-label="Stop your calendar link">
          <span>Stop your calendar link too, so shifts don’t show twice?</span>
          <button type="button" className="btn btn-quiet" disabled={off}
            onClick={() => run('calendar.feed.stop', () => {
              qc.setQueryData(['calendar-feed'], { ...feed.data, feed: null });
              setOfferFeed(false);
              tell('Calendar link stopped');
            })}>Stop</button>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setOfferFeed(false)}>Keep</button>
        </div>
      )}
      <p className="gg-sr" role="status" aria-live="polite">{toast}</p>
      {toast && !offering && <div className="toast gc-toast" aria-hidden="true">{toast}</div>}
      {error && <p className="error" role="alert">{error}</p>}
      {!online && <NeedsSignalLine>Google Calendar needs signal</NeedsSignalLine>}
    </section>
  );
}
