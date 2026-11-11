// The question before the first pull from a Mailchimp audience (ext/mailchimp
// pull.js): it turns email off here for everyone on file who ever left
// there, and nobody here can turn that back on — so it is asked, with the
// audience's name, how many people on file it would turn off, and when that
// was counted:
//   "Audience ‘Imagine Surrey supporters’ · 1,240 people here unsubscribed
//    there · 85 dead addresses"
//   "Only they can turn their email back on. Counted 3:42 p.m."
//   [Turn their email off here]  [Not now]
// Asked the same way on Settings → Services (MailchimpPanel) and by a list's
// "Send to Mailchimp" (SendToMailchimp). The yes is for these numbers: the
// parent sends them with it, and a count that has changed since is refused.
//   <FirstPull first={first} busy={…} online={…} onYes={…} onNotNow={…} yesClass="btn ops-tap" />
// first: { audience, name, unsubscribed, cleaned, counted_at } as counted (GET /api/mailchimp).
import './first-pull.css';

const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
// Whether a count has anyone to ask about: nobody to turn off is no question.
export const asks = (f) => Boolean(f) && (Number(f.unsubscribed) > 0 || Number(f.cleaned) > 0);
// "3:42 p.m." today, "Nov 9, 3:42 p.m." another day.
const whenWord = (iso) => {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('en-CA', today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export const firstWords = (f) => [
  f.unsubscribed ? `${num(f.unsubscribed)} ${Number(f.unsubscribed) === 1 ? 'person' : 'people'} here unsubscribed there` : null,
  f.cleaned ? `${num(f.cleaned)} dead ${Number(f.cleaned) === 1 ? 'address' : 'addresses'}` : null,
].filter(Boolean).join(' · ');

export default function FirstPull({ first, busy, online, onYes, onNotNow, yesClass = 'btn ops-tap' }) {
  const counted = whenWord(first.counted_at);
  // "Counted 3:42 p.m." — the time's own full stop ends the sentence.
  const note = [Number(first.unsubscribed) > 0 ? 'Only they can turn their email back on.' : null, counted ? `Counted ${counted}${counted.endsWith('.') ? '' : '.'}` : null].filter(Boolean).join(' ');
  return (
    <div className="fp" role="group" aria-label="Before the first pull from Mailchimp">
      {/* Announced when it appears: it comes after a count, not after a tap. */}
      <p className="fp-said" role="status"><strong>Audience ‘{first.name || first.audience}’</strong> · {firstWords(first)}</p>
      {note && <p className="fp-note">{note}</p>}
      <div className="fp-acts">
        <button type="button" className={yesClass} disabled={busy || !online} onClick={onYes}>{busy ? 'Turning it off…' : 'Turn their email off here'}</button>
        <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onNotNow}>Not now</button>
      </div>
    </div>
  );
}
