// The public website (SITE.md "Where the site is served"):
//
//   the campaign's own domain(s)   SITE_HOSTS=imaginesurrey.ca,www.imaginesurrey.ca
//                                  and site_settings.domains: the site at /.
//                                  Only the site answers there — and
//                                  /media/:id, /site-assets/*, Stripe's and
//                                  Twilio's webhooks, the emails'
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
import { getCookie, setCookie } from 'hono/cookie';
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
import { siteHost, siteWorkspace, ensureSite, readSettings, menuPages, siteOf, parseJ } from './store.js';
import { loadData } from './loaders.js';
import { cacheKey, cacheGet, cachePut } from './cache.js';
import { verify, sign, PERSON_TTL } from './tokens.js';
import { personOfCode, refCodeFor, CODE_RE } from './people.js';
import { choicesOf, emailOff, emailOn, smsOff, smsOn } from './consent.js';
import { formRoute } from './forms.js';
import { KINDS, consentWording } from './shape.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const REF_COOKIE = 'site_ref';
const REF_DAYS = 30;

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
export const cspFor = (html, { preview = false } = {}) => [
  "default-src 'self'",
  `script-src 'self'${scriptHashes(html).map((h) => ` ${h}`).join('')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  `frame-src ${FRAMES}`,
  "form-action 'self' https://checkout.stripe.com",
  `frame-ancestors ${preview ? "'self'" : "'none'"}`,
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const staging = () => envName() === 'staging';
const pageHeaders = (c, site, { csp, preview = false, store = false }) => {
  c.header('Content-Security-Policy', csp);
  c.header('X-Frame-Options', preview ? 'SAMEORIGIN' : 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cache-Control', store ? 'no-store' : 'no-cache');
  // Not indexed: a draft, staging, or the app's own copy of a site that has
  // its own domain (search engines should find that one).
  if (preview || staging() || site.mirror) c.header('X-Robots-Tag', 'noindex, nofollow');
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
  const ws = await siteWorkspace(db, at.workspaceId || null);
  if (!ws) return null;
  const base = c.env?.base || '';
  const url = new URL(c.req.url);
  const proto = isHttps(c) ? 'https' : url.protocol.replace(':', '');
  const origin = `${proto}://${url.host}`;
  return {
    db, ws, inner: at.root, root: `${base}${at.root}`, base,
    origin, address: publicOrigin(base, origin), https: proto === 'https', assets: `${base}/site-assets`,
  };
};

const ctxOf = (c, site, extra = {}) => {
  const q = (k) => c.req.query(k);
  const sent = KINDS.includes(q('sent')) ? q('sent') : null;
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
const draw = async (c, site, { kind, page = null, post = null, campaign = null, key, status, ctx: extra = {} }) => {
  const settings = await readSettings(site.db, site.ws.id);
  const ctx = ctxOf(c, site, extra);
  const keep = key && !ctx.sent && !ctx.error && !ctx.cancelled && !ctx.preview;
  const fullKey = keep ? cacheKey(site.ws.id, [site.address, site.root, kind, ...key, settings.updated_at, ctx.referral || '']) : null;
  let hit = fullKey ? cacheGet(fullKey) : null;
  if (!hit) {
    const data = await loadData(site.db, site.ws, { posts: kind === 'page' && page?.slug === 'news' ? 200 : 24 });
    const out = renderSite({ kind, site: siteOf(settings, await menuPages(site.db, site.ws.id)), page, post, campaign, data, ctx });
    hit = { status: status || out.status || 200, html: out.html, csp: cspFor(out.html, { preview: ctx.preview }) };
    if (fullKey && hit.status === 200) cachePut(fullKey, hit);
  }
  pageHeaders(c, site, { csp: hit.csp, preview: ctx.preview, store: ctx.preview || Boolean(ctx.sent || ctx.error) });
  return c.html(hit.html, hit.status);
};

const notFound = (c, site) => draw(c, site, { kind: 'notFound', key: ['404'], status: 404 });

const livePage = async (site, slug) => (await site.db.query(
  "select id, slug, version, published from site_pages where workspace_id = $1 and slug = $2 and deleted_at is null and status = 'published'",
  [site.ws.id, slug],
)).rows[0] || null;
// A page's share picture ({ url, alt }), or null: the renderer's og:image
// for the page, before the site's own (seo.shareImage) and the hero's.
const shareOf = (content) => (content?.image?.url ? { url: String(content.image.url), alt: String(content.image.alt || '') } : null);
// A live page as the renderer gets it: a hidden module's words never reach
// the public page at all.
const pageFor = (row) => {
  const p = parseJ(row.published, {}) || {};
  const modules = (Array.isArray(p.modules) ? p.modules : []).filter((m) => m && !m.hidden);
  return { id: row.id, slug: row.slug, title: p.title || '', description: p.description || '', image: shareOf(p), modules };
};

// /news with no news page: the posts, newest first.
const NEWS_PAGE = { id: null, slug: 'news', title: 'News', description: '', modules: [{ id: 'news-all', kind: 'news', hidden: false, props: checkProps('news', { title: 'News', limit: 24 }) }] };

// ── Plain pages of the site's own (preferences, unsubscribe, a link that
// expired): the campaign's name and colours, one column, one button. ──
const plainPage = (site, settings, { title, body, status = 200 }) => {
  const s = siteOf(settings);
  const org = s.org.name || site.ws.name;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
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
footer{margin-top:28px;font-size:15px}
</style></head><body>
<header class="top"><a href="${esc(site.root)}/">${esc(org)}</a></header>
<main id="main">${body}
<footer><a href="${esc(site.root)}/">Back to ${esc(org)}</a></footer></main></body></html>`;
  return { html, status };
};
const sendPlain = (c, site, settings, page, { preview = false } = {}) => {
  const { html, status } = plainPage(site, settings, page);
  pageHeaders(c, site, { csp: cspFor(html, { preview }), preview, store: true });
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return c.html(html, status);
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
const badLink = (c, site, settings) => sendPlain(c, site, settings, {
  title: 'This link has expired',
  body: `<h1>This link doesn’t work any more</h1><p>Links in our emails stop working after a while. Use the link in a newer email from us, or reply to one and we’ll change it for you.</p>`,
  status: 404,
});

// A token for a supporter's own choices, for the links in emails:
// {site}/preferences?t=… and {site}/unsubscribe?t=… (SITE.md).
export const personToken = (workspaceId, personId) => sign('person', { w: workspaceId, p: personId }, PERSON_TTL);

const choicesBody = (site, person, choices, { t, saved = null, code = null, wording }) => {
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

// ── The site's routes, at a root ('' on its own domain, '/site' elsewhere) ──
export const makeSiteApp = (at) => {
  const app = new Hono();
  const R = at.root;
  const route = (p) => `${R}${p}`;
  // The campaign this request is for, made on first use.
  app.use('*', async (c, next) => {
    const site = await siteFor(c, at);
    if (!site) return c.text('This site isn’t set up yet.', 503);
    await ensureSite(site.db, site.ws);
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
    // The app's own copy of a site that has a domain of its own isn't indexed.
    if (R) {
      const domains = parseJ((await site.db.query('select domains from site_settings where workspace_id = $1', [site.ws.id])).rows[0]?.domains, []);
      site.mirror = Boolean(String(process.env.SITE_HOSTS || '').trim()) || (Array.isArray(domains) && domains.length > 0);
    }
    c.set('site', site);
    await next();
  });

  app.get(route('/site-assets/*'), serveAsset);

  app.get(route('/robots.txt'), (c) => {
    const site = c.get('site');
    const body = staging()
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nDisallow: ${site.root}/__preview/\nDisallow: ${site.root}/api/\nDisallow: ${site.root}/preferences\nDisallow: ${site.root}/unsubscribe\nDisallow: ${site.root}/r/\n\nSitemap: ${site.address}${site.root}/sitemap.xml\n`;
    return c.text(body, 200, { 'Cache-Control': 'public, max-age=3600' });
  });

  app.get(route('/sitemap.xml'), async (c) => {
    const site = c.get('site');
    const at2 = `${site.address}${site.root}`;
    const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const rows = [];
    for (const p of (await site.db.query(
      "select slug, coalesce(published_at, updated_at) as at from site_pages where workspace_id = $1 and deleted_at is null and status = 'published' order by nav_order, created_at",
      [site.ws.id],
    )).rows) rows.push([p.slug === 'home' ? `${at2}/` : `${at2}/${p.slug}`, day(p.at)]);
    if (!rows.some(([u]) => u === `${at2}/news`)) rows.push([`${at2}/news`, null]);
    for (const p of (await site.db.query(
      "select slug, coalesce(updated_at, published_at) as at from site_posts where workspace_id = $1 and deleted_at is null and status = 'published' and published_at <= now() order by published_at desc limit 5000",
      [site.ws.id],
    )).rows) rows.push([`${at2}/news/${p.slug}`, day(p.at)]);
    for (const p of (await site.db.query(
      "select slug, updated_at as at from site_campaigns where workspace_id = $1 and deleted_at is null and status = 'open' order by created_at",
      [site.ws.id],
    )).rows) rows.push([`${at2}/act/${p.slug}`, day(p.at)]);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.map(([u, d]) => `<url><loc>${esc(u)}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
    return c.body(xml, 200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
  });

  // A referral link: remembered 30 days (the forms credit them), then home.
  app.get(route('/r/:code'), async (c) => {
    const site = c.get('site');
    const code = String(c.req.param('code') || '').toLowerCase();
    if (CODE_RE.test(code) && await personOfCode(site.db, site.ws.id, code)) {
      setCookie(c, REF_COOKIE, code, {
        path: site.root || '/', maxAge: REF_DAYS * 24 * 3600, httpOnly: true, sameSite: 'Lax', secure: site.https,
      });
    }
    c.header('Cache-Control', 'no-store');
    return c.redirect(`${site.root}/`, 302);
  });

  app.post(route('/api/forms/:kind'), (c) => formRoute(c, c.get('site')));

  // ── Their own email and text choices (a signed link from an email) ──
  const preferences = async (c, saved = null) => {
    const site = c.get('site');
    const settings = await readSettings(site.db, site.ws.id);
    const t = c.req.query('t') || '';
    const person = await personOfToken(site, t);
    if (!person) return badLink(c, site, settings);
    const choices = await choicesOf(site.db, site.ws.id, person);
    const code = parseJ(person.attrs, {})?.ref_code || null;
    return sendPlain(c, site, settings, {
      title: 'Your email and texts',
      body: choicesBody(site, person, choices, { t, saved, code, wording: consentWording(settings.org, settings.seo) }),
    });
  };
  app.get(route('/preferences'), (c) => preferences(c));
  app.post(route('/preferences'), async (c) => {
    const site = c.get('site');
    const form = await c.req.parseBody().catch(() => ({}));
    const t = String(form.t || c.req.query('t') || '');
    const settings = await readSettings(site.db, site.ws.id);
    const person = await personOfToken(site, t);
    if (!person) return badLink(c, site, settings);
    const before = await choicesOf(site.db, site.ws.id, person);
    const want = { email: form.email === 'on' && Boolean(person.email), sms: form.sms === 'on' && Boolean(person.phone) };
    const wording = consentWording(settings.org, settings.seo);
    await runAction(site.db, { workspaceId: site.ws.id, actorId: null, action: 'site.preferences' }, async (tx, emit) => {
      const ws = site.ws.id;
      // On: when it isn't. Off: unless it's off already — a save that only
      // changes their texts leaves no second "no" to email on the record.
      if (person.email && (want.email ? !before.email : !before.emailOff)) {
        await (want.email ? emailOn : emailOff)(tx, ws, { personId: person.id, name: person.name, email: person.email, source: 'preferences', wording: wording.email }, emit);
      }
      if (person.phone && (want.sms ? !before.sms : !before.smsOff)) {
        await (want.sms ? smsOn : smsOff)(tx, ws, { personId: person.id, phone: person.phone, source: 'preferences', wording: wording.sms }, emit);
      }
      await refCodeFor(tx, ws, person.id, emit);
    });
    const words = [
      ...(person.email ? [want.email ? 'You’ll get our emails' : 'No emails'] : []),
      ...(person.phone ? [want.sms ? 'texts are on' : 'no texts'] : []),
    ].join(', ');
    return preferencesAfter(c, site, settings, t, words ? `${words[0].toUpperCase()}${words.slice(1)}.` : 'Nothing to change.');
  });
  const preferencesAfter = async (c, site, settings, t, saved) => {
    const person = await personOfToken(site, t);
    const choices = await choicesOf(site.db, site.ws.id, person);
    const code = parseJ((await site.db.query('select attrs from persons where id = $1', [person.id])).rows[0]?.attrs, {})?.ref_code || null;
    return sendPlain(c, site, settings, {
      title: 'Your email and texts',
      body: choicesBody(site, person, choices, { t, saved, code, wording: consentWording(settings.org, settings.seo) }),
    });
  };

  // One-step unsubscribe from email. Opening it only asks (mail scanners
  // open links by themselves); the button — or a mail app's one-click
  // unsubscribe (List-Unsubscribe-Post) — does it.
  app.get(route('/unsubscribe'), async (c) => {
    const site = c.get('site');
    const settings = await readSettings(site.db, site.ws.id);
    const t = c.req.query('t') || '';
    const person = await personOfToken(site, t);
    if (!person || !person.email) return badLink(c, site, settings);
    const org = settings.org.name || site.ws.name;
    return sendPlain(c, site, settings, {
      title: 'Unsubscribe',
      body: `<h1>Stop emails from ${esc(org)}?</h1><p>${esc(person.email)} won’t get our newsletters or other emails.</p>
<form method="post" action="${esc(site.root)}/unsubscribe?t=${esc(encodeURIComponent(t))}"><input type="hidden" name="t" value="${esc(t)}"><button type="submit">Unsubscribe</button></form>
<p class="more"><a href="${esc(site.root)}/preferences?t=${esc(encodeURIComponent(t))}">Choose what you get instead</a></p>`,
    });
  });
  app.post(route('/unsubscribe'), async (c) => {
    const site = c.get('site');
    const form = await c.req.parseBody().catch(() => ({}));
    const t = String(form.t || c.req.query('t') || '');
    const settings = await readSettings(site.db, site.ws.id);
    const person = await personOfToken(site, t);
    if (!person || !person.email) return badLink(c, site, settings);
    const now = await choicesOf(site.db, site.ws.id, person);
    if (!now.emailOff) {
      await runAction(site.db, { workspaceId: site.ws.id, actorId: null, action: 'site.unsubscribe' }, (tx, emit) => emailOff(tx, site.ws.id, {
        personId: person.id, email: person.email, source: 'unsubscribe-link',
      }, emit));
    }
    const org = settings.org.name || site.ws.name;
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
      ? (await site.db.query('select id, slug, title, description, draft from site_pages where id = $1 and workspace_id = $2 and deleted_at is null', [id, site.ws.id])).rows[0]
      : null;
    if (!row) {
      const settings = await readSettings(site.db, site.ws.id);
      return sendPlain(c, site, settings, {
        title: 'Preview expired',
        body: '<h1>This preview has expired</h1><p>Open the preview again from Website in base.win.</p>',
        status: 403,
      }, { preview: true });
    }
    const d = parseJ(row.draft, {}) || {};
    const page = { id: row.id, slug: row.slug, title: d.title || row.title, description: d.description || '', image: shareOf(d), modules: Array.isArray(d.modules) ? d.modules : [] };
    return draw(c, site, { kind: 'page', page, key: null, ctx: { preview: true } });
  });

  // ── Pages ──
  const home = async (c) => {
    const site = c.get('site');
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

// The site at /site/… on the app's own address (and its files at /site-assets/).
const atSite = makeSiteApp({ root: '/site', workspaceId: null });
export const publicRoutes = new Hono();
publicRoutes.get('/site-assets/*', serveAsset);
publicRoutes.all('/site', (c) => atSite.fetch(c.req.raw, c.env));
publicRoutes.all('/site/*', (c) => atSite.fetch(c.req.raw, c.env));

// The campaign's own domain: only the site (and what it shares) answers.
const sites = new Map(); // workspace id ('' for the default) → app at /
const atRootFor = (workspaceId) => {
  const k = workspaceId || '';
  if (!sites.has(k)) sites.set(k, makeSiteApp({ root: '', workspaceId }));
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
  return atRootFor(at.workspaceId).fetch(c.req.raw, c.env);
};
