// Website → Pages (/website/pages): every page of the site, in the menu's
// order. One yellow "New page" (a title, then straight into its builder,
// WebsitePage.jsx). Each row: its title (opens it), its address, on the
// site or a draft (and whether it has changes not on the site yet), "In the
// menu", and ⋯ — Move up / Move down, View on the site, Duplicate, Delete
// (Undo brings it back: site.page.restore). Another website's pages
// (/website/sites/:siteId/pages) are this same screen with its site: its
// own pages, made with site.page.create { site_id }. The order: drag a row by its
// handle, or tap the handle and then "Move here" (keyboard: Enter on the
// handle, then Tab to "Move here"), or ⋯ → Move up / Move down.
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { useDragDrop } from '../components/useDragDrop.js';
import { MoreMenu, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { useMicrosite, useSite, useSiteRefresh } from '../components/site/useSite.js';
import { SiteBack, SiteGone } from './WebsiteSite.jsx';
import { moveModule, slugInput, slugify } from '../components/site/builder.js';
import './shifts.css';
import '../editor.css';
import './website.css';

export const addressOf = (p) => (p.slug === 'home' ? '/' : `/${p.slug}`);
export function PageStatus({ p }) {
  if (p.status !== 'published') return <span className="chip ops-chip-muted">Draft</span>;
  if (p.changed) return <span className="chip chip-warn">On the site · changes not published</span>;
  return <span className="chip chip-ok">On the site</span>;
}

function NewPageForm({ onClose, siteId, siteKey }) {
  const navigate = useNavigate();
  const refresh = useSiteRefresh();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [nav, setNav] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const auto = slugify(title);
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setError('Give the page a title'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await action('site.page.create', { title: title.trim(), slug: slug.trim() || undefined, show_in_nav: nav, ...(siteId ? { site_id: siteId } : {}) });
      await refresh(siteKey, ['site']);
      navigate(`/website/pages/${res.page.id}?new=1`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="card wb-new" onSubmit={submit} aria-label="New page">
      <div className="field">
        <label htmlFor="wb-new-title">Title</label>
        <input id="wb-new-title" className="input" required autoFocus maxLength={120} autoComplete="off"
          placeholder="Town hall" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="wb-new-slug">Address</label>
        <div className="wb-slug">
          <span className="wb-slug__root" aria-hidden="true">/</span>
          <input id="wb-new-slug" className="input" maxLength={60} autoComplete="off" spellCheck={false}
            placeholder={auto || 'town-hall'} value={slug} aria-describedby="wb-new-slug-hint"
            onChange={(e) => setSlug(slugInput(e.target.value))} />
        </div>
        <p className="wb-field__hint" id="wb-new-slug-hint">Leave it empty to use {auto ? `/${auto}` : 'one made from the title'}.</p>
      </div>
      <div className="wb-toggle">
        <input id="wb-new-nav" type="checkbox" className="wb-toggle__box" checked={nav} onChange={(e) => setNav(e.target.checked)} />
        <label htmlFor="wb-new-nav">Show it in the site’s menu (once it’s published)</label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Making it…' : 'Make the page'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

export default function WebsitePages() {
  const [params, setParams] = useSearchParams();
  const showNew = params.get('new') === '1';
  const { siteId } = useParams();
  const mainQ = useSite(!siteId);
  const siteQ = useMicrosite(siteId);
  const q = siteId ? siteQ : mainQ;
  const key = siteId ? ['microsite', siteId] : ['site'];
  const qc = useQueryClient();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const { toast, say, clear } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Another website's pages are edited only while it is there (not deleted).
  const editable = !siteId || (q.data && !q.data.deleted);
  const pages = useMemo(() => (editable ? q.data?.pages || [] : []), [q.data, editable]);
  const siteRoot = (q.data?.urls?.site || '/site/').replace(/\/$/, '');

  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    try { return await action(name, input); } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  };
  // The menu's order, at once on screen; the server's answer settles it.
  const reorder = async (next, words) => {
    qc.setQueryData(key, (d) => (d ? { ...d, pages: next } : d));
    const ok = await run('site.page.reorder', { ids: next.map((p) => p.id) });
    if (ok && words) say(words);
    await refresh(key, ['site']);
  };
  const move = (from, to) => {
    if (to < 0 || to >= pages.length || from === to) return;
    const p = pages[from];
    reorder(moveModule(pages, from, to), `Moved “${p.title}” to ${to + 1} of ${pages.length}`);
  };
  const dnd = useDragDrop({
    enabled: online && !busy,
    onDrop: (item, key) => {
      const to = pages.findIndex((p) => `page:${p.id}` === key);
      const from = pages.findIndex((p) => p.id === item.id);
      if (from >= 0 && to >= 0) move(from, to);
    },
  });
  const picked = dnd.picked;

  const setNav = async (p, on) => {
    qc.setQueryData(key, (d) => (d ? { ...d, pages: d.pages.map((x) => (x.id === p.id ? { ...x, show_in_nav: on } : x)) } : d));
    const ok = await run('site.page.save', { id: p.id, show_in_nav: on });
    if (ok) say(on ? `“${p.title}” is in the menu${p.status === 'published' ? '' : ' once it’s published'}` : `“${p.title}” is out of the menu`);
    await refresh(key, ['site']);
  };
  const duplicate = async (p) => {
    const res = await run('site.page.duplicate', { id: p.id });
    if (res) { say(`Copied — “${res.page.title}” is a draft`); await refresh(key, ['site']); }
  };
  const undoable = (p) => say(`Deleted “${p.title}”`, {
    undo: async () => {
      const back = await run('site.page.restore', { id: p.id });
      if (back) {
        say(back.page.slug === p.slug ? `“${p.title}” is back` : `“${p.title}” is back, at /${back.page.slug} (its address was taken)`);
        await refresh(key, ['site']);
      }
    },
  });
  const remove = async (p) => {
    const i = pages.findIndex((x) => x.id === p.id);
    const res = await run('site.page.delete', { id: p.id });
    if (!res) return;
    await refresh(key, ['site']);
    undoable(p);
    // Its row is gone: the next page's name takes the focus.
    setTimeout(() => {
      const names = document.querySelectorAll('.wb-row__name');
      (names[i] || names[i - 1])?.focus();
    }, 30);
  };
  // Deleted from its builder: said here, with Undo.
  const navigate = useNavigate();
  const deleted = useLocation().state?.deleted;
  useEffect(() => {
    if (!deleted) return;
    navigate('.', { replace: true, state: null });
    undoable(deleted);
  }, [deleted]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="wb-page">
      {siteId && <SiteBack d={q.data} id={siteId} />}
      <div className="ops-head">
        <h1>Pages{siteId && q.data ? <span className="ws-sr"> of {q.data.microsite.name}</span> : null}</h1>
        {!showNew && online && editable && <button type="button" className="btn btn-primary ops-tap" onClick={() => setParams({ new: '1' })}>New page</button>}
      </div>
      {siteId ? null : <WebsiteTabs />}
      {showNew && editable && <NewPageForm onClose={() => setParams({})} siteId={siteId} siteKey={key} />}

      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {siteId ? <SiteGone q={q} id={siteId} /> : q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {pages.length > 0 && (
        <>
          <p className="wb-help">The menu’s order: drag a page by its handle — or tap the handle, then “Move here”.</p>
          <ol className="wb-rows" aria-label="Pages, in the menu’s order">
            {pages.map((p, i) => {
              const isPicked = picked?.id === p.id;
              return (
                <li key={p.id} className="wb-row" data-drop-key={`page:${p.id}`} data-over={dnd.over(`page:${p.id}`)}
                  data-picked={isPicked ? '' : undefined}>
                  <button type="button" className="wb-handle" {...dnd.itemProps({ id: p.id, title: p.title })} disabled={!online || busy}
                    aria-label={isPicked ? `${p.title}: picked up — choose where it goes` : `Move ${p.title}`}>
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
                  </button>
                  <div className="wb-row__main">
                    <Link className="wb-row__name" to={`/website/pages/${p.id}`}>{p.title}</Link>
                    <span className="wb-row__sub">
                      <span className="wb-row__addr">{addressOf(p)}</span>
                      <PageStatus p={p} />
                    </span>
                  </div>
                  {picked && !isPicked ? (
                    <button type="button" className="btn wb-here" onClick={() => dnd.dropPicked(`page:${p.id}`)}>Move here</button>
                  ) : (
                    <div className="wb-row__end">
                      <span className="wb-menu-toggle">
                        <input id={`wb-nav-${p.id}`} type="checkbox" checked={p.show_in_nav} disabled={!online || busy}
                          onChange={(e) => setNav(p, e.target.checked)} />
                        <label htmlFor={`wb-nav-${p.id}`}>In the menu<span className="ws-sr">: {p.title}</span></label>
                      </span>
                      <MoreMenu label={`More for ${p.title}`} items={[
                        i > 0 && { label: 'Move up', onClick: () => move(i, i - 1), disabled: !online || busy },
                        i < pages.length - 1 && { label: 'Move down', onClick: () => move(i, i + 1), disabled: !online || busy },
                        p.status === 'published' && { label: 'View on the site', href: `${siteRoot}${addressOf(p)}`, external: true },
                        { label: 'Duplicate', onClick: () => duplicate(p), disabled: !online || busy },
                        p.slug !== 'home' && { label: 'Delete', onClick: () => remove(p), danger: true, disabled: !online || busy },
                      ]} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {picked && (
            <div className="wb-hand" role="status">
              <span>Moving <b>{picked.title}</b> — tap “Move here” on the row it should take the place of.</span>
              <button type="button" className="btn btn-quiet" onClick={() => dnd.setPicked(null)}>Cancel</button>
            </div>
          )}
          <div className="wb-ghost" ref={dnd.ghostRef} hidden={!dnd.dragging} aria-hidden="true">{dnd.dragging?.title}</div>
        </>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
