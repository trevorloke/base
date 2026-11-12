// "Your shifts in your calendar" on Your profile (every role, both apps):
// one secret link a calendar app checks now and then, so a person's own
// shifts (and the voting days; filing dates for the money desk) stay in
// their calendar as they are booked, moved or taken off
// (server/ext/calendar).
//   No link yet   "Get my calendar link" (calendar.feed.make)
//   With a link   at most three ways in, by device:
//                   Apple (iPhone, iPad, Mac)  Add to iPhone or Mac (webcal)
//                   a computer                 Add to Google (new tab)
//                   a phone                    Email me the link — Google
//                     adds calendar links only on a computer, so the steps
//                     go to their inbox (calendar.feed.email)
//                   always                     Copy link (for Outlook)
//                 More: Make a new link (renew), Stop this link (stop).
// The link itself is never shown: it works for whoever has it.
// An older server (404) shows nothing.
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet, ApiError } from '../api.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';
import './calendar.css';

const said = (m) => { const t = String(m || ''); return t.charAt(0).toUpperCase() + t.slice(1); };
export const deviceOf = (ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) => ({
  phone: /Android|iPhone|iPad|iPod|Mobile/.test(ua),
  apple: /iPhone|iPad|iPod|Macintosh/.test(ua),
});

// The clipboard, or (an old browser, a page without permission) a hidden
// field copied the old way.
const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
    return ok;
  }
};

export default function CalendarFeedCard({ me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: ['calendar-feed'], queryFn: () => apiGet('/calendar/feed'), retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [more, setMore] = useState(false);
  const [asking, setAsking] = useState(null); // 'renew' | 'stop'
  const moreId = useId();
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Opened from Shifts ("Put my shifts in my calendar"): bring the card up.
  const cardRef = useRef(null);
  useEffect(() => {
    if (window.location.hash === '#calendar' && q.data) cardRef.current?.scrollIntoView({ block: 'start' });
  }, [q.data]);

  const tell = (text) => {
    setNote(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(''), 6000);
  };
  const run = async (name, after) => {
    setBusy(true); setError(null); setNote('');
    try {
      const r = await action(name, {});
      await after?.(r);
    } catch (err) {
      setError(said(err.message));
    } finally {
      setBusy(false);
    }
  };
  const fresh = (r) => { qc.setQueryData(['calendar-feed'], { feed: r?.feed ?? null }); };

  // An older server has no calendar links: say nothing.
  if (q.isError && q.error instanceof ApiError && q.error.status === 404) return null;

  const head = <h2 className="ts-h">Your shifts in your calendar</h2>;
  if (!q.data) {
    return (
      <section className="ts-card cal-card" id="calendar" ref={cardRef} aria-label="Your shifts in your calendar">
        <div className="ts-head">{head}</div>
        {q.isError ? (
          <p className="ts-line">Unavailable — <button type="button" className="btn btn-quiet ts-btn" onClick={() => q.refetch()}>Try again</button></p>
        ) : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const feed = q.data.feed;
  const off = busy || !online;
  if (!feed) {
    return (
      <section className="ts-card cal-card" id="calendar" ref={cardRef} aria-label="Your shifts in your calendar">
        <div className="ts-head">{head}</div>
        <p className="ts-line">Your shifts appear in your calendar and stay up to date.</p>
        {note && <p className="ts-line ts-note" role="status">{note}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="btn ts-main" disabled={off}
          onClick={() => run('calendar.feed.make', fresh)}>
          {busy ? 'Getting it…' : 'Get my calendar link'}
        </button>
        {!online && <NeedsSignalLine>Needs signal</NeedsSignalLine>}
      </section>
    );
  }

  const device = deviceOf();
  const email = me?.user?.email || 'your email';
  return (
    <section className="ts-card cal-card" id="calendar" ref={cardRef} aria-label="Your shifts in your calendar">
      <div className="ts-head">{head}</div>
      <div className="ts-row">
        {device.apple && (online
          ? <a className="btn ts-btn" href={feed.webcal}>Add to iPhone or Mac</a>
          : <button type="button" className="btn ts-btn" disabled>Add to iPhone or Mac</button>)}
        {!device.phone && (online
          ? <a className="btn ts-btn" href={feed.google} target="_blank" rel="noopener noreferrer">Add to Google</a>
          : <button type="button" className="btn ts-btn" disabled>Add to Google</button>)}
        {device.phone && (
          <button type="button" className="btn ts-btn" disabled={off}
            onClick={() => run('calendar.feed.email', () => tell(`Sent to ${email}`))}>
            Email me the link
          </button>
        )}
        <button type="button" className="btn ts-btn" disabled={busy}
          onClick={async () => {
            setError(null);
            if (await copyText(feed.url)) tell('Link copied — paste it into Outlook: Add calendar → Subscribe from web');
            else setError('Couldn’t copy — try again');
          }}>
          Copy link
        </button>
      </div>
      {device.phone && <p className="cal-help">Google adds calendar links on a computer — we’ll email it to you.</p>}
      <p className="cal-said" role="status" aria-live="polite">{note}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="cal-help">Calendars check for changes every few hours, not instantly.</p>
      {!online && <NeedsSignalLine>Needs signal</NeedsSignalLine>}
      <button type="button" className="disclose ts-disclose" aria-expanded={more} aria-controls={moreId}
        onClick={() => { setMore((v) => !v); setAsking(null); }}>More</button>
      <div id={moreId} hidden={!more} className="ts-more">
        {asking === 'renew' ? (
          <div className="cal-confirm" role="group" aria-label="Make a new link">
            <span>The old link stops working. Make a new one?</span>
            <button type="button" className="btn" disabled={off}
              onClick={() => run('calendar.feed.renew', (r) => { fresh(r); setAsking(null); setMore(false); tell('New link made — add it to your calendar again'); })}>
              {busy ? 'Saving…' : 'Yes'}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(null)}>No</button>
          </div>
        ) : asking === 'stop' ? (
          <div className="cal-confirm" role="group" aria-label="Stop this link">
            <span>Your calendar stops getting shifts. Stop it?</span>
            <button type="button" className="btn ts-danger" disabled={off}
              onClick={() => run('calendar.feed.stop', () => { fresh(null); setAsking(null); setMore(false); tell('Link stopped'); })}>
              {busy ? 'Saving…' : 'Yes'}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(null)}>No</button>
          </div>
        ) : (
          <div className="ts-row">
            <button type="button" className="btn btn-quiet ts-btn" disabled={off} onClick={() => setAsking('renew')}>Make a new link</button>
            <button type="button" className="btn btn-quiet ts-btn" disabled={off} onClick={() => setAsking('stop')}>Stop this link</button>
          </div>
        )}
      </div>
    </section>
  );
}
