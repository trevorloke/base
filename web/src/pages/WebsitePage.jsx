// Website → a page's builder (/website/pages/:id).
//   The page's sections in order. Drag one by its handle to move it — or tap
//   the handle, then "Move here"; ⋯ also has Move up / Move down (keyboard).
//   "Add a section" opens the catalogue, grouped (Text and pictures,
//   Actions, Live from base.win, About the organization) with what each one
//   does. Tap a section to open its form (made from its fields: Fields.jsx);
//   ⋯ hides or shows it, duplicates it, adds one below, or deletes it (Undo).
//   Page details: title, address, description and share picture, "In the
//   menu".
//   Every change saves the draft by itself (a moment after the last one):
//   "Saving…" · "Saved 2:14 pm". A draft may be unfinished; what's on the
//   site doesn't change until Publish. Publish checks every section first
//   (the catalogue's strict check, and the petitions and pages they point
//   at) and says exactly which section and which box needs a look — and
//   opens it there.
//   Preview: the draft in a new tab (a link that lasts half an hour), and on
//   a wide screen beside the editor, as a phone or a computer shows it,
//   fresh after every save.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { MODULE_BY_KIND } from '@starbase/shared/site/catalogue';
import { action, apiPost } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { useDragDrop } from '../components/useDragDrop.js';
import { Dialog, MoreMenu, SaveState, Toast, useToast } from '../components/site/Bits.jsx';
import { ImageField, ModuleForm, TextField, ToggleField } from '../components/site/Fields.jsx';
import { useSite, useSiteCampaigns, useSitePage, useSiteRefresh } from '../components/site/useSite.js';
import {
  addModule, duplicateModule, groups, moveModule, problemWords, problemsOf, putBack, removeModule,
  sectionFromServer, setHidden, setProps, slugInput, summaryOf,
} from '../components/site/builder.js';
import { PageStatus, addressOf } from './WebsitePages.jsx';
import './shifts.css';
import '../editor.css';
import './website.css';

const SAVE_AFTER_MS = 800;
const TOKEN_FOR_MS = 20 * 60_000; // a preview link lasts 30 minutes; a new one after 20
const wideNow = () => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1280px)').matches;
const SYSTEM = { home: 'The home page is always at /.', news: 'The news page is always at /news.' };

// ── Add a section: the catalogue ──
function Catalogue({ open, onClose, onPick, paymentsReady }) {
  return (
    <Dialog open={open} title="Add a section" onClose={onClose} wide>
      {groups().map((g) => (
        <section key={g.key} className="wb-cat" aria-labelledby={`wb-cat-${g.key}`}>
          <h3 id={`wb-cat-${g.key}`} className="wb-cat__h">{g.label}</h3>
          <ul className="wb-cat__list">
            {g.modules.map((m) => (
              <li key={m.kind}>
                <button type="button" className="wb-cat__item" onClick={() => onPick(m.kind)}>
                  <span className="wb-cat__name">{m.label}</span>
                  <span className="wb-cat__what">{m.description}</span>
                  {['donate', 'join'].includes(m.kind) && !paymentsReady && (
                    <span className="wb-cat__note">Online giving isn’t set up yet — until it is, the form says so.</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Dialog>
  );
}

// One builder per page: another page's address starts afresh (its own
// draft, saving, preview link).
export default function WebsitePage() {
  const { id } = useParams();
  return <Builder key={id} id={id} />;
}

function Builder({ id }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const q = useSitePage(id);
  const siteQ = useSite();
  const campsQ = useSiteCampaigns({ fresh: true });
  const { toast, say, clear } = useToast();

  const [draft, setDraftState] = useState(null);
  const [base, setBase] = useState(null);
  const [save, setSave] = useState({ state: 'saved' });
  const [openId, setOpenId] = useState(null);
  const [strict, setStrict] = useState(false);
  const [looseProblems, setLooseProblems] = useState([]);
  const [serverProblem, setServerProblem] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [adding, setAdding] = useState(null); // { at } while the catalogue is open
  const [details, setDetails] = useState(params.get('new') === '1');
  const [slug, setSlug] = useState('');
  const [slugErr, setSlugErr] = useState(null);
  const [preview, setPreview] = useState(null); // { url, at }
  const [frameKey, setFrameKey] = useState(0);
  const [showFrame, setShowFrame] = useState(wideNow);
  const [frameSize, setFrameSize] = useState('phone');
  const [said, setSaid] = useState('');

  const draftRef = useRef(null);
  const baseRef = useRef(null);
  const dirty = useRef(false);
  const timer = useRef(null);
  const inflight = useRef(null);
  const stopped = useRef(false); // someone else saved: no more autosaves until a reload

  // null while they load: a publish's check then leaves them to the server.
  const campaigns = useMemo(() => campsQ.data?.campaigns || null, [campsQ.data]);
  const pages = useMemo(() => siteQ.data?.pages || null, [siteQ.data]);
  const paymentsReady = Boolean(siteQ.data?.payments?.ready);

  // The page as opened: once, from a fresh read (later reads must never
  // overwrite what's being typed). Leaving marks the copy old, so the next
  // visit reads it again.
  useEffect(() => {
    const p = q.data?.page;
    if (!p || q.isFetching || baseRef.current?.id === p.id) return;
    const d = p.draft || {};
    const next = {
      title: d.title || p.title || '', description: d.description ?? p.description ?? '',
      image: d.image || { url: '', alt: '' }, show_in_nav: Boolean(p.show_in_nav), modules: Array.isArray(d.modules) ? d.modules : [],
    };
    draftRef.current = next;
    baseRef.current = p;
    setDraftState(next);
    setBase(p);
    setSlug(p.slug);
  }, [q.data, q.isFetching]);
  useEffect(() => () => { qc.invalidateQueries({ queryKey: ['site-page', id] }); }, [qc, id]);

  // ── Saving the draft ──
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inflight.current) await inflight.current;
    if (!dirty.current || stopped.current || !draftRef.current) return !stopped.current;
    const d = draftRef.current;
    if (!d.title.trim()) { setSave({ state: 'blocked', text: 'give the page a title' }); return false; }
    const loose = problemsOf(d.modules);
    setLooseProblems(loose);
    if (loose.length) { setSave({ state: 'blocked', text: problemWords(loose[0]) }); return false; }
    dirty.current = false;
    setSave({ state: 'saving' });
    const run = (async () => {
      try {
        const res = await action('site.page.save', {
          id, title: d.title.trim(), description: d.description || '', image: d.image?.url ? d.image : null,
          show_in_nav: d.show_in_nav, modules: d.modules, updated_at: baseRef.current?.updated_at,
        });
        baseRef.current = res.page;
        setBase(res.page);
        qc.setQueryData(['site-page', id], { page: res.page });
        setSave(dirty.current ? { state: 'waiting' } : { state: 'saved', at: Date.now() });
        setFrameKey((k) => k + 1);
        return true;
      } catch (e) {
        if (e.status === 409) {
          stopped.current = true;
          setSave({ state: 'conflict', text: 'Someone else saved this page since you opened it. Reload to see their changes (yours since then aren’t saved).' });
          return false;
        }
        dirty.current = true;
        setSave({ state: 'error', text: e.message });
        return false;
      }
    })();
    inflight.current = run;
    const ok = await run;
    inflight.current = null;
    if (ok && dirty.current) return flush();
    return ok;
  }, [id, qc]);

  const change = useCallback((fn) => {
    if (!draftRef.current) return;
    const next = fn(draftRef.current);
    draftRef.current = next;
    setDraftState(next);
    setServerProblem(null);
    if (stopped.current) return;
    dirty.current = true;
    setSave({ state: 'waiting' });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flush(); }, SAVE_AFTER_MS);
  }, [flush]);

  // Leaving: what's typed still saves. Closing the tab mid-save: asked first.
  useEffect(() => () => { if (dirty.current) flush(); }, [flush]);
  useEffect(() => {
    const warn = (e) => { if (dirty.current || inflight.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // ── Preview: a link to the draft (renewed before it runs out) ──
  const previewUrl = useCallback(async () => {
    if (preview && Date.now() - preview.at < TOKEN_FOR_MS) return preview.url;
    const r = await apiPost('/site/preview-token', { pageId: id });
    setPreview({ url: r.url, at: Date.now() });
    return r.url;
  }, [id, preview]);
  useEffect(() => {
    if (!base?.id || !online) return undefined;
    previewUrl().catch(() => {});
    const t = setInterval(() => { previewUrl().catch(() => {}); }, TOKEN_FOR_MS);
    return () => clearInterval(t);
  }, [base?.id, online, previewUrl]);
  const openPreview = async (e) => {
    // Saved and fresh: the link opens as it is. Otherwise save first.
    if (!dirty.current && !inflight.current && preview && Date.now() - preview.at < TOKEN_FOR_MS) return;
    e.preventDefault();
    const w = window.open('about:blank', '_blank');
    await flush();
    try {
      const url = await previewUrl();
      if (w) w.location.replace(url); else window.open(url, '_blank', 'noopener');
    } catch (err) {
      w?.close();
      say(`The preview didn’t open — ${err.message}`);
    }
  };

  // ── Sections ──
  const announce = (text) => setSaid(text);
  const at = (mid) => draftRef.current?.modules.findIndex((m) => m.id === mid) ?? -1;
  const moveTo = (from, to) => {
    const list = draftRef.current.modules;
    if (to < 0 || to >= list.length || from === to) return;
    const m = list[from];
    change((d) => ({ ...d, modules: moveModule(d.modules, from, to) }));
    announce(`Moved ${MODULE_BY_KIND[m.kind]?.label || 'the section'} to ${to + 1} of ${list.length}`);
  };
  const dnd = useDragDrop({
    enabled: !stopped.current,
    onDrop: (item, key) => {
      const to = at(key.replace(/^sec:/, ''));
      const from = at(item.id);
      if (from >= 0 && to >= 0) moveTo(from, to);
    },
  });
  const picked = dnd.picked;

  const focusSection = (mid, field = true) => {
    setTimeout(() => {
      const el = document.getElementById(`wb-sec-${mid}`);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      const target = (field && el.querySelector('[aria-invalid="true"]')) || el.querySelector('.wb-sec__body input, .wb-sec__body textarea, .wb-sec__body select') || el.querySelector('.wb-sec__toggle');
      target?.focus({ preventScroll: true });
    }, 60);
  };
  const addAt = (kind) => {
    const where = adding?.at ?? draftRef.current.modules.length;
    let made = null;
    change((d) => { const r = addModule(d.modules, kind, where); made = r.module; return { ...d, modules: r.list }; });
    setAdding(null);
    if (made) {
      setOpenId(made.id);
      announce(`Added ${MODULE_BY_KIND[kind].label} as section ${where + 1}`);
      focusSection(made.id, false);
    }
  };
  const duplicate = (i) => {
    let made = null;
    change((d) => { const r = duplicateModule(d.modules, i); made = r.module; return { ...d, modules: r.list }; });
    if (made) { setOpenId(made.id); say(`Copied — the copy is section ${i + 2}`); }
  };
  const remove = (i) => {
    let gone = null;
    change((d) => { const r = removeModule(d.modules, i); gone = r.removed; return { ...d, modules: r.list }; });
    if (!gone) return;
    // The section's gone, and with it the button that was focused: the next
    // one takes the focus (or "Add a section").
    setTimeout(() => {
      const rows = document.querySelectorAll('.wb-sec__toggle');
      (rows[i] || rows[i - 1] || document.querySelector('.wb-add'))?.focus();
    }, 30);
    const label = MODULE_BY_KIND[gone.module.kind]?.label || 'the section';
    say(`Deleted section ${gone.index + 1} (${label})`, {
      undo: () => { change((d) => ({ ...d, modules: putBack(d.modules, gone) })); say(`${label} is back`); },
    });
  };
  const hide = (i, hidden) => {
    const m = draftRef.current.modules[i];
    change((d) => ({ ...d, modules: setHidden(d.modules, i, hidden) }));
    say(hidden ? `${MODULE_BY_KIND[m.kind]?.label} is hidden — it won’t show on the page` : `${MODULE_BY_KIND[m.kind]?.label} shows on the page again`);
  };

  // ── Problems: a save's (loose), a publish's (strict) and the server's ──
  const problems = useMemo(() => {
    if (!draft) return [];
    const list = strict ? problemsOf(draft.modules, { strict: true, campaigns, pages }) : looseProblems.filter((p) => draft.modules.some((m) => m.id === p.id));
    if (serverProblem?.id && !list.some((p) => p.id === serverProblem.id)) list.push(serverProblem);
    return list;
  }, [draft, strict, campaigns, pages, looseProblems, serverProblem]);
  const errorsFor = (mid) => Object.fromEntries(problems.filter((p) => p.id === mid && p.path).map((p) => [p.path, p.text]));
  // Loose problems are fixed as they're typed: check again on every change.
  useEffect(() => {
    if (!draft || !looseProblems.length) return;
    const now = problemsOf(draft.modules);
    if (now.map(problemWords).join('|') !== looseProblems.map(problemWords).join('|')) setLooseProblems(now);
  }, [draft, looseProblems]);

  // ── Publish ──
  const publish = async () => {
    setPublishing(true);
    setServerProblem(null);
    const saved = await flush();
    if (!saved) { setPublishing(false); setStrict(true); return; }
    const list = problemsOf(draftRef.current.modules, { strict: true, campaigns, pages });
    if (list.length) {
      setStrict(true);
      setOpenId(list[0].id);
      focusSection(list[0].id);
      setPublishing(false);
      return;
    }
    try {
      const res = await action('site.page.publish', { id });
      baseRef.current = res.page;
      setBase(res.page);
      setStrict(false);
      say('Published — it’s on the site now');
      refresh(['site']);
    } catch (e) {
      const s = sectionFromServer(e.message);
      const m = s ? draftRef.current.modules[s.index] : null;
      if (m) {
        setServerProblem({ index: s.index, id: m.id, kind: m.kind, label: MODULE_BY_KIND[m.kind]?.label || '', path: s.path, text: s.text });
        setOpenId(m.id);
        focusSection(m.id);
      } else {
        setServerProblem({ text: e.message });
      }
    } finally {
      setPublishing(false);
    }
  };
  const unpublish = async () => {
    await flush();
    try {
      const res = await action('site.page.unpublish', { id });
      baseRef.current = res.page;
      setBase(res.page);
      say('Taken off the site — it’s a draft now');
      refresh(['site']);
    } catch (e) { say(e.message); }
  };
  const deletePage = async () => {
    await flush();
    try {
      await action('site.page.delete', { id });
      await refresh(['site']);
      navigate('/website/pages', { replace: true, state: { deleted: { id, title: draftRef.current?.title || base.title, slug: base.slug } } });
    } catch (e) { say(e.message); }
  };
  const changeSlug = async (e) => {
    e.preventDefault();
    setSlugErr(null);
    if (!slug || slug === base.slug) return;
    await flush();
    try {
      const res = await action('site.page.save', { id, slug, updated_at: baseRef.current?.updated_at });
      baseRef.current = res.page;
      setBase(res.page);
      setSlug(res.page.slug);
      say(`The address is now ${addressOf(res.page)}`);
      refresh(['site']);
    } catch (err) { setSlugErr(err.message); }
  };

  // ── Drawing ──
  if (noSignal(q)) return <div className="wb-page"><NoSignal /></div>;
  if (q.isError) {
    return (
      <div className="wb-page">
        <Link className="ops-back" to="/website/pages">← Pages</Link>
        <p className="error" role="alert">{q.error.status === 404 ? 'That page is gone — it may have been deleted.' : q.error.message}</p>
      </div>
    );
  }
  if (!draft || !base) return <div className="wb-page"><p className="muted">Loading…</p></div>;

  const live = base.status === 'published';
  const nothingNew = live && !base.changed && !dirty.current && save.state === 'saved';
  const ctx = { campaigns, pages: pages || [], toast: (text, undo) => say(text, { undo }), announce };
  const frame = showFrame && preview?.url;
  const strictList = strict ? problems : [];

  return (
    <div className={`wb-build${frame ? ' wb-build--frame' : ''}`}>
      <div className="wb-build__main">
        <Link className="ops-back" to="/website/pages">← Pages</Link>
        <div className="wb-build__head">
          <div className="wb-build__title">
            <h1>{draft.title || 'Untitled page'}</h1>
            <span className="wb-build__meta">
              <span className="wb-row__addr">{addressOf(base)}</span>
              <PageStatus p={{ ...base, changed: base.changed || dirty.current }} />
              <SaveState state={save} onRetry={() => { dirty.current = true; flush(); }} />
            </span>
          </div>
          <div className="wb-build__actions">
            {preview?.url ? (
              <a className="btn ops-tap" href={preview.url} target="_blank" rel="noopener" onClick={openPreview}>
                Preview<span aria-hidden="true"> ↗</span><span className="ws-sr"> (opens a new tab)</span>
              </a>
            ) : (
              <button type="button" className="btn ops-tap" disabled>Preview</button>
            )}
            <button type="button" className="btn btn-primary ops-tap" onClick={publish}
              disabled={publishing || !online || save.state === 'conflict' || nothingNew}>
              {publishing ? 'Publishing…' : nothingNew ? 'Published' : live ? 'Publish changes' : 'Publish'}
            </button>
            <MoreMenu label="More for this page" items={[
              live && { label: 'View on the site', href: `${(siteQ.data?.urls?.site || '/site/').replace(/\/$/, '')}${addressOf(base)}`, external: true },
              { label: showFrame ? 'Hide the preview beside' : 'Show the preview beside', onClick: () => setShowFrame((v) => !v) },
              live && base.slug !== 'home' && { label: 'Take it off the site', onClick: unpublish },
              base.slug !== 'home' && { label: 'Delete this page', onClick: deletePage, danger: true },
            ]} />
          </div>
        </div>

        {save.state === 'conflict' && (
          <div className="wb-alert" role="alert">
            <p>{save.text}</p>
            <button type="button" className="btn ops-tap" onClick={() => window.location.reload()}>Reload</button>
          </div>
        )}
        {(strictList.length > 0 || (serverProblem && !serverProblem.id)) && (
          <div className="wb-alert" role="alert" aria-labelledby="wb-before">
            <h2 id="wb-before" className="wb-alert__h">Before it goes on the site</h2>
            <ul className="wb-alert__list">
              {strictList.map((p) => (
                <li key={`${p.id}-${p.path}`}>
                  <button type="button" className="btn-link" onClick={() => { setOpenId(p.id); focusSection(p.id); }}>{problemWords(p)}</button>
                </li>
              ))}
              {serverProblem && !serverProblem.id && <li>{serverProblem.text}</li>}
            </ul>
          </div>
        )}

        <section className="wb-details" aria-label="Page details">
          <button type="button" className="disclose" aria-expanded={details} aria-controls="wb-details-body" onClick={() => setDetails((v) => !v)}>
            Page details — title, address, description, share picture
          </button>
          {details && (
            <div id="wb-details-body" className="wb-details__body">
              <TextField id="wb-title" label="Title" max={120} value={draft.title} error={!draft.title.trim() ? 'Give the page a title' : null}
                onChange={(v) => change((d) => ({ ...d, title: v }))} />
              <form className="field wb-field" onSubmit={changeSlug}>
                <label htmlFor="wb-slug">Address</label>
                {SYSTEM[base.slug] ? (
                  <p className="wb-fixed">{SYSTEM[base.slug]}</p>
                ) : (
                  <>
                    <div className="wb-slug">
                      <span className="wb-slug__root" aria-hidden="true">/</span>
                      <input id="wb-slug" className="input" maxLength={60} autoComplete="off" spellCheck={false} value={slug}
                        aria-invalid={slugErr ? 'true' : undefined} aria-describedby="wb-slug-hint"
                        onChange={(e) => { setSlug(slugInput(e.target.value)); setSlugErr(null); }} />
                      <button type="submit" className="btn wb-tap" disabled={!slug || slug === base.slug}>Change address</button>
                    </div>
                    <p className="wb-field__hint" id="wb-slug-hint">
                      {live ? 'Changes at once, on the live page too: links to the old address stop working.' : 'Lowercase letters, numbers and dashes.'}
                    </p>
                    {slugErr && <p className="wb-field__err">{slugErr}</p>}
                  </>
                )}
              </form>
              <TextField id="wb-desc" label="Description (for search engines and shares)" max={300} multiline value={draft.description}
                onChange={(v) => change((d) => ({ ...d, description: v }))} />
              <ImageField id="wb-share" label="Share picture" value={draft.image}
                hint="Shown when the page is shared on social media or in a message. Without one, the site’s own (Settings → Search and sharing)."
                onChange={(v) => change((d) => ({ ...d, image: v }))} />
              <ToggleField id="wb-nav" label="Show this page in the site’s menu" value={draft.show_in_nav}
                hint={live ? null : 'Once it’s published.'} onChange={(v) => change((d) => ({ ...d, show_in_nav: v }))} />
            </div>
          )}
        </section>

        <h2 className="wb-h2">Sections</h2>
        {draft.modules.length === 0 && <p className="ops-empty">Nothing on this page yet. Add its first section.</p>}
        {draft.modules.length > 1 && <p className="wb-help">Drag a section by its handle to move it — or tap the handle, then “Move here”.</p>}
        <ol className="wb-secs" aria-label="Sections, top to bottom">
          {draft.modules.map((m, i) => {
            const def = MODULE_BY_KIND[m.kind];
            const label = def?.label || m.kind;
            const isOpen = openId === m.id;
            const isPicked = picked?.id === m.id;
            const bad = problems.some((p) => p.id === m.id);
            const general = problems.find((p) => p.id === m.id && !p.path);
            const sum0 = summaryOf(m, { campaigns });
            const sum = sum0 && sum0.toLowerCase() !== label.toLowerCase() ? sum0 : '';
            return (
              <li key={m.id} id={`wb-sec-${m.id}`} className="wb-sec" data-drop-key={`sec:${m.id}`} data-over={dnd.over(`sec:${m.id}`)}
                data-open={isOpen ? '' : undefined} data-hidden={m.hidden ? '' : undefined} data-bad={bad ? '' : undefined}
                data-picked={isPicked ? '' : undefined} data-kind={m.kind}>
                <div className="wb-sec__head">
                  <button type="button" className="wb-handle" {...dnd.itemProps({ id: m.id, label })} disabled={stopped.current}
                    aria-label={isPicked ? `${label}: picked up — choose where it goes` : `Move section ${i + 1}, ${label}`}>
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
                  </button>
                  <button type="button" className="wb-sec__toggle" aria-expanded={isOpen} aria-controls={`wb-sec-${m.id}-body`}
                    onClick={() => setOpenId(isOpen ? null : m.id)}>
                    <span className="wb-sec__num" aria-hidden="true">{i + 1}</span>
                    <span className="wb-sec__words">
                      <span className="wb-sec__label"><span className="ws-sr">Section {i + 1}: </span>{label}</span>
                      {sum && <span className="wb-sec__sum">{sum}</span>}
                    </span>
                    {m.hidden && <span className="chip ops-chip-muted">Hidden</span>}
                    {bad && <span className="chip chip-danger">Needs a look</span>}
                  </button>
                  {picked && !isPicked ? (
                    <button type="button" className="btn wb-here" onClick={() => dnd.dropPicked(`sec:${m.id}`)}>Move here</button>
                  ) : (
                    <MoreMenu label={`More for section ${i + 1}, ${label}`} items={[
                      i > 0 && { label: 'Move up', onClick: () => moveTo(i, i - 1) },
                      i < draft.modules.length - 1 && { label: 'Move down', onClick: () => moveTo(i, i + 1) },
                      { label: m.hidden ? 'Show on the page' : 'Hide from the page', onClick: () => hide(i, !m.hidden) },
                      { label: 'Duplicate', onClick: () => duplicate(i) },
                      { label: 'Add a section below', onClick: () => setAdding({ at: i + 1 }) },
                      { label: 'Delete', onClick: () => remove(i), danger: true },
                    ]} />
                  )}
                </div>
                {isOpen && (
                  <div className="wb-sec__body" id={`wb-sec-${m.id}-body`}>
                    {def?.description && <p className="wb-sec__what">{def.description}</p>}
                    {m.hidden && <p className="wb-note">Hidden: it stays in the draft but isn’t shown on the page.</p>}
                    {general && <p className="wb-field__err">{general.text}</p>}
                    <ModuleForm module={m} errors={errorsFor(m.id)} ctx={ctx}
                      onChange={(key, v) => change((d) => {
                        // The section as it is now (by id: it may have moved), not as it was drawn.
                        const at2 = d.modules.findIndex((x) => x.id === m.id);
                        if (at2 < 0) return d;
                        const cur = d.modules[at2].props || {};
                        return { ...d, modules: setProps(d.modules, at2, { ...cur, [key]: typeof v === 'function' ? v(cur[key]) : v }) };
                      })} />
                    <div className="wb-sec__foot">
                      <button type="button" className="btn btn-quiet wb-tap" onClick={() => setOpenId(null)}>Done</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {picked && (
          <div className="wb-hand" role="status">
            <span>Moving <b>{picked.label}</b> — tap “Move here” on the section it should take the place of.</span>
            <button type="button" className="btn btn-quiet" onClick={() => dnd.setPicked(null)}>Cancel</button>
          </div>
        )}
        <div className="wb-ghost" ref={dnd.ghostRef} hidden={!dnd.dragging} aria-hidden="true">{dnd.dragging?.label}</div>
        <button type="button" className="btn wb-add ops-tap" onClick={() => setAdding({ at: draft.modules.length })} disabled={draft.modules.length >= 60}>
          + Add a section
        </button>
        <p className="ws-sr" aria-live="polite">{said}</p>
      </div>

      {frame && (
        <aside className="wb-frame" data-size={frameSize} aria-label="Preview of the draft">
          <div className="wb-frame__bar">
            <span className="wb-frame__h">Preview</span>
            <div className="ops-seg wb-frame__seg" role="group" aria-label="Show it as">
              <button type="button" aria-pressed={frameSize === 'phone'} onClick={() => setFrameSize('phone')}>Phone</button>
              <button type="button" aria-pressed={frameSize === 'wide'} onClick={() => setFrameSize('wide')}>Computer</button>
            </div>
          </div>
          <div className="wb-frame__box">
            <iframe key={`${frameKey}-${preview.url}`} title={`Preview of ${draft.title || 'the page'} (the draft)`} src={preview.url} />
          </div>
        </aside>
      )}

      <Catalogue open={Boolean(adding)} onClose={() => setAdding(null)} onPick={addAt} paymentsReady={paymentsReady} />
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
