// "Choose fonts" (WA decision 13): the sheet opened by Change fonts on
// Website → Theme (and on Settings → Brand, headings only, decision 15).
//   Pairings: twelve ready-made pairs, each drawn in its own letters with the
//   campaign's name and words, and what it adds to a first visit.
//   Any Google font: for headings (any of Google's) or body text (the 65
//   checked for long reading); search, kinds, Recommended or A–Z; each name
//   drawn in its own face (a sample through base.win, never from Google).
//   A sample pinned at the top shows the choice. The one primary button uses
//   it — "Get <Family> and use it" when base.win must fetch it first.
//   More: the fonts added to the site, with Remove (Undo) and "Not used".
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FEELS, FONT_BY_VALUE, FONT_WORDS, PAIRINGS, firstVisitKb, fontFor, profileFor } from '@base-win/shared/site/fonts';
import { action, apiGet, apiPost } from '../../api.js';
import { Dialog } from './Bits.jsx';
import { loadFace, loadSample, stackOf, useFaces } from './fontFaces.js';
import './FontSheet.css';

const KINDS = [['sans-serif', 'Sans serif'], ['serif', 'Serif'], ['display', 'Display'], ['handwriting', 'Handwriting'], ['monospace', 'Monospace']];
const KIND_WORDS = Object.fromEntries(KINDS);
const PENDING = 'p:';
const nameOf = (v, added) => (String(v).startsWith(PENDING) ? v.slice(2) : fontFor(v, added)?.label || 'Inter');

export const useAddedFonts = () => useQuery({ queryKey: ['site-fonts'], queryFn: () => apiGet('/site/fonts') });

// One catalogue row's name, in its own face once its sample is in.
function RowName({ row, added }) {
  const [face, setFace] = useState(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    let live = true;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const value = row.builtIn || (row.added ? `g:${added.find((a) => a.family === row.family)?.slug}` : null);
      const p = value ? loadFace(value, added).then((ok) => (ok ? stackOf(value, added) : null)) : loadSample(row.family, row.family).then((n) => (n ? `'${n}'` : null));
      p.then((f) => { if (!live) return; if (f) setFace(f); else setFailed(true); });
    });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [row.family]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={ref} className="fs-row__name" style={face ? { fontFamily: face } : undefined}>
      {row.family}{failed && <span className="fs-row__na"> · Preview unavailable</span>}
    </span>
  );
}

export default function FontSheet({ open, onClose, value, onPick, headingsOnly = false, siteName, words }) {
  const qc = useQueryClient();
  const fontsQ = useAddedFonts();
  const added = fontsQ.data?.fonts || [];
  const [tab, setTab] = useState(headingsOnly ? 'any' : 'pairs');
  const [choice, setChoice] = useState(value);
  const [role, setRole] = useState('heading');
  const [feel, setFeel] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState('recommended');
  const [list, setList] = useState({ rows: [], total: null, page: 0, error: null, loading: false });
  const [busy, setBusy] = useState('');
  const [said, setSaid] = useState('');
  const [undo, setUndo] = useState(null);
  useEffect(() => { if (open) { setChoice(value); setSaid(''); setBusy(''); setUndo(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const forBody = !headingsOnly && role === 'body';
  useEffect(() => { if (forBody && !['', 'sans-serif', 'serif'].includes(kind)) setKind(''); }, [forBody, kind]);

  // The list, 40 at a time, a moment after typing stops.
  const load = async (page) => {
    setList((l) => ({ ...l, loading: true, error: null }));
    try {
      const r = await apiGet(`/site/fonts/catalogue?q=${encodeURIComponent(q)}&kind=${kind}&for=${forBody ? 'body' : 'heading'}&sort=${sort}&page=${page}`);
      setList((l) => ({ rows: page ? [...l.rows, ...r.rows] : r.rows, total: r.total, page, built: r.built, error: null, loading: false }));
    } catch (e) {
      setList((l) => ({ ...l, loading: false, error: e.message }));
    }
  };
  useEffect(() => {
    if (!open || tab !== 'any') return undefined;
    const t = setTimeout(() => load(0), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, tab, q, kind, sort, forBody]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = useRef(null);
  useEffect(() => {
    const el = more.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !list.loading && list.rows.length < (list.total || 0)) load(list.page + 1); });
    io.observe(el);
    return () => io.disconnect();
  });

  const pairValues = useMemo(() => [...new Set(PAIRINGS.flatMap((p) => [p.heading, p.body]))], []);
  useFaces(open ? pairValues : [], added);
  const known = (v) => !String(v).startsWith(PENDING);
  useFaces(open ? [choice.heading, choice.body].filter(known) : [], added);
  const [pendingFace, setPendingFace] = useState({});
  useEffect(() => {
    for (const v of [choice.heading, choice.body]) {
      if (known(v) || pendingFace[v]) continue;
      loadSample(v.slice(2), `${siteName || 'Your campaign'} ${words || ''}`.slice(0, 120)).then((n) => n && setPendingFace((p) => ({ ...p, [v]: `'${n}'` })));
    }
  }, [choice.heading, choice.body]); // eslint-disable-line react-hooks/exhaustive-deps
  const faceOf = (v) => (known(v) ? stackOf(v, added) : pendingFace[v] || 'inherit');

  const kb = [choice.heading, choice.body].every(known) ? firstVisitKb({ fonts: choice }, added, 'en') : null;
  const bodyBad = !headingsOnly && known(choice.body) && fontFor(choice.body, added) && !fontFor(choice.body, added).body;
  const pending = [...new Set([choice.heading, choice.body].filter((v) => !known(v)))];
  const pick = (v) => setChoice((c) => ({ ...c, [headingsOnly ? 'heading' : role]: v }));
  const valueOfRow = (r) => r.builtIn || (r.added ? `g:${added.find((a) => a.family === r.family)?.slug}` : `${PENDING}${r.family}`);

  const use = async () => {
    setSaid('');
    let next = { ...choice };
    try {
      for (const v of pending) {
        setBusy(`Getting ${v.slice(2)} from Google…`);
        const r = await action('site.font.add', { family: v.slice(2) });
        const g = `g:${r.font.slug}`;
        next = Object.fromEntries(Object.entries(next).map(([k, x]) => [k, x === v ? g : x]));
      }
      await qc.invalidateQueries({ queryKey: ['site-fonts'] });
      setBusy('');
      onPick(next, await qc.fetchQuery({ queryKey: ['site-fonts'], queryFn: () => apiGet('/site/fonts') }).then((d) => d.fonts).catch(() => added));
    } catch (e) {
      setBusy('');
      setSaid(e.message);
    }
  };
  const remove = async (f) => {
    setSaid('');
    try {
      await action('site.font.remove', { slug: f.slug });
      setUndo(f);
      setSaid(`${f.family} is off your site.`);
      qc.invalidateQueries({ queryKey: ['site-fonts'] });
    } catch (e) { setSaid(e.message); }
  };
  const restore = async () => {
    const f = undo;
    setUndo(null);
    try { await action('site.font.restore', { slug: f.slug }); setSaid(`${f.family} is back.`); qc.invalidateQueries({ queryKey: ['site-fonts'] }); } catch (e) { setSaid(e.message); }
  };
  const refetch = async (slug) => { await apiPost('/site/fonts/refetch', { slug }).catch(() => {}); qc.invalidateQueries({ queryKey: ['site-fonts'] }); };

  const hp = known(choice.heading) ? profileFor(fontFor(choice.heading, added) || FONT_BY_VALUE.inter) : { weight: 400 };
  const primary = pending.length ? `Get ${pending.map((v) => v.slice(2)).join(' and ')} and use ${pending.length > 1 ? 'them' : 'it'}` : 'Use these fonts';
  const pairs = PAIRINGS.filter((p) => !feel || p.feel === feel);
  const kinds = forBody ? KINDS.slice(0, 2) : KINDS;
  return (
    <Dialog open={open} title="Choose fonts" onClose={onClose} wide>
      <div className="fs-sample" aria-label="Your choice">
        <p className="fs-sample__h" style={{ fontFamily: faceOf(choice.heading), fontWeight: hp.weight }}>{siteName || 'Your campaign’s name'}</p>
        {!headingsOnly && <p className="fs-sample__p" style={{ fontFamily: faceOf(choice.body) }}>{words || 'We’re working for a city where everyone has a fair say.'}</p>}
        <p className="fs-sample__names">{nameOf(choice.heading, added)}{headingsOnly ? ' for headings' : ` for headings · ${nameOf(choice.body, added)} for body text`}</p>
        {kb > 150 && <p className="wb-warn" role="alert">{FONT_WORDS.budget(kb)}</p>}
        {kb > 100 && kb <= 150 && <p className="fs-sample__kb">{FONT_WORDS.slower(kb)}</p>}
        {bodyBad && <p className="wb-warn" role="alert">{FONT_WORDS.body}</p>}
        <p className="fs-sample__note">Punjabi and Chinese use matching fonts automatically.</p>
      </div>

      {!headingsOnly && (
        <div className="fs-tabs" role="tablist" aria-label="How to choose">
          {[['pairs', 'Pairings'], ['any', 'Any Google font']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className="fs-tab" onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
      )}

      {tab === 'pairs' && (
        <>
          <div className="fs-chips" role="group" aria-label="Feel">
            {['', ...FEELS].map((f) => <button key={f || 'all'} type="button" className="chip fs-chip" aria-pressed={feel === f} onClick={() => setFeel(f)}>{f || 'All'}</button>)}
          </div>
          <div className="fs-pairs" role="radiogroup" aria-label="Pairings">
            {pairs.map((p) => {
              const on = choice.heading === p.heading && choice.body === p.body;
              const h = F_(p.heading);
              return (
                <label key={p.key} className="fs-pair" data-on={on ? '' : undefined}>
                  <input type="radio" name="fs-pair" checked={on} onChange={() => setChoice({ heading: p.heading, body: p.body })} />
                  <span className="fs-pair__h" style={{ fontFamily: h.stack, fontWeight: profileFor(h).weight, textTransform: profileFor(h).case }}>{siteName || 'Your campaign’s name'}</span>
                  <span className="fs-pair__p" style={{ fontFamily: F_(p.body).stack }}>{words || 'We’re working for a city where everyone has a fair say.'}</span>
                  <span className="fs-pair__names">{h.label} / {F_(p.body).label} · {p.feel}</span>
                  <span className="fs-pair__kb">Adds {p.kb} KB on a first visit</span>
                  {on && <span className="fs-pair__tick" aria-hidden="true">✓</span>}
                </label>
              );
            })}
          </div>
        </>
      )}

      {tab === 'any' && (
        <>
          {!headingsOnly && (
            <div className="fs-seg" role="radiogroup" aria-label="Which text">
              {[['heading', 'For headings'], ['body', 'For body text']].map(([k, label]) => (
                <label key={k} className="fs-seg__opt" data-on={role === k ? '' : undefined}>
                  <input type="radio" name="fs-role" checked={role === k} onChange={() => setRole(k)} />{label}
                </label>
              ))}
            </div>
          )}
          <input type="search" className="input fs-search" aria-label="Search fonts" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={list.total != null && !q && !kind ? `Search ${list.total.toLocaleString('en-CA')} fonts` : 'Search fonts'} />
          <div className="fs-chips" role="group" aria-label="Kind">
            {kinds.map(([k, label]) => <button key={k} type="button" className="chip fs-chip" aria-pressed={kind === k} onClick={() => setKind(kind === k ? '' : k)}>{label}</button>)}
            <select className="input fs-sort" aria-label="Order" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recommended">Recommended</option>
              <option value="az">A–Z</option>
            </select>
          </div>
          {forBody && <p className="wb-field__hint">Body text uses fonts checked for long reading.</p>}
          {list.built && <p className="fs-built">Font list from {new Date(`${list.built}T12:00:00`).toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric' })}</p>}
          {list.error && <p className="error" role="alert">Unavailable — <button type="button" className="btn btn-quiet" onClick={() => load(0)}>Try again</button></p>}
          <ul className="fs-rows" role="listbox" aria-label="Fonts">
            {list.rows.map((r) => {
              const v = valueOfRow(r);
              const on = choice[headingsOnly ? 'heading' : role] === v;
              return (
                <li key={r.family} role="option" aria-selected={on} tabIndex={0} className="fs-row" data-on={on ? '' : undefined}
                  onClick={() => pick(v)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(v); } }}>
                  <RowName row={r} added={added} />
                  <span className="fs-row__meta">{KIND_WORDS[r.kind]} · {r.latinExt ? 'Covers English and French accents' : 'Covers English'} · {r.about ? 'about ' : ''}{r.kb} KB{r.added || r.builtIn ? ' · On your site' : ''}</span>
                </li>
              );
            })}
          </ul>
          {list.loading ? <p className="muted">Loading…</p> : list.total === 0 && <p className="muted">No fonts match.</p>}
          <div ref={more} aria-hidden="true" className="fs-more" />
        </>
      )}

      <details className="fs-mine">
        <summary>More: fonts on your site{fontsQ.data ? ` (${added.length} of ${fontsQ.data.max})` : ''}</summary>
        {fontsQ.isError && <p className="error">Unavailable — <button type="button" className="btn btn-quiet" onClick={() => fontsQ.refetch()}>Try again</button></p>}
        {fontsQ.isPending && <p className="muted">Loading…</p>}
        {fontsQ.data && !added.length && <p className="muted">None yet. Fonts you get from Google show here.</p>}
        <ul className="fs-mine__list">
          {added.map((f) => (
            <li key={f.slug} className="fs-mine__row">
              <span className="fs-row__name" style={{ fontFamily: stackOf(`g:${f.slug}`, added) }}>{f.family}</span>
              {f.notUsed && <span className="chip">Not used</span>}
              {f.refetch === 'waiting' && <span className="muted">Getting your fonts back from Google…</span>}
              {f.refetch === 'failed' && <span>{f.family} couldn’t be fetched again. <button type="button" className="btn btn-quiet" onClick={() => refetch(f.slug)}>Try again</button></span>}
              <button type="button" className="btn btn-quiet wb-tap" onClick={() => remove(f)}>Remove<span className="ws-sr"> {f.family}</span></button>
            </li>
          ))}
        </ul>
      </details>

      <div className="fs-foot">
        <p className="fs-said" aria-live="polite">{busy || said}{undo && <> <button type="button" className="btn" onClick={restore}>Undo</button></>}</p>
        <button type="button" className="btn btn-primary wb-tap" disabled={Boolean(busy) || kb > 150 || bodyBad} onClick={use}>{busy ? 'Getting it…' : primary}</button>
      </div>
    </Dialog>
  );
}

const F_ = (v) => FONT_BY_VALUE[v];
