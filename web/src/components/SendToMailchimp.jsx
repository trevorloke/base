// "Send to Mailchimp" on a list's page (ext/mailchimp), beside Download CSV.
//   <SendToMailchimp listId={id} />
// Shown only when Mailchimp is on (GET /api/integrations): nothing at all
// otherwise. A tap asks first — how many addresses go: only the newsletter's
// subscribers, or, with one tick, everyone on the list who can be emailed —
// then the work happens in the background and the line under the buttons
// says how it stands: "Syncing with Mailchimp · 120 to go" (and "trying
// again soon (Mailchimp said: …)" while it waits out a refusal that will
// pass), "In Mailchimp · 212 addresses · tag “base.win: Members”", or
// "Stopped: Mailchimp said … · Try again". Once sent, the button reads
// "Sync again". A read that fails says "Unavailable — Try again".
// Every sync first reads who has left in Mailchimp and turns their email off
// here: the question says so before the tap, and the line says how many it
// was afterwards ("Email turned off here too: 2 who unsubscribed in
// Mailchimp, 1 dead address.") — the count before the tap could not know.
// An address Mailchimp would not take is counted with Mailchimp's own words
// for why.
// The first send to an audience starts the first pull from it, which turns
// off here everyone on file who ever left there, for good: so Send first
// answers with a question (FirstPull) — counted in the background, "Counting
// who unsubscribed in Mailchimp…" meanwhile — and only "Turn their email off
// here" sends. "Not now" sends nothing. With nobody here to turn off there
// is nothing to ask, and the list goes on its way.
// It sits in the page's row of buttons; what it opens takes the row's whole
// width underneath (send-to-mailchimp.css).
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import FirstPull from './FirstPull.jsx';
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
// What this sync's own pull turned off here, in one sentence — null when nothing.
const turnedOff = (s) => {
  const left = Number(s.pulled_unsubscribed) || 0;
  const dead = Number(s.pulled_cleaned) || 0;
  if (!left && !dead) return null;
  const who = [
    left ? `${num(left)} who unsubscribed in Mailchimp` : null,
    dead ? `${num(dead)} dead ${plural(dead, 'address', 'addresses')}${left ? '' : ' in Mailchimp'}` : null,
  ].filter(Boolean).join(', ');
  return `Email turned off here too: ${who}.`;
};
// "(Mailchimp said: …)" after the count of addresses it would not take: its words about the first.
const whyNot = (s) => (s.skipped_why ? ` (Mailchimp said${s.skipped > 1 ? ' of the first' : ''}: ${s.skipped_why})` : '');

// How the last sync stands, in one line (and one quiet line of detail) — and,
// however it stands, what its own pull turned off here: that is done even
// when the sync then stops.
function Status({ s, running }) {
  const off = turnedOff(s);
  return (
    <>
      <Standing s={s} running={running} />
      {off && <p className="ops-meta mc-off">{off}</p>}
    </>
  );
}
function Standing({ s, running }) {
  if (stopped(s)) return <p className="mc-line" data-status="stopped"><strong>Stopped</strong>: {s.note || 'it stopped part-way'}</p>;
  if (active(s)) {
    if (!running) return <p className="mc-line"><strong>Waiting</strong> · background work is off on this server</p>;
    return (
      <p className="mc-line">
        <strong>Syncing with Mailchimp</strong>{s.todo > 0 ? ` · ${num(s.todo)} to go` : ''}{s.note ? ` · trying again soon (${s.note})` : ''}
      </p>
    );
  }
  const inTag = Math.max(0, s.total - s.skipped);
  const detail = [
    s.synced_at ? `Synced ${whenWord(s.synced_at)}` : null,
    s.consent === 'all' ? 'everyone who can be emailed' : 'newsletter subscribers only',
    s.added ? `${num(s.added)} new to your audience` : null,
    s.removed ? `${num(s.removed)} taken out of the tag` : null,
    s.skipped ? `${num(s.skipped)} Mailchimp wouldn’t take${whyNot(s)}` : null,
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
  // Whether Mailchimp is on at all (the read "Send to CallHub" shares). With
  // no answer there is nothing to show, not even "Unavailable": most
  // campaigns have no Mailchimp to be unavailable.
  const on = useQuery({ queryKey: ['integrations'], queryFn: () => apiGet('/integrations'), staleTime: 5 * 60_000, retry: false });
  const isOn = Boolean(on.data?.mailchimp);
  const key = ['mailchimp', 'list', listId];
  const [asking, setAsking] = useState(false);
  const [everyone, setEveryone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Sent, and answered with the question about the first pull: { all } — the
  // choice made, kept for the yes (the question itself is the list's answer, `first`).
  const [door, setDoor] = useState(null);
  const state = useQuery({
    queryKey: key,
    queryFn: () => apiGet(`/lists/${listId}/mailchimp`),
    enabled: isOn,
    retry: false,
    // While it is on its way, every few seconds; while the first pull is counted, more often.
    refetchInterval: (q) => (door && q.state.data?.first?.counting ? 1500 : active(q.state.data?.sync) ? 3000 : false),
  });
  // How many would go: asked each time the question opens, never kept.
  const ask = useQuery({
    queryKey: [...key, 'counts'],
    queryFn: () => apiGet(`/lists/${listId}/mailchimp?counts=1`),
    enabled: isOn && asking,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  // agree: the audience the question named — the yes to the first pull from it.
  const send = async (all, agree = null) => {
    setBusy(true); setError(null);
    try {
      const r = await action('mailchimp.push', { list_id: listId, everyone: all, ...(agree ? { agree } : {}) });
      if (r.first) {
        // Nothing went: the question first (the list's own answer carries it,
        // read again below, before `busy` ends).
        setDoor({ all });
        setAsking(true);
      } else {
        setDoor(null);
        setAsking(false);
      }
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const first = door ? state.data?.first : undefined;
  // Counted, and nobody here to turn off (or someone said yes meanwhile): it
  // goes as asked — once for each tap, whatever the answer then says.
  const resent = useRef(false);
  useEffect(() => {
    if (door && first === null && !busy && !resent.current) { resent.current = true; send(door.all); }
  }, [door, first, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  // A sync that turned people off here changes the page's own numbers ("3 by
  // email"): read again when it ends.
  const last = state.data?.sync;
  const wasGoing = useRef(false);
  useEffect(() => {
    const now = active(last);
    if (wasGoing.current && !now && (Number(last?.pulled_unsubscribed) || Number(last?.pulled_cleaned))) queryClient.invalidateQueries({ queryKey: ['lists'] });
    wasGoing.current = now;
  }, [last?.id, last?.status, last?.stalled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nothing at all unless Mailchimp is on (and still on, as this list's own answer has it).
  if (!isOn || state.data?.on === false) return null;
  const s = state.data?.sync || null;
  const going = active(s);
  const open = () => { setError(null); setDoor(null); resent.current = false; setEveryone(s?.consent === 'all'); setAsking(true); };
  const away = () => { setAsking(false); setDoor(null); setError(null); };
  const counts = ask.data?.counts;
  const n = counts ? (everyone ? counts.everyone : counts.subscribed) : 0;
  // The block under the buttons is only there when it has something to say.
  const quiet = state.data && !asking && !s && !error;
  return (
    <>
      {state.data && !going && (
        <button type="button" className="btn btn-quiet ops-tap" aria-expanded={asking} disabled={!online && !asking}
          onClick={() => (asking ? away() : open())}>
          {s ? 'Sync again' : 'Send to Mailchimp'}
        </button>
      )}
      {!quiet && (
        <div className="mc" role="group" aria-label="Mailchimp">
          {state.isError && !state.data ? (
            <p className="mc-line" role="status">Mailchimp: Unavailable — <button type="button" className="btn-link mc-retry" onClick={() => state.refetch()}>Try again</button></p>
          ) : !state.data ? <p className="mc-line" role="status">Mailchimp: Loading…</p> : null}
          {asking && door && (
            <div className="mc-ask mc-first">
              {first?.unsubscribed != null ? (
                <FirstPull first={first} busy={busy} online={online} onYes={() => send(door.all, first.audience)} onNotNow={away} yesClass="btn ops-solid ops-tap" />
              ) : (
                <>
                  <p className="mc-line" role="status">
                    {!state.data.running ? <><strong>Waiting</strong> · background work is off on this server</>
                      : busy || first?.counting || first === null ? 'Counting who unsubscribed in Mailchimp…'
                        : <>Mailchimp didn’t answer — <button type="button" className="btn-link mc-retry" disabled={busy} onClick={() => send(door.all)}>Try again</button></>}
                  </p>
                  <div className="ops-actions">
                    <button type="button" className="btn btn-quiet ops-tap" onClick={away}>Not now</button>
                  </div>
                </>
              )}
            </div>
          )}
          {asking && !door && (
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
                  <p className="ops-meta">Anyone who unsubscribed in Mailchimp is turned off here too — only they can rejoin.</p>
                </>
              )}
              <div className="ops-actions">
                {/* Nothing to send is nothing to do — unless it was sent before: then the tag is emptied. */}
                <button type="button" className="btn ops-solid ops-tap" disabled={busy || !online || !counts || (!n && !s)} onClick={() => send(everyone)}>{busy ? 'Sending…' : 'Send'}</button>
                <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={away}>Cancel</button>
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
