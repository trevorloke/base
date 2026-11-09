// What every component is handed: the site's settings and the loaders' data
// in one known shape (missing pieces filled, odd ones dropped), where the
// site lives, and the helpers that turn a typed link into a safe one. See
// SITE.md "Rendering" for the shapes accepted.
import { checkTheme } from '../theme.js';
import { consentName, consentWords } from '../wording.js';
import { renderMarkdown } from '../../markdown.js';
import { arr, obj, str, cleanRef, cleanSource, DEFAULT_TIME_ZONE } from './util.js';
import { absolute, imageFor, linkFor, locFrom, safeUrl } from './links.js';

const links = (list) => arr(list)
  .map((l) => ({ label: str(l?.label).trim(), href: str(l?.href).trim(), bar: l?.bar === true }))
  .filter((l) => l.label && safeUrl(l.href));

export function normalizeSite(site) {
  const s = obj(site);
  const { theme } = checkTheme(s.theme);
  const org0 = obj(s.org);
  const seo0 = obj(s.seo);
  const name = str(org0.name).trim() || str(seo0.title).trim();
  const nav0 = s.nav;
  const ctaRaw = Array.isArray(nav0) ? undefined : obj(nav0).cta;
  const cta = ctaRaw === undefined
    ? { label: 'Donate', href: '/donate' }
    : ctaRaw && str(ctaRaw.label).trim() && safeUrl(ctaRaw.href) ? { label: str(ctaRaw.label).trim(), href: str(ctaRaw.href).trim() } : null;
  const ann = obj(s.announcement);
  const annLink = obj(ann.link);
  const seoImage = obj(seo0.image || seo0.shareImage || seo0.share_image);
  const social = Array.isArray(s.social) ? s.social : arr(obj(s.social).accounts);
  const footer = obj(s.footer);
  // The words beside the consent boxes and the newsletter's button: the
  // server's (site.consent — what it keeps with each yes), else the same
  // words made the same way (shared/site/wording.js).
  const given = obj(s.consent);
  const made = consentWords(consentName(org0, seo0));
  const consent = Object.fromEntries(Object.keys(made).map((k) => [k, str(given[k]).trim() || made[k]]));
  return {
    theme,
    consent,
    org: {
      name,
      shortName: str(org0.short_name || org0.shortName).trim() || name,
      email: str(org0.email).trim(),
      phone: str(org0.phone).trim(),
      address: str(org0.address).trim(),
      authorization: str(org0.authorization || org0.authorized_by || org0.authorizationLine).trim(),
      privacy: str(org0.privacy_url || org0.privacyUrl || org0.privacy).trim(),
      platformUrl: str(org0.platform_url || org0.platformUrl).trim(),
      platformLabel: str(org0.platform_label || org0.platformLabel).trim(),
      timeZone: str(org0.time_zone || org0.timeZone).trim(),
    },
    nav: {
      items: links(Array.isArray(nav0) ? nav0 : obj(nav0).items || obj(nav0).links),
      bar: links(Array.isArray(nav0) ? [] : obj(nav0).bar),
      cta,
    },
    footer: {
      acknowledgement: str(footer.acknowledgement || footer.land).trim(),
      links: links(footer.links),
      text: str(footer.text || footer.note).trim(),
      logo: { url: str(obj(footer.logo).url).trim(), alt: str(obj(footer.logo).alt).trim() },
    },
    announcement: {
      on: ann.enabled !== false && Boolean(str(ann.text).trim()),
      text: str(ann.text).trim(),
      link: { label: str(annLink.label || ann.linkLabel || ann.link_label).trim(), href: str(annLink.href || ann.linkHref || ann.link_href).trim() },
    },
    seo: {
      title: str(seo0.title).trim() || name,
      description: str(seo0.description).trim(),
      image: { url: str(seoImage.url).trim(), alt: str(seoImage.alt).trim() },
      noindex: seo0.noindex === true,
    },
    social: social
      .map((a) => ({ name: str(a?.name).trim(), handle: str(a?.handle).trim(), url: str(a?.url).trim(), cta: str(a?.cta).trim(), short: str(a?.short).trim() }))
      .filter((a) => a.name && safeUrl(a.url) && /^https?:/i.test(a.url)),
  };
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

export function normalizeData(data) {
  const d = obj(data);
  const pay = obj(d.payments);
  const counts = obj(d.counts);
  return {
    posts: arr(d.posts).filter((p) => p && str(p.slug) && str(p.title)),
    events: arr(d.events).filter((e) => e && e.id != null && str(e.title)),
    shifts: arr(d.shifts || d.events).filter((e) => e && e.id != null && str(e.title)),
    counts: { members: counts.members == null ? null : num(counts.members, null), signatures: obj(counts.signatures) },
    campaigns: obj(d.campaigns),
    payments: { ready: pay.ready === true, limit_cents: Math.max(0, Math.round(num(pay.limit_cents))), monthly_max_cents: Math.max(0, Math.round(num(pay.monthly_max_cents))), membership_min_cents: Math.max(0, Math.round(num(pay.membership_min_cents))) },
    roles: arr(d.roles).map(str).map((r) => r.trim()).filter(Boolean),
  };
}

// ctx.sent: 'newsletter' (?sent=<kind>) or { kind, module_id }.
// ctx.error: 'email' (?error=<field>) or { field, kind, module_id, message }.
const pickSent = (v) => (typeof v === 'string' ? { kind: v, module: '' } : v && typeof v === 'object' ? { kind: str(v.kind), module: str(v.module_id || v.module) } : null);
const pickError = (v) => (typeof v === 'string' ? { field: v, kind: '', module: '', message: '' } : v && typeof v === 'object' ? { field: str(v.field), kind: str(v.kind), module: str(v.module_id || v.module), message: str(v.message || v.error) } : null);

// What a field's error says when the page comes back from a plain form post.
export const ERROR_WORDS = {
  first_name: 'Enter your first name',
  last_name: 'Enter your last name',
  email: 'Enter your email address (or a phone number)',
  phone: 'Enter a phone number with its area code',
  postal_code: 'Enter a postal code like V3T 1A1',
  address: 'Enter your street address',
  city: 'Enter your city',
  birth_date: 'Enter your date of birth',
  citizenship: 'Choose one',
  declaration: 'Tick the box to confirm',
  amount_cents: 'Choose an amount',
  term: 'Choose how long',
  message: 'Write your message',
  comment: 'Keep it under 1,000 characters',
  campaign: 'This one isn’t taking names right now',
  shift_id: 'That opening isn’t available any more',
  consent_email: 'Tick the box to get email from us',
  roles: 'Pick at least one',
  busy: 'Too many tries from here — wait a minute and try again.',
  payments: 'Online payments aren’t working right now — please try again in a few minutes, or get in touch to give another way.',
};
// Errors about a whole form rather than one of its boxes, and the kinds of
// form each is about (null: every form — too many tries from one address
// stops them all). With no module named, they show on every such form.
const FORM_ERRORS = { busy: null, payments: ['join', 'donate'], campaign: ['petition', 'pledge'], shift_id: ['rsvp'] };

export function renderContext({ kind = 'page', site, page, post, campaign, data, ctx } = {}) {
  const c = obj(ctx);
  const loc = locFrom(c);
  const s = normalizeSite(site);
  const d = normalizeData(data);
  const tz = str(c.timeZone).trim() || s.org.timeZone || DEFAULT_TIME_ZONE;
  const sent = pickSent(c.sent);
  const error = pickError(c.error);
  const mods = kind === 'page' ? arr(obj(page).modules) : [];
  // Is this module (an error's, from the address) on this page? A
  // petition's own page has one form, 'campaign'.
  const onPage = (id) => (kind === 'campaign' ? id === 'campaign' : mods.some((m) => m && m.id === id));
  const rc = {
    kind,
    loc,
    site: s,
    data: d,
    timeZone: tz,
    preview: Boolean(c.preview),
    // The forms' tracking, only as the server takes it (util.js).
    referral: cleanRef(c.referral),
    source: cleanSource(c.source),
    pageId: kind === 'page' ? str(obj(page).id) : '',
    modules: mods,
    link: (u) => linkFor(loc, u),
    img: (u) => imageFor(loc, u),
    abs: (p) => absolute(loc, p),
    action: (formKind) => `${loc.root}api/forms/${formKind}`,
    hidden: (moduleId, extra = {}) => ({ page_id: kind === 'page' ? str(obj(page).id) : '', module_id: moduleId, ref: cleanRef(c.referral), source: cleanSource(c.source), ...extra }),
    sentFor: (formKind, moduleId) => Boolean(sent && sent.kind === formKind && (!sent.module || sent.module === moduleId)),
    // After a plain post: the error on the form that was sent (its module,
    // when it is on this page), else on every form it is about — a box of
    // that name, or the kinds FORM_ERRORS names.
    errorFor: (formKind, moduleId, fieldNames) => {
      if (!error || !error.field) return null;
      const mod = error.module && onPage(error.module) ? error.module : '';
      if (mod && mod !== moduleId) return null;
      if (error.kind && error.kind !== formKind) return null;
      if (!mod && !error.kind) {
        if (Object.hasOwn(FORM_ERRORS, error.field)) {
          if (FORM_ERRORS[error.field] && !FORM_ERRORS[error.field].includes(formKind)) return null;
        } else if (!fieldNames.includes(error.field)) return null;
      }
      const message = error.message || ERROR_WORDS[error.field] || 'Please check the form and try again.';
      return fieldNames.includes(error.field) ? { field: error.field, message } : { field: '', message };
    },
    // Markdown, sanitized (shared/markdown.js), with its site links put
    // under the site's root like every other link.
    markdown: (text) => renderMarkdown(text).replace(/<a href="(\/(?!\/)[^"]*)"/g, (m, url) => {
      const to = linkFor(loc, url.replace(/&amp;/g, '&'));
      return to ? `<a href="${to.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : m;
    }),
    // The first module of a kind on this page, for "#m-…" links (an open
    // board seat → the membership form).
    anchorFor: (moduleKind) => {
      const m = mods.find((x) => x && !x.hidden && x.kind === moduleKind);
      return m ? `#m-${m.id}` : null;
    },
  };
  rc.post = post || null;
  rc.campaign = campaign || null;
  return rc;
}
