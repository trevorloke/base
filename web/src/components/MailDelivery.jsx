// What the email sender said about a send's emails, on the send's row in
// Outreach (GET /api/blasts/stats: confirmed, bounced, complained — the
// sender's delivery events, server/ext/mail). Nothing until the sender has
// said something: until then the send says "sent", as it always did.
//   "Delivered 1,180 of 1,200 · 12 bounced · 1 spam complaint"
//   "Those addresses are left off from now on."
//   "0.3% marked it as spam. Gmail’s limit is 0.1%."   (at 0.1% or more)
import './mail-delivery.css';

const n = (v) => Number(v || 0).toLocaleString('en-CA');
// Gmail's line for bulk senders: spam complaints under 0.1% of what was sent.
const COMPLAINT_LINE = 0.001;
const pct = (rate) => {
  const p = rate * 100;
  return `${p < 10 ? Math.round(p * 10) / 10 : Math.round(p)}%`;
};

export function DeliveryStats({ stat }) {
  if (!stat) return null;
  const confirmed = Number(stat.confirmed) || 0;
  const bounced = Number(stat.bounced) || 0;
  const complained = Number(stat.complained) || 0;
  if (confirmed + bounced + complained === 0) return null;
  // Everyone the sender took: the ones it didn't send back, and the bounces.
  const sent = (Number(stat.delivered) || 0) + bounced;
  const rate = sent > 0 ? complained / sent : 0;
  return (
    <span className="md" data-testid="delivery-stats">
      <span className="md-line">
        <span>Delivered {n(confirmed)} of {n(sent)}</span>
        {bounced > 0 && <span className="md-bad">{n(bounced)} bounced</span>}
        {complained > 0 && <span className="md-bad">{n(complained)} spam {complained === 1 ? 'complaint' : 'complaints'}</span>}
      </span>
      {bounced + complained > 0 && <span className="md-note">{bounced + complained === 1 ? 'That address is' : 'Those addresses are'} left off from now on.</span>}
      {rate >= COMPLAINT_LINE && <span className="md-warn">{pct(rate)} marked it as spam. Gmail’s limit is 0.1%.</span>}
    </span>
  );
}
