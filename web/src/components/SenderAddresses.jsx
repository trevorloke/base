// "From addresses" — in the Email row of Settings → Services (managers).
// The addresses a send may go from, all at MAIL_FROM's own domain (the
// sender verifies the domain, not each address). The first row is MAIL_FROM
// itself, always there. Each row: "Default for email" / "Default for press"
// chips, Remove (asked in place), and under More the two "Make default"
// buttons. Add an address: name and address, then Save; a refusal is the
// server's own sentence. With no press default yet, one tap offers
// media@<domain>, and saving it makes it the press default.
//   GET /api/senders · sender.save · sender.remove · sender.default (ext/senders)
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { LOADING, Unavailable } from './AudienceBits.jsx';
import { NeedsSignal } from './NoSignal.jsx';
import { SENDERS_KEY, useSenders } from './SenderPick.jsx';
import './senders.css';

function RowMore({ children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" className="btn btn-quiet ops-tap disclose" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>More</button>
      {open && <div id={id} className="sa-acts">{children}</div>}
    </>
  );
}

function Row({ s, system, defaults, busy, run }) {
  const [removing, setRemoving] = useState(false);
  const id = system ? null : s.id;
  const isEmail = (defaults.email || null) === id;
  const isPress = (defaults.press || null) === id;
  return (
    <li className="sa-row" data-testid="sender-row">
      <div className="sa-row__head">
        <span className="sa-name">{s.name || 'The campaign'}</span>
        <span className="sa-addr">{s.email}</span>
      </div>
      <div className="sa-chips">
        {system && <span className="chip">Always available</span>}
        {isEmail && <span className="chip chip-ok">Default for email</span>}
        {isPress && <span className="chip chip-ok">Default for press</span>}
      </div>
      {!removing && (
        <div className="sa-acts">
          {!system && <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setRemoving(true)}>Remove</button>}
          {(!isEmail || !isPress) && (
            <RowMore>
              {!isPress && <button type="button" className="btn ops-tap" disabled={busy} onClick={() => run('sender.default', { use: 'press', id })}>Make default for press</button>}
              {!isEmail && <button type="button" className="btn ops-tap" disabled={busy} onClick={() => run('sender.default', { use: 'email', id })}>Make default for email</button>}
            </RowMore>
          )}
        </div>
      )}
      {removing && (
        <div className="ot-confirm sa-acts" role="group" aria-label="Confirm remove">
          <span>Remove {s.email}?{isEmail || isPress ? ' Its sends go from the campaign’s address again.' : ''}</span>
          <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={async () => { if (await run('sender.remove', { id: s.id })) setRemoving(false); }}>Yes, remove</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setRemoving(false)}>No</button>
        </div>
      )}
    </li>
  );
}

export default function SenderAddresses({ online = true }) {
  const qc = useQueryClient();
  const q = useSenders();
  const [form, setForm] = useState(null);
  const [said, setSaid] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (name, input) => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await action(name, input);
      await qc.invalidateQueries({ queryKey: SENDERS_KEY });
      return r || true;
    } catch (e) {
      setSaid({ ok: false, line: e.message });
      return null;
    } finally {
      setBusy(false);
    }
  };
  const head = (body) => (
    <section className="sa" aria-label="From addresses">
      <h3 className="sa-h">From addresses</h3>
      {body}
    </section>
  );
  if (q.isPending) return head(<p className="sa-help" role="status">{LOADING}</p>);
  if (q.isError) return head(<p className="sa-help" role="status"><Unavailable onRetry={() => q.refetch()} /></p>);
  const d = q.data;
  if (!d.domain) return head(<p className="sa-help">Set MAIL_FROM to an address on your own domain first.</p>);
  const defaults = d.defaults || {};
  const suggest = `media@${d.domain}`;
  const offer = !defaults.press && !(d.senders || []).some((s) => s.email === suggest) && !form;
  const save = async (e) => {
    e.preventDefault();
    const r = await run('sender.save', { name: form.name.trim(), email: form.email.trim() });
    if (!r) return;
    if (form.press) await run('sender.default', { use: 'press', id: r.sender.id });
    setSaid({ ok: true, line: `Added ${r.sender.email}${form.press ? ' — the default for press' : ''}` });
    setForm(null);
  };
  return head(
    <>
      <p className="sa-help">Who a newsletter, an email to a list or a press release is from. Replies go to that address’s own mailbox.</p>
      <ul className="sa-list">
        {d.system && <Row s={d.system} system defaults={defaults} busy={busy || !online} run={run} />}
        {(d.senders || []).map((s) => <Row key={s.id} s={s} defaults={defaults} busy={busy || !online} run={run} />)}
      </ul>
      {offer && (
        <div className="sa-acts">
          <button type="button" className="btn ops-tap sa-suggest" onClick={() => { setSaid(null); setForm({ name: d.system?.name ? `${d.system.name} Media` : 'Media', email: suggest, press: true }); }}>
            Add {suggest} for press
          </button>
        </div>
      )}
      {form ? (
        <form className="sa-form" onSubmit={save} aria-label="Add an address">
          <div className="field">
            <label htmlFor="sa-name">Name</label>
            <input id="sa-name" className="input" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="sa-email">Address</label>
            <input id="sa-email" className="input" type="email" required maxLength={320} autoCapitalize="none" spellCheck={false}
              value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={`name@${d.domain}`} />
          </div>
          <button type="submit" className="btn ops-tap" disabled={busy || !online || !form.name.trim() || !form.email.trim()}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setForm(null)}>Cancel</button>
          <p className="sa-help sa-full">Addresses at {d.domain} only.</p>
        </form>
      ) : (
        (d.senders || []).length < 10 && (
          <div className="sa-acts">
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => { setSaid(null); setForm({ name: '', email: '', press: false }); }}>Add an address</button>
          </div>
        )
      )}
      {!online && <NeedsSignal />}
      {said && <p className={`sa-said ${said.ok ? 'is-ok' : 'is-bad'}`} role="status">{said.line}</p>}
    </>,
  );
}
