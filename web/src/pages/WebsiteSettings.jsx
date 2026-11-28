// Website → Settings (/website/settings): what every page of the site shares
// (server/ext/site/shape.js; SITE.md "Settings"), as small panels (WEB 3b),
// each its heading and a line saying what is set; opened, its fields and its
// own Save (only that part is sent, live at once; Undo in the toast):
//   Menu — Your links (in order), then Pages in the menu (published pages
//     marked "In the menu", in menu order: drag, ⋯ Move up / Move down /
//     Take out of the menu).
//   Title bar — its links and its button (Donate).
//   Announcement bar — a line across the top of every page.
//   Footer — the land acknowledgement, its links, its logo.
//   Who's behind the site — who authorized the site (the financial agent
//     and how to reach them: "Authorized by …", which election rules ask
//     for), the privacy link, the name, contact details, the platform link.
//   Social accounts · Search and sharing (the title, description and picture
//     search engines and shares use) · Your own domain.
// A link here (#org, or a field's id like #wb-s-agent) opens its panel.
import { useEffect, useRef, useState } from 'react';
import { action } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { MoreMenu, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { useDragDrop } from '../components/useDragDrop.js';
import { Field, ImageField, ListField, TextField, ToggleField, UrlField } from '../components/site/Fields.jsx';
import { useSite, useSiteRefresh } from '../components/site/useSite.js';
import { isSiteLink } from '../components/site/builder.js';
import './shifts.css';
import '../editor.css';
import './website.css';
import { PLATFORM_WORD, parseSocial } from '@base-win/shared/socials';

const SECTIONS = ['nav', 'announcement', 'footer', 'org', 'social', 'seo', 'domains'];
const LINK = [{ key: 'label', type: 'text', label: 'Words', max: 60 }, { key: 'href', type: 'url', label: 'Goes to' }];
const F = {
  menu: { key: 'menu', type: 'list', label: 'Your links', max: 20, of: LINK },
  links: { key: 'links', type: 'list', label: 'Title bar links', max: 3, of: LINK },
  cta: { key: 'cta', type: 'link', label: 'The title bar’s button' },
  footerLinks: { key: 'links', type: 'list', label: 'Links', max: 12, of: LINK },
  accounts: {
    key: 'accounts', type: 'list', label: 'Accounts', max: 12, of: [
      { key: 'name', type: 'text', label: 'Network (Instagram, Facebook…)', max: 40 },
      { key: 'handle', type: 'text', label: 'Handle', max: 60 },
      { key: 'url', type: 'url', label: 'Link to the account' },
      { key: 'short', type: 'text', label: 'Short form for the icon (up to 4 letters, like IG)', max: 4 },
    ],
  },
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A typed account link fills an empty Network and Handle (shared/socials.js):
// "instagram.com/name" → Instagram, @name. What it filled follows the link
// as it is typed; anything typed into them by hand stays.
const filledFrom = (url) => {
  const r = parseSocial(url);
  if (!r.handle || r.platform === 'other') return { name: '', handle: '' };
  return { name: PLATFORM_WORD[r.platform], handle: /^https:\/\//.test(r.handle) ? '' : `@${r.handle}` };
};
const fillAccounts = (before = [], after = []) => after.map((a, i) => {
  const was = before[i];
  if (!was || was.url === a.url) return a;
  const old = filledFrom(was.url);
  const next = filledFrom(a.url);
  return {
    ...a,
    name: a.name === '' || a.name === old.name ? next.name : a.name,
    handle: a.handle === '' || a.handle === old.handle ? next.handle : a.handle,
  };
});
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const hostOf = (raw) => String(raw ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');

// Every link in what's about to be saved, with where it is: [words, href].
const linksIn = (s) => [
  ...s.nav.menu.map((l, i) => [`Menu, link ${i + 1}`, l.href]),
  ...s.nav.links.map((l, i) => [`Title bar link ${i + 1}`, l.href]),
  ['The title bar’s button', s.nav.cta.href],
  ['The announcement’s link', s.announcement.linkHref],
  ...s.footer.links.map((l, i) => [`Footer link ${i + 1}`, l.href]),
  ['The platform link', s.org.platformUrl], ['The privacy link', s.org.privacyUrl],
  ...s.social.accounts.map((a, i) => [`Social account ${i + 1}`, a.url]),
];

// appHosts: where the app itself answers (the server says: this address,
// its public one, base.win) — the server refuses them too. usedHosts: where
// people used the app, signed in ({ host, why }) — the server refuses those
// too, and why is in its own words.
function Domains({ value, onChange, appHosts = [], usedHosts = [] }) {
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState(null);
  const here = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : '';
  const isApp = (h) => h === here || h === 'base.win' || h.endsWith('.base.win') || appHosts.includes(h);
  const add = () => {
    const h = hostOf(typed);
    setErr(null);
    if (!HOST.test(h)) { setErr('A web address, like yourcampaign.ca'); return; }
    // Only the site answers on these: never the address the app itself is at,
    // nor one people use it at.
    if (isApp(h)) { setErr('That’s where base.win itself is — the app would stop answering there. Use your campaign’s own domain.'); return; }
    const used = usedHosts.find((u) => u.host === h);
    if (used) { setErr(used.why); return; }
    if (!value.includes(h)) onChange([...value, h].slice(0, 10));
    setTyped('');
  };
  return (
    <>
      {value.length > 0 && (
        <ul className="wb-chips">
          {value.map((d) => (
            <li key={d} className="wb-chip" data-app={isApp(d) ? '' : undefined}>
              {/* One saved before the server checked: the site ignores it; take it off. */}
              <span>{d}{isApp(d) && <span className="wb-chip__note"> — base.win itself, not the site: remove it</span>}</span>
              <button type="button" className="wb-chip__x" aria-label={`Remove ${d}`} onClick={() => onChange(value.filter((x) => x !== d))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="wb-words__add">
        <label htmlFor="wb-domain" className="ws-sr">Add a domain</label>
        <input id="wb-domain" className="input" value={typed} placeholder="yourcampaign.ca" spellCheck={false} autoComplete="off"
          aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'wb-domain-err' : 'wb-domain-hint'}
          onChange={(e) => { setTyped(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn wb-tap" disabled={!typed.trim() || value.length >= 10} onClick={add}>Add</button>
      </div>
      {err && <p className="wb-field__err" id="wb-domain-err">{err}</p>}
      <p className="wb-field__hint" id="wb-domain-hint">
        On these, only the website answers (at /) — no sign-in, nothing of the app. Add the domain here first — and its
        www. name too, if that will point here as well — then point its DNS at this server (your host or IT person does
        this), so the website answers there from the very first visit. The app stays at {here || 'its own address'}.
      </p>
    </>
  );
}

// The published pages marked "In the menu", in menu order: a drag handle,
// the page's title and ⋯ (Move up, Move down, Take out of the menu — Undo
// in the toast). Their order and who is in it are saved with the Menu panel.
function MenuPages({ value, onChange, toast }) {
  const moveTo = (i, j) => {
    if (j < 0 || j >= value.length || i === j) return;
    const next = [...value];
    const [x] = next.splice(i, 1);
    next.splice(j, 0, x);
    onChange(next);
  };
  const dnd = useDragDrop({ onDrop: (item, key) => { const to = Number(String(key).split(':').pop()); if (Number.isInteger(to)) moveTo(item.i, to); } });
  const out = (i) => {
    const gone = value[i];
    onChange(value.filter((_, k) => k !== i));
    toast(`${gone.title} comes out of the menu when you save`, () => onChange((cur) => [...cur.slice(0, i), gone, ...cur.slice(i)]));
  };
  return (
    <fieldset className="wb-group wb-list">
      <legend>Pages in the menu <span className="wb-list__n">· {value.length}</span></legend>
      {value.length ? (
        <ol className="wb-list__items">
          {value.map((p, i) => {
            const key = `wb-s-pages:${i}`;
            const isPicked = dnd.picked?.i === i;
            return (
              <li key={p.id} className="wb-list__item" data-drop-key={key} data-over={dnd.over(key)} data-picked={isPicked ? '' : undefined}>
                <div className="wb-list__head">
                  <button type="button" className="wb-handle" {...dnd.itemProps({ id: key, i, label: p.title })}
                    aria-label={isPicked ? `${p.title}: picked up — choose where it goes` : `Move ${p.title}`}>
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
                  </button>
                  <span className="wb-list__sum wb-list__page">{p.title}</span>
                  {dnd.picked && !isPicked ? (
                    <button type="button" className="btn wb-here" onClick={() => dnd.dropPicked(key)}>Move here</button>
                  ) : (
                    <MoreMenu label={`More for ${p.title}`} items={[
                      i > 0 && { label: 'Move up', onClick: () => moveTo(i, i - 1) },
                      i < value.length - 1 && { label: 'Move down', onClick: () => moveTo(i, i + 1) },
                      { label: 'Take out of the menu', onClick: () => out(i), danger: true },
                    ]} />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : <p className="wb-field__hint">None yet. A page goes in the menu from its details under Pages (“In the menu”).</p>}
      <div className="wb-ghost" ref={dnd.ghostRef} hidden={!dnd.dragging} aria-hidden="true">{dnd.dragging?.label}</div>
      <p className="wb-field__hint">They come after your links, once each is published.</p>
    </fieldset>
  );
}

// One small panel: its heading and a line saying what is set; opened, its
// fields and its own Save.
function Panel({ id, title, line, open, onToggle, dirty, busy, online, onSave, children }) {
  const bodyId = `${id}-body`;
  return (
    <section className="card wb-panel" id={id} data-open={open ? '' : undefined} aria-labelledby={`${id}-h`}>
      <h2 className="wb-panel__h" id={`${id}-h`}>
        <button type="button" className="wb-panel__toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="wb-panel__title">{title}</span>
          <span className="wb-panel__line">{line}</span>
        </button>
      </h2>
      <div className="wb-panel__body" id={bodyId} hidden={!open}>
        {children}
        <div className="wb-panel__acts">
          <button type="button" className="btn btn-primary ops-tap" disabled={!online || !dirty || busy} onClick={onSave}>{busy ? 'Saving…' : 'Save'}</button>
          {dirty && <span className="wb-panel__note">Not saved yet</span>}
        </div>
      </div>
    </section>
  );
}

// Which parts of the settings each panel saves: [section, keys] (keys null:
// the whole section). Two panels share the menu's section (nav): each sends
// its own keys over the section as it was saved.
const PARTS = {
  menu: ['nav', ['menu']],
  bar: ['nav', ['links', 'cta']],
  announcement: ['announcement', null],
  footer: ['footer', null],
  org: ['org', null],
  social: ['social', null],
  seo: ['seo', null],
  domains: ['domains', null],
};
const partOf = (s, panel) => {
  const [sec, keys] = PARTS[panel];
  return keys ? Object.fromEntries(keys.map((k) => [k, s[sec]?.[k]])) : s[sec];
};
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const sumLine = (s, pages, panel) => {
  switch (panel) {
    case 'menu': return `${n(s.nav.menu.length, 'link', 'links')} · ${n(pages.length, 'page', 'pages')}`;
    case 'bar': return [s.nav.cta?.label ? `Button: ${s.nav.cta.label}` : 'No button', n(s.nav.links.length, 'link', 'links')].join(' · ');
    case 'announcement': return s.announcement.enabled && s.announcement.text ? s.announcement.text : 'Off';
    case 'footer': return [s.footer.acknowledgement ? 'Land acknowledgement' : 'No land acknowledgement', n(s.footer.links.length, 'link', 'links')].join(' · ');
    case 'org': return s.org.agentName && s.org.agentContact ? `Authorized by ${s.org.agentName}` : 'No one is named on the Authorized by line yet';
    case 'social': return s.social.accounts.length ? s.social.accounts.map((a) => a.name || a.handle).filter(Boolean).join(' · ') || n(s.social.accounts.length, 'account', 'accounts') : 'None yet';
    case 'seo': return s.seo.title || 'The site’s name';
    case 'domains': return s.domains.length ? s.domains.join(' · ') : 'None yet';
    default: return '';
  }
};
// The panel a field (#wb-s-agent, from the checklist) or a section name (#org) is in.
const PANEL_OF = { menu: 'menu', nav: 'menu', announcement: 'announcement', footer: 'footer', org: 'org', social: 'social', seo: 'seo', domains: 'domains' };

export default function WebsiteSettings() {
  const q = useSite();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const { toast, say, clear } = useToast();
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(null);
  const [pages, setPages] = useState(null);
  const [savedPages, setSavedPages] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  // What is saved as it is now (an Undo runs later than the save it undoes).
  const savedRef = useRef(null);
  savedRef.current = saved;
  const savedPagesRef = useRef(null);
  savedPagesRef.current = savedPages;
  useEffect(() => {
    if (q.data?.settings && !s) {
      const v = Object.fromEntries(SECTIONS.map((k) => [k, structuredClone(q.data.settings[k] ?? (k === 'domains' ? [] : {}))]));
      setS(v);
      setSaved(v);
      const inMenu = (q.data.pages || []).filter((p) => p.show_in_nav && p.status === 'published').map((p) => ({ id: p.id, title: p.title }));
      setPages(inMenu);
      setSavedPages(inMenu);
    }
  }, [q.data, s]);
  // #org, #announcement… or a field's id: its panel opens; a field is
  // scrolled to the middle of the window and takes the cursor.
  useEffect(() => {
    if (!s) return undefined;
    const go = () => {
      const want = window.location.hash.slice(1);
      if (!want) return;
      const el = document.getElementById(want);
      const panel = PANEL_OF[want] || el?.closest?.('.wb-panel')?.id;
      if (!panel || !PARTS[panel]) return;
      setOpen((o) => (o.has(panel) ? o : new Set([...o, panel])));
      requestAnimationFrame(() => {
        const target = document.getElementById(want);
        if (!target) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
          target.scrollIntoView({ block: 'center' });
          target.focus({ preventScroll: true });
        } else target.scrollIntoView();
      });
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [Boolean(s)]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirtyOf = (panel) => Boolean(s && saved) && (!same(partOf(s, panel), partOf(saved, panel)) || (panel === 'menu' && !same(pages, savedPages)));
  const anyDirty = s && Object.keys(PARTS).some(dirtyOf);
  useEffect(() => {
    const warn = (e) => { if (anyDirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);
  // v: a value, or current => value (a list's Undo, applied to the list as it is then).
  const set = (sec, key, v) => setS((x) => ({ ...x, [sec]: { ...x[sec], [key]: typeof v === 'function' ? v(x[sec][key]) : v } }));
  const ctx = { pages: q.data?.pages || [], toast: (text, undo) => say(text, { undo }) };
  const toggle = (panel) => setOpen((o) => { const x = new Set(o); if (x.has(panel)) x.delete(panel); else x.add(panel); return x; });

  // Sends one panel's values (over the section as it was saved) and, for
  // the menu, the order of its pages and any taken out.
  const send = async (panel, values, menuPages) => {
    const [sec, keys] = PARTS[panel];
    const section = keys ? { ...savedRef.current[sec], ...values } : values;
    await action('site.settings.save', { [sec]: section });
    if (panel === 'menu' && menuPages) {
      const savedPages = savedPagesRef.current;
      const out = savedPages.filter((p) => !menuPages.some((x) => x.id === p.id));
      for (const p of out) await action('site.page.save', { id: p.id, show_in_nav: false });
      const back = menuPages.filter((p) => !savedPages.some((x) => x.id === p.id));
      for (const p of back) await action('site.page.save', { id: p.id, show_in_nav: true });
      if (menuPages.length && (!same(menuPages.map((p) => p.id), savedPages.filter((p) => menuPages.some((x) => x.id === p.id)).map((p) => p.id)) || back.length)) {
        // The menu's pages first, in their order; the rest after, as they were.
        const rest = (q.data?.pages || []).map((p) => p.id).filter((id) => !menuPages.some((x) => x.id === id));
        await action('site.page.reorder', { ids: [...menuPages.map((p) => p.id), ...rest] });
      }
    }
    return section;
  };
  const save = async (panel) => {
    setProblem(null);
    const [sec] = PARTS[panel];
    const values = partOf(s, panel);
    const draft = { ...saved, [sec]: PARTS[panel][1] ? { ...saved[sec], ...values } : values };
    const bad = linksIn(draft).find(([, href]) => !isSiteLink(String(href || '').trim()));
    if (bad && !same(partOf(draft, panel), partOf(saved, panel))) { setProblem({ panel, text: `${bad[0]}: a page of the site (/donate) or a full address (https://…)` }); return; }
    if (panel === 'org' && s.org.email && !EMAIL.test(s.org.email.trim())) { setProblem({ panel, text: 'The email doesn’t look right' }); return; }
    setBusy(panel);
    const was = partOf(saved, panel);
    const wasPages = savedPages;
    try {
      const section = await send(panel, values, panel === 'menu' ? pages : null);
      setSaved((x) => ({ ...x, [sec]: section }));
      if (panel === 'menu') setSavedPages(pages);
      // Undo: the panel as it was saved before, saved again.
      say('Saved — every page of the site has it now', {
        undo: async () => {
          try {
            const back = await send(panel, was, panel === 'menu' ? wasPages : null);
            // On screen, only this panel's own part goes back: another panel
            // sharing the section (Menu and Title bar) keeps what is typed in it.
            setS((x) => ({ ...x, [sec]: PARTS[panel][1] ? { ...x[sec], ...was } : back }));
            setSaved((x) => ({ ...x, [sec]: back }));
            if (panel === 'menu') { setPages(wasPages); setSavedPages(wasPages); }
            say('Undone');
            refresh(['site']);
          } catch (e) { setProblem({ panel, text: e.message }); }
        },
      });
      refresh(['site']);
    } catch (e) {
      setProblem({ panel, text: e.message });
    } finally {
      setBusy(null);
    }
  };
  const panel = (key, id, title, body) => (
    <Panel key={key} id={id} title={title} line={sumLine(s, pages || [], key)} open={open.has(key)} onToggle={() => toggle(key)}
      dirty={dirtyOf(key)} busy={busy === key} online={online} onSave={() => save(key)}>
      {body}
      {problem?.panel === key && <p className="wb-field__err" role="alert">{problem.text}</p>}
    </Panel>
  );

  return (
    <div className="wb-page">
      <div className="ops-head">
        <h1>Website settings</h1>
      </div>
      <WebsiteTabs />
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {s && (
        <div className="wb-settings">
          <p className="wb-help">What every page of the site shares. Open a panel to change it; each one saves on its own.</p>
          {panel('menu', 'menu', 'Menu', <>
            <ListField id="wb-s-menu-list" f={F.menu} path="menu" value={s.nav.menu} ctx={ctx} onChange={(v) => set('nav', 'menu', v)} />
            <MenuPages value={pages} onChange={(v) => setPages((cur) => (typeof v === 'function' ? v(cur) : v))} toast={ctx.toast} />
          </>)}
          {panel('bar', 'bar', 'Title bar', <>
            <ListField id="wb-s-links" f={F.links} path="links" value={s.nav.links} ctx={ctx} onChange={(v) => set('nav', 'links', v)} />
            <Field f={F.cta} id="wb-s-cta" path="cta" value={s.nav.cta} ctx={ctx} onChange={(v) => set('nav', 'cta', v)} />
          </>)}
          {panel('announcement', 'announcement', 'Announcement bar', <>
            <ToggleField id="wb-s-ann-on" label="Show a line across the top of every page" value={s.announcement.enabled}
              onChange={(v) => set('announcement', 'enabled', v)} />
            <TextField id="wb-s-ann-text" label="What it says" max={160} value={s.announcement.text} onChange={(v) => set('announcement', 'text', v)} />
            <div className="form-row">
              <TextField id="wb-s-ann-ll" label="Link words" max={40} value={s.announcement.linkLabel} onChange={(v) => set('announcement', 'linkLabel', v)} />
              <UrlField id="wb-s-ann-lh" label="Link goes to" value={s.announcement.linkHref} pages={ctx.pages} onChange={(v) => set('announcement', 'linkHref', v)} />
            </div>
          </>)}
          {panel('footer', 'footer', 'Footer', <>
            <TextField id="wb-s-ack" label="Land acknowledgement" max={600} multiline rows={4} value={s.footer.acknowledgement}
              hint="Shown at the foot of every page, in your own words." onChange={(v) => set('footer', 'acknowledgement', v)} />
            <ListField id="wb-s-flinks" f={F.footerLinks} path="links" value={s.footer.links} ctx={ctx} onChange={(v) => set('footer', 'links', v)} />
            <ImageField plain id="wb-s-flogo" label="Footer logo" value={s.footer.logo} onChange={(v) => set('footer', 'logo', v)} />
          </>)}
          {panel('org', 'org', 'Who’s behind the site', <>
            <p className="wb-field__hint">Election rules ask every page to say who authorized it: “Authorized by” your financial agent, and how to reach them.</p>
            {/* "Authorized by <name>, <contact>" on every page of every website
                (shared/site/wording.js authorizedBy); the old free line stays
                saved, drawn only while no agent is named. */}
            <div className="form-row">
              <TextField id="wb-s-agent" label="Authorized by (your financial agent’s name)" max={80} value={s.org.agentName || ''}
                onChange={(v) => set('org', 'agentName', v)} />
              <TextField id="wb-s-agentc" label="How to reach them (a B.C. phone number, mailing address or email)" max={120} value={s.org.agentContact || ''}
                onChange={(v) => set('org', 'agentContact', v)} />
            </div>
            <UrlField id="wb-s-priv" label="Privacy policy link" value={s.org.privacyUrl} pages={ctx.pages} onChange={(v) => set('org', 'privacyUrl', v)} />
            <div className="form-row">
              <TextField id="wb-s-name" label="Name" max={80} value={s.org.name} onChange={(v) => set('org', 'name', v)} />
              <TextField id="wb-s-short" label="Short name" max={40} value={s.org.shortName}
                hint="Used in the consent boxes: “Yes, <short name> can email me…”" onChange={(v) => set('org', 'shortName', v)} />
            </div>
            <div className="form-row">
              <TextField id="wb-s-email" label="Email" max={320} value={s.org.email} onChange={(v) => set('org', 'email', v)} />
              <TextField id="wb-s-phone" label="Phone" max={40} value={s.org.phone} onChange={(v) => set('org', 'phone', v)} />
            </div>
            <TextField id="wb-s-addr" label="Mailing address" max={200} value={s.org.address} onChange={(v) => set('org', 'address', v)} />
            <div className="form-row">
              <UrlField id="wb-s-plat" label="Platform link" value={s.org.platformUrl} pages={ctx.pages} onChange={(v) => set('org', 'platformUrl', v)} />
              <TextField id="wb-s-platl" label="Platform link words" max={80} value={s.org.platformLabel} onChange={(v) => set('org', 'platformLabel', v)} />
            </div>
          </>)}
          {panel('social', 'social', 'Social accounts', (
            <ListField id="wb-s-acc" f={F.accounts} path="accounts" value={s.social.accounts} ctx={ctx} onChange={(v) => set('social', 'accounts', (cur) => fillAccounts(cur, typeof v === 'function' ? v(cur) : v))} />
          ))}
          {panel('seo', 'seo', 'Search and sharing', <>
            <TextField id="wb-s-seot" label="The site’s title (in search results and browser tabs)" max={80} value={s.seo.title} onChange={(v) => set('seo', 'title', v)} />
            <TextField id="wb-s-seod" label="Description (under the title in search results)" max={300} multiline value={s.seo.description} onChange={(v) => set('seo', 'description', v)} />
            <ImageField plain id="wb-s-share" label="Share picture" value={s.seo.shareImage}
              hint="Shown when a link to the site is shared. A page’s own share picture (Pages → Page details) comes first."
              onChange={(v) => set('seo', 'shareImage', v)} />
          </>)}
          {panel('domains', 'domains', 'Your own domain', (
            <Domains value={s.domains} appHosts={q.data?.urls?.app_hosts || []} usedHosts={q.data?.urls?.used_hosts || []}
              onChange={(v) => setS((x) => ({ ...x, domains: v }))} />
          ))}
        </div>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
