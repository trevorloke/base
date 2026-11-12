// Website → Settings (/website/settings): what every page of the site shares
// (server/ext/site/shape.js; SITE.md "Settings").
//   Menu — the links in it, in order (pages marked "In the menu" come after
//     them); the title bar's links and its button (Donate).
//   Announcement bar — a line across the top of every page.
//   Footer — the land acknowledgement, its links, its logo.
//   Organization — the name, contact details, the platform and privacy
//     links, and the authorization line election rules ask for.
//   Social accounts · Search and sharing (the title, description and picture
//     search engines and shares use) · Your own domain.
// One yellow "Save settings": the sections that changed, live at once.
import { useEffect, useMemo, useState } from 'react';
import { action } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { SaveState, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { Field, ImageField, ListField, TextField, ToggleField, UrlField } from '../components/site/Fields.jsx';
import { useSite, useSiteRefresh } from '../components/site/useSite.js';
import { isSiteLink } from '../components/site/builder.js';
import './shifts.css';
import '../editor.css';
import './website.css';
import { PLATFORM_WORD, parseSocial } from '@starbase/shared/socials';

const SECTIONS = ['nav', 'announcement', 'footer', 'org', 'social', 'seo', 'domains'];
const LINK = [{ key: 'label', type: 'text', label: 'Words', max: 60 }, { key: 'href', type: 'url', label: 'Goes to' }];
const F = {
  menu: { key: 'menu', type: 'list', label: 'Menu', max: 20, of: LINK },
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

export default function WebsiteSettings() {
  const q = useSite();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const { toast, say, clear } = useToast();
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(null);
  const [state, setState] = useState(null);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (q.data?.settings && !s) {
      const v = Object.fromEntries(SECTIONS.map((k) => [k, structuredClone(q.data.settings[k] ?? (k === 'domains' ? [] : {}))]));
      setS(v);
      setSaved(v);
    }
  }, [q.data, s]);
  useEffect(() => {
    if (s && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [s]);
  const changed = useMemo(() => (s && saved ? SECTIONS.filter((k) => !same(s[k], saved[k])) : []), [s, saved]);
  useEffect(() => {
    const warn = (e) => { if (changed.length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed.length]);
  // v: a value, or current => value (a list's Undo, applied to the list as it is then).
  const set = (sec, key, v) => setS((x) => ({ ...x, [sec]: { ...x[sec], [key]: typeof v === 'function' ? v(x[sec][key]) : v } }));
  const ctx = { pages: q.data?.pages || [], toast: (text, undo) => say(text, { undo }) };

  const save = async () => {
    setProblem(null);
    const bad = linksIn(s).find(([, href]) => !isSiteLink(String(href || '').trim()));
    if (bad) { setProblem(`${bad[0]}: a page of the site (/donate) or a full address (https://…)`); return; }
    if (s.org.email && !EMAIL.test(s.org.email.trim())) { setProblem('Organization: the email doesn’t look right'); return; }
    setState({ state: 'saving' });
    try {
      const input = Object.fromEntries(changed.map((k) => [k, s[k]]));
      await action('site.settings.save', input);
      setSaved(s);
      setState({ state: 'saved', at: Date.now() });
      say('Saved — every page of the site has it now');
      refresh(['site']);
    } catch (e) {
      setState({ state: 'error', text: e.message });
      setProblem(e.message);
    }
  };

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
        <form className="wb-settings" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <section className="card" id="menu" aria-labelledby="wb-s-menu">
            <h2 id="wb-s-menu" className="wb-card-h">Menu and title bar</h2>
            <p className="wb-field__hint">Pages marked “In the menu” (under Pages) come after these links.</p>
            <ListField id="wb-s-menu-list" f={F.menu} path="menu" value={s.nav.menu} ctx={ctx} onChange={(v) => set('nav', 'menu', v)} />
            <ListField id="wb-s-links" f={F.links} path="links" value={s.nav.links} ctx={ctx} onChange={(v) => set('nav', 'links', v)} />
            <Field f={F.cta} id="wb-s-cta" path="cta" value={s.nav.cta} ctx={ctx} onChange={(v) => set('nav', 'cta', v)} />
          </section>

          <section className="card" id="announcement" aria-labelledby="wb-s-ann">
            <h2 id="wb-s-ann" className="wb-card-h">Announcement bar</h2>
            <ToggleField id="wb-s-ann-on" label="Show a line across the top of every page" value={s.announcement.enabled}
              onChange={(v) => set('announcement', 'enabled', v)} />
            <TextField id="wb-s-ann-text" label="What it says" max={160} value={s.announcement.text} onChange={(v) => set('announcement', 'text', v)} />
            <div className="form-row">
              <TextField id="wb-s-ann-ll" label="Link words" max={40} value={s.announcement.linkLabel} onChange={(v) => set('announcement', 'linkLabel', v)} />
              <UrlField id="wb-s-ann-lh" label="Link goes to" value={s.announcement.linkHref} pages={ctx.pages} onChange={(v) => set('announcement', 'linkHref', v)} />
            </div>
          </section>

          <section className="card" id="footer" aria-labelledby="wb-s-foot">
            <h2 id="wb-s-foot" className="wb-card-h">Footer</h2>
            <TextField id="wb-s-ack" label="Land acknowledgement" max={600} multiline rows={4} value={s.footer.acknowledgement}
              hint="Shown at the foot of every page, in your own words." onChange={(v) => set('footer', 'acknowledgement', v)} />
            <ListField id="wb-s-flinks" f={F.footerLinks} path="links" value={s.footer.links} ctx={ctx} onChange={(v) => set('footer', 'links', v)} />
            <ImageField id="wb-s-flogo" label="Footer logo" value={s.footer.logo} onChange={(v) => set('footer', 'logo', v)} />
          </section>

          <section className="card" id="org" aria-labelledby="wb-s-org">
            <h2 id="wb-s-org" className="wb-card-h">Organization</h2>
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
            <UrlField id="wb-s-priv" label="Privacy policy link" value={s.org.privacyUrl} pages={ctx.pages} onChange={(v) => set('org', 'privacyUrl', v)} />
            <TextField id="wb-s-auth" label="Authorization line" max={200} value={s.org.authorizationLine}
              hint="The line election rules ask for on advertising — who authorized it. Ask your financial agent for the exact words."
              onChange={(v) => set('org', 'authorizationLine', v)} />
          </section>

          <section className="card" id="social" aria-labelledby="wb-s-soc">
            <h2 id="wb-s-soc" className="wb-card-h">Social accounts</h2>
            <ListField id="wb-s-acc" f={F.accounts} path="accounts" value={s.social.accounts} ctx={ctx} onChange={(v) => set('social', 'accounts', fillAccounts(s.social.accounts, v))} />
          </section>

          <section className="card" id="seo" aria-labelledby="wb-s-seo">
            <h2 id="wb-s-seo" className="wb-card-h">Search and sharing</h2>
            <TextField id="wb-s-seot" label="The site’s title (in search results and browser tabs)" max={80} value={s.seo.title} onChange={(v) => set('seo', 'title', v)} />
            <TextField id="wb-s-seod" label="Description (under the title in search results)" max={300} multiline value={s.seo.description} onChange={(v) => set('seo', 'description', v)} />
            <ImageField id="wb-s-share" label="Share picture" value={s.seo.shareImage}
              hint="Shown when a link to the site is shared. A page’s own share picture (Pages → Page details) comes first."
              onChange={(v) => set('seo', 'shareImage', v)} />
          </section>

          <section className="card" id="domains" aria-labelledby="wb-s-dom">
            <h2 id="wb-s-dom" className="wb-card-h">Your own domain</h2>
            <Domains value={s.domains} appHosts={q.data?.urls?.app_hosts || []} usedHosts={q.data?.urls?.used_hosts || []}
              onChange={(v) => setS((x) => ({ ...x, domains: v }))} />
          </section>

          <div className="wb-savebar">
            {problem && <p className="wb-field__err" role="alert">{problem}</p>}
            <SaveState state={state} />
            <span className="wb-savebar__what">{changed.length ? `${changed.length} ${changed.length === 1 ? 'section' : 'sections'} changed` : 'Nothing changed'}</span>
            <button type="submit" className="btn btn-primary ops-tap" disabled={!online || !changed.length || state?.state === 'saving'}>
              {state?.state === 'saving' ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}
