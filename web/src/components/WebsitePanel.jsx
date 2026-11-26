// The website's own buttons, in its row of Settings → Services (managers):
// base.win's unsubscribes and text STOPs sent to the campaign's website
// (GET /api/intake/website).
//   Send again        everything still waiting, and what the website
//                     refused, is tried again now (intake.website.resend).
//   Send the N already off here
//                     what was off before the website was connected is not
//                     sent by itself: everyone off here now is counted, one
//                     tap sends them, once (intake.website.backfill).
// Check, beside the row, only ever reads.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal } from './NoSignal.jsx';
import './mailchimp-panel.css';

const KEY = ['intake', 'website'];
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
// "Nov 9, 3:42 pm", as the row above writes its own times.
const day = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s*([ap])\.?m\.?$/i, (m, x) => ` ${x.toLowerCase()}m`);
};

export default function WebsitePanel({ online }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => apiGet('/intake/website'),
    retry: false,
    // While something is on its way, every few seconds.
    refetchInterval: (x) => ((x.state.data?.waiting > 0 && !x.state.data?.waiting_note) || ['pending', 'running'].includes(x.state.data?.backfill?.status) ? 3000 : false),
  });
  const [busy, setBusy] = useState(null); // 'again' | 'old'
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: KEY });
    await queryClient.invalidateQueries({ queryKey: ['connections'] });
  };
  const run = async (which, name, words) => {
    setBusy(which); setError(null); setSaid(null);
    try { setSaid(words(await action(name, {}))); } catch (e) { setError(e.message); }
    await refresh();
    setBusy(null);
  };
  const again = () => run('again', 'intake.website.resend', (r) => (r.items ? `Sending ${num(r.items)} again now.` : r.backfill ? 'Carrying on now.' : 'Nothing is waiting.'));
  const old = () => run('old', 'intake.website.backfill', (r) => (r.queued ? `Sending ${num(r.count)} now. It goes at the website’s pace, about 60 a minute.` : 'Already sent.'));

  if (q.isLoading) return <div className="mcp"><p className="sv2-detail">Loading…</p></div>;
  if (q.isError) {
    return (
      <div className="mcp">
        <p className="sv2-detail">{noSignal(q) ? <NoSignal /> : <>Unavailable — <button type="button" className="btn-link mcp-retry" onClick={() => q.refetch()}>Try again</button></>}</p>
      </div>
    );
  }
  const d = q.data;
  if (!d?.on) return null;
  const held = d.waiting + d.refused;
  const b = d.backfill || { status: 'none', count: 0 };
  const going = ['pending', 'running'].includes(b.status);
  const stopped = b.status === 'failed';
  return (
    <div className="mcp">
      {/* How many are waiting or refused, and why, is in the row's own lines above. */}
      {held === 0 && <p className="sv2-detail" role="status" aria-live="polite">Nothing is waiting.</p>}
      {!d.running && <p className="sv2-detail">Background work is turned off on this server, so nothing is sent — ask whoever set up base.win to turn it on.</p>}
      <div className="mcp-acts">
        <button type="button" className="btn ops-tap" disabled={!!busy || !online || (held === 0 && !stopped)} onClick={again}>{busy === 'again' ? 'Sending…' : 'Send again'}</button>
        {b.status === 'none' && b.count > 0 && (
          <button type="button" className="btn ops-tap" disabled={!!busy || !online || !d.key} onClick={old}>
            {busy === 'old' ? 'Sending…' : `Send the ${num(b.count)} already off here`}
          </button>
        )}
      </div>
      {b.status === 'none' && b.count > 0 && (
        <p className="sv2-for">
          {num(b.count)} {b.count === 1 ? 'address or number is' : 'addresses and numbers are'} off here now. What was off before the website was connected was never sent. One tap sends {b.count === 1 ? 'it' : 'them all'}, once. Only a no is ever sent.
        </p>
      )}
      {b.status === 'none' && b.count === 0 && <p className="sv2-for">Nobody is off here yet, so there is nothing from before to send.</p>}
      {going && <p className="sv2-for">Sending what was already off here: {num(b.queued)} of {num(b.total)} so far.</p>}
      {stopped && <p className="sv2-for">Sending what was already off here stopped at {num(b.queued)} of {num(b.total)}. Send again carries on.</p>}
      {b.status === 'done' && <p className="sv2-for">What was already off here was sent {day(b.at)} ({num(b.queued)}).</p>}
      {said && <p className="sv2-said is-ok" role="status">✓ {said}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
