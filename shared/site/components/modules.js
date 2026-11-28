// One component for every module kind in the catalogue. Each draws its
// section — outer element <section data-module="<kind>" id="m-<id>"> — from
// the module's checked props and the loaders' data, coloured only by the
// theme's CSS variables. Text is React text (escaped); Markdown goes through
// shared/markdown.js; every link and picture through the catalogue's
// safe-url rule (util.js linkFor / imageFor).
import { createElement, Fragment } from 'react';
import { MODULE_BY_KIND, checkProps, defaultsFor } from '../catalogue.js';
import { html, cx } from './h.js';
import { Icon, ICON_NAMES } from './icons.js';
import { Island } from './islands.js';
import { arr, dateOnly, initials, money, obj, paragraphs, str, thousands, when } from './util.js';
import { pagePath } from './links.js';
import { DONATE_DECLARATION, JOIN_DECLARATION } from '../wording.js';
import { LANG_BY_CODE } from '../languages.js';
import { heroSegments, bandSegment, splitMark } from '../segments.js';
import { enLang } from './lang.js';
import { googleLink, outlookLink, shiftEvent } from '../../ics.js';
import { VoterGuide } from './voteguide.js';

// A supporter's share words, with "Authorized by …" on its own line under
// them when it is filled in (shared/site/authorized.js): in English, then
// the approved words in the page's language.
export const signedShare = (rc, words) => {
  const a = rc.authorizedLine({ channel: 'share-sheet' });
  return a.include ? [words, a.en, a.local?.text].filter(Boolean).join('\n') : words;
};

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
    const src = { ...(def ? defaultsFor(m.kind) : {}), ...obj(m.props) };
    return Object.fromEntries((def?.fields || []).map((f) => [f.key, loose(f, src[f.key])]));
  }
}

export function Section({ m, tone = 'paper', className, labelled = true, children }) {
  return html`<section data-module=${m.kind} id=${`m-${m.id}`} className=${cx('section', `tone-${tone}`, DARK.has(tone) && 'on-dark', className)}
    aria-labelledby=${labelled ? titleId(m) : undefined}>${children}</section>`;
}

// A heading, or nothing when its words were left empty (no empty headings).
const blank = (c) => c == null || c === false || (typeof c === 'string' && !c.trim()) || (Array.isArray(c) && c.every(blank));
export function Heading({ level = 2, id, className = 'display', lang, children }) {
  if (blank(children)) return null;
  return createElement(`h${Math.min(6, Math.max(1, level))}`, { id, className, lang: lang || enLang(children) }, children);
}

export function Md({ rc, text, className }) {
  const t = str(text).trim();
  if (!t) return null;
  return html`<div className=${cx('md', className)} dangerouslySetInnerHTML=${{ __html: rc.markdown(t) }} />`;
}

// A paragraph field: blank lines make paragraphs.
export function Paras({ text, className }) {
  return paragraphs(text).map((t, i) => html`<p key=${i} className=${className} lang=${enLang(t)}>${t}</p>`);
}

export function Button({ rc, link, className, children }) {
  const href = rc.link(obj(link).href);
  const label = str(obj(link).label).trim();
  if (!href || !label) return null;
  return html`<a className=${className} href=${href}>${label}${children}</a>`;
}

// A picture (WA decision 26): its smaller copies as a srcset with the
// place's `sizes`, the spot kept in view (focus) as object-position, and a
// decorative picture says nothing to a screen reader. eager: the first
// section's picture (or a post's): fetched first, never lazy.
export function pictureAttrs(rc, image, sizes = '100vw') {
  const i = obj(image);
  const src = rc.img(i.url);
  if (!src) return null;
  const copies = arr(i.sizes).map((z) => ({ url: rc.img(obj(z).url), w: Number(obj(z).w) })).filter((z) => z.url && z.w > 0);
  const full = Number(i.width) > 0 ? Number(i.width) : 0;
  const set = copies.length && full ? [...copies.filter((z) => z.w < full), { url: src, w: full }] : copies;
  const f = obj(i.focus);
  const focus = Number.isFinite(f.x) && Number.isFinite(f.y) ? { objectPosition: `${f.x}% ${f.y}%` } : null;
  return {
    src,
    ...(set.length > 1 ? { srcSet: set.map((z) => `${z.url} ${z.w}w`).join(', '), sizes } : {}),
    ...(focus ? { style: focus } : {}),
    alt: i.decorative === true ? '' : str(i.alt),
  };
}

export function Img({ rc, image, className, width, height, eager, alt, sizes }) {
  const a = pictureAttrs(rc, image, sizes);
  if (!a) return null;
  const i = obj(image);
  const w = Number(i.width) > 0 ? Number(i.width) : width;
  const h = Number(i.height) > 0 ? Number(i.height) : height;
  return html`<img className=${className} src=${a.src} srcSet=${a.srcSet} sizes=${a.sizes} style=${a.style} alt=${alt ?? a.alt} width=${w} height=${h}
    loading=${eager ? undefined : 'lazy'} fetchPriority=${eager ? 'high' : undefined} decoding="async" />`;
}

// ── The forms' wording ──
// The words a visitor ticks are the words the server keeps: the consent
// boxes' from site.consent (context.js), the declarations from
// shared/site/wording.js — never written here.
// On a translated page the labels and messages are the page's language
// (rc.w); a legal line that isn't approved there carries lang 'en'.
const langOf = (rc, l) => (rc.lang !== 'en' && l === 'en' ? { labelLang: 'en' } : {});
export const makeF = (rc) => ({
  first: (o) => ({ name: 'first_name', label: rc.w('field.first'), autoComplete: 'given-name', required: true, msg: rc.w('err.first_name'), half: true, max: 80, ...o }),
  last: (o) => ({ name: 'last_name', label: rc.w('field.last'), autoComplete: 'family-name', required: true, msg: rc.w('err.last_name'), half: true, max: 80, ...o }),
  email: (o) => ({ name: 'email', label: rc.w('field.email'), type: 'email', inputMode: 'email', autoComplete: 'email', required: true, msg: rc.w('err.emailAddress'), half: true, max: 200, ...o }),
  phone: (o) => ({ name: 'phone', label: rc.w('field.phone'), type: 'tel', inputMode: 'tel', autoComplete: 'tel', optional: true, half: true, max: 30, ...o }),
  postal: (o) => ({ name: 'postal_code', label: rc.w('field.postal'), autoComplete: 'postal-code', required: true, msg: rc.w('err.postal'), half: true, max: 7, ...o }),
  address: (o) => ({ name: 'address', label: rc.w('field.address'), autoComplete: 'street-address', required: true, msg: rc.w('err.address'), max: 200, ...o }),
  city: (o) => ({ name: 'city', label: rc.w('field.city'), autoComplete: 'address-level2', required: true, msg: rc.w('err.city'), half: true, max: 80, ...o }),
  consentEmail: () => ({ name: 'consent_email', type: 'check', label: rc.site.consent.email, ...langOf(rc, rc.site.consentLang?.email) }),
  consentSms: () => ({ name: 'consent_sms', type: 'check', label: rc.site.consent.sms, ...langOf(rc, rc.site.consentLang?.sms) }),
  declaration: (key, english) => {
    const d = rc.lang === 'en' ? { text: english, lang: 'en' } : rc.legal(key);
    return { name: 'declaration', type: 'check', required: true, msg: rc.w('err.declaration'), label: d.text, ...langOf(rc, d.lang) };
  },
});
const orgName = (rc) => rc.site.org.shortName || rc.site.org.name || 'the campaign';
const privacyHref = (rc) => (rc.site.org.privacy ? rc.link(rc.site.org.privacy) : null);
// Whose the data is, for the line under every form (form.js FormSmall).
const keeper = (rc) => rc.site.org.name || orgName(rc);
// The privacy line on a translated page: the approved words only.
const privacyLine = (rc) => {
  if (rc.lang === 'en') return {};
  const l = rc.legal('privacy');
  return { privacyLine: l.text, privacyLang: l.lang === 'en' ? 'en' : undefined };
};
const privacyOf = (rc) => ({ href: privacyHref(rc), keeper: keeper(rc), ...privacyLine(rc) });

// The island's props for a module's form: the fields, where it posts, the
// hidden ids, and — after a plain post — its thank-you or its error.
export function formProps(rc, m, kind, o) {
  const names = o.fields.map((f) => f.name).filter(Boolean).concat(o.amount ? ['amount_cents'] : []);
  return {
    uid: `${m.id}-form`,
    ...o,
    // Every form: the privacy line and the main site's privacy policy.
    privacy: privacyHref(rc),
    keeper: keeper(rc),
    ...privacyLine(rc),
    ...rc.islandWords('form'),
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
    <p className="notice-title">${rc.w(what === 'membership' ? 'mod.notReadyMembership' : 'mod.notReadyGiving')}</p>
    ${email ? html`<p>${`${rc.w(verb === 'join' ? 'mod.notReadyJoin' : 'mod.notReadyGive')} `}<a href=${`mailto:${email}`}>${email}</a>.</p>` : html`<p>${rc.w('mod.checkBackSoon')}</p>`}
  </div>`;
}

// ── Text and pictures ──

// The hero's headline on a translated page (decision 23): one row per
// rotating word, "{prefix} <b>{word}</b>". The same text before every <b>:
// the translated prefix and words, as in English. Otherwise each whole
// sentence rotates (no prefix). Any row missing: the English, lang="en".
function heroWords(rc, p) {
  const words = arr(p.words).map(str).map((w) => w.trim()).filter(Boolean);
  const title = str(p.titlePrefix).trim();
  if (rc.lang === 'en') return { title, words };
  if (!words.length) { const r = rc.t(title); return { title: r.text, words, lang: r.lang === 'en' ? 'en' : undefined }; }
  const rows = heroSegments(title, words).map((x) => rc.t(x));
  if (rows.some((r) => r.lang === 'en')) return { title, words, lang: 'en' };
  const parts = rows.map((r) => /^([\s\S]*?)<b>([\s\S]*?)<\/b>([\s\S]*)$/.exec(r.text));
  if (parts.every(Boolean) && parts.every((x) => !x[3].trim() && x[1].trim() === parts[0][1].trim())) {
    return { title: parts[0][1].trim(), words: parts.map((x) => x[2].trim()) };
  }
  return { title: '', words: rows.map((r) => r.text.replace(/<\/?b>/g, '').replace(/\s+/g, ' ').trim()) };
}

// Where the hero's picture goes (WEB decision 31): beside the words (every
// hero before; in the modern sizes a 7:5 grid, the picture 4:5) or behind
// them (the words on a panel of the brand colour). No picture: the words
// alone — but the builder's own frame (?edit=1, rc.edit) of a modern hero
// shows a plain box saying where a picture would go; no other preview does. Its `sizes` follow the place it takes.
const HERO_SIZES = { classic: '(min-width: 900px) 50vw, 100vw', modern: '(min-width: 1200px) 480px, (min-width: 900px) 40vw, 100vw', behind: '100vw' };
function Hero({ m, p, rc, level, first }) {
  const { title, words, lang } = heroWords(rc, p);
  const wl = rc.lang !== 'en' ? { ...(lang ? { lang } : {}), ...rc.islandWords('words') } : {};
  const has = Boolean(rc.img(obj(p.image).url));
  const behind = has && p.layout === 'behind';
  const modern = rc.site.theme.scale === 'modern';
  const sizes = behind ? HERO_SIZES.behind : modern ? HERO_SIZES.modern : HERO_SIZES.classic;
  const ph = !has && modern && Boolean(rc.edit);
  return html`<${Section} m=${m} tone="brand" className=${cx('hero', has && 'has-picture', ph && 'has-ph', behind && 'hero--behind')} labelled=${false}>
    <div className="container hero-inner">
      <div className="hero-copy">
        ${words.length
          ? html`<${Island} name="words" props=${{ uid: `${m.id}-words`, prefix: title, words, level, ...wl }} />`
          : html`<div className="hero-headline"><${Heading} level=${level} className="hero-title display" lang=${lang}>${title}<//></div>`}
        <${Paras} text=${p.text} className="hero-text" />
        <div className="btn-row">
          <${Button} rc=${rc} link=${p.primaryCta} className="btn btn--primary btn--lg" />
          ${arr(p.secondaryCtas).map((c, i) => html`<${Button} key=${i} rc=${rc} link=${c} className="btn btn--ghost btn--lg" />`)}
        </div>
      </div>
      <${Img} rc=${rc} image=${p.image} className="hero-image" width=${1600} height=${1200} sizes=${sizes} eager=${first} />
      ${ph ? html`<div className="hero-ph" role="img" aria-label=${rc.w('mod.yourPicture')}>${rc.w('mod.yourPicture')}</div>` : null}
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

function Picture({ m, p, rc, first }) {
  const has = Boolean(rc.img(obj(p.image).url));
  if (!has && !rc.preview) return html`<${Section} m=${m} tone="paper" className="picture is-empty" labelled=${false} />`;
  return html`<${Section} m=${m} tone="paper" className="picture" labelled=${false}>
    <figure className="container picture-figure">
      ${has
        ? html`<${Img} rc=${rc} image=${p.image} className="wide-image" width=${1600} height=${900} sizes="(min-width: 1200px) 1200px, 100vw" eager=${first} />`
        : html`<div className="picture-empty" role="img" aria-label=${rc.w('mod.noPicture')}></div>`}
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
        ? html`<div className="video-frame"><iframe src=${embed.src} title=${title || str(p.caption).trim() || rc.w('mod.video', { provider: embed.provider })} loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"></iframe></div>`
        : href ? html`<p><a className="text-link" href=${href}>${rc.w('mod.watchVideo')}</a></p>` : null}
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
      ${items.length ? html`<div className="pillars" style=${{ '--cols-n': String(Math.min(items.length, 3)) }}>
        ${items.map((it, i) => html`<div key=${i} className="pillar">
          <div className="pillar-head">
            <div className="pillar-icon"><${Icon} name=${ICON_NAMES.includes(it.icon) ? it.icon : 'civic'} size=${26} stroke=${2} /></div>
            <h3>${str(it.title)}</h3>
          </div>
          ${str(it.body).trim() ? html`<p>${str(it.body)}</p>` : null}
        </div>`)}
      </div>` : null}
      ${str(p.ctaText).trim() || rc.link(obj(p.cta).href) ? html`<div className="pillars-foot">
        ${str(p.ctaText).trim() ? html`<p className="pillars-cta">${p.ctaText}</p>` : null}
        <${Button} rc=${rc} link=${p.cta} className="btn btn--outline" />
      </div>` : null}
    </div>
  <//>`;
}

// The band's heading drawn whole (decision 23): the translated row split at
// its <u> part, which may come first or last; no row: the English, lang="en".
function bandParts(rc, p) {
  const title = str(p.title);
  const hl = str(p.highlight).trim();
  if (rc.lang === 'en' || !hl) {
    if (rc.lang === 'en' || !title.trim()) return { before: title, inside: hl, after: '' };
    const r = rc.t(title);
    return { before: r.text, inside: '', after: '', lang: r.lang === 'en' ? 'en' : undefined };
  }
  const r = rc.t(bandSegment(title, hl));
  const parts = r.lang === 'en' ? null : splitMark(r.text, 'u');
  if (!parts) return { before: title, inside: hl, after: '', lang: 'en' };
  return parts;
}

function Band({ m, p, rc, level }) {
  const tone = toneOf(p.tone, 'accent');
  const b = bandParts(rc, p);
  return html`<${Section} m=${m} tone=${tone} className="band">
    <div className="container band-inner">
      ${rc.lang === 'en'
        ? html`<${Heading} level=${level} id=${titleId(m)}>${p.title}${str(p.highlight).trim() ? ' ' : null}${str(p.highlight).trim() ? html`<span className="underline">${p.highlight}</span>` : null}<//>`
        : html`<${Heading} level=${level} id=${titleId(m)} lang=${b.lang}>${b.inside && b.lang === 'en' ? `${b.before.trimEnd()} ` : b.before}${b.inside ? html`<span className="underline">${b.inside}</span>` : null}${b.after}<//>`}
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
        <${Img} rc=${rc} image=${p.photo} className="quote-photo" width=${96} height=${96} sizes="96px" />
        <span className="quote-who">
          ${str(p.name).trim() ? html`<span className="quote-name">${rc.names(p.name)}</span>` : null}
          ${str(p.role).trim() ? html`<span className="quote-role">${p.role}</span>` : null}
        </span>
      </figcaption>` : null}
    </figure>
  <//>`;
}

// ── Actions ──

function Newsletter({ m, p, rc, level }) {
  const tone = toneOf(p.tone, 'surface');
  const F = makeF(rc);
  const fields = [
    F.first({ required: false, optional: true, msg: undefined }),
    F.email(),
    ...(p.askPhone ? [F.phone(), F.consentSms()] : []),
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
          submit: str(p.buttonLabel).trim() || rc.w('form.signUp'),
          submitClass: 'btn--brand',
          // Sending this form is the yes to email: these words, as the server keeps them.
          small: rc.site.consent.newsletter,
          ...(rc.lang !== 'en' && rc.site.consentLang?.newsletter === 'en' ? { smallLang: 'en' } : {}),
          thanks: { title: rc.w('form.newsletterThanks'), body: rc.w('form.newsletterThanksBody') },
        })} />
      </div>
    </div>
  <//>`;
}

function membershipAmounts(rc) {
  const min = rc.data.payments.membership_min_cents || 0;
  const limit = rc.data.payments.limit_cents;
  // The minimum, then the campaign's usual amounts above it (the loaders'
  // payments.membership_suggested), four in all.
  const usual = rc.data.payments.membership_suggested;
  return (min ? [min, ...usual.filter((c) => c > min)] : usual).filter((c) => !limit || c <= limit).slice(0, 4);
}

// Only on the website of a campaign that has a membership (the loaders'
// data.membership): on any other, the section draws nothing.
function Join({ m, p, rc, level }) {
  if (!rc.data.membership) return null;
  const pay = rc.data.payments;
  const presets = membershipAmounts(rc);
  const F = makeF(rc);
  const form = pay.ready
    ? html`<${Island} name="form" props=${formProps(rc, m, 'join', {
      title: rc.w('form.joinOnline'),
      fields: [
        F.first(), F.last(), F.email(), F.phone(),
        F.address(), F.city(), F.postal(),
        { name: 'birth_date', label: rc.w('field.birth'), type: 'date', autoComplete: 'bday', required: true, msg: rc.w('err.birth_date'), half: true },
        { name: 'citizenship', label: rc.w('field.citizenship'), type: 'radios', required: true, msg: rc.w('err.citizenship'), options: [{ value: 'citizen', label: rc.w('join.citizen') }, { value: 'pr', label: rc.w('join.pr') }] },
        { name: 'term', label: rc.w('field.term'), type: 'radios', number: true, required: true, msg: rc.w('err.term'), value: 1, options: [{ value: 1, label: rc.w('field.oneYear') }, { value: 4, label: rc.w('field.fourYears') }] },
        { type: 'amount' },
        ...payNote(rc),
        F.declaration('join', JOIN_DECLARATION),
        F.consentEmail(), F.consentSms(),
      ],
      amount: { presets, monthly: false, cadence: false, limit: pay.limit_cents, defaultCents: presets[0] || null, min: pay.membership_min_cents || 100, legend: str(p.amountTitle).trim() || rc.w('form.membershipAmount'), note: str(p.amountNote).trim() },
      submit: rc.w('form.joinPay'),
      privacy: privacyHref(rc),
      ...smallOf(rc, 'donateSmallNoLimit', {}, 'You’ll pay on the next page by card, Apple Pay or Google Pay.'),
      thanks: { title: rc.w('form.joinThanks'), body: rc.w('form.joinThanksBody') },
    })} />`
    : html`<${NotReady} rc=${rc} what="membership" verb="join" />`;
  return html`<${Section} m=${m} tone="surface" className="join">
    <div className="container stack stack--xl">
      <${Img} rc=${rc} image=${p.photo} className="join-photo" width=${1024} height=${458} sizes="(min-width: 900px) 50vw, 100vw" />
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
  const F = makeF(rc);
  const form = pay.ready
    ? html`<${Island} name="form" props=${formProps(rc, m, 'donate', {
      fields: [
        { type: 'amount' },
        ...payNote(rc),
        { type: 'section', label: rc.w('field.details') },
        F.first(), F.last(), F.email(), F.phone(),
        F.address(), F.city(), F.postal(),
        F.declaration('donate', DONATE_DECLARATION),
        F.consentEmail(), F.consentSms(),
      ],
      amount: { presets: unique, monthly: p.allowMonthly === true, cadence: true, limit, monthlyMax: pay.monthly_max_cents || Math.floor(limit / 12 / 100) * 100, defaultCents: unique[Math.min(1, unique.length - 1)] ?? null, monthlyNote: str(p.monthlyNote).trim() },
      submit: rc.w('form.donate'),
      privacy: privacyHref(rc),
      ...(limit
        ? smallOf(rc, 'donateSmall', { limit: money(limit) }, `The most anyone can give in a year is ${money(limit)}. You’ll pay on the next page by card, Apple Pay or Google Pay.`)
        : smallOf(rc, 'donateSmallNoLimit', {}, 'You’ll pay on the next page by card, Apple Pay or Google Pay.')),
      thanks: { title: rc.w('form.donateThanks'), body: rc.w('form.donateThanksBody') },
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

export function GoalBar({ count, goal, kind, w }) {
  const g = Math.round(Number(goal) || 0);
  if (g <= 0) return null;
  const n = Math.max(0, Math.round(Number(count) || 0));
  return html`<div className="goal">
    <p className="goal-label"><strong>${thousands(n)}</strong>${` ${w ? w(kind === 'pledge' ? 'act.signers' : 'act.signatures') : kind === 'pledge' ? 'have signed' : 'signatures'}`}<span className="goal-of">${` ${w ? w('act.of', { goal: thousands(g) }) : `of ${thousands(g)}`}`}</span></p>
    <progress className="goal-bar" max=${g} value=${Math.min(n, g)} aria-label=${w ? w('act.ofTotal', { count: thousands(n), goal: thousands(g) }) : `${thousands(n)} of ${thousands(g)}`}></progress>
  </div>`;
}

// The petition or pledge form; also used by the campaign page.
export function campaignForm(rc, m, c, { idPrefix } = {}) {
  const pledge = c.kind === 'pledge';
  const kind = pledge ? 'pledge' : 'petition';
  const path = `/act/${str(c.slug)}`;
  const shareUrl = rc.abs(rc.link(path) || path);
  const F = makeF(rc);
  return formProps(rc, m, kind, {
    uid: `${idPrefix || m.id}-form`,
    title: rc.w(pledge ? 'form.signPledge' : 'form.addName'),
    // The statement's words as drawn (decision 37): the server keeps exactly these.
    hidden: { campaign: str(c.id), ...(rc.lang !== 'en' && c.statementV ? { statement_v: c.statementV } : {}) },
    fields: [
      F.first(), F.last(), F.email(), F.postal(), F.phone(),
      { name: 'comment', label: rc.w(pledge ? 'field.whySigning' : 'field.comment'), type: 'textarea', optional: true, max: 1000, rows: 3 },
      F.consentEmail(), F.consentSms(),
    ],
    submit: rc.w(pledge ? 'form.signPledge' : 'form.addMyName'),
    // Who keeps the details is the form's privacy line (wording.js
    // PRIVACY_LINE): no second sentence saying it again.
    privacy: privacyHref(rc),
    thanks: {
      title: rc.w(pledge ? 'form.signedPledge' : 'form.signedPetition'),
      body: rc.w('form.signedBody'),
      // The supporter's "I signed …" words, with "Authorized by …" under
      // them when it is filled in (shared/site/authorized.js).
      share: { url: shareUrl, here: pagePath(rc.loc), text: signedShare(rc, rc.w('act.signedShare', { title: str(c.title) })), subject: str(c.title), label: rc.w('share.it') },
    },
  });
}

function Petition({ m, p, rc, level }) {
  const c = obj(rc.data.campaigns[str(p.campaign)]);
  const tone = toneOf(p.tone);
  if (!c.id && !c.title) {
    return html`<${Section} m=${m} tone=${tone} className="petition" labelled=${false}>
      <div className="container"><p className="empty-state">${rc.w(rc.preview ? 'act.choose' : 'act.gonePetition')}</p></div>
    <//>`;
  }
  const pledge = c.kind === 'pledge';
  const eyebrow = str(p.eyebrow).trim() || rc.w(pledge ? 'act.thePledge' : 'act.petition');
  const closed = c.status === 'closed';
  return html`<${Section} m=${m} tone=${tone} className=${cx('petition', DARK.has(tone) && 'petition--dark')}>
    <div className="container">
      <div className="campaign-box">
        <div className="campaign-copy">
          <p className="eyebrow">${eyebrow}</p>
          <${Heading} level=${level} id=${titleId(m)} className="campaign-title">${str(c.title)}<//>
          ${str(c.excerpt).trim() ? html`<p className="lede">${c.excerpt}</p>` : null}
          ${str(c.statement).trim() ? html`<blockquote className="statement" lang=${rc.lang !== 'en' && c.statementLang === 'en' ? 'en' : undefined}><${Paras} text=${c.statement} /></blockquote>` : null}
          <${GoalBar} count=${c.count} goal=${c.goal} kind=${c.kind} w=${rc.lang !== 'en' ? rc.w : null} />
          ${str(c.slug).trim() ? html`<a className="text-link" href=${rc.link(`/act/${c.slug}`)}>${rc.lang === 'en' ? html`More about this ${pledge ? 'pledge' : 'petition'}` : rc.w(pledge ? 'act.morePledge' : 'act.morePetition')}</a>` : null}
        </div>
        <div className="campaign-form">
          ${closed
            ? html`<div className="notice" role="note"><p className="notice-title">${rc.w(pledge ? 'act.closedPledge' : 'act.closedPetition')}</p><p>${rc.w('act.thanksSigned')}</p></div>`
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
  const F = makeF(rc);
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
            // The value stays English (the desk, ladders and filters match it); only the label is the page's language.
            ...(list.length ? [{ name: 'roles', label: rc.w('field.roles'), type: 'checks', optional: true, columns: true, options: list.map((r) => ({ value: r, label: rc.tt(r) })) }] : []),
            ...(p.askAvailability ? [{ name: 'availability', label: rc.w('field.availability'), type: 'textarea', optional: true, max: 300, rows: 2, hint: rc.w('field.availabilityHint') }] : []),
            { name: 'note', label: rc.w('field.note'), type: 'textarea', optional: true, max: 1000, rows: 3 },
            F.consentEmail(), F.consentSms(),
          ],
          submit: rc.w('form.signMeUp'),
          privacy: privacyHref(rc),
          thanks: { title: rc.w('form.volunteerThanks'), body: rc.w('form.volunteerThanksBody') },
        })} />
      </div>
    </div>
  <//>`;
}

// Openings and events: the loaders' shifts, as the island shows them.
function openingItems(rc, list, limit) {
  return arr(list).slice(0, Math.max(1, Number(limit) || 6)).map((e) => {
    const w = when(e.starts_at, e.ends_at, rc.timeZone, rc.locale);
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
      // After the date, lower case: "Sunday, November 15, drop in 4:00–8:00 p.m."
      time: w?.time ? `${e.drop_in ? `${rc.w('open.dropIn')} ` : ''}${w.time}` : '',
      where: str(e.location).trim(),
      map,
      full: left === 0,
      low: left !== null && left > 0 && left <= 3,
      spots: left === null || left === 0 ? '' : rc.w(left === 1 ? 'open.spot' : 'open.spots', { count: left }),
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
        ? html`<${Island} name="openings" props=${{ uid: `${m.id}-openings`, variant: 'shifts', action: rc.action('rsvp'), hidden: rc.hidden(m.id), privacy: privacyOf(rc), items, sent: rc.sentFor('rsvp', m.id), sentItem: rc.sentItem(), error: rc.errorFor('rsvp', m.id, RSVP_FIELDS), ...rc.islandWords('openings') }} />`
        : html`<p className="empty-state">${`${rc.w('mod.noOpenings')} `}${volunteer ? html`<a href=${volunteer}>${rc.w('mod.tellUs')}</a>` : rc.w('mod.newEveryWeek')}</p>`}
      ${p.showMap && items.some((it) => it.map) ? html`<p className="small">${rc.w('mod.mapHint')}</p>` : null}
    </div>
  <//>`;
}

function Contact({ m, p, rc, level }) {
  const topics = arr(p.topics).map(str).filter(Boolean);
  const { email, phone } = rc.site.org;
  const F = makeF(rc);
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
            ...(topics.length ? [{ name: 'topic', label: rc.w('field.topic'), type: 'select', optional: true, options: topics.map((t) => ({ value: t.slice(0, 60), label: rc.tt(t) })) }] : []),
            { name: 'message', label: rc.w('field.message'), type: 'textarea', required: true, msg: rc.w('err.message'), max: 4000, rows: 5 },
            F.consentEmail(),
          ],
          submit: rc.w('form.send'),
          privacy: privacyHref(rc),
          thanks: { title: rc.w('form.contactThanks'), body: rc.w('form.contactThanksBody') },
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
          <h3 className="rail-subtitle">${rc.w('mod.nextUp')}</h3>
          <ul className="next-list">
            ${next.map((ev) => html`<li key=${ev.id} className="next-card">
              <div className="date-badge date-badge--sm" aria-hidden="true"><span className="day">${ev.day}</span><span className="mon">${ev.mon}</span></div>
              <div className="next-info">
                <p className="eyebrow">${rc.w('mod.event')}</p>
                <a className="next-title" href=${rc.anchorFor('events') || volunteer}>${ev.title}</a>
                <p className="next-meta">${ev.date}, ${ev.time}${ev.where ? ` · ${ev.where}` : ''}</p>
              </div>
            </li>`)}
            <li className="next-card">
              <div className="next-icon" aria-hidden="true"><${Icon} name="hand" size=${22} /></div>
              <div className="next-info">
                <p className="eyebrow">${rc.w('mod.volunteer')}</p>
                <a className="next-title" href=${volunteer}>${rc.w('mod.pickShift')}</a>
                <p className="next-meta">${rc.w('mod.shiftHint')}</p>
              </div>
            </li>
          </ul>
        </div>
        <div className="stack stack--sm">
          <h3 className="rail-subtitle">${rc.w(showCounts ? 'mod.soFar' : 'mod.latest')}</h3>
          ${showCounts ? html`<ul className="counts">
            ${members != null ? html`<li><span className="count">${thousands(members)}</span><span className="count-label">${rc.w('mod.members')}</span></li>` : null}
            ${signed > 0 ? html`<li><span className="count">${thousands(signed)}</span><span className="count-label">${rc.w('mod.signatures')}</span></li>` : null}
          </ul>` : null}
          ${open.slice(0, 2).map((c) => html`<div key=${c.id} className="rail-post">
            <p className="eyebrow">${rc.w(c.kind === 'pledge' ? 'act.pledge' : 'act.petition')}${p.showCounts !== false && Number(c.count) > 0 ? ` · ${rc.w('act.signedCount', { count: thousands(c.count) })}` : ''}</p>
            <a className="next-title" href=${rc.link(`/act/${str(c.slug)}`)}>${str(c.title)}</a>
          </div>`)}
          ${post ? html`<div className="rail-post">
            <p className="eyebrow">${dateOnly(post.published_at, rc.timeZone, rc.locale) || rc.w('mod.newsWord')}</p>
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
          <p className="eyebrow">${rc.w(items.length ? 'mod.nextEvent' : 'mod.events')}</p>
          <${Heading} level=${level} id=${titleId(m)} className="display pop-alt">${p.title}<//>
        </div>
      </div>
      ${items.length
        ? html`<${Fragment}><${Island} name="openings" props=${{ uid: `${m.id}-events`, variant: 'events', action: rc.action('rsvp'), hidden: rc.hidden(m.id), privacy: privacyOf(rc), items, sent: rc.sentFor('rsvp', m.id), sentItem: rc.sentItem(), error: rc.errorFor('rsvp', m.id, RSVP_FIELDS), ...rc.islandWords('openings') }} />
          <p className="small events-ics"><a href=${rc.link('/events.ics')}>${rc.w('mod.eventsCalendar')}</a></p><//>`
        : html`<div className="event-feature">
          <div className="info">
            <h3>${rc.w('mod.eventsSoon')}</h3>
            <p className="summary">${rc.w(newsletter ? 'mod.eventsNewsletter' : 'mod.checkBack')}</p>
          </div>
          ${newsletter ? html`<a className="btn btn--primary btn--lg" href=${newsletter}>${rc.w('mod.getNewsletter')}</a>` : null}
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
        <a className="text-link" href=${rc.link('/news')}>${rc.w('news.all')}</a>
      </div>
      ${posts.length ? html`<div className="card-grid">
        ${posts.map((post) => html`<article key=${post.slug} className=${cx('card', rc.img(obj(post.image).url) && 'has-picture')}>
          <${Img} rc=${rc} image=${post.image} className="news-card-image" width=${1200} height=${675} sizes="(min-width: 1200px) 384px, (min-width: 600px) 50vw, 100vw" alt="" />
          <p className="eyebrow">${dateOnly(post.published_at, rc.timeZone, rc.locale)}</p>
          <h3 className="h3"><a href=${rc.link(`/news/${post.slug}`)}>${post.title}</a></h3>
          ${str(post.excerpt).trim() ? html`<p>${post.excerpt}</p>` : null}
        </article>`)}
      </div>` : html`<p className="empty-state">${rc.w('news.empty')}</p>`}
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

export function StatusStamp({ status, rc }) {
  const s = STATUS_LABEL[status] ? status : 'pending';
  return html`<span className=${`status-badge status-${s}`}><${Icon} name=${s} size=${14} stroke=${2.6} />${rc ? rc.w(`tracker.${s}`) : STATUS_LABEL[s]}</span>`;
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
      ${counts.length ? html`<ul className="score-legend" aria-label=${rc.w('mod.promisesBy')}>
        ${counts.map((s) => html`<li key=${s.value}><span className="score-count">${s.n}</span><${StatusStamp} status=${s.value} rc=${rc} /></li>`)}
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
                  <${StatusStamp} status=${status} rc=${rc} />
                  ${str(it.due).trim() ? html`<span className="promise-due">${rc.lang === 'en' ? html`Due ${it.due}` : rc.w('mod.due', { due: it.due })}</span>` : null}
                </div>
                <h3 className="promise-title">${it.title}</h3>
              </div>
            </div>
            ${str(it.note).trim() || source ? html`<details className="promise-detail">
              <summary>${rc.w('mod.whatHappened')}<span className="visually-hidden">: ${it.title}</span></summary>
              <div className="promise-body">
                <${Paras} text=${it.note} />
                ${source ? html`<p><a href=${source}>${rc.w('mod.source')}</a></p>` : null}
              </div>
            </details>` : null}
          </li>`;
        })}
      </ol>` : html`<p className="empty-state">${rc.w('mod.promisesSoon')}</p>`}
    </div>
  <//>`;
}

// ── About the organization ──

function People({ m, p, rc, level }) {
  const seats = arr(p.seats);
  // An open seat links to the membership form, where the campaign has one.
  const join = rc.data.membership ? rc.anchorFor('join') || rc.link('/join') : null;
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
              ? html`<${Img} rc=${rc} image=${{ ...obj(seat.photo), width: undefined, height: undefined }} className="avatar avatar--photo" width=${112} height=${112} sizes="112px" />`
              : letters ? html`<div className="avatar" aria-hidden="true">${letters}</div>`
              : html`<div className="avatar avatar--open" aria-hidden="true"><${Icon} name="plus" size=${22} /></div>`}
            ${str(seat.role).trim() ? html`<p className="eyebrow">${seat.role}</p>` : null}
            <h3 className="h3">${name ? rc.names(name) : rc.w('mod.seatOpen')}</h3>
            ${str(seat.bio).trim() ? html`<p className="seat-bio">${seat.bio}</p>` : null}
            ${!name && join ? html`<a className="text-link" href=${join}>${rc.w('mod.putName')}<span className="visually-hidden">: ${str(seat.role)}</span></a>` : null}
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
        <${Heading} level=${level} id=${titleId(m)}>${rc.w('mod.followAlong')}<//>
        <${Paras} text=${p.intro} className="lede" />
      </div>
      ${accounts.length ? html`<div className="social-grid">
        ${accounts.map((a, i) => html`<article key=${i} className="social-card">
          <div className="head"><h3>${a.name}</h3>${str(a.handle).trim() ? html`<span className="handle">${a.handle}</span>` : null}</div>
          <a className="btn btn--outline" href=${rc.link(a.url)} rel="noopener noreferrer">${str(a.cta).trim() || rc.w('mod.followOn', { network: a.name })}</a>
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
  voterguide: VoterGuide,
};

// Whether a section draws its own heading (its title) — for the page's one
// heading (templates.js): a section that draws nothing, or nothing but its
// box, can't be the page's title. Each rule is the one its component above
// draws by: a list of questions with none written, a membership section on
// a website with no membership, a section with no title at all.
const HEADLESS = {
  faq: (p) => !arr(p.items).some((it) => str(it?.q).trim()),
  join: (p, rc) => !rc.data.membership,
};
export const drawsHeading = (kind, p, rc) => Boolean(str(obj(p).title).trim()) && !(HEADLESS[kind]?.(obj(p), rc));

// One module instance on a page. Unknown kinds draw nothing.
export function Module({ m, rc, level = 2, first = false }) {
  const Component = MODULE_COMPONENTS[m?.kind];
  if (!Component) return null;
  const id = str(String(m.id ?? '')).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'module';
  const mod = { ...m, id };
  const p = propsFor(mod);
  return html`<${Component} m=${mod} p=${rc.lang === 'en' ? p : translateProps(mod.kind, p, rc)} rc=${rc} level=${level} first=${first} />`;
}

// A module's words in the page's language (decision 22), walked by the
// catalogue's field types the way the server collects them
// (shared/site/segments.js): text, a paragraph field paragraph by
// paragraph, words, a link's label, a picture's words. Markdown is
// translated as it is drawn (rc.markdown); names, handles and amounts never;
// 'label' fields (roles, topics) keep their English, labelled where drawn;
// 'composed' headlines are drawn whole by the hero and the band.
export function translateProps(kind, p, rc) {
  const def = MODULE_BY_KIND[kind];
  if (!def) return p;
  const one = (type, v, check) => {
    if (type === 'text') return rc.tt(v, { check });
    if (type === 'textarea') return paragraphs(v).map((x) => rc.tt(x, { check })).join('\n\n');
    if (type === 'words') return arr(v).map((x) => rc.tt(x, { check }));
    if (type === 'link') return { ...obj(v), label: rc.tt(obj(v).label, { check }) };
    if (type === 'image') return { ...obj(v), alt: rc.tt(obj(v).alt, { check }) };
    return v;
  };
  const walk = (fields, o) => {
    const out = { ...obj(o) };
    for (const f of fields) {
      const flag = f.translate === undefined ? true : f.translate;
      if (flag === false || flag === 'label' || flag === 'composed') continue;
      if (f.type === 'list') out[f.key] = arr(out[f.key]).map((item) => walk(f.of, item));
      else out[f.key] = one(f.type, out[f.key], flag === 'check-first');
    }
    return out;
  };
  return walk(def.fields, p);
}

// Under the amounts, where Stripe has no page in this language (Punjabi):
// "The payment page may be in English."
function payNote(rc) {
  if (rc.lang === 'en' || LANG_BY_CODE[rc.lang]?.stripe !== 'auto') return [];
  const n = rc.legal('payPageNote');
  return [{ type: 'note', label: n.text, ...(n.lang === 'en' ? { labelLang: 'en' } : {}) }];
}
// The small print under donate and join: the approved words on a
// translated page, else as it always read.
function smallOf(rc, key, slots, english) {
  if (rc.lang === 'en') return { small: english };
  const l = rc.legal(key, slots);
  return { small: l.text, ...(l.lang === 'en' ? { smallLang: 'en' } : {}) };
}
