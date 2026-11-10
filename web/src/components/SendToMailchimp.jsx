// "Send to Mailchimp" on a list's page (ext/mailchimp), beside Download CSV.
//   <SendToMailchimp listId={id} />
// Shown only when Mailchimp is on (GET /api/integrations): nothing at all
// otherwise. A tap asks first — how many addresses go: only the newsletter's
// subscribers, or, with one tick, everyone on the list who can be emailed —
// then the work happens in the background and the line under the buttons
// says how it stands: "Syncing with Mailchimp · 120 to go", "In Mailchimp ·
// 212 addresses · tag “base.win: Members”", or "Stopped: Mailchimp said … ·
// Try again". Once sent, the button reads "Sync again".
// It sits in the page's row of buttons; what it opens takes the row's whole
// width underneath (send-to-mailchimp.css).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { useOnline } from './NoSignal.jsx';
import './send-to-mailchimp.css';

const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const plural = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many);
const errorText = (e) => e?.message || 'No answer — check your signal';
// "3:42 pm" today, "Tue 3:42 pm" another day.
const whenWord = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('en-CA', today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
const active = (s) => Boolean(s) && (s.status === 'queued' || s.status === 'syncing') && !s.stalled;
const stopped = (s) => Boolean(s) && (s.status === 'failed' || s.stalled);

// How the last sync stands, in one line (and one quiet line of detail).
function Status({ s, running }) {
  if (stopped(s)) return <p className="mc-line" data-status="stopped"><strong>Stopped</strong>: {s.note || 'it stopped part-way'}</p>;
  if (active(s)) {
    if (!running) return <p className="mc-line"><strong>Waiting</strong> · background work is off on this server</p>;
    return (
      <p className="mc-line">
        <strong>Syncing with Mailchimp</strong>{s.todo > 0 ? ` · ${num(s.todo)} to go` : ''}{s.note ? ` · ${s.note} — trying again soon` : ''}
      </p>
    );
  }
  const inTag = Math.max(0, s.total - s.skipped);
  const detail = [
    s.synced_at ? `Synced ${whenWord(s.synced_at)}` : null,
    s.consent === 'all' ? 'everyone who can be emailed' : 'newsletter subscribers only',
    s.added ? `${num(s.added)} new to your audience` : null,
    s.removed ? `${num(s.removed)} taken out of the tag` : null,
    s.skipped ? `${num(s.skipped)} Mailchimp wouldn’t take` : null,
    s.by ? `sent by ${s.by}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <>
      <p className="mc-line" data-status="synced"><strong>In Mailchimp</strong> · {num(inTag)} {plural(inTag, 'address', 'addresses')} · tag “{s.tag}”</p>
      <p className="ops-meta mc-detail">{detail}</p>
    </>
  );
}

export default function SendToMailchimp({ listId }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const on = useQuery({ queryKey: ['integrations'], queryFn: () => apiGet('/integrations'), staleTime: 5 * 60_000, retry: false });
  const isOn = Boolean(on.data?.mailchimp);
  const key = ['mailchimp', 'list', listId];
  const state = useQuery({
    queryKey: key,
    queryFn: () => apiGet(`/lists/${listId}/mailchimp`),
    enabled: isOn,
    retry: false,
    // While it is on its way, every few seconds.
    refetchInterval: (q) => (active(q.state.data?.sync) ? 3000 : false),
  });
  const [asking, setAsking] = useState(false);
  const [everyone, setEveryone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // How many would go: asked each time the question opens, never kept.
  const ask = useQuery({
    queryKey: [...key, 'counts'],
    queryFn: () => apiGet(`/lists/${listId}/mailchimp?counts=1`),
    enabled: isOn && asking,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  // Nothing at all unless Mailchimp is on (and still on, as this list's own answer has it).
  if (!isOn || state.data?.on === false) return null;
  const s = state.data?.sync || null;
  const going = active(s);
  const send = async (all) => {
    setBusy(true); setError(null);
    try {
      await action('mailchimp.push', { list_id: listId, everyone: all });
      setAsking(false);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const open = () => { setError(null); setEveryone(s?.consent === 'all'); setAsking(true); };
  const counts = ask.data?.counts;
  const n = counts ? (everyone ? counts.everyone : counts.subscribed) : 0;
  // The block under the buttons is only there when it has something to say.
  const quiet = state.data && !asking && !s && !error;
  return (
    <>
      {state.data && !going && (
        <button type="button" className="btn btn-quiet ops-tap" aria-expanded={asking} disabled={!online && !asking}
          onClick={() => (asking ? setAsking(false) : open())}>
          {s ? 'Sync again' : 'Send to Mailchimp'}
        </button>
      )}
      {!quiet && (
        <div className="mc" role="group" aria-label="Mailchimp">
          {state.isError && !state.data ? (
            <p className="mc-line" role="status">Mailchimp: Unavailable — <button type="button" className="btn-link mc-retry" onClick={() => state.refetch()}>Try again</button></p>
          ) : !state.data ? <p className="mc-line" role="status">Mailchimp: Loading…</p> : null}
          {asking && (
            <div className="mc-ask">
              {ask.isError ? (
                <p className="mc-line" role="status">Unavailable — <button type="button" className="btn-link mc-retry" onClick={() => ask.refetch()}>Try again</button></p>
              ) : !counts ? <p className="mc-line" role="status">Counting…</p> : (
                <>
                  <p className="mc-line" role="status">
                    <strong>{num(n)}</strong> {plural(n, 'address', 'addresses')} to send{everyone ? '' : ' · newsletter subscribers only'}
                  </p>
                  <label className="ops-check mc-tick">
                    <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
                    <span>Everyone on this list who can be emailed ({num(counts.everyone)}); they agreed to hear from us by email</span>
                  </label>
                  <p className="ops-meta">Only email, first and last name go. Nobody already in your audience is changed.</p>
                </>
              )}
              <div className="ops-actions">
                <button type="button" className="btn ops-solid ops-tap" disabled={busy || !online || !n} onClick={() => send(everyone)}>{busy ? 'Sending…' : 'Send'}</button>
                <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>Cancel</button>
              </div>
            </div>
          )}
          {s && !asking && (
            <div className="mc-status">
              {/* Announced when it changes; the button is not part of what is read out. */}
              <div role="status" aria-live="polite"><Status s={s} running={state.data.running} /></div>
              {stopped(s) && (
                <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={() => send(s.consent === 'all')}>{busy ? 'Starting…' : 'Try again'}</button>
              )}
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      )}
    </>
  );
}
