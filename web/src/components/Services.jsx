// Settings → Services (managers): every outside service Starbase uses, what
// it's for, whether it's set up, and "Check" — one real call to the service
// (GET /api/connections, POST /api/connections/check — ext/connections).
// The Email row carries the sender's "Sending domain" (SendingDomain.jsx);
// the Mailchimp row its own Connect and Pull now (MailchimpPanel.jsx).
// Keys live in the hosting's settings (Render → the service → Environment),
// never here: a missing one is named, with where it goes. The long version
// is INTEGRATIONS.md.
// Website keys: the keys the campaign's website (its server) uses to send
// people in (ext/intake). A new key is shown once, to copy; after that only
// its first characters, when it was last used, and Revoke.
// Going out: the one way out to any other tool — a ladder's "Send to a web
// address" step (ext/ladders) — said here, where integrations are looked
// for, with the way to Ladders.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet, apiPost } from '../api.js';
import SendingDomain from './SendingDomain.jsx';
import SenderAddresses from './SenderAddresses.jsx';
import MailchimpPanel from './MailchimpPanel.jsx';
import { NoSignal, noSignal, useOnline } from './NoSignal.jsx';
import ServiceConnect from './ServiceConnect.jsx';
import './services.css';

const STATE_WORD = { ready: 'Set up', missing: 'Not set up', default: 'Using the free default', test: 'Test mode' };

function Row({ s, online }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const check = async () => {
    setBusy(true);
    setRes(null);
    try { setRes(await apiPost('/connections/check', { key: s.key })); } catch (e) { setRes({ ok: false, said: e.message }); }
    setBusy(false);
  };
  return (
    <li className="sv2-row" data-state={s.state}>
      <div className="sv2-row__main">
        <div className="sv2-row__head">
          <span className="sv2-name">{s.name}</span>
          <span className={`chip sv2-state sv2-state--${s.state}`}>{STATE_WORD[s.state]}{s.launch && s.state === 'missing' ? ' · needed to launch' : ''}</span>
        </div>
        <p className="sv2-for">{s.for}</p>
        {s.detail && <p className="sv2-detail">{s.detail}</p>}
        {s.missing.length > 0 && (
          <p className="sv2-missing">Set in the hosting’s environment: {s.missing.map((k) => <code key={k}>{k}</code>).reduce((a, b) => [a, ' · ', b])}</p>
        )}
        {s.domainPanel && <SendingDomain online={online} />}
        {s.domainPanel && <SenderAddresses online={online} />}
        {s.panel === 'mailchimp' && <MailchimpPanel online={online} onChanged={() => setRes(null)} />}
        {/* The email sender's block comes as `hook`: a page cached from before it existed prints Stripe's sentence over any `webhook`. */}
        {s.hook && <Webhook w={s.hook} />}
        {s.webhook && <Webhook w={s.webhook} />}
        {s.connect && <ServiceConnect connect={s.connect} online={online} onDone={() => setRes(null)} />}
        {res && <p className={`sv2-said ${res.ok ? 'is-ok' : 'is-bad'}`} role="status">{res.ok ? '✓ ' : '✕ '}{res.said}</p>}
        {/* Something for the manager to do at the service: said apart, not in the line that says what works. */}
        {res?.todo && <p className="sv2-detail sv2-todo" role="status">{res.todo}</p>}
      </div>
      {s.checkable && (
        <button type="button" className="btn ops-tap sv2-check" disabled={busy || !online} onClick={check}>{busy ? 'Checking…' : 'Check'}</button>
      )}
    </li>
  );
}

// A service that calls back (Stripe: s.webhook; the email sender: s.hook):
// the address to paste into it, where there (w.where), the events to tick,
// and what to set here afterwards (w.note), when there is something.
function Webhook({ w }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(w.url); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div className="sv2-hook">
      <p className="sv2-detail">Webhook address{w.where ? ` — in ${w.where}` : ''}:</p>
      <div className="sv2-hook__url">
        <code className="sv2-url sv2-key">{w.url}</code>
        <button type="button" className="btn ops-tap sv2-copy" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}<span className="sv2-sr"> the webhook address</span></button>
      </div>
      <p className="sv2-detail">Events to send ({w.events.length}):</p>
      <ul className="sv2-events">{w.events.map((e) => <li key={e}><code className="sv2-url">{e}</code></li>)}</ul>
      {w.note && <p className="sv2-detail">{w.note}</p>}
    </div>
  );
}

export default function Services() {
  const online = useOnline();
  const q = useQuery({ queryKey: ['connections'], queryFn: () => apiGet('/connections') });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError) return noSignal(q.error) ? <NoSignal /> : <p className="error">{q.error.message}</p>;
  const { services, inbound } = q.data;
  const needed = services.filter((s) => s.launch && s.state === 'missing');
  return (
    <div className="sv2">
      <p className="sv2-lead">
        {needed.length
          ? `${needed.length} to set up before launch: ${needed.map((s) => s.name.replace(/ \(.*\)$/, '')).join(', ')}.`
          : 'Everything needed to launch is set up. Check each one to be sure it answers.'}
        {' '}Keys go in the hosting’s settings (Render → the service → Environment), never here.
      </p>
      <ul className="sv2-list">
        {services.map((s) => <Row key={s.key} s={s} online={online} />)}
      </ul>
      <WebsiteKeys online={online} />
      <h2 className="sv2-h">Coming in</h2>
      <ul className="sv2-list sv2-in">
        {inbound.map((i) => (
          <li key={i.name} className="sv2-row">
            <div className="sv2-row__main">
              <span className="sv2-name">{i.name}</span>
              <p className="sv2-detail"><code className="sv2-url">{i.url}</code></p>
              <p className="sv2-for">{i.how}</p>
            </div>
          </li>
        ))}
      </ul>
      <h2 className="sv2-h">Going out</h2>
      <ul className="sv2-list sv2-out">
        <li className="sv2-row">
          <div className="sv2-row__main">
            <strong>Any other tool — Zapier, Make, a Slack channel</strong>
            <p className="sv2-for">A ladder’s “Send to a web address” step sends it each person who reaches the step. <Link to="/ladders">Open Ladders</Link></p>
          </div>
        </li>
      </ul>
    </div>
  );
}

const when = (t) => (t ? new Date(t).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null);

function WebsiteKeys({ online }) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['intake', 'keys'], queryFn: () => apiGet('/intake/keys') });
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null); // { name, key } — shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['intake', 'keys'] });
  const make = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null); setCopied(false);
    try {
      const r = await action('intake.key.create', { name: name.trim() });
      setFresh({ name: r.name, key: r.key });
      setName('');
      refresh();
    } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const revoke = async (k) => {
    setBusy(true); setError(null);
    try { await action('intake.key.revoke', { id: k.id }); refresh(); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(fresh.key); setCopied(true); } catch { setCopied(false); }
  };
  const keys = (q.data?.keys || []).filter((k) => !k.revoked_at);
  return (
    <section className="sv2-keys" aria-label="Website keys">
      <h2 className="sv2-h">Website keys</h2>
      <p className="sv2-for">The campaign’s website sends sign-ups in with a key, from its server — never from a page in the visitor’s browser. INTEGRATIONS.md says what to send.</p>
      {fresh && (
        <div className="sv2-fresh" role="status">
          <p className="sv2-name">{fresh.name}: copy this key now — it won’t be shown again.</p>
          <code className="sv2-url sv2-key">{fresh.key}</code>
          <div className="sv2-fresh__acts">
            <button type="button" className="btn ops-tap" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}
      {keys.length > 0 && (
        <ul className="sv2-list">
          {keys.map((k) => (
            <li key={k.id} className="sv2-row">
              <div className="sv2-row__main">
                <span className="sv2-name">{k.name}</span>
                <p className="sv2-detail"><code className="sv2-url">{k.prefix}…</code> · made {when(k.created_at)} · {k.last_used_at ? `last used ${when(k.last_used_at)}` : 'not used yet'}</p>
              </div>
              <button type="button" className="btn btn-quiet ops-tap sv2-check" disabled={busy || !online} onClick={() => revoke(k)}>Revoke</button>
            </li>
          ))}
        </ul>
      )}
      <form className="sv2-make" onSubmit={make}>
        <div className="field">
          <label htmlFor="sv2-key-name">A new key, named for where it goes</label>
          <input id="sv2-key-name" className="input" maxLength={80} placeholder="Website" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" className="btn ops-solid ops-tap" disabled={busy || !online || !name.trim()}>Make a key</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
