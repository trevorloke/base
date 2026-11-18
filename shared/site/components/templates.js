// The four kinds of page — a page built from modules, a news post, a
// petition or pledge (/act/:slug), not found — and what goes in each one's
// <head> (title, description, canonical, Open Graph). The server renderer
// (server/ext/site/render) turns these into the HTML document.
import { Fragment } from 'react';
import { markdownText } from '../../markdown.js';
import { html } from './h.js';
import { Island } from './islands.js';
import { GoalBar, Img, Md, Module, MODULE_COMPONENTS, Paras, campaignForm } from './modules.js';
import { Announcement, Footer, Header, LanguageSwitch, PageHead, PreviewBanner, SkipLink } from './shell.js';
import { VoteBanner, EmbedView } from './voteguide.js';
import { arr, dateOnly, obj, str } from './util.js';
import { pagePath } from './links.js';
import { fontFilesFor } from '../fonts.js';

export const visibleModules = (page) => arr(obj(page).modules).filter((m) => m && typeof m === 'object' && !m.hidden && MODULE_COMPONENTS[m.kind]);

function PageView({ rc, page }) {
  const p = obj(page);
  const modules = visibleModules(p);
  // A hero is the page's title; so is a voter guide that opens the page
  // (one title, with the day that matters straight under it).
  const heroFirst = modules[0]?.kind === 'hero' || modules[0]?.kind === 'voterguide';
  const name = rc.site.site?.name || rc.site.org.name;
  const title = str(p.slug) === 'home' ? name || str(p.title) : str(p.title) || name;
  return html`<${Fragment}>
    ${heroFirst ? null : html`<${PageHead} title=${title} lede=${p.description} />`}
    ${modules.map((m, i) => html`<${Module} key=${`${m.id}-${i}`} m=${m} rc=${rc} level=${heroFirst && i === 0 ? 1 : 2} first=${i === 0} />`)}
  <//>`;
}

function PostView({ rc, post }) {
  const p = obj(post);
  return html`<${Fragment}>
    <${PageHead} title=${str(p.title)} eyebrow=${dateOnly(p.published_at, rc.timeZone, rc.locale)} lede=${p.excerpt} />
    <article className="section tone-paper post" aria-label=${str(p.title)}>
      <div className="container narrow stack stack--lg">
        <${Img} rc=${rc} image=${p.image} className="news-image" width=${1200} height=${675} sizes="min(100vw, 760px)" eager />
        <${Md} rc=${rc} text=${p.body} className="prose" />
        <${Island} name="share" props=${{ uid: 'post-share', url: rc.abs(pagePath(rc.loc)), here: pagePath(rc.loc), text: str(p.title), subject: str(p.title), label: rc.w('share.this'), ...rc.islandWords('share') }} />
        <p><a className="text-link" href=${rc.link('/news')}>${rc.w('news.allBack')}</a></p>
      </div>
    </article>
  <//>`;
}

function CampaignView({ rc, campaign }) {
  const c = obj(campaign);
  const pledge = c.kind === 'pledge';
  const live = obj(rc.data.campaigns[str(c.id)]);
  const count = c.count ?? live.count ?? obj(rc.data.counts.signatures)[str(c.id)];
  const m = { kind: 'campaign', id: 'campaign' };
  const share = { uid: 'campaign-share', url: rc.abs(pagePath(rc.loc)), here: pagePath(rc.loc), text: rc.w('act.signedShare', { title: str(c.title) }), subject: str(c.title), label: rc.w(pledge ? 'act.sharePledge' : 'act.sharePetition'), ...rc.islandWords('share') };
  return html`<${Fragment}>
    <${PageHead} title=${str(c.title)} eyebrow=${rc.w(pledge ? 'act.pledge' : 'act.petition')} lede=${c.excerpt} />
    <section className="section tone-paper campaign" id="m-campaign" data-template="campaign" aria-label=${str(c.title)}>
      <div className="container split act-split">
        <div className="stack stack--lg act-main">
          <${Md} rc=${rc} text=${c.body} className="prose" />
          ${str(c.statement).trim() ? html`<blockquote className="act-statement" lang=${rc.lang !== 'en' && c.statementLang === 'en' ? 'en' : undefined}>
            <p className="eyebrow">${rc.w(pledge ? 'act.thePledge' : 'act.thePetition')}</p>
            <${Paras} text=${c.statement} />
          </blockquote>` : null}
          <${GoalBar} count=${count} goal=${c.goal} kind=${c.kind} w=${rc.lang !== 'en' ? rc.w : null} />
          <${Island} name="share" props=${share} />
        </div>
        <div className="act-form">
          ${c.status === 'closed'
            ? html`<div className="notice" role="note"><p className="notice-title">${rc.w(pledge ? 'act.closedPledge' : 'act.closedPetition')}</p><p>${rc.w('act.thanksSigned')}</p></div>`
            : html`<${Island} name="form" props=${campaignForm(rc, m, c, { idPrefix: 'campaign' })} />`}
        </div>
      </div>
    </section>
  <//>`;
}

function NotFoundView({ rc }) {
  const places = [{ label: rc.w('page.homePage'), href: rc.loc.root }, ...rc.site.nav.items.map((l) => ({ label: l.label, href: rc.link(l.href) }))]
    .filter((p) => p.href).slice(0, 8);
  const cta = rc.site.nav.cta && rc.link(rc.site.nav.cta.href) ? { label: rc.site.nav.cta.label, href: rc.link(rc.site.nav.cta.href) } : null;
  return html`<${Fragment}>
    <${PageHead} title=${rc.w('page.notFound')} lede=${rc.w('page.notFoundLede')} />
    <section className="section tone-paper not-found" aria-labelledby="nf-title">
      <div className="container stack">
        <h2 className="h3" id="nf-title">${rc.w('page.tryThese')}</h2>
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
  // The voter guide alone, in another website's frame (VG decision 21).
  if (rc.embed && kind === 'page') return html`<${Fragment}><${SkipLink} rc=${rc} /><${EmbedView} rc=${rc} page=${page} Module=${Module} /><//>`;
  return html`<${Fragment}>
    <${SkipLink} rc=${rc} />
    <${LanguageSwitch} rc=${rc} />
    ${rc.preview ? html`<${PreviewBanner} rc=${rc} />` : null}
    <${VoteBanner} rc=${rc} />
    <${Announcement} rc=${rc} />
    <${Header} rc=${rc} />
    <main id="main" tabIndex="-1">${view}</main>
    <${Footer} rc=${rc} />
  <//>`;
}


// What goes in <head>, as data (the server writes it out, escaped).
export function headFor(rc, { kind, page, post, campaign }) {
  const { site, loc } = rc;
  // Another website of the campaign is titled by its own name.
  const siteTitle = site.site?.name || site.seo.title || site.org.name;
  let title = siteTitle;
  let description = site.seo.description;
  let image = site.seo.image;
  let type = 'website';
  if (kind === 'page') {
    const p = obj(page);
    const isHome = str(p.slug) === 'home' || loc.path === '/';
    title = isHome || !str(p.title).trim() ? siteTitle : `${str(p.title).trim()} · ${siteTitle}`;
    description = str(p.description).trim() || description;
    // The page's own share picture (Page details), else the site's
    // (seo.shareImage), else its hero's.
    const hero = visibleModules(p).find((m) => m.kind === 'hero');
    if (obj(p.image).url) image = obj(p.image);
    else if (!image.url && hero && obj(obj(hero.props).image).url) image = obj(hero.props).image;
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
    title = `${rc.w('page.notFound')} · ${siteTitle}`;
  }
  const imageUrl = rc.img(obj(image).url);
  // The body's file and the heading's (a Punjabi page: the body's and
  // Gurmukhi, in place of the heading's): two preloads at most.
  const fonts = fontFilesFor(site.theme, site.fonts, rc.lang);
  return {
    title: title || rc.w('page.website'),
    description: description.slice(0, 300),
    // A petition shown on another website counts at the main site's address.
    canonical: kind === 'notFound' || rc.preview ? ''
      : kind === 'campaign' && site.parent ? `${site.parent.url}/act/${str(obj(campaign).slug)}`
        : !loc.origin ? '' : loc.origin + pagePath(loc),
    type,
    // Open Graph wants an absolute address: a picture only when there is one.
    image: imageUrl && /^https?:\/\//.test(rc.abs(imageUrl)) ? { url: rc.abs(imageUrl), alt: str(obj(image).alt) } : null,
    siteName: site.site?.name || site.org.name || siteTitle,
    noindex: kind === 'notFound' || rc.preview || site.seo.noindex,
    themeColor: site.theme.colors.brand,
    published: kind === 'post' ? str(obj(post).published_at) : '',
    fonts: fonts.map((f) => (f.startsWith('fonts/g/') ? loc.fontAssets : loc.assets) + f),
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
