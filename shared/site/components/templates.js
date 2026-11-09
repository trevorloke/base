// The four kinds of page — a page built from modules, a news post, a
// petition or pledge (/act/:slug), not found — and what goes in each one's
// <head> (title, description, canonical, Open Graph). The server renderer
// (server/ext/site/render) turns these into the HTML document.
import { Fragment } from 'react';
import { markdownText } from '../../markdown.js';
import { FONT_BY_VALUE } from '../theme.js';
import { html } from './h.js';
import { Island } from './islands.js';
import { GoalBar, Img, Md, Module, MODULE_COMPONENTS, Paras, campaignForm } from './modules.js';
import { Announcement, Footer, Header, PageHead, PreviewBanner, SkipLink } from './shell.js';
import { arr, dateOnly, obj, str } from './util.js';
import { pagePath } from './links.js';

export const visibleModules = (page) => arr(obj(page).modules).filter((m) => m && typeof m === 'object' && !m.hidden && MODULE_COMPONENTS[m.kind]);

function PageView({ rc, page }) {
  const p = obj(page);
  const modules = visibleModules(p);
  const heroFirst = modules[0]?.kind === 'hero';
  const title = str(p.slug) === 'home' ? rc.site.org.name || str(p.title) : str(p.title) || rc.site.org.name;
  return html`<${Fragment}>
    ${heroFirst ? null : html`<${PageHead} title=${title} lede=${p.description} />`}
    ${modules.map((m, i) => html`<${Module} key=${`${m.id}-${i}`} m=${m} rc=${rc} level=${heroFirst && i === 0 ? 1 : 2} />`)}
  <//>`;
}

function PostView({ rc, post }) {
  const p = obj(post);
  return html`<${Fragment}>
    <${PageHead} title=${str(p.title)} eyebrow=${dateOnly(p.published_at, rc.timeZone)} lede=${p.excerpt} />
    <article className="section tone-paper post" aria-label=${str(p.title)}>
      <div className="container narrow stack stack--lg">
        <${Img} rc=${rc} image=${p.image} className="news-image" width=${1200} height=${675} eager />
        <${Md} rc=${rc} text=${p.body} className="prose" />
        <${Island} name="share" props=${{ uid: 'post-share', url: rc.abs(pagePath(rc.loc)), here: pagePath(rc.loc), text: str(p.title), subject: str(p.title), label: 'Share this' }} />
        <p><a className="text-link" href=${rc.link('/news')}>← All news</a></p>
      </div>
    </article>
  <//>`;
}

function CampaignView({ rc, campaign }) {
  const c = obj(campaign);
  const pledge = c.kind === 'pledge';
  const what = pledge ? 'pledge' : 'petition';
  const live = obj(rc.data.campaigns[str(c.id)]);
  const count = c.count ?? live.count ?? obj(rc.data.counts.signatures)[str(c.id)];
  const m = { kind: 'campaign', id: 'campaign' };
  const share = { uid: 'campaign-share', url: rc.abs(pagePath(rc.loc)), here: pagePath(rc.loc), text: `I signed “${str(c.title)}”. Add your name:`, subject: str(c.title), label: `Share this ${what}` };
  return html`<${Fragment}>
    <${PageHead} title=${str(c.title)} eyebrow=${pledge ? 'Pledge' : 'Petition'} lede=${c.excerpt} />
    <section className="section tone-paper campaign" id="m-campaign" data-template="campaign" aria-label=${str(c.title)}>
      <div className="container split act-split">
        <div className="stack stack--lg act-main">
          <${Md} rc=${rc} text=${c.body} className="prose" />
          ${str(c.statement).trim() ? html`<blockquote className="act-statement">
            <p className="eyebrow">${pledge ? 'The pledge' : 'The petition'}</p>
            <${Paras} text=${c.statement} />
          </blockquote>` : null}
          <${GoalBar} count=${count} goal=${c.goal} kind=${c.kind} />
          <${Island} name="share" props=${share} />
        </div>
        <div className="act-form">
          ${c.status === 'closed'
            ? html`<div className="notice" role="note"><p className="notice-title">${`This ${what} is closed.`}</p><p>Thank you to everyone who signed.</p></div>`
            : html`<${Island} name="form" props=${campaignForm(rc, m, c, { idPrefix: 'campaign' })} />`}
        </div>
      </div>
    </section>
  <//>`;
}

function NotFoundView({ rc }) {
  const places = [{ label: 'Home page', href: rc.loc.root }, ...rc.site.nav.items.map((l) => ({ label: l.label, href: rc.link(l.href) }))]
    .filter((p) => p.href).slice(0, 8);
  const cta = rc.site.nav.cta && rc.link(rc.site.nav.cta.href) ? { label: rc.site.nav.cta.label, href: rc.link(rc.site.nav.cta.href) } : null;
  return html`<${Fragment}>
    <${PageHead} title="Page not found" lede="We couldn’t find that page. It may have moved, or the link may have a typo." />
    <section className="section tone-paper not-found" aria-labelledby="nf-title">
      <div className="container stack">
        <h2 className="h3" id="nf-title">Try one of these instead</h2>
        <ul className="link-list">${places.map((p, i) => html`<li key=${i}><a className="text-link" href=${p.href}>${p.label}</a></li>`)}</ul>
        ${cta ? html`<div className="btn-row"><a className="btn btn--action btn--lg" href=${cta.href}>${cta.label}</a></div>` : null}
      </div>
    </section>
  <//>`;
}

// Everything inside <body>.
export function SiteBody({ rc, kind, page, post, campaign }) {
  const view = kind === 'post' ? html`<${PostView} rc=${rc} post=${post} />`
    : kind === 'campaign' ? html`<${CampaignView} rc=${rc} campaign=${campaign} />`
    : kind === 'notFound' ? html`<${NotFoundView} rc=${rc} />`
    : html`<${PageView} rc=${rc} page=${page} />`;
  return html`<${Fragment}>
    <${SkipLink} />
    ${rc.preview ? html`<${PreviewBanner} />` : null}
    <${Announcement} rc=${rc} />
    <${Header} rc=${rc} />
    <main id="main" tabIndex="-1">${view}</main>
    <${Footer} rc=${rc} />
  <//>`;
}

// The font files a theme's heading and body faces load first (preloaded).
const FONT_FILES = {
  inter: 'fonts/inter-latin.woff2',
  montserrat: 'fonts/montserrat-latin.woff2',
  'barlow-condensed': 'fonts/barlow-condensed-800-latin.woff2',
};

// What goes in <head>, as data (the server writes it out, escaped).
export function headFor(rc, { kind, page, post, campaign }) {
  const { site, loc } = rc;
  const siteTitle = site.seo.title || site.org.name;
  let title = siteTitle;
  let description = site.seo.description;
  let image = site.seo.image;
  let type = 'website';
  if (kind === 'page') {
    const p = obj(page);
    const isHome = str(p.slug) === 'home' || loc.path === '/';
    title = isHome || !str(p.title).trim() ? siteTitle : `${str(p.title).trim()} · ${siteTitle}`;
    description = str(p.description).trim() || description;
    const hero = visibleModules(p).find((m) => m.kind === 'hero');
    if (!image.url && hero && obj(obj(hero.props).image).url) image = obj(hero.props).image;
  } else if (kind === 'post') {
    const p = obj(post);
    title = `${str(p.title)} · ${siteTitle}`;
    description = str(p.excerpt).trim() || markdownText(p.body, 200) || description;
    if (obj(p.image).url) image = obj(p.image);
    type = 'article';
  } else if (kind === 'campaign') {
    const c = obj(campaign);
    title = `${str(c.title)} · ${siteTitle}`;
    description = str(c.excerpt).trim() || markdownText(c.statement || c.body, 200) || description;
  } else {
    title = `Page not found · ${siteTitle}`;
  }
  const imageUrl = rc.img(obj(image).url);
  const fonts = [...new Set([site.theme.fonts.heading, site.theme.fonts.body].map((f) => FONT_FILES[f]).filter(Boolean))];
  return {
    title: title || 'Website',
    description: description.slice(0, 300),
    canonical: kind === 'notFound' || rc.preview || !loc.origin ? '' : loc.origin + pagePath(loc),
    type,
    image: imageUrl ? { url: rc.abs(imageUrl), alt: str(obj(image).alt) } : null,
    siteName: site.org.name || siteTitle,
    noindex: kind === 'notFound' || rc.preview || site.seo.noindex,
    themeColor: site.theme.colors.brand,
    published: kind === 'post' ? str(obj(post).published_at) : '',
    fonts: fonts.map((f) => loc.assets + f),
    fontStacks: [FONT_BY_VALUE[site.theme.fonts.heading]?.stack, FONT_BY_VALUE[site.theme.fonts.body]?.stack],
    organization: {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: site.org.name || siteTitle,
      ...(loc.origin ? { url: loc.origin + loc.root } : {}),
      ...(site.seo.description ? { description: site.seo.description } : {}),
      ...(site.org.email ? { email: site.org.email } : {}),
      ...(site.org.phone ? { telephone: site.org.phone } : {}),
      ...(site.social.length ? { sameAs: site.social.map((s) => s.url) } : {}),
    },
  };
}
