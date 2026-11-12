// Phone banks (ext/banks). The desk: every bank, a new one — from a List
// (Call this list: everyone on it who may be called, however many; whoever
// leaves the list leaves the calls not yet made) or picked from the people
// list (a search, a rating, a tag — everyone with a phone who matches) — its
// numbers handed to a caller or split across a team, who has what and how
// far they are, numbers taken back, the bank closed. A volunteer here sees
// their own call lists; each opens on Calls (/calls?bank=…), where a logged
// call crosses the number off.
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { codesInBand } from '@starbase/shared/scale';
import { ApiError, action, apiGet } from '../api.js';
import { RatingChip, useScale } from '../components/RatingButtons.jsx';
import { useWebDid, webChoices } from '../components/FieldCuts.jsx';
import SendToCallHub from '../components/SendToCallHub.jsx';
import { LOADING, Unavailable, useListCounts, useListNames } from '../components/AudienceBits.jsx';
import './dashboard.css';
import './shifts.css'; // the ops-* pieces: a full-height button, a row of actions, a quiet line
import './banks.css';
import './banks-calltime.css';
import '../editor.css';

const DESK = ['manager', 'staff', 'treasurer'];
const plural = (n, w, many = `${w}s`) => (n === 1 ? w : many);
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const BANDS = [['', 'Any rating'], ['support', 'Support'], ['undecided', 'Undecided'], ['opposed', 'Opposed'], ['unrated', 'Unrated']];

export default function Banks() {
  const { me } = useOutletContext();
  const { id } = useParams();
  const desk = DESK.includes(me?.role);
  if (!desk) return <Mine />;
  if (id === 'new') return <NewBank />;
  if (id) return <Bank id={id} />;
  return <List />;
}

const useSaver = (keys = [['banks']]) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (name, input) => {
    setBusy(true); setError(null);
    try {
      const r = await action(name, input);
      await Promise.all(keys.map((k) => queryClient.invalidateQueries({ queryKey: k })));
      return r;
    } catch (e) { setError(e instanceof ApiError ? e.message : 'No signal — try again'); return null; } finally { setBusy(false); }
  };
  return { run, busy, error };
};

// ── Your call lists (any role) ──
export function Mine({ embedded = false }) {
  const q = useQuery({ queryKey: ['banks', 'mine'], queryFn: () => apiGet('/banks/mine'), staleTime: 15_000 });
  const banks = q.data?.banks || [];
  if (embedded && !banks.length) return null;
  return (
    <div className={embedded ? 'bk-mine bk-mine--embedded' : 'bk'}>
      {!embedded && <div className="page-head"><div><span className="eyebrow">Calls</span><h1>Your call lists</h1></div></div>}
      {embedded && <h2 className="today-h">Your call lists</h2>}
      {q.isError && !q.data && <p className="error">{q.error.message}</p>}
      {!embedded && q.data && !banks.length && <div className="pp-empty"><p>No numbers handed to you right now. <Link to="/calls">Calls</Link> has everyone you may call.</p></div>}
      <ul className="bk-list">
        {banks.map((b) => (
          <li key={b.id}>
            <Link className="bk-row" to={`/calls?bank=${b.id}&channel=phone`}>
              <span className="bk-row__main">
                <span className="bk-row__name">{b.name}</span>
                <span className="bk-row__sub">{b.left ? `${num(b.left)} to call` : 'All done'} · {num(b.done)} of {num(b.total)} done</span>
              </span>
              <span className="bk-bar" aria-hidden="true"><span style={{ width: `${b.total ? Math.round((b.done / b.total) * 100) : 0}%` }} /></span>
              <span className="today-chev" aria-hidden="true">›</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── The desk's list ──
function List() {
  const q = useQuery({ queryKey: ['banks'], queryFn: () => apiGet('/banks'), staleTime: 15_000 });
  if (q.isError && !q.data) return <p className="error" role="alert">{q.error.message}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const banks = q.data.banks;
  return (
    <div className="bk">
      <div className="page-head">
        <div><span className="eyebrow">Calls</span><h1>Phone banks</h1></div>
        <div className="head-actions"><Link className="btn btn-primary" to="/banks/new">New phone bank</Link></div>
      </div>
      <Mine embedded />
      {!banks.length ? (
        <div className="pp-empty"><p>No phone banks yet. Make one from the people you want called, then hand the numbers out.</p></div>
      ) : (
        <ul className="bk-list">
          {banks.map((b) => (
            <li key={b.id}>
              <Link className={`bk-row${b.closed ? ' is-closed' : ''}`} to={`/banks/${b.id}`}>
                <span className="bk-row__main">
                  <span className="bk-row__name">{b.name}{b.candidate_name && <span className="chip">Call time · {b.candidate_name}</span>}{b.closed && <span className="chip">Closed</span>}</span>
                  <span className="bk-row__sub">
                    {num(b.total)} {plural(b.total, 'number')} · {num(b.done)} done · {num(b.open)} not handed out{b.list_name && <> · from {b.list_name}</>}
                    {b.callers.length > 0 && <> · {b.callers.map((c) => `${c.name} ${c.done}/${c.total}`).join(', ')}</>}
                  </span>
                </span>
                <span className="bk-bar" aria-hidden="true"><span style={{ width: `${b.total ? Math.round((b.done / b.total) * 100) : 0}%` }} /></span>
                <span className="today-chev" aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── A new bank from the people list ──
// A No answer: back on the caller's list after some hours, up to so many
// calls (server/ext/banks crossOff); "Never" crosses it off at once.
const RETRY_HOURS = [[0, 'Never — cross it off'], [1, 'After an hour'], [2, 'After 2 hours'], [4, 'After 4 hours'], [8, 'After 8 hours'], [24, 'The next day']];
const backAt = (iso) => new Date(iso).toLocaleString('en-CA', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
function RetryFields({ value, onChange, idPrefix, disabled = false }) {
  return (
    <div className="bk-who__row bk-retry">
      <div><label htmlFor={`${idPrefix}-h`} className="ws-label">No answer: call again</label>
        <select id={`${idPrefix}-h`} className="input" disabled={disabled} value={value.retry_hours}
          onChange={(e) => onChange({ ...value, retry_hours: Number(e.target.value) })}>
          {RETRY_HOURS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
        </select></div>
      {value.retry_hours > 0 && (
        <div><label htmlFor={`${idPrefix}-t`} className="ws-label">Up to</label>
          <select id={`${idPrefix}-t`} className="input" disabled={disabled} value={value.max_tries}
            onChange={(e) => onChange({ ...value, max_tries: Number(e.target.value) })}>
            {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} calls</option>)}
          </select></div>
      )}
    </div>
  );
}

function NewBank() {
  const navigate = useNavigate();
  const { me } = useOutletContext();
  // Who calls: volunteers, or one candidate's call time (ext/candidates) —
  // offered to the desk holding Donations, when there are candidates.
  const money = (me?.areas || []).includes('money');
  const seats = useQuery({ queryKey: ['calltime', 'seats'], queryFn: () => apiGet('/calltime/seats'), enabled: money, staleTime: 60_000 });
  const candidates = seats.data?.candidates ?? [];
  const [caller, setCaller] = useState('');
  const [askDollars, setAskDollars] = useState('');
  const [params] = useSearchParams();
  const scale = useScale();
  const [typedName, setName] = useState(null);
  const [script, setScript] = useState('');
  const [retry, setRetry] = useState({ retry_hours: 4, max_tries: 3 });
  const [f, setF] = useState({ q: '', band: '', tag: '', web: '' });
  const id = useId();
  const { run, busy, error } = useSaver();
  // Who to call: a List (Call this list — arrives with ?list=), or people
  // picked here by hand. A campaign with lists starts on a list.
  const names = useListNames();
  const lists = names.data?.lists ?? [];
  const [listId, setListId] = useState(params.get('list') || '');
  const [picked, setFrom] = useState(params.get('list') ? 'list' : null);
  const from = picked ?? (names.isPending ? null : lists.length ? 'list' : 'hand');
  const chosen = lists.find((l) => l.id === listId) || null;
  const listCount = useListCounts(chosen ? [chosen] : []).get(chosen?.id);
  const name = typedName ?? (from === 'list' && chosen ? chosen.name : '');
  // What they did on the website (ext/webdid): offered once it has people.
  const web = webChoices(useWebDid());
  const qs = useMemo(() => {
    const p = new URLSearchParams({ has: 'phone', limit: '2000' });
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.tag.trim()) p.set('tag', f.tag.trim());
    if (f.web) p.set('web', f.web);
    if (f.band === 'unrated') p.set('rating', 'unrated');
    else if (f.band) p.set('rating', codesInBand(scale, f.band).join(','));
    return p.toString();
  }, [f, scale]);
  const people = useQuery({ queryKey: ['persons', 'list', qs], queryFn: () => apiGet(`/persons?${qs}`), staleTime: 15_000, enabled: from === 'hand' });
  const callable = useMemo(() => (people.data?.persons || []).filter((p) => p.phone && !(p.tags || []).some((t) => t === 'do-not-contact' || t === 'do-not-call')), [people.data]);
  // How many numbers the bank will start with: a list's "can be called", or the people picked.
  const startWith = from === 'list' ? (listCount?.counts?.with_call ?? null) : callable.length;
  const submit = async (e) => {
    e.preventDefault();
    const who = from === 'list' ? { list_id: listId } : { person_ids: callable.map((p) => p.id) };
    const ask = askDollars.trim() ? Math.round(Number.parseFloat(askDollars.replace(/[$,\s]/g, '')) * 100) : null;
    const call = caller ? { candidate_id: caller, ask_cents: Number.isFinite(ask) && ask > 0 ? ask : null } : {};
    const r = await run('bank.create', { name, script: script || null, ...who, ...retry, ...call });
    if (r) navigate(`/banks/${r.bank.id}`, { replace: true });
  };
  return (
    <div className="bk">
      <p className="lu-back"><Link to="/banks">← Phone banks</Link></p>
      <div className="page-head"><div><span className="eyebrow">Calls</span><h1>New phone bank</h1></div></div>
      <form className="bk-form" onSubmit={submit}>
        <label htmlFor={`${id}-n`} className="ws-label">Name</label>
        <input id={`${id}-n`} className="input" value={name} maxLength={120} required autoFocus placeholder="Undecided in Newton — week of Nov 3" onChange={(e) => setName(e.target.value)} />
        {candidates.length > 0 && (
          <div className="bk-caller-pick">
            <label htmlFor={`${id}-who`} className="ws-label">Who calls</label>
            <select id={`${id}-who`} className="input" value={caller} onChange={(e) => setCaller(e.target.value)}>
              <option value="">Volunteers</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>Call time: {c.name}</option>)}
            </select>
            {caller && (
              <>
                <label htmlFor={`${id}-ask`} className="ws-label">Ask ($, optional)</label>
                <input id={`${id}-ask`} className="input bk-ask" inputMode="decimal" autoComplete="off" value={askDollars} placeholder="250"
                  onChange={(e) => setAskDollars(e.target.value)} />
                <p className="ops-meta">Every number goes to them. They see what each donor gave and may still give.</p>
              </>
            )}
          </div>
        )}
        <fieldset className="bk-who">
          <legend className="ws-label">Who to call</legend>
          <div className="au-from" role="group" aria-label="Who to call">
            <button type="button" className="btn ops-tap" aria-pressed={from === 'list'} onClick={() => setFrom('list')}>From a list</button>
            <button type="button" className="btn ops-tap" aria-pressed={from === 'hand'} onClick={() => setFrom('hand')}>Pick people</button>
          </div>
          {from === null && <p className="bk-count" role="status">{LOADING}</p>}
          {from === 'list' && (
            <div className="au-from__list">
              <label htmlFor={`${id}-l`} className="ws-label">List</label>
              <select id={`${id}-l`} className="input" value={listId} required onChange={(e) => setListId(e.target.value)}>
                <option value="">Choose a list…</option>
                {listId && !chosen && <option value={listId}>{names.isPending ? LOADING : names.isError ? 'The list you picked' : 'A list that isn’t here any more'}</option>}
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {names.isError && <p className="error" role="alert"><Unavailable onRetry={() => names.refetch()} /></p>}
              {names.isSuccess && !lists.length && <p className="ops-meta">No lists yet — <Link className="au-tap" to="/lists/new">make one</Link>, or pick people.</p>}
              {chosen && (
                <p className="bk-count" role="status">
                  {listCount?.counts ? <><strong className="mono">{num(listCount.counts.with_call)}</strong> of {num(listCount.counts.total)} on it can be called</>
                    : listCount?.isError ? <Unavailable onRetry={listCount.refetch} /> : LOADING}
                </p>
              )}
              {chosen && <p className="ops-meta">Whoever leaves the list leaves the calls not made yet. Or <Link className="au-tap" to={`/calls?list=${chosen.id}&channel=phone`}>call them yourself</Link>.</p>}
            </div>
          )}
          {from === 'hand' && (
          <>
          <div className="bk-who__row">
            <div><label htmlFor={`${id}-b`} className="ws-label">Rating</label>
              <select id={`${id}-b`} className="input" value={f.band} onChange={(e) => setF({ ...f, band: e.target.value })}>{BANDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label htmlFor={`${id}-t`} className="ws-label">Tag</label>
              <input id={`${id}-t`} className="input" value={f.tag} placeholder="volunteer, newton…" onChange={(e) => setF({ ...f, tag: e.target.value })} /></div>
            {web.length > 0 && (
              <div><label htmlFor={`${id}-w`} className="ws-label">Did on the website</label>
                <select id={`${id}-w`} className="input" value={f.web} onChange={(e) => setF({ ...f, web: e.target.value })}>
                  <option value="">Anyone</option>
                  {web.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></div>
            )}
            <div className="bk-who__grow"><label htmlFor={`${id}-q`} className="ws-label">Search (name, street, phone)</label>
              <input id={`${id}-q`} className="input" value={f.q} placeholder="104 Ave" onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
          </div>
          {/* A read that failed is never "0 people". */}
          {people.isError && !people.data ? <p className="error" role="alert"><Unavailable onRetry={() => people.refetch()} /></p> : (
          <p className="bk-count" role="status">
            {people.isFetching && !people.data ? 'Counting…' : <><strong className="mono">{num(callable.length)}</strong> {plural(callable.length, 'person', 'people')} with a phone{callable.length >= 2000 ? ' (the first 2,000)' : ''}{people.data && people.data.persons.length > callable.length ? ` — ${people.data.persons.length - callable.length} do-not-contact or do-not-call left out` : ''}</>}
          </p>
          )}
          {callable.length > 0 && (
            <ul className="bk-sample">
              {callable.slice(0, 5).map((p) => <li key={p.id}>{p.name} <span className="muted">· {p.phone}</span> {p.rating && <RatingChip code={p.rating} who brief />}</li>)}
              {callable.length > 5 && <li className="muted">…and {num(callable.length - 5)} more</li>}
            </ul>
          )}
          </>
          )}
        </fieldset>
        <RetryFields value={retry} onChange={setRetry} idPrefix={`${id}-r`} />
        <label htmlFor={`${id}-s`} className="ws-label">Script (what callers see while they call)</label>
        <textarea id={`${id}-s`} className="input bk-script" rows={6} value={script} maxLength={20_000}
          placeholder={'Hi, this is ___ with the campaign. We’re calling neighbours about the election on…'} onChange={(e) => setScript(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="lu-form__acts">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !from || (from === 'list' ? !chosen || startWith === 0 : !callable.length)}>
            {startWith == null ? 'Make the bank' : `Make the bank with ${num(startWith)} ${plural(startWith, 'number')}`}
          </button>
          <Link className="btn btn-quiet" to="/banks">Cancel</Link>
        </div>
      </form>
    </div>
  );
}

// ── One bank: hand out, take back, watch ──
// The numbers come 2,000 at a time (GET /banks/:id?offset=).
const PAGE = 2000;
function Bank({ id }) {
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: ['banks', id, offset], queryFn: () => apiGet(`/banks/${id}?offset=${offset}`), refetchInterval: 30_000, placeholderData: (prev) => prev });
  const members = useQuery({ queryKey: ['members'], queryFn: () => apiGet('/members'), staleTime: 60_000 });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => apiGet('/teams'), staleTime: 60_000 });
  const { run, busy, error } = useSaver([['banks'], ['banks', id]]);
  const [to, setTo] = useState('');       // 'u:<id>' | 't:<id>'
  const [count, setCount] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [editScript, setEditScript] = useState(null);
  const [ask, setAsk] = useState(false);
  const [topped, setTopped] = useState(null);
  const fid = useId();
  useEffect(() => { if (q.data && editScript === null) setEditScript(null); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isError && !q.data) return <div className="bk"><p className="error" role="alert">{q.error.status === 404 ? 'That phone bank isn’t here.' : <Unavailable onRetry={() => q.refetch()} />}</p><Link className="btn" to="/banks">Phone banks</Link></div>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const { bank, numbers } = q.data;
  // Not handed out and still to call, as the server counts it: someone who
  // left the list (or may no longer be called) isn't waiting to be handed out.
  const open = bank.open ?? numbers.filter((n) => !n.assigned_to && !n.done_at).length;
  const topUp = async () => {
    setTopped(null);
    const r = await run('bank.topup', { id });
    if (r) setTopped(r.added ? `✓ ${num(r.added)} more to call — on the list since` : '✓ No one new on the list');
  };
  const handOut = async (e) => {
    e.preventDefault();
    if (!to) return;
    const [kind, who] = to.split(':');
    const input = { id, count: count ? Number(count) : undefined };
    if (kind === 'u') input.user_id = who; else input.team_id = who;
    const r = await run('bank.assign', input);
    if (r) setCount('');
  };
  const shown = showAll ? numbers : numbers.slice(0, 40);
  // Closed, and the list it was made from deleted: there is nothing to tell who left by, so it can't reopen.
  const shut = Boolean(bank.closed && bank.list_id && !bank.list_name);
  return (
    <div className="bk">
      <p className="lu-back"><Link to="/banks">← Phone banks</Link></p>
      <div className="page-head bk-head">
        <div><span className="eyebrow">{bank.candidate_id ? `Call time · ${bank.candidate_name || 'a candidate'}` : 'Phone bank'}{bank.closed ? ' · Closed' : ''}</span><h1>{bank.name}</h1></div>
        <div className="head-actions">
          {/* Closed and its list deleted: it stays closed (the server refuses) — the line below says why. */}
          {!shut && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('bank.update', { id, closed: !bank.closed })}>{bank.closed ? 'Reopen' : 'Close'}</button>}
          {ask ? (
            <span className="ops-confirm"><span>Remove the bank?</span>
              <button type="button" className="btn ops-danger" disabled={busy} onClick={async () => { if (await run('bank.remove', { id })) navigate('/banks'); }}>Yes</button>
              <button type="button" className="btn btn-quiet" onClick={() => setAsk(false)}>No</button></span>
          ) : <button type="button" className="btn btn-quiet" onClick={() => setAsk(true)}>Remove</button>}
        </div>
      </div>

      {bank.list_id && (
        // Made from a List: who left it since is out of the calls not made yet.
        <div className="ops-actions au-banklist">
          <span>
            {bank.list_name ? <>From the list <Link className="au-tap" to={`/lists/${bank.list_id}`}>{bank.list_name}</Link></> : shut ? 'From a list that was deleted — the numbers stay, and the bank stays closed' : 'From a list that was deleted — the numbers stay'}
            {bank.gone > 0 && <> · <strong className="mono">{num(bank.gone)}</strong> left the list or can’t be called now</>}
          </span>
          {bank.list_name && !bank.closed && <button type="button" className="btn ops-tap" disabled={busy} onClick={topUp}>Add who joined since</button>}
          {topped && <span className="ops-done" role="status">{topped}</span>}
        </div>
      )}

      <div className="dash-figs bk-figs" role="list">
        {[['Numbers', bank.total], ['Handed out', bank.assigned], ['Done', bank.done], ['Not handed out', open]].map(([l, n]) => (
          <div className="dash-fig" role="listitem" key={l}><span className="dash-fig__n">{num(n)}</span><span className="dash-fig__label">{l}</span></div>
        ))}
      </div>

      {/* Call time is the candidate's own: no hand-out, no CallHub. */}
      {bank.candidate_id ? (
        <p className="ops-meta bk-calltime">Every number is {bank.candidate_name || 'the candidate'}’s to call{bank.ask_cents ? ` · ask $${(bank.ask_cents / 100).toLocaleString('en-CA')}` : ''}.</p>
      ) : (<>
      <SendToCallHub kind="bank" id={id} />
      <section className="bk-sec" aria-labelledby={`${fid}-h`}>
        <h2 className="dash-sec__h" id={`${fid}-h`}>Hand out numbers</h2>
        {bank.closed ? <p className="muted">{shut ? 'The bank is closed.' : 'The bank is closed — reopen it to hand out numbers.'}</p> : open === 0 ? <p className="muted">Every number is handed out or done.</p> : (
          <form className="bk-hand" onSubmit={handOut}>
            <div className="bk-hand__to">
            <label htmlFor={`${fid}-to`} className="ws-label">To</label>
            <select id={`${fid}-to`} className="input" value={to} onChange={(e) => setTo(e.target.value)} required>
              <option value="">Pick a caller or a team…</option>
              {teams.data?.teams?.length > 0 && (
                <optgroup label="Teams (split evenly)">
                  {teams.data.teams.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name} · {t.members.length}</option>)}
                </optgroup>
              )}
              <optgroup label="People">
                {(members.data?.members || []).map((m) => <option key={m.id} value={`u:${m.id}`}>{m.name} · {m.role}</option>)}
              </optgroup>
            </select>
            </div>
            <div>
            <label htmlFor={`${fid}-c`} className="ws-label">How many</label>
            <input id={`${fid}-c`} className="input bk-hand__n" type="number" min="1" max={open} value={count} placeholder={`all ${num(open)}`} onChange={(e) => setCount(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !to}>Hand out</button>
          </form>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      </>)}

      {bank.callers.length > 0 && (
        <section className="bk-sec" aria-label="Callers">
          <h2 className="dash-sec__h">Callers</h2>
          <ul className="bk-callers">
            {bank.callers.map((c) => (
              <li key={c.user_id} className="bk-caller">
                <span className="bk-caller__name">{c.name}</span>
                <span className="bk-bar" aria-hidden="true"><span style={{ width: `${c.total ? Math.round((c.done / c.total) * 100) : 0}%` }} /></span>
                <span className="mono bk-caller__n">{c.done} / {c.total}</span>
                {c.done < c.total && !bank.candidate_id && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('bank.release', { id, user_id: c.user_id })}>Take back {c.total - c.done}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bk-sec" aria-label="No answer">
        <h2 className="dash-sec__h">No answer</h2>
        <RetryFields value={{ retry_hours: bank.retry_hours, max_tries: bank.max_tries }} idPrefix={`bk-${id}-r`} disabled={busy}
          onChange={(v) => run('bank.update', { id, ...v })} />
      </section>

      <section className="bk-sec" aria-label="Script">
        <div className="dash-sec__head">
          <h2 className="dash-sec__h">Script</h2>
          {editScript === null && <button type="button" className="btn btn-quiet" onClick={() => setEditScript(bank.script || '')}>{bank.script ? 'Edit' : 'Add a script'}</button>}
        </div>
        {editScript !== null ? (
          <form className="bk-form" onSubmit={async (e) => { e.preventDefault(); if (await run('bank.update', { id, script: editScript || null })) setEditScript(null); }}>
            <textarea className="input bk-script" rows={8} value={editScript} maxLength={20_000} onChange={(e) => setEditScript(e.target.value)} />
            <div className="lu-form__acts">
              <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
              <button type="button" className="btn btn-quiet" onClick={() => setEditScript(null)}>Cancel</button>
            </div>
          </form>
        ) : bank.script ? <pre className="bk-script__read">{bank.script}</pre> : <p className="muted">No script yet — callers see one here and on their call card.</p>}
      </section>

      <section className="bk-sec" aria-label="Numbers">
        <h2 className="dash-sec__h">Numbers</h2>
        <div className="dash-tablewrap">
          <table className="dash-table bk-table">
            <thead><tr><th scope="col">Who</th><th scope="col">Phone</th><th scope="col">Rating</th><th scope="col">Caller</th><th scope="col">Status</th><th scope="col"><span className="pp-sr">Actions</span></th></tr></thead>
            <tbody>
              {shown.map((n) => (
                <tr key={n.person_id} className={n.done_at ? 'is-done' : ''}>
                  <th scope="row"><Link to={`/people/${n.person_id}`}>{n.name}</Link></th>
                  <td className="mono">{n.phone}</td>
                  <td>{n.rating ? <RatingChip code={n.rating} who brief /> : <span className="muted">·</span>}</td>
                  <td>{n.caller || <span className="muted">—</span>}</td>
                  <td>{n.done_at ? <span className="chip chip-ok">{n.outcome || 'done'}</span>
                    : n.still === false ? <span className="muted">{bank.list_id ? 'left the list or can’t be called now' : 'can’t be called now'}</span>
                    : n.next_at && new Date(n.next_at) > new Date() ? `call back ${backAt(n.next_at)}${n.tries ? ` · ${n.tries} ${n.tries === 1 ? 'try' : 'tries'}` : ''}`
                      : n.assigned_to ? 'to call' : <span className="muted">not handed out</span>}</td>
                  <td className="bk-table__acts">
                    {!n.done_at && n.assigned_to && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('bank.release', { id, person_id: n.person_id })}>Take back</button>}
                    {!n.done_at && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('bank.done', { id, person_id: n.person_id, outcome: 'skipped' })}>Skip</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {numbers.length > shown.length && <button type="button" className="btn btn-quiet" onClick={() => setShowAll(true)}>Show all {num(numbers.length)}</button>}
        {/* A bank bigger than one page: 2,000 numbers at a time. */}
        {(offset > 0 || bank.total > offset + numbers.length) && (showAll || numbers.length <= shown.length) && (
          <div className="ops-actions au-pager">
            <span className="ops-meta">{num(offset + 1)}–{num(offset + numbers.length)} of {num(bank.total)}</span>
            {offset > 0 && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous {num(PAGE)}</button>}
            {bank.total > offset + numbers.length && <button type="button" className="btn btn-quiet ops-tap" onClick={() => { setOffset(offset + PAGE); setShowAll(true); }}>Next {num(Math.min(PAGE, bank.total - offset - numbers.length))}</button>}
          </div>
        )}
      </section>
    </div>
  );
}
