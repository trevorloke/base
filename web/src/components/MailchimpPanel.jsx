// Mailchimp's own buttons, in its row of Settings → Services (managers).
//   Connect    the one step that changes something at Mailchimp: it is told
//              where to send unsubscribes and dead addresses (mailchimp.connect).
//              If Mailchimp answers with a signing secret it is shown here
//              once, to copy into MAILCHIMP_WEBHOOK_SECRET — base.win keeps it
//              nowhere. Check, beside the row, only ever reads.
//   Pull now   read who left and whose address died, now (mailchimp.pull):
//              the work is done in the background and the line under the
//              buttons says what it found (GET /api/mailchimp).
// The first pull from an audience turns off here everyone on file who ever
// left there, for good: until someone says yes, Connect, Pull now and the
// nightly pull only count it, and the row asks (FirstPull) whenever the
// count finds someone — with when it was counted; Pull now counts again.
// (Someone who leaves there after the first count is turned off here all
// the same, as the webhook does it: the line says so.)
// "Turn their email off here" is the yes, for the numbers shown
// (mailchimp.pull with agree and shown: a count that has changed since is
// refused, and the row reads it again); "Not now" puts the question away
// until Pull now is tapped again or the page is opened again.
// onChanged: Connect worked — the row drops what an earlier Check said.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import FirstPull, { asks } from './FirstPull.jsx';
import { NoSignal, noSignal } from './NoSignal.jsx';
import './mailchimp-panel.css';

const KEY = ['mailchimp', 'state'];
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
// "3:42 pm" today, "Nov 9, 3:42 pm" another day.
const whenWord = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('en-CA', today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export default function MailchimpPanel({ online, onChanged }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => apiGet('/mailchimp'),
    retry: false,
    // While a pull is under way, every couple of seconds.
    refetchInterval: (x) => (x.state.data?.pulling && x.state.data?.running ? 2000 : false),
  });
  const [busy, setBusy] = useState(null); // 'connect' | 'pull' | 'yes'
  const [res, setRes] = useState(null); // what Connect said: { ok, said }
  const [secret, setSecret] = useState(null); // shown once
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [notNow, setNotNow] = useState(false); // the question put away for now
  const [yesTo, setYesTo] = useState(null); // the numbers the last yes here was for

  const connect = async () => {
    setBusy('connect'); setRes(null); setError(null); setCopied(false); setNotNow(false);
    try {
      const r = await action('mailchimp.connect', {});
      setRes({ ok: r.ok, said: r.said });
      if (r.secret) setSecret(r.secret);
      if (r.ok) onChanged?.();
      // Connect starts counting what the first pull would do: watched from here.
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (e) { setRes({ ok: false, said: e.message }); }
    setBusy(null);
  };
  // yes: the question as shown — the yes to the first pull from its audience, for its numbers.
  const pull = async (yes = null) => {
    setBusy(yes ? 'yes' : 'pull'); setError(null); setNotNow(false);
    setYesTo(yes ? { unsubscribed: yes.unsubscribed, cleaned: yes.cleaned } : null);
    try {
      await action('mailchimp.pull', yes ? { agree: yes.audience, shown: { unsubscribed: yes.unsubscribed, cleaned: yes.cleaned } } : {});
    } catch (e) { setError(e.message); setYesTo(null); }
    // Read again either way: after a refusal ("the count has changed"), the count as it stands.
    await queryClient.invalidateQueries({ queryKey: KEY });
    setBusy(null);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(secret); setCopied(true); } catch { setCopied(false); }
  };

  const d = q.data;
  // A pull asked for on a server whose background work is off: nothing here
  // will do it, so nothing says "Pulling…".
  const idle = Boolean(d?.pulling) && !d?.running;
  const pulling = busy === 'pull' || busy === 'yes' || (Boolean(d?.pulling) && !idle);
  // The first pull from this audience, counted, with someone to ask about, and waiting for a yes.
  const first = asks(d?.first) ? d.first : null;
  // Back after a yes here, with other numbers: the pull counted again first and found more.
  const again = Boolean(first && yesTo) && (first.unsubscribed !== yesTo.unsubscribed || first.cleaned !== yesTo.cleaned);
  // While nobody has said yes, a pull only counts — and says so.
  const counting = pulling && Boolean(d?.first) && busy !== 'yes';
  let line;
  let stopped = false; // the line is the one about a pull that stopped
  if (q.isLoading) line = 'Loading…';
  else if (q.isError) {
    line = noSignal(q) ? <NoSignal /> : <>Unavailable — <button type="button" className="btn-link mcp-retry" onClick={() => q.refetch()}>Try again</button></>;
  } else if (idle && busy !== 'pull' && busy !== 'yes') line = 'Waiting · background work is off on this server';
  else if (counting) line = 'Counting who unsubscribed in Mailchimp…';
  else if (pulling) line = 'Pulling…';
  else if (d.pull_ok === false) { stopped = true; line = `The last pull stopped: ${d.pull_note || 'no answer from Mailchimp'}`; }
  else if (d.pulled_at) line = `Last pulled ${whenWord(d.pulled_at)} · ${d.pull_note || 'Nothing new'}`;
  else line = 'Not pulled yet';

  return (
    <div className="mcp">
      <div className="mcp-acts">
        <button type="button" className="btn ops-tap" disabled={!!busy || !online} onClick={connect}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>
        <button type="button" className="btn ops-tap" disabled={!!busy || pulling || idle || !online || q.isLoading} onClick={() => pull()}>{counting ? 'Counting…' : pulling ? 'Pulling…' : 'Pull now'}</button>
      </div>
      <p className="sv2-for">Connect tells Mailchimp to send unsubscribes here. Pull now reads them at once.</p>
      {res && <p className={`sv2-said ${res.ok ? 'is-ok' : 'is-bad'}`} role="status">{res.ok ? '✓ ' : '✕ '}{res.said}</p>}
      {secret && (
        <div className="sv2-fresh" role="status">
          <p className="sv2-name">Copy this signing secret now — it won’t be shown again.</p>
          <code className="sv2-url sv2-key">{secret}</code>
          <p className="sv2-detail">Set <code className="sv2-url">MAILCHIMP_WEBHOOK_SECRET</code> to it in the hosting’s environment. Mailchimp’s deliveries are then checked against it.</p>
          <div className="sv2-fresh__acts">
            <button type="button" className="btn ops-tap" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}<span className="sv2-sr"> the signing secret</span></button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setSecret(null)}>Done</button>
          </div>
        </div>
      )}
      {first && !notNow && !pulling && (
        <>
          {again && <p className="sv2-detail mcp-again" role="status">The count has changed since you said yes — look again.</p>}
          <FirstPull first={first} busy={busy === 'yes'} online={online} onYes={() => pull(first)} onNotNow={() => setNotNow(true)} />
        </>
      )}
      <p className={`sv2-detail mcp-pull${stopped ? ' is-stopped' : ''}`} role="status" aria-live="polite">{line}</p>
      {d?.waiting > 0 && (
        <p className="sv2-detail mcp-waiting">
          {num(d.waiting)} {d.waiting === 1 ? 'unsubscribe' : 'unsubscribes'} here still to tell Mailchimp{d.waiting_note ? ` (${d.waiting_note})` : ''} — Pull now sends {d.waiting === 1 ? 'it' : 'them'} again.
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
