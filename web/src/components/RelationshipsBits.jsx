// Relationships on other screens — who knows whom.
//
//   KINDS, kindWord(code)        Family · Friend · Neighbour · Work · Community · Other
//   useMyPeople(me)              GET /relationships/mine, kept on this phone for a day
//                                (query key ['persons', 'mine']: every write that
//                                changes people refetches it)
//   <MyPeopleLink me />          Calls' quiet "My people · 6" (→ /my-people)
//   usePersonKnows(id, desk)     a profile's Knows (desk only; kept for no
//                                signal like the profile — KeptCopies.js)
//   <KnowsNudge query person />  "Ask Priya Nair — they know each other": one line
//                                on the profile of someone undecided or not rated
//                                (never someone tagged do-not-contact); and "May
//                                be the same person as …" when a volunteer's add
//                                may have doubled someone (same email or name)
//   <PersonKnows person query /> the Knows section: who they know (name, kind ·
//                                note, rating), "Brought in by", "+ Someone they
//                                know" (search the list, then how they know each
//                                other), and Remove? Yes · No in place — both
//                                need signal, and say so
//   linkWords(link)              "Neighbour · Same block": the kind, and the note
//   <KeyTies ties n max housemates state />  the key line: "Knows Sofia
//                                Petrova Friend · Close · 3 more · Same address:
//                                Ann Example" (desk: the profile, the Calls card)
//   useKeyTies(ids, enabled)     GET /relationships/key for up to 20 people
//   useKnowMe(person, me)        is this person in your own circle? From the
//                                phone's My people and the outbox (no new read)
//   <KnowMeChip />, <IKnowThem /> "You know them · Friend", and the one-tap
//                                "I know them" (every role; saved offline)
// No pronouns are guessed from names: the words never need one.
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rankTies } from '@starbase/shared/ties';
import { apiGet, action } from '../api.js';
import { newClientId, queueAction, useOutbox } from '../offline.js';
import { queuedText } from './queued.js';
import { Unavailable } from './AudienceBits.jsx';
import { RatingChip } from './RatingButtons.jsx';
import { phoneCopy, useKeepCopy } from './OfflineCache.js';
import { NeedsSignal, NoSignal, noSignal, useOnline } from './NoSignal.jsx';
import '../pages/relationships.css';
import '../pages/relationships-key.css';

export const KINDS = [
  { code: 'family', label: 'Family' },
  { code: 'friend', label: 'Friend' },
  { code: 'neighbour', label: 'Neighbour' },
  { code: 'work', label: 'Work' },
  { code: 'community', label: 'Community' },
  { code: 'other', label: 'Other' },
];
export const kindWord = (code) => KINDS.find((k) => k.code === code)?.label || 'Other';
export const linkWords = (link) => [kindWord(link?.kind), String(link?.note || '').trim()].filter(Boolean).join(' · ');

export const MINE_KEY = ['persons', 'mine'];
const MINE_COPY = 'my-people';

export function useMyPeople(me) {
  const q = useQuery({
    queryKey: MINE_KEY,
    queryFn: () => apiGet('/relationships/mine'),
    // The phone's copy stands in for no signal only: it counts as old, so
    // with signal the server is always asked first (a removal elsewhere).
    ...phoneCopy(me, MINE_COPY),
    initialDataUpdatedAt: 0,
  });
  useKeepCopy(me, MINE_COPY, q);
  return q;
}

export function MyPeopleLink({ me }) {
  const location = useLocation();
  const n = useMyPeople(me).data?.people?.length || 0;
  const label = location.pathname === '/calls' && new URLSearchParams(location.search).get('channel') === 'text' ? 'Texts' : 'Calls';
  return (
    <Link className="rel-link" to="/my-people" state={{ from: { to: `${location.pathname}${location.search}`, label } }}>
      My people{n ? <> · <span className="mono">{n}</span></> : null}
    </Link>
  );
}

// Every query that shows a link or the people at its ends.
const useRefresh = () => {
  const queryClient = useQueryClient();
  return () => Promise.all(['person', 'persons', 'brief'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
};

function useRun() {
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    try {
      const res = await action(name, input);
      await refresh();
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

export const usePersonKnows = (id, desk) => useQuery({
  queryKey: ['person', id, 'knows'],
  queryFn: () => apiGet(`/persons/${id}/knows`),
  enabled: Boolean(id) && Boolean(desk),
});

const undecided = (p) => p && (p.rating == null || p.rating === '3');
const dnc = (p) => Array.isArray(p?.tags) && p.tags.includes('do-not-contact');

export function KnowsNudge({ query, person }) {
  const n = query.data?.nudge;
  const same = query.data?.same_as || [];
  const nudge = n && undecided(person) && !dnc(person);
  if (!nudge && !same.length) return null;
  return (
    <>
      {nudge && (
        <p className="rel-nudge">
          Ask <Link to={`/people/${n.id}`}>{n.name}</Link> — they know each other
        </p>
      )}
      {same.length > 0 && (
        <p className="rel-same">
          May be the same person as{' '}
          {same.map((x, i) => (
            <Fragment key={x.id}>{i ? ', ' : ''}<Link to={`/people/${x.id}`}>{x.name}</Link></Fragment>
          ))}
        </p>
      )}
    </>
  );
}

// Adding a link needs signal (it's a desk write, never saved on the device).
const NEEDS = 'Adding someone they know needs signal';

// Said under every note about who knows whom (profile and My people).
export const NOTE_HELP = 'Only what helps the campaign — no health, family or money details.';

function AddKnown({ person, known, onClose }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null);
  const [note, setNote] = useState('');
  const inputId = useId();
  const noteId = useId();
  const act = useRun();
  const online = useOnline();
  const term = q.trim();
  const found = useQuery({
    queryKey: ['persons', 'pick', term],
    queryFn: () => apiGet(`/persons?${new URLSearchParams({ q: term, limit: '12' })}`),
    enabled: term.length >= 2,
    staleTime: 30_000,
  });
  const list = (found.data?.persons || []).filter((p) => p.id !== person.id && !known.has(p.id)).slice(0, 6);
  // No signal: the search can't answer and the link can't go — said once, in place.
  const off = !online || (term.length >= 2 && noSignal(found));
  const add = async (kind) => {
    const res = await act.run('relationship.add', { from_id: person.id, person_id: pick.id, kind, note: note.trim() || undefined });
    if (res) onClose();
  };
  if (pick) {
    return (
      <div className="rel-add">
        <p className="rel-add__q">{pick.name} — how do they know each other?</p>
        <div className="rel-kinds" role="group" aria-label="How they know each other">
          {KINDS.map((k) => (
            <button key={k.code} type="button" className="rel-kind" disabled={act.busy || !online} onClick={() => add(k.code)}>{k.label}</button>
          ))}
        </div>
        <div className="field rel-add__note">
          <label htmlFor={noteId}>Note (optional)</label>
          <input id={noteId} className="input" maxLength={200} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)}
            aria-describedby={`${noteId}-help`} />
          <p className="rk-help" id={`${noteId}-help`}>{NOTE_HELP}</p>
        </div>
        {!online ? <NeedsSignal className="pf-empty">{NEEDS}</NeedsSignal> : act.error && <p className="error" role="alert">{act.error}</p>}
        <button type="button" className="btn btn-quiet pp-btn" onClick={() => setPick(null)}>Back</button>
      </div>
    );
  }
  return (
    <div className="rel-add">
      <label className="rel-add__q" htmlFor={inputId}>Who do they know?</label>
      <input id={inputId} className="input" type="search" autoFocus autoComplete="off" placeholder="Search by name"
        value={q} onChange={(e) => setQ(e.target.value)} />
      {off ? <NeedsSignal className="pf-empty">{NEEDS}</NeedsSignal> : list.length > 0 && (
        <ul className="rel-picks">
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" className="rel-pick" onClick={() => setPick(p)}>
                <span className="rel-pick__name">{p.name}</span>
                <RatingChip code={p.rating} who />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!off && term.length >= 2 && found.isSuccess && list.length === 0 && <p className="pf-empty">No one matches.</p>}
      <button type="button" className="btn btn-quiet pp-btn" onClick={onClose}>Cancel</button>
    </div>
  );
}

// "<Name>’s circle": a filter list of everyone they know (knows=person:<id>),
// opened so the desk can rename it, call, walk or email it.
function MakeList({ person }) {
  const navigate = useNavigate();
  const act = useRun();
  const online = useOnline();
  const make = async () => {
    // A list's name is at most 120 characters; a person's can be longer.
    const who = person.name.length > 110 ? `${person.name.slice(0, 109)}…` : person.name;
    const res = await act.run('list.create', { name: `${who}’s circle`, kind: 'filter', filter: { knows: `person:${person.id}` } });
    if (res?.list?.id) navigate(`/lists/${res.list.id}`);
  };
  return (
    <div className="rk-make">
      <button type="button" className="btn btn-quiet pp-btn" disabled={act.busy || !online} onClick={make}>Make a list</button>
      <p className="rk-help">Anyone you give this list to sees who is on it.</p>
      {online && act.error && <p className="error" role="alert">{act.error}</p>}
    </div>
  );
}

export function PersonKnows({ person, query, me = null }) {
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const act = useRun();
  const online = useOnline();
  // No signal and nothing kept: say so, never a "Loading…" that doesn't end.
  if (noSignal(query)) return <NoSignal />;
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) return <p className="error">{query.error.message}</p>;
  const { knows = [], brought_in_by: by = null } = query.data || {};
  const known = new Set(knows.map((k) => k.person.id));
  const remove = async (id) => {
    const res = await act.run('relationship.remove', { id });
    if (res) setConfirm(null);
  };
  return (
    <>
      {by && <p className="rel-by">Brought in by <Link to={`/people/${by.id}`}>{by.name}</Link></p>}
      {knows.length === 0 && !adding && <p className="pf-empty">No one yet.</p>}
      {knows.length > 0 && (
        <ul className="rel-knows">
          {knows.map((k) => (
            <li key={k.id}>
              <span className="rel-knows__who">
                <Link to={`/people/${k.person.id}`}>{k.person.name}</Link>
                <span className="rel-knows__kind">{linkWords(k)}</span>
              </span>
              <span className="rel-knows__end">
                <RatingChip code={k.person.rating} who />
                <button type="button" className={`btn btn-quiet pp-btn rk-close${k.close ? ' is-on' : ''}`} aria-pressed={Boolean(k.close)}
                  aria-label={`Close: ${k.person.name}`} disabled={act.busy || !online}
                  onClick={() => act.run('relationship.update', { id: k.id, close: !k.close })}>
                  Close
                </button>
                {confirm === k.id ? (
                  <span className="ops-confirm rel-confirm">
                    <span>Remove?</span>
                    <button type="button" className="btn pp-btn" disabled={act.busy || !online} onClick={() => remove(k.id)}>Yes</button>
                    <button type="button" className="btn btn-quiet pp-btn" onClick={() => setConfirm(null)}>No</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-quiet pp-btn" aria-label={`Remove ${k.person.name}`} disabled={!online} onClick={() => setConfirm(k.id)}>Remove</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {online && act.error && <p className="error" role="alert">{act.error}</p>}
      {adding ? (
        <AddKnown person={person} known={known} onClose={() => setAdding(false)} />
      ) : (
        <>
          <div className="pf-row-acts">
            <button type="button" className="btn pp-btn" disabled={!online} onClick={() => setAdding(true)}>+ Someone they know</button>
            <IKnowThem person={person} me={me} />
            {!online && <NeedsSignal className="ops-meta rel-needs">Adding, removing and Close need signal</NeedsSignal>}
          </div>
          {knows.length > 0 && <MakeList person={person} />}
        </>
      )}
    </>
  );
}

// ── The key line ──
// ties: ranked (rankTies) — [{ id, kind, close, person: { id, name, rating } }];
// n: all their live links (do-not-contact ends too); state: 'ok' | 'loading'
// | 'error' | 'offline'. housemates: [{ id, name, dnc }] (the profile only):
// not ties, so never counted in "N more"; someone already linked isn't
// repeated, and someone who asked not to be contacted is left out.
export function KeyTies({ ties = [], n = null, max = 3, housemates = [], state = 'ok', onRetry, onMore, moreTo }) {
  const ref = useRef(null);
  const linked = new Set(ties.map((t) => t.person?.id));
  const homes = housemates.filter((h) => !h.dnc && !linked.has(h.id));
  // How many ties fit: start from max and drop one while the line runs past
  // two lines (long names on a phone), before it is painted; last of all
  // (room 0) the one tie's chip gives its short code ("4C", the full words
  // in its title). A new set of ties or a new width starts again from max.
  const sig = `${max}|${ties.map((t) => t.id || t.person?.id).join(',')}|${homes.map((h) => h.id).join(',')}`;
  const [fit, setFit] = useState([sig, max]);
  const room = fit[0] === sig ? fit[1] : max;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || room <= 0 || !ties.length) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 21;
    if (el.getBoundingClientRect().height > lh * 2 + 6) setFit([sig, room - 1]);
  });
  useEffect(() => {
    const again = () => setFit(['', max]);
    window.addEventListener('resize', again);
    return () => window.removeEventListener('resize', again);
  }, [max]);
  // The line grew without a new width (the web font arrived late): look again.
  const [, look] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => look((x) => x + 1)); });
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [state, ties.length > 0 || homes.length > 0]);
  const head = <span className="rk-word">Knows</span>;
  if (state === 'loading') return <p className="rk-line" aria-live="polite">{head} <span className="rk-dim">· Loading…</span></p>;
  if (state === 'offline') return <p className="rk-line">{head} <span className="rk-dim">· needs signal</span></p>;
  if (state === 'error') return <p className="rk-line">{head} <span className="rk-dim">·</span> <Unavailable onRetry={onRetry} /></p>;
  const shown = ties.slice(0, Math.max(1, Math.min(room, max)));
  const total = n == null ? ties.length : n;
  const more = Math.max(0, total - shown.length);
  if (!shown.length && !more && !homes.length) return null;
  const moreWords = `${more.toLocaleString('en-CA')} more`;
  // "Knows" stays with the first name (non-breaking space, one unbroken
  // piece); each "·" ends the entry before it, so a line never opens with one.
  const entries = [
    ...shown.map((t, i) => {
      const name = <Link className="rk-name" to={`/people/${t.person.id}`} title={t.person.name}>{t.person.name}</Link>;
      return (
        <span key={t.id || t.person.id} className="rk-tie">
          {i === 0 ? <span className="rk-lead">{head}{'\u00a0'}{name}</span> : name}{' '}
          <span className="rk-dim">{kindWord(t.kind)}{t.close ? '\u00a0· Close' : ''}</span>
          {t.person.rating && <>{' '}<RatingChip code={t.person.rating} who={room > 0} /></>}
        </span>
      );
    }),
    more > 0 && (
      <span key="more" className="rk-dim">
        {onMore ? <a className="rk-more" href="#pf-knows" onClick={(e) => { e.preventDefault(); onMore(); }}>{moreWords}</a>
          : <Link className="rk-more" to={moreTo}>{moreWords}</Link>}
      </span>
    ),
    homes.length > 0 && (
      <span key="home" className="rk-dim rk-home">
        Same address: <Link className="rk-name" to={`/people/${homes[0].id}`} title={homes[0].name}>{homes[0].name}</Link>{homes.length > 1 ? `\u00a0+${homes.length - 1}` : ''}
      </span>
    ),
  ].filter(Boolean);
  return (
    <p className="rk-line" ref={ref}>
      {shown.length ? null : <>{head} </>}
      {entries.map((e, i) => (
        <Fragment key={e.key}>
          {e}
          {i < entries.length - 1 && <><span className="rk-sep">{'\u00a0·'}</span>{' '}</>}
        </Fragment>
      ))}
    </p>
  );
}

// The key ties of up to 20 people in one read (the Calls card: this one and
// the next four, so the next card's ties are already here).
export const useKeyTies = (ids, enabled) => useQuery({
  queryKey: ['ties', ...ids],
  queryFn: () => apiGet(`/relationships/key?${new URLSearchParams({ ids: ids.join(',') })}`),
  enabled: Boolean(enabled) && ids.length > 0,
  staleTime: 60_000,
});

// ── "You know them" ──
// Your own circle, from what this phone has (My people, kept for a day) and
// what waits in its outbox. Nothing kept: unknown, so nothing is claimed.
export function useKnowMe(person, meIn) {
  const ctx = useOutletContext();
  const me = meIn || ctx?.me || null;
  const mine = useQuery({
    queryKey: MINE_KEY,
    queryFn: () => apiGet('/relationships/mine'),
    ...phoneCopy(me, MINE_COPY),
    staleTime: 5 * 60_000,
    enabled: Boolean(me),
  });
  useKeepCopy(me, MINE_COPY, mine);
  const outbox = useOutbox();
  const id = person?.id;
  if (!id || !mine.data) return { ready: false, link: null, self: false, me };
  const myEmail = String(me?.user?.email || '').toLowerCase();
  const self = mine.data.me?.id === id || Boolean(myEmail && String(person.email || '').toLowerCase() === myEmail);
  const link = (mine.data.people || []).find((x) => x.person?.id === id)
    || outbox.items.filter((i) => i.name === 'relationship.add' && i.state !== 'refused')
      .map((i) => i.input || {})
      .filter((i) => i.person_id === id || i.person?.id === id)
      .map((i) => ({ id: i.id, kind: i.kind || 'other', pending: true }))[0]
    || null;
  return { ready: true, link, self, me };
}

export function KnowMeChip({ person, me = null, className = '' }) {
  const { link } = useKnowMe(person, me);
  if (!link) return null;
  return <span className={`chip rk-chip ${className}`}>You know them · {kindWord(link.kind)}</span>;
}

// "I know them": one tap on how, queued through the outbox (relationship.add
// is a field action: saved on the phone with no signal, sent once).
export function IKnowThem({ person, me = null }) {
  const know = useKnowMe(person, me);
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null); // { text, cid }: cid while it waits in the outbox
  const outbox = useOutbox();
  const labelId = useId();
  // The last refusal seen while it waited: gone from the outbox after that
  // (dismissed, or the outbox cleared) is still not saved, never "Added".
  const refused = useRef(null);
  if (!person?.id || person.pending) return null;
  if (said) {
    // Saved offline, then sent (gone from the outbox) or refused: say so.
    const item = said.cid ? outbox.items.find((i) => i.cid === said.cid) : null;
    if (item) refused.current = item.state === 'refused' ? `Not saved — ${item.error?.message || 'try again'}` : null;
    const text = !said.cid ? said.text
      : item ? refused.current || said.text
        : refused.current || 'Added to My people';
    return <p className="rk-said" role="status">{text}</p>;
  }
  if (!know.ready || know.link || know.self) return null;
  const add = async (kind) => {
    setBusy(true);
    try {
      const r = await queueAction('relationship.add', { id: newClientId(), person_id: person.id, kind }, { who: person.name });
      setSaid(r.queued ? { text: queuedText(r), cid: r.client_id } : { text: 'Added to My people' });
      if (!r.queued) {
        await Promise.all([MINE_KEY, ['person', person.id], ['brief']].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      }
    } catch (err) {
      setSaid({ text: err.message || 'Not saved — try again' });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  if (!asking) {
    return <button type="button" className="btn btn-quiet pp-btn rk-know" onClick={() => setAsking(true)}>I know them</button>;
  }
  return (
    <div className="rk-ask">
      <span className="rel-add__q" id={labelId}>How do you know them?</span>
      <div className="rel-kinds" role="group" aria-labelledby={labelId}>
        {KINDS.map((k) => (
          <button key={k.code} type="button" className="rel-kind" disabled={busy} onClick={() => add(k.code)}>{k.label}</button>
        ))}
      </div>
      <button type="button" className="btn btn-quiet pp-btn" onClick={() => setAsking(false)}>Cancel</button>
    </div>
  );
}

// A phone's width: the line names at most two ties there (KeyTies drops one
// more if long names would take it past two lines); the rest are in "N more".
const NARROW = '(max-width: 480px)';
const useNarrow = () => {
  const [narrow, setNarrow] = useState(() => Boolean(globalThis.matchMedia?.(NARROW).matches));
  useEffect(() => {
    const mq = globalThis.matchMedia?.(NARROW);
    if (!mq) return undefined;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
};

// The profile's line, from its own Knows read and housemates (no new read).
export function ProfileKeyTies({ query, household = [], onMore }) {
  const narrow = useNarrow();
  if (noSignal(query)) return <KeyTies state="offline" />;
  if (query.isPending) return <KeyTies state="loading" />;
  if (query.isError) return <KeyTies state="error" onRetry={() => query.refetch()} />;
  const knows = query.data?.knows || [];
  return <KeyTies ties={rankTies(knows)} n={knows.length} max={narrow ? 2 : 3} housemates={household} onMore={onMore} />;
}
