// Letters to the editor and op-eds — the writer's own (ext/letters).
//   /letters        Your letters: each with one fact (New · Working on it ·
//                   Ready to send · Sent · Published · Declined · Withdrawn,
//                   or "Not printed at X") and "Reply" when the campaign
//                   wrote back. "Write a letter".
//   /letters/new    Write a letter: Letter · Op-ed, the paper(s) with their
//                   rules, the text with its count against the paper's
//                   limit, "These words are the campaign's" when it repeats
//                   the talking points, the sign-off under More details.
//                   "Send to the campaign" goes through the outbox, so it
//                   works with no signal; the form is kept on this phone
//                   (components/letterDrafts.js) until the server has it.
//   /letters/:id    a letter's page (pages/LetterPage.jsx)
// The writer always sends it themselves, from their own email: the campaign
// suggests, never sends under their name.
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sharedRuns } from '@starbase/shared/letters';
import { apiGet } from '../api.js';
import { newClientId, onOutboxSent, queueAction } from '../offline.js';
import { showingCopy } from '../components/OfflineCache.js';
import {
  BODY_MAX, CampaignWords, Count, KIND_WORDS, LOADING, More, STATUS_WORDS, Unavailable, firstWords, rulesLine, useLetterOutlets,
} from '../components/LetterBits.jsx';
import { clearDraft, readDraft, writeDraft } from '../components/letterDrafts.js';
import { queuedText } from '../components/queued.js';
import LetterPage from './LetterPage.jsx';
import './shifts.css';
import './letters.css';

export default function Letters({ view }) {
  const { me } = useOutletContext() ?? {};
  const { id } = useParams();
  const location = useLocation();
  // Keyed by the visit: "Back to draft" opening this same screen reads the draft again.
  if (view === 'new') return <WriteLetter key={location.key} me={me} />;
  if (view === 'one') return <LetterPage key={id} me={me} id={id} />;
  return <LettersList me={me} />;
}

// ── Your letters ──
const chipOf = (l) => (l.status === 'ready' && l.not_printed_at ? `Not printed at ${l.not_printed_at}` : STATUS_WORDS[l.status] || l.status);
function LettersList({ me }) {
  const q = useQuery({ queryKey: ['letters', 'mine'], queryFn: () => apiGet('/letters/mine') });
  const draft = readDraft('draft');
  const letters = q.data?.letters || [];
  const write = <Link className="btn btn-primary ops-tap" to="/letters/new">Write a letter</Link>;
  return (
    <div className="ops-page lt-page">
      <Link to="/" className="ops-back">← Today</Link>
      <div className="lt-head">
        <h1>Letters</h1>
        {letters.length > 0 && write}
      </div>
      {draft && String(draft.body || '').trim() && (
        <ul className="ops-rows">
          <li><Link className="ops-row lt-row" to="/letters/new">
            <span className="ops-row__main"><span className="ops-row__name">{draft.title || firstWords(draft.body)}</span></span>
            <span className="chip">{draft.queued ? 'Waiting to send' : 'Not sent yet'}</span>
          </Link></li>
        </ul>
      )}
      {q.isPending && !q.data && <p className="ops-meta" role="status">{me ? LOADING : ''}</p>}
      {q.isError && !q.data && <p className="error" role="alert"><Unavailable onRetry={() => q.refetch()} /></p>}
      {q.isSuccess && letters.length === 0 && (
        <div className="lt-empty">
          <p>Write to the paper in your own words.</p>
          {write}
        </div>
      )}
      {letters.length > 0 && (
        <ul className="ops-rows" aria-label="Your letters">
          {letters.map((l) => (
            <li key={l.id}>
              <Link className="ops-row lt-row" to={`/letters/${l.id}`}>
                <span className="ops-row__main">
                  <span className="ops-row__name">{l.title || firstWords(l.first_words) || KIND_WORDS[l.kind]}</span>
                  {l.outlets.length > 0 && <span className="ops-row__sub">{l.outlets.map((o) => o.name).join(' · ')}</span>}
                </span>
                {l.unseen && <span className="lt-reply"><span className="lt-dot" aria-hidden="true" />Reply</span>}
                <span className={`chip${l.not_printed_at ? ' chip-warn' : ''}`}>{chipOf(l)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Write a letter ──
const BLANK = { kind: 'letter', title: '', body: '', outlet_ids: [], sign: {}, disclose_line: undefined, email_me: true };
const SIGN_FIELDS = [['name', 'Name', 120], ['city', 'City', 80], ['phone', 'Phone', 40], ['address', 'Address', 300]];

function WriteLetter({ me }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState(() => ({ ...BLANK, ...(readDraft('draft') || {}) }));
  const [error, setError] = useState(null);
  const [said, setSaid] = useState(null);
  const [busy, setBusy] = useState(false);
  const outletsQ = useLetterOutlets(me, f.kind);
  const data = outletsQ.data;
  const outlets = data?.outlets || [];
  const you = data?.you || { sign: {} };
  const queued = Boolean(f.queued);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  // Kept on this phone on every change (a moment after), for this sign-in only.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    const t = setTimeout(() => {
      if (f.queued || String(f.body).trim() || String(f.title).trim()) writeDraft('draft', f); else clearDraft('draft');
    }, 500);
    return () => clearTimeout(t);
  }, [f]);
  // The server has it (sent now, or later from the outbox): open the letter.
  useEffect(() => onOutboxSent(({ name, input, result }) => {
    if (name !== 'myletter.submit' || !f.queued || input?.client_id !== f.queued) return;
    clearDraft('draft');
    qc.invalidateQueries({ queryKey: ['letters'] });
    qc.invalidateQueries({ queryKey: ['brief'] });
    if (result?.letter?.id) navigate(`/letters/${result.letter.id}`, { replace: true, state: { dropped: result.dropped_outlets || [] } });
  }), [f.queued, navigate, qc]);

  const picked = f.outlet_ids.map((id) => outlets.find((o) => o.id === id)).filter(Boolean);
  const top = picked[0] || null;
  const togglePaper = (id) => set({
    outlet_ids: f.outlet_ids.includes(id) ? f.outlet_ids.filter((x) => x !== id) : f.outlet_ids.length >= 3 ? f.outlet_ids : [...f.outlet_ids, id],
  });
  const disclose = f.disclose_line ?? Boolean(you.desk || you.candidate);
  const asksAddress = picked.some((o) => o.asks_address);
  const signVal = (k) => f.sign[k] ?? you.sign?.[k] ?? '';

  // Where it repeats the talking points (a moment after typing; offline too).
  const [run, setRun] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => setRun(data?.points ? sharedRuns(f.body, data.points)?.text || null : null), 400);
    return () => clearTimeout(t);
  }, [f.body, data?.points]);

  const submit = async (e) => {
    e.preventDefault();
    if (queued || busy) return;
    setError(null); setSaid(null);
    if (!f.body.trim()) { setError('Write your letter first'); return; }
    const cid = newClientId();
    const sign = Object.fromEntries(Object.entries(f.sign).map(([k, v]) => [k, String(v).trim()]));
    const input = {
      client_id: cid, kind: f.kind, title: f.title.trim() || undefined, body: f.body,
      outlet_ids: f.outlet_ids.filter((id) => outlets.some((o) => o.id === id) || !data),
      ...(Object.keys(sign).length ? { sign } : {}),
      disclose_line: disclose, email_me: f.email_me,
    };
    const held = { ...f, queued: cid };
    writeDraft('draft', held); // never lost between the tap and the outbox
    setF(held);
    setBusy(true);
    try {
      const r = await queueAction('myletter.submit', input);
      if (r.queued) {
        setSaid(queuedText(r, 'Your letter is'));
      } else {
        clearDraft('draft');
        qc.invalidateQueries({ queryKey: ['letters'] });
        navigate(`/letters/${r.result.letter.id}`, { replace: true, state: { dropped: r.result.dropped_outlets || [] } });
      }
    } catch (err) {
      const back = { ...f };
      delete back.queued;
      writeDraft('draft', back);
      setF(back);
      setError(err.message || 'Not sent — try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ops-page lt-page">
      <Link to="/letters" className="ops-back">← Letters</Link>
      <h1>Write a letter</h1>
      {showingCopy(outletsQ) && <p className="ops-meta">No signal — your letter is kept here and sends when you’re back online.</p>}
      <form className="card lt-form" onSubmit={submit} aria-label="Your letter">
        <fieldset className="lt-fs" disabled={queued}>
          <div className="lt-chips" role="radiogroup" aria-label="Kind">
            {Object.entries(KIND_WORDS).map(([k, w]) => (
              <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={`chip lt-chip${f.kind === k ? ' is-on' : ''}`}
                onClick={() => f.kind !== k && set({ kind: k, outlet_ids: [] })}>{w}</button>
            ))}
          </div>

          <div className="field">
            <span className="lt-label" id="lt-papers">Paper</span>
            {outletsQ.isPending && !data && <p className="ops-meta" role="status">{LOADING}</p>}
            {outletsQ.isError && !data && <p className="ops-meta" role="status"><Unavailable onRetry={() => outletsQ.refetch()} /></p>}
            {data && outlets.length === 0 && <p className="ops-meta">The campaign hasn’t added papers yet — send it anyway.</p>}
            {outlets.length > 0 && (
              <div className="lt-chips" role="group" aria-labelledby="lt-papers">
                {outlets.map((o) => {
                  const at = f.outlet_ids.indexOf(o.id);
                  return (
                    <button key={o.id} type="button" aria-pressed={at >= 0} className={`chip lt-chip${at >= 0 ? ' is-on' : ''}`} onClick={() => togglePaper(o.id)}>
                      {at >= 0 && f.outlet_ids.length > 1 && <span className="lt-n" aria-hidden="true">{at + 1}</span>}{o.name}
                    </button>
                  );
                })}
              </div>
            )}
            {top && (
              <p className="lt-rules">
                {rulesLine(top) && <span>{rulesLine(top)}</span>}
                {top.rules && <span className="lt-rules__line">{top.rules}</span>}
              </p>
            )}
          </div>

          {picked.some((o) => o.no_candidates) && you.candidate && <p className="lt-remind">This paper doesn’t print pieces by candidates.</p>}
          {picked.some((o) => o.disclose) && (
            <div className="lt-remind">
              <p>This paper asks you to say if you work with a campaign.</p>
              <label className="lt-check"><input type="checkbox" checked={disclose} onChange={(e) => set({ disclose_line: e.target.checked })} />
                <span>Add a line: I volunteer with {data?.campaign_name || 'the campaign'}</span></label>
            </div>
          )}

          <div className="field">
            <label htmlFor="lt-body">{f.kind === 'op_ed' ? 'Your op-ed' : 'Your letter'}</label>
            <textarea id="lt-body" className="input lt-body" rows={12} maxLength={BODY_MAX} value={f.body}
              onChange={(e) => set({ body: e.target.value })} placeholder="Write it, or paste it here" />
            <Count text={f.body} outlet={top} />
            {f.body.length >= BODY_MAX && <p className="ops-meta" role="status">That’s the most one letter can hold</p>}
            <CampaignWords run={run} />
          </div>

          <div className="field">
            <label htmlFor="lt-title">Headline idea <span className="muted">(optional)</span></label>
            <input id="lt-title" className="input" maxLength={200} value={f.title} onChange={(e) => set({ title: e.target.value })} />
          </div>

          <More label="More details">
            <h2 className="lt-sub">For the paper to check it’s you</h2>
            <p className="ops-meta">Papers print your name and city only.</p>
            <div className="form-row">
              {SIGN_FIELDS.filter(([k]) => k !== 'address' || asksAddress).map(([k, label, max]) => (
                <div key={k} className="field">
                  <label htmlFor={`lt-s-${k}`}>{label}</label>
                  <input id={`lt-s-${k}`} className="input" maxLength={max} type={k === 'phone' ? 'tel' : 'text'} value={signVal(k)}
                    onChange={(e) => set({ sign: { ...f.sign, [k]: e.target.value } })} />
                </div>
              ))}
            </div>
            <label className="lt-check"><input type="checkbox" checked={f.email_me} onChange={(e) => set({ email_me: e.target.checked })} />
              <span>Email me when the campaign replies</span></label>
            {data?.points && (
              <>
                <h2 className="lt-sub">Ideas from the campaign</h2>
                <p className="ops-meta">Say it your way — papers turn away copied words.</p>
                <p className="lt-points">{data.points}</p>
              </>
            )}
          </More>
        </fieldset>

        {error && <p className="error" role="alert">{error}</p>}
        {queued ? (
          <p className="ops-done ops-done--wait" role="status">{said || 'Waiting to send — it goes to the campaign when you’re back online.'}</p>
        ) : (
          <div className="ops-actions">
            <button type="submit" className="btn btn-primary ops-tap ops-wide" disabled={busy}>{busy ? 'Sending…' : 'Send to the campaign'}</button>
          </div>
        )}
      </form>
    </div>
  );
}
