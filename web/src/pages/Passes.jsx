// Passes (desk) — /passes, from the turf list's "Pass: … ›" chip.
//   A pass is one sweep over every turf: what it's for (Persuasion · Get out
//   the vote · Lit drop · Find out who's who), who to knock, and how many
//   tries before a door is left. While one is open, "doors left" on every
//   turf means doors in its universe not finished in it: a No answer keeps
//   the door on the list ("Try again · 1 of 2") until the tries run out; a
//   talk, a refusal, moved or no access finishes it. With none open the
//   lists work as they always did.
//   The open pass: its name, its line, the day it started, "N doors knocked ·
//   N talked · N yes", and "End this pass" (asks in place). The one yellow
//   button starts a pass — the form: a suggested name ("Persuasion ·
//   October"), What for, Who, a List to walk (Walk this list: only doors
//   with someone on it, as it stands at each load — a list's Walk button
//   opens the form with it picked, /passes?new=1&list=…), Tries 1–5 (2) —
//   and says that doors left on every turf will change; starting one ends
//   the open one. Past passes sit below with their numbers. With no signal:
//   the title and the No signal line; starting or ending needs signal.
import { useId, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KINDS, WHO, TRIES_MAX, kindLabel, passLine } from '@starbase/shared/passes';
import { action, apiGet } from '../api.js';
import { NeedsSignalLine, NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { LOADING, Unavailable, useListNames } from '../components/AudienceBits.jsx';
import './shifts.css';
import './surveys.css';
import './passes.css';

const TRIES = Array.from({ length: TRIES_MAX }, (_, i) => i + 1);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '');
const monthNow = () => new Date().toLocaleDateString('en-CA', { month: 'long' });
const suggestName = (kind) => `${kindLabel(kind)} · ${monthNow()}`;
// "12 doors knocked · 8 talked · 3 yes" (the open pass) / "… · 8 talked" (past)
const statsLine = (s, withYes) => [
  plural(s?.doors_knocked || 0, 'door', 'doors') + ' knocked',
  `${s?.talked || 0} talked`,
  withYes ? `${s?.support_found || 0} yes` : null,
].filter(Boolean).join(' · ');
// Everything a pass changes: every turf's doors left, every walk list, Today.
const PASS_KEYS = ['passes', 'turfs', 'turf', 'brief'];

function Picks({ id, label, items, value, onPick, className = 'sv-kinds' }) {
  return (
    <div className="field">
      <span className="sv-label" id={id}>{label}</span>
      <div className={className} role="group" aria-labelledby={id}>
        {items.map((k) => (
          <button key={k.code} type="button" className="sv-kind" aria-pressed={value === k.code} onClick={() => onPick(k.code)}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// The form: a name suggested from the kind and the month, until it's typed over.
// list: the List to walk, picked already when the form came from one.
function StartForm({ open, busy, online, onSubmit, onCancel, list = '' }) {
  const uid = useId();
  const [kind, setKind] = useState('persuasion');
  const [who, setWho] = useState('all');
  const [tries, setTries] = useState(2);
  const [typed, setTyped] = useState(null);
  const [error, setError] = useState(null);
  const [listId, setListId] = useState(list);
  const names = useListNames();
  const lists = names.data?.lists ?? [];
  const name = typed ?? suggestName(kind);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Give the pass a name'); return; }
    setError(null);
    const err = await onSubmit({ name: name.trim(), kind, who, tries, ...(listId ? { list_id: listId } : {}) });
    if (err) setError(err);
  };
  return (
    <form className="card pass-form" onSubmit={submit} aria-label="Start a pass">
      <h2>Start a pass</h2>
      <div className="field">
        <label htmlFor={`${uid}-name`}>Name</label>
        <input id={`${uid}-name`} className="input" required maxLength={120} autoComplete="off"
          value={name} onChange={(e) => setTyped(e.target.value)} />
      </div>
      <Picks id={`${uid}-kind`} label="What for" items={KINDS} value={kind} onPick={setKind} />
      <Picks id={`${uid}-who`} label="Who" items={WHO} value={who} onPick={setWho} />
      <div className="field">
        <label htmlFor={`${uid}-list`}>List to walk</label>
        <select id={`${uid}-list`} className="input" value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">None — every door</option>
          {listId && !lists.some((l) => l.id === listId) && <option value={listId}>{names.isPending ? LOADING : names.isError ? 'The list you picked' : 'A list that isn’t here any more'}</option>}
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {names.isError && <span className="error" role="alert"><Unavailable onRetry={() => names.refetch()} /></span>}
      </div>
      <Picks id={`${uid}-tries`} label="Tries" items={TRIES.map((n) => ({ code: n, label: String(n) }))} value={tries} onPick={setTries} className="pass-tries" />
      <p className="muted pass-form__note">
        Doors left on every turf will change when the pass starts.{listId ? ' Only doors with someone on the list are walked.' : ''}{open ? ` This ends “${open.name}”.` : ''}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy || !online}>Start the pass</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function OpenPass({ pass, busy, online, onEnd }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="card pass-open" aria-label="Open pass">
      <span className="eyebrow">Open now</span>
      <h2 className="pass-open__name">{pass.name}</h2>
      <p className="pass-open__line">{passLine(pass)}</p>
      <p className="pass-open__meta muted">started {day(pass.started_at)}</p>
      <p className="pass-open__stats mono">{statsLine(pass.stats, true)}</p>
      {confirm ? (
        <div className="ops-confirm" role="group" aria-label="End this pass">
          <span>End this pass? Until the next one, a door counts as done once anyone there has been knocked.</span>
          <button type="button" className="btn ops-tap sv-danger" disabled={busy || !online} onClick={onEnd}>Yes</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
        </div>
      ) : (
        <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={() => setConfirm(true)}>End this pass</button>
      )}
    </section>
  );
}

export default function Passes() {
  const { me } = useOutletContext() ?? {};
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['passes'], queryFn: () => apiGet('/passes'), enabled: Boolean(me?.user?.id) });
  // Walk this list (a list's Walk button): the form opens with that list picked.
  const [params, setParams] = useSearchParams();
  const fromList = /^[0-9a-f-]{36}$/i.test(params.get('list') || '') ? params.get('list') : '';
  const [adding, setAddingNow] = useState(params.get('new') === '1');
  const setAdding = (on) => { setAddingNow(on); if (!on && (params.get('new') || params.get('list'))) setParams({}, { replace: true }); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [said, setSaid] = useState(null);
  const online = useOnline();

  // Every change is one action; a refusal shows in place, in the server's words.
  const run = async (name, input, done) => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const res = await action(name, input);
      await Promise.all(PASS_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      if (done) setSaid(done);
      return { res };
    } catch (e) {
      return { error: e.message };
    } finally {
      setBusy(false);
    }
  };

  const back = <Link to="/turfs" className="ops-back">← Turfs</Link>;
  const head = (
    <div className="ops-head">
      <h1>Passes</h1>
      {!adding && q.data && (
        <button type="button" className="btn btn-primary ops-tap" disabled={!online || busy} onClick={() => { setSaid(null); setError(null); setAdding(true); }}>
          Start a pass
        </button>
      )}
    </div>
  );
  if (noSignal(q)) return <div className="ops-page pass-page">{back}{head}<NoSignal /></div>;
  if (q.isPending) return <div className="ops-page pass-page">{back}{head}<p className="muted">Loading…</p></div>;
  if (q.isError) return <div className="ops-page pass-page">{back}{head}<p className="error" role="alert">{q.error.message}</p></div>;
  const { open, past = [] } = q.data;

  const start = async (input) => {
    const r = await run('pass.start', input, `✓ Started “${input.name}”`);
    if (r.res) setAdding(false);
    return r.error;
  };
  const end = async () => {
    const r = await run('pass.end', { id: open.id }, `✓ Ended “${open.name}” — a door anyone was knocked at counts as done until the next pass`);
    if (r.error) setError(r.error);
  };

  return (
    <div className="ops-page pass-page">
      {back}
      {head}
      {!online && <NeedsSignalLine>Starting or ending a pass needs signal</NeedsSignalLine>}
      {said && <p className="ops-done" role="status">{said}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {adding && <StartForm open={open} busy={busy} online={online} onSubmit={start} onCancel={() => setAdding(false)} list={fromList} />}
      {open ? (
        <OpenPass pass={open} busy={busy} online={online} onEnd={end} />
      ) : (
        !adding && past.length === 0 && (
          <p className="pass-empty">No pass yet. A pass is a sweep over every turf: who to knock, and how many tries before a door is left.</p>
        )
      )}
      {!open && !adding && past.length > 0 && <p className="ops-meta">No pass open — every door knocked before counts as done.</p>}
      {past.length > 0 && (
        <section aria-label="Past passes">
          <h2 className="pass-past__h">Past passes</h2>
          <ol className="ops-rows">
            {past.map((p) => (
              <li key={p.id} className="ops-item" data-tone="past">
                <div className="ops-row ops-row--static">
                  <span className="ops-row__main">
                    <span className="ops-row__name">{p.name}</span>
                    <span className="ops-row__sub">{passLine(p)} · {day(p.started_at)} – {day(p.ended_at)}</span>
                    <span className="ops-row__sub">{statsLine(p.stats, false)}</span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
