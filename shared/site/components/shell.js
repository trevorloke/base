// Around every page: the skip link, the preview banner, the announcement
// bar, the header (logo, the donate button, the Menu) and the footer (the
// land acknowledgement, links, social, the authorization line). As on
// imaginesurrey.ca (apps/web Header.tsx, Footer.tsx, AnnouncementBar.tsx).
import { html } from './h.js';
import { Island } from './islands.js';
import { Md } from './modules.js';
import { str } from './util.js';
import { isCurrent } from './links.js';

const SOCIAL_SHORT = { instagram: 'IG', facebook: 'FB', x: 'X', twitter: 'X', tiktok: 'TT', linkedin: 'IN', threads: 'TH', bluesky: 'BS', youtube: 'YT', whatsapp: 'WA', mastodon: 'MA' };
export const socialShort = (a) => str(a.short).trim().slice(0, 3) || SOCIAL_SHORT[str(a.name).toLowerCase()] || str(a.name).slice(0, 2).toUpperCase();

export function SkipLink() {
  return html`<a className="skip-link" href="#main">Skip to content</a>`;
}

export function PreviewBanner() {
  return html`<div className="preview-banner" role="note">
    <p><strong>Preview.</strong> This is a draft: only people with this link can see it, and it isn’t on the public site yet.</p>
  </div>`;
}

export function Announcement({ rc }) {
  const a = rc.site.announcement;
  if (!a.on) return null;
  const href = rc.link(a.link.href);
  const label = a.link.label;
  return html`<div className="announcement" role="region" aria-label="Announcement">
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
  return html`<header className="site-header">
    <nav className="site-nav" aria-label="Main">
      <a className="logo-link" href=${rc.loc.root} aria-current=${rc.kind === 'page' && rc.loc.path === '/' ? 'page' : undefined}>
        ${logo
          ? html`<img className="logo" src=${logo} alt=${theme.logo.alt || org.name || 'Home'} height="56" decoding="async" />`
          : html`<span className="wordmark">${org.name || 'Home'}</span>`}
      </a>
      <div className="nav-bar">
        ${bar.map((l, i) => html`<a key=${i} className="nav-link nav-bar-link" href=${l.href} aria-current=${l.current ? 'page' : undefined}>${l.label}</a>`)}
        ${cta ? html`<a className="btn btn--action nav-cta" href=${cta.href} aria-current=${cta.current ? 'page' : undefined}>${cta.label}</a>` : null}
        ${items.length || bar.length ? html`<${Island} name="menu" props=${{ uid: 'menu', items: [...bar, ...items] }} />` : null}
      </div>
    </nav>
  </header>`;
}

export function Footer({ rc }) {
  const { org, footer, social } = rc.site;
  // The footer's links, then the platform (Settings → Organization).
  const platform = org.platformUrl ? rc.link(org.platformUrl) : null;
  const links = [
    ...footer.links.map((l) => ({ label: l.label, href: rc.link(l.href) })),
    ...(platform ? [{ label: org.platformLabel || 'Read the platform', href: platform }] : []),
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
          <h2 className="footer-heading">Follow</h2>
          <ul className="socials">
            ${social.map((s, i) => html`<li key=${i}><a className="social" href=${rc.link(s.url)} rel="noopener noreferrer" aria-label=${`${org.shortName || org.name} on ${s.name}`} title=${s.name}>${socialShort(s)}</a></li>`)}
          </ul>
        </div>` : null}
        ${links.length ? html`<div className="footer-col footer-links">
          <h2 className="footer-heading">Links</h2>
          <ul>${links.map((l, i) => html`<li key=${i}><a href=${l.href}>${l.label}</a></li>`)}</ul>
        </div>` : null}
      </div>
      ${footer.acknowledgement ? html`<${Md} rc=${rc} text=${footer.acknowledgement} className="footer-acknowledgement" />` : null}
      ${footer.text ? html`<${Md} rc=${rc} text=${footer.text} className="footer-text" />` : null}
      <div className="footer-bottom">
        <p>© ${year} ${org.name}${org.authorization ? html`<span className="footer-authorization">${org.authorization}</span>` : null}</p>
        ${privacy ? html`<p className="footer-legal"><a href=${privacy}>Privacy</a></p>` : null}
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
      <h1 className="display">${title}</h1>
      ${str(lede).trim() ? html`<p className="lede">${lede}</p>` : null}
    </div>
  </section>`;
}
