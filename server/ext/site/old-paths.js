// The addresses of the website a domain had before base.win's (SITE.md
// "On its own domain"): a link people kept, shared or were emailed still
// goes somewhere. The list is the campaign's own, from its set-up
// (preset().site.oldPaths: none for most campaigns), each entry
// [from, to]:
//
//   from   a path: literal parts, ':name' (one part of letters, digits,
//          '-' and '_'), and '*' at the end (the rest, maybe nothing)
//   to     a path on this website, with the same ':name' and '*' — sent on
//          for good (301) only when that page is live here; or 'former' —
//          the website the domain had before, at its own address
//          (STARBASE_SITE_FORMER_URL): 302, or 307 for anything but a GET
//          (a mail app's one-click unsubscribe keeps its POST)
//
// Asked only where the main site at a domain's root has no page for the
// address (its 404), so a page base.win has always wins.
import { preset } from '../../lib/preset.js';
import { formerUrl } from './domain.js';

const PART = /^[A-Za-z0-9_-]+$/;

// → the address an old path goes to ('former' for the former website), or null.
export const matchOld = (list, path) => {
  const parts = String(path || '').split('/').slice(1);
  for (const [from, to] of Array.isArray(list) ? list : []) {
    const pat = String(from).split('/').slice(1);
    const got = {};
    let rest = null;
    let ok = true;
    for (let i = 0; i < pat.length && ok; i += 1) {
      if (pat[i] === '*' && i === pat.length - 1) { rest = parts.slice(i).join('/'); break; }
      const part = parts[i];
      if (part === undefined) ok = false;
      else if (pat[i].startsWith(':')) { if (PART.test(part)) got[pat[i].slice(1)] = part; else ok = false; } else if (pat[i] !== part) ok = false;
    }
    if (ok && rest === null && parts.length !== pat.length) ok = false;
    if (!ok) continue;
    if (to === 'former') return 'former';
    return String(to).replace(/:([A-Za-z0-9_]+)/g, (m, k) => got[k] ?? m).replace(/\*$/, rest ?? '').replace(/\/+$/, '') || '/';
  }
  return null;
};

// Is that address a live page of this website? (home, a published page,
// a petition or pledge, a published post, /news, /act)
const liveAt = async (site, path, livePage) => {
  if (path === '/' || path === '/news' || path === '/act') return path !== '/' || Boolean(await livePage(site, 'home'));
  const m = /^\/(?:(act|news)\/)?([a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?)$/.exec(path);
  if (!m) return false;
  if (m[1] === 'act') {
    return Boolean((await site.db.query('select 1 from site_campaigns where workspace_id = $1 and slug = $2 and deleted_at is null', [site.ws.id, m[2]])).rows[0]);
  }
  if (m[1] === 'news') {
    return Boolean((await site.db.query(
      "select 1 from site_posts where workspace_id = $1 and slug = $2 and deleted_at is null and status = 'published' and published_at <= now()", [site.ws.id, m[2]],
    )).rows[0]);
  }
  return m[2] !== 'home' && Boolean(await livePage(site, m[2]));
};

// The answer for an address the site has no page for, or null (its 404).
export const oldPathAnswer = async (c, site, livePage) => {
  if (site.inner !== '' || site.micro || site.lang !== 'en') return null;
  const list = preset().site?.oldPaths || [];
  if (!list.length) return null;
  const url = new URL(c.req.url);
  const to = matchOld(list, c.req.path);
  if (!to) return null;
  const read = c.req.method === 'GET' || c.req.method === 'HEAD';
  if (to === 'former') {
    const at = formerUrl();
    if (!at) return null;
    return new Response(null, { status: read ? 302 : 307, headers: { location: `${at}${c.req.path}${url.search}`, 'cache-control': 'no-store' } });
  }
  if (!read || !(await liveAt(site, to, livePage))) return null;
  return new Response(null, { status: 301, headers: { location: `${site.base}${to}${url.search}`, 'cache-control': 'public, max-age=3600' } });
};
