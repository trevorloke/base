// One audience on every screen that names people — Lists, People, Calls, a
// phone bank, a pass, Outreach (server/ext/lists, ext/audience):
//   fmt(n)                12,345 — a number as people read it
//   <Unavailable onRetry />  "Unavailable — Try again": a read that failed.
//                         With "Loading…" and the number itself, the only
//                         three things a number on these screens says.
//   useListNames()        every list at once, by name (GET /lists?counts=later:
//                         a list's numbers ride along only while the server
//                         still keeps them)
//   useListCounts(lists, first)  each list's numbers — { total, with_email,
//                         with_phone, with_call, reachable } — asked for three
//                         at a time, first's first: id → { counts, isError, refetch }
//   useAudienceChoices()  what the rules offer that a screen can't know (this
//                         year; the survey questions)
//   RULE_KEYS             the rules People's filter gained: gave, member,
//                         answer, shift, since (ext/audience), list, notlist (ext/lists),
//                         knows (ext/relationships: knows a supporter, a donor…)
//   useKnowsName(v)       "Knows Priya Nair" for knows=person:<id> (its profile read)
//   ruleChips(f, lists, choices)  the ones picked, in words: [{ key, label }]
//   <RuleGroups chip f update />  People's sheet, under More filters
//   <RuleFields value onChange exclude />  a list's rule builder, under More rules
//   <SnapshotForm input count defaultName />  "Save these people as they are
//                         now": a name, then one action (list.snapshot)
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { useOnline } from './NoSignal.jsx';
import { hasArea } from '../Shell.jsx';
import '../pages/shifts.css';
import './audience.css';

export const fmt = (n) => (Number(n) || 0).toLocaleString('en-CA');
export const LOADING = 'Loading…';

export function Unavailable({ onRetry, children = 'Unavailable' }) {
  return (
    <span className="au-off">
      {children} — <button type="button" className="btn au-retry" onClick={() => onRetry?.()}>Try again</button>
    </span>
  );
}

// ── Lists and their numbers ──
export const useListNames = (enabled = true) => useQuery({
  queryKey: ['lists', 'names'], queryFn: () => apiGet('/lists?counts=later'), enabled, staleTime: 15_000,
});

// A city's lists are counted on the server one by one, each kept a minute:
// asked for a few at a time, so thirty lists never ask thirty counts at once
// — on a first look, or coming back once the numbers have gone stale (a
// list turned on asks the server again then, so it waits its turn too).
const AT_ONCE = 3;
const KEEP_MS = 60_000;
const countKey = (id) => ['lists', 'counts', id];
export function useListCounts(lists, first = null) {
  const queryClient = useQueryClient();
  // The lists turned on since this screen opened stay on; only a count on
  // its way holds a place (one that failed, or went stale, waits quietly).
  const asked = useRef(new Set());
  const ordered = useMemo(() => {
    const all = lists || [];
    return first ? [...all.filter((l) => l.id === first), ...all.filter((l) => l.id !== first)] : all;
  }, [lists, first]);
  const states = ordered.map((l) => queryClient.getQueryState(countKey(l.id)));
  let busy = ordered.filter((l, i) => asked.current.has(l.id) && (states[i]?.fetchStatus === 'fetching' || states[i]?.status === 'pending')).length;
  const results = useQueries({
    queries: ordered.map((l, i) => {
      const s = states[i];
      let enabled = asked.current.has(l.id);
      if (!enabled) {
        // Fresh numbers (or ones that came with the names) ask nothing when turned on.
        const fresh = (!s && Boolean(l.counts)) || (s?.status === 'success' && !s.isInvalidated && Date.now() - s.dataUpdatedAt < KEEP_MS);
        enabled = fresh || busy < AT_ONCE;
        if (enabled && !fresh) busy += 1;
        if (enabled) asked.current.add(l.id);
      }
      return {
        queryKey: countKey(l.id),
        queryFn: () => apiGet(`/lists/${l.id}/counts`).then((r) => r.counts),
        ...(l.counts ? { initialData: l.counts } : {}),
        enabled,
        staleTime: KEEP_MS,
        // Back online, a list's numbers come when it's looked at again — never all at once.
        refetchOnReconnect: false,
        // A count that comes back the same still frees its place for the next one.
        notifyOnChangeProps: ['data', 'error', 'status', 'fetchStatus'],
        retry: 1,
      };
    }),
  });
  return useMemo(() => {
    const out = new Map();
    ordered.forEach((l, i) => {
      const r = results[i];
      out.set(l.id, { counts: r.data ?? null, isError: r.isError && !r.data, refetch: r.refetch });
    });
    return out;
  }, [ordered, results]);
}

export const useAudienceChoices = (enabled = true) => useQuery({
  queryKey: ['audience', 'choices'], queryFn: () => apiGet('/audience/choices'), enabled, staleTime: 60_000, meta: { side: true },
});

// ── The rules, in words ──
export const RULE_KEYS = ['gave', 'member', 'shift', 'answer', 'list', 'notlist', 'since', 'knows'];
// Who they know (ext/relationships). "Knows a donor" only for someone with
// Donations: the server's own money rule matches nobody for anyone else.
const KNOWS = [['supporter', 'Knows a supporter'], ['donor', 'Knows a donor'], ['volunteer', 'Knows a volunteer'], ['any', 'Knows anyone']];
const useKnowsChoices = () => {
  const me = useOutletContext()?.me;
  return hasArea(me, 'money') ? KNOWS : KNOWS.filter(([k]) => k !== 'donor');
};
const knowsPerson = (v) => /^person:([0-9a-f-]{36})$/i.exec(v || '')?.[1] || null;
// knows=person:<id> in words: their name from the profile read (kept, or asked
// once); "Knows someone" while it loads, or if they're gone.
export function useKnowsName(v) {
  const id = knowsPerson(v);
  const q = useQuery({ queryKey: ['person', id], queryFn: () => apiGet(`/persons/${id}`), enabled: Boolean(id), staleTime: 60_000, retry: false });
  return id ? q.data?.person?.name || null : null;
}
const knowsWord = (v, name) => (knowsPerson(v) ? (name ? `Knows ${name}` : 'Knows someone') : KNOWS.find(([k]) => k === v)?.[1] || 'Knows someone');
const GAVE = [['year', 'Gave this year'], ['lapsed', 'Gave before, not this year'], ['never', 'Never gave']];
const MEMBER = [['now', 'Member now'], ['lapsed', 'Lapsed member']];
const SHIFTS = [['came:30', 'Came to a shift · 30 days'], ['came:90', 'Came to a shift · 90 days'], ['missed:30', 'Missed a shift · 30 days'], ['missed:90', 'Missed a shift · 90 days']];
// gave=min:500 is "gave at least $500 in one calendar year" (whole dollars).
const minOf = (v) => /^min:(\d+)$/.exec(v || '')?.[1] || '';
const dollars = (typed) => Math.round(Number(String(typed).replace(/[$,\s]/g, '')) || 0);
const gaveWord = (v) => {
  const min = minOf(v);
  if (min) return `Gave $${fmt(min)}+ in a year`;
  return GAVE.find(([k]) => k === v)?.[1] || 'Gave';
};
const shiftWord = (v) => {
  const m = /^(came|missed):(\d+)$/.exec(v || '');
  if (!m) return 'A shift';
  return SHIFTS.find(([k]) => k === v)?.[1] || `${m[1] === 'came' ? 'Came to' : 'Missed'} a shift · ${m[2]} days`;
};
const dayWord = (ymd) => {
  const d = new Date(`${ymd}T12:00:00`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
};
// A survey question's answers, as the rule takes them ([value, words]).
const answersOf = (q) => {
  if (!q) return [];
  if (q.kind === 'yesno') return [['yes', 'Yes'], ['no', 'No']];
  if (q.kind === 'scale') return ['1', '2', '3', '4', '5'].map((n) => [n, n]);
  if (q.kind === 'choice' || q.kind === 'choices') return (q.options || []).map((o) => [o, o]);
  return [];
};
const splitAnswer = (v) => {
  const s = String(v || '');
  const at = s.indexOf(':');
  return at < 0 ? [s, ''] : [s.slice(0, at), s.slice(at + 1)];
};
const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const answerWord = (v, questions) => {
  const [id, want] = splitAnswer(v);
  const q = (questions || []).find((x) => x.id === id);
  const said = want === 'any' ? 'any answer' : (answersOf(q).find(([k]) => k === want)?.[1] || want);
  return q ? `${short(q.text)}: ${said}` : `A survey answer: ${said}`;
};
const listName = (id, lists) => (lists || []).find((l) => l.id === id)?.name;

export const ruleChips = (f, lists = [], choices = null, knowsName = null) => [
  f.gave && { key: 'gave', label: gaveWord(f.gave) },
  f.member && { key: 'member', label: MEMBER.find(([k]) => k === f.member)?.[1] || 'Member' },
  f.shift && { key: 'shift', label: shiftWord(f.shift) },
  f.answer && { key: 'answer', label: answerWord(f.answer, choices?.questions) },
  f.list && { key: 'list', label: `On “${listName(f.list, lists) || 'a list'}”` },
  f.notlist && { key: 'notlist', label: `Not on “${listName(f.notlist, lists) || 'a list'}”` },
  f.since && { key: 'since', label: `Added since ${dayWord(f.since)}` },
  f.knows && { key: 'knows', label: knowsWord(f.knows, knowsName) },
].filter(Boolean);
export const rulesPicked = (f) => RULE_KEYS.filter((k) => f[k]).length;

// ── People's sheet: chip rows, and a select where a chip row would be too long ──
export function RuleGroups({ chip, f, update }) {
  const id = useId();
  const knows = useKnowsChoices();
  const lists = useListNames().data?.lists ?? [];
  const choices = useAudienceChoices().data;
  const questions = choices?.questions ?? [];
  const [qid, want] = splitAnswer(f.answer);
  const q = questions.find((x) => x.id === qid);
  // The amount box shows the rule as it stands: a chip (this year, never…)
  // takes the place of an amount, and the other way round.
  const shownMin = minOf(f.gave);
  const setGaveMin = (v) => update({ gave: dollars(v) > 0 ? `min:${dollars(v)}` : null });
  return (
    <>
      <fieldset className="pp-group">
        <legend className="eyebrow">Gave</legend>
        <div className="pp-group__opts">{GAVE.map(([k, l]) => chip('gave', k, l))}</div>
        <div className="field au-inline">
          <label htmlFor={`${id}-min`}>Gave at least, in one year ($)</label>
          <input id={`${id}-min`} className="input mono" inputMode="numeric" autoComplete="off" placeholder="500"
            value={shownMin} onChange={(e) => setGaveMin(e.target.value)} />
        </div>
      </fieldset>
      <fieldset className="pp-group">
        <legend className="eyebrow">Membership</legend>
        <div className="pp-group__opts">{MEMBER.map(([k, l]) => chip('member', k, l))}</div>
      </fieldset>
      <fieldset className="pp-group">
        <legend className="eyebrow">Shifts</legend>
        <div className="pp-group__opts">{SHIFTS.map(([k, l]) => chip('shift', k, l))}</div>
      </fieldset>
      <fieldset className="pp-group">
        <legend className="eyebrow">Knows</legend>
        <div className="pp-group__opts">{knows.map(([k, l]) => chip('knows', k, l))}</div>
      </fieldset>
      {(questions.length > 0 || f.answer) && (
        <fieldset className="pp-group">
          <legend className="eyebrow">Survey answer</legend>
          <div className="form-row">
            <div className="field">
              <label htmlFor={`${id}-q`}>Question</label>
              <select id={`${id}-q`} className="input" value={f.answer ? qid : ''} onChange={(e) => update({ answer: e.target.value ? `${e.target.value}:any` : null })}>
                <option value="">Any question</option>
                {/* A rule whose question hasn't loaded (or is gone) still shows as picked. */}
                {f.answer && !q && <option value={qid}>{answerWord(f.answer, questions)}</option>}
                {questions.map((x) => <option key={x.id} value={x.id}>{short(x.text, 60)}</option>)}
              </select>
            </div>
            {q && (
              <div className="field">
                <label htmlFor={`${id}-a`}>Their latest answer</label>
                <select id={`${id}-a`} className="input" value={want || 'any'} onChange={(e) => update({ answer: `${qid}:${e.target.value}` })}>
                  <option value="any">Any answer</option>
                  {answersOf(q).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            )}
          </div>
        </fieldset>
      )}
      {(lists.length > 0 || f.list || f.notlist) && (
        <fieldset className="pp-group">
          <legend className="eyebrow">Lists</legend>
          <div className="form-row">
            <ListSelect id={`${id}-on`} label="On the list" value={f.list} lists={lists} onChange={(v) => update({ list: v || null })} />
            <ListSelect id={`${id}-off`} label="Not on the list" value={f.notlist} lists={lists} onChange={(v) => update({ notlist: v || null })} />
          </div>
        </fieldset>
      )}
      <div className="field au-inline">
        <label htmlFor={`${id}-since`}>Added since</label>
        <input id={`${id}-since`} className="input" type="date" value={f.since || ''} onChange={(e) => update({ since: e.target.value || null })} />
      </div>
    </>
  );
}

function ListSelect({ id, label, value, lists, onChange, exclude = null }) {
  const shown = lists.filter((l) => l.id !== exclude);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any list</option>
        {value && !shown.some((l) => l.id === value) && <option value={value}>A list</option>}
        {shown.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </div>
  );
}

// ── A list's rule builder: the same rules as selects, under "More rules" ──
export function RuleFields({ value, onChange, exclude = null }) {
  const id = useId();
  const knows = useKnowsChoices();
  const knowsName = useKnowsName(value.knows);
  const picked = rulesPicked(value);
  const [open, setOpen] = useState(picked > 0);
  const lists = useListNames().data?.lists ?? [];
  const questions = useAudienceChoices().data?.questions ?? [];
  const set = (k) => (v) => onChange({ ...value, [k]: v || '' });
  const [qid, want] = splitAnswer(value.answer);
  const q = questions.find((x) => x.id === qid);
  // "At least…" stays picked while its amount is being typed (no rule until there is one).
  const [gaveKind, setGaveKind] = useState(minOf(value.gave) ? 'min' : value.gave || '');
  const [min, setMin] = useState(minOf(value.gave));
  const pickGave = (v) => {
    setGaveKind(v);
    set('gave')(v === 'min' ? (dollars(min) > 0 ? `min:${dollars(min)}` : '') : v);
  };
  const typeMin = (v) => {
    setMin(v);
    set('gave')(dollars(v) > 0 ? `min:${dollars(v)}` : '');
  };
  return (
    <div className="au-rules">
      <button type="button" className="disclose disclose--inline au-rules__toggle" aria-expanded={open} aria-controls={`${id}-more`} onClick={() => setOpen((o) => !o)}>
        More rules{!open && picked ? <span className="pp-badge">{picked}</span> : null}
      </button>
      {open && (
        <div id={`${id}-more`} className="form-row au-rules__body">
          <div className="field">
            <label htmlFor={`${id}-gave`}>Gave</label>
            <select id={`${id}-gave`} className="input" value={gaveKind} onChange={(e) => pickGave(e.target.value)}>
              <option value="">Anyone</option>
              {GAVE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              <option value="min">At least, in one year…</option>
            </select>
          </div>
          {gaveKind === 'min' && (
            <div className="field">
              <label htmlFor={`${id}-min`}>At least ($)</label>
              <input id={`${id}-min`} className="input mono" inputMode="numeric" autoComplete="off" placeholder="500" value={min} onChange={(e) => typeMin(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label htmlFor={`${id}-member`}>Membership</label>
            <select id={`${id}-member`} className="input" value={value.member || ''} onChange={(e) => set('member')(e.target.value)}>
              <option value="">Anyone</option>
              {MEMBER.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-shift`}>Shifts</label>
            <select id={`${id}-shift`} className="input" value={value.shift || ''} onChange={(e) => set('shift')(e.target.value)}>
              <option value="">Anyone</option>
              {value.shift && !SHIFTS.some(([k]) => k === value.shift) && <option value={value.shift}>{shiftWord(value.shift)}</option>}
              {SHIFTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          {(questions.length > 0 || value.answer) && (
            <>
              <div className="field">
                <label htmlFor={`${id}-q`}>Survey question</label>
                <select id={`${id}-q`} className="input" value={value.answer ? qid : ''} onChange={(e) => set('answer')(e.target.value ? `${e.target.value}:any` : '')}>
                  <option value="">Any question</option>
                  {/* A rule whose question hasn't loaded (or is gone) still shows as picked. */}
                  {value.answer && !q && <option value={qid}>{answerWord(value.answer, questions)}</option>}
                  {questions.map((x) => <option key={x.id} value={x.id}>{short(x.text, 60)}</option>)}
                </select>
              </div>
              {q && (
                <div className="field">
                  <label htmlFor={`${id}-a`}>Their latest answer</label>
                  <select id={`${id}-a`} className="input" value={want || 'any'} onChange={(e) => set('answer')(`${qid}:${e.target.value}`)}>
                    <option value="any">Any answer</option>
                    {answersOf(q).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
              )}
            </>
          )}
          <div className="field">
            <label htmlFor={`${id}-knows`}>Knows</label>
            <select id={`${id}-knows`} className="input" value={value.knows || ''} onChange={(e) => set('knows')(e.target.value)}>
              <option value="">Anyone</option>
              {/* "Priya Nair’s circle", or a rule this viewer can't pick, still shows as picked. */}
              {value.knows && !knows.some(([k]) => k === value.knows) && <option value={value.knows}>{knowsWord(value.knows, knowsName)}</option>}
              {knows.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <ListSelect id={`${id}-on`} label="On another list" value={value.list} lists={lists} exclude={exclude} onChange={set('list')} />
          <ListSelect id={`${id}-off`} label="Not on another list" value={value.notlist} lists={lists} exclude={exclude} onChange={set('notlist')} />
          <div className="field">
            <label htmlFor={`${id}-since`}>Added since</label>
            <input id={`${id}-since`} className="input" type="date" value={value.since || ''} onChange={(e) => set('since')(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── "Save these people as they are now" ──
// input: { filter } or { list_id } — list.snapshot keeps exactly who it
// names this moment, as a hand-picked list (up to the whole file).
const today = () => new Date().toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
// link: the opener reads as a link beside "Save as a list" (People's count line).
export function SnapshotForm({ input, count = null, defaultName = 'People', className = '', link = false }) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Cancel puts the keyboard back on the button that opened the form.
  const opener = useRef(null);
  const [closed, setClosed] = useState(false);
  useEffect(() => { if (closed && !open) { opener.current?.focus(); setClosed(false); } }, [closed, open]);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await action('list.snapshot', { name: name.trim(), ...input });
      await queryClient.invalidateQueries({ queryKey: ['lists'] });
      navigate(`/lists/${r.list.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  // Nobody matches right now: nothing to keep.
  if (!open && count === 0) return null;
  if (!open) {
    return (
      <button type="button" ref={opener} className={`${link ? 'au-snap__link' : 'btn btn-quiet ops-tap'} ${className}`} disabled={!online}
        onClick={() => { setName(`${defaultName} — ${today()}`); setOpen(true); }}>
        Save these people as they are now
      </button>
    );
  }
  return (
    <form className={`au-snap ${className}`} onSubmit={save} aria-label="Save these people as they are now">
      <div className="field au-snap__name">
        <label htmlFor={`${id}-n`}>Name of the new list</label>
        <input id={`${id}-n`} className="input" required maxLength={120} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <p className="ops-meta au-snap__note">
        {count != null ? `Keeps exactly these ${fmt(count)}` : 'Keeps exactly these people'} — the list won’t change as they do.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn ops-tap" disabled={busy || !online || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={() => { setOpen(false); setClosed(true); }}>Cancel</button>
      </div>
    </form>
  );
}
