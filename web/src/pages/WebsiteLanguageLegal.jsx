// Website → Languages → one language → "Words the law needs"
// (/website/languages/:code/legal; TR decision 46). One card per key: the
// English as the site shows it, then the words in the language — the
// approved ones, or a draft labelled as one (the machine's, or 简体
// converted for 繁體). Then how readers see the kept names (empty unless a
// person types one). A manager approves them all at once; everyone else
// reads. The server refuses a line that lost a {slot}, in place.
import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { day } from '../components/site/useSite.js';
import { Unavailable } from './WebsiteSites.jsx';
import { LANGS } from './WebsiteLanguages.jsx';
import './shifts.css';
import '../editor.css';
import './website.css';
import './website-languages.css';

export default function WebsiteLanguageLegal() {
  const { code } = useParams();
  const { me } = useOutletContext() || {};
  const manager = me?.role === 'manager';
  const online = useOnline();
  const qc = useQueryClient();
  // Nothing approved and no draft yet: asked again every ten seconds until
  // the first translation run (or 简体's approval, for 繁體) brings one.
  const q = useQuery({
    queryKey: ['site-language', code, 'legal'], queryFn: () => apiGet(`/site/languages/${code}/legal`), enabled: Boolean(LANGS[code]),
    refetchInterval: (qq) => (qq.state.data && !qq.state.data.approved && !qq.state.data.draft_from ? 10_000 : false),
  });
  const d = q.data;
  const [words, setWords] = useState(null);
  const [names, setNames] = useState({});
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { toast, say, clear } = useToast();
  useEffect(() => {
    if (!d || words) return;
    const a = d.approved?.words || {};
    setWords(Object.fromEntries(d.keys.map((k) => [k.key, d.stale_keys.includes(k.key) || !a[k.key] ? (d.draft[k.key] || a[k.key] || '') : a[k.key]])));
    setNames(Object.fromEntries(d.names.kept.map((nm) => [nm, d.names.approved[nm] || ''])));
  }, [d, words]);
  // A newer draft fills the boxes still empty; a box someone typed in stays.
  useEffect(() => {
    if (!d || !words) return;
    const fill = d.keys.filter((k) => !words[k.key] && d.draft[k.key]);
    if (fill.length) setWords((w) => ({ ...w, ...Object.fromEntries(fill.map((k) => [k.key, d.draft[k.key]])) }));
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!LANGS[code]) return <div className="wb-page"><h1>No such language</h1><Link to="/website/languages">Languages</Link></div>;
  const label = LANGS[code].label;
  const approve = async () => {
    setAsking(false);
    setBusy(true);
    setErr(null);
    try {
      await action('site.legal.approve', { lang: code, words: { ...words, names } });
      await Promise.all([qc.invalidateQueries({ queryKey: ['site-language', code] }), qc.invalidateQueries({ queryKey: ['site-languages'] })]);
      setWords(null);
      say(`Approved — the ${label} pages show these words`);
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  // No words to approve yet: say why, and keep Approve off until they come.
  const waiting = Boolean(d) && !d.approved && !d.draft_from;
  const waitWord = code === 'zh-Hant' ? 'Approve 简体 first; 繁體 is made from it.' : 'The machine draft arrives in about a minute.';
  // The card a refusal names ("Fill in Authorized by"), marked.
  const badKey = err && d ? d.keys.filter((k) => err.includes(k.label)).sort((a, b) => b.label.length - a.label.length)[0]?.key : null;
  const draftWord = d?.draft_from === 'converted' ? 'Converted from 简体 — check every word' : 'Machine draft — check every word';
  return (
    <div className="wb-page">
      <p className="ops-back-row"><Link className="ops-back" to={`/website/languages/${code}`}>←{' '}<span lang={code} className="lg-back__name">{label}</span></Link></p>
      <div className="ops-head"><h1>Words the law needs</h1></div>
      <WebsiteTabs />
      <p className="wb-help">Shown exactly as approved, and kept with every yes and every gift.</p>
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <Unavailable q={q} />}
      {d && words && (
        <form className="lg-legal" onSubmit={(e) => { e.preventDefault(); setAsking(true); }}>
          {waiting && <p className="lg-wait" role="status">{waitWord}</p>}
          {d.approved && <p className="wb-help">Approved {day(d.approved.at)}{d.approved.by_name ? ` by ${d.approved.by_name}` : ''}.</p>}
          {d.keys.map((k) => {
            const approved = d.approved?.words?.[k.key] && !d.stale_keys.includes(k.key);
            const stale = d.approved && d.stale_keys.includes(k.key);
            return (
              <section key={k.key} className={`card lg-key${badKey === k.key ? ' lg-key--bad' : ''}`} aria-labelledby={`lg-k-${k.key}`}>
                <h2 id={`lg-k-${k.key}`} className="lg-key__h">{k.label}{stale && <span className="chip chip-warn">English changed</span>}</h2>
                <p className="lg-key__en" lang="en">{k.english}</p>
                <label className="ws-sr" htmlFor={`lg-w-${k.key}`}>{k.label} in {label}</label>
                {!approved && words[k.key] && <p className="wb-field__hint">{draftWord}</p>}
                <textarea id={`lg-w-${k.key}`} className="input lg-key__box" lang={code} readOnly={!manager} rows={Math.min(8, Math.max(2, Math.ceil(k.english.length / 60)))}
                  aria-invalid={badKey === k.key || undefined}
                  value={words[k.key] || ''} onChange={(e) => setWords((w) => ({ ...w, [k.key]: e.target.value }))} />
              </section>
            );
          })}
          <section className="card lg-key" aria-labelledby="lg-names-h">
            <h2 id="lg-names-h" className="lg-key__h">How <span lang={code}>{label}</span> readers see names</h2>
            <p className="wb-field__hint">Leave empty to show the name only as written. Ask the person how their name is written.</p>
            {d.names.kept.map((nm) => (
              <div key={nm} className="field">
                <label htmlFor={`lg-n-${nm}`}>{nm}</label>
                <input id={`lg-n-${nm}`} className="input" lang={code} maxLength={60} readOnly={!manager} value={names[nm] || ''}
                  onChange={(e) => setNames((x) => ({ ...x, [nm]: e.target.value }))} />
              </div>
            ))}
          </section>
          <p aria-live="polite">{err && <span className="wb-field__err" role="alert">{err}</span>}</p>
          {manager && !asking && <button type="submit" className="btn btn-primary ops-tap" disabled={busy || !online || waiting}>{busy ? 'Approving…' : 'Approve these words'}</button>}
          {manager && asking && (
            <div className="lg-ask" role="group" aria-label={`Approve for ${label}?`}>
              <p>Approve for <span lang={code}>{label}</span>?</p>
              <div className="ops-actions">
                <button type="button" className="btn btn-primary ops-tap" autoFocus onClick={approve}>Yes</button>
                <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(false)}>No</button>
              </div>
            </div>
          )}
          {!manager && <p className="wb-help">A manager approves these words.</p>}
        </form>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
