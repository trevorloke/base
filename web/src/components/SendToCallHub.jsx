// "Send to CallHub" on a list's page and a phone bank's page (ext/callhub).
//   <SendToCallHub kind="list" id={id} />  ·  <SendToCallHub kind="bank" id={id} />
// Shown only when CallHub is on (GET /api/integrations): nothing at all
// otherwise. A tap asks first — how many numbers go, for how many people,
// how many are left out — then the sending happens in the background and
// the line under it says how far it is ("Sending · 850 of 2,000", "Sent",
// or "Stopped: CallHub said … · Carry on"), and how many numbers CallHub
// would not take, in its words, with whose they were (a few by name, the
// rest on a tap). Once calls are made, how many results came back; under
// "What each result counts as", CallHub's own results with the outcome each
// is filed as (filled in by pattern, yours to change), and the survey
// question whose answers rate people — none until someone picks it. A
// change moves the results already in too, and putting it back undoes it
// (on the lists sent since that copied it as well); one that would tag
// people do-not-call or rate them asks first, in place, naming the result —
// and so does taking a row off "Do not call", which lets people be called
// again (saying how many lists sent since follow). Once saved, the keyboard
// is back on the row's select; anyone a put-back leaves do-not-call is named.
// Under everything: the do-not-call numbers CallHub would not take, and
// the ones it still holds though nobody here blocks them now — with whose
// they are, so someone can put it right in CallHub.
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { offeredCodes, ratingText } from '@starbase/shared/scale';
import { ApiError, action, apiGet } from '../api.js';
import { useOnline } from './NoSignal.jsx';
import { useScale } from './scale.js';
// The shared .ops-* pieces (48px buttons, the quiet line): a phone bank's page doesn't load them itself.
import '../pages/shifts.css';
import './send-to-callhub.css';

const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const plural = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many);
const errorText = (e) => e?.message || 'No answer — check your signal';
// A refusal with its reason (a closed phone bank, a list too long to send):
// said as it is. Anything else is "Unavailable — Try again".
const refusal = (e) => (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 ? e.message : null);
// The outcomes a result can be filed as, in the Calls screen's own words.
const OUTCOMES = [
  ['contacted', 'Talked'], ['no_answer', 'No answer'], ['left_message', 'Left message'], ['inaccessible', 'Wrong number'],
  ['refused', 'Refused'], ['moved', 'Moved'], ['do_not_call', 'Do not call'],
];
const LONG_QUESTION = 30; // about what a phone's closed select shows
const active = (p) => p && (p.status === 'queued' || p.status === 'sending');
const isStopped = (p) => p && (p.status === 'failed' || p.stalled);
// Whether this device has seen CallHub on: if the "is it on?" read then
// fails, the block says so instead of silently not being there.
const SEEN = 'base.callhub.on';
const seenOn = () => { try { return localStorage.getItem(SEEN) === '1'; } catch { return false; } };
const rememberOn = (on) => { try { if (on) localStorage.setItem(SEEN, '1'); else localStorage.removeItem(SEEN); } catch { /* a per-device nicety */ } };

// "do-not-call" kept on one line: a phone's narrow column would break it at a hyphen.
const DNC = <span className="ch-nobreak">do-not-call</span>;
const joined = (parts) => parts.filter(Boolean).map((x, i) => <Fragment key={i}>{i > 0 && ' · '}{x}</Fragment>);
// What a save did, in one line: what moved, who was tagged or rated — or no longer.
const savedLine = (r) => joined([
  'Saved',
  r.changed && `${num(r.changed)} ${plural(r.changed, 'result')} already in moved too`,
  r.tagged && <>{num(r.tagged)} {plural(r.tagged, 'person', 'people')} tagged {DNC}</>,
  r.untagged && <>{num(r.untagged)} {plural(r.untagged, 'person is', 'people are')} no longer {DNC}</>,
  r.rated && `${num(r.rated)} ${plural(r.rated, 'person', 'people')} rated`,
  r.unrated && `${num(r.unrated)} ${plural(r.unrated, 'rating')} taken back`,
  r.more && 'the rest follow by themselves',
  // What was taken back here was copied into the lists sent since: they follow.
  r.later && `${num(r.later)} ${plural(r.later, 'list')} sent since ${plural(r.later, 'follows', 'follow')} too`,
]);
// Whoever a row put back is about and is still do-not-call, by name, so the
// desk can look: tagged by hand (no call's result holds it), or another of
// their calls still says so.
const stays = (s, why) => s && <>{num(s.n)} {plural(s.n, 'person stays', 'people stay')} {DNC}, {why}<Names people={s.people} more={s.more} /></>;
const staysLine = (r) => joined([stays(r.stay_hand, 'tagged by hand'), stays(r.stay_call, 'another call says so')]);

function Unavailable({ onRetry }) {
  return <p className="ch-line" role="status">Unavailable — <button type="button" className="btn-link" onClick={onRetry}>Try again</button></p>;
}

// People by name, each a way to their page: a few — "Ana Example, Ben
// Example and 3 more" — and, on its own row under them, "Show all 8". more:
// how many the server could not name here at all (said, with nothing to open).
const WHO_SHOWN = 5;
function Names({ people, more = 0 }) {
  const [all, setAll] = useState(false);
  if (!people?.length) return null;
  const shown = all ? people : people.slice(0, WHO_SHOWN);
  const rest = people.length - shown.length + more;
  return (
    <>
      {' — '}{shown.map((who, i) => <span key={who.id}>{i > 0 && ', '}<Link to={`/people/${who.id}`}>{who.name}</Link></span>)}
      {rest > 0 && ` and ${num(rest)} more`}
      {people.length > WHO_SHOWN && (
        <button type="button" className="btn-link ch-all" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${num(people.length)}`}
        </button>
      )}
    </>
  );
}

// What each of CallHub's results counts as, and the question that rates.
function Results({ p, online, onChanged }) {
  const scale = useScale();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  // What the last save did (its line), and who it left do-not-call all the
  // same — kept on its own, so it stays said while a big push's rest moves.
  const [said, setSaid] = useState(null);
  const [stayed, setStayed] = useState(null);
  const [error, setError] = useState(null);
  // A pick that would tag, untag or rate people already called waits here for a Yes: { at, words, input }.
  const [ask, setAsk] = useState(null);
  // The question is brought clear of the phone's bottom bar, once, when it appears.
  const askRef = useRef(null);
  useEffect(() => {
    const el = askRef.current;
    if (el && el.getBoundingClientRect().bottom > window.innerHeight - 96) el.scrollIntoView({ block: 'center' });
  }, [ask?.at]);
  // A big push's results move in the background: said while it goes, and when it is done.
  const [wasMoving, setWasMoving] = useState(false);
  useEffect(() => {
    if (p.moving) setWasMoving(true);
    else if (wasMoving) { setWasMoving(false); setSaid('Saved · the results already in have all moved'); }
  }, [p.moving, wasMoving]);
  // The select a save came from (it is disabled while saving, and a Yes that
  // was pressed is gone): the keyboard goes back to it once the save is done.
  const back = useRef(null);
  useEffect(() => {
    if (busy || !back.current) return;
    const el = document.getElementById(back.current);
    back.current = null;
    if (el && (!document.activeElement || document.activeElement === document.body)) el.focus();
  }, [busy]);
  const save = async (input, at = null) => {
    back.current = at && `${uid}-${at}`;
    setBusy(true); setError(null); setSaid(null); setStayed(null); setAsk(null);
    try {
      const r = await action('callhub.map', { id: p.id, ...input });
      setSaid(savedLine(r));
      if (r.stay_hand || r.stay_call) setStayed(staysLine(r));
      onChanged();
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const support = p.questions.find((q) => q.support) || null;
  const picked = support?.question || p.rating?.question || '';
  const questions = picked && !p.questions.some((q) => q.question === picked) ? [...p.questions, { question: picked, answers: [] }] : p.questions;
  const rates = Boolean(support?.answers.some((a) => a.rating));

  // What is taken back here is taken back on the lists sent since that still carry it: the question says on how many.
  const alsoSince = (n) => (n ? ` — here and on the ${num(n)} ${plural(n, 'list')} sent since` : '');
  const pickOutcome = (d, i, value) => {
    const input = { outcomes: { [d.disposition]: value === d.suggested ? null : value } };
    // Off "Do not call" lets the people it tagged be called again — on the
    // lists sent since that copied the row, too — so it asks first as well:
    // one arrow key on the focused select is not enough.
    if (d.outcome === 'do_not_call' && value !== 'do_not_call') {
      setAsk({ at: `d${i}`, input, words: `Stop counting “${d.disposition || 'No result given'}” as do not call? Whoever it tagged can be called again${alsoSince(d.later)}.` });
      return;
    }
    if (value !== 'do_not_call') { save(input, `d${i}`); return; }
    // The question names the result it is about: it is read on its own, not only under its row.
    const who = d.people ? `the ${num(d.people)} ${plural(d.people, 'person', 'people')}` : 'everyone';
    const result = d.disposition ? `with “${d.disposition}”` : 'with no result given';
    setAsk({ at: `d${i}`, input, words: <>Tag {who} {result} {DNC}? They leave every call list.</> });
  };
  const pickQuestion = (value) => {
    const input = { rating: value ? { question: value, answers: {} } : null };
    if (!rates) { save(input, 'q'); return; }
    setAsk({ at: 'q', input, words: `Stop rating people from this question? The ratings its answers gave are taken back${alsoSince(p.rating?.later)}.` });
  };
  const pickRating = (a, i, value) => {
    const input = { rating: { question: picked, answers: { [a.answer]: value || null } } };
    if (!value) { save(input, `a${i}`); return; }
    setAsk({ at: `a${i}`, input, words: `Rate everyone who answered “${a.answer}” as ${ratingText(scale, value)}?` });
  };
  // No — by its button or by Escape: nothing changes, and the keyboard is back on the select.
  const sayNo = (at) => { setAsk(null); document.getElementById(`${uid}-${at}`)?.focus(); };
  const confirm = (at) => ask?.at === at && (
    <span className="ops-confirm ch-confirm" role="alert" ref={askRef} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); sayNo(at); } }}>
      <span>{ask.words}</span>
      <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={() => save(ask.input, at)}>Yes</button>
      <button type="button" className="btn btn-quiet ops-tap" autoFocus onClick={() => sayNo(at)}>No</button>
    </span>
  );
  return (
    <div className="ch-results">
      <ul className="ch-map">
        {p.dispositions.map((d, i) => (
          <li key={d.disposition || '—'} className="ch-map__row">
            <label htmlFor={`${uid}-d${i}`} className="ch-map__name">{d.disposition || 'No result given'} <span className="ops-meta">{num(d.n)}</span></label>
            <select id={`${uid}-d${i}`} className="input ch-select" value={d.outcome} disabled={busy || !online}
              onChange={(e) => pickOutcome(d, i, e.target.value)}>
              {OUTCOMES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
            {confirm(`d${i}`)}
          </li>
        ))}
      </ul>
      {questions.length > 0 && (
        <div className="ch-rate">
          <div className="field">
            <label htmlFor={`${uid}-q`}>Support question</label>
            <select id={`${uid}-q`} className="input ch-select" value={picked} disabled={busy || !online}
              onChange={(e) => pickQuestion(e.target.value)}>
              <option value="">None — nobody is rated from a call</option>
              {questions.map((q) => <option key={q.question} value={q.question}>{q.question}</option>)}
            </select>
            {/* A long question is cut short in the closed box on a phone: here it is whole. */}
            {picked.length > LONG_QUESTION && <p className="ops-meta ch-question">{picked}</p>}
            {confirm('q')}
          </div>
          {support && (
            <ul className="ch-map">
              {support.answers.map((a, i) => (
                <li key={a.answer} className="ch-map__row">
                  <label htmlFor={`${uid}-a${i}`} className="ch-map__name">{a.answer} <span className="ops-meta">{num(a.n)}</span></label>
                  <select id={`${uid}-a${i}`} className="input ch-select" value={a.rating || ''} disabled={busy || !online}
                    onChange={(e) => pickRating(a, i, e.target.value)}>
                    <option value="">Doesn’t rate</option>
                    {offeredCodes(scale).map((code) => <option key={code} value={code}>{ratingText(scale, code)}</option>)}
                  </select>
                  {confirm(`a${i}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="ops-meta" role="status" aria-live="polite">
        {busy ? 'Saving…' : p.moving ? 'Moving the results already in…' : said || 'A change also moves the results already in. Putting it back undoes it.'}
        {!busy && stayed && <> · {stayed}</>}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// newest: the one push that can still be carried on; an earlier one that
// stopped was left behind when the list was sent again. asking: the "how
// many go?" question is open above — its Send · Cancel are the only pair of
// buttons then.
function Push({ p, running, online, onChanged, newest, asking, onSendAgain }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const carryOn = async () => {
    setBusy(true); setError(null);
    try { await action('callhub.resume', { id: p.id }); onChanged(); } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const stopped = isStopped(p);
  const pct = p.total ? Math.min(100, Math.round((p.sent / p.total) * 100)) : 0;
  // said: announced when it changes (the state, and why it waits or
  // stopped); rest: the count on the way, read but not announced each time.
  // Clock times are the server's words, in the campaign's own time — the
  // clock the phonebook's name was stamped with.
  let said; let rest = null;
  if (stopped) {
    said = <><strong>Stopped</strong>: {p.note || 'it stopped part-way'}</>;
    rest = <> · {num(p.sent)} of {num(p.total)} sent</>;
  } else if (p.status === 'sent') said = <><strong>Sent</strong> · {num(p.sent)} {plural(p.sent, 'number')}{p.sent_words ? ` · ${p.sent_words}` : ''}</>;
  else if (p.status === 'queued') said = <><strong>Waiting</strong> · {running ? 'starting…' : 'background work is off on this server'}</>;
  else {
    said = <><strong>Sending</strong>{p.note ? ` · ${p.note}` : ''}{p.resume_words ? ` · carries on ${p.resume_words}` : ''}</>;
    rest = <> · {num(p.sent)} of {num(p.total)}</>;
  }
  return (
    <li className="ch-push" data-status={stopped ? 'stopped' : p.status}>
      <p className="ch-line ch-status"><span role="status" aria-live="polite">{said}</span>{rest}</p>
      {active(p) && !stopped && <span className="ch-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>}
      {stopped && newest && !asking && (
        <div className="ops-actions ch-stopped">
          <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={carryOn}>{busy ? 'Starting…' : 'Carry on'}</button>
          {/* Only where CallHub refused it: one left part-way with no job behind it can only be carried on. */}
          {p.status === 'failed' && <button type="button" className="btn btn-quiet ops-tap" disabled={busy || !online} onClick={onSendAgain}>Send again instead</button>}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="ops-meta ch-book">Phonebook in CallHub: “{p.name}”{p.skipped ? ` · ${num(p.skipped)} left out` : ''}{p.by ? ` · sent by ${p.by}` : ''}</p>
      {p.refused > 0 && (
        <p className="ops-meta ch-refused">
          CallHub wouldn’t take {num(p.refused)} {plural(p.refused, 'number')}{p.refused_note ? `: “${p.refused_note}”` : ''}
          <Names people={p.refused_people} more={Math.max(0, p.refused - (p.refused_people?.length || 0))} />
        </p>
      )}
      {p.results > 0 ? (
        <>
          <p className="ch-line"><strong>{num(p.results)}</strong> {plural(p.results, 'result')} back</p>
          <button type="button" className="disclose" aria-expanded={open} aria-controls={`${uid}-r`} onClick={() => setOpen((v) => !v)}>What each result counts as</button>
          {open && <div id={`${uid}-r`}><Results p={p} online={online} onChanged={onChanged} /></div>}
        </>
      ) : p.status === 'sent' && <p className="ops-meta">Next: start the calling campaign on this phonebook in CallHub.</p>}
    </li>
  );
}

export default function SendToCallHub({ kind, id }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const on = useQuery({ queryKey: ['integrations'], queryFn: () => apiGet('/integrations'), staleTime: 5 * 60_000, retry: false });
  const isOn = Boolean(on.data?.callhub);
  useEffect(() => { if (on.data) rememberOn(isOn); }, [on.data, isOn]);
  const key = ['callhub', kind, id];
  const pushes = useQuery({
    queryKey: key,
    queryFn: () => apiGet(`/callhub/pushes?${kind}=${id}`),
    enabled: isOn,
    // While it is sending (or results are being moved), every few seconds; after, results trickle in.
    refetchInterval: (q) => ((q.state.data?.pushes || []).some((p) => active(p) || p.moving) ? 3000 : 30_000),
  });
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [earlier, setEarlier] = useState(false);
  const uid = useId();
  const preview = useQuery({
    queryKey: [...key, 'preview'],
    queryFn: () => apiGet(`/callhub/preview?${kind}=${id}`),
    enabled: isOn && asking,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  if (!isOn) {
    // Not on: nothing at all. Not known (the read failed) where it was on before: said, not hidden.
    if (!on.isError || on.data || !seenOn()) return null;
    return <section className="ch" aria-label="CallHub"><h2 className="ch-title">CallHub</h2><Unavailable onRetry={() => on.refetch()} /></section>;
  }
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    // Results re-filed change people's histories and a bank's numbers.
    queryClient.invalidateQueries({ queryKey: ['persons'] });
    queryClient.invalidateQueries({ queryKey: ['banks'] });
  };
  const ask = () => { setError(null); setAsking(true); };
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await action('callhub.push', kind === 'list' ? { list_id: id } : { bank_id: id });
      setAsking(false);
      refresh();
    } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  const list = pushes.data?.pushes || [];
  // One at a time: while one is on its way there is nothing new to send, and
  // one that stopped part-way offers Carry on first ("Send again instead" is
  // beside it, quietly).
  const going = list.some(active);
  const pv = preview.data;
  const why = preview.isError ? refusal(preview.error) : null;
  const nt = pushes.data?.not_taken;
  const held = pushes.data?.held;
  return (
    <section className="ch" aria-label="CallHub">
      <div className="ch-head">
        <h2 className="ch-title">CallHub</h2>
        {!asking && !going && !isStopped(list[0]) && pushes.data && (
          <button type="button" className="btn ops-tap" disabled={!online} onClick={ask}>
            {list.length ? 'Send again' : 'Send to CallHub'}
          </button>
        )}
      </div>
      {asking && (
        <div className="ch-ask">
          {why ? <p className="ch-line" role="status">{why}</p>
            : preview.isError ? <Unavailable onRetry={() => preview.refetch()} />
            : !pv ? <p className="ch-line" role="status">Counting…</p> : (
              <>
                <p className="ch-line" role="status">
                  <strong>{num(pv.numbers)}</strong> {plural(pv.numbers, 'number')} to send
                  {pv.people !== pv.numbers ? ` for ${num(pv.people)} ${plural(pv.people, 'person', 'people')}` : ''}
                  {pv.left_out ? ` · ${num(pv.left_out)} left out (no number, or do not call)` : ''}
                </p>
                <p className="ops-meta">
                  {pv.numbers ? `Only names, numbers and cities go.${pv.days > 1 ? ` About ${num(pv.days)} days: CallHub takes 3,600 a day.` : ''}`
                    : 'Nobody here has a number that can be called.'}
                </p>
              </>
            )}
          <div className="ops-actions">
            <button type="button" className="btn ops-solid ops-tap" disabled={busy || !online || !pv?.numbers} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
            <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {pushes.isError && !pushes.data ? <Unavailable onRetry={() => pushes.refetch()} />
        : !pushes.data ? <p className="ch-line" role="status">Loading…</p>
          : !list.length && !asking && <p className="ops-meta">Sends this {kind === 'list' ? 'list' : 'phone bank'} to CallHub’s dialer. Each call’s result comes back onto the person.</p>}
      {list.length > 0 && (
        <ul className="ch-pushes">
          <Push p={list[0]} running={pushes.data.running} online={online} onChanged={refresh} newest asking={asking} onSendAgain={ask} />
        </ul>
      )}
      {list.length > 1 && (
        <>
          <button type="button" className="disclose" aria-expanded={earlier} aria-controls={`${uid}-e`} onClick={() => setEarlier((v) => !v)}>
            Earlier · {num(list.length - 1)}
          </button>
          {earlier && (
            <ul className="ch-pushes" id={`${uid}-e`}>
              {list.slice(1).map((p) => <Push key={p.id} p={p} running={pushes.data.running} online={online} onChanged={refresh} />)}
            </ul>
          )}
        </>
      )}
      {nt && (
        <p className="ops-meta ch-nottaken">
          CallHub wouldn’t take {num(nt.n)} {DNC} {plural(nt.n, 'number')}{nt.note ? `: “${nt.note}”` : ''}
          <Names people={nt.people} more={nt.more || 0} />
        </p>
      )}
      {held && (
        <p className="ops-meta ch-nottaken ch-held">
          CallHub’s {DNC} list still has {num(held.n)} {plural(held.n, 'number')} nobody here blocks now. Take {plural(held.n, 'it', 'them')} off in CallHub
          <Names people={held.people} more={held.more || 0} />
        </p>
      )}
    </section>
  );
}
