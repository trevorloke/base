// "Sending domain" — in the Email row of Settings → Services (managers).
// The DNS records the email sender asks for, each with Copy and a chip (In ·
// Not found yet); the domain's DMARC record, which base.win looks up itself
// (no sender sets it up; Gmail, Yahoo and Outlook ask for it); and one
// button: Add domain while the sender doesn't hold the domain, Check again
// once its records are added at the DNS host.
//   GET /api/mail/domain · mail.domain.add · mail.domain.check (ext/mail)
// Nothing is kept: every look asks the sender. A key that may only send
// can't show the records, and the panel says so.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal } from './NoSignal.jsx';
import './sending-domain.css';

const KEY = ['mail', 'domain'];
const STATUS = {
  verified: ['chip chip-ok', 'Verified'],
  pending: ['chip chip-warn', 'Not verified yet'],
  failed: ['chip chip-danger', 'Not verified — check the records'],
};

function CopyButton({ value, what }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <button type="button" className="btn ops-tap sd-copy" onClick={copy}>
      {copied ? '✓ Copied' : 'Copy'}<span className="sv2-sr"> the {what}</span>
    </button>
  );
}

// One DNS record: what it is for and its type, where it goes, what it says.
function Record({ what, name, value, chip, copy = true, note = null }) {
  return (
    <li className="sd-rec">
      <div className="sd-rec__head">
        <span className="sd-rec__what">{what}</span>
        {chip}
      </div>
      <dl className="sd-rec__lines">
        <div><dt>Name</dt><dd><code className="sv2-url sd-val">{name}</code></dd></div>
        {value != null && (
          <div>
            <dt>Value</dt>
            <dd className="sd-rec__value">
              <code className="sv2-url sd-val">{value}</code>
              {copy && <CopyButton value={value} what={`${what} value`} />}
            </dd>
          </div>
        )}
      </dl>
      {note && <p className="sd-note">{note}</p>}
    </li>
  );
}

const inChip = (ok) => (ok
  ? <span className="chip chip-ok">In</span>
  : <span className="chip chip-warn">Not found yet</span>);

function Dmarc({ d }) {
  if (!d) return null;
  if (d.found) return <Record what="DMARC · TXT" name={d.at} value={d.value} chip={inChip(true)} copy={false} />;
  if (d.found === false) {
    return <Record what="DMARC · TXT" name={d.add.name} value={d.add.value} chip={inChip(false)} note="Gmail, Yahoo and Outlook ask bulk senders for this one." />;
  }
  return <Record what="DMARC · TXT" name="_dmarc" value={null} chip={<span className="chip">Couldn’t look it up</span>} />;
}

export default function SendingDomain({ online }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => apiGet('/mail/domain'), retry: false });
  const [busy, setBusy] = useState(null); // 'add' | 'check'
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);

  const head = (rest) => (
    <section className="sd" aria-label="Sending domain">
      <h3 className="sd-h">Sending domain</h3>
      {rest}
    </section>
  );
  if (q.isLoading) return head(<p className="sd-note">Loading…</p>);
  if (q.isError) {
    if (noSignal(q)) return head(<NoSignal />);
    return head(
      <p className="sd-note" role="status">
        Unavailable — {q.error.message}.{' '}
        <button type="button" className="btn ops-tap" disabled={q.isFetching || !online} onClick={() => q.refetch()}>{q.isFetching ? 'Trying…' : 'Try again'}</button>
      </p>,
    );
  }
  const d = q.data;
  if (!d?.provider) return null;
  if (!d.domain) return head(<p className="sd-note">Set MAIL_FROM to a sender on your own domain: its records show here.</p>);

  // Every record on the panel that can be told apart: in, or still to add.
  const count = (x) => ({
    lines: x.records.length + (x.dmarc && x.dmarc.found !== null ? 1 : 0),
    inNow: x.records.filter((r) => r.ok).length + (x.dmarc?.found ? 1 : 0),
  });
  const { lines, inNow } = count(d);
  const missing = lines - inNow;
  const run = async (which) => {
    setBusy(which); setSaid(null); setError(null);
    try {
      let next;
      if (which === 'add') next = await action('mail.domain.add', { domain: d.domain });
      else if (d.canManage) next = await action('mail.domain.check', {});
      else next = (await q.refetch({ throwOnError: true })).data; // a sending-only key: only the DMARC line can be looked at again
      if (d.canManage) qc.setQueryData(KEY, next);
      const now = count(next);
      setSaid(which === 'add' ? 'Added. Now add these records at your domain’s DNS host.'
        : now.inNow === now.lines ? 'Checked: every record is in.'
          : `Checked: ${now.inNow} of ${now.lines} in. A new record can take an hour to show.`);
    } catch (e) { setError(e.message); }
    setBusy(null);
  };
  // Nothing left to do: the sender has verified the domain and DMARC is in.
  const allIn = d.status === 'verified' && d.dmarc?.found === true;
  const [chipClass, chipWord] = STATUS[d.status] || [];

  return head(
    <>
      <p className="sd-domain">
        <strong>{d.domain}</strong>
        {d.found && chipWord && <span className={chipClass}>{chipWord}</span>}
        {d.found === false && <span className="chip chip-warn">Not added yet</span>}
      </p>
      {d.canManage === false && (
        <p className="sd-note">A sending-only key can’t show the records: use a full-access key, or {d.name}’s own screen.</p>
      )}
      {d.found === false && <p className="sd-note">{d.name} doesn’t have this domain yet.</p>}
      {d.found !== false && missing > 0 && (
        <p className="sd-note">{missing === 1 ? 'Add this record' : 'Add these'} at your domain’s DNS host, then tap Check again.</p>
      )}
      <ul className="sd-recs">
        {d.records.map((r) => (
          <Record key={`${r.purpose}-${r.type}-${r.name}`} what={`${r.purpose} · ${r.type}${r.priority != null ? ` · priority ${r.priority}` : ''}`} name={r.name} value={r.value} chip={inChip(r.ok)} />
        ))}
        <Dmarc d={d.dmarc} />
      </ul>
      <div className="sd-acts">
        {d.found === false && d.canManage
          ? <button type="button" className="btn btn-primary ops-tap" disabled={!!busy || !online} onClick={() => run('add')}>{busy === 'add' ? 'Adding…' : 'Add domain'}</button>
          : <button type="button" className={`btn ops-tap${allIn ? '' : ' btn-primary'}`} disabled={!!busy || !online} onClick={() => run('check')}>{busy === 'check' ? 'Checking…' : 'Check again'}</button>}
        {d.found && lines > 0 && !said && !error && <span className="sd-count">{inNow} of {lines} in</span>}
        {said && <span className="sd-count" role="status">{said}</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </>,
  );
}
