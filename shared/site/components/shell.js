// Around every page: the skip link, the preview banner, the announcement
// bar, the header (logo, the donate button, the Menu) and the footer (the
// land acknowledgement, links, social, the authorization line — on another
// website of the campaign, only the bottom lines and "A website by …"). As on
// imaginesurrey.ca (apps/web Header.tsx, Footer.tsx, AnnouncementBar.tsx).
import { html } from './h.js';
import { Island } from './islands.js';
import { Md } from './modules.js';
import { str } from './util.js';
import { isCurrent } from './links.js';
import { enLang } from './lang.js';
import { labelFor } from '../languages.js';

// A fixed word with a piece drawn in its place ("A website by {name}"):
// the words before and after the slot.
export const around = (rc, key, slot) => {
  const w = rc.w(key, { [slot]: '\u0000' });
  const at = w.indexOf('\u0000');
  return at < 0 ? [w, ''] : [w.slice(0, at), w.slice(at + 1)];
};

const SOCIAL_SHORT = { instagram: 'IG', facebook: 'FB', x: 'X', twitter: 'X', tiktok: 'TT', linkedin: 'IN', threads: 'TH', bluesky: 'BS', youtube: 'YT', whatsapp: 'WA', mastodon: 'MA' };
export const socialShort = (a) => str(a.short).trim().slice(0, 3) || SOCIAL_SHORT[str(a.name).toLowerCase()] || str(a.name).slice(0, 2).toUpperCase();

export function SkipLink({ rc }) {
  return html`<a className="skip-link" href="#main">${rc ? rc.w('shell.skip') : 'Skip to content'}</a>`;
}

export function PreviewBanner({ rc }) {
  return html`<div className="preview-banner" role="note">
    <p><strong>${rc ? rc.w('shell.previewTitle') : 'Preview.'}</strong>${` ${rc ? rc.w('shell.preview') : 'This is a draft: only people with this link can see it, and it isn’t on the public site yet.'}`}</p>
  </div>`;
}

// The language switch (TR decision 32): English · ਪੰਜਾਬੀ · 简体 · 繁體,
// each label in its own script, each link the same page in that language.
// Drawn only when a language besides English is offered; no JavaScript.
// English carries ?lang=en (it clears the remembered language); the note
// under it on a translated page says the English is the official version.
const GLOBE = html`<svg className="lang-globe" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z" /></svg>`;
export function LanguageSwitch({ rc }) {
  const offered = rc.langs.offered;
  if (!offered.length) return null;
  const roots = rc.langs.roots;
  const path = rc.loc.path || '/';
  const at = (code) => `${roots[code] ?? ''}${path}`;
  const codes = ['en', ...offered];
  const current = rc.lang;
  return html`<div className="lang-bar">
    <div className="lang-bar-inner">
      ${GLOBE}
      <nav className="lang-switch" aria-label="Language · ਭਾਸ਼ਾ · 语言 · 語言">
        ${codes.map((code) => html`<a key=${code} href=${code === 'en' ? `${at('en')}?lang=en` : at(code)} hrefLang=${code} lang=${code}
          aria-current=${code === current ? 'true' : undefined}>${labelFor(code, offered)}</a>`)}
      </nav>
    </div>
    ${current !== 'en' ? (() => {
      const note = rc.legal('translatedNote');
      const read = rc.legal('readInEnglish');
      // The home page sends a remembered visitor back to their language
      // unless the address has a query: this link carries one, and unlike
      // ?lang=en it keeps the language remembered.
      const en = path === '/' ? `${at('en')}?en=1` : at('en');
      return html`<p className="lang-note"><span lang=${note.lang}>${note.text}</span> <a href=${en} hrefLang="en" lang=${read.lang}>${read.text}</a></p>`;
    })() : null}
    ${rc.policyEnglish ? (() => {
      // A privacy policy not checked yet in this language is shown in
      // English: said as the bar's own second line, not loose under it.
      const l = rc.legal('policyInEnglish');
      return html`<p className="lang-note lang-note--policy" lang=${l.lang}>${l.text}</p>`;
    })() : null}
  </div>`;
}

export function Announcement({ rc }) {
  const a = rc.site.announcement;
  if (!a.on) return null;
  const href = rc.link(a.link.href);
  const label = a.link.label;
  return html`<div className="announcement" role="region" aria-label=${rc.w('shell.announcement')}>
    <div className="announcement-inner">
      <p className="announcement-text">${a.text}${href && label ? ' ' : null}${href && label ? html`<a className="announcement-link" href=${href}>${label}</a>` : null}</p>
    </div>
  </div>`;
}

export function Header({ rc }) {
  const { org, theme, nav } = rc.site;
  const logo = rc.img(theme.logo.url);
  const here = (href) => isCurrent(rc.loc, href);
  const bar = nav.bar.map((l) => ({ label: l.label, href: rc.link(l.href), current: here(l.href), bar: true })).filter((l) => l.href);
  const items = nav.items.map((l) => ({ label: l.label, href: rc.link(l.href), current: here(l.href) })).filter((l) => l.href);
  const cta = nav.cta && rc.link(nav.cta.href) ? { label: nav.cta.label, href: rc.link(nav.cta.href), current: here(nav.cta.href) } : null;
  // Another website of the campaign shows its own name; the main one, the organization's.
  const name = rc.site.site?.name || org.name;
  return html`<header className="site-header">
    <nav className="site-nav" aria-label=${rc.w('shell.mainNav')}>
      <a className="logo-link" href=${rc.loc.root} aria-current=${rc.kind === 'page' && rc.loc.path === '/' ? 'page' : undefined}>
        ${logo
          ? html`<img className="logo" src=${logo} alt=${theme.logo.alt || name || rc.w('shell.home')} height="56" decoding="async" />`
          : html`<span className="wordmark">${name || rc.w('shell.home')}</span>`}
      </a>
      <div className="nav-bar">
        ${bar.map((l, i) => html`<a key=${i} className="nav-link nav-bar-link" href=${l.href} aria-current=${l.current ? 'page' : undefined}>${l.label}</a>`)}
        ${cta ? html`<a className="btn btn--action nav-cta" href=${cta.href} aria-current=${cta.current ? 'page' : undefined}>${cta.label}</a>` : null}
        ${items.length || bar.length ? html`<${Island} name="menu" props=${{ uid: 'menu', items: [...bar, ...items], ...(rc.lang !== 'en' ? { label: rc.w('menu.label') } : {}) }} />` : null}
      </div>
    </nav>
  </header>`;
}

export function Footer({ rc }) {
  const { org, footer, social, parent } = rc.site;
  // The footer's links, then the platform (Settings → Organization) — on
  // the main site; another website of the campaign has none of its own.
  const platform = org.platformUrl && !parent ? rc.link(org.platformUrl) : null;
  const links = [
    ...(parent ? [] : footer.links.map((l) => ({ label: l.label, href: rc.link(l.href) }))),
    ...(platform ? [{ label: org.platformLabel || rc.w('shell.platform'), href: platform }] : []),
  ].filter((l) => l.href);
  const privacy = org.privacy ? rc.link(org.privacy) : null;
  // The footer's own logo (a light one, for the dark footer), else the name.
  const logo = rc.img(footer.logo.url);
  const year = new Date().getFullYear();
  return html`<footer className="site-footer">
    <div className="container stack stack--lg">
      <div className="footer-top">
        <div className="footer-brand">
          ${logo
            ? html`<img className="footer-logo" src=${logo} alt=${footer.logo.alt || org.name || ''} height="88" decoding="async" loading="lazy" />`
            : org.name ? html`<p className="footer-name">${org.name}</p>` : null}
          ${org.address ? html`<p className="footer-address">${org.address}</p>` : null}
          ${org.email ? html`<a className="footer-contact" href=${`mailto:${org.email}`}>${org.email}</a>` : null}
          ${org.phone ? html`<a className="footer-contact" href=${`tel:${org.phone.replace(/[^\d+]/g, '')}`}>${org.phone}</a>` : null}
        </div>
        ${social.length ? html`<div className="footer-col">
          <h2 className="footer-heading">${rc.w('shell.follow')}</h2>
          <ul className="socials">
            ${social.map((s, i) => html`<li key=${i}><a className="social" href=${rc.link(s.url)} rel="noopener noreferrer" aria-label=${rc.w('shell.on', { org: org.shortName || org.name, network: s.name })} title=${s.name}>${socialShort(s)}</a></li>`)}
          </ul>
        </div>` : null}
        ${links.length ? html`<div className="footer-col footer-links">
          <h2 className="footer-heading">${rc.w('shell.links')}</h2>
          <ul>${links.map((l, i) => html`<li key=${i}><a href=${l.href}>${l.label}</a></li>`)}</ul>
        </div>` : null}
      </div>
      ${footer.acknowledgement && !parent ? html`<${Md} rc=${rc} text=${footer.acknowledgement} className="footer-acknowledgement" />` : null}
      ${footer.text && !parent ? html`<${Md} rc=${rc} text=${footer.text} className="footer-text" />` : null}
      <div className="footer-bottom">
        ${rc.lang === 'en'
          ? html`<p>© ${year} ${org.name}${org.authorization ? html`<span className="footer-authorization">${org.authorization}</span>` : null}</p>`
          : html`<p>© ${year} ${org.name}</p>`}
        ${rc.lang !== 'en' && org.authorization ? html`<p className="footer-authorization" lang="en">${org.authorization}</p>` : null}
        ${rc.lang !== 'en' ? (() => {
          // The line again in the page's language, as a manager approved it
          // (B.C.'s rule for advertising in another language). One element
          // per slot: an array here would need keys.
          const a = rc.legal('authorizedBy');
          return a.lang !== 'en' ? html`<p className="footer-authorization" lang=${a.lang}>${a.text}</p>` : null;
        })() : null}
        ${privacy ? html`<p className="footer-legal"><a href=${privacy}>${rc.w('shell.privacy')}</a></p>` : null}
        ${parent ? (() => { const [before, after] = around(rc, 'shell.websiteBy', 'name'); return html`<p className="footer-parent">${before}<a href=${parent.url}>${parent.name}</a>${after}</p>`; })() : null}
      </div>
    </div>
  </footer>`;
}

// The banner at the top of a page that isn't built from modules (news,
// a petition, not found) — and of a page whose first module isn't a hero.
export function PageHead({ title, eyebrow, lede }) {
  return html`<section className="section tone-brand on-dark page-head">
    <div className="container stack stack--sm">
      ${str(eyebrow).trim() ? html`<p className="eyebrow eyebrow--accent">${eyebrow}</p>` : null}
      <h1 className="display" lang=${enLang(title)}>${title}</h1>
      ${str(lede).trim() ? html`<p className="lede" lang=${enLang(lede)}>${lede}</p>` : null}
    </div>
  </section>`;
}
