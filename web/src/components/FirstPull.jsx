// The question before the first pull from a Mailchimp audience (ext/mailchimp
// pull.js): it turns email off here for everyone on file who ever left
// there, and nobody here can turn that back on — so it is asked once, with
// the audience's name and how many on file it would turn off:
//   "Audience ‘Imagine Surrey supporters’ · 1,240 people here unsubscribed
//    there · 85 dead addresses"   [Turn their email off here]  [Not now]
// Asked the same way on Settings → Services (MailchimpPanel) and by a list's
// "Send to Mailchimp" (SendToMailchimp).
//   <FirstPull first={first} busy={…} online={…} onYes={…} onNotNow={…} yesClass="btn ops-tap" />
// first: { audience, name, unsubscribed, cleaned } as counted (GET /api/mailchimp).
import './first-pull.css';

const num = (n) => (Number(n) || 0).toLocaleString('en-CA');

export const firstWords = (f) => [
  f.unsubscribed ? `${num(f.unsubscribed)} ${Number(f.unsubscribed) === 1 ? 'person' : 'people'} here unsubscribed there` : null,
  f.cleaned ? `${num(f.cleaned)} dead ${Number(f.cleaned) === 1 ? 'address' : 'addresses'}` : null,
].filter(Boolean).join(' · ');

export default function FirstPull({ first, busy, online, onYes, onNotNow, yesClass = 'btn ops-tap' }) {
  return (
    <div className="fp" role="group" aria-label="Before the first pull from Mailchimp">
      {/* Announced when it appears: it comes after a count, not after a tap. */}
      <p className="fp-said" role="status"><strong>Audience ‘{first.name || first.audience}’</strong> · {firstWords(first)}</p>
      {Number(first.unsubscribed) > 0 && <p className="fp-note">Only they can turn their email back on.</p>}
      <div className="fp-acts">
        <button type="button" className={yesClass} disabled={busy || !online} onClick={onYes}>{busy ? 'Turning it off…' : 'Turn their email off here'}</button>
        <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onNotNow}>Not now</button>
      </div>
    </div>
  );
}
