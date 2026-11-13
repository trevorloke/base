// One component for every module kind in the catalogue. Each draws its
// section — outer element <section data-module="<kind>" id="m-<id>"> — from
// the module's checked props and the loaders' data, in the look of
// imaginesurrey.ca (apps/web/src/app/page.tsx), coloured only by the theme's
// CSS variables. Text is React text (escaped); Markdown goes through
// shared/markdown.js; every link and picture through the catalogue's
// safe-url rule (util.js linkFor / imageFor).
import { createElement, Fragment } from 'react';
import { MODULE_BY_KIND, checkProps } from '../catalogue.js';
import { html, cx } from './h.js';
import { Icon, ICON_NAMES } from './icons.js';
import { Island } from './islands.js';
import { arr, dateOnly, initials, money, obj, paragraphs, str, thousands, when } from './util.js';
import { pagePath } from './links.js';
import { DONATE_DECLARATION, JOIN_DECLARATION } from '../wording.js';
import { googleLink, outlookLink, shiftEvent } from '../../ics.js';

const TONES = new Set(['paper', 'surface', 'brand', 'accent', 'ink']);
const DARK = new Set(['brand', 'ink', 'action']);
const toneOf = (t, fallback = 'paper') => (TONES.has(t) ? t : fallback);
const titleId = (m) => `m-${m.id}-title`;
// An opening's sign-up asks only these (openings.js).
const RSVP_FIELDS = ['first_name', 'email', 'phone'];

// The module's props, checked like a save (types, limits, defaults). A
// module that doesn't pass (an old draft, a hand-made page) is drawn from
// its defaults and whatever of its own props there are, each put in the
// shape its field has (text as text, lists as lists), so nothing odd can
// stop the page — and every link and picture is still checked as it is drawn.
const loose = (f, v) => {
  switch (f.type) {
    case 'link': { const o = obj(v); return { label: str(o.label), href: str(o.href) }; }
    case 'image': { const o = obj(v); return { url: str(o.url), alt: str(o.alt) }; }
    case 'toggle': return v === true || v === 'true';
    case 'number': return Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : f.min ?? 0;
    case 'words': return arr(v).map(str).filter(Boolean);
    case 'list': return arr(v).map((item) => Object.fromEntries(f.of.map((s) => [s.key, loose(s, obj(item)[s.key])])));
    default: return str(v);
  }
};
export function propsFor(m) {
  const def = MODULE_BY_KIND[m.kind];
  try {
    return checkProps(m.kind, m.props);
  } catch {
    const src = { ...JSON.parse(JSON.stringify(def?.defaults || {})), ...obj(m.props) };
    return Object.fromEntries((def?.fields || []).map((f) => [f.key, loose(f, src[f.key])]));
  }
}

export function Section({ m, tone = 'paper', className, labelled = true, children }) {
  return html`<section data-module=${m.kind} id=${`m-${m.id}`} className=${cx('section', `tone-${tone}`, DARK.has(tone) && 'on-dark', className)}
    aria-labelledby=${labelled ? titleId(m) : undefined}>${children}</section>`;
}

// A heading, or nothing when its words were left empty (no empty headings).
const blank = (c) => c == null || c === false || (typeof c === 'string' && !c.trim()) || (Array.isArray(c) && c.every(blank));
export function Heading({ level = 2, id, className = 'display', children }) {
  if (blank(children)) return null;
  return createElement(`h${Math.min(6, Math.max(1, level))}`, { id, className }, children);
}

export function Md({ rc, text, className }) {
  const t = str(text).trim();
  if (!t) return null;
  return html`<div className=${cx('md', className)} dangerouslySetInnerHTML=${{ __html: rc.markdown(t) }} />`;
}

// A paragraph field: blank lines make paragraphs.
export function Paras({ text, className }) {
  return paragraphs(text).map((t, i) => html`<p key=${i} className=${className}>${t}</p>`);
}

export function Button({ rc, link, className, children }) {
  const href = rc.link(obj(link).href);
  const label = str(obj(link).label).trim();
  if (!href || !label) return null;
  return html`<a className=${className} href=${href}>${label}${children}</a>`;
}

export function Img({ rc, image, className, width, height, eager, alt }) {
  const i = obj(image);
  const src = rc.img(i.url);
  if (!src) return null;
  const w = Number(i.width) > 0 ? Number(i.width) : width;
  const h = Number(i.height) > 0 ? Number(i.height) : height;
  return html`<img className=${className} src=${src} alt=${alt ?? str(i.alt)} width=${w} height=${h} loading=${eager ? undefined : 'lazy'} decoding="async" />`;
}

// ── The forms' wording ──
// The words a visitor ticks are the words the server keeps: the consent
// boxes' from site.consent (context.js), the declarations from
// shared/site/wording.js — never written here.
const F = {
  first: (o) => ({ name: 'first_name', label: 'First name', autoComplete: 'given-name', required: true, msg: 'Enter your first name', half: true, max: 80, ...o }),
  last: (o) => ({ name: 'last_name', label: 'Last name', autoComplete: 'family-name', required: true, msg: 'Enter your last name', half: true, max: 80, ...o }),
  email: (o) => ({ name: 'email', label: 'Email', type: 'email', inputMode: 'email', autoComplete: 'email', required: true, msg: 'Enter your email address', half: true, max: 200, ...o }),
  phone: (o) => ({ name: 'phone', label: 'Mobile number', type: 'tel', inputMode: 'tel', autoComplete: 'tel', optional: true, half: true, max: 30, ...o }),
  postal: (o) => ({ name: 'postal_code', label: 'Postal code', autoComplete: 'postal-code', required: true, msg: 'Enter your postal code', half: true, max: 7, ...o }),
  address: (o) => ({ name: 'address', label: 'Street address', autoComplete: 'street-address', required: true, msg: 'Enter your street address', max: 200, ...o }),
  city: (o) => ({ name: 'city', label: 'City', autoComplete: 'address-level2', required: true, msg: 'Enter your city', half: true, max: 80, ...o }),
  consentEmail: (rc) => ({ name: 'consent_email', type: 'check', label: rc.site.consent.email }),
  consentSms: (rc) => ({ name: 'consent_sms', type: 'check', label: rc.site.consent.sms }),
  declaration: (label) => ({ name: 'declaration', type: 'check', required: true, msg: 'Tick the box to confirm', label }),
};
const orgName = (rc) => rc.site.org.shortName || rc.site.org.name || 'the campaign';
const privacyHref = (rc) => (rc.site.org.privacy ? rc.link(rc.site.org.privacy) : null);
// Whose the data is, for the line under every form (form.js FormSmall).
const keeper = (rc) => rc.site.org.name || orgName(rc);
const privacyOf = (rc) => ({ href: privacyHref(rc), keeper: keeper(rc) });

// The island's props for a module's form: the fields, where it posts, the
// hidden ids, and — after a plain post — its thank-you or its error.
function formProps(rc, m, kind, o) {
  const names = o.fields.map((f) => f.name).filter(Boolean).concat(o.amount ? ['amount_cents'] : []);
  return {
    uid: `${m.id}-form`,
    ...o,
    // Every form: the privacy line and the main site's privacy policy.
    privacy: privacyHref(rc),
    keeper: keeper(rc),
    kind,
    action: rc.action(kind),
    hidden: rc.hidden(m.id, o.hidden),
    sent: rc.sentFor(kind, m.id),
    error: rc.errorFor(kind, m.id, names),
  };
}

function NotReady({ rc, what, verb }) {
  const email = rc.site.org.email;
  return html`<div className="notice" role="note">
    <p className="notice-title">${`Online ${what} isn’t set up yet.`}</p>
    ${email ? html`<p>${`To ${verb} now, email `}<a href=${`mailto:${email}`}>${email}</a>.</p>` : html`<p>Please check back soon.</p>`}
  </div>`;
}

// ── Text and pictures ──

function Hero({ m, p, rc, level }) {
  const words = arr(p.words).map(str).map((w) => w.trim()).filter(Boolean);
  const title = str(p.titlePrefix).trim();
  return html`<${Section} m=${m} tone="brand" className="hero" labelled=${false}>
    <div className="container hero-inner">
      <div className="hero-copy">
        ${words.length
          ? html`<${Island} name="words" props=${{ uid: `${m.id}-words`, prefix: title, words, level }} />`
          : html`<div className="hero-headline"><${Heading} level=${level} className="hero-title display">${title}<//></div>`}
        <${Paras} text=${p.text} className="hero-text" />
        <div className="btn-row">
          <${Button} rc=${rc} link=${p.primaryCta} className="btn btn--primary btn--lg" />
          ${arr(p.secondaryCtas).map((c, i) => html`<${Button} key=${i} rc=${rc} link=${c} className="btn btn--ghost btn--lg" />`)}
        </div>
      </div>
      <${Img} rc=${rc} image=${p.image} className="hero-image" width=${1600} height=${1200} eager />
    </div>
  <//>`;
}

function Text({ m, p, rc, level }) {
  const tone = toneOf(p.tone);
  const title = str(p.title).trim();
  const empty = !title && !str(p.body).trim() && !rc.link(obj(p.cta).href);
  return html`<${Section} m=${m} tone=${tone} className=${cx('text-block', empty && 'is-empty')} labelled=${Boolean(title)}>
    <div className="container narrow stack">
      ${title ? html`<${Heading} level=${level} id=${titleId(m)}>${title}<//>` : null}
      <${Md} rc=${rc} text=${p.body} className="prose" />
      ${rc.link(obj(p.cta).href) && str(obj(p.cta).label).trim() ? html`<div className="btn-row"><${Button} rc=${rc} link=${p.cta} className="btn btn--primary btn--lg" /></div>` : null}
    </div>
  <//>`;
}

function Picture({ m, p, rc }) {
  const has = Boolean(rc.img(obj(p.image).url));
  if (!has && !rc.preview) return html`<${Section} m=${m} tone="paper" className="picture is-empty" labelled=${false} />`;
  return html`<${Section} m=${m} tone="paper" className="picture" labelled=${false}>
    <figure className="container picture-figure">
      ${has
        ? html`<${Img} rc=${rc} image=${p.image} className="wide-image" width=${1600} height=${900} />`
        : html`<div className="picture-empty" role="img" aria-label="No picture chosen yet"></div>`}
      ${str(p.caption).trim() ? html`<figcaption>${p.caption}</figcaption>` : null}
    </figure>
  <//>`;
}

// YouTube and Vimeo players (privacy-friendly hosts); anything else is a link.
export function videoEmbed(url) {
  const u = str(url).trim();
  let x;
  if ((x = /^https:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{6,20})/.exec(u))
    || (x = /^https:\/\/youtu\.be\/([A-Za-z0-9_-]{6,20})/.exec(u))
    || (x = /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,20})/.exec(u))) {
    return { src: `https://www.youtube-nocookie.com/embed/${x[1]}`, provider: 'YouTube' };
  }
  if ((x = /^https:\/\/(?:www\.)?vimeo\.com\/(\d{5,12})(?:[/?#]|$)/.exec(u)) || (x = /^https:\/\/player\.vimeo\.com\/video\/(\d{5,12})/.exec(u))) {
    return { src: `https://player.vimeo.com/video/${x[1]}?dnt=1`, provider: 'Vimeo' };
  }
  return null;
}

function Video({ m, p, rc, level }) {
  const title = str(p.title).trim();
  const embed = videoEmbed(p.url);
  const href = rc.link(p.url);
  return html`<${Section} m=${m} tone="paper" className="video" labelled=${Boolean(title)}>
    <div className="container narrow stack">
      ${title ? html`<${Heading} level=${level} id=${titleId(m)}>${title}<//>` : null}
      ${embed
        ? html`<div className="video-frame"><iframe src=${embed.src} title=${title || str(p.caption).trim() || `${embed.provider} video`} loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"></iframe></div>`
        : href ? html`<p><a className="text-link" href=${href}>Watch the video</a></p>` : null}
      ${str(p.caption).trim() ? html`<p className="caption">${p.caption}</p>` : null}
    </div>
  <//>`;
}

function Columns({ m, p, rc, level }) {
  const items = arr(p.items);
  return html`<${Section} m=${m} tone="paper" className="columns">
    <div className="container stack stack--xl">
      <div className="intro">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <${Paras} text=${p.intro} className="lede" />
      </div>
      ${items.length ? html`<div className="pillars">
        ${items.map((it, i) => html`<div key=${i} className="pillar">
          <div className="pillar-head">
            <div className="pillar-icon"><${Icon} name=${ICON_NAMES.includes(it.icon) ? it.icon : 'civic'} size=${26} stroke=${2} /></div>
            <h3>${str(it.title)}</h3>
          </div>
          <p>${str(it.body)}</p>
        </div>`)}
      </div>` : null}
      ${str(p.ctaText).trim() || rc.link(obj(p.cta).href) ? html`<div className="pillars-foot">
        ${str(p.ctaText).trim() ? html`<p className="pillars-cta">${p.ctaText}</p>` : null}
        <${Button} rc=${rc} link=${p.cta} className="btn btn--outline" />
      </div>` : null}
    </div>
  <//>`;
}

function Band({ m, p, rc, level }) {
  const tone = toneOf(p.tone, 'accent');
  return html`<${Section} m=${m} tone=${tone} className="band">
    <div className="container band-inner">
      <${Heading} level=${level} id=${titleId(m)}>${p.title}${str(p.highlight).trim() ? ' ' : null}${str(p.highlight).trim() ? html`<span className="underline">${p.highlight}</span>` : null}<//>
      <${Button} rc=${rc} link=${p.cta} className="btn btn--primary btn--xl" />
    </div>
  <//>`;
}

function Faq({ m, p, rc, level }) {
  const items = arr(p.items).filter((it) => str(it?.q).trim());
  if (!items.length) return html`<${Section} m=${m} tone="paper" className="faq is-empty" labelled=${false} />`;
  return html`<${Section} m=${m} tone="paper" className="faq">
    <div className="container narrow stack">
      <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
      ${items.length ? html`<div className="faq-list">
        ${items.map((it, i) => html`<details key=${i} className="faq-item">
          <summary><span>${it.q}</span><${Icon} name="chevron" size=${20} /></summary>
          <${Md} rc=${rc} text=${it.a} className="faq-answer" />
        </details>`)}
      </div>` : null}
    </div>
  <//>`;
}

function Quote({ m, p, rc }) {
  const tone = toneOf(p.tone, 'surface');
  if (!str(p.quote).trim()) return html`<${Section} m=${m} tone=${tone} className="quote-module is-empty" labelled=${false} />`;
  return html`<${Section} m=${m} tone=${tone} className="quote-module" labelled=${false}>
    <figure className="container narrow quote">
      <blockquote><${Paras} text=${p.quote} /></blockquote>
      ${str(p.name).trim() || str(p.role).trim() ? html`<figcaption>
        <${Img} rc=${rc} image=${p.photo} className="quote-photo" width=${96} height=${96} />
        <span className="quote-who">
          ${str(p.name).trim() ? html`<span className="quote-name">${p.name}</span>` : null}
          ${str(p.role).trim() ? html`<span className="quote-role">${p.role}</span>` : null}
        </span>
      </figcaption>` : null}
    </figure>
  <//>`;
}

// ── Actions ──

function Newsletter({ m, p, rc, level }) {
  const tone = toneOf(p.tone, 'surface');
  const fields = [
    F.first({ required: false, optional: true, msg: undefined }),
    F.email(),
    ...(p.askPhone ? [F.phone(), F.consentSms(rc)] : []),
  ];
  return html`<${Section} m=${m} tone=${tone} className="newsletter">
    <div className="container">
      <div className="newsletter-bar">
        <div className="copy">
          <${Heading} level=${level} id=${titleId(m)} className="newsletter-title">${p.title}<//>
          <${Paras} text=${p.intro} className="small" />
        </div>
        <${Island} name="form" props=${formProps(rc, m, 'newsletter', {
          layout: 'inline',
          fields,
          impliedConsent: 'consent_email',
          submit: str(p.buttonLabel).trim() || 'Sign up',
          submitClass: 'btn--brand',
          // Sending this form is the yes to email: these words, as the server keeps them.
          small: rc.site.consent.newsletter,
          thanks: { title: 'You’re on the list', body: 'Thanks for signing up. Watch your inbox for the next one.' },
        })} />
      </div>
    </div>
  <//>`;
}

function membershipAmounts(rc) {
  const min = rc.data.payments.membership_min_cents || 0;
  const limit = rc.data.payments.limit_cents;
  // The minimum, then the usual amounts above it (apps/web contributions.ts), four in all.
  const usual = [1000, 2500, 5000, 10000];
  return (min ? [min, ...usual.filter((c) => c > min)] : usual).filter((c) => !limit || c <= limit).slice(0, 4);
}

function Join({ m, p, rc, level }) {
  const pay = rc.data.payments;
  const presets = membershipAmounts(rc);
  const form = pay.ready
    ? html`<${Island} name="form" props=${formProps(rc, m, 'join', {
      title: 'Join online',
      fields: [
        F.first(), F.last(), F.email(), F.phone(),
        F.address(), F.city(), F.postal(),
        { name: 'birth_date', label: 'Date of birth', type: 'date', autoComplete: 'bday', required: true, msg: 'Enter your date of birth', half: true },
        { name: 'citizenship', label: 'Citizenship', type: 'radios', required: true, msg: 'Choose one', options: [{ value: 'citizen', label: 'Canadian citizen' }, { value: 'pr', label: 'Permanent resident' }] },
        { name: 'term', label: 'How long', type: 'radios', number: true, required: true, msg: 'Choose how long', value: 1, options: [{ value: 1, label: '1 year' }, { value: 4, label: '4 years' }] },
        { type: 'amount' },
        F.declaration(JOIN_DECLARATION),
        F.consentEmail(rc), F.consentSms(rc),
      ],
      amount: { presets, monthly: false, cadence: false, limit: pay.limit_cents, defaultCents: presets[0] || null, min: pay.membership_min_cents || 100, legend: str(p.amountTitle).trim() || 'Your membership contribution', note: str(p.amountNote).trim() },
      submit: 'Join and pay',
      privacy: privacyHref(rc),
      small: 'You’ll pay on the next page by card, Apple Pay or Google Pay.',
      thanks: { title: 'Welcome aboard', body: 'Thanks for joining. Watch your inbox for a note from us.' },
    })} />`
    : html`<${NotReady} rc=${rc} what="membership" verb="join" />`;
  return html`<${Section} m=${m} tone="surface" className="join">
    <div className="container stack stack--xl">
      <${Img} rc=${rc} image=${p.photo} className="join-photo" width=${1024} height=${458} />
      <div className="split">
        <div className="stack join-copy">
          <div className="stack stack--sm">
            <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
            <${Paras} text=${p.intro} className="lede" />
          </div>
          ${arr(p.benefits).length ? html`<div className="benefits">
            ${arr(p.benefits).map((b, i) => html`<div key=${i} className="benefit">
              <div className="bar" aria-hidden="true"></div>
              <h3>${str(b.title)}</h3>
              <p>${str(b.body)}</p>
            </div>`)}
          </div>` : null}
        </div>
        <div className="join-form">${form}</div>
      </div>
    </div>
  <//>`;
}

function Donate({ m, p, rc, level }) {
  const pay = rc.data.payments;
  const limit = pay.limit_cents;
  const presets = arr(p.amounts).map((a) => Math.round(Number(str(a).replace(/[$,\s]/g, '')) * 100))
    .filter((c) => Number.isFinite(c) && c >= 100 && (!limit || c <= limit));
  const unique = [...new Set(presets)];
  const form = pay.ready
    ? html`<${Island} name="form" props=${formProps(rc, m, 'donate', {
      fields: [
        { type: 'amount' },
        { type: 'section', label: 'Your details' },
        F.first(), F.last(), F.email(), F.phone(),
        F.address(), F.city(), F.postal(),
        F.declaration(DONATE_DECLARATION),
        F.consentEmail(rc), F.consentSms(rc),
      ],
      amount: { presets: unique, monthly: p.allowMonthly === true, cadence: true, limit, monthlyMax: pay.monthly_max_cents || Math.floor(limit / 12 / 100) * 100, defaultCents: unique[Math.min(1, unique.length - 1)] ?? null, monthlyNote: str(p.monthlyNote).trim() },
      submit: 'Donate',
      privacy: privacyHref(rc),
      small: `${limit ? `The most anyone can give in a year is ${money(limit)}. ` : ''}You’ll pay on the next page by card, Apple Pay or Google Pay.`,
      thanks: { title: 'Thank you', body: 'Your gift is on its way. Watch your inbox for the receipt.' },
    })} />`
    : html`<${NotReady} rc=${rc} what="giving" verb="give" />`;
  return html`<${Section} m=${m} tone="paper" className="donate">
    <div className="container split">
      <div className="stack donate-copy">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <${Paras} text=${p.intro} className="lede" />
        <${Paras} text=${p.text} className="body" />
        <${Paras} text=${p.clubNote} className="small" />
      </div>
      <div className="donate-card">${form}</div>
    </div>
  <//>`;
}

export function GoalBar({ count, goal, kind }) {
  const g = Math.round(Number(goal) || 0);
  if (g <= 0) return null;
  const n = Math.max(0, Math.round(Number(count) || 0));
  return html`<div className="goal">
    <p className="goal-label"><strong>${thousands(n)}</strong>${` ${kind === 'pledge' ? 'have signed' : 'signatures'}`}<span className="goal-of">${` of ${thousands(g)}`}</span></p>
    <progress className="goal-bar" max=${g} value=${Math.min(n, g)} aria-label=${`${thousands(n)} of ${thousands(g)}`}></progress>
  </div>`;
}

// The petition or pledge form; also used by the campaign page.
export function campaignForm(rc, m, c, { idPrefix } = {}) {
  const pledge = c.kind === 'pledge';
  const kind = pledge ? 'pledge' : 'petition';
  const path = `/act/${str(c.slug)}`;
  const shareUrl = rc.abs(rc.link(path) || path);
  return formProps(rc, m, kind, {
    uid: `${idPrefix || m.id}-form`,
    title: pledge ? 'Sign the pledge' : 'Add your name',
    hidden: { campaign: str(c.id) },
    fields: [
      F.first(), F.last(), F.email(), F.postal(), F.phone(),
      { name: 'comment', label: pledge ? 'Why you’re signing' : 'Add a comment', type: 'textarea', optional: true, max: 1000, rows: 3 },
      F.consentEmail(rc), F.consentSms(rc),
    ],
    submit: pledge ? 'Sign the pledge' : 'Add my name',
    // Who keeps the details is the form's privacy line (wording.js
    // PRIVACY_LINE): no second sentence saying it again.
    privacy: privacyHref(rc),
    thanks: {
      title: pledge ? 'You’ve signed the pledge' : 'Your name is on the petition',
      body: 'Thank you. It counts for more when friends sign too — share it with a neighbour:',
      share: { url: shareUrl, here: pagePath(rc.loc), text: `I signed “${str(c.title)}”. Add your name:`, subject: str(c.title), label: 'Share it' },
    },
  });
}

function Petition({ m, p, rc, level }) {
  const c = obj(rc.data.campaigns[str(p.campaign)]);
  const tone = toneOf(p.tone);
  if (!c.id && !c.title) {
    return html`<${Section} m=${m} tone=${tone} className="petition" labelled=${false}>
      <div className="container"><p className="empty-state">${rc.preview ? 'Choose a petition or pledge for this module.' : 'This petition isn’t available any more.'}</p></div>
    <//>`;
  }
  const pledge = c.kind === 'pledge';
  const eyebrow = str(p.eyebrow).trim() || (pledge ? 'The pledge' : 'Petition');
  const closed = c.status === 'closed';
  return html`<${Section} m=${m} tone=${tone} className=${cx('petition', DARK.has(tone) && 'petition--dark')}>
    <div className="container">
      <div className="campaign-box">
        <div className="campaign-copy">
          <p className="eyebrow">${eyebrow}</p>
          <${Heading} level=${level} id=${titleId(m)} className="campaign-title">${str(c.title)}<//>
          ${str(c.excerpt).trim() ? html`<p className="lede">${c.excerpt}</p>` : null}
          ${str(c.statement).trim() ? html`<blockquote className="statement"><${Paras} text=${c.statement} /></blockquote>` : null}
          <${GoalBar} count=${c.count} goal=${c.goal} kind=${c.kind} />
          ${str(c.slug).trim() ? html`<a className="text-link" href=${rc.link(`/act/${c.slug}`)}>More about this ${pledge ? 'pledge' : 'petition'}</a>` : null}
        </div>
        <div className="campaign-form">
          ${closed
            ? html`<div className="notice" role="note"><p className="notice-title">${`This ${pledge ? 'pledge' : 'petition'} is closed.`}</p><p>Thank you to everyone who signed.</p></div>`
            : html`<${Island} name="form" props=${campaignForm(rc, m, c)} />`}
        </div>
      </div>
    </div>
  <//>`;
}

function Volunteer({ m, p, rc, level }) {
  const tone = toneOf(p.tone);
  const roles = arr(p.roles).map(str).filter(Boolean);
  const list = roles.length ? roles : rc.data.roles;
  return html`<${Section} m=${m} tone=${tone} className="volunteer">
    <div className="container split">
      <div className="stack volunteer-copy">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <${Paras} text=${p.intro} className="lede" />
      </div>
      <div className="volunteer-form">
        <${Island} name="form" props=${formProps(rc, m, 'volunteer', {
          fields: [
            F.first(), F.last(), F.email(), F.phone(), F.postal({ required: false, optional: true, msg: undefined }),
            ...(list.length ? [{ name: 'roles', label: 'What would you like to do?', type: 'checks', optional: true, columns: true, options: list.map((r) => ({ value: r, label: r })) }] : []),
            ...(p.askAvailability ? [{ name: 'availability', label: 'When are you free?', type: 'textarea', optional: true, max: 300, rows: 2, hint: 'For example: weekday evenings, Saturday mornings' }] : []),
            { name: 'note', label: 'Anything else we should know?', type: 'textarea', optional: true, max: 1000, rows: 3 },
            F.consentEmail(rc), F.consentSms(rc),
          ],
          submit: 'Sign me up',
          privacy: privacyHref(rc),
          thanks: { title: 'Thanks for offering to help', body: 'An organizer will be in touch within a day.' },
        })} />
      </div>
    </div>
  <//>`;
}

// Openings and events: the loaders' shifts, as the island shows them.
function openingItems(rc, list, limit) {
  return arr(list).slice(0, Math.max(1, Number(limit) || 6)).map((e) => {
    const w = when(e.starts_at, e.ends_at, rc.timeZone);
    const left = e.spots_left == null || e.spots_left === '' ? null : Math.max(0, Math.round(Number(e.spots_left) || 0));
    const lat = Number(e.lat);
    const lng = Number(e.lng);
    const map = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)
      ? `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=16/${lat.toFixed(5)}/${lng.toFixed(5)}`
      : null;
    // "Add it to your calendar" after a sign-up: the Google and Outlook
    // links, and the site's own file for this one (server/ext/site/calendar.js).
    // Never the desk's instructions or links.
    let cal = null;
    try {
      const ev = shiftEvent({ id: e.id, title: str(e.title), kind: e.kind, starts_at: e.starts_at, ends_at: e.ends_at, location: str(e.location) },
        { tz: rc.timeZone, private: false });
      cal = { google: googleLink(ev), outlook: outlookLink(ev), ics: rc.link(`/events/${String(e.id)}.ics`) };
    } catch { cal = null; }
    return {
      id: str(String(e.id)),
      starts_at: str(e.starts_at),
      ends_at: e.ends_at ? str(e.ends_at) : null,
      cal,
      title: str(e.title),
      day: w?.day || '',
      mon: w?.mon || '',
      date: w?.date || '',
      time: w?.time ? `${e.drop_in ? 'Drop in ' : ''}${w.time}` : '',
      where: str(e.location).trim(),
      map,
      full: left === 0,
      low: left !== null && left > 0 && left <= 3,
      spots: left === null || left === 0 ? '' : `${left} ${left === 1 ? 'spot' : 'spots'} left`,
    };
  }).filter((it) => it.title && it.date);
}

function Shifts({ m, p, rc, level }) {
  const items = openingItems(rc, rc.data.shifts, p.limit);
  const volunteer = rc.anchorFor('volunteer');
  return html`<${Section} m=${m} tone="paper" className="shifts">
    <div className="container stack">
      <div className="intro">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <${Paras} text=${p.intro} className="lede" />
      </div>
      ${items.length
        ? html`<${Island} name="openings" props=${{ uid: `${m.id}-openings`, variant: 'shifts', action: rc.action('rsvp'), hidden: rc.hidden(m.id), privacy: privacyOf(rc), items, sent: rc.sentFor('rsvp', m.id), sentItem: rc.sentItem(), error: rc.errorFor('rsvp', m.id, RSVP_FIELDS) }} />`
        : html`<p className="empty-state">No openings right now. ${volunteer ? html`<a href=${volunteer}>Tell us how you’d like to help</a>` : 'New ones are added every week.'}</p>`}
      ${p.showMap && items.some((it) => it.map) ? html`<p className="small">Tap a place to see it on a map.</p>` : null}
    </div>
  <//>`;
}

function Contact({ m, p, rc, level }) {
  const topics = arr(p.topics).map(str).filter(Boolean);
  const { email, phone } = rc.site.org;
  return html`<${Section} m=${m} tone="paper" className="contact">
    <div className="container split">
      <div className="stack contact-copy">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <${Paras} text=${p.intro} className="lede" />
        ${email || phone ? html`<ul className="contact-lines">
          ${email ? html`<li><${Icon} name="email" /><a href=${`mailto:${email}`}>${email}</a></li>` : null}
          ${phone ? html`<li><${Icon} name="phone" /><a href=${`tel:${phone.replace(/[^\d+]/g, '')}`}>${phone}</a></li>` : null}
        </ul>` : null}
      </div>
      <div className="contact-form">
        <${Island} name="form" props=${formProps(rc, m, 'contact', {
          fields: [
            F.first(), F.last({ required: false, optional: true, msg: undefined }), F.email(), F.phone(),
            ...(topics.length ? [{ name: 'topic', label: 'What it’s about', type: 'select', optional: true, options: topics.map((t) => ({ value: t.slice(0, 60), label: t })) }] : []),
            { name: 'message', label: 'Your message', type: 'textarea', required: true, msg: 'Write your message', max: 4000, rows: 5 },
            F.consentEmail(rc),
          ],
          submit: 'Send',
          privacy: privacyHref(rc),
          thanks: { title: 'Thanks, your message is on its way', body: 'Someone from the campaign will get back to you soon.' },
        })} />
      </div>
    </div>
  <//>`;
}

// ── Live from base.win ──

function ActNow({ m, p, rc, level }) {
  const next = openingItems(rc, rc.data.events, 2);
  const post = rc.data.posts[0];
  const { members, signatures } = rc.data.counts;
  const open = Object.values(rc.data.campaigns).filter((c) => c && typeof c === 'object' && c.status !== 'closed' && str(c.title) && str(c.slug));
  const signed = Object.values(obj(signatures)).reduce((a, n) => a + (Number(n) || 0), 0);
  const volunteer = rc.anchorFor('shifts') || rc.anchorFor('volunteer') || rc.link('/volunteer');
  const showCounts = p.showCounts !== false && (members != null || signed > 0);
  return html`<${Section} m=${m} tone="paper" className="act-rail">
    <div className="container stack">
      <div className="rail-head"><${Heading} level=${level} id=${titleId(m)} className="rail-title">${p.title}<//></div>
      <div className="rail-grid">
        <div className="stack stack--sm">
          <h3 className="rail-subtitle">Next up</h3>
          <ul className="next-list">
            ${next.map((ev) => html`<li key=${ev.id} className="next-card">
              <div className="date-badge date-badge--sm" aria-hidden="true"><span className="day">${ev.day}</span><span className="mon">${ev.mon}</span></div>
              <div className="next-info">
                <p className="eyebrow">Event</p>
                <a className="next-title" href=${rc.anchorFor('events') || volunteer}>${ev.title}</a>
                <p className="next-meta">${ev.date}, ${ev.time}${ev.where ? ` · ${ev.where}` : ''}</p>
              </div>
            </li>`)}
            <li className="next-card">
              <div className="next-icon" aria-hidden="true"><${Icon} name="hand" size=${22} /></div>
              <div className="next-info">
                <p className="eyebrow">Volunteer</p>
                <a className="next-title" href=${volunteer}>Pick a volunteer shift</a>
                <p className="next-meta">Door-knocking, phone banks and events, a few hours at a time.</p>
              </div>
            </li>
          </ul>
        </div>
        <div className="stack stack--sm">
          <h3 className="rail-subtitle">${showCounts ? 'So far' : 'Latest'}</h3>
          ${showCounts ? html`<ul className="counts">
            ${members != null ? html`<li><span className="count">${thousands(members)}</span><span className="count-label">members</span></li>` : null}
            ${signed > 0 ? html`<li><span className="count">${thousands(signed)}</span><span className="count-label">signatures</span></li>` : null}
          </ul>` : null}
          ${open.slice(0, 2).map((c) => html`<div key=${c.id} className="rail-post">
            <p className="eyebrow">${c.kind === 'pledge' ? 'Pledge' : 'Petition'}${p.showCounts !== false && Number(c.count) > 0 ? ` · ${thousands(c.count)} signed` : ''}</p>
            <a className="next-title" href=${rc.link(`/act/${str(c.slug)}`)}>${str(c.title)}</a>
          </div>`)}
          ${post ? html`<div className="rail-post">
            <p className="eyebrow">${dateOnly(post.published_at, rc.timeZone) || 'News'}</p>
            <a className="next-title" href=${rc.link(`/news/${post.slug}`)}>${post.title}</a>
          </div>` : null}
        </div>
      </div>
    </div>
  <//>`;
}

function Events({ m, p, rc, level }) {
  const items = openingItems(rc, rc.data.events, p.limit);
  const newsletter = rc.anchorFor('newsletter');
  return html`<${Section} m=${m} tone="action" className="events">
    <div className="container stack">
      <div className="section-head">
        <div className="stack stack--xs">
          <p className="eyebrow">${items.length ? 'Next event' : 'Events'}</p>
          <${Heading} level=${level} id=${titleId(m)} className="display pop-alt">${p.title}<//>
        </div>
      </div>
      ${items.length
        ? html`<${Fragment}><${Island} name="openings" props=${{ uid: `${m.id}-events`, variant: 'events', action: rc.action('rsvp'), hidden: rc.hidden(m.id), privacy: privacyOf(rc), items, sent: rc.sentFor('rsvp', m.id), sentItem: rc.sentItem(), error: rc.errorFor('rsvp', m.id, RSVP_FIELDS) }} />
          <p className="small events-ics"><a href=${rc.link('/events.ics')}>Get our events in your calendar</a></p><//>`
        : html`<div className="event-feature">
          <div className="info">
            <h3>New events are on the way</h3>
            <p className="summary">${newsletter ? 'Get the newsletter and we’ll tell you as soon as the next one is booked.' : 'Check back soon.'}</p>
          </div>
          ${newsletter ? html`<a className="btn btn--primary btn--lg" href=${newsletter}>Get the newsletter</a>` : null}
        </div>`}
    </div>
  <//>`;
}

function News({ m, p, rc, level }) {
  const posts = rc.data.posts.slice(0, Math.max(1, Number(p.limit) || 3));
  return html`<${Section} m=${m} tone="paper" className="news">
    <div className="container stack">
      <div className="section-head">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <a className="text-link" href=${rc.link('/news')}>All news</a>
      </div>
      ${posts.length ? html`<div className="card-grid">
        ${posts.map((post) => html`<article key=${post.slug} className="card">
          <${Img} rc=${rc} image=${post.image} className="news-card-image" width=${1200} height=${675} alt="" />
          <p className="eyebrow">${dateOnly(post.published_at, rc.timeZone)}</p>
          <h3 className="h3">${post.title}</h3>
          ${str(post.excerpt).trim() ? html`<p>${post.excerpt}</p>` : null}
          <a className="text-link card-link" href=${rc.link(`/news/${post.slug}`)}>Read more<span className="visually-hidden">: ${post.title}</span></a>
        </article>`)}
      </div>` : html`<p className="empty-state">News will appear here as soon as it’s published.</p>`}
    </div>
  <//>`;
}

export const PROMISE_STATUSES = [
  { value: 'kept', label: 'Kept' },
  { value: 'progress', label: 'In progress' },
  { value: 'stalled', label: 'Stalled' },
  { value: 'broken', label: 'Broken' },
  { value: 'pending', label: 'Not started' },
];
const STATUS_LABEL = Object.fromEntries(PROMISE_STATUSES.map((s) => [s.value, s.label]));

export function StatusStamp({ status }) {
  const s = STATUS_LABEL[status] ? status : 'pending';
  return html`<span className=${`status-badge status-${s}`}><${Icon} name=${s} size=${14} stroke=${2.6} />${STATUS_LABEL[s]}</span>`;
}

function Tracker({ m, p, rc, level }) {
  const items = arr(p.items).filter((it) => str(it?.title).trim());
  const counts = PROMISE_STATUSES.map((s) => ({ ...s, n: items.filter((it) => (STATUS_LABEL[it.status] ? it.status : 'pending') === s.value).length })).filter((s) => s.n);
  return html`<${Section} m=${m} tone="paper" className="tracker">
    <div className="container stack">
      <div className="intro">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <${Paras} text=${p.intro} className="lede" />
      </div>
      ${counts.length ? html`<ul className="score-legend" aria-label="Promises by status">
        ${counts.map((s) => html`<li key=${s.value}><span className="score-count">${s.n}</span><${StatusStamp} status=${s.value} /></li>`)}
      </ul>` : null}
      ${items.length ? html`<ol className="promise-list">
        ${items.map((it, i) => {
          const source = rc.link(it.source);
          const status = STATUS_LABEL[it.status] ? it.status : 'pending';
          return html`<li key=${i} className=${`promise-card status-${status}`}>
            <div className="promise-head">
              <span className="promise-number" aria-hidden="true">${i + 1}</span>
              <div className="promise-main">
                <div className="promise-meta">
                  <${StatusStamp} status=${status} />
                  ${str(it.due).trim() ? html`<span className="promise-due">Due ${it.due}</span>` : null}
                </div>
                <h3 className="promise-title">${it.title}</h3>
              </div>
            </div>
            ${str(it.note).trim() || source ? html`<details className="promise-detail">
              <summary>What happened<span className="visually-hidden">: ${it.title}</span></summary>
              <div className="promise-body">
                <${Paras} text=${it.note} />
                ${source ? html`<p><a href=${source}>Source</a></p>` : null}
              </div>
            </details>` : null}
          </li>`;
        })}
      </ol>` : html`<p className="empty-state">Promises will be listed here.</p>`}
    </div>
  <//>`;
}

// ── About the organization ──

function People({ m, p, rc, level }) {
  const seats = arr(p.seats);
  const join = rc.anchorFor('join') || rc.link('/join');
  return html`<${Section} m=${m} tone="surface" className="people">
    <div className="container stack">
      <div className="intro">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <${Paras} text=${p.intro} className="lede" />
      </div>
      ${seats.length ? html`<div className="board-grid">
        ${seats.map((seat, i) => {
          const name = str(seat.name).trim();
          const letters = name ? initials(name) : '';
          const photo = rc.img(obj(seat.photo).url);
          return html`<article key=${i} className="card card--white seat">
            ${photo
              ? html`<img className="avatar avatar--photo" src=${photo} alt=${str(obj(seat.photo).alt)} width="112" height="112" loading="lazy" decoding="async" />`
              : letters ? html`<div className="avatar" aria-hidden="true">${letters}</div>`
              : html`<div className="avatar avatar--open" aria-hidden="true"><${Icon} name="plus" size=${22} /></div>`}
            ${str(seat.role).trim() ? html`<p className="eyebrow">${seat.role}</p>` : null}
            <h3 className="h3">${name || 'Seat open'}</h3>
            ${str(seat.bio).trim() ? html`<p className="seat-bio">${seat.bio}</p>` : null}
            ${!name && join ? html`<a className="text-link" href=${join}>Put your name forward<span className="visually-hidden">: ${str(seat.role)}</span></a>` : null}
          </article>`;
        })}
      </div>` : null}
    </div>
  <//>`;
}

function Groups({ m, p, rc, level }) {
  const items = arr(p.items).filter((it) => str(it?.title).trim());
  return html`<${Section} m=${m} tone="paper" className="groups">
    <div className="container stack stack--lg">
      <div className="intro">
        <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
        <${Paras} text=${p.intro} className="lede" />
      </div>
      ${items.length ? html`<div className="features">
        ${items.map((it, i) => html`<article key=${i} className="feature">
          <div className="bar" aria-hidden="true"></div>
          <h3>${it.title}</h3>
          <${Paras} text=${it.body} />
        </article>`)}
      </div>` : null}
    </div>
  <//>`;
}

function Social({ m, p, rc, level }) {
  const own = arr(p.accounts).filter((a) => str(a?.name).trim() && rc.link(a.url));
  const accounts = own.length ? own : rc.site.social;
  if (!accounts.length) return html`<${Section} m=${m} tone="paper" className="social-follow is-empty" labelled=${false} />`;
  return html`<${Section} m=${m} tone="paper" className="social-follow">
    <div className="container stack">
      <div className="intro">
        <${Heading} level=${level} id=${titleId(m)}>Follow along<//>
        <${Paras} text=${p.intro} className="lede" />
      </div>
      ${accounts.length ? html`<div className="social-grid">
        ${accounts.map((a, i) => html`<article key=${i} className="social-card">
          <div className="head"><h3>${a.name}</h3>${str(a.handle).trim() ? html`<span className="handle">${a.handle}</span>` : null}</div>
          <a className="btn btn--outline" href=${rc.link(a.url)} rel="noopener noreferrer">${str(a.cta).trim() || `Follow on ${a.name}`}</a>
        </article>`)}
      </div>` : null}
    </div>
  <//>`;
}

export const MODULE_COMPONENTS = {
  hero: Hero,
  text: Text,
  image: Picture,
  video: Video,
  columns: Columns,
  band: Band,
  faq: Faq,
  quote: Quote,
  newsletter: Newsletter,
  join: Join,
  donate: Donate,
  petition: Petition,
  volunteer: Volunteer,
  shifts: Shifts,
  contact: Contact,
  actNow: ActNow,
  events: Events,
  news: News,
  tracker: Tracker,
  people: People,
  groups: Groups,
  social: Social,
};

// One module instance on a page. Unknown kinds draw nothing.
export function Module({ m, rc, level = 2 }) {
  const Component = MODULE_COMPONENTS[m?.kind];
  if (!Component) return null;
  const id = str(String(m.id ?? '')).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'module';
  const mod = { ...m, id };
  return html`<${Component} m=${mod} p=${propsFor(mod)} rc=${rc} level=${level} />`;
}
