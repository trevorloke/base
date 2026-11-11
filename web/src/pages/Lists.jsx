// Lists — saved filters and hand-picked lists of people: the one audience
// for an email, a text, a phone bank (Call) and a pass (Walk), a CSV.
//   /lists           every list by name at once, then each one's numbers as
//                    they're counted (kept a minute on the server): how many
//                    it names and how many can be reached by any channel;
//                    Email · Text · Call · Walk, each with how many it
//                    reaches · New list
//   /lists/new       a new one: a saved filter (tag, rating, role, has, the
//                    field's cuts, and under More rules: gave, membership,
//                    shifts, a survey answer, another list, added since — the
//                    count updates as you pick) or a hand-picked list;
//                    People's "Save as a list" arrives here with the filter
//                    filled in
//   /lists/:id       its numbers, Email · Text · Call · Walk this list, its
//                    people, search, Add people (hand-picked), Remove, Edit the
//                    filter, Download CSV, Save these people as they are now
// Every number is the number, "Loading…" or "Unavailable — Try again".
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import { ApiError, apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { useScale } from '../components/RatingButtons.jsx';
import { useAction, ratingBands } from './People.jsx';
import { CUT_KEYS, CutFields, useTurfs } from '../components/FieldCuts.jsx';
import {
  LOADING, RULE_KEYS, RuleFields, SnapshotForm, Unavailable, fmt, useListCounts, useListNames,
} from '../components/AudienceBits.jsx';
import './shifts.css';
import './lists.css';
import { at } from '../base.js';

const FILTER_KEYS = ['q', 'tag', 'rating', 'role', 'has', 'field', ...CUT_KEYS, ...RULE_KEYS];
const HAS = [['', 'Anyone'], ['email', 'An email address'], ['phone', 'A phone number'], ['location', 'A pin on the map']];
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const qs = (f) => new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([k, v]) => v && FILTER_KEYS.includes(k)))).toString();
const cleanFilter = (f) => Object.fromEntries(Object.entries(f || {}).filter(([k, v]) => v && FILTER_KEYS.includes(k)));

// A filter's count before it's saved: the number, Loading…, or Unavailable.
function Counts({ q, kind }) {
  if (q.isError && !q.data) return <Unavailable onRetry={() => q.refetch()} />;
  const counts = q.data?.counts;
  if (!counts) return LOADING;
  return (
    <span className="ls-counts">
      <strong className="mono">{fmt(counts.total)}</strong> {plural(counts.total, 'person', 'people')}
      <span> · {fmt(counts.with_email)} can be emailed · {fmt(counts.with_phone)} texted · {fmt(counts.with_call)} called</span>
      {kind === 'filter' && <span className="muted"> · matches today</span>}
    </span>
  );
}

// Each way a list goes out, pointed at it: Email · Text · Call (a phone bank
// made from it) · Walk (a pass that walks it). counts: how many each reaches,
// once counted (a row); words: "Email this list" (the list's own page).
const WAYS = [
  { key: 'email', label: 'Email', to: (id) => `/outreach/email?new=1&list=${id}`, n: 'with_email' },
  { key: 'text', label: 'Text', to: (id) => `/outreach/texting?new=1&list=${id}`, n: 'with_phone' },
  { key: 'call', label: 'Call', to: (id) => `/banks/new?list=${id}`, n: 'with_call' },
  { key: 'walk', label: 'Walk', to: (id) => `/passes?new=1&list=${id}`, n: null },
];
const REACH_WORD = { email: 'can be emailed', text: 'can be texted', call: 'can be called' };
function Ways({ id, name, counts = null, page = false }) {
  return (
    <div className={`au-go${page ? ' au-go--page' : ''}`} role="group" aria-label={`Reach ${name}`}>
      {WAYS.map((w) => {
        const n = w.n && counts ? counts[w.n] : null;
        return (
          <Link key={w.key} className="btn ops-tap" to={w.to(id)}
            aria-label={page ? undefined : `${w.label} ${name}${n != null ? ` — ${fmt(n)} ${REACH_WORD[w.key]}` : ''}`}>
            {page ? `${w.label} this list` : w.label}
            {!page && n != null && <span className="au-n" aria-hidden="true">{fmt(n)}</span>}
          </Link>
        );
      })}
    </div>
  );
}

// The filter fields: the same choices as People's own filter.
function FilterFields({ value, onChange, exclude = null }) {
  const scale = useScale();
  const turfs = useTurfs();
  const tags = useQuery({ queryKey: ['lists', 'tags'], queryFn: () => apiGet('/lists/tags') });
  const set = (k) => (v) => onChange({ ...value, [k]: v || '' });
  return (
    <div className="ls-filter">
      <div className="field">
        <label htmlFor="ls-tag">Tag <span className="muted">(or several, with commas)</span></label>
        <input id="ls-tag" className="input" list="ls-tags" value={value.tag || ''} onChange={(e) => set('tag')(e.target.value)} placeholder="member, volunteer…" />
        <datalist id="ls-tags">{(tags.data?.tags ?? []).map((t) => <option key={t.tag} value={t.tag}>{t.n}</option>)}</datalist>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ls-rating">Rating</label>
          <select id="ls-rating" className="input" value={value.rating || ''} onChange={(e) => set('rating')(e.target.value)}>
            <option value="">Any</option>
            {ratingBands(scale).map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ls-role">Volunteer role</label>
          <select id="ls-role" className="input" value={value.role || ''} onChange={(e) => set('role')(e.target.value)}>
            <option value="">Any</option>
            {VOLUNTEER_ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ls-has">Has</label>
          <select id="ls-has" className="input" value={value.has || ''} onChange={(e) => set('has')(e.target.value)}>
            {HAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="ls-q">Words <span className="muted">(name, street, phone, email)</span></label>
        <input id="ls-q" className="input" value={value.q || ''} onChange={(e) => set('q')(e.target.value)} />
      </div>
      <CutFields value={value} onChange={onChange} turfs={turfs} />
      <RuleFields value={value} onChange={onChange} exclude={exclude} />
    </div>
  );
}

// Counted once the typing settles: a city's file isn't counted on every key.
function usePreview(filter, on) {
  const key = useSettled(qs(filter));
  return useQuery({ queryKey: ['lists', 'preview', key], queryFn: () => apiGet(`/lists/preview?${key}`), enabled: on, retry: 1 });
}

// Add people to a hand-picked list: search, tap to add.
function AddPeople({ listId, onAdded }) {
  const [q, setQ] = useState('');
  const found = useQuery({ queryKey: ['persons', 'ls-search', q], queryFn: () => apiGet(`/persons?q=${encodeURIComponent(q.trim())}&limit=20`), enabled: q.trim().length >= 2 });
  const act = useAction(() => onAdded(), { needsSignal: true });
  return (
    <div className="ls-add">
      <div className="field">
        <label htmlFor="ls-add-q">Add people</label>
        <input id="ls-add-q" className="input" type="search" placeholder="Type a name" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {act.error && <p className="error">{act.error}</p>}
      {q.trim().length >= 2 && (
        <ul className="ops-rows ls-found">
          {(found.data?.persons ?? []).map((p) => (
            <li key={p.id} className="ops-item">
              <div className="ops-row ops-row--static">
                <span className="ops-row__main"><span className="ops-row__name">{p.name}</span><span className="ops-row__sub">{p.email && <span>{p.email}</span>}{p.phone && <span>{p.phone}</span>}</span></span>
                <button type="button" className="btn btn-quiet ops-tap" disabled={act.busy} onClick={() => act.run('list.add', { id: listId, person_ids: [p.id] })}>Add</button>
              </div>
            </li>
          ))}
          {found.isSuccess && !found.data.persons.length && <li className="ops-empty">No one by that name.</li>}
        </ul>
      )}
    </div>
  );
}

function NewList() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromPeople = cleanFilter(Object.fromEntries(params));
  const [name, setName] = useState('');
  const [kind, setKind] = useState('filter');
  const [filter, setFilter] = useState(fromPeople);
  const preview = usePreview(filter, kind === 'filter');
  const queryClient = useQueryClient();
  const act = useAction(() => queryClient.invalidateQueries({ queryKey: ['lists'] }), { needsSignal: true });
  const submit = async (e) => {
    e.preventDefault();
    const res = await act.run('list.create', { name: name.trim(), kind, ...(kind === 'filter' ? { filter: cleanFilter(filter) } : {}) });
    if (res) navigate(`/lists/${res.list.id}`, { replace: true });
  };
  return (
    <form className="ops-page ls-page" onSubmit={submit}>
      <Link className="ops-back" to="/lists">← Lists</Link>
      <div className="ops-head"><h1>New list</h1></div>
      <div className="field">
        <label htmlFor="ls-name">Name</label>
        <input id="ls-name" className="input" required maxLength={120} value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Members in Newton" />
      </div>
      <div className="ls-kinds" role="radiogroup" aria-label="Kind of list">
        <label className={`ls-kind${kind === 'filter' ? ' is-on' : ''}`}><input type="radio" name="kind" checked={kind === 'filter'} onChange={() => setKind('filter')} /> <span><strong>A saved filter</strong><br /><span className="muted">Whoever matches it, today and as people change.</span></span></label>
        <label className={`ls-kind${kind === 'people' ? ' is-on' : ''}`}><input type="radio" name="kind" checked={kind === 'people'} onChange={() => setKind('people')} /> <span><strong>Hand-picked</strong><br /><span className="muted">The people you put on it.</span></span></label>
      </div>
      {kind === 'filter' && (
        <>
          <FilterFields value={filter} onChange={setFilter} />
          <p className="ls-preview" aria-live="polite"><Counts q={preview} kind="filter" /></p>
        </>
      )}
      {kind === 'people' && <p className="ops-meta">Save it, then add people by name.</p>}
      {act.error && <p className="error" role="alert">{act.error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={act.busy || !name.trim()}>Save list</button>
        <Link className="btn btn-quiet ops-tap" to="/lists">Cancel</Link>
      </div>
    </form>
  );
}

// A list's numbers on its own page, each a number with a short label.
const FIGS = [['total', null], ['with_email', 'can be emailed'], ['with_phone', 'can be texted'], ['with_call', 'can be called'], ['reachable', 'can be reached']];
function Figures({ counts }) {
  return (
    <ul className="au-figs" aria-label="How many">
      {FIGS.map(([k, label]) => (
        <li key={k} className="au-fig">
          <span className="au-fig__n">{fmt(counts[k])}</span>
          <span className="au-fig__label">{label || plural(counts.total, 'person', 'people')}</span>
        </li>
      ))}
    </ul>
  );
}

// Typing in a search asks once it settles, not on every key.
function useSettled(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function OneList({ id }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [typed, setQ] = useState('');
  const q = useSettled(typed.trim());
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState(null);
  const [asking, setAsking] = useState(false);
  // A search keeps the page on screen (dimmed) while it loads, never a blank page.
  const list = useQuery({
    queryKey: ['lists', id, q], queryFn: () => apiGet(`/lists/${id}?q=${encodeURIComponent(q)}&limit=500`),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === id ? prev : undefined),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['lists'] });
  const act = useAction(refresh, { needsSignal: true });
  const l = list.data?.list;
  useEffect(() => { if (l && filter == null) setFilter(l.filter || {}); }, [l, filter]);
  const preview = usePreview(filter || {}, !!(editing && l?.kind === 'filter'));
  if (noSignal(list)) return <NoSignal />;
  if (list.isError && !list.data) {
    return (
      <div className="ops-page ls-page">
        <Link className="ops-back" to="/lists">← Lists</Link>
        {list.error instanceof ApiError && list.error.status === 404
          ? <p className="ops-empty">That list isn’t here any more.</p>
          : <p className="error" role="alert"><Unavailable onRetry={() => list.refetch()} /></p>}
      </div>
    );
  }
  if (!l) return <div className="ops-page ls-page"><Link className="ops-back" to="/lists">← Lists</Link><p className="muted">Loading…</p></div>;
  const people = list.data.people;
  const stale = list.isPlaceholderData;
  const saveFilter = async () => { if (await act.run('list.update', { id, filter: cleanFilter(filter) })) setEditing(false); };
  const del = async () => { if (await act.run('list.delete', { id })) navigate('/lists'); };
  return (
    <div className="ops-page ls-page">
      <Link className="ops-back" to="/lists">← Lists</Link>
      <div className="ops-head">
        <h1>{l.name}</h1>
      </div>
      <p className="ops-meta">{l.kind === 'filter' ? 'A saved filter: whoever matches it today.' : 'Hand-picked: the people put on it.'}</p>
      <Figures counts={list.data.counts} />
      <Ways id={id} name={l.name} page />
      <div className="ops-actions ls-tools">
        <a className="btn btn-quiet ops-tap" href={at(`/api/lists/${id}/export.csv`)}>Download CSV</a>
        {l.kind === 'filter' && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setEditing((v) => !v)}>{editing ? 'Close' : 'Edit the filter'}</button>}
        {asking ? (
          <span className="ops-confirm"><span>Delete this list?</span>
            <button type="button" className="btn ops-danger ops-tap" disabled={act.busy} onClick={del}>Yes</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(false)}>No</button></span>
        ) : <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(true)}>Delete</button>}
        <SnapshotForm input={{ list_id: id }} count={list.data.counts.total} defaultName={l.name} />
      </div>
      {act.error && <p className="error" role="alert">{act.error}</p>}
      {editing && l.kind === 'filter' && filter && (
        <div className="card ls-edit">
          <FilterFields value={filter} onChange={setFilter} exclude={id} />
          <p className="ls-preview" aria-live="polite"><Counts q={preview} kind="filter" /></p>
          <button type="button" className="btn btn-primary ops-tap" disabled={act.busy} onClick={saveFilter}>Save the filter</button>
        </div>
      )}
      {l.kind === 'people' && <AddPeople listId={id} onAdded={refresh} />}
      <input className="input ls-search" type="search" placeholder="Search this list" aria-label="Search this list" value={typed} onChange={(e) => setQ(e.target.value)} />
      {list.isError && <p className="error" role="alert"><Unavailable onRetry={() => list.refetch()} /></p>}
      {!people.length && !stale && <p className="ops-empty">{q ? 'No one by that name.' : l.kind === 'people' ? 'No one on this list yet.' : 'No one matches this filter yet.'}</p>}
      <ul className={`ops-rows${stale ? ' au-stale' : ''}`} aria-busy={stale || undefined}>
        {people.map((p) => (
          <li key={p.id} className="ops-item">
            <div className="ops-row ops-row--static">
              <Link className="ops-row__main ls-link" to={`/people/${p.id}`}>
                <span className="ops-row__name">{p.name}</span>
                <span className="ops-row__sub">{p.email && <span>{p.email}</span>}{p.phone && <span>{p.phone}</span>}{p.city && <span>{p.city}</span>}</span>
              </Link>
              {l.kind === 'people' && <button type="button" className="btn btn-quiet ops-tap" disabled={act.busy} onClick={() => act.run('list.remove', { id, person_ids: [p.id] })}>Remove</button>}
            </div>
          </li>
        ))}
      </ul>
      {list.data.total > people.length && <p className="ops-meta">Showing {fmt(people.length)} of {fmt(list.data.total)}. Download the CSV for everyone.</p>}
    </div>
  );
}

// A row's numbers: how many it names and how many can be reached at all — or
// Loading… / Unavailable while its count is on its way or failed.
function RowNumbers({ c }) {
  if (c?.counts) {
    return <span>{fmt(c.counts.total)} {plural(c.counts.total, 'person', 'people')} · {fmt(c.counts.reachable)} can be reached</span>;
  }
  if (c?.isError) return <Unavailable onRetry={c.refetch} />;
  return <span>{LOADING}</span>;
}

function AllLists() {
  // The names at once; each list's numbers as they're counted.
  const lists = useListNames();
  const all = lists.data?.lists ?? [];
  const counts = useListCounts(all);
  return (
    <div className="ops-page ls-page">
      <div className="ops-head">
        <h1>Lists</h1>
        <div className="ops-head__actions"><Link className="btn btn-primary ops-tap" to="/lists/new">New list</Link></div>
      </div>
      <p className="ops-meta">A saved filter is whoever matches it today; a hand-picked list, who you put on it.</p>
      {noSignal(lists) && <NoSignal />}
      {lists.isPending && !noSignal(lists) && <p className="muted">{LOADING}</p>}
      {lists.isError && !noSignal(lists) && <p className="error" role="alert"><Unavailable onRetry={() => lists.refetch()} /></p>}
      {lists.isSuccess && !all.length && <p className="ops-empty">No lists yet. Filter People and tap <em>Save as a list</em>, or start one here.</p>}
      <ul className="ops-rows">
        {all.map((l) => {
          const c = counts.get(l.id);
          return (
            <li key={l.id} className="ops-item">
              <div className="au-row">
                <span className="au-row__main">
                  <Link className="au-row__name" to={`/lists/${l.id}`}>{l.name}</Link>
                  <span className="ops-row__sub"><span>{l.kind === 'filter' ? 'Saved filter' : 'Hand-picked'}</span><RowNumbers c={c} /></span>
                </span>
                <Ways id={l.id} name={l.name} counts={c?.counts} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function Lists() {
  const { id } = useParams();
  if (id === 'new') return <NewList />;
  return id ? <OneList key={id} id={id} /> : <AllLists />;
}
