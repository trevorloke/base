// Website → Languages (TR, SITE.md "Languages"): the website in ਪੰਜਾਬੀ and
// 中文, made ahead of time and checked by people.
//   /website/languages              one row per language (its chip and its
//                                   counts) and the month's characters
//   /website/languages/:code        one language: Turn on (with what it
//                                   costs), the checklist while it gets
//                                   ready, the sentences to check, correct
//                                   or approve, recent edits with Undo, the
//                                   names kept as written; under More, search
//                                   listing, older posts and Turn off
//   /website/languages/:code/legal  the words the law needs (WebsiteLanguageLegal)
// Reads: GET /api/site/languages… (language-reads.js). Writes are actions
// (site.settings.save for a manager's switches, site.translation.*,
// site.names.keep, site.translate.now). Someone with only "Website
// translations" suggests; the server decides what goes live.
import { useEffect, useId, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { MoreMenu, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { day, plural } from '../components/site/useSite.js';
import { hasArea } from '../Shell.jsx';
import { Unavailable } from './WebsiteSites.jsx';
import './shifts.css';
import '../editor.css';
import './website.css';
import './website-languages.css';

export const LANGS = { pa: { label: 'ਪੰਜਾਬੀ', name: 'Punjabi', path: '/pa' }, 'zh-Hans': { label: '简体', name: 'Chinese (Simplified)', path: '/zh' }, 'zh-Hant': { label: '繁體', name: 'Chinese (Traditional)', path: '/zh-hant' } };
const n = (x) => Number(x || 0).toLocaleString('en-CA');
export const useLanguages = () => useQuery({ queryKey: ['site-languages'], queryFn: () => apiGet('/site/languages') });
const useRefresh = () => {
  const qc = useQueryClient();
  return (code) => Promise.all([
    qc.invalidateQueries({ queryKey: ['site-languages'] }),
    code && qc.invalidateQueries({ queryKey: ['site-language', code] }),
    qc.invalidateQueries({ queryKey: ['site'] }),
  ]);
};

// On · Getting ready · Off · Needs approval · English changed
export const chipOf = (l) => {
  if (!l.on) return ['Off', 'ops-chip-muted'];
  if (l.offered) return l.legal.stale_keys.length ? ['English changed', 'chip-warn'] : ['On', 'chip-ok'];
  if (l.ready_at && (l.legal.state === 'missing' || l.legal.stale_keys.includes('authorizedBy'))) return ['Needs approval', 'chip-warn'];
  return ['Getting ready', 'ops-chip-muted'];
};
const Chip = ({ l }) => { const [w, cls] = chipOf(l); return <span className={`chip ${cls}`}>{w}</span>; };
const countsLine = (c) => (c ? [
  plural(c.live, 'sentence'), c.waiting ? `${n(c.waiting)} waiting` : null, c.suggested ? `${n(c.suggested)} suggested` : null,
  c.failed ? `${n(c.failed)} couldn’t translate` : null, `${n(c.checked)} checked`,
].filter(Boolean).join(' · ') : 'Not turned on');
const errorWords = (e) => (e === 'monthly-limit' ? 'This month’s character limit is reached — the rest waits for next month or a higher limit' : e);

// The settings the manager's switches save (the whole section, as it is).
const saveLanguages = (settings, patch) => action('site.settings.save', { languages: { ...settings, ...patch } });

function KeyNote({ d, manager }) {
  if (d.key) return null;
  const anyReady = d.languages.some((l) => l.ready_at);
  return (
    <p className={`card lg-note${anyReady ? ' wb-warn' : ''}`} role="status">
      {anyReady ? 'Translation key missing — new wording stays English.' : 'Add the translation key to turn on languages.'}
      {manager && <> <Link to="/settings/services">Settings → Services</Link></>}
    </p>
  );
}

function Limit({ d, manager }) {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(String(d.usage.limit));
  const [err, setErr] = useState(null);
  const stopped = d.languages.some((l) => l.on && l.last_error === 'monthly-limit');
  const save = async (e) => {
    e.preventDefault();
    setErr(null);
    try { await saveLanguages(d.settings, { monthlyChars: Number(String(v).replace(/[^\d]/g, '')) }); await refresh(); setOpen(false); } catch (x) { setErr(x.message); }
  };
  return (
    <div className="lg-usage">
      <p>This month: {n(d.usage.chars)} of {n(d.usage.limit)} characters</p>
      {stopped && <p className="wb-warn">Monthly limit reached.</p>}
      {manager && !open && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setOpen(true)}>Change the limit</button>}
      {open && (
        <form className="lg-inline" onSubmit={save}>
          <label htmlFor="lg-limit">Characters a month</label>
          <input id="lg-limit" className="input" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} />
          <p className="wb-field__hint">10,000 to 5,000,000. About $20 US per million above Google’s free allowance.</p>
          {err && <p className="wb-field__err" role="alert">{err}</p>}
          <div className="ops-actions">
            <button type="submit" className="btn ops-tap">Save</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function WebsiteLanguages() {
  const { me } = useOutletContext() || {};
  const manager = me?.role === 'manager';
  const q = useLanguages();
  const d = q.data;
  return (
    <div className="wb-page">
      <div className="ops-head"><h1>Languages</h1></div>
      <WebsiteTabs />
      <p className="wb-help">The website in ਪੰਜਾਬੀ and 中文, translated when you publish and checked by people.</p>
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <Unavailable q={q} />}
      {d && (
        <>
          <KeyNote d={d} manager={manager} />
          <ul className="wb-rows lg-rows" aria-label="Languages">
            {d.languages.map((l) => (
              <li key={l.code} className="wb-row lg-row">
                <Link className="lg-row__link" to={`/website/languages/${l.code}`}>
                  <span className="lg-row__top">
                    <span className="lg-row__label" lang={l.code}>{l.label}</span>
                    <span className="lg-row__name">{l.name}</span>
                    <Chip l={l} />
                  </span>
                  <span className="wb-row__sub">{countsLine(l.counts)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Limit d={d} manager={manager} />
        </>
      )}
    </div>
  );
}

// ── One language ──

function TurnOn({ d, l, manager, say }) {
  const refresh = useRefresh();
  const est = useQuery({ queryKey: ['site-language-estimate', l.code], queryFn: () => apiGet(`/site/languages/${l.code}/estimate`), enabled: manager && !l.on });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!manager || l.on) return null;
  const e = est.data;
  const left = e ? Math.max(0, e.usage.limit - e.usage.chars) : 0;
  // Chinese comes on in both scripts; either can be turned off under More.
  const codes = l.code === 'zh-Hans' ? ['zh-Hans', 'zh-Hant'] : [l.code];
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await saveLanguages(d.settings, { on: [...new Set([...d.settings.on, ...codes])] });
      await refresh(l.code);
      say(`${codes.map((c) => LANGS[c].label).join(' and ')} turned on — translating now`);
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <section className="card lg-turnon" aria-label="Turn on">
      {est.isPending && <p className="muted">Loading…</p>}
      {est.isError && <Unavailable q={est} />}
      {e && (e.converted
        ? <p>No characters: made from 简体.</p>
        : <p>First translation needs about {n(e.essential)} characters ({n(e.all)} with everything). This month: {n(left)} of {n(e.usage.limit)} left.</p>)}
      {l.code === 'zh-Hans' && <p className="wb-field__hint">简体 and 繁體 come on together; 繁體 is made from 简体.</p>}
      {err && <p className="wb-field__err" role="alert">{err}</p>}
      <button type="button" className="btn btn-primary ops-tap" disabled={busy} onClick={go}>{busy ? 'Turning on…' : 'Turn on'}</button>
    </section>
  );
}

function Tick({ done, children, to }) {
  return (
    <li className="lg-check" data-done={done ? '' : undefined}>
      <span className="lg-check__mark" aria-hidden="true">{done ? '✓' : '○'}</span>
      <span className="ws-sr">{done ? 'Done: ' : 'To do: '}</span>
      {done || !to ? <span>{children}</span> : <Link to={to}><span>{children}</span></Link>}
    </li>
  );
}

// Preview before visitors see the language (decision 35): a half-hour link
// to the home page in it, asked for on the tap (the tab opens first, so no
// pop-up blocker stops it).
function DraftPreview({ code, say }) {
  const open = async () => {
    const w = window.open('about:blank', '_blank');
    try {
      const r = await apiGet(`/site/languages/${code}/preview`);
      if (w) w.location.href = r.url; else window.location.href = r.url;
    } catch (e) {
      if (w) w.close();
      say(e.message || 'Couldn’t open the preview — try again');
    }
  };
  return (
    <button type="button" className="btn btn-quiet ops-tap" onClick={open}>
      Preview<span aria-hidden="true"> ↗</span><span className="ws-sr"> (opens a new tab)</span>
    </button>
  );
}

function Checklist({ d, l }) {
  if (!l.on || l.offered) return null;
  const c = l.counts || { live: 0, waiting: 0 };
  const approved = l.legal.state !== 'missing' && !l.legal.stale_keys.includes('authorizedBy');
  return (
    <section className="card lg-checklist" aria-labelledby="lg-ready-h">
      <h2 id="lg-ready-h" className="wb-card-h">Getting ready</h2>
      <ul className="lg-checks">
        <Tick done={d.key || Boolean(l.ready_at)} to="/settings/services">Translation key</Tick>
        <Tick done={d.agent} to="/website/settings#org">Authorized by (the agent’s name)</Tick>
        <Tick done={approved} to={`/website/languages/${l.code}/legal`}>Authorized by, in <span lang={l.code}>{l.label}</span>, approved</Tick>
        <Tick done={Boolean(l.ready_at)}>First translation of the main pages done ({n(c.live - c.waiting)} of {n(c.live)})</Tick>
      </ul>
      <p className="wb-help">Visitors see <span lang={l.code}>{l.label}</span> once every line is ticked.</p>
    </section>
  );
}

const ORIGIN = { machine: ['Machine', 'ops-chip-muted'], converted: ['From 简体', 'ops-chip-muted'], edited: ['Edited', 'ops-chip-muted'] };
const FILTERS = [['check', 'To check'], ['suggested', 'Suggested'], ['failed', 'Couldn’t translate'], ['edited', 'Edited'], ['all', 'All']];

function Sentence({ s, code, mayLive, onDone, say }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(s.text || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const id = useId();
  const run = async (name, input, words) => {
    setBusy(true);
    setErr(null);
    try { await action(name, input); say(words); setOpen(false); await onDone(); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const chip = s.suggestion ? ['Suggested', 'chip-warn'] : s.failure ? ['Couldn’t translate', 'chip-warn'] : s.checked_at ? ['Checked', 'chip-ok'] : ORIGIN[s.origin];
  const save = (e) => { e.preventDefault(); run('site.translation.save', { lang: code, src_hash: s.src_hash, text }, mayLive ? 'Saved — it’s on the site now' : 'Suggested — waiting for a second person'); };
  const looksRight = () => run('site.translation.check', { lang: code, src_hashes: [s.src_hash] }, 'Checked');
  const rows = Math.min(10, Math.max(2, Math.ceil(((s.text || s.src).length) / 50)));
  return (
    <li className="lg-sent" data-open={open ? '' : undefined}>
      <p className="lg-sent__src" lang="en">{s.src}</p>
      {s.text !== null && <p className="lg-sent__text" lang={code}>{s.text}</p>}
      {s.earlier && <p className="lg-sent__earlier">Earlier wording: <span lang={code}>{s.earlier}</span></p>}
      {s.failure && <p className="lg-sent__why">{s.failure.reason}</p>}
      {s.suggestion && (
        <div className="lg-sent__sugg">
          <p className="lg-sent__text" lang={code}>{s.suggestion.text}</p>
          <p className="lg-sent__meta">Suggested by {s.suggestion.by_name || 'someone'}{s.suggestion.at ? ` · ${day(s.suggestion.at)}` : ''}</p>
          <div className="ops-actions">
            {!s.suggestion.mine && <button type="button" className="btn ops-tap" disabled={busy} onClick={() => run('site.translation.approve', { lang: code, version_id: s.suggestion.id }, 'Approved — it’s on the site now')}>Looks right</button>}
            <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => run('site.translation.decline', { lang: code, version_id: s.suggestion.id }, s.suggestion.mine ? 'Suggestion taken back' : 'Declined')}>{s.suggestion.mine ? 'Take it back' : 'Decline'}</button>
          </div>
        </div>
      )}
      <p className="lg-sent__meta">
        <span>{s.place_label}</span>
        {chip && <span className={`chip ${chip[1]}`}>{chip[0]}</span>}
        {s.checked_by_name && <span>by {s.checked_by_name}</span>}
      </p>
      {!open && !s.suggestion && (
        <div className="ops-actions">
          <button type="button" className="btn btn-quiet ops-tap" aria-expanded="false" onClick={() => { setText(s.text || ''); setOpen(true); }}>{s.text === null ? 'Type it' : 'Change'}</button>
          {s.text !== null && !s.checked_at && !s.mine && <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={looksRight}>Looks right</button>}
        </div>
      )}
      {open && (
        <form className="lg-edit" onSubmit={save}>
          <label htmlFor={`${id}-t`} className="ws-sr">In {LANGS[code].label}</label>
          <textarea id={`${id}-t`} className="input lg-edit__box" lang={code} rows={rows} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
          <div className="ops-actions">
            <button type="submit" className="btn ops-tap" disabled={busy}>{mayLive ? 'Save' : 'Suggest'}</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      {err && <p className="wb-field__err" role="alert">{err}</p>}
    </li>
  );
}

function Sentences({ code, mayLive, say, failedCount }) {
  const [filter, setFilter] = useState('check');
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [after, setAfter] = useState(0);
  const refresh = useRefresh();
  useEffect(() => { const t = setTimeout(() => { setQuery(typed.trim()); setAfter(0); }, 300); return () => clearTimeout(t); }, [typed]);
  const key = ['site-language', code, 'sentences', filter, query, after];
  const q = useQuery({ queryKey: key, queryFn: () => apiGet(`/site/languages/${code}/sentences?filter=${filter}&q=${encodeURIComponent(query)}&after=${after}`) });
  const done = () => refresh(code);
  return (
    <section className="lg-list" aria-labelledby="lg-list-h">
      <h2 id="lg-list-h" className="wb-h2">Sentences</h2>
      <p className="wb-help">Footer text and the land acknowledgement are translated like any page.</p>
      <div className="lg-filters" role="group" aria-label="Show">
        {FILTERS.map(([k, w]) => (
          <button key={k} type="button" className="chip lg-filter" aria-pressed={filter === k} onClick={() => { setFilter(k); setAfter(0); }}>
            {w}{k === 'failed' && failedCount ? ` (${n(failedCount)})` : ''}
          </button>
        ))}
      </div>
      <label className="ws-sr" htmlFor="lg-q">Search the sentences</label>
      <input id="lg-q" className="input lg-search" type="search" placeholder="Search the sentences" value={typed} onChange={(e) => setTyped(e.target.value)} />
      {q.isPending && <p className="muted">Loading…</p>}
      {q.isError && <Unavailable q={q} />}
      {q.data && (
        <>
          <p className="ws-sr" aria-live="polite">{plural(q.data.total, 'sentence')}</p>
          {q.data.sentences.length === 0 && <p className="ops-empty">{filter === 'check' ? 'Nothing waiting to be checked.' : 'None here.'}</p>}
          <ul className="lg-sents">
            {q.data.sentences.map((s) => <Sentence key={`${s.src_hash}:${s.text}:${s.suggestion?.id}`} s={s} code={code} mayLive={mayLive} onDone={done} say={say} />)}
          </ul>
          <div className="ops-actions">
            {after > 0 && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAfter(Math.max(0, after - 50))}>Earlier ones</button>}
            {q.data.next !== null && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAfter(q.data.next)}>More sentences</button>}
          </div>
        </>
      )}
    </section>
  );
}

function Edits({ code, mayUndo, say }) {
  const refresh = useRefresh();
  const q = useQuery({ queryKey: ['site-language', code, 'edits'], queryFn: () => apiGet(`/site/languages/${code}/edits`) });
  const [err, setErr] = useState(null);
  const undo = async (e) => {
    setErr(null);
    try { await action('site.translation.undo', { lang: code, version_id: e.id }); say('Undone — the words before are back'); await refresh(code); } catch (x) { setErr(x.message); }
  };
  const STATE = { live: 'Live', suggested: 'Suggested', declined: 'Declined', replaced: 'Replaced' };
  return (
    <section className="lg-edits" aria-labelledby="lg-edits-h">
      <h2 id="lg-edits-h" className="wb-h2">Recent edits</h2>
      {q.isPending && <p className="muted">Loading…</p>}
      {q.isError && <Unavailable q={q} />}
      {err && <p className="wb-field__err" role="alert">{err}</p>}
      {q.data && q.data.edits.length === 0 && <p className="ops-empty">No edits by people yet.</p>}
      {q.data && q.data.edits.length > 0 && (
        <ul className="lg-sents">
          {q.data.edits.map((e) => (
            <li key={e.id} className="lg-sent">
              {e.src && <p className="lg-sent__src" lang="en">{e.src}</p>}
              {e.before && <p className="lg-sent__before"><span className="ws-sr">Before: </span><del lang={code}>{e.before}</del></p>}
              <p className="lg-sent__text" lang={code}><span className="ws-sr">After: </span>{e.text}</p>
              <p className="lg-sent__meta"><span>{e.by_name || 'Someone'} · {day(e.at)}</span><span className="chip ops-chip-muted">{STATE[e.state] || e.state}</span></p>
              {mayUndo && e.live && e.before && <div className="ops-actions"><button type="button" className="btn btn-quiet ops-tap" onClick={() => undo(e)}>Undo</button></div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Names({ d, say }) {
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const keep = async (nm, on = true) => {
    setErr(null);
    try { await action('site.names.keep', { name: nm, keep: on }); say(on ? `${nm} is kept as written` : `${nm} is no longer kept`); setName(''); await refresh(); } catch (x) { setErr(x.message); }
  };
  return (
    <section className="lg-names" aria-labelledby="lg-names-h">
      <h2 id="lg-names-h" className="wb-h2">Names kept as written</h2>
      <p className="wb-help">Never translated: the campaign, its candidates, its websites and the names here.</p>
      <ul className="lg-chips">
        {d.names.kept.map((nm) => (
          <li key={nm} className="chip lg-name">{nm}
            {d.names.typed.includes(nm) && <button type="button" className="lg-name__x" aria-label={`Stop keeping ${nm}`} onClick={() => keep(nm, false)}>✕</button>}
          </li>
        ))}
      </ul>
      {d.names.too_many && <p className="wb-warn">Too many names to keep — the rest may be translated.</p>}
      <form className="lg-inline" onSubmit={(e) => { e.preventDefault(); if (name.trim()) keep(name.trim()); }}>
        <label htmlFor="lg-name">Another name (an opponent, a place)</label>
        <div className="lg-inline__row">
          <input id="lg-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn ops-tap">Keep</button>
        </div>
      </form>
      {err && <p className="wb-field__err" role="alert">{err}</p>}
      {d.names.possible.length > 0 && (
        <details className="lg-more">
          <summary className="lg-h3">Possible names ({d.names.possible.length})</summary>
          <ul className="lg-possible">
            {d.names.possible.map((nm) => (
              <li key={nm}><span>{nm}</span><button type="button" className="btn btn-quiet ops-tap" onClick={() => keep(nm)}>Keep as written<span className="ws-sr"> — {nm}</span></button></li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// "Stop showing ਪੰਜਾਬੀ? Yes · No" — a question in place.
function Ask({ text, onYes, onNo }) {
  return (
    <div className="card lg-ask" role="alertdialog" aria-label={text}>
      <p>{text}</p>
      <div className="ops-actions">
        <button type="button" className="btn ops-tap" autoFocus onClick={onYes}>Yes</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onNo}>No</button>
      </div>
    </div>
  );
}

export function WebsiteLanguage() {
  const { code } = useParams();
  const { me } = useOutletContext() || {};
  const manager = me?.role === 'manager';
  const mayLive = manager || hasArea({ ...me, role: me?.role }, 'site');
  const online = useOnline();
  const q = useLanguages();
  const refresh = useRefresh();
  const { toast, say, clear } = useToast();
  const [ask, setAsk] = useState(null);
  const [err, setErr] = useState(null);
  const d = q.data;
  const l = d?.languages.find((x) => x.code === code);
  if (!LANGS[code]) return <div className="wb-page"><h1>No such language</h1><Link to="/website/languages">Languages</Link></div>;
  const set = async (patch, words) => {
    setAsk(null);
    setErr(null);
    try { await saveLanguages(d.settings, patch); await refresh(code); say(words); } catch (x) { setErr(x.message); }
  };
  const now = async () => {
    setErr(null);
    try { await action('site.translate.now', {}); say('Translating — new words show in about a minute'); setTimeout(() => refresh(code), 5000); } catch (x) { setErr(x.message); }
  };
  const label = LANGS[code].label;
  return (
    <div className="wb-page">
      <p className="ops-back-row"><Link className="ops-back" to="/website/languages">← Languages</Link></p>
      <div className="ops-head lg-head">
        <h1><span lang={code}>{label}</span> <span className="lg-head__name">{LANGS[code].name}</span></h1>
        {l && <Chip l={l} />}
        {l && manager && l.on && (
          <MoreMenu label={`More for ${LANGS[code].name}`} items={[
            { label: l.index ? 'Hide from search results' : 'Show in search results', onClick: () => setAsk('index') },
            { label: d.settings.oldPosts ? 'Stop translating older posts' : 'Translate older posts', onClick: () => set({ oldPosts: !d.settings.oldPosts }, d.settings.oldPosts ? 'Older posts stay in English' : 'Older posts will be translated') },
            { label: 'Turn off', danger: true, onClick: () => setAsk('off') },
          ]} />
        )}
      </div>
      <WebsiteTabs />
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <Unavailable q={q} />}
      {ask === 'off' && <Ask text={`Stop showing ${label}?`} onNo={() => setAsk(null)} onYes={() => set({ on: d.settings.on.filter((c) => c !== code) }, `${label} is off — its addresses go to the English pages`)} />}
      {ask === 'index' && <Ask text={l.index ? `Hide the ${label} pages from search engines?` : `Let search engines list the ${label} pages?`} onNo={() => setAsk(null)}
        onYes={() => set({ index: { ...d.settings.index, [code]: !l.index } }, l.index ? 'Hidden from search results' : 'Search engines may list them now')} />}
      {err && <p className="wb-field__err" role="alert">{err}</p>}
      {d && l && (
        <>
          <KeyNote d={d} manager={manager} />
          <TurnOn d={d} l={l} manager={manager && online} say={say} />
          <Checklist d={d} l={l} />
          {l.legal.stale_keys.length > 0 && l.legal.state === 'stale' && (
            <p className="card lg-note wb-warn">
              The English changed in: {(l.legal.stale_labels || l.legal.stale_keys).join(', ')}. It shows in English until you <Link to={`/website/languages/${code}/legal`}>approve new words</Link>.
            </p>
          )}
          {l.last_error && <p className="card lg-note wb-warn" role="status">{errorWords(l.last_error)} <button type="button" className="btn btn-quiet ops-tap" onClick={now}>Try again</button></p>}
          <div className="lg-links">
            <Link className="btn btn-quiet ops-tap" to={`/website/languages/${code}/legal`}>Words the law needs</Link>
            {l.offered && <a className="btn btn-quiet ops-tap" href={`${d.site || '/site'}${LANGS[code].path}/`} target="_blank" rel="noopener">Preview<span aria-hidden="true"> ↗</span><span className="ws-sr"> (opens a new tab)</span></a>}
            {l.on && !l.offered && <DraftPreview code={code} say={say} />}
            {l.on && l.counts?.waiting > 0 && <button type="button" className="btn btn-quiet ops-tap" onClick={now}>Translate now</button>}
          </div>
          {(l.on || l.counts) && <Sentences code={code} mayLive={mayLive} say={say} failedCount={l.counts?.failed || 0} />}
          {(l.on || l.counts) && <Edits code={code} mayUndo={mayLive} say={say} />}
          <Names d={d} say={say} />
        </>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
