// The public website (SITE.md "Where the site is served"):
//
//   the campaign's own domain(s)   SITE_HOSTS=imaginesurrey.ca,www.imaginesurrey.ca
//                                  and site_settings.domains: the site at /.
//                                  Only the site answers there — and
//                                  /media/:id, /site-assets/*, the services'
//                                  webhooks (Stripe, Twilio, the email
//                                  sender, Mailchimp, CallHub), the emails'
//                                  unsubscribe links (/u, /bu, /lu): no app
//                                  route, no sign-in cookie is ever read or
//                                  set (siteGate, first in server/index.js)
//   anywhere else (the app's own address, base.win/<client>)
//                                  the site at /site/… (and /site-assets/*);
//                                  every app route stays the app's
//
// Routes, from the site's root: / (the page 'home') · /:slug · /news,
// /news/:slug · /act, /act/:slug · /r/:code · /preferences, /unsubscribe ·
// /__preview/:pageId · /sitemap.xml · /robots.txt · POST /api/forms/:kind
// (forms.js) · /site-assets/* (the stylesheet, fonts, pictures, the
// islands' script). Anything else is the site's 404 page.
//
// Pages are drawn by renderSite (./render/index.js — SITE.md "Rendering")
// and kept for a minute (cache.js). Every page carries a Content Security
// Policy: this site, the YouTube and Vimeo players, and Stripe's checkout
// as a form's destination; never framed by another site (a draft's preview
// may be framed by the app's own Website screen).
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, normalize, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { checkProps } from '@starbase/shared/site/catalogue';
import { themeCss } from '@starbase/shared/site/theme';
import { getDb } from '../../db/client.js';
import { runAction } from '../../lib/events.js';
import { envName } from '../../lib/org.js';
import { renderSite } from './render/index.js';
import { siteHost, siteWorkspace, ensureSite, readSettings, menuPages, siteOf, parseJ, mainAddress } from './store.js';
import { authorizedBy } from '../../../shared/site/wording.js';
import { loadData } from './loaders.js';
import { calendarHeaders, eventsCalendar } from './calendar.js';
import { cacheKey, cacheGet, cachePut, cacheGen, remember } from './cache.js';
import { now as clockNow } from '../../lib/clock.js';
import { guideState } from '../../../shared/voteguide.js';
import { guideFor } from '../voteguide/read.js';
import { clockRoute, findRoute } from '../voteguide/public.js';
import { verify, sign, PERSON_TTL } from './tokens.js';
import { refCodeFor, CODE_RE } from './people.js';
import { choicesOf, emailOff, emailOn, smsOff, smsOn } from './consent.js';
import { formRoute } from './forms.js';
import { KIT_CODE_RE, goodPath } from '../socials/share.js';
import { withSource } from '../../../shared/site/components/util.js';
import { KINDS, consentWording } from './shape.js';
import { LANG_BY_CODE, LANG_BY_PREFIX, isOther, labelFor } from '../../../shared/site/languages.js';
import { UI_WORDS, fillWords } from '../../../shared/site/ui-words.js';
import { languagesFor, translatorFor } from './translate.js';
import { LEGAL_ENGLISH_HASH, keyCurrent, legalSlots, legalWords, legalRow } from './legal.js';
// The campaign's website settings, read once until the next Website action
// (cache.js remember): a page already kept costs the database nothing.
const settingsOf = (site) => remember(site.db, `settings|${site.ws.id}`, () => readSettings(site.db, site.ws.id));
const legalRowOf = (site, id) => legalRow(site.db, site.ws.id, String(id).toLowerCase());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const REF_COOKIE = 'site_ref';
const SRC_COOKIE = 'site_src'; // the share kit a visitor came through (forms.js)
const REF_DAYS = 30;
const LANG_COOKIE = 'site_lang'; // the language a visitor last read the site in (TR decision 33)
// A prefetch (the switch's Speculation-Rules) never sets or clears it.
const prefetching = (c) => /prefetch/i.test(`${c.req.header('sec-purpose') || ''} ${c.req.header('purpose') || ''}`);
// The rules a page's Speculation-Rules header points at: prefetch the
// switch's other languages on hover or press — never the English link
// that clears the remembered language. That link is left out by its
// hreflang: a "?" in a URL pattern string is a modifier, so the address
// test alone let the browser prefetch it, and a click then used the
// prefetched answer, which (rightly) forgot nothing.
const LANG_RULES = JSON.stringify({
  prefetch: [{ where: { and: [{ selector_matches: '.lang-switch a:not([hreflang="en"])' }, { not: { href_matches: '*\\?lang=*' } }] }, eagerness: 'moderate' }],
});

// ── Files: /site-assets/* ──
// The site's own pictures (shared/site/assets), its stylesheet and fonts
// (shared/site), and the islands' script and its pieces (web/dist).
const fromHere = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOTS = [
  { dir: fromHere('../../../shared/site/assets/'), exts: ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif', '.ico', '.woff2', '.woff', '.css'] },
  { dir: fromHere('../../../shared/site/'), exts: ['.css', '.woff2', '.woff', '.ttf', '.otf'] },
  // The islands' build: web/dist/site-assets/* (where a build may put the
  // islands' pieces, so they load at /site-assets/… on the site's own
  // domain too), then web/dist/* (site-islands.js itself).
  { dir: fromHere('../../../web/dist/site-assets/'), exts: ['.js', '.mjs', '.css', '.woff2', '.woff', '.png', '.jpg', '.jpeg', '.webp', '.svg'] },
  { dir: fromHere('../../../web/dist/'), exts: ['.js', '.mjs', '.css', '.woff2', '.woff', '.png', '.jpg', '.jpeg', '.webp', '.svg'] },
];
const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
};
const serveAsset = async (c) => {
  const rel = decodeURIComponent(c.req.path.replace(/^.*?\/site-assets\//, ''));
  // The voter guide's embed script (VG): the snippet's second line.
  if (rel === 'embed.js') return c.body(await readFile(fromHere('../../../shared/site/embed.js')), 200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  if (rel === 'lang-rules.json') return c.body(LANG_RULES, 200, { 'Content-Type': 'application/speculationrules+json', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  if (!rel || rel.includes('\0') || rel.split('/').some((p) => p === '..' || p.startsWith('.'))) return c.text('not found', 404);
  const ext = extname(rel).toLowerCase();
  for (const root of ROOTS) {
    if (!root.exts.includes(ext)) continue;
    const file = normalize(join(root.dir, rel));
    if (!file.startsWith(root.dir.endsWith(sep) ? root.dir : `${root.dir}${sep}`)) continue;
    try {
      const s = await stat(file);
      if (!s.isFile()) continue;
      const body = await readFile(file);
      return c.body(body, 200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        ...(ext === '.svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}),
      });
    } catch { /* not in this root */ }
  }
  return c.text('not found', 404);
};

// The islands' script, when the web build made it (tests run without).
let islandsAt = 0;
let islandsThere = false;
const islandsBuilt = () => {
  if (Date.now() - islandsAt > 60_000) {
    islandsThere = existsSync(fromHere('../../../web/dist/site-islands.js'));
    islandsAt = Date.now();
  }
  return islandsThere;
};

// ── Headers ──
const FRAMES = 'https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com';
// Inline scripts the page carries (its islands' data is JSON, not code): each
// allowed by its hash, never 'unsafe-inline'.
const scriptHashes = (html) => {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !['text/javascript', 'module', 'application/javascript'].includes(type)) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2]).digest('base64')}'`);
  }
  return [...new Set(out)];
};
// frameAncestors: the addresses allowed to frame this page (the voter
// guide's embed, VG decision 21); otherwise nobody (a preview: the app).
export const cspFor = (html, { preview = false, frameAncestors = [] } = {}) => [
  "default-src 'self'",
  `script-src 'self'${scriptHashes(html).map((h) => ` ${h}`).join('')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  `frame-src ${FRAMES}`,
  "form-action 'self' https://checkout.stripe.com",
  `frame-ancestors ${preview ? "'self'" : frameAncestors.length ? frameAncestors.join(' ') : "'none'"}`,
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const staging = () => envName() === 'staging';
// geo: the page holds the voter guide, whose "Use my location" asks the
// browser (never the server) where the visitor is. frame: the voter guide's
// embed with its saved addresses — framed by them, so no X-Frame-Options
// (with none saved it is DENY like every page).
const pageHeaders = (c, site, { csp, preview = false, store = false, geo = false, frame = null }) => {
  c.header('Content-Security-Policy', csp);
  if (!(frame && frame.length)) c.header('X-Frame-Options', preview ? 'SAMEORIGIN' : 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', `camera=(), microphone=(), geolocation=${geo ? '(self)' : '()'}, payment=()`);
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cache-Control', store ? 'no-store' : 'no-cache');
  // Not indexed: a draft, staging, or the app's own copy of a site that has
  // its own domain (search engines should find that one).
  if (preview || frame || staging() || site.mirror) c.header('X-Robots-Tag', 'noindex, nofollow');
  if (site.https) c.header('Strict-Transport-Security', 'max-age=31536000');
};

const isHttps = (c) => (c.req.header('x-forwarded-proto') || '').split(',')[0].trim() === 'https' || c.req.url.startsWith('https:');

// The address people see in front of the site's root (canonical, og:url,
// og:image, share links, the sitemap): the request's own — except under a
// client's path, where the front door forwards base.win/<client> from
// base.win and STARBASE_PUBLIC_URL (https://base.win/<client>) names it.
const publicOrigin = (base, origin) => {
  if (!base) return origin;
  try {
    const u = new URL(String(process.env.STARBASE_PUBLIC_URL || '').trim());
    if (/^https?:$/.test(u.protocol) && u.pathname.replace(/\/+$/, '') === base) return u.origin;
  } catch { /* not set: the request's own */ }
  return origin;
};

// ── One request's site: the campaign, the root, the absolute origin ──
// root: '' on the campaign's own domain, '/site' elsewhere — with the
// client's path (BASE_PATH) in front, so links in pages and in island
// props alike are right as they are. origin: the request's; address: the
// public one (publicOrigin) — neither repeats the client's path.
const siteFor = async (c, at) => {
  const db = await getDb();
  // Read once until the next Website action; no campaign yet is asked again
  // (one may be signed up a moment later).
  const ws = await remember(db, `ws|${at.workspaceId || ''}|${process.env.SITE_WORKSPACE || ''}`, () => siteWorkspace(db, at.workspaceId || null))
    || await siteWorkspace(db, at.workspaceId || null);
  if (!ws) return null;
  const base = c.env?.base || '';
  const url = new URL(c.req.url);
  const proto = isHttps(c) ? 'https' : url.protocol.replace(':', '');
  const origin = `${proto}://${url.host}`;
  // lang: the language app's ('en' on the site's own); home: the root
  // without the language (where the cookies live, where English is).
  const lang = isOther(at.lang) ? at.lang : 'en';
  const home = `${base}${at.home ?? at.root}`;
  return {
    db, ws, inner: at.root, root: `${base}${at.root}`, base, lang, home,
    origin, address: publicOrigin(base, origin), https: proto === 'https', assets: `${base}/site-assets`,
  };
};

const ctxOf = (c, site, extra = {}) => {
  const q = (k) => c.req.query(k);
  // ?sent=rsvp&shift=<id>: the event someone just signed up for (forms.js).
  const sentKind = KINDS.includes(q('sent')) ? q('sent') : null;
  const sent = sentKind === 'rsvp' && UUID.test(q('shift') || '') ? { kind: sentKind, shift: q('shift').toLowerCase() } : sentKind;
  // ?error=<field>&module=<id>: the form a plain post came back to (forms.js).
  const field = /^[a-z_]{1,40}$/.test(q('error') || '') ? q('error') : null;
  const module = /^[A-Za-z0-9_-]{1,64}$/.test(q('module') || '') ? q('module') : '';
  const error = field && module ? { field, module_id: module } : field;
  const cancelled = KINDS.includes(q('cancelled')) ? q('cancelled') : null;
  const code = getCookie(c, REF_COOKIE);
  return {
    root: site.root,
    assets: site.assets,
    media: `${site.base}/media`,
    origin: site.address,
    islands: islandsBuilt() ? `${site.assets}/site-islands.js` : null,
    preview: false,
    path: c.req.path.slice(site.inner.length) || '/',
    sent, error, cancelled,
    referral: CODE_RE.test(code || '') ? code : null,
    ...extra,
  };
};

// Draw (or reuse) a page. key: null for a page never kept (a thank-you, a preview).
// A kept page is kept per address: its canonical and share links name the
// host it was asked for (www or not), so it is only ever that host's.
// The main site's address, as another website links back to it.
const parentUrlOf = (site, settings) => mainAddress(settings, `${site.origin}${site.base}/site`);
// What the renderer gets as `site` (store.js siteOf): the main site's, or
// another website's (site.micro) with its home page and the link back.
const rendererSite = async (site, settings) => {
  if (!site.micro) return siteOf(settings, await menuPages(site.db, site.ws.id), site.ws);
  const home = await livePage(site, 'home');
  return siteOf(settings, await menuPages(site.db, site.ws.id, site.micro.id), site.ws, {
    microsite: site.micro, home: home ? pageFor(home) : null, parentUrl: parentUrlOf(site, settings),
  });
};

// What a page needs to speak a language, and to draw the switch (TR): only
// when the campaign has a language on — an English-only campaign reads
// nothing more.
const languageCtx = async (site, settings, { lang = site.lang, preview = false, checkFirst = false } = {}) => {
  const langs = site.langs || (site.langs = await languagesFor(site.db, site.ws, settings));
  const roots = Object.fromEntries(['en', ...langs.offered].map((code) => [code, `${site.home}${LANG_BY_CODE[code].path}`]));
  const out = { offered: preview ? [] : langs.offered, langRoots: roots, indexed: (langs.offered || []).filter((code) => settings.languages?.index?.[code]) };
  if (!isOther(lang)) return out;
  const row = langs.legal[lang] || null;
  const names = row?.words?.names && typeof row.words.names === 'object' ? row.words.names : {};
  return {
    ...out,
    lang,
    tr: await translatorFor(site.db, site.ws.id, lang),
    legal: { id: row?.id || null, hash: LEGAL_ENGLISH_HASH, words: row?.words || {}, current: Object.keys(row?.words || {}).filter((k) => keyCurrent(row, k)), slots: legalSlots(settings) },
    names,
    checkFirst: checkFirst || Boolean(site.micro?.check_first),
  };
};

// The voter guide's filters from the address (VG decision 19a): ?area= and
// ?day= only when they are this guide's own (then part of the page's key,
// so the pages kept are bounded); ?q= is drawn and never kept; ?near= is
// the island's alone. null when the page holds no guide.
const guideFilter = async (c, site, page) => {
  if (!(page?.modules || []).some((m) => m && !m.hidden && m.kind === 'voterguide')) return null;
  const g = await guideFor(site.db, site.ws);
  const q = (k) => String(c.req.query(k) ?? '').trim();
  const area = g.areas.includes(q('area')) ? q('area') : '';
  const day = g.days.some((d) => d.day === q('day')) || ['today', 'advance', 'general', 'all'].includes(q('day')) ? q('day') : '';
  return { area, day, q: q('q').slice(0, 80) };
};

// Pages being drawn now, by cache key and cacheGen: visitors who ask for
// the same page while it is drawn wait for that one draw (a crowd on a
// page not yet in the cache — the voter guide on voting day — asks the
// database once). A Website action during a draw (a "Closed today"
// correction) starts a new generation: later visitors get a draw of their
// own, and the older draw is never kept.
const DRAWING = new Map();
const draw = async (c, site, { kind, page = null, post = null, campaign = null, key, status, frame = null, ctx: extra = {} }) => {
  const gen = cacheGen();
  const settings = await settingsOf(site);
  const vg = kind === 'page' ? await guideFilter(c, site, page) : null;
  const ctx = ctxOf(c, site, { ...(vg ? { vgFilter: vg } : {}), ...extra });
  const langsOn = (settings.languages?.on || []).length > 0;
  if (langsOn) Object.assign(ctx, await languageCtx(site, settings, { lang: ctx.preview ? extra.lang || 'en' : site.lang, preview: ctx.preview, checkFirst: page?.checkFirst === true }));
  const keep = key && !ctx.sent && !ctx.error && !ctx.cancelled && !ctx.preview && !vg?.q;
  // Per website too: '/' on two hosts is never the same page.
  const micro = site.micro ? [site.micro.id, new Date(site.micro.updated_at).getTime()] : ['', ''];
  const fullKey = keep ? cacheKey(site.ws.id, [site.address, site.root, ...micro, kind, ...key, settings.updated_at, ctx.referral || '', ...(vg ? ['vg', vg.area, vg.day] : [])]) : null;
  let hit = fullKey ? cacheGet(fullKey) : null;
  const drawKey = fullKey && `${fullKey}|${gen}`;
  if (!hit && fullKey && DRAWING.has(drawKey)) hit = await DRAWING.get(drawKey).catch(() => null);
  if (!hit) {
    const drawing = (async () => {
      const now = clockNow();
      const data = await loadData(site.db, site.ws, { posts: kind === 'page' && page?.slug === 'news' ? 200 : 24, now, draft: ctx.preview, siteId: site.micro?.id || null });
      const out = renderSite({ kind, site: await rendererSite(site, settings), page, post, campaign, data, ctx });
      // Kept as bytes: a kept page is sent as it is, not encoded again for
      // each visitor (most of a cache hit's cost under a crowd).
      const drawn = { status: status || out.status || 200, html: Buffer.from(out.html), csp: cspFor(out.html, { preview: ctx.preview, frameAncestors: frame || [] }), geo: / data-module="voterguide"/.test(out.html) };
      // While the guide is published, never served past its next change.
      const g = data.guide;
      const until = g && g.status === 'published' ? guideState(g.times, now, g.places).boundary : null;
      if (fullKey && drawn.status === 200 && cacheGen() === gen) cachePut(fullKey, drawn, { until: until ?? undefined });
      return drawn;
    })();
    if (fullKey) {
      DRAWING.set(drawKey, drawing);
      drawing.catch(() => {}).finally(() => { if (DRAWING.get(drawKey) === drawing) DRAWING.delete(drawKey); });
    }
    hit = await drawing;
  }
  pageHeaders(c, site, { csp: hit.csp, preview: ctx.preview, store: ctx.preview || frame !== null || Boolean(ctx.sent || ctx.error), geo: hit.geo, frame });
  if (langsOn && !ctx.preview) langHeaders(c, site, hit.status);
  return c.body(hit.html, hit.status, { 'Content-Type': 'text/html; charset=UTF-8' });
};

const notFound = (c, site) => draw(c, site, { kind: 'notFound', key: ['404'], status: 404 });

// After a page is drawn (TR decision 33): the switch's prefetch rules; a
// language page remembers its language (never on a prefetch); English's
// ?lang=en forgets it and is never kept by the browser.
const langHeaders = (c, site, status) => {
  if (site.langs?.offered?.length) c.header('Speculation-Rules', `"${site.assets}/lang-rules.json"`);
  if (prefetching(c)) return;
  const path = site.home || '/';
  if (site.lang !== 'en' && status === 200) {
    setCookie(c, LANG_COOKIE, site.lang, { path, maxAge: 365 * 24 * 3600, sameSite: 'Lax', secure: site.https });
  } else if (site.lang === 'en' && c.req.query('lang') === 'en') {
    deleteCookie(c, LANG_COOKIE, { path, secure: site.https });
    c.header('Cache-Control', 'no-store');
  }
};

// A published page of this website (another website's pages are its own).
// Read once until the next Website action (cache.js remember).
const livePage = (site, slug) => remember(site.db, `page|${site.ws.id}|${site.micro?.id || ''}|${slug}`, async () => (await site.db.query(
  `select id, slug, version, published from site_pages where workspace_id = $1 and slug = $2 and deleted_at is null and status = 'published'
     and site_id is not distinct from $3::uuid`,
  [site.ws.id, slug, site.micro?.id || null],
)).rows[0] || null);
// A page's share picture ({ url, alt }), or null: the renderer's og:image
// for the page, before the site's own (seo.shareImage) and the hero's.
const shareOf = (content) => (content?.image?.url ? { url: String(content.image.url), alt: String(content.image.alt || '') } : null);
// A live page as the renderer gets it: a hidden module's words never reach
// the public page at all.
const pageFor = (row) => {
  const p = parseJ(row.published, {}) || {};
  const modules = (Array.isArray(p.modules) ? p.modules : []).filter((m) => m && !m.hidden);
  return { id: row.id, slug: row.slug, title: p.title || '', description: p.description || '', image: shareOf(p), modules, ...(p.checkFirst === true ? { checkFirst: true } : {}) };
};

// /news with no news page: the posts, newest first.
const NEWS_PAGE = { id: null, slug: 'news', title: 'News', description: '', modules: [{ id: 'news-all', kind: 'news', hidden: false, props: checkProps('news', { title: 'News', limit: 24 }) }] };

// ── Plain pages of the site's own (preferences, unsubscribe, a link that
// expired): the campaign's name and colours, one column, one button. ──
// Every one carries "Authorized by …"; another website's (coming soon) its
// own name and look and the link back; closed: the main site's, home is
// the main site.
// pl: the page's language, for a supporter's own pages (TR decision 40):
// { lang, w, auth } — its words, and "Authorized by" in it as approved.
const plainPage = (site, settings, { title, body, status = 200, closed = false, back = true, pl = null, langs = '' }) => {
  const parentUrl = site.micro || closed ? parentUrlOf(site, settings) : null;
  const s = siteOf(settings, [], site.ws, site.micro && !closed ? { microsite: site.micro, home: null, parentUrl } : null);
  const mainName = settings.org.name || site.ws.name;
  const org = closed ? mainName : s.site?.name || s.org.name || site.ws.name;
  const home = closed ? parentUrl : `${site.root}/`;
  const auth = authorizedBy(settings.org);
  const html = `<!doctype html><html lang="${pl ? esc(pl.lang) : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · ${esc(org)}</title>
<style>${themeCss(s.theme)}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--ink);font:18px/1.55 var(--font-body)}
.top{background:var(--brand);color:var(--brand-ink);padding:18px 16px}
.top a{color:inherit;font:700 20px/1.2 var(--font-heading);text-decoration:none}
.top a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
main{max-width:560px;margin:0 auto;padding:32px 16px 64px}
h1{font:800 30px/1.15 var(--font-heading);margin:0 0 14px;overflow-wrap:anywhere}
p{margin:0 0 14px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin:20px 0}
.check{display:flex;gap:14px;align-items:flex-start;min-height:48px;padding:12px 0;font-size:17px;cursor:pointer}
.check+.check{border-top:1px solid var(--line)}
.check input{width:26px;height:26px;flex:none;margin:1px 0 0;accent-color:var(--brand)}
.check b{display:block}
.check:has(input:disabled){cursor:default}
.check input:disabled{opacity:.55}
.hint{display:block;font-size:15px;opacity:.8;margin-top:2px}
button{display:block;width:100%;min-height:52px;margin-top:20px;border:0;border-radius:var(--radius);background:var(--brand);color:var(--brand-ink);font:700 17px/1.2 var(--font-body);cursor:pointer;padding:14px 20px}
button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--link);outline-offset:3px}
.done{border-left:5px solid var(--brand)}
.share{word-break:break-all;font-weight:700}
a{color:var(--link)}
.more{margin-top:16px}
.more a,footer a{display:inline-flex;align-items:center;min-height:48px}
.langs{display:flex;justify-content:flex-end;gap:2px;padding:6px 16px;background:var(--paper);border-bottom:1px solid var(--line)}
.langs a{display:inline-flex;align-items:center;justify-content:center;min-height:48px;min-width:64px;padding:0 12px;border-radius:999px;color:var(--ink);font:600 16px/1.2 var(--font-body);text-decoration:none}
.langs a[aria-current="true"]{background:var(--brand);color:var(--brand-ink)}
@media (max-width:640px){.langs a{flex:1 1 0;min-width:0;padding:0 4px}}
footer{margin-top:28px;font-size:15px}
footer p{margin:8px 0 0}
</style></head><body>
${langs}<header class="top"><a href="${esc(home)}">${esc(org)}</a></header>
<main id="main">${body}
<footer>${closed || !back ? '' : `<a href="${esc(home)}">${pl ? esc(pl.w('plain.back', { org })) : `Back to ${esc(org)}`}</a>`}${parentUrl ? `<p class="by">${pl ? esc(pl.w('plain.websiteBy')) : 'A website by'} <a href="${esc(parentUrl)}">${esc(mainName)}</a></p>` : ''}${auth ? `<p class="auth"${pl ? ' lang="en"' : ''}>${esc(auth)}</p>` : ''}${pl?.auth ? `<p class="auth" lang="${esc(pl.lang)}">${esc(pl.auth)}</p>` : ''}</footer></main></body></html>`;
  return { html, status };
};
const sendPlain = (c, site, settings, page, { preview = false } = {}) => {
  const { html, status } = plainPage(site, settings, page);
  pageHeaders(c, site, { csp: cspFor(html, { preview }), preview, store: true });
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.html(html, status);
};

// The language switch on a supporter's own page (preferences, unsubscribe):
// the same page, the token kept, in each language the site offers.
const plainSwitch = async (site, settings, path, t, current) => {
  if (!(settings.languages?.on || []).length) return '';
  const offered = (await languagesFor(site.db, site.ws, settings)).offered;
  if (!offered.length) return '';
  const link = (code) => `${site.root}${path}?t=${encodeURIComponent(t)}&lang=${code}`;
  return `<nav class="langs" aria-label="Language · ਭਾਸ਼ਾ · 语言 · 語言">${['en', ...offered].map((code) => `<a href="${esc(link(code))}" hreflang="${esc(code)}" lang="${esc(code)}"${code === current ? ' aria-current="true"' : ''}>${esc(labelFor(code, offered))}</a>`).join('')}</nav>`;
};

const personOfToken = async (site, t) => {
  const claims = await verify('person', t);
  if (!claims || claims.w !== site.ws.id || !UUID.test(String(claims.p || ''))) return null;
  const p = (await site.db.query(
    'select id, name, email, phone, tags, attrs from persons where id = $1 and workspace_id = $2 and deleted_at is null', [claims.p, site.ws.id],
  )).rows[0];
  if (p) return p;
  // Merged into another record since the email went out: that one.
  const into = (await site.db.query(
    "select attrs->>'merged_into' as id from persons where id = $1 and workspace_id = $2", [claims.p, site.ws.id],
  )).rows[0]?.id;
  if (!UUID.test(String(into || ''))) return null;
  return (await site.db.query(
    'select id, name, email, phone, tags, attrs from persons where id = $1 and workspace_id = $2 and deleted_at is null', [into, site.ws.id],
  )).rows[0] || null;
};
const badLink = (c, site, settings, pl = null) => sendPlain(c, site, settings, {
  title: pl ? pl.w('plain.expiredTitle') : 'This link has expired',
  body: pl ? `<h1>${esc(pl.w('plain.expired'))}</h1><p>${esc(pl.w('plain.expiredBody'))}</p>`
    : `<h1>This link doesn’t work any more</h1><p>Links in our emails stop working after a while. Use the link in a newer email from us, or reply to one and we’ll change it for you.</p>`,
  status: 404,
  pl,
});

// The language a supporter's own page is in (TR decision 40): ?lang=, else
// the language they last read the site in — when it is offered; else none
// (English). Its words, its approved legal words and the form's legal_v.
const plainLanguage = async (c, site, settings) => {
  const want = String(c.req.query('lang') || getCookie(c, LANG_COOKIE) || '');
  if (!isOther(want) || !(settings.languages?.on || []).includes(want)) return null;
  const langs = await languagesFor(site.db, site.ws, settings);
  if (!langs.offered.includes(want)) return null;
  const tr = await translatorFor(site.db, site.ws.id, want);
  const row = langs.legal[want];
  const slots = legalSlots(settings);
  const w = (key, sl) => fillWords(tr.look(UI_WORDS[key] ?? key).text, sl);
  const legal = (key) => legalWords(row, want, key, slots);
  const auth = legal('authorizedBy');
  return { lang: want, w, legal, row, legalV: `${row.id}.${LEGAL_ENGLISH_HASH}`, auth: auth.lang === want ? auth.text : '' };
};

// A token for a supporter's own choices, for the links in emails:
// {site}/preferences?t=… and {site}/unsubscribe?t=… (SITE.md).
export const personToken = (workspaceId, personId) => sign('person', { w: workspaceId, p: personId }, PERSON_TTL);

const choicesBody = (site, person, choices, { t, saved = null, code = null, wording, pl = null }) => {
  if (pl) return choicesBodyIn(site, person, choices, { t, saved, code, pl });
  const box = (name, on, label, hint, disabled = false) => `<label class="check"><input type="checkbox" name="${name}" value="on"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}><span><b>${esc(label)}</b><span class="hint">${esc(hint)}</span></span></label>`;
  return `<h1>Your email and texts</h1>
${saved ? `<div class="card done" role="status"><p><b>Saved.</b> ${esc(saved)}</p></div>` : ''}
<p>Choose what ${esc(person.email || person.phone || 'you')} gets from us.</p>
<form method="post" class="card">
<input type="hidden" name="t" value="${esc(t)}">
${box('email', choices.email, 'Email', person.email ? wording.email : 'We don’t have an email address for you.', !person.email)}
${box('sms', choices.sms, 'Texts', person.phone ? wording.sms : 'We don’t have a mobile number for you.', !person.phone)}
<button type="submit">Save my choices</button>
</form>
${code ? `<div class="card"><p><b>Your link to share</b></p><p>When someone signs up through it, we know you brought them in:</p><p class="share">${esc(site.address)}${esc(site.root)}/r/${esc(code)}</p></div>` : ''}`;
};
// The same page in a supporter's language: its consent lines the approved
// words (or the English, lang="en"), and the form names them (legal_v).
const choicesBodyIn = (site, person, choices, { t, saved, code, pl }) => {
  const W = (k, sl) => esc(pl.w(k, sl));
  const box = (name, on, label, hint, hintLang, disabled = false) => `<label class="check"><input type="checkbox" name="${name}" value="on"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}><span><b>${label}</b><span class="hint"${hintLang ? ` lang="${esc(hintLang)}"` : ''}>${esc(hint)}</span></span></label>`;
  const em = pl.legal('email');
  const sm = pl.legal('sms');
  return `<h1>${W('plain.choicesTitle')}</h1>
${saved ? `<div class="card done" role="status"><p><b>${W('plain.saved')}</b> ${esc(saved)}</p></div>` : ''}
<p>${W('plain.choose', { who: person.email || person.phone || pl.w('plain.you') })}</p>
<form method="post" class="card">
<input type="hidden" name="t" value="${esc(t)}">
<input type="hidden" name="legal_v" value="${esc(pl.legalV)}">
${box('email', choices.email, W('plain.email'), person.email ? em.text : pl.w('plain.noEmail'), person.email && em.lang === 'en' ? 'en' : null, !person.email)}
${box('sms', choices.sms, W('plain.texts'), person.phone ? sm.text : pl.w('plain.noPhone'), person.phone && sm.lang === 'en' ? 'en' : null, !person.phone)}
<button type="submit">${W('plain.save')}</button>
</form>
${code ? `<div class="card"><p><b>${W('plain.shareLink')}</b></p><p>${W('plain.shareHint')}</p><p class="share">${esc(site.address)}${esc(site.root)}/r/${esc(code)}</p></div>` : ''}`;
};

const sitemapXml = (rows, alt = null) => {
  if (!alt) return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.map(([u, d]) => `<url><loc>${esc(u)}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
  // One <url> per indexed address, each listing every language's address
  // of the same page (itself included) and English as the default.
  const out = [];
  for (const [u, d] of rows) {
    const rel = u.slice(alt.at.length) || '/';
    const set = alt.codes.map((code) => [code, `${alt.roots[code]}${rel}`]);
    const links = [...set, ['x-default', set[0][1]]].map(([code, href]) => `<xhtml:link rel="alternate" hreflang="${esc(code)}" href="${esc(href)}"/>`).join('');
    for (const [, href] of set) out.push(`<url><loc>${esc(href)}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}${links}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${out.join('\n')}\n</urlset>\n`;
};
// The languages a sitemap lists: English and each offered one search may list.
const sitemapLanguages = async (site) => {
  const settings = await settingsOf(site);
  if (!(settings.languages?.on || []).length) return null;
  const { offered } = await languagesFor(site.db, site.ws, settings);
  const codes = ['en', ...offered.filter((code) => settings.languages.index?.[code])];
  if (codes.length < 2) return null;
  const at = `${site.address}${site.root}`;
  return { at, codes, roots: Object.fromEntries(codes.map((code) => [code, `${at}${LANG_BY_CODE[code].path}`])) };
};
const langDisallows = async (site) => {
  const settings = await settingsOf(site);
  if (!(settings.languages?.on || []).length) return '';
  const { offered } = await languagesFor(site.db, site.ws, settings);
  return offered.map((code) => `Disallow: ${site.root}${LANG_BY_CODE[code].path}/api/\nDisallow: ${site.root}${LANG_BY_CODE[code].path}/r/\n`).join('');
};

// A closed website's address (a deleted one's, or one it no longer uses):
// it says so, with who it was by and the main site — never the app, so a
// sign-in page never answers on a domain that once was a website.
const closedPage = async (c, site) => {
  const settings = await settingsOf(site);
  return sendPlain(c, site, settings, {
    title: 'This website has closed',
    body: '<h1>This website has closed</h1><p>It isn’t taking sign-ups any more.</p>',
    status: 410,
    closed: true,
  });
};

// ── The site's routes, at a root ('' on its own domain, '/site' elsewhere) ──
// The campaigns whose website is set up (ensureSite): asked once a process.
const SEEDED = new WeakMap(); // db → Set of workspace ids
export const makeSiteApp = (at) => {
  const app = new Hono();
  const R = at.root;
  const route = (p) => `${R}${p}`;
  // The campaign this request is for, made on first use.
  app.use('*', async (c, next) => {
    const site = await siteFor(c, at);
    if (!site) return c.text('This site isn’t set up yet.', 503);
    const seeded = SEEDED.get(site.db) || SEEDED.set(site.db, new Set()).get(site.db);
    if (!seeded.has(site.ws.id)) { await ensureSite(site.db, site.ws); seeded.add(site.ws.id); }
    // One address per page: /donate/ → /donate. Always on this site: the
    // slashes in front collapse to one, so '//other.host/' is a path here
    // and never a link to another site; and the path goes back as it came,
    // still encoded. A tab, a line break or a backslash in it (%09, %0A,
    // %5C), which a browser drops or reads as '/', is no page: the 404.
    const p = c.req.path;
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && p.length > 1 && p.endsWith('/') && p !== `${R}/`) {
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f\\]/.test(p)) return notFound(c, site);
      const url = new URL(c.req.url);
      return c.redirect(`${site.base}/${url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')}${url.search}`, 301);
    }
    // Another website of the campaign: at its own domain (at.siteId), or
    // at /site/sites/<key>/ on the app's address (at.siteKey).
    if (at.siteId || at.siteKey) {
      const m = (await site.db.query(
        at.siteId ? 'select * from microsites where workspace_id = $1 and id = $2'
          : 'select * from microsites where workspace_id = $1 and key = $2 and deleted_at is null',
        [site.ws.id, at.siteId || at.siteKey],
      )).rows[0];
      if (!m || m.deleted_at) {
        // Gone: its domain is closed (the gate says so first); on the
        // app's address, the main site's page not found.
        if (at.siteId) return closedPage(c, site);
        Object.assign(site, { inner: '/site', root: `${site.base}/site` });
        c.set('site', site);
        return notFound(c, site);
      }
      site.micro = { ...m, domains: parseJ(m.domains, []) };
      const rel = p.slice(R.length) || '/';
      // Not live yet (or taken offline): "Coming soon" on every route but
      // its files and the admin's preview of a draft.
      if (m.status !== 'live' && !/^\/(site-assets|__preview)\//.test(rel)) {
        const settings = await settingsOf(site);
        return sendPlain(c, site, settings, {
          title: 'Coming soon',
          body: `<h1>Coming soon</h1><p>${esc(m.name)} isn’t open yet. Please come back soon.</p>`,
          back: false,
        });
      }
      // The main site's own: news, the list of petitions, a supporter's
      // email choices (emails always link to the main site's).
      if (/^\/(news|act|preferences|unsubscribe)$|^\/news\//.test(rel)) {
        c.set('site', site);
        return notFound(c, site);
      }
    }
    // A language app (TR decisions 5–6): its language must be offered —
    // else every GET goes to the same page in English and a form post is
    // refused with nothing kept. Its site's own pages (robots, sitemap, a
    // supporter's choices, a preview) aren't under a language.
    if (site.lang !== 'en') {
      const rel = p.slice(R.length) || '/';
      const settings = await settingsOf(site);
      site.langs = await languagesFor(site.db, site.ws, settings);
      if (!site.langs.offered.includes(site.lang)) {
        if (c.req.method === 'GET' || c.req.method === 'HEAD') {
          // Always on this site, as the trailing-slash redirect above: on
          // the campaign's own domain home is '', so '/pa//other.host' must
          // not become '//other.host'. A tab, a line break or a backslash
          // is no page.
          // eslint-disable-next-line no-control-regex
          if (/[\u0000-\u001f\u007f\\]/.test(rel)) return notFound(c, site);
          const url = new URL(c.req.url);
          c.header('Cache-Control', 'no-store');
          return c.redirect(`${site.home}${rel.replace(/^\/+/, '/')}${url.search}`, 302);
        }
        return c.json({ error: 'This page changed — please reload it and send again' }, 400);
      }
      if (/^\/(robots\.txt|sitemap\.xml|preferences|unsubscribe)$|^\/__preview\//.test(rel)) {
        c.set('site', site);
        return notFound(c, site);
      }
    }
    // The app's own copy of a site that has a domain of its own isn't indexed.
    // Its root without the language says which: '' on a domain (/pa there
    // is the real site in Punjabi), '/site…' on the app's address.
    const appCopy = Boolean(at.home ?? R);
    if (appCopy && site.micro) site.mirror = site.micro.domains.length > 0;
    else if (appCopy) {
      const domains = (await settingsOf(site))?.domains;
      site.mirror = Boolean(String(process.env.SITE_HOSTS || '').trim()) || (Array.isArray(domains) && domains.length > 0);
    }
    c.set('site', site);
    await next();
  });

  app.get(route('/site-assets/*'), serveAsset);

  app.get(route('/robots.txt'), async (c) => {
    const site = c.get('site');
    const body = staging()
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nDisallow: ${site.root}/__preview/\nDisallow: ${site.root}/api/\nDisallow: ${site.root}/preferences\nDisallow: ${site.root}/unsubscribe\nDisallow: ${site.root}/r/\n${await langDisallows(site)}\nSitemap: ${site.address}${site.root}/sitemap.xml\n`;
    return c.text(body, 200, { 'Cache-Control': 'public, max-age=3600' });
  });

  app.get(route('/sitemap.xml'), async (c) => {
    const site = c.get('site');
    const at2 = `${site.address}${site.root}`;
    const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const rows = [];
    for (const p of (await site.db.query(
      `select slug, coalesce(published_at, updated_at) as at from site_pages where workspace_id = $1 and deleted_at is null and status = 'published'
         and site_id is not distinct from $2::uuid order by nav_order, created_at`,
      [site.ws.id, site.micro?.id || null],
    )).rows) rows.push([p.slug === 'home' ? `${at2}/` : `${at2}/${p.slug}`, day(p.at)]);
    // Each indexed language: its own <url> per page, every <url> with the
    // full set of alternates (TR decision 30).
    const alt = await sitemapLanguages(site);
    // Another website: its own pages only.
    if (site.micro) return c.body(sitemapXml(rows, alt), 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
    if (!rows.some(([u]) => u === `${at2}/news`)) rows.push([`${at2}/news`, null]);
    for (const p of (await site.db.query(
      "select slug, coalesce(updated_at, published_at) as at from site_posts where workspace_id = $1 and deleted_at is null and status = 'published' and published_at <= now() order by published_at desc limit 5000",
      [site.ws.id],
    )).rows) rows.push([`${at2}/news/${p.slug}`, day(p.at)]);
    for (const p of (await site.db.query(
      "select slug, updated_at as at from site_campaigns where workspace_id = $1 and deleted_at is null and status = 'open' order by created_at",
      [site.ws.id],
    )).rows) rows.push([`${at2}/act/${p.slug}`, day(p.at)]);
    return c.body(sitemapXml(rows, alt), 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
  });

  // A referral link: remembered 30 days (the forms credit them), then home.
  // With ?k=<kit code> (a share kit, ext/socials/share.js, open or stopped)
  // the post is remembered too (site_src, which forms.js reads when a form
  // sends no source of its own) and the link opens the kit's page.
  app.get(route('/r/:code'), async (c) => {
    const site = c.get('site');
    const code = String(c.req.param('code') || '').toLowerCase();
    // On the site's root without the language: a share opened in Punjabi
    // credits a sign-up on an English page, and the reverse.
    const keep = { path: site.home || '/', maxAge: REF_DAYS * 24 * 3600, httpOnly: true, sameSite: 'Lax', secure: site.https };
    // Any well-formed code is remembered, known or not: a form's answer hands
    // someone already on file a decoy code, and following it must look the
    // same as following a real one. An unknown code credits nobody (forms.js
    // finds no one for it at POST time).
    if (CODE_RE.test(code)) setCookie(c, REF_COOKIE, code, keep);
    const k = String(c.req.query('k') || '').toLowerCase();
    const kit = KIT_CODE_RE.test(k)
      ? (await site.db.query('select code, path from share_kits where workspace_id = $1 and code = $2 and deleted_at is null', [site.ws.id, k])).rows[0]
      : null;
    c.header('Cache-Control', 'no-store');
    if (!kit || !goodPath(kit.path)) return c.redirect(`${site.root}/`, 302);
    const source = `kit-${kit.code}`;
    setCookie(c, SRC_COOKIE, source, keep);
    return c.redirect(withSource(`${site.root}${kit.path}`, source), 302);
  });

  app.post(route('/api/forms/:kind'), (c) => formRoute(c, c.get('site')));

  // ── Their own email and text choices (a signed link from an email) ──
  const preferences = async (c, saved = null) => {
    const site = c.get('site');
    const settings = await settingsOf(site);
    const pl = await plainLanguage(c, site, settings);
    const t = c.req.query('t') || '';
    const person = await personOfToken(site, t);
    if (!person) return badLink(c, site, settings, pl);
    const choices = await choicesOf(site.db, site.ws.id, person);
    const code = parseJ(person.attrs, {})?.ref_code || null;
    return sendPlain(c, site, settings, {
      title: pl ? pl.w('plain.choicesTitle') : 'Your email and texts',
      body: choicesBody(site, person, choices, { t, saved, code, wording: consentWording(settings.org, settings.seo), pl }),
      pl,
      langs: await plainSwitch(site, settings, '/preferences', t, pl?.lang || 'en'),
    });
  };
  app.get(route('/preferences'), (c) => preferences(c));
  app.post(route('/preferences'), async (c) => {
    const site = c.get('site');
    const form = await c.req.parseBody().catch(() => ({}));
    const t = String(form.t || c.req.query('t') || '');
    const settings = await settingsOf(site);
    const pl = await plainLanguage(c, site, settings);
    const person = await personOfToken(site, t);
    if (!person) return badLink(c, site, settings, pl);
    // In a supporter's language: the words their page named (legal_v), as it drew them.
    let shown = null;
    if (pl) {
      const m = /^([0-9a-f-]{36})\.([0-9a-f]{12})$/i.exec(String(form.legal_v || ''));
      const row = m && m[2] === LEGAL_ENGLISH_HASH ? await legalRowOf(site, m[1]) : null;
      if (!row || row.lang !== pl.lang) return sendPlain(c, site, settings, { title: pl.w('plain.choicesTitle'), body: `<h1>${esc(pl.w('plain.choicesTitle'))}</h1><p>${esc(pl.w('form.reload'))}</p>`, status: 400, pl });
      const slots = legalSlots(settings);
      const one = (key) => { const x = legalWords(row, pl.lang, key, slots); return { wording: x.text, lang: x.lang, wordingEn: legalWords(null, 'en', key, slots).text }; };
      shown = { email: one('email'), sms: one('sms') };
    }
    const before = await choicesOf(site.db, site.ws.id, person);
    const want = { email: form.email === 'on' && Boolean(person.email), sms: form.sms === 'on' && Boolean(person.phone) };
    const wording = consentWording(settings.org, settings.seo);
    await runAction(site.db, { workspaceId: site.ws.id, actorId: null, action: 'site.preferences' }, async (tx, emit) => {
      const ws = site.ws.id;
      // On: when it isn't. Off: unless it's off already — a save that only
      // changes their texts leaves no second "no" to email on the record.
      if (person.email && (want.email ? !before.email : !before.emailOff)) {
        await (want.email ? emailOn : emailOff)(tx, ws, { personId: person.id, name: person.name, email: person.email, source: 'preferences', wording: wording.email, ...(shown?.email || {}) }, emit);
      }
      if (person.phone && (want.sms ? !before.sms : !before.smsOff)) {
        await (want.sms ? smsOn : smsOff)(tx, ws, { personId: person.id, phone: person.phone, source: 'preferences', wording: wording.sms, ...(shown?.sms || {}) }, emit);
      }
      await refCodeFor(tx, ws, person.id, emit);
    });
    if (pl) {
      const words = [
        ...(person.email ? [pl.w(want.email ? 'plain.getEmails' : 'plain.noEmails')] : []),
        ...(person.phone ? [pl.w(want.sms ? 'plain.textsOn' : 'plain.noTexts')] : []),
      ].join(', ');
      return preferencesAfter(c, site, settings, t, words ? `${words}.` : pl.w('plain.nothing'), pl);
    }
    const words = [
      ...(person.email ? [want.email ? 'You’ll get our emails' : 'No emails'] : []),
      ...(person.phone ? [want.sms ? 'texts are on' : 'no texts'] : []),
    ].join(', ');
    return preferencesAfter(c, site, settings, t, words ? `${words[0].toUpperCase()}${words.slice(1)}.` : 'Nothing to change.');
  });
  const preferencesAfter = async (c, site, settings, t, saved, pl = null) => {
    const person = await personOfToken(site, t);
    const choices = await choicesOf(site.db, site.ws.id, person);
    const code = parseJ((await site.db.query('select attrs from persons where id = $1', [person.id])).rows[0]?.attrs, {})?.ref_code || null;
    return sendPlain(c, site, settings, {
      title: pl ? pl.w('plain.choicesTitle') : 'Your email and texts',
      body: choicesBody(site, person, choices, { t, saved, code, wording: consentWording(settings.org, settings.seo), pl }),
      pl,
    });
  };

  // One-step unsubscribe from email. Opening it only asks (mail scanners
  // open links by themselves); the button — or a mail app's one-click
  // unsubscribe (List-Unsubscribe-Post) — does it.
  app.get(route('/unsubscribe'), async (c) => {
    const site = c.get('site');
    const settings = await settingsOf(site);
    const pl = await plainLanguage(c, site, settings);
    const t = c.req.query('t') || '';
    const person = await personOfToken(site, t);
    if (!person || !person.email) return badLink(c, site, settings, pl);
    const org = settings.org.name || site.ws.name;
    const q = `t=${esc(encodeURIComponent(t))}${pl ? `&amp;lang=${esc(pl.lang)}` : ''}`;
    const langs = await plainSwitch(site, settings, '/unsubscribe', t, pl?.lang || 'en');
    if (pl) {
      return sendPlain(c, site, settings, {
        title: pl.w('plain.unsubTitle'),
        body: `<h1>${esc(pl.w('plain.unsubAsk', { org }))}</h1><p>${esc(pl.w('plain.unsubWont', { email: person.email }))}</p>
<form method="post" action="${esc(site.root)}/unsubscribe?${q}"><input type="hidden" name="t" value="${esc(t)}"><button type="submit">${esc(pl.w('plain.unsubButton'))}</button></form>
<p class="more"><a href="${esc(site.root)}/preferences?${q}">${esc(pl.w('plain.chooseInstead'))}</a></p>`,
        pl,
        langs,
      });
    }
    return sendPlain(c, site, settings, {
      title: 'Unsubscribe',
      body: `<h1>Stop emails from ${esc(org)}?</h1><p>${esc(person.email)} won’t get our newsletters or other emails.</p>
<form method="post" action="${esc(site.root)}/unsubscribe?t=${esc(encodeURIComponent(t))}"><input type="hidden" name="t" value="${esc(t)}"><button type="submit">Unsubscribe</button></form>
<p class="more"><a href="${esc(site.root)}/preferences?t=${esc(encodeURIComponent(t))}">Choose what you get instead</a></p>`,
      langs,
    });
  });
  app.post(route('/unsubscribe'), async (c) => {
    const site = c.get('site');
    const form = await c.req.parseBody().catch(() => ({}));
    const t = String(form.t || c.req.query('t') || '');
    const settings = await settingsOf(site);
    const pl = await plainLanguage(c, site, settings);
    const person = await personOfToken(site, t);
    if (!person || !person.email) return badLink(c, site, settings, pl);
    const now = await choicesOf(site.db, site.ws.id, person);
    if (!now.emailOff) {
      await runAction(site.db, { workspaceId: site.ws.id, actorId: null, action: 'site.unsubscribe' }, (tx, emit) => emailOff(tx, site.ws.id, {
        personId: person.id, email: person.email, source: 'unsubscribe-link',
      }, emit));
    }
    const org = settings.org.name || site.ws.name;
    if (pl) {
      const q = `t=${esc(encodeURIComponent(t))}&amp;lang=${esc(pl.lang)}`;
      return sendPlain(c, site, settings, {
        title: pl.w('plain.unsubDoneTitle'),
        body: `<h1>${esc(pl.w('plain.unsubDone'))}</h1><div class="card done" role="status"><p>${esc(pl.w('plain.unsubDoneBody', { email: person.email, org }))}</p></div>
<p class="more"><a href="${esc(site.root)}/preferences?${q}">${esc(pl.w('plain.changeMind'))}</a></p>`,
        pl,
      });
    }
    return sendPlain(c, site, settings, {
      title: 'Unsubscribed',
      body: `<h1>You’re unsubscribed</h1><div class="card done" role="status"><p>${esc(person.email)} won’t get emails from ${esc(org)} any more.</p></div>
<p class="more"><a href="${esc(site.root)}/preferences?t=${esc(encodeURIComponent(t))}">Change your mind, or your texts</a></p>`,
    });
  });

  // A draft, for the admin's preview (a signed link that lasts half an hour).
  app.get(route('/__preview/:pageId'), async (c) => {
    const site = c.get('site');
    const id = c.req.param('pageId');
    const claims = UUID.test(id) ? await verify('preview', c.req.query('t')) : null;
    const row = claims && claims.w === site.ws.id && claims.p === id
      ? (await site.db.query(
        'select id, slug, title, description, draft, published from site_pages where id = $1 and workspace_id = $2 and deleted_at is null and site_id is not distinct from $3::uuid',
        [id, site.ws.id, site.micro?.id || null],
      )).rows[0]
      : null;
    // A link made for someone with only Website translations draws the
    // published page, never the draft.
    if (!row || (claims.live && !row.published)) {
      const settings = await settingsOf(site);
      return sendPlain(c, site, settings, {
        title: 'Preview expired',
        body: '<h1>This preview has expired</h1><p>Open the preview again from Website in base.win.</p>',
        status: 403,
      }, { preview: true });
    }
    const d = parseJ(claims.live ? row.published : row.draft, {}) || {};
    const page = { id: row.id, slug: row.slug, title: d.title || row.title, description: d.description || '', image: shareOf(d), modules: Array.isArray(d.modules) ? d.modules : [], ...(d.checkFirst === true ? { checkFirst: true } : {}) };
    // ?lang=pa: the draft with that language's words so far (one that is on).
    const settings = await settingsOf(site);
    const want = String(c.req.query('lang') || '');
    const lang = isOther(want) && (settings.languages?.on || []).includes(want) ? want : 'en';
    return draw(c, site, { kind: 'page', page, key: null, ctx: { preview: true, lang } });
  });

  // ── Pages ──
  const home = async (c) => {
    const site = c.get('site');
    // Only the home page, only a plain visit: a visitor who last read the
    // site in another language lands in it again (decided before the cache;
    // nothing reads Accept-Language, so a crawler always gets English).
    const remembered = getCookie(c, LANG_COOKIE);
    if (site.lang === 'en' && isOther(remembered) && !new URL(c.req.url).search && c.req.method === 'GET') {
      const settings = await settingsOf(site);
      if ((settings.languages?.on || []).includes(remembered)) {
        site.langs = site.langs || await languagesFor(site.db, site.ws, settings);
        if (site.langs.offered.includes(remembered)) {
          c.header('Cache-Control', 'no-store');
          return c.redirect(`${site.home}${LANG_BY_CODE[remembered].path}/`, 302);
        }
      }
    }
    const row = await livePage(site, 'home');
    if (!row) return notFound(c, site);
    return draw(c, site, { kind: 'page', page: pageFor(row), key: ['page', row.id, row.version] });
  };
  app.get(route('/'), home);
  if (R) app.get(R, home);

  app.get(route('/news'), async (c) => {
    const site = c.get('site');
    const row = await livePage(site, 'news');
    return draw(c, site, { kind: 'page', page: row ? pageFor(row) : NEWS_PAGE, key: ['page', row?.id || 'news', row?.version || 0] });
  });
  app.get(route('/news/:slug'), async (c) => {
    const site = c.get('site');
    const r = (await site.db.query(
      `select id, slug, title, excerpt, body, image, published_at, updated_at from site_posts
        where workspace_id = $1 and slug = $2 and deleted_at is null and status = 'published' and published_at <= now()`,
      [site.ws.id, c.req.param('slug')],
    )).rows[0];
    if (!r) return notFound(c, site);
    const post = { id: r.id, slug: r.slug, title: r.title, excerpt: r.excerpt || '', body: r.body || '', image: parseJ(r.image, {}) || {}, published_at: new Date(r.published_at).toISOString() };
    return draw(c, site, { kind: 'post', post, key: ['post', r.id, new Date(r.updated_at).getTime()] });
  });

  // Every open petition and pledge, each with its form.
  app.get(route('/act'), async (c) => {
    const site = c.get('site');
    const open = (await site.db.query(
      "select id, kind from site_campaigns where workspace_id = $1 and deleted_at is null and status = 'open' order by created_at", [site.ws.id],
    )).rows;
    const page = {
      id: null, slug: 'act', title: 'Take action', description: '',
      modules: [
        { id: 'act-head', kind: 'text', hidden: false, props: checkProps('text', { title: 'Take action', body: open.length ? '' : 'Nothing is open to sign right now.', tone: 'brand' }) },
        ...open.map((x) => ({ id: `act-${x.id}`, kind: 'petition', hidden: false, props: checkProps('petition', { campaign: x.id, eyebrow: x.kind === 'pledge' ? 'Pledge' : 'Petition' }) })),
      ],
    };
    return draw(c, site, { kind: 'page', page, key: ['act', open.map((x) => x.id).join(',')] });
  });
  app.get(route('/act/:slug'), async (c) => {
    const site = c.get('site');
    const r = (await site.db.query(
      `select c.id, c.slug, c.kind, c.title, c.excerpt, c.body, c.statement, c.goal, c.status, c.updated_at,
              (select count(distinct a.person_id)::int from site_actions a where a.workspace_id = c.workspace_id and a.campaign_id = c.id and a.kind in ('petition', 'pledge')) as count
         from site_campaigns c where c.workspace_id = $1 and c.slug = $2 and c.deleted_at is null`,
      [site.ws.id, c.req.param('slug')],
    )).rows[0];
    if (!r) return notFound(c, site);
    const campaign = {
      id: r.id, slug: r.slug, kind: r.kind, title: r.title, excerpt: r.excerpt || '', body: r.body || '', statement: r.statement || '',
      goal: r.goal == null ? null : Number(r.goal), count: r.count, status: r.status,
    };
    return draw(c, site, { kind: 'campaign', campaign, key: ['campaign', r.id, new Date(r.updated_at).getTime()] });
  });

  // Calendars (calendar.js): the Events list as one calendar, and one event
  // from either list — only where this site lists them, else its 404.
  // Registered before /:slug. The description's last line is the site's
  // authorization line, when one is set.
  const icsRoute = (idOf) => async (c) => {
    const site = c.get('site');
    const id = idOf(c);
    if (id === false) return notFound(c, site);
    const org = siteOf(await settingsOf(site), [], site.ws).org;
    const out = await eventsCalendar(site, { name: org.name || site.ws.name, authorization: org.authorization }, { id });
    if (!out) return notFound(c, site);
    return c.body(out.body, 200, calendarHeaders(out.filename, staging() || site.mirror));
  };
  app.get(route('/events.ics'), icsRoute(() => null));
  app.get(route('/events/:file{[0-9a-f-]{36}\\.ics}'), icsRoute((c) => {
    const id = c.req.param('file').slice(0, -4);
    return UUID.test(id) ? id : false;
  }));

  // The voter guide (VG): the server's clock, an address looked up and
  // forgotten, and the guide alone for another website's frame.
  app.get(route('/api/guide/clock'), clockRoute);
  app.post(route('/api/guide/find'), async (c) => {
    const site = c.get('site');
    const tr = site.lang !== 'en' ? await translatorFor(site.db, site.ws.id, site.lang) : null;
    const w = (k) => { const en = UI_WORDS[k]; const r = tr ? tr.look(en) : null; return r && r.lang !== 'en' ? r.text : en; };
    return findRoute(c, site, w);
  });
  app.get(route('/embed/voter-guide'), async (c) => {
    const site = c.get('site');
    const g = await guideFor(site.db, site.ws);
    const at = g.pages.find((p) => (p.site_id || null) === (site.micro?.id || null)) || null;
    const module = at?.module || { id: 'voter-guide', kind: 'voterguide', hidden: false, props: {} };
    const page = { id: at?.id || null, slug: at?.slug || 'voter-guide', title: '', description: '', modules: [module] };
    // Kept like any page (on voting day the crowd may come through a
    // WordPress page that frames it). The saved addresses are in the key,
    // so a change of them is in the next answer: its kept frame-ancestors
    // can never be another list's.
    const frame = g.embed_origins || [];
    return draw(c, site, {
      kind: 'page', page, key: ['embed', at?.id || '', JSON.stringify(frame)], frame,
      ctx: { embed: true, ...(at ? { path: at.slug === 'home' ? '/' : `/${at.slug}` } : {}) },
    });
  });

  app.get(route('/:slug'), async (c) => {
    const site = c.get('site');
    const slug = c.req.param('slug');
    const row = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug) && slug !== 'home' ? await livePage(site, slug) : null;
    if (!row) return notFound(c, site);
    return draw(c, site, { kind: 'page', page: pageFor(row), key: ['page', row.id, row.version] });
  });

  app.all('*', (c) => notFound(c, c.get('site')));
  app.onError((e, c) => {
    console.error('site:', e);
    return c.text('Something went wrong on our side — please try again in a minute.', 500);
  });
  return app;
};

// A language's prefix: /pa/… is the same site in Punjabi (TR decision 4).
// The language app's root has the prefix; its home is the root without it.
const langAt = (at, lang) => (lang ? { ...at, root: `${at.root}${LANG_BY_CODE[lang].path}`, home: at.root, lang } : at);
// The first segment of a path after a root, when it is a language's prefix.
const langOfPath = (path, root) => {
  const seg = path.slice(root.length).split('/')[1] || '';
  return LANG_BY_PREFIX[seg] || null;
};

// The site at /site/… on the app's own address (and its files at /site-assets/).
const atSiteApps = new Map(); // lang ('' English) → app
const atSite = (lang = null) => {
  if (!atSiteApps.has(lang || '')) atSiteApps.set(lang || '', makeSiteApp(langAt({ root: '/site', workspaceId: null }, lang)));
  return atSiteApps.get(lang || '');
};
// Another website of the campaign at /site/sites/<key>/… on the app's address.
const KEY = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const atKeys = new Map(); // "key|lang" → app
const atKey = (key, lang = null) => {
  const k = `${key}|${lang || ''}`;
  if (!atKeys.has(k)) {
    if (atKeys.size >= 200) atKeys.clear();
    atKeys.set(k, makeSiteApp(langAt({ root: `/site/sites/${key}`, workspaceId: null, siteKey: key }, lang)));
  }
  return atKeys.get(k);
};
const microAtApp = (c, next) => {
  const key = c.req.param('key');
  if (!KEY.test(key)) return next();
  // /site/sites/<key>/pa/…: that website in Punjabi.
  return atKey(key, langOfPath(c.req.path, `/site/sites/${key}`)).fetch(c.req.raw, c.env);
};
const siteAtApp = (c) => atSite(langOfPath(c.req.path, '/site')).fetch(c.req.raw, c.env);
export const publicRoutes = new Hono();
publicRoutes.get('/site-assets/*', serveAsset);
publicRoutes.all('/site/sites/:key', microAtApp);
publicRoutes.all('/site/sites/:key/*', microAtApp);
publicRoutes.all('/site', siteAtApp);
publicRoutes.all('/site/*', siteAtApp);

// The campaign's own domain: only the site (and what it shares) answers.
const sites = new Map(); // "<workspace id ('' for the default)>|<website id ('' the main)>|<lang>" → app at /
const atRootFor = (workspaceId, siteId = null, lang = null) => {
  const k = `${workspaceId || ''}|${siteId || ''}|${lang || ''}`;
  if (!sites.has(k)) sites.set(k, makeSiteApp(langAt({ root: '', workspaceId, siteId }, lang)));
  return sites.get(k);
};
// Shared: pictures, and what services and emails already sent call back
// (Stripe's and Twilio's webhooks, the email sender's delivery events,
// Mailchimp's unsubscribes, the dialer's call results, the unsubscribe links
// /u, /bu and /lu), so no domain setting ever drops a payment, a STOP, a
// bounce, a call's result or an unsubscribe.
// Each only in the shape, the case and with the method it comes in, as its
// route takes it (an unsubscribe link's id in either case): nothing else of
// the app answers there. (/r/… there is the site's referral link, never a
// receipt.)
const TWILIO = /^\/api\/public\/twilio\/(?:sms|(?:sms-status|voice-dial|voice-status)\/[^/]+|voice\/[^/]+(?:\/connect)?)$/;
const UNSUBSCRIBE = /^\/(?:u|bu|lu)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHARED = [
  [['GET', 'HEAD'], /^\/media\/[^/]+$/],
  [['POST'], /^\/stripe\/webhook$/],
  [['POST'], /^\/hooks\/mail\/[a-z]+$/], // the email sender's delivery events (ext/mail)
  [['GET', 'HEAD', 'POST'], /^\/hooks\/mailchimp\/[0-9a-f]{32}$/], // Mailchimp's unsubscribes (ext/mailchimp); it asks the address before saving it
  [['POST'], TWILIO],
  [['POST'], /^\/hooks\/callhub\/[0-9a-f]{32}$/], // the dialer's call results (ext/callhub)
  [['GET', 'HEAD', 'POST'], UNSUBSCRIBE],
];
const shared = (c) => SHARED.some(([methods, path]) => methods.includes(c.req.method) && path.test(c.req.path));
export const siteGate = async (c, next) => {
  const at = await siteHost(c);
  if (!at) return next();
  if (shared(c)) return next();
  // A closed website's address: every route, any method, says so.
  if (at.gone) {
    const site = await siteFor(c, { root: '', workspaceId: at.workspaceId });
    if (!site) return c.text('This website has closed.', 410);
    return closedPage(c, site);
  }
  return atRootFor(at.workspaceId, at.siteId, langOfPath(c.req.path, '')).fetch(c.req.raw, c.env);
};
