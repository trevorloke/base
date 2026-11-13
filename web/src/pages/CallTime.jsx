// Call time (/call-time): a candidate on the phone to the donors the desk
// set out for them (ext/candidates calltime.js). One card at a time, built
// for a phone: who, the number to tap, one line of what they gave and may
// still give, the ask — and four answers. A pledge is what they said, never
// a gift: the financial agent takes the money, and a wrong pledge is
// dropped by the treasurer (there is no Undo here).
//
// The list is kept on this phone (OfflineCache phoneCopy) and answers go
// through the outbox (offline.js calltime.log), so a dead zone loses
// nothing: each answer is sent once signal is back, and one the server
// refuses shows in the outbox's refused strip with its words.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action, dollarsToCents } from '../api.js';
import { queueAction, onOutboxSent, useOutbox } from '../offline.js';
import { queuedText } from '../components/queued.js';
import { phoneCopy, useKeepCopy } from '../components/OfflineCache.js';
import { useOnline } from '../components/NoSignal.jsx';
import { fmtBig } from '../components/MoneyWords.js';
import { Unavailable } from '../components/GiftImportBits.jsx';
import './shifts.css';
import './calltime.css';

const ANSWERS = [
  ['pledged', 'Pledged'],
  ['no', 'Not now'],
  ['no_answer', 'No answer'],
  ['left_message', 'Left message'],
];
// "Call back…": the Calls screen's three times, on this phone's clock.
const CALLBACKS = [
  ['In an hour', () => new Date(Date.now() + 3600_000)],
  ['This evening', () => { const d = new Date(); if (d.getHours() >= 17) d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); return d; }],
  ['Tomorrow morning', () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; }],
];
// "3 May 2026"
const longDate = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'them';
const overWords = (room) => `That’s over what they can give this year — up to ${fmtBig(room)}`;

// "Gave $500 last on 3 May 2026 · $500 this year · Room $929.70"
function factsOf(n) {
  const parts = [];
  if (n.last_gift) parts.push(`Gave ${fmtBig(n.last_gift.amount_cents)} last on ${longDate(n.last_gift.date)}`);
  else parts.push('No gifts yet');
  if (n.given_year_cents > 0) parts.push(`${fmtBig(n.given_year_cents)} this year`);
  if (n.room_cents != null) parts.push(`Room ${fmtBig(n.room_cents)}`);
  return parts.join(' · ');
}

export default function CallTime() {
  const { me } = useOutletContext() ?? {};
  const queryClient = useQueryClient();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const homeCopy = 'calltime-home';
  const home = useQuery({ queryKey: ['candidate-home'], queryFn: () => apiGet('/candidate/home'), ...phoneCopy(me, homeCopy) });
  useKeepCopy(me, homeCopy, home);
  const banks = home.data?.calltime?.banks ?? [];
  const bankId = params.get('bank') || (banks.find((b) => b.left > 0) || banks[0])?.id || null;
  const copyName = bankId ? `calltime:${bankId}` : null;
  const page = useQuery({
    queryKey: ['calltime', bankId],
    queryFn: () => apiGet(`/calltime/${bankId}`),
    enabled: Boolean(bankId),
    ...phoneCopy(me, copyName),
  });
  useKeepCopy(me, copyName, page);

  // Answered on this phone: { [person_id]: { result, amount } } — off the
  // card at once. One still in the outbox is counted at the end (below).
  const [answered, setAnswered] = useState({});
  const outbox = useOutbox();
  const [open, setOpen] = useState(null); // 'pledge' | 'callback' | null
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [details, setDetails] = useState(false);
  const [script, setScript] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [lastPledge, setLastPledge] = useState(null); // { name, phone }
  const toastTimer = useRef(null);
  const headRef = useRef(null);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => { setAnswered({}); setLastPledge(null); }, [bankId]);

  // An answer that waited in the outbox has gone: count it from the server now.
  useEffect(() => onOutboxSent(({ name, input }) => {
    if (name !== 'calltime.log') return;
    queryClient.invalidateQueries({ queryKey: ['calltime', input.bank_id] });
    queryClient.invalidateQueries({ queryKey: ['candidate-home'] });
  }), [queryClient]);

  const numbers = useMemo(() => (page.data?.numbers ?? []).filter((n) => !answered[n.person_id]), [page.data, answered]);
  const current = numbers[0] || null;
  const say = (text) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };
  const reset = (n) => {
    setOpen(null); setNote(''); setDetails(false); setError(null);
    setAmount(n?.ask_cents ? String(n.ask_cents / 100) : '');
  };
  useEffect(() => { reset(current); }, [current?.person_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (result) => {
    if (!current || busy) return;
    setError(null);
    let cents = null;
    if (result === 'pledged') {
      cents = dollarsToCents(amount);
      if (!cents || cents < 100) { setError('An amount of $1 or more'); return; }
      if (current.room_cents != null && cents > current.room_cents) { setError(overWords(current.room_cents)); return; }
    }
    setBusy(true);
    try {
      const r = await queueAction('calltime.log', {
        bank_id: bankId, person_id: current.person_id, result,
        ...(cents ? { amount_cents: cents } : {}), ...(note.trim() ? { note: note.trim() } : {}),
      }, { who: current.name });
      setAnswered((a) => ({ ...a, [current.person_id]: { result, amount: cents || 0 } }));
      setLastPledge(result === 'pledged' && current.phone ? { name: current.name, phone: current.phone } : null);
      say(r.queued ? queuedText(r) : 'Saved');
      if (!r.queued) {
        queryClient.invalidateQueries({ queryKey: ['calltime', bankId] });
        queryClient.invalidateQueries({ queryKey: ['candidate-home'] });
      }
      requestAnimationFrame(() => headRef.current?.focus());
    } catch (e) {
      setError(e.message || 'Not saved — try again');
      // Refused on what the server knows now (another pledge took the room;
      // answered from another phone): the card reads it afresh.
      if (e.status === 400 || e.status === 409) queryClient.invalidateQueries({ queryKey: ['calltime', bankId] });
      if (e.status === 409) {
        setAnswered((a) => ({ ...a, [current.person_id]: { result: 'elsewhere', amount: 0 } }));
        say(`${firstName(current.name)} · already called`);
      }
    } finally {
      setBusy(false);
    }
  };

  const callBack = async (when) => {
    if (!current) return;
    setBusy(true); setError(null);
    try {
      await action('bank.callback', { id: bankId, person_id: current.person_id, at: when().toISOString() });
      setAnswered((a) => ({ ...a, [current.person_id]: { result: 'later', amount: 0 } }));
      say(`${firstName(current.name)} · back on your list later`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ── States: loading, unavailable, no call time ──
  const back = <Link to="/" className="ops-back">← Today</Link>;
  if (home.isPending || (bankId && page.isPending)) return <div className="ops-page ct-page">{back}<h1>Call time</h1><p className="ops-meta" role="status">Loading…</p></div>;
  if ((home.isError && !home.data) || (page.isError && !page.data)) {
    return (
      <div className="ops-page ct-page">{back}<h1>Call time</h1>
        <Unavailable onRetry={() => { home.refetch(); if (bankId) page.refetch(); }} busy={home.isFetching || page.isFetching} />
      </div>
    );
  }
  if (!bankId || !page.data) {
    return <div className="ops-page ct-page">{back}<h1>Call time</h1><p className="ops-empty">No call time yet — the desk sets it up for you.</p></div>;
  }

  const bank = page.data.bank;
  // Answers still waiting in the outbox, read from the outbox itself: one
  // the server refused (already called from another phone) isn't counted.
  const waiting = outbox.items.filter((i) => i.name === 'calltime.log' && i.state === 'pending' && i.input?.bank_id === bankId);
  const calls = page.data.done.calls + waiting.length;
  const pledged = page.data.done.pledged_cents + waiting.reduce((s, i) => s + (i.input.result === 'pledged' ? i.input.amount_cents || 0 : 0), 0);
  // Still to call: the server's count, less what this phone has answered
  // that the server hasn't counted yet (still in its list). The card holds
  // the first 200; the rest come with the next read.
  const toCall = Math.max(numbers.length,
    bank.left - (page.data.numbers ?? []).filter((n) => answered[n.person_id]).length);
  const donate = page.data.donate_url;
  const sms = lastPledge && donate
    ? `sms:${lastPledge.phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(`Thank you! Here’s where to give: ${donate}`)}`
    : null;

  return (
    <div className="ops-page ct-page">
      {back}
      <h1 ref={headRef} tabIndex={-1}>{bank.name}</h1>
      {banks.length > 1 && (
        <div className="ct-banks" role="group" aria-label="Your call time">
          {banks.map((b) => (
            <button key={b.id} type="button" className={`chip ct-bank${b.id === bankId ? ' is-on' : ''}`} aria-pressed={b.id === bankId}
              onClick={() => setParams({ bank: b.id })}>{b.name}</button>
          ))}
        </div>
      )}

      {sms && (
        <p className="ct-after">
          <a className="btn btn-quiet ops-tap" href={sms}>Text {firstName(lastPledge.name)} the donate link</a>
        </p>
      )}

      {current ? (
        <section className="card ct-card" aria-label={`Call ${current.name}`}>
          <p className="ct-left ops-meta">{toCall.toLocaleString('en-CA')} to call{bank.later > 0 ? ` · ${bank.later.toLocaleString('en-CA')} later` : ''}</p>
          <h2 className="ct-name">{current.name}</h2>
          {current.city && <p className="ops-meta ct-city">{current.city}</p>}
          {current.phone && (
            // The first thing to tap: a real button (not primary — the answers are), with a phone mark.
            <a className="btn ct-call" href={`tel:${current.phone.replace(/[^\d+]/g, '')}`}>
              <svg className="ct-call__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
              </svg>
              Call <span className="mono">{current.phone}</span>
            </a>
          )}
          <p className="ct-facts">{factsOf(current)}</p>
          {current.ask_cents ? <p className="ct-ask">Ask {fmtBig(current.ask_cents)}</p> : null}

          {open === 'pledge' ? (
            <div className="ct-pledge">
              <div className="field">
                <label htmlFor="ct-amount">Amount pledged ($)</label>
                <input id="ct-amount" className="input mono" inputMode="decimal" autoComplete="off" autoFocus value={amount}
                  onChange={(e) => { setAmount(e.target.value); setError(null); }} />
                <span className="ops-meta">A pledge isn’t a gift — the financial agent takes the money.</span>
              </div>
              <div className="ct-row">
                <button type="button" className="btn btn-primary ops-tap" disabled={busy} onClick={() => answer('pledged')}>{busy ? 'Saving…' : 'Save pledge'}</button>
                <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => { setOpen(null); setError(null); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="ct-answers" role="group" aria-label="What they said">
              {ANSWERS.map(([key, label]) => (
                <button key={key} type="button" className="btn ct-answer" disabled={busy}
                  onClick={() => (key === 'pledged' ? setOpen('pledge') : answer(key))}>{label}</button>
              ))}
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}

          <button type="button" className="ops-more disclose" aria-expanded={details} aria-controls="ct-details" onClick={() => setDetails((v) => !v)}>More details</button>
          {details && (
            <div id="ct-details" className="field">
              <label htmlFor="ct-note">Note (for the treasurer)</label>
              <textarea id="ct-note" className="input" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}

          <div className="ct-row">
            <button type="button" className="btn ops-tap" aria-expanded={open === 'callback'} disabled={busy || !online}
              onClick={() => setOpen((v) => (v === 'callback' ? null : 'callback'))}>Call back…</button>
            {!online && <span className="ops-meta">Needs signal</span>}
          </div>
          {open === 'callback' && online && (
            <div className="ct-row" role="group" aria-label="Call back">
              {CALLBACKS.map(([label, when]) => (
                <button key={label} type="button" className="btn ops-tap" disabled={busy} onClick={() => callBack(when)}>{label}</button>
              ))}
            </div>
          )}
          {bank.script && (
            <>
              <button type="button" className="ops-more disclose" aria-expanded={script} aria-controls="ct-script" onClick={() => setScript((v) => !v)}>Script</button>
              {script && <p id="ct-script" className="ct-script">{bank.script}</p>}
            </>
          )}
        </section>
      ) : toCall > 0 ? (
        <section className="card ct-done" aria-live="polite">
          <h2>{toCall.toLocaleString('en-CA')} more to call</h2>
          {online
            ? <button type="button" className="btn btn-quiet ops-tap" disabled={page.isFetching} onClick={() => page.refetch()}>{page.isFetching ? 'Loading…' : 'Load the next numbers'}</button>
            : <p className="ops-meta">They load once you have signal.</p>}
        </section>
      ) : (
        <section className="card ct-done" aria-live="polite">
          <h2>All done — {calls.toLocaleString('en-CA')} {calls === 1 ? 'call' : 'calls'}, {fmtBig(pledged)} pledged</h2>
          {bank.later > 0 && <p className="ops-meta">{bank.later.toLocaleString('en-CA')} to call back later.</p>}
          <Link to="/" className="btn btn-primary ops-tap">Back to Today</Link>
        </section>
      )}

      {toast && <div className="toast ops-toast" role="status">{toast}</div>}
    </div>
  );
}
