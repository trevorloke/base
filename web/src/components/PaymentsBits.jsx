// Donations' online side (ext/payments, GET /api/payments) — the pieces the
// Donations screen (pages/Money.jsx) uses:
//   usePayments(enabled)  the one read; never kept past the tab (KeptCopies
//                         keeps no ['payments'] copy at all)
//   PaymentNeedRow        Needs you: an online payment the desk must see —
//                         refunded over the limit, a refund that didn't go
//                         through, a dispute, a refund made in Stripe — the
//                         plain line, "Got it" when that's all it needs, Donor
//   OnlineChips           on a ledger row: "online", and how it stands when
//                         it isn't simply paid ("disputed", "partly refunded")
//   MonthlyDonors         everyone giving monthly — online, or pledged on a
//                         form — the amount, since when, the last month in
//   OnlinePayments        the latest online payments and how each stands
//                         (paid, refunded, disputed…), and whether online
//                         giving is live, in test mode or not set up
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, action, fmtMoney } from '../api.js';
import './payments.css';

export const usePayments = (enabled) => useQuery({
  queryKey: ['payments'],
  queryFn: () => apiGet('/payments'),
  enabled,
  staleTime: 15_000,
});

const TONE = {
  paid: 'chip-ok', over_limit: 'chip-warn', refunded: '', partly_refunded: 'chip-warn',
  refund_failed: 'chip-danger', disputed: 'chip-danger', dispute_lost: 'chip-danger', no_donor: 'chip-warn',
};
export const StatusChip = ({ p }) => <span className={`chip ${TONE[p.status] ?? ''}`}>{p.word}</span>;

const METHOD = { card: 'Card', etransfer: 'E-transfer', cheque: 'Cheque', cash: 'Cash', pad: 'Pre-authorized debit', 'in-kind': 'In-kind' };
const day = (iso) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const opts = { month: 'short', day: 'numeric', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) };
  return new Date(y, m - 1, d).toLocaleDateString('en-CA', opts);
};
const monthOf = (iso) => {
  const [y, m] = String(iso || '').split('-').map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleDateString('en-CA', { month: 'short', year: 'numeric' }) : '';
};

// ── Needs you ──
export function PaymentNeedRow({ n, onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const bodyId = `pn-${n.id.slice(0, 8)}`;
  const ack = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('payment.ack', { id: n.id });
      onDone(`✓ Done — ${n.name}`);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <li className="ops-item">
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className="ops-row__main">
          <span className="ops-row__name">{n.name}</span>
          <span className="ops-row__sub">
            {n.paid_day}
            <span className="chip">online{n.cadence === 'monthly' ? ' · monthly' : ''}</span>
            <StatusChip p={n} />
          </span>
        </span>
        <span className="ops-row__end"><span className="ops-row__amt">{fmtMoney(n.amount_cents)}</span></span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          <p className="pay-line">{n.line}</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="ops-actions">
            {n.can_ack && (
              <button type="button" className="btn ops-solid ops-tap" disabled={busy} onClick={ack}>{busy ? 'Saving…' : 'Got it'}</button>
            )}
            {n.person_id && <Link className="btn btn-quiet ops-tap" to={`/people/${n.person_id}`}>Donor</Link>}
          </div>
        </div>
      )}
    </li>
  );
}

// ── A ledger row's marks ──
export function OnlineChips({ g, info }) {
  if (!info && g?.attrs?.source !== 'online') return null;
  return (
    <>
      <span className="chip" title="Paid online, by card">online</span>
      {info && info.status !== 'paid' && <StatusChip p={info} />}
    </>
  );
}

// ── Monthly donors ──
const SHOWN = 3;
export function MonthlyDonors({ list, totalCents }) {
  const [all, setAll] = useState(false);
  if (!list?.length) return null;
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <section className="pay-section" aria-labelledby="pay-monthly-h">
      <h2 className="eyebrow ops-label pay-h" id="pay-monthly-h">
        Monthly donors · {list.length} · {fmtMoney(totalCents).replace(/\.00$/, '')} a month
      </h2>
      <ul className="ops-rows" id="pay-monthly-list">
        {shown.map((m) => (
          <li key={m.id} className="ops-item">
            <Link className="ops-row" to={`/people/${m.person_id}`}>
              <span className="ops-row__main">
                <span className="ops-row__name">{m.name}</span>
                <span className="ops-row__sub">
                  <span className="chip">{m.online ? 'online' : METHOD[m.method] || 'pledged'}</span>
                  {m.since && <span>since {monthOf(m.since)}</span>}
                  {m.last_gift_on && <span>last {day(m.last_gift_on)}</span>}
                </span>
              </span>
              <span className="ops-row__end pay-month">
                <span className="ops-row__amt">{fmtMoney(m.amount_cents)}</span>
                <span className="ops-meta">a month</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {list.length > SHOWN && (
        <button type="button" className="ops-more disclose" aria-expanded={all} aria-controls="pay-monthly-list" onClick={() => setAll((v) => !v)}>
          All monthly donors · {list.length}
        </button>
      )}
    </section>
  );
}

// ── Online payments ──
const LATEST = 5;
export function OnlinePayments({ data }) {
  const [all, setAll] = useState(false);
  if (!data) return null;
  const { stripe, recent } = data;
  const state = !stripe?.ready ? 'not set up' : stripe.mode === 'test' ? 'test mode' : 'live';
  const shown = all ? recent : recent.slice(0, LATEST);
  return (
    <section className="pay-section" aria-labelledby="pay-online-h">
      <h2 className="eyebrow ops-label pay-h" id="pay-online-h">Online giving · {state}</h2>
      {!stripe?.ready && (
        <p className="ops-meta pay-note">Gifts and membership dues by card on the website start once a manager sets up Stripe under Settings → Services.</p>
      )}
      {stripe?.ready && stripe.mode === 'test' && (
        <p className="ops-meta pay-note">Test mode: no real money moves. Live keys take real gifts.</p>
      )}
      {recent.length === 0 && stripe?.ready && <p className="ops-meta pay-note">No online payments yet.</p>}
      {recent.length > 0 && (
        <ul className="ops-rows" id="pay-online-list">
          {shown.map((p) => (
            <li key={p.id} className="ops-item">
              {p.person_id ? (
                <Link className="ops-row" to={`/people/${p.person_id}`}>
                  <PaymentRowInner p={p} />
                </Link>
              ) : (
                <div className="ops-row ops-row--static"><PaymentRowInner p={p} /></div>
              )}
            </li>
          ))}
        </ul>
      )}
      {recent.length > LATEST && (
        <button type="button" className="ops-more disclose" aria-expanded={all} aria-controls="pay-online-list" onClick={() => setAll((v) => !v)}>
          All online payments · {recent.length}
        </button>
      )}
    </section>
  );
}

function PaymentRowInner({ p }) {
  return (
    <>
      <span className="ops-row__main">
        <span className="ops-row__name">{p.name}</span>
        <span className="ops-row__sub">
          {p.paid_day}
          {p.kind === 'membership' ? <span className="chip">dues</span> : p.cadence === 'monthly' ? <span className="chip">monthly</span> : null}
          <StatusChip p={p} />
        </span>
      </span>
      <span className="ops-row__end"><span className="ops-row__amt">{fmtMoney(p.amount_cents)}</span></span>
    </>
  );
}
