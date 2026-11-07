// One mailout (/mailouts/:id — the desk, the Outreach area): the words and
// who it goes to, then the three steps to the post office (ext/mailouts):
//   1. Get the list ready — the people it goes to, fixed (only those with a
//      street address who may be mailed; the rest are counted as left out)
//   2. Print — letters, #10 envelopes, Avery address labels (5160, 5163),
//      return-address labels (5167), 6×4 postcards; each opens a page to
//      print at 100%
//   3. Mark as mailed — a thank-you letter's gifts are thanked by letter
// Before the list is ready, "Print a sample" shows the layout with a
// made-up person.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { renderMarkdown } from '@starbase/shared/markdown';
import './shifts.css';
import './mailouts.css';

export const KIND_WORDS = { letter: 'Letter', postcard: 'Postcard', labels: 'Labels only' };
export const STATUS_WORDS = { draft: 'Draft', ready: 'Ready to print', mailed: 'In the mail' };
const FILLS = [['{{first_name}}', '+ First name'], ['{{name}}', '+ Full name'], ['{{campaign}}', '+ Campaign']];
const THANKS_FILLS = [['{{amount}}', '+ Gift amount'], ['{{gift_date}}', '+ Gift date']];
// What to print, by kind: [what, label, hint].
const PRINTS = {
  letter: [['letters', 'Letters', 'Letter paper, one per person'], ['envelopes', '#10 envelopes', 'Fed through the envelope tray'], ['labels-5160', 'Address labels', 'Avery 5160 · 30 a sheet'], ['labels-5163', 'Big address labels', 'Avery 5163 · 10 a sheet'], ['return-5167', 'Return-address labels', 'Avery 5167 · 80 a sheet']],
  postcard: [['postcards', 'Postcards', '6 × 4 in · print both sides'], ['labels-5160', 'Address labels', 'Avery 5160 · 30 a sheet'], ['return-5167', 'Return-address labels', 'Avery 5167 · 80 a sheet']],
  labels: [['labels-5160', 'Address labels', 'Avery 5160 · 30 a sheet'], ['labels-5163', 'Big address labels', 'Avery 5163 · 10 a sheet'], ['envelopes', '#10 envelopes', 'Fed through the envelope tray'], ['return-5167', 'Return-address labels', 'Avery 5167 · 80 a sheet']],
};
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
// How the words read for a made-up person (the page's preview).
const sampleFill = (body, campaign, r) => String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k) => ({
  first_name: r?.first_name || 'Sam', last_name: r?.last_name || 'Sample', name: r?.name || 'Sam Sample', campaign: campaign || '',
  amount: r?.amount_cents != null ? `$${(r.amount_cents / 100).toFixed(2)}` : '$50.00',
  gift_date: new Date(`${r?.gift_date || new Date().toISOString().slice(0, 10)}T12:00:00`).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
}[k] ?? all));
const printUrl = (id, what, sample) => `/api/mailouts/${id}/print?what=${what}${sample ? '&sample=1' : ''}`;

export function MailoutForm({ mailout, lists, mailFrom, onSaved, onCancel }) {
  const [f, setF] = useState(() => ({
    name: mailout?.name || '', kind: mailout?.kind || 'letter', body: mailout?.body || '',
    to: mailout?.audience?.thanks ? 'thanks' : mailout?.audience?.list_id || '',
    from: mailout?.return_address ?? mailFrom ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const insert = (t) => {
    const el = ref.current;
    const at = el ? el.selectionStart : f.body.length;
    const end = el ? el.selectionEnd : f.body.length;
    setF((x) => ({ ...x, body: `${x.body.slice(0, at)}${t}${x.body.slice(end)}` }));
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(at + t.length, at + t.length); } });
  };
  const save = async (e) => {
    e.preventDefault();
    if (!f.to) { setError('Who it goes to: a list, or the donors to thank'); return; }
    setBusy(true); setError(null);
    try {
      const r = await action('mailout.save', {
        id: mailout?.id, name: f.name.trim(), kind: f.kind, body: f.body,
        audience: f.to === 'thanks' ? { thanks: true } : { list_id: f.to },
        return_address: f.from.trim() || null,
      });
      onSaved(r.mailout);
    } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <form className="card ml-form" onSubmit={save} aria-label={mailout ? 'Edit mailout' : 'New mailout'}>
      <div className="form-row">
        <div className="field" style={{ flex: '2 1 240px' }}>
          <label htmlFor="ml-name">Name</label>
          <input id="ml-name" className="input" required autoFocus={!mailout} maxLength={160} placeholder="Fall newsletter by mail" value={f.name} onChange={set('name')} />
        </div>
        <div className="field" style={{ flex: '1 1 160px' }}>
          <label htmlFor="ml-kind">What</label>
          <select id="ml-kind" className="input" value={f.kind} onChange={set('kind')}>
            {Object.entries(KIND_WORDS).map(([k, w]) => <option key={k} value={k}>{w}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="ml-to">To</label>
        <select id="ml-to" className="input" value={f.to} onChange={set('to')}>
          <option value="">Choose…</option>
          <option value="thanks">Donors to thank (one letter per gift not yet thanked)</option>
          {(lists || []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span className="ops-meta">Only people with a street address go in the mail; do-not-mail and do-not-contact are left out. <Link to="/lists">Lists</Link></span>
      </div>
      {f.kind !== 'labels' && (
        <div className="field">
          <label htmlFor="ml-body">{f.kind === 'postcard' ? 'The message side' : 'The letter'}</label>
          <div className="ml-fills">
            {[...FILLS, ...(f.to === 'thanks' ? THANKS_FILLS : [])].map(([t, l]) => <button key={t} type="button" className="btn btn-quiet ops-tap" onClick={() => insert(t)}>{l}</button>)}
          </div>
          <textarea id="ml-body" ref={ref} className="input ml-body" rows={f.kind === 'postcard' ? 6 : 12} maxLength={20000}
            placeholder={'Dear {{first_name}},\n\n…'} value={f.body} onChange={set('body')} />
          <span className="ops-meta">Blank line between paragraphs; **bold**; - for a list.{f.kind === 'postcard' ? ' Keep it short: a postcard holds about 80 words.' : ''}</span>
        </div>
      )}
      <div className="field">
        <label htmlFor="ml-from">Return address</label>
        <textarea id="ml-from" className="input" rows={3} maxLength={400} placeholder={'Imagine Surrey\n123 Campaign Way\nSurrey BC  V3T 0A1'} value={f.from} onChange={set('from')} />
        <span className="ops-meta">One line each. Remembered for the next mailout.</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy || !f.name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        {onCancel && <button type="button" className="btn btn-quiet ops-tap" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function Mailout() {
  const { id } = useParams();
  const { me } = useOutletContext() ?? {};
  const qc = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const q = useQuery({ queryKey: ['mailouts', id], queryFn: () => apiGet(`/mailouts/${id}`) });
  const all = useQuery({ queryKey: ['mailouts'], queryFn: () => apiGet('/mailouts') });
  const lists = useQuery({ queryKey: ['lists', 'all'], queryFn: () => apiGet('/lists') });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null); // 'mailed' | 'delete'
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setEditing(false); }, [id]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['mailouts'] }); qc.invalidateQueries({ queryKey: ['stewardship'] }); };
  const run = async (name, ok) => {
    setBusy(true); setError(null);
    try { const r = await action(name, { id }); setAsk(null); setSaid(ok(r)); refresh(); return r; } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  };

  const head = <Link to="/outreach/mail" className="ops-back">← Mail</Link>;
  if (!q.data) return <div className="ops-page ml-page">{head}{noSignal(q) ? <NoSignal /> : q.isError ? <p className="error">{q.error.message}</p> : <p className="muted">Loading…</p>}</div>;
  const { mailout: m, recipients, preview } = q.data;
  const prints = PRINTS[m.kind] || PRINTS.letter;

  return (
    <div className="ops-page ml-page">
      {head}
      <div className="ops-head">
        <h1>{m.name}</h1>
        <span className={`chip ml-status ml-status--${m.status}`}>{STATUS_WORDS[m.status]}</span>
      </div>
      <p className="ml-meta muted">{KIND_WORDS[m.kind]} · {m.audience?.thanks ? 'donors to thank' : (lists.data?.lists || []).find((l) => l.id === m.audience?.list_id)?.name || 'a list'}</p>
      {said && <p className="ops-done" role="status">{said}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {editing ? (
        <MailoutForm mailout={m} lists={lists.data?.lists} mailFrom={all.data?.mail_from}
          onSaved={() => { setEditing(false); setSaid('✓ Saved'); refresh(); }} onCancel={() => setEditing(false)} />
      ) : (
        <>
          {m.kind !== 'labels' && m.body && (
            <>
              <span className="eyebrow">How it reads for {recipients[0]?.name || 'a sample person'}</span>
              {/* eslint-disable-next-line react/no-danger -- the site's own safe renderer: every character is escaped first */}
              <div className={`card ml-preview ml-preview--${m.kind}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(sampleFill(m.body, me?.workspace?.name, recipients[0])) }} />
            </>
          )}
          {m.status !== 'mailed' && <button type="button" className="btn btn-quiet ops-tap" disabled={!online} onClick={() => setEditing(true)}>Edit</button>}

          <ol className="ml-steps">
            <li className={`card ml-step${m.status === 'draft' ? ' is-now' : ''}`}>
              <h2>1 · Get the list ready</h2>
              {m.status === 'draft' ? (
                <>
                  <p>{preview?.error ? preview.error : <>Goes to <strong className="mono">{preview?.recipients ?? '…'}</strong>{preview?.left_out ? <> · <span className="muted">{preview.left_out} left out (no street address, or do-not-mail)</span></> : null}{preview?.first?.length ? <span className="muted"> · {preview.first.join(', ')}{preview.recipients > preview.first.length ? '…' : ''}</span> : null}</>}</p>
                  <button type="button" className="btn btn-primary ops-tap" disabled={busy || !online || !preview?.recipients} onClick={() => run('mailout.ready', (r) => `✓ Ready: ${r.recipients} to print${r.left_out ? ` · ${r.left_out} left out` : ''}`)}>Get the list ready</button>
                </>
              ) : (
                <p><strong className="mono">{recipients.length}</strong> {recipients.length === 1 ? 'person' : 'people'}{m.left_out ? <span className="muted"> · {m.left_out} left out</span> : null}{m.status === 'ready' && <> · <button type="button" className="ml-link" disabled={busy || !online} onClick={() => run('mailout.ready', (r) => `✓ Made ready again: ${r.recipients}`)}>Make it again</button></>}</p>
              )}
            </li>
            <li className={`card ml-step${m.status === 'ready' ? ' is-now' : ''}`}>
              <h2>2 · Print</h2>
              <ul className="ml-prints">
                {prints.map(([what, label, hint]) => (
                  <li key={what}>
                    {m.status === 'draft' && what !== 'return-5167'
                      ? <a className="btn ops-tap" href={printUrl(m.id, what, true)} target="_blank" rel="noopener noreferrer">{label} — sample</a>
                      : <a className={`btn ops-tap${what === prints[0][0] && m.status === 'ready' ? ' btn-primary' : ''}`} href={printUrl(m.id, what)} target="_blank" rel="noopener noreferrer">{label}</a>}
                    <span className="ops-meta">{hint}</span>
                  </li>
                ))}
              </ul>
              <p className="ops-meta">Each opens a page to print. Print at 100% (not “fit to page”), with no headers or footers.</p>
            </li>
            <li className={`card ml-step${m.status === 'mailed' ? ' is-now' : ''}`}>
              <h2>3 · In the mail</h2>
              {m.status === 'mailed' ? <p>✓ Mailed {fmtDay(m.mailed_at)}{m.audience?.thanks ? ' — their gifts are marked thanked by letter.' : '.'}</p>
                : ask === 'mailed' ? (
                  <div className="ops-confirm" role="group" aria-label="Mark as mailed">
                    <span>Everything printed and in the mail?{m.audience?.thanks ? ' Each gift is marked thanked by letter.' : ''}</span>
                    <button type="button" className="btn btn-primary ops-tap" disabled={busy} onClick={() => run('mailout.mailed', (r) => `✓ In the mail${r.thanked ? ` · ${r.thanked} gifts thanked` : ''}`)}>Yes, mailed</button>
                    <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(null)}>Not yet</button>
                  </div>
                ) : <button type="button" className="btn ops-tap" disabled={m.status !== 'ready' || !online} onClick={() => setAsk('mailed')}>Mark as mailed</button>}
            </li>
          </ol>
          {recipients.length > 0 && (
            <details className="ml-who">
              <summary>Who it goes to · {recipients.length}</summary>
              <ul>{recipients.map((r) => <li key={r.position}><Link to={r.person_id ? `/people/${r.person_id}` : '#'}>{r.name}</Link> <span className="muted">· {r.line1}, {r.city} {r.province} {r.postal}</span></li>)}</ul>
            </details>
          )}
          {m.status !== 'mailed' && (ask === 'delete' ? (
            <div className="ops-confirm ml-delete" role="group" aria-label="Delete mailout">
              <span>Delete this mailout?</span>
              <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={async () => { if (await run('mailout.delete', () => '')) navigate('/outreach/mail'); }}>Delete</button>
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsk(null)}>Keep it</button>
            </div>
          ) : <button type="button" className="btn btn-quiet ops-tap ml-delete" onClick={() => setAsk('delete')}>Delete</button>)}
        </>
      )}
    </div>
  );
}
