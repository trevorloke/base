// What the website's settings hold, what an address may be, and the words
// next to the consent boxes — one place, read by the actions (to check what
// an admin saves), the public routes (to hand the renderer `site`) and the
// seeds. Pure: no database.
//
// Settings sections (site_settings; SITE.md "Settings" says the same):
//   nav           { menu: [{ label, href }], links: [{ label, href }] (≤ 3,
//                 in the title bar), cta: { label, href } (the title bar's
//                 button) } — the renderer gets menu with every published
//                 page marked "show in menu" that isn't in it already, after it
//   footer        { acknowledgement, links: [{ label, href }], logo: { url, alt } }
//   announcement  { enabled, text, linkLabel, linkHref }
//   seo           { title, description, shareImage: { url, alt } }
//   org           { name, shortName, email, phone, address, platformUrl,
//                 platformLabel, privacyUrl, authorizationLine }
//   social        { accounts: [{ name, short, handle, url }] }
//   theme         shared/site/theme.js checkTheme (a pair under 4.5:1 is refused)
//   domains       ['imaginesurrey.ca', …] — the site answers at / on these
// Every href is the site's own path (/donate, /#m-join) or http(s), mailto:
// or tel:; the renderer puts ctx.root in front of the site's own.
import { z } from 'zod';

export const KINDS = ['newsletter', 'petition', 'pledge', 'volunteer', 'rsvp', 'contact', 'join', 'donate'];

// Addresses the site itself answers (routes) or the app keeps: never a page's.
export const RESERVED_SLUGS = ['news', 'act', 'r', 'preferences', 'unsubscribe', 'api', 'site-assets', '__preview', 'sitemap.xml', 'robots.txt', 'media', 'stripe', 'site'];
// Pages the site has whatever an admin does: home is /, news is /news.
export const SYSTEM_SLUGS = ['home', 'news'];
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

// "Get SkyTrain to South Surrey!" → "get-skytrain-to-south-surrey"
export const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');

// → null (fine) or the reason in plain words.
export const slugProblem = (slug) => {
  if (!slug) return 'Give the page an address (letters, numbers and dashes)';
  if (!SLUG_RE.test(slug)) return 'An address is lowercase letters, numbers and dashes (like town-hall-2026)';
  if (RESERVED_SLUGS.includes(slug)) return `“${slug}” is kept for the site itself — pick another address`;
  return null;
};

const isSafeHref = (s) => s === '' || /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i.test(s);
const text = (max) => z.string().trim().max(max);
const href = z.string().trim().max(500).refine(isSafeHref, { message: 'a link starting with /, # or https://' });
const link = z.object({ label: text(60).default(''), href: href.default('') });
const imageUrl = z.string().trim().max(500).refine((s) => s === '' || /^(\/(?!\/)|https:\/\/)/.test(s), { message: 'a picture from Website → Pictures (/media/…) or https://' });
const image = z.object({ url: imageUrl.default(''), alt: text(300).default('') });
const email = z.union([z.literal(''), z.string().trim().toLowerCase().email().max(320)]);

export const SECTIONS = {
  nav: z.object({
    menu: z.array(link).max(20).default([]),
    links: z.array(link).max(3).default([]),
    cta: link.default({ label: '', href: '' }),
  }),
  footer: z.object({
    acknowledgement: text(600).default(''),
    links: z.array(link).max(12).default([]),
    logo: image.default({ url: '', alt: '' }),
  }),
  announcement: z.object({
    enabled: z.boolean().default(false),
    text: text(160).default(''),
    linkLabel: text(40).default(''),
    linkHref: href.default(''),
  }),
  seo: z.object({
    title: text(80).default(''),
    description: text(300).default(''),
    shareImage: image.default({ url: '', alt: '' }),
  }),
  org: z.object({
    name: text(80).default(''),
    shortName: text(40).default(''),
    email: email.default(''),
    phone: text(40).default(''),
    address: text(200).default(''),
    platformUrl: href.default(''),
    platformLabel: text(80).default(''),
    privacyUrl: href.default(''),
    authorizationLine: text(200).default(''),
  }),
  social: z.object({
    accounts: z.array(z.object({
      name: text(40).default(''), short: text(4).default(''), handle: text(60).default(''), url: href.default(''),
    })).max(12).default([]),
  }),
};
export const SECTION_KEYS = Object.keys(SECTIONS);

// A section as stored → its full shape (defaults filled; anything that no
// longer fits is dropped back to the default rather than breaking a page).
export const sectionOf = (key, v) => {
  const r = SECTIONS[key].safeParse(v && typeof v === 'object' ? v : {});
  return r.success ? r.data : SECTIONS[key].parse({});
};

// 'https://www.Example.org/' → 'www.example.org'; null when it isn't a host.
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const hostOf = (raw) => {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return HOST_RE.test(s) ? s : null;
};

// The words next to the consent boxes, stored with every consent event.
// The renderer shows exactly these (site.consent), so what a person saw is
// what the record says.
export const consentWording = (org) => {
  const name = String(org?.shortName || org?.name || '').trim() || 'We';
  return {
    email: `Yes, ${name} can email me news and ways to help. I can unsubscribe at any time.`,
    sms: `Yes, ${name} can text me about events and volunteering. Reply STOP at any time. Message and data rates may apply.`,
  };
};

// Tags are at most 40 characters (person.update's rule): a long campaign
// title is cut at a word, the same way every time.
export const tagOf = (prefix, title) => {
  const full = `${prefix}${String(title ?? '').trim().replace(/\s+/g, ' ')}`;
  if (full.length <= 40) return full;
  const cut = full.slice(0, 39);
  const at = cut.lastIndexOf(' ');
  return `${(at > prefix.length ? cut.slice(0, at) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
};
