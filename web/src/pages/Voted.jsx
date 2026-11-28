// Get out the vote (/voted, the desk): the voting days' one screen.
//   Header   the switch Off · Practice · On (managers; the screen's one
//            primary control), what's happening in one line, and while
//            names are held, why ("…Chief Election Officer not asked yet").
//   Numbers  supporters voted, marked in the last hour, scrutineers on
//            duty, To check.
//   Tabs     Turnout (by turf, live) · Voting places (from the voter guide)
//            · Scrutineers (posts, sign-in codes) · To check (names a
//            scrutineer couldn't match) · Settings (days, closing times,
//            the sending rule, who sees who voted, the Ready list).
// Practice shows practice numbers here (and only here), marked "Practice".
// Needs signal for every change.
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { dayEvent } from '@base-win/shared/ics';
import { dayOf } from '@base-win/shared/dayparts';
import AddToCalendar from '../components/AddToCalendar.jsx';
import { zoneOf } from '../components/shiftTime.js';
import { useGuide } from '../components/guide.js';
import { useLiveChip } from '../components/GotvLive.js';
import { PersonPicker } from '../components/PersonPicker.jsx';
import { hasArea } from '../Shell.jsx';
import '../components/voted.css';
import './shifts.css';
import './surveys.css';
import './gotv.css';

const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${Number(n) === 1 ? one : many}`;
const BANDS = [['support', 'Support'], ['undecided', 'Undecided'], ['opposed', 'Opposed'], ['unrated', 'Unrated']];
const TABS = [['turnout', 'Turnout'], ['places', 'Voting places'], ['scrutineers', 'Scrutineers'], ['check', 'To check'], ['settings', 'Settings']];
const SILENT_MS = 45 * 60_000;
const clock = (iso, tz) => (iso ? new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: tz }) : '');
const hmWord = (hm) => {
  if (!/^\d{2}:\d{2}$/.test(hm || '')) return '';
  const [h, m] = hm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'a.m.' : 'p.m.'}`;
};
const dayWord = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
const agoWord = (ms) => { const m = Math.max(1, Math.round((Date.now() - ms) / 60_000)); return `Updated ${m} min ago`; };

export default function Voted() {
  const { me } = useOutletContext() ?? {};
  const isManager = me?.role === 'manager';
  const tz = zoneOf(me);
  const queryClient = useQueryClient();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'turnout';
  const setTab = (k) => setParams((p) => { const n = new URLSearchParams(p); if (k === 'turnout') n.delete('tab'); else n.set('tab', k); return n; }, { replace: true });
  const status = useQuery({ queryKey: ['voted', 'status'], queryFn: () => apiGet('/voted/status'), staleTime: 15_000, refetchInterval: 30_000 });
  const practice = Boolean(status.data?.practice);
  const q = useQuery({
    queryKey: ['voted', 'summary', practice ? 'practice' : 'real'],
    queryFn: () => apiGet(`/voted/summary${practice ? '?practice=1' : ''}`),
    staleTime: 15_000, refetchInterval: 15_000, enabled: status.data !== undefined,
  });
  const setup = useQuery({ queryKey: ['gotv', 'setup'], queryFn: () => apiGet('/gotv/setup'), staleTime: 15_000 });
  const posts = useQuery({ queryKey: ['gotv', 'posts'], queryFn: () => apiGet('/gotv/posts'), staleTime: 15_000, refetchInterval: 30_000 });
  const checks = useQuery({ queryKey: ['gotv', 'checks'], queryFn: () => apiGet('/gotv/checks?open=1'), staleTime: 15_000, refetchInterval: 30_000 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['voted'] }),
    queryClient.invalidateQueries({ queryKey: ['gotv'] }),
    queryClient.invalidateQueries({ queryKey: ['brief'] }),
  ]);
  // One write: busy while it runs, the server's words when it refuses.
  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    try {
      const r = await action(name, input);
      await refresh();
      return r;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const head = <h1>Get out the vote</h1>;
  if (noSignal(q) || noSignal(status)) return <div className="gv-desk">{head}<NoSignal /></div>;
  if (status.isError || q.isError) {
    return <div className="gv-desk">{head}<p className="error" role="alert">Unavailable — {(status.error || q.error).message} <button type="button" className="btn" onClick={refresh}>Try again</button></p></div>;
  }
  if (!status.data || !q.data) return <div className="gv-desk">{head}<p className="muted">Loading…</p></div>;
  const s = status.data;
  const sum = q.data;
  const mode = s.practice ? 'practice' : s.manual ? 'on' : s.on ? 'auto' : 'off';
  const ctx = { me, isManager, tz, online, busy, run, setError, s, sum, setup, posts, checks, setTab, summaryAt: q.dataUpdatedAt };
  return (
    <div className="gv-desk">
      <Header ctx={ctx} mode={mode} />
      {error && <p className="error" role="alert">{error}</p>}
      <Numbers ctx={ctx} />
      <div className="gv-tabs" role="tablist" aria-label="Get out the vote">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`gv-tab-${k}`} aria-selected={tab === k} aria-controls="gv-panel" onClick={() => setTab(k)}>
            {label}{k === 'check' && checks.data?.checks?.length ? ` · ${num(checks.data.checks.length)}` : ''}
          </button>
        ))}
      </div>
      <div id="gv-panel" role="tabpanel" aria-labelledby={`gv-tab-${tab}`}>
        {tab === 'turnout' && <Turnout ctx={ctx} />}
        {tab === 'places' && <Places ctx={ctx} />}
        {tab === 'scrutineers' && <Scrutineers ctx={ctx} />}
        {tab === 'check' && <ToCheck ctx={ctx} />}
        {tab === 'settings' && <Settings ctx={ctx} />}
      </div>
    </div>
  );
}

// ── The header: title, chip, the switch, one line ──
function Header({ ctx, mode }) {
  const { isManager, online, busy, run, s, setup, setTab } = ctx;
  const [ask, setAsk] = useState(null); // 'on' | 'off' | 'end'
  const [picking, setPicking] = useState(false);
  const group = (setup.data?.posts || 0) + (setup.data?.practice_users?.length || 0);
  const chip = mode === 'on' ? <span className="chip">On</span>
    : mode === 'auto' ? <span className="chip">On by itself today</span>
      : mode === 'practice' ? <span className="chip gv-warnchip">Practice · {plural(group, 'person', 'people')}</span>
        : <span className="chip">Off</span>;
  const days = (s.advance_days?.length || 0) + (s.election_day ? 1 : 0);
  const ready = setup.data?.ready || [];
  const readyDone = ready.filter((r) => r.done).length;
  const line = mode === 'practice'
    ? `Practice — only the ${plural(group, 'person', 'people')} practising see this. Marks are wiped when practice ends.`
    : mode === 'off' ? (days ? 'Turns on by itself on your voting days.' : 'Add your voting days in Settings.')
      : null;
  const value = mode === 'auto' ? 'on' : mode;
  // A voting day with "turn on by itself": Off must stop that too, or it stays on.
  const autoToday = s.auto !== false && Boolean(s.voting_day);
  const pick = (v) => {
    if (!isManager || v === value) return;
    if (v === 'on') setAsk('on');
    else if (v === 'off') setAsk(mode === 'practice' ? 'end' : 'off');
    else setPicking(true);
  };
  const confirm = async () => {
    const m = ask === 'on' ? 'on' : 'off';
    setAsk(null);
    // On by itself today: Off also stops it turning on by itself (else it stays on).
    await run('vote.settings', { mode: m, ...(ask === 'off' && autoToday ? { auto: false } : {}) });
  };
  const words = {
    on: 'Turn GOTV on for every volunteer?',
    off: autoToday
      ? 'Turn GOTV off? The Voted ✓ buttons go away, and it stops turning on by itself on your voting days.'
      : 'Turn GOTV off? The Voted ✓ buttons go away.',
    end: 'End practice and wipe practice marks on every phone?',
  };
  return (
    <header>
      <div className="gv-desk__top">
        <div>
          <div className="gv-desk__title">
            <h1>Get out the vote</h1>
            {chip}
            {mode === 'off' && ready.length > 0 && (
              <button type="button" className="chip" onClick={() => setTab('settings')}>Ready {readyDone} of {ready.length}</button>
            )}
          </div>
          {line && <p className="gv-under">{line}</p>}
          {s.held_line && (
            <p className="gv-under gv-flag" role="status">
              <button type="button" className="btn btn-quiet" onClick={() => setTab('settings')}>{s.held_line}</button>
            </p>
          )}
        </div>
        <div>
          <div className="gv-switch" role="radiogroup" aria-label="GOTV">
            {[['off', 'Off'], ['practice', 'Practice'], ['on', 'On']].map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={value === v} disabled={!isManager || busy || !online}
                onClick={() => pick(v)}>{label}</button>
            ))}
          </div>
          {!online && <p className="gv-under">Needs signal</p>}
          {!isManager && <p className="gv-under">A manager turns this on.</p>}
        </div>
      </div>
      {ask && (
        <div className="gv-ask" role="alertdialog" aria-label={words[ask]}>
          <span>{words[ask]}</span>
          <button type="button" className="btn" onClick={confirm} disabled={busy}>Yes</button>
          <button type="button" className="btn btn-quiet" onClick={() => setAsk(null)}>No</button>
        </div>
      )}
      {picking && <PracticeSheet ctx={ctx} onClose={() => setPicking(false)} />}
    </header>
  );
}

// "Who's practising": everyone with a post (ticked, fixed), and members added by a search.
function PracticeSheet({ ctx, onClose }) {
  const { run, busy, setup, posts } = ctx;
  const members = useQuery({ queryKey: ['members'], queryFn: () => apiGet('/members'), staleTime: 60_000 });
  const posted = posts.data?.posts || [];
  const [picked, setPicked] = useState(() => (setup.data?.practice_users || []).map((u) => u.id));
  const [find, setFind] = useState('');
  const postedIds = new Set(posted.map((p) => p.user_id));
  const all = (members.data?.members || []).filter((m) => !postedIds.has(m.id));
  const shown = all.filter((m) => picked.includes(m.id) || (find.trim().length >= 1 && m.name.toLowerCase().includes(find.trim().toLowerCase()))).slice(0, 30);
  const start = async () => {
    const r1 = await run('vote.settings', { practice_users: picked });
    if (r1) { const r2 = await run('vote.settings', { mode: 'practice' }); if (r2) onClose(); }
  };
  return (
    <section className="gv-sheet" aria-labelledby="gv-practice-h">
      <h2 id="gv-practice-h">Who’s practising</h2>
      <ul className="gv-pick-list">
        {posted.map((p) => (
          <li key={p.id}><label className="gv-check"><input type="checkbox" checked disabled /> {p.name} <span className="muted">· {p.role === 'runner' ? 'Runner' : 'Scrutineer'}</span></label></li>
        ))}
        {shown.map((m) => (
          <li key={m.id}><label className="gv-check">
            <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked((l) => (e.target.checked ? [...l, m.id] : l.filter((x) => x !== m.id)))} /> {m.name}
          </label></li>
        ))}
      </ul>
      <div className="gv-field">
        <label htmlFor="gv-practice-find">Add someone</label>
        <input id="gv-practice-find" className="input" value={find} onChange={(e) => setFind(e.target.value)} placeholder="A name" autoComplete="off" />
      </div>
      <div className="gv-sheet__acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={start}>Start practice</button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}

// ── The numbers row ──
function Numbers({ ctx }) {
  const { sum, posts, checks, setTab, s } = ctx;
  const pct = sum.supporters ? Math.min(100, Math.round((sum.supporters_voted / sum.supporters) * 100)) : 0;
  const list = posts.data?.posts;
  const onDuty = (sum.by_place || []).reduce((n, p) => n + (p.scrutineers_on_duty || 0), 0);
  const practiceChip = s.practice ? <span className="chip gv-warnchip">Practice</span> : null;
  return (
    <div className="gv-nums">
      <div className="gv-num">
        <span className="gv-num__big mono">{num(sum.supporters_voted)} <span className="gv-num__label">of {num(sum.supporters)}</span></span>
        <span className="gv-num__label">supporters voted {practiceChip}</span>
        <span className="gv-bar" role="progressbar" aria-label="Supporters voted" aria-valuemin={0} aria-valuemax={sum.supporters || 0} aria-valuenow={Math.min(sum.supporters_voted || 0, sum.supporters || 0)}><span style={{ width: `${pct}%` }} /></span>
      </div>
      <div className="gv-num">
        <span className="gv-num__big mono">{num(sum.marked_hour)}</span>
        <span className="gv-num__label">marked in the last hour {practiceChip}</span>
      </div>
      <div className="gv-num">
        <span className="gv-num__big mono">{list ? `${num(onDuty)} of ${num(list.filter((p) => p.role === 'scrutineer').length)}` : posts.isError ? 'Unavailable' : 'Loading…'}</span>
        <span className="gv-num__label">scrutineers on duty</span>
      </div>
      <div className="gv-num">
        <span className="gv-num__big mono">{checks.data ? num(checks.data.checks.length) : checks.isError ? 'Unavailable' : 'Loading…'}</span>
        <button type="button" className="btn btn-quiet gv-num__label" onClick={() => setTab('check')}>To check</button>
      </div>
    </div>
  );
}

// ── Turnout ──
function Turnout({ ctx }) {
  const { sum } = ctx;
  const live = useLiveChip();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const rows = [...(sum.by_turf || [])].map((t) => ({ ...t, left: Math.max(0, t.supporters - t.voted) })).sort((a, b) => b.left - a.left || a.name.localeCompare(b.name));
  const chip = live?.live ? 'Live' : agoWord(ctx.summaryAt || Date.now());
  return (
    <section aria-label="Turnout">
      <div className="gv-tablehead">
        <ul className="vt-bands" aria-label="Voted, by rating">
          {BANDS.map(([key, label]) => <li key={key}><span className="chip">{label} · {num(sum.by_band?.[key])}</span></li>)}
        </ul>
        <span className={`chip gv-live${live?.live ? ' is-live' : ''}`}>{chip}</span>
      </div>
      {rows.length ? (
        <table className="gv-table">
          <thead><tr><th>Turf</th><th className="num">Supporters</th><th className="num">Voted</th><th className="num">Not marked yet</th><th className="num">%</th><th><span className="gv-sr">Walk list</span></th></tr></thead>
          <tbody>
            {rows.map((t) => {
              const pct = t.supporters ? Math.round((t.voted / t.supporters) * 100) : 0;
              return (
                <tr key={t.turf_id}>
                  <td><strong>{t.name}</strong><span className="gv-rowsub gv-phone-only">{num(t.left)} not marked yet · {pct}%</span></td>
                  <td className="num gv-hide-phone">{num(t.supporters)}</td>
                  <td className="num gv-hide-phone">{num(t.voted)}</td>
                  <td className="num gv-hide-phone">{num(t.left)}</td>
                  <td className="num gv-hide-phone">{pct}%</td>
                  <td className="gv-acts"><Link className="btn" to={`/turfs/${t.turf_id}`}>Walk list</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="vt-empty">No turfs yet — draw one on the map to see this by turf.</p>}
    </section>
  );
}

// ── Voting places ──
function Places({ ctx }) {
  const { sum, s, tz, me } = ctx;
  const places = sum.by_place || [];
  const held = s.send === 'after_close' && !s.send_open && (s.voting_day || s.on);
  if (!places.length) {
    return (
      <section aria-label="Voting places">
        <p className="vt-empty">No voting places yet.</p>
        {hasArea(me, 'site')
          ? <Link className="btn" to="/website/guide">Add voting places</Link>
          : <p className="gv-under">Ask whoever runs the website to add the voting places in the voter guide.</p>}
      </section>
    );
  }
  return (
    <section aria-label="Voting places">
      {held && <p className="gv-under">Names arrive after polls close.</p>}
      <table className="gv-table">
        <thead><tr><th>Place</th><th>Closes</th><th className="num">Scrutineers</th><th className="num">Names today</th><th>Last name at</th><th><span className="gv-sr">More</span></th></tr></thead>
        <tbody>
          {places.map((p) => {
            const open = p.open_today !== false && (s.send === 'live' || (p.closes_at && Date.now() >= Date.parse(p.closes_at)) || s.send_open);
            const silent = open && p.scrutineers_on_duty > 0 && (!p.last_at || Date.now() - Date.parse(p.last_at) > SILENT_MS);
            return (
              <tr key={p.place_id}>
                <td><strong>{p.name}</strong>{silent && <span className="chip gv-warnchip gv-rowsub">No names for 45 min</span>}</td>
                <td>{p.open_today === false ? <span className="chip">Not open today</span> : p.closes_hm ? hmWord(p.closes_hm) : p.closes_at ? clock(p.closes_at, tz) : 'Not entered'}</td>
                <td className="num">{num(p.scrutineers_on_duty)}</td>
                <td className="num">{num(p.marks_today)}</td>
                <td>{p.last_at ? clock(p.last_at, tz) : '—'}</td>
                <td className="gv-acts"><Link className="btn" to={`/gotv?place=${p.place_id}`}>Enter a sheet</Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ── Scrutineers ──
function Scrutineers({ ctx }) {
  const { posts, isManager, run, busy } = ctx;
  const [adding, setAdding] = useState(null); // null | {} | post (Change)
  const [code, setCode] = useState(null); // { name, url, qr_svg }
  const [more, setMore] = useState(null);
  if (posts.isError) return <p className="error" role="alert">Unavailable — {posts.error.message}</p>;
  if (!posts.data) return <p className="muted">Loading…</p>;
  const list = posts.data.posts;
  const signinCode = async (p) => {
    const r = await run('gotv.signin.code', { user_id: p.user_id });
    if (r) setCode({ name: p.name, ...r });
  };
  return (
    <section aria-label="Scrutineers">
      <div className="gv-tablehead">
        <p className="gv-under">{plural(list.length, 'scrutineer or runner', 'scrutineers and runners')}</p>
        {isManager && <button type="button" className="btn" onClick={() => setAdding({})}>Add a scrutineer</button>}
      </div>
      {adding && <PostSheet ctx={ctx} post={adding} onClose={() => setAdding(null)} />}
      {code && (
        <section className="gv-sheet" aria-labelledby="gv-code-h">
          <h2 id="gv-code-h">Sign-in code for {code.name}</h2>
          <div className="gv-qr" aria-label="QR code" dangerouslySetInnerHTML={{ __html: code.qr_svg }} />
          <p className="gv-url mono">{code.url}</p>
          <p className="gv-under">Works once, for 15 minutes. Show the QR on your screen; a link sent by text or chat may be opened by the app’s preview.</p>
          <button type="button" className="btn btn-quiet" onClick={() => setCode(null)}>Done</button>
        </section>
      )}
      {list.length ? (
        <table className="gv-table">
          <thead><tr><th>Name</th><th>Role</th><th>Place</th><th>Days</th><th>Status</th><th><span className="gv-sr">More</span></th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong></td>
                <td>{p.role === 'runner' ? 'Runner' : 'Scrutineer'}</td>
                <td>{p.place?.name || 'Any voting place'}</td>
                <td>{p.days?.length ? p.days.map(dayWord).join(', ') : 'All voting days'}
                  {p.not_open?.length > 0 && <span className="gv-rowsub gv-flag">Not open on {p.not_open.map(dayWord).join(', ')}</span>}</td>
                <td>
                  <span className="gv-chips">
                    <span className="chip">{p.signed_in ? 'Signed in' : 'Not signed in yet'}</span>
                    <span className="chip">{p.appointed ? 'Appointed' : 'Not appointed'}</span>
                    {p.limit_reached && <span className="chip gv-warnchip">{p.name.split(' ')[0]} reached today’s look-up limit</span>}
                  </span>
                  {p.limit_reached && isManager && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('gotv.find.allow', { user_id: p.user_id })}>Allow 2,000 more today</button>}
                </td>
                <td className="gv-acts">
                  {isManager && (more === p.id ? (
                    <>
                      <button type="button" className="btn" disabled={busy} onClick={() => signinCode(p)}>Sign-in code</button>
                      <button type="button" className="btn" onClick={() => { setAdding(p); setMore(null); }}>Change</button>
                      <button type="button" className="btn" disabled={busy} onClick={() => run('gotv.post.end', { id: p.id })}>End</button>
                    </>
                  ) : <button type="button" className="btn btn-quiet" aria-expanded={false} onClick={() => setMore(p.id)}>More</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="vt-empty">No scrutineers yet.</p>}
    </section>
  );
}

function PostSheet({ ctx, post, onClose }) {
  const { run, busy, s } = ctx;
  const members = useQuery({ queryKey: ['members'], queryFn: () => apiGet('/members'), staleTime: 60_000 });
  const places = useQuery({ queryKey: ['gotv', 'places'], queryFn: () => apiGet('/gotv/places'), staleTime: 60_000 });
  const [who, setWho] = useState(post.user_id || '');
  const [role, setRole] = useState(post.role || 'scrutineer');
  const [place, setPlace] = useState(post.place?.id || '');
  const [allDays, setAllDays] = useState(!post.days?.length);
  const [days, setDays] = useState(post.days || []);
  const [appointed, setAppointed] = useState(Boolean(post.appointed));
  const voting = [...(s.advance_days || []), ...(s.election_day ? [s.election_day] : [])].sort();
  const vols = (members.data?.members || []).filter((m) => m.role === 'volunteer');
  const save = async () => {
    const r = await run('gotv.post.set', { user_id: who, role, ...(role === 'scrutineer' || place ? { place_id: place || null } : {}), days: allDays ? [] : days, appointed });
    if (r) onClose();
  };
  return (
    <section className="gv-sheet" aria-labelledby="gv-post-h">
      <h2 id="gv-post-h">{post.id ? `Change ${post.name}’s post` : 'Add a scrutineer'}</h2>
      <div className="gv-field">
        <label htmlFor="gv-who">Who</label>
        <select id="gv-who" className="input" value={who} disabled={Boolean(post.id)} onChange={(e) => setWho(e.target.value)}>
          <option value="">Pick a volunteer</option>
          {vols.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      <fieldset className="gv-field gv-radio">
        <legend className="gv-under">Scrutineer or runner</legend>
        <label><input type="radio" name="gv-role" checked={role === 'scrutineer'} onChange={() => setRole('scrutineer')} /> Scrutineer (at one voting place)</label>
        <label><input type="radio" name="gv-role" checked={role === 'runner'} onChange={() => setRole('runner')} /> Runner (carries any place’s sheets)</label>
      </fieldset>
      <div className="gv-field">
        <label htmlFor="gv-place">Voting place</label>
        <select id="gv-place" className="input" value={place} onChange={(e) => setPlace(e.target.value)}>
          <option value="">{role === 'runner' ? 'Any voting place' : 'Pick a voting place'}</option>
          {(places.data?.places || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <fieldset className="gv-field gv-radio">
        <legend className="gv-under">Days</legend>
        <label><input type="radio" name="gv-days" checked={allDays} onChange={() => setAllDays(true)} /> All voting days</label>
        <label><input type="radio" name="gv-days" checked={!allDays} onChange={() => setAllDays(false)} /> Pick days</label>
        {!allDays && voting.map((d) => (
          <label key={d} className="gv-check"><input type="checkbox" checked={days.includes(d)} onChange={(e) => setDays((l) => (e.target.checked ? [...l, d].sort() : l.filter((x) => x !== d)))} /> {dayWord(d)}</label>
        ))}
      </fieldset>
      <label className="gv-check"><input type="checkbox" checked={appointed} onChange={(e) => setAppointed(e.target.checked)} /> Appointment sent to the Chief Election Officer</label>
      <div className="gv-sheet__acts">
        <button type="button" className="btn btn-primary" disabled={busy || !who || (role === 'scrutineer' && !place)} onClick={save}>Save</button>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}

// ── To check ──
function ToCheck({ ctx }) {
  const { checks, run, busy, tz } = ctx;
  const [finding, setFinding] = useState(null);
  if (checks.isError) return <p className="error" role="alert">Unavailable — {checks.error.message}</p>;
  if (!checks.data) return <p className="muted">Loading…</p>;
  const list = checks.data.checks;
  if (!list.length) return <p className="vt-empty">Nothing to check.</p>;
  return (
    <section aria-label="To check">
      <table className="gv-table">
        <thead><tr><th>Typed</th><th>Place</th><th>Written</th><th>By</th><th><span className="gv-sr">Actions</span></th></tr></thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id}>
              <td><strong>{k.typed}</strong>
                {finding === k.id && (
                  <div className="gv-sheet">
                    <PersonPicker id={`gv-find-${k.id}`} allowCreate={false} autoFocus placeholder="Find who they meant"
                      onPick={async (p) => { const r = await run('gotv.check.resolve', { id: k.id, person_id: p.id, outcome: 'marked' }); if (r) setFinding(null); }} />
                  </div>
                )}
              </td>
              <td>{k.place || '—'}</td>
              <td>{clock(k.written_at, tz)}</td>
              <td>{k.by_name || '—'}</td>
              <td className="gv-acts">
                <button type="button" className="btn" onClick={() => setFinding(finding === k.id ? null : k.id)}>Find</button>
                <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('gotv.check.resolve', { id: k.id, outcome: 'not_ours' })}>Not ours</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ── Settings ──
function Settings({ ctx }) {
  const { setup, isManager, run, busy, online } = ctx;
  const [ceo, setCeo] = useState(null); // { allows_live, note } while recording
  const [times, setTimes] = useState({});
  if (setup.isError) return <p className="error" role="alert">Unavailable — {setup.error.message}</p>;
  if (!setup.data) return <p className="muted">Loading…</p>;
  const st = setup.data;
  const allows = Boolean(st.ceo_answer?.allows_live);
  const off = !isManager || busy || !online;
  return (
    <section aria-label="Settings">
      <VotingDays ctx={ctx} />

      <div className="gv-sec">
        <h2>Closing times</h2>
        {st.days.length ? (
          <ul className="gv-closes">
            {st.days.map((d) => (
              <li key={d.day}>
                <span className="gv-closes__day">{dayWord(d.day)}</span>
                <span>{d.guide_close ? `From the voter guide: ${hmWord(d.guide_close)}` : 'Not in the voter guide'}</span>
                <label className="gv-field">
                  <span>Closing time</span>
                  <input className="input gv-time" placeholder="HH:MM" inputMode="numeric" disabled={off} value={times[d.day] ?? d.override ?? ''}
                    onChange={(e) => setTimes((t) => ({ ...t, [d.day]: e.target.value }))}
                    onBlur={() => {
                      const v = (times[d.day] ?? d.override ?? '').trim();
                      if (v === (d.override || '')) return;
                      run('vote.settings', { close_override: { [d.day]: v || null } });
                    }} />
                </label>
                {d.places_differ > 0 && <span className="gv-rowsub">{plural(d.places_differ, 'place closes', 'places close')} at a different time</span>}
              </li>
            ))}
          </ul>
        ) : <p className="gv-under">Add your voting days first.</p>}
        <p className="gv-under">Only if the voter guide doesn’t have it. From the elections office’s published hours.</p>
      </div>

      <div className="gv-sec">
        <h2>Scrutineers send names</h2>
        <div className="gv-radio" role="radiogroup" aria-label="Scrutineers send names">
          <label><input type="radio" name="gv-send" checked={st.send === 'after_close'} disabled={off} onChange={() => run('vote.settings', { send: 'after_close' })} /> After polls close</label>
          <label className={allows ? '' : 'is-off'}><input type="radio" name="gv-send" checked={st.send === 'live'} disabled={off || !allows} onChange={() => run('vote.settings', { send: 'live' })} /> As soon as entered</label>
        </div>
        {!allows && <p className="gv-under">Record the Chief Election Officer’s answer first.</p>}
        {isManager && st.voting_day && st.held_today && (
          <button type="button" className="btn" disabled={off} onClick={() => run('vote.settings', { release: true })}>Polls are closed — send names now</button>
        )}
      </div>

      <div className="gv-sec">
        <h2>Volunteers see who voted</h2>
        <div className="gv-radio" role="radiogroup" aria-label="Volunteers see who voted">
          <label><input type="radio" name="gv-scope" checked={st.scope === 'turfs'} disabled={off} onChange={() => run('vote.settings', { scope: 'turfs' })} /> In their turfs and phone banks</label>
          <label><input type="radio" name="gv-scope" checked={st.scope === 'campaign'} disabled={off} onChange={() => run('vote.settings', { scope: 'campaign' })} /> Anywhere in the city</label>
        </div>
        {st.scope === 'campaign' && <p className="gv-under">Every volunteer can see who voted anywhere in the city.</p>}
      </div>

      <div className="gv-sec">
        <h2>A voted file</h2>
        <p className="gv-under">
          A voted file: <Link to="/people/import">People → Import</Link> with a Voted column (1/0 or a date). A file marks people; it never un-marks anyone.
          {st.voting_day && st.send === 'after_close' && ' On a voting day, Voted lists from voting places go in after polls close.'}
        </p>
      </div>

      <div className="gv-sec" id="gv-ready">
        <h2>Ready</h2>
        <ul className="gv-ready">
          {st.ready.map((r) => (
            <li key={r.key} className={r.done ? 'is-done' : ''}>
              <span className="gv-ready__mark" aria-hidden="true">{r.done ? '✓' : '○'}</span>
              <div className="gv-ready__body">
                <span>{r.label}</span>
                <span className="gv-sr">{r.done ? ' — done' : ' — not yet'}</span>
                {r.key === 'ceo' && r.answer && <span className="gv-rowsub">{r.answer.allows_live ? 'Yes: names may leave during voting' : 'No: names wait until polls close'}{r.answer.note ? ` · ${r.answer.note}` : ''}</span>}
                {r.key === 'ceo' && isManager && (ceo ? (
                  <div className="gv-sheet">
                    <div className="gv-radio" role="radiogroup" aria-label="Their answer">
                      <label><input type="radio" name="gv-ceo" checked={ceo.allows_live === true} onChange={() => setCeo((c) => ({ ...c, allows_live: true }))} /> Yes — names may leave the voting place during voting</label>
                      <label><input type="radio" name="gv-ceo" checked={ceo.allows_live === false} onChange={() => setCeo((c) => ({ ...c, allows_live: false }))} /> No — only after it closes</label>
                    </div>
                    <div className="gv-field">
                      <label htmlFor="gv-ceo-note">Note (who answered, when)</label>
                      <input id="gv-ceo-note" className="input" maxLength={300} value={ceo.note} onChange={(e) => setCeo((c) => ({ ...c, note: e.target.value }))} />
                    </div>
                    <div className="gv-sheet__acts">
                      <button type="button" className="btn" disabled={off || ceo.allows_live == null} onClick={async () => { const r = await run('vote.settings', { ceo_answer: ceo }); if (r) setCeo(null); }}>Save the answer</button>
                      <button type="button" className="btn btn-quiet" onClick={() => setCeo(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="gv-ready__acts"><button type="button" className="btn btn-quiet" disabled={off} onClick={() => setCeo({ allows_live: r.answer ? r.answer.allows_live : null, note: r.answer?.note || '' })}>Record their answer</button></div>
                ))}
                {r.tick && isManager && (
                  <div className="gv-ready__acts">
                    <label className="gv-check"><input type="checkbox" checked={r.done} disabled={off} onChange={(e) => run('vote.settings', { ready: { key: r.key, done: e.target.checked } })} /> Done</label>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="gv-under">An unticked line never stops GOTV from turning on.</p>
      </div>
    </section>
  );
}

// The voting days (today's editor), with the voter guide's days when they differ.
function VotingDays({ ctx }) {
  const { me, isManager, s, run, busy, online } = ctx;
  const guide = useGuide({ side: true }).data;
  const [draft, setDraft] = useState(null);
  const [newDay, setNewDay] = useState('');
  const [said, setSaid] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const saved = { election_day: s.election_day || '', advance_days: s.advance_days || [], auto: s.auto !== false };
  const cur = draft || saved;
  const changed = Boolean(draft) && JSON.stringify(cur) !== JSON.stringify(saved);
  const patch = (p) => setDraft({ ...cur, ...p });
  const addDay = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDay)) return;
    patch({ advance_days: [...new Set([...cur.advance_days, newDay])].sort() });
    setNewDay('');
  };
  const done = () => { setDraft(null); setSaid('Saved'); clearTimeout(timer.current); timer.current = setTimeout(() => setSaid(null), 4000); };
  const save = async () => { if (await run('vote.settings', { election_day: cur.election_day || null, advance_days: cur.advance_days, auto: cur.auto })) done(); };
  const gDays = guide?.status !== 'not_out' ? (guide?.days || []) : [];
  const gAdvance = gDays.filter((d) => d.kind === 'advance').map((d) => d.day).sort();
  const gElection = gDays.filter((d) => d.kind === 'general').map((d) => d.day).sort().at(-1) || '';
  const guideDiffers = gDays.length > 0 && (gElection !== (s.election_day || '') || JSON.stringify(gAdvance) !== JSON.stringify([...(s.advance_days || [])].sort()));
  const takeGuideDays = async () => { if (await run('vote.settings', { election_day: gElection || null, advance_days: gAdvance, auto: saved.auto })) done(); };
  const savedDays = [...new Set([...(s.advance_days || []), ...(s.election_day ? [s.election_day] : [])])].sort();
  const today = dayOf(new Date(), zoneOf(me));
  const nextDay = savedDays.find((d) => d >= today);
  const nextEvent = nextDay ? dayEvent({
    uid: `vote-${nextDay}@base.win`, title: nextDay === s.election_day ? 'Election day' : 'Advance voting', day: nextDay, details: me?.workspace?.name || null,
  }) : null;
  const off = !isManager || busy;
  return (
    <div className="gv-sec">
      <h2>Voting days</h2>
      {guideDiffers && (
        <p className="vt-line vt-guide" role="status">
          The voter guide has other days.{' '}
          {isManager && <button type="button" className="btn vt-tap" disabled={busy || !online} onClick={takeGuideDays}>Use the guide’s days</button>}
        </p>
      )}
      <div className="field">
        <label htmlFor="vt-date">Election day</label>
        <input id="vt-date" type="date" className="input vt-date" value={cur.election_day || ''} disabled={off} onChange={(e) => patch({ election_day: e.target.value })} />
      </div>
      <div className="field">
        <span className="vt-label" id="vt-adv-l">Advance-voting days</span>
        {cur.advance_days.length > 0 ? (
          <ul className="vt-days" aria-labelledby="vt-adv-l">
            {cur.advance_days.map((d) => (
              <li key={d} className="chip vt-day">
                <span className="mono">{dayWord(d)}</span>
                {isManager && <button type="button" className="vt-day__x" aria-label={`Take ${dayWord(d)} off`} disabled={busy} onClick={() => patch({ advance_days: cur.advance_days.filter((x) => x !== d) })}>✕</button>}
              </li>
            ))}
          </ul>
        ) : <p className="ops-meta">None yet.</p>}
        {isManager && (
          <div className="vt-addday">
            <input id="vt-newday" type="date" className="input vt-date" aria-label="An advance-voting day" value={newDay} disabled={busy} onChange={(e) => setNewDay(e.target.value)} />
            <button type="button" className="btn vt-tap" disabled={busy || !newDay} onClick={addDay}>Add day</button>
          </div>
        )}
      </div>
      <label className="ot-check vt-auto">
        <input type="checkbox" checked={cur.auto} disabled={off} onChange={(e) => patch({ auto: e.target.checked })} />
        <span>Turn on by itself on these days (in the campaign’s time)</span>
      </label>
      {isManager && (
        <div className="vt-save">
          <button type="button" className="btn vt-tap" disabled={busy || !changed || !online} onClick={save}>Save days</button>
          {said && <span className="mono ok-text" role="status">✓ {said}</span>}
        </div>
      )}
      {changed ? <p className="ops-meta">Save first to add these days to a calendar</p>
        : savedDays.length > 0 && <AddToCalendar kind="vote" id="all" event={nextEvent} />}
    </div>
  );
}
