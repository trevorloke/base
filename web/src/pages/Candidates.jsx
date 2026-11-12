// Settings → Candidates (managers): the slate's seats. Each row is the
// candidate's name, "Mayor · City council" (office · race), and where they
// are: Signed in, Invited, or Not invited — with why, when their email is
// someone at the desk (a candidate is only ever a volunteer: ext/candidates).
// "Add a candidate" is the one primary button; a row opens in place with
// "Invite to the app" (or "New link", the link to copy and whether the
// email went), and under More: Unlink, and Remove (confirmed in place).
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { NoSignal, noSignal, useOnline, NeedsSignalLine } from '../components/NoSignal.jsx';
import { JoinLink } from './Team.jsx';
import './candidates.css';

const KEY = ['candidates'];
const statusOf = (c) => (c.signed_in ? ['Signed in', 'chip chip-ok']
  : c.invited_until ? ['Invited', 'chip'] : ['Not invited', 'chip chip-warn']);
const subOf = (c) => [c.office, c.race_label].filter(Boolean).join(' · ');
// Call time (ext/candidates): "18 to call · $1,250 pledged".
const callTimeLine = (t) => `${t.left.toLocaleString('en-CA')} to call · $${(t.pledged_cents / 100).toLocaleString('en-CA', { maximumFractionDigits: 2 })} pledged`;

function CandidateForm({ slates, onSave, onCancel, busy, online }) {
  const id = useId();
  const [f, setF] = useState({ name: '', office: '', race: '', email: '' });
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));
  const submit = (e) => {
    e.preventDefault();
    if (!f.name.trim()) return;
    onSave({ name: f.name.trim(), office: f.office.trim() || null, race: f.race || null, email: f.email.trim() || null });
  };
  return (
    <form className="can-form card" onSubmit={submit} aria-label="Add a candidate">
      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input id={`${id}-name`} className="input" maxLength={120} required autoFocus value={f.name} onChange={set('name')} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-office`}>Office</label>
        <input id={`${id}-office`} className="input" maxLength={80} placeholder="e.g. Mayor, Council" value={f.office} onChange={set('office')} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-race`}>Race</label>
        <select id={`${id}-race`} className="input" value={f.race} onChange={set('race')}>
          <option value="">No race</option>
          {slates.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-email`}>Email</label>
        <input id={`${id}-email`} className="input" type="email" maxLength={320} placeholder="For their invite" value={f.email} onChange={set('email')} />
      </div>
      <div className="can-form__acts">
        <button type="submit" className="btn btn-primary ot-btn-tap" disabled={busy || !online || !f.name.trim()}>Save</button>
        <button type="button" className="btn btn-quiet ot-btn-tap" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function CandidateRow({ c, open, onToggle, run, busy, online }) {
  const bodyId = useId();
  const [sent, setSent] = useState(null);
  const [more, setMore] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, cls] = statusOf(c);
  const invite = async () => {
    // Already on the team: in the seat now. Otherwise the link (and the email).
    const r = await run('candidate.invite', { id: c.id }, (x) => (x.linked ? `${c.name} is in the seat now`
      : x.email === 'sent' ? `Emailed ${c.name} their link` : `${c.name}’s link is ready to send`));
    if (r && !r.linked) setSent({ email: c.email, joinUrl: r.joinUrl, emailStatus: r.email, replaced: Boolean(c.invited_until) });
  };
  return (
    <li className="ot-item">
      <button type="button" className="ot-row can-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="ot-row__main">
          <span className="ot-row__name">{c.name}</span>
          {subOf(c) && <span className="ot-row__sub">{subOf(c)}</span>}
          {c.not_linked_reason && <span className="ot-row__sub can-why">{c.not_linked_reason}</span>}
          {c.calltime && <span className="ot-row__sub">{callTimeLine(c.calltime)}</span>}
        </span>
        <span className={cls}>{status}</span>
      </button>
      {open && (
        <div className="ot-body can-body" id={bodyId}>
          {!c.signed_in && (
            c.email ? (
              <button type="button" className="btn ot-btn-tap" disabled={busy || !online} onClick={invite}>
                {c.invited_until ? 'New link' : 'Invite to the app'}
              </button>
            ) : <p className="muted">Add their email to invite them.</p>
          )}
          {sent && <JoinLink sent={sent} testId="candidate-joinlink" />}
          <button type="button" className="btn btn-quiet disclose can-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>More</button>
          {more && (
            <div className="can-more__body">
              {c.signed_in && (
                <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy || !online}
                  onClick={() => run('candidate.unlink', { id: c.id }, () => `${c.name} is a volunteer again`)}>Unlink</button>
              )}
              {!confirming ? (
                <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy || !online} onClick={() => setConfirming(true)}>Remove</button>
              ) : (
                <div className="ot-confirm ot-confirm-danger" role="group" aria-label={`Remove ${c.name}`}>
                  <span>Remove {c.name}?</span>
                  <button type="button" className="btn ot-btn-tap ot-btn-danger" disabled={busy}
                    onClick={() => run('candidate.remove', { id: c.id }, () => `${c.name} removed`)}>Yes</button>
                  <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy} onClick={() => setConfirming(false)}>No</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function Candidates() {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: KEY, queryFn: () => apiGet('/candidates') });
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [said, setSaid] = useState('');
  const run = async (act, input, words) => {
    setBusy(true); setError(null); setSaid('');
    try {
      const r = await action(act, input);
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ['team'] });
      if (words) setSaid(words(r));
      return r;
    } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  };
  if (!q.data) {
    return noSignal(q) ? <NoSignal /> : q.isError ? <p className="error">{q.error.message}</p> : <p className="muted">Loading…</p>;
  }
  const { candidates, slates } = q.data;
  const save = async (input) => {
    const r = await run('candidate.save', input, () => `${input.name} added`);
    if (r) { setAdding(false); setOpenId(r.candidate.id); }
  };
  return (
    <div className="can">
      {!adding && (
        <button type="button" className="btn btn-primary ot-btn-tap" disabled={!online} onClick={() => { setAdding(true); setSaid(''); }}>Add a candidate</button>
      )}
      {adding && <CandidateForm slates={slates} busy={busy} online={online} onSave={save} onCancel={() => setAdding(false)} />}
      {!online && <NeedsSignalLine>Changing candidates needs signal</NeedsSignalLine>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="ot-sr" role="status" aria-live="polite">{said}</p>
      {said && <p className="muted can-said" aria-hidden="true">{said}</p>}
      {candidates.length === 0 && !adding && <p className="muted">No candidates yet. Each one gets their own day on their phone.</p>}
      <ul className="ot-list">
        {candidates.map((c) => (
          <CandidateRow key={c.id} c={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)}
            run={run} busy={busy} online={online} />
        ))}
      </ul>
    </div>
  );
}
