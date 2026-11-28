// Website → a page's builder (/website/pages/:id), WA decision 19: the page
// itself. The top bar (title in place, status, Saved, Undo / Redo, Phone /
// Computer, Preview, ⋯, Publish); a column with the sections in order (or
// the open section's form); the live preview beside it, updated as you
// type, where a tap on a headline, words or a picture opens that box. On a
// phone: the list, with Preview opening the page full screen (a tap opens
// that section's form in a sheet). The parts are in
// components/site/builder/; this file wires them.
//   Every change saves the draft by itself; what's on the site doesn't
//   change until Publish, which checks every section first (sample words
//   included) and opens the first box that needs a look.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MODULE_BY_KIND } from '@base-win/shared/site/catalogue';
import { samplePath } from '@base-win/shared/site/starters';
import { action } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { useDragDrop } from '../components/useDragDrop.js';
import { Dialog, Toast, useToast } from '../components/site/Bits.jsx';
import { useMicrosite, useSite, useSiteCampaigns, useSitePage, useSiteRefresh } from '../components/site/useSite.js';
import { addModule, duplicateModule, moveModule, problemWords, problemsOf, putBack, removeModule, sectionFromServer, setHidden, setProps, slugify } from '../components/site/builder.js';
import { useDraft } from '../components/site/builder/useDraft.js';
import { usePreviewLink, useWidth } from '../components/site/builder/usePreview.js';
import { TopBar } from '../components/site/builder/TopBar.jsx';
import { SectionList } from '../components/site/builder/SectionList.jsx';
import { SectionForm } from '../components/site/builder/SectionForm.jsx';
import { PreviewFrame } from '../components/site/builder/PreviewFrame.jsx';
import { Gallery } from '../components/site/builder/Gallery.jsx';
import { PageSettings } from '../components/site/builder/PageSettings.jsx';
import { themeColors } from '@base-win/shared/site/theme';
import { knownPictures, olderUndescribed, picturesIn } from '@base-win/shared/site/pictures';
import { addressOf } from './WebsitePages.jsx';
import './shifts.css';
import '../editor.css';
import './website.css';
import '../components/site/builder/builder.css';

export default function WebsitePage() {
  const { id } = useParams();
  return <Builder key={id} id={id} />;
}

const labelOf = (m) => MODULE_BY_KIND[m?.kind]?.label || 'the section';
const picturesNeedingWords = (m, known) => picturesIn(MODULE_BY_KIND[m.kind]?.fields || [], m.props).filter((p) => !p.alt && !p.decorative && known.has(p.url));

function Builder({ id }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const q = useSitePage(id);
  const siteQ = useSite();
  const msId = q.data?.page?.site_id || null;
  const msQ = useMicrosite(msId);
  const campsQ = useSiteCampaigns({ fresh: true });
  const { toast, say, clear } = useToast();
  const [savedN, setSavedN] = useState(0);
  const d = useDraft(id, q.data?.page && !q.isFetching ? q.data.page : null, { onSaved: () => setSavedN((n) => n + 1) });
  const { draft, base } = d;
  const width = useWidth();
  const [openId, setOpenId] = useState(null);
  const [focus, setFocus] = useState(null); // { path, n }
  const [strict, setStrict] = useState(false);
  const [serverProblem, setServerProblem] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [adding, setAdding] = useState(null); // { at } while the gallery is open
  const [settings, setSettings] = useState(false);
  const [size, setSize] = useState('phone');
  const [side, setSide] = useState(false); // 720–1099 px: the preview beside, when asked
  const [full, setFull] = useState(false); // a phone: the preview full screen
  const [sheet, setSheet] = useState(null); // a phone: a section's form over the preview
  const [said, setSaid] = useState('');
  const preview = usePreviewLink(id, Boolean(base?.id) && online);

  const campaigns = useMemo(() => campsQ.data?.campaigns || null, [campsQ.data]);
  // The pictures already on the site: one added since needs its description.
  const known = useMemo(() => knownPictures(base?.published || null), [base?.published]);
  const pages = useMemo(() => (msId ? msQ.data?.pages : siteQ.data?.pages) || null, [msId, msQ.data, siteQ.data]);
  const pagesPath = msId ? `/website/sites/${msId}/pages` : '/website/pages';
  const viewRoot = (msId ? msQ.data?.urls?.domains?.[0] || msQ.data?.urls?.site : siteQ.data?.urls?.site) || '/site/';
  const refreshSite = () => refresh(['site'], ...(msId ? [['microsite', msId]] : []));
  const colors = useMemo(() => { try { return themeColors(siteQ.data?.settings?.theme || {}); } catch { return null; } }, [siteQ.data]);

  // Open a section's form, with the cursor in one box (path) or its first.
  const openAt = useCallback((mid, path = null) => {
    setOpenId(mid);
    setFocus((f) => ({ path, n: (f?.n || 0) + 1 }));
  }, []);
  // A page made from a starter opens on its first sample box.
  useEffect(() => {
    if (!draft || params.get('start') !== '1') return;
    const m = draft.modules.find((x) => samplePath(x.kind, x.props));
    if (m) openAt(m.id, samplePath(m.kind, m.props));
    navigate('.', { replace: true });
  }, [Boolean(draft)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl+Y, everywhere in the builder.
  useEffect(() => {
    const key = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); if (d.undo()) setSaid('Undone'); } else if ((k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey)) { e.preventDefault(); if (d.redo()) setSaid('Redone'); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [d]);

  // ── Sections ──
  const at = (mid) => d.current()?.modules.findIndex((m) => m.id === mid) ?? -1;
  const mods = (fn, key) => d.change((x) => ({ ...x, modules: fn(x.modules) }), key);
  const moveTo = (from, to) => {
    const list = d.current().modules;
    if (to < 0 || to >= list.length || from === to) return;
    mods((l) => moveModule(l, from, to));
    setSaid(`Moved ${labelOf(list[from])} to ${to + 1} of ${list.length}`);
  };
  const dnd = useDragDrop({ enabled: !d.stopped(), onDrop: (item, key) => { const to = at(key.replace(/^sec:/, '')); const from = at(item.id); if (from >= 0 && to >= 0) moveTo(from, to); } });
  const addAt = (kind) => {
    const where = adding?.at ?? d.current().modules.length;
    let made = null;
    mods((l) => { const r = addModule(l, kind, where); made = r.module; return r.list; });
    setAdding(null);
    if (made) { openAt(made.id); setSaid(`Added ${MODULE_BY_KIND[kind].label} as section ${where + 1}`); }
  };
  const remove = (i) => {
    let gone = null;
    mods((l) => { const r = removeModule(l, i); gone = r.removed; return r.list; });
    if (!gone) return;
    if (openId === gone.module.id) setOpenId(null);
    const label = labelOf(gone.module);
    say(`Deleted section ${gone.index + 1} (${label})`, { undo: () => { mods((l) => putBack(l, gone)); say(`${label} is back`); } });
  };
  const setField = (mid) => (key, v) => mods((l) => {
    const i = l.findIndex((x) => x.id === mid);
    if (i < 0) return l;
    const cur = l[i].props || {};
    return setProps(l, i, { ...cur, [key]: typeof v === 'function' ? v(cur[key]) : v });
  }, typeof v === 'function' ? null : `${mid}.${key}`);

  // ── Problems: a save's (loose), a publish's (strict) and the server's ──
  const problems = useMemo(() => {
    if (!draft) return [];
    const list = strict ? problemsOf(draft.modules, { strict: true, campaigns, pages, known }) : d.looseProblems.filter((p) => draft.modules.some((m) => m.id === p.id));
    if (serverProblem?.id && !list.some((p) => p.id === serverProblem.id)) list.push(serverProblem);
    return list;
  }, [draft, strict, campaigns, pages, known, d.looseProblems, serverProblem]);
  const errorsFor = (mid) => Object.fromEntries(problems.filter((p) => p.id === mid && p.path).map((p) => [p.path, p.text]));

  // ── Publish ──
  const publish = async () => {
    setPublishing(true);
    setServerProblem(null);
    const saved = await d.flush();
    if (!saved) { setPublishing(false); setStrict(true); return; }
    const list = problemsOf(d.current().modules, { strict: true, campaigns, pages, known });
    if (list.length) { setStrict(true); openAt(list[0].id, list[0].path); setPublishing(false); return; }
    try {
      const res = await d.inTurn(() => action('site.page.publish', { id }));
      setStrict(false);
      const langs = siteQ.data?.settings?.languages?.on || [];
      const words = [...new Set(langs.map((c) => (c === 'pa' ? 'ਪੰਜਾਬੀ' : '中文')))];
      const noAuth = !String(siteQ.data?.settings?.org?.authorizationLine || '').trim();
      const href = `${viewRoot.replace(/\/$/, '')}${addressOf(res?.page || base)}`;
      // Pictures already on the site without words don't block; they're asked for.
      const older = Number(res?.undescribed) || 0;
      const describe = () => {
        const m = d.current().modules.find((x) => !x.hidden && olderUndescribed(MODULE_BY_KIND[x.kind]?.fields || [], x.props, known));
        const p = m && picturesNeedingWords(m, known)[0];
        if (m) openAt(m.id, p?.path || null);
      };
      say(`Published.${words.length ? ` ${words.join(' and ')} update in about a minute.` : ''}${older ? ` ${older === 1 ? '1 older picture has' : `${older} older pictures have`} no description.` : ''}${noAuth ? ' Your site has no ‘Authorized by’ line yet.' : ''}`, {
        links: [{ label: 'View it', href, external: true }, older && { label: 'Describe them', onClick: describe }, noAuth && { label: 'Add it', to: '/website/settings#org' }].filter(Boolean),
      });
      refreshSite();
    } catch (e) {
      const s = sectionFromServer(e.message);
      const m = s ? d.current().modules[s.index] : null;
      if (m) { setServerProblem({ index: s.index, id: m.id, kind: m.kind, label: labelOf(m), path: s.path, text: s.text }); openAt(m.id, s.path); } else setServerProblem({ text: e.message });
    } finally { setPublishing(false); }
  };
  const run = async (name, input, words) => {
    await d.flush();
    try { const r = await d.inTurn(() => action(name, input)); if (words) say(words); refreshSite(); return r; } catch (e) { say(e.message); return null; }
  };
  const changeSlug = async (slug) => {
    await d.flush();
    try {
      const res = await d.inTurn(() => action('site.page.save', { id, slug, updated_at: base.updated_at }));
      say(`The address is now ${addressOf(res.page)}`);
      refreshSite();
      return { slug: res.page.slug };
    } catch (e) { return { error: e.message }; }
  };
  // The title edited in place: a page never published takes its address
  // from it.
  const titleDone = () => {
    const t = d.current()?.title.trim();
    if (t && !base.version && base.slug !== 'home' && slugify(t) && slugify(t) !== base.slug) changeSlug(slugify(t));
  };

  if (noSignal(q)) return <div className="wb-page"><NoSignal /></div>;
  if (q.isError) return <div className="wb-page"><p className="error" role="alert">{q.error.status === 404 ? 'That page is gone — it may have been deleted.' : q.error.message}</p></div>;
  if (!draft || !base) return <div className="wb-page"><p className="muted">Loading…</p></div>;

  const live = base.status === 'published';
  const nothingNew = live && !base.changed && !d.dirty() && d.save.state === 'saved';
  const ctx = { campaigns, refreshCampaigns: () => campsQ.refetch(), pages: pages || [], colors, toast: (text, undo) => say(text, { undo }), announce: setSaid };
  const showFrame = width >= 1100 || (width >= 720 && side);
  const open = draft.modules.find((m) => m.id === openId);
  const general = (mid) => problems.find((p) => p.id === mid && !p.path)?.text;
  const form = (m, back, bare = false) => (
    <SectionForm module={m} index={draft.modules.indexOf(m)} errors={errorsFor(m.id)} general={general(m.id)} ctx={ctx} focus={focus}
      onChange={setField(m.id)} onBack={back} bare={bare} />
  );
  const pick = (mid, field) => {
    if (!draft.modules.some((m) => m.id === mid)) return;
    openAt(mid, field);
    if (full) setSheet(mid);
  };
  const frame = (isFull) => (
    <PreviewFrame url={preview.url} modules={draft.modules} size={isFull ? 'phone' : size} focusId={openId} savedN={savedN} onPick={pick}
      title={`Preview of ${draft.title || 'the page'} (the draft)`} full={isFull} onClose={() => setFull(false)} />
  );
  const strictList = strict ? problems : [];

  return (
    <div className={`wb-builder${showFrame ? ' wb-builder--frame' : ''}`}>
      <TopBar pagesPath={pagesPath} title={draft.title} onTitle={(v) => d.change((x) => ({ ...x, title: v }), 'title')} onTitleDone={titleDone}
        base={base} dirty={d.dirty()} save={d.save} onRetry={d.retry} onSite={msId ? msQ.data?.microsite?.name || 'another website' : null}
        undo={() => d.undo()} redo={() => d.redo()} canUndo={d.canUndo} canRedo={d.canRedo} size={size} onSize={setSize}
        preview={preview.url} onPreview={(e) => preview.open(e, d)} showSide={side} onSide={() => setSide((v) => !v)} onFull={() => setFull(true)}
        publishing={publishing} canPublish={online && d.save.state !== 'conflict'} nothingNew={nothingNew} onPublish={publish}
        more={[
          { label: 'Page settings', onClick: () => setSettings(true) },
          live && { label: 'View on the site', href: `${viewRoot.replace(/\/$/, '')}${addressOf(base)}`, external: true },
          { label: 'Duplicate', onClick: async () => { const r = await run('site.page.duplicate', { id }); if (r?.page) navigate(`/website/pages/${r.page.id}`); } },
          live && base.slug !== 'home' && { label: 'Take it off the site', onClick: () => run('site.page.unpublish', { id }, 'Taken off the site — it’s a draft now') },
          base.slug !== 'home' && { label: 'Delete this page', danger: true, onClick: async () => { if (await run('site.page.delete', { id })) navigate(pagesPath, { replace: true, state: { deleted: { id, title: draft.title || base.title, slug: base.slug } } }); } },
        ]} />
      {d.save.state === 'conflict' && (
        <div className="wb-alert" role="alert"><p>{d.save.text}</p><button type="button" className="btn ops-tap" onClick={() => window.location.reload()}>Reload</button></div>
      )}
      {(strictList.length > 0 || (serverProblem && !serverProblem.id)) && (
        <div className="wb-alert" role="alert" aria-labelledby="wb-before">
          <h2 id="wb-before" className="wb-alert__h">Before it goes on the site</h2>
          <ul className="wb-alert__list">
            {strictList.map((p) => <li key={`${p.id}-${p.path}`}><button type="button" className="btn-link" onClick={() => openAt(p.id, p.path)}>{problemWords(p)}</button></li>)}
            {serverProblem && !serverProblem.id && <li>{serverProblem.text}</li>}
          </ul>
        </div>
      )}
      <div className="wb-builder__body">
        <div className="wb-col">
          {open ? form(open, () => { setOpenId(null); setTimeout(() => document.querySelector(`#wb-sec-${open.id} .wb-card__open`)?.focus(), 0); }) : (
            <SectionList modules={draft.modules} problems={problems} campaigns={campaigns} dnd={dnd} locked={d.stopped()}
              onOpen={(mid) => openAt(mid)} onAdd={(i) => setAdding({ at: i })} onMove={moveTo}
              onHide={(i, h) => { mods((l) => setHidden(l, i, h)); say(h ? `${labelOf(draft.modules[i])} is hidden — it won’t show on the page` : `${labelOf(draft.modules[i])} shows on the page again`); }}
              onDuplicate={(i) => { let made = null; mods((l) => { const r = duplicateModule(l, i); made = r.module; return r.list; }); if (made) say(`Copied — the copy is section ${i + 2}`); }}
              onRemove={remove} />
          )}
        </div>
        {showFrame && <aside className="wb-side" aria-label="Preview of the draft">{frame(false)}</aside>}
      </div>
      {full && !showFrame && <div className="wb-fullpv" role="dialog" aria-label="Preview of the draft">{frame(true)}</div>}
      <Dialog open={Boolean(sheet && full)} title={labelOf(draft.modules.find((m) => m.id === sheet))} onClose={() => setSheet(null)}>
        {sheet && draft.modules.find((m) => m.id === sheet) && form(draft.modules.find((m) => m.id === sheet), () => setSheet(null), true)}
      </Dialog>
      <PageSettings open={settings} onClose={() => setSettings(false)} draft={draft} base={base} change={d.change} onSlug={changeSlug}
        languagesOn={(siteQ.data?.settings?.languages?.on || []).length > 0} />
      <Gallery open={Boolean(adding)} onClose={() => setAdding(null)} onPick={addAt} modules={draft.modules} paymentsReady={Boolean(siteQ.data?.payments?.ready)} />
      <p className="ws-sr" aria-live="polite">{said}</p>
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
