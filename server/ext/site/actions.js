// The Website area's writes (SITE.md "Admin API"). Managers by default; the
// 'site' area (lib/perms.js) lets a manager grant it to a role or a person.
// Each is one runAction (the hash-chained event log), and each clears the
// campaign's cached pages once it has committed.
//
//   site.settings.save   { theme?, nav?, footer?, announcement?, seo?, org?, social?, domains? }
//                        each section given replaces that section (shape.js);
//                        a theme with a colour pair under 4.5:1 is refused
//   site.page.create     { title, slug?, description?, modules?, show_in_nav?, site_id? } → { page }   a draft
//                        (site_id: on another website of the campaign — a
//                        page's address, order, copy and restore stay within
//                        its own website; microsites.js has those websites' own)
//   site.page.save       { id, title?, slug?, description?, image?, modules?, show_in_nav?, nav_order?, updated_at? }
//                        the draft (modules checked loosely: a draft may be
//                        unfinished); image: the page's share picture
//                        { url, alt } (null or no url: none); updated_at: the
//                        page as it was opened — someone else's save since is
//                        refused (409)
//   site.page.publish    { id }  the draft goes live: every module complete
//                        (checkModules strict), the petitions it shows still there
//   site.page.unpublish  { id }  off the site (not home)
//   site.page.duplicate  { id } → { page }  a draft copy
//   site.page.delete     { id }  (not home)
//   site.page.restore    { id } → { page }  a deleted page back as it was (the
//                        Website screen's Undo); its address taken since: a free one like it
//   site.page.reorder    { ids }  the menu order of those pages
//   site.post.save       { id?, title, slug?, excerpt?, body?, image? } → { post }
//   site.post.publish    { id, published? = true }
//   site.post.delete     { id }
//   site.post.restore    { id } → { post }  (Undo)
//   site.campaign.save   { id?, kind, title, slug?, excerpt?, body?, statement?, goal? } → { campaign }
//   site.campaign.close  { id, open? }  closed (or open again)
//   site.campaign.delete { id }
//   site.campaign.restore { id } → { campaign }  (Undo)
//   site.picture         { data (base64 or a data: URL), name?, width?, height? } → { media: { id, url } }
//                        JPG, PNG or WebP, at most 2 MB, served at /media/:id
//                        (the same store as Outreach's pictures)
//   shift.public         { id, public }  the desk: a shift shown (or not) on
//                        the site's events, where anyone may sign up for it
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { checkModules, MODULE_BY_KIND } from '@starbase/shared/site/catalogue';
import { checkTheme } from '@starbase/shared/site/theme';
import { newId, canonical } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { readUpload } from '../abtests/media.js';
import { brandKey } from '../../lib/brand.js';
import { SECTIONS, slugify, slugProblem, SYSTEM_SLUGS, RESERVED_SLUGS, hostOf } from './shape.js';
import { ensureSiteTx, parseJ, pageOut, postOut, campaignOut, forgetDomains, isAppHost, envHosts, appHostSeen, usedWhy } from './store.js';
import { cacheClear } from './cache.js';
import { micrositeActions, hostProblem, takeHeld, roomForPage } from './microsites.js';

const MANAGER = ['manager'];
const DESK = ['manager', 'treasurer', 'staff'];
const uuid = () => z.uuid();
const text = (max) => z.string().trim().max(max);

// A Website action: managers, or whoever the 'site' area is granted to.
// After it commits, the campaign's cached pages go (cache.js).
const siteAction = (input, handler) => ({
  roles: MANAGER,
  area: 'site',
  input,
  handler: async (tx, ctx, data, emit) => {
    await ensureSiteTx(tx, ctx.workspace || { id: ctx.workspaceId }, emit);
    return handler(tx, ctx, data, emit);
  },
  after: async (db, ctx, result) => {
    cacheClear(ctx.workspaceId);
    forgetDomains(); // a domain saved: answered there from the next request
    return { result };
  },
});

const hash = (v) => createHash('sha256').update(canonical(v)).digest('hex').slice(0, 16);
// A page's modules without their words, for the event log (the words are
// the page's own; publish logs what went live in full).
const shapeOf = (modules) => (modules || []).map((m) => ({ id: m.id, kind: m.kind, hidden: Boolean(m.hidden) }));

// "modules[3]: campaign: pick one" → "The 4th module (Petition or pledge): campaign: pick one"
const ordinal = (n) => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const moduleProblem = (e, modules) => {
  const m = /^modules\[(\d+)\]: (.*)$/.exec(String(e.message));
  if (!m) return httpError(400, String(e.message));
  const i = Number(m[1]);
  const label = MODULE_BY_KIND[modules?.[i]?.kind]?.label;
  return httpError(400, `The ${ordinal(i + 1)} module${label ? ` (${label})` : ''}: ${m[2]}`);
};
// The catalogue names the field that's wrong; this names the module too.
const checked = (modules, opts = {}) => {
  try { return checkModules(modules, opts); } catch (e) {
    if (Array.isArray(modules) && modules.length <= 60) {
      for (const [i, m] of modules.entries()) {
        try { checkModules([m], opts); } catch (one) {
          const label = MODULE_BY_KIND[m?.kind]?.label;
          throw httpError(400, `The ${ordinal(i + 1)} module${label ? ` (${label})` : ''}: ${String(one.message).replace(/^modules\[0\]: /, '')}`);
        }
      }
    }
    throw moduleProblem(e, modules);
  }
};

const loadPage = async (tx, ws, id) => {
  const r = (await tx.query('select * from site_pages where id = $1 and workspace_id = $2 and deleted_at is null for update', [id, ws])).rows[0];
  if (!r) throw httpError(404, 'That page is gone — reload the list');
  return r;
};

// A free address: the one asked for (refused if taken), or one made from
// the title (with -2, -3… when taken).
// siteId: a page's own website (null: the main site's).
const freeSlug = async (tx, ws, table, wanted, fallback, exceptId = null, { pages = true, siteId = null } = {}) => {
  const ofSite = table === 'site_pages' ? ' and site_id is not distinct from $4::uuid' : '';
  const taken = async (s) => Boolean((await tx.query(
    `select 1 from ${table} where workspace_id = $1 and slug = $2 and deleted_at is null and ($3::uuid is null or id <> $3::uuid)${ofSite}`,
    table === 'site_pages' ? [ws, s, exceptId, siteId] : [ws, s, exceptId],
  )).rows[0]);
  if (wanted) {
    const s = String(wanted).trim().toLowerCase();
    const why = pages ? slugProblem(s) : (/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(s) ? null : 'An address is lowercase letters, numbers and dashes (like town-hall-2026)');
    if (why) throw httpError(400, why);
    if (pages && SYSTEM_SLUGS.includes(s)) throw httpError(409, `“${s}” is the ${s === 'home' ? 'home page' : 'news page'}'s address`);
    if (await taken(s)) throw httpError(409, `Another ${table === 'site_pages' ? 'page' : table === 'site_posts' ? 'post' : 'petition'} has the address “${s}”`);
    return s;
  }
  const base = slugify(fallback) || (table === 'site_pages' ? 'page' : 'item');
  const start = pages && (RESERVED_SLUGS.includes(base) || SYSTEM_SLUGS.includes(base)) ? `${base}-page` : base;
  for (let i = 1; i < 200; i += 1) {
    const s = i === 1 ? start : `${start.slice(0, 55)}-${i}`;
    if (!(await taken(s))) return s;
  }
  throw httpError(409, 'Pick an address for it');
};

// The petitions and pages a published page points at must be there.
const refsProblem = async (tx, ws, modules, siteId = null) => {
  for (const [i, m] of modules.entries()) {
    if (m.hidden) continue;
    for (const f of MODULE_BY_KIND[m.kind]?.fields || []) {
      const v = m.props?.[f.key];
      if (!v) continue;
      if (f.type === 'campaign') {
        const c = (await tx.query('select kind from site_campaigns where id::text = $1 and workspace_id = $2 and deleted_at is null', [v, ws])).rows[0];
        if (!c) return `The ${ordinal(i + 1)} module (${MODULE_BY_KIND[m.kind].label}): the petition or pledge it shows is gone — pick another`;
        if (f.kinds && !f.kinds.includes(c.kind)) return `The ${ordinal(i + 1)} module: pick a ${f.kinds.join(' or ')}`;
      }
      if (f.type === 'page') {
        const p = (await tx.query(
          "select 1 from site_pages where slug = $1 and workspace_id = $2 and deleted_at is null and status = 'published' and site_id is not distinct from $3::uuid", [v, ws, siteId],
        )).rows[0];
        if (!p) return `The ${ordinal(i + 1)} module (${MODULE_BY_KIND[m.kind].label}): the page it links to isn't on the site`;
      }
    }
  }
  return null;
};

const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);

// A page's share picture: { url, alt } in its draft (and, once published,
// in what went live) — only when it has one, so a page without stays
// { title, description, modules }.
const shareImage = z.object({ url: z.string().trim().max(500).default(''), alt: text(300).default('') }).nullish();
const withImage = (content, image) => {
  const { image: _drop, ...rest } = content;
  return image?.url ? { ...rest, image: { url: image.url, alt: image.alt || '' } } : rest;
};

// A deleted page, post or petition back as it was (Undo). Its address may
// have gone to another since: then a free one like it (-2, -3…).
const restoreRow = async (tx, ws, table, id, gone) => {
  const cur = (await tx.query(`select * from ${table} where id = $1 and workspace_id = $2 and deleted_at is not null for update`, [id, ws])).rows[0];
  if (!cur) throw httpError(404, gone);
  const pages = table === 'site_pages';
  const siteId = pages ? cur.site_id || null : null;
  if (siteId) {
    // A page of another website comes back only while that website is there.
    const there = (await tx.query('select 1 from microsites where id = $1 and workspace_id = $2 and deleted_at is null', [siteId, ws])).rows[0];
    if (!there) throw httpError(404, 'That website is gone — reload');
    await roomForPage(tx, ws, siteId);
  }
  const taken = (await tx.query(
    `select 1 from ${table} where workspace_id = $1 and slug = $2 and deleted_at is null${pages ? ' and site_id is not distinct from $3::uuid' : ''}`,
    pages ? [ws, cur.slug, siteId] : [ws, cur.slug],
  )).rows[0];
  const slug = taken ? await freeSlug(tx, ws, table, null, cur.slug, null, { pages, siteId }) : cur.slug;
  return { cur, slug };
};

export const actions = {
  'site.settings.save': siteAction(z.object({
    theme: z.record(z.string(), z.any()).optional(),
    nav: z.any().optional(), footer: z.any().optional(), announcement: z.any().optional(),
    seo: z.any().optional(), org: z.any().optional(), social: z.any().optional(),
    domains: z.array(z.string().max(300)).max(10).optional(),
  }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const sets = [];
    const params = [ws];
    const changed = {};
    for (const key of Object.keys(SECTIONS)) {
      if (input[key] === undefined) continue;
      const r = SECTIONS[key].safeParse(input[key]);
      if (!r.success) {
        const i = r.error.issues[0];
        throw httpError(400, `${key}${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`);
      }
      params.push(JSON.stringify(r.data));
      sets.push(`${key} = $${params.length}`);
      changed[key] = r.data;
    }
    if (input.theme !== undefined) {
      // Following the campaign's brand, or not, changes only when a save says
      // so (Website → Theme: "Use the campaign's brand" / "Give the website
      // its own look"); any other theme save keeps it as it was.
      const was = parseJ((await tx.query('select theme from site_settings where workspace_id = $1', [ws])).rows[0]?.theme, null);
      const follow = typeof input.theme.follow === 'boolean' ? input.theme.follow : was?.follow === true;
      // A website that had its own look when it began to follow keeps it
      // underneath ("Go back to the look it had"); one that has followed
      // since it was made has none. Never the save's own word for it.
      const kept = follow && Boolean(was) && (was.follow === true ? was.kept === true : true);
      const given = { ...input.theme, follow, kept };
      const { theme, problems } = checkTheme(given, brandKey());
      if (problems.length) {
        const p = problems[0];
        throw httpError(400, `${p.pair.label}: ${p.ratio.toFixed(1)}:1 is too hard to read — it needs 4.5:1. Pick a darker or lighter colour.`);
      }
      params.push(JSON.stringify(theme));
      sets.push(`theme = $${params.length}`);
      changed.theme = theme;
    }
    if (input.domains !== undefined) {
      const hosts = [];
      for (const d of input.domains) {
        const h = hostOf(d);
        if (!h) throw httpError(400, `“${d}” isn't a web address (like imaginesurrey.ca)`);
        // On a domain only the site answers: never where the app itself is
        // (this request's host, the server's public address and its other
        // addresses, base.win).
        if (isAppHost(h, ctx.host ? [ctx.host] : [])) {
          throw httpError(400, `${h} is where base.win itself answers — on a website domain only the site does, so the app would stop working there. Add your campaign’s own domain (like yourcampaign.ca).`);
        }
        if (!hosts.includes(h)) hosts.push(h);
      }
      const saved = parseJ((await tx.query('select domains from site_settings where workspace_id = $1', [ws])).rows[0]?.domains, []);
      const already = Array.isArray(saved) ? saved : [];
      for (const h of hosts) {
        // Nor an address people use the app at (app_hosts), unless the site
        // has it already (saved before, or the operator's SITE_HOSTS): the
        // app doesn't answer there then. The screen refuses the same ones as
        // they're typed, in the same words (store.js usedHosts).
        const seen = already.includes(h) || envHosts().includes(h) ? null : await appHostSeen(tx, h);
        if (seen) throw httpError(400, usedWhy(h, seen, ctx));
        const other = (await tx.query(
          'select 1 from site_settings where workspace_id <> $1 and domains @> $2::jsonb', [ws, JSON.stringify([h])],
        )).rows[0];
        if (other) throw httpError(409, `${h} is another campaign's address`);
        // Nor another website's (microsites.js); an address a closed website
        // of this campaign still holds is taken from it.
        const p = await hostProblem(tx, ctx, h, { main: true, already: [...already, ...envHosts()] });
        if (p.why) throw httpError(400, p.why);
        await takeHeld(tx, ws, h, p.take, emit);
      }
      params.push(JSON.stringify(hosts));
      sets.push(`domains = $${params.length}`);
      changed.domains = hosts;
    }
    if (!sets.length) throw httpError(400, 'Nothing to save');
    await tx.query(`update site_settings set ${sets.join(', ')}, updated_at = now() where workspace_id = $1`, params);
    emit('site_settings', ws, 'update', changed);
    const row = (await tx.query('select updated_at from site_settings where workspace_id = $1', [ws])).rows[0];
    return { saved: Object.keys(changed), updated_at: iso(row.updated_at) };
  }),

  'site.page.create': siteAction(z.object({
    title: text(120).min(1, 'Give the page a title'),
    slug: z.string().max(80).nullish(),
    description: text(300).nullish(),
    modules: z.array(z.any()).max(60).nullish(),
    show_in_nav: z.boolean().optional(),
    site_id: uuid().nullish(),
  }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const siteId = input.site_id || null;
    if (siteId) {
      const there = (await tx.query('select 1 from microsites where id = $1 and workspace_id = $2 and deleted_at is null', [siteId, ws])).rows[0];
      if (!there) throw httpError(404, 'That website is gone — reload');
      await roomForPage(tx, ws, siteId);
    }
    const slug = await freeSlug(tx, ws, 'site_pages', input.slug, input.title, null, { siteId });
    const modules = checked(input.modules || []);
    const draft = { title: input.title, description: input.description || '', modules };
    const order = (await tx.query(
      'select coalesce(max(nav_order), -1) + 1 as n from site_pages where workspace_id = $1 and deleted_at is null and site_id is not distinct from $2::uuid', [ws, siteId],
    )).rows[0].n;
    const id = newId();
    const row = (await tx.query(
      `insert into site_pages (id, workspace_id, slug, title, description, draft, show_in_nav, nav_order, site_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [id, ws, slug, input.title, input.description || '', JSON.stringify(draft), Boolean(input.show_in_nav), order, siteId],
    )).rows[0];
    emit('site_page', id, 'create', { slug, title: input.title, show_in_nav: Boolean(input.show_in_nav), modules: shapeOf(modules), content_hash: hash(draft), ...(siteId ? { site_id: siteId } : {}) });
    return { page: pageOut(row) };
  }),

  'site.page.save': siteAction(z.object({
    id: uuid(),
    title: text(120).min(1, 'Give the page a title').optional(),
    slug: z.string().max(80).optional(),
    description: text(300).nullish(),
    image: shareImage,
    modules: z.array(z.any()).max(60).optional(),
    show_in_nav: z.boolean().optional(),
    nav_order: z.number().int().min(0).max(10000).optional(),
    updated_at: z.string().max(40).optional(),
  }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const cur = await loadPage(tx, ws, input.id);
    if (input.updated_at && new Date(input.updated_at).getTime() !== new Date(cur.updated_at).getTime()) {
      throw httpError(409, 'Someone else saved this page since you opened it — reload to see their changes');
    }
    if (input.image?.url && !/^(\/(?!\/)|https:\/\/)/.test(input.image.url)) throw httpError(400, 'image: a picture from Website (/media/…)');
    const draft = parseJ(cur.draft, {});
    let slug = cur.slug;
    if (input.slug !== undefined && input.slug.trim().toLowerCase() !== cur.slug) {
      if (SYSTEM_SLUGS.includes(cur.slug)) throw httpError(400, `The ${cur.slug === 'home' ? 'home page' : 'news page'} keeps its address`);
      slug = await freeSlug(tx, ws, 'site_pages', input.slug, null, cur.id, { siteId: cur.site_id || null });
    }
    const title = input.title ?? cur.title;
    const description = input.description === undefined ? (cur.description || '') : (input.description || '');
    const modules = input.modules === undefined ? (draft.modules || []) : checked(input.modules);
    const next = withImage({ title, description, modules }, input.image === undefined ? draft.image : input.image);
    const showInNav = input.show_in_nav ?? cur.show_in_nav;
    const navOrder = input.nav_order ?? cur.nav_order;
    const row = (await tx.query(
      `update site_pages set slug = $3, title = $4, description = $5, draft = $6, show_in_nav = $7, nav_order = $8, updated_at = now()
       where id = $1 and workspace_id = $2 returning *`,
      [cur.id, ws, slug, title, description, JSON.stringify(next), showInNav, navOrder],
    )).rows[0];
    const changes = {};
    if (slug !== cur.slug) changes.slug = slug;
    if (title !== cur.title) changes.title = title;
    if (description !== (cur.description || '')) changes.description = description;
    if ((next.image?.url || '') !== (draft.image?.url || '')) changes.image = next.image?.url || '';
    if (showInNav !== cur.show_in_nav) changes.show_in_nav = showInNav;
    if (navOrder !== cur.nav_order) changes.nav_order = navOrder;
    emit('site_page', cur.id, 'update', { ...changes, modules: shapeOf(modules), content_hash: hash(next) });
    return { page: pageOut(row) };
  }),

  'site.page.publish': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const cur = await loadPage(tx, ws, input.id);
    const draft = parseJ(cur.draft, {});
    const modules = checked(draft.modules || [], { strict: true });
    const problem = await refsProblem(tx, ws, modules, cur.site_id || null);
    if (problem) throw httpError(400, problem);
    const live = withImage({ title: cur.title, description: cur.description || '', modules }, draft.image);
    const row = (await tx.query(
      `update site_pages set published = $3, draft = $3, version = version + 1, status = 'published', published_at = now(), updated_at = now()
       where id = $1 and workspace_id = $2 returning *`,
      [cur.id, ws, JSON.stringify(live)],
    )).rows[0];
    // What went live, in full: the record of what the public saw.
    emit('site_page', cur.id, 'update', { published: true, version: row.version, slug: row.slug, content: live });
    return { page: pageOut(row) };
  }),

  'site.page.unpublish': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const cur = await loadPage(tx, ws, input.id);
    if (cur.slug === 'home') throw httpError(400, 'The home page stays on the site — edit it instead');
    if (cur.status !== 'published') return { page: pageOut(cur) };
    const row = (await tx.query(
      `update site_pages set status = 'draft', updated_at = now() where id = $1 and workspace_id = $2 returning *`, [cur.id, ws],
    )).rows[0];
    emit('site_page', cur.id, 'update', { published: false });
    return { page: pageOut(row) };
  }),

  'site.page.duplicate': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const cur = await loadPage(tx, ws, input.id);
    const draft = parseJ(cur.draft, {});
    const title = `${cur.title} (copy)`.slice(0, 120);
    const siteId = cur.site_id || null;
    await roomForPage(tx, ws, siteId);
    const slug = await freeSlug(tx, ws, 'site_pages', null, `${cur.slug}-copy`, null, { siteId });
    const copy = { ...draft, title };
    const order = (await tx.query(
      'select coalesce(max(nav_order), -1) + 1 as n from site_pages where workspace_id = $1 and deleted_at is null and site_id is not distinct from $2::uuid', [ws, siteId],
    )).rows[0].n;
    const id = newId();
    const row = (await tx.query(
      `insert into site_pages (id, workspace_id, slug, title, description, draft, show_in_nav, nav_order, site_id)
       values ($1, $2, $3, $4, $5, $6, false, $7, $8) returning *`,
      [id, ws, slug, title, cur.description || '', JSON.stringify(copy), order, siteId],
    )).rows[0];
    emit('site_page', id, 'create', { slug, title, copied_from: cur.id, modules: shapeOf(copy.modules), content_hash: hash(copy) });
    return { page: pageOut(row) };
  }),

  'site.page.delete': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const cur = await loadPage(tx, ws, input.id);
    if (cur.slug === 'home') throw httpError(400, 'The home page stays — edit it instead');
    await tx.query('update site_pages set deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2', [cur.id, ws]);
    emit('site_page', cur.id, 'void', { slug: cur.slug });
    return { id: cur.id };
  }),

  'site.page.restore': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const { cur, slug } = await restoreRow(tx, ws, 'site_pages', input.id, 'That page can’t be brought back — reload the list');
    const row = (await tx.query(
      'update site_pages set deleted_at = null, slug = $3, updated_at = now() where id = $1 and workspace_id = $2 returning *', [cur.id, ws, slug],
    )).rows[0];
    emit('site_page', cur.id, 'restore', { slug, ...(slug !== cur.slug ? { was: cur.slug } : {}) });
    return { page: pageOut(row) };
  }),

  'site.page.reorder': siteAction(z.object({ ids: z.array(uuid()).min(1).max(200) }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const rows = (await tx.query(
      'select id, nav_order, site_id from site_pages where workspace_id = $1 and deleted_at is null and id = any($2::uuid[])', [ws, input.ids],
    )).rows;
    if (new Set(rows.map((r) => r.site_id || '')).size > 1) throw httpError(400, 'Those pages are on two different websites — order each one’s on its own');
    const have = new Map(rows.map((r) => [r.id, r.nav_order]));
    let moved = 0;
    for (const [i, id] of [...new Set(input.ids)].entries()) {
      if (!have.has(id) || have.get(id) === i) continue;
      await tx.query('update site_pages set nav_order = $3, updated_at = now() where id = $1 and workspace_id = $2', [id, ws, i]);
      emit('site_page', id, 'update', { nav_order: i });
      moved += 1;
    }
    return { moved };
  }),

  'site.post.save': siteAction(z.object({
    id: uuid().nullish(),
    title: text(160).min(1, 'Give the post a title'),
    slug: z.string().max(80).nullish(),
    excerpt: text(400).nullish(),
    body: z.string().max(50000).nullish(),
    image: z.object({ url: z.string().max(500).default(''), alt: text(300).default('') }).nullish(),
  }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const image = input.image || { url: '', alt: '' };
    if (image.url && !/^(\/(?!\/)|https:\/\/)/.test(image.url)) throw httpError(400, 'image: a picture from Website → Pictures (/media/…)');
    if (input.id) {
      const cur = (await tx.query('select * from site_posts where id = $1 and workspace_id = $2 and deleted_at is null for update', [input.id, ws])).rows[0];
      if (!cur) throw httpError(404, 'That post is gone — reload the list');
      const slug = input.slug && input.slug.trim().toLowerCase() !== cur.slug
        ? await freeSlug(tx, ws, 'site_posts', input.slug, null, cur.id, { pages: false }) : cur.slug;
      const row = (await tx.query(
        `update site_posts set slug = $3, title = $4, excerpt = $5, body = $6, image = $7, updated_at = now()
         where id = $1 and workspace_id = $2 returning *`,
        [cur.id, ws, slug, input.title, input.excerpt ?? cur.excerpt, input.body ?? cur.body, JSON.stringify(input.image ? image : parseJ(cur.image, {}))],
      )).rows[0];
      emit('site_post', cur.id, 'update', { slug, title: input.title, content_hash: hash({ e: row.excerpt, b: row.body, i: row.image }) });
      return { post: postOut(row) };
    }
    const slug = await freeSlug(tx, ws, 'site_posts', input.slug, input.title, null, { pages: false });
    const id = newId();
    const row = (await tx.query(
      `insert into site_posts (id, workspace_id, slug, title, excerpt, body, image) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [id, ws, slug, input.title, input.excerpt || '', input.body || '', JSON.stringify(image)],
    )).rows[0];
    emit('site_post', id, 'create', { slug, title: input.title });
    return { post: postOut(row) };
  }),

  'site.post.publish': siteAction(z.object({ id: uuid(), published: z.boolean().default(true) }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const cur = (await tx.query('select * from site_posts where id = $1 and workspace_id = $2 and deleted_at is null for update', [input.id, ws])).rows[0];
    if (!cur) throw httpError(404, 'That post is gone — reload the list');
    const row = (await tx.query(
      `update site_posts set status = $3, published_at = case when $3 = 'published' then coalesce(published_at, now()) else published_at end, updated_at = now()
       where id = $1 and workspace_id = $2 returning *`,
      [cur.id, ws, input.published ? 'published' : 'draft'],
    )).rows[0];
    emit('site_post', cur.id, 'update', { published: input.published, title: row.title, body: row.body, excerpt: row.excerpt });
    return { post: postOut(row) };
  }),

  'site.post.delete': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const n = await tx.query('update site_posts set deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2 and deleted_at is null', [input.id, ctx.workspaceId]);
    if (!n.affectedRows) throw httpError(404, 'That post is gone — reload the list');
    emit('site_post', input.id, 'void', {});
    return { id: input.id };
  }),

  'site.post.restore': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const { cur, slug } = await restoreRow(tx, ws, 'site_posts', input.id, 'That post can’t be brought back — reload the list');
    const row = (await tx.query(
      'update site_posts set deleted_at = null, slug = $3, updated_at = now() where id = $1 and workspace_id = $2 returning *', [cur.id, ws, slug],
    )).rows[0];
    emit('site_post', cur.id, 'restore', { slug, ...(slug !== cur.slug ? { was: cur.slug } : {}) });
    return { post: postOut(row) };
  }),

  'site.campaign.save': siteAction(z.object({
    id: uuid().nullish(),
    kind: z.enum(['petition', 'pledge']).optional(),
    title: text(160).min(1, 'Give it a title'),
    slug: z.string().max(80).nullish(),
    excerpt: text(400).nullish(),
    body: z.string().max(20000).nullish(),
    statement: text(1000).nullish(),
    goal: z.number().int().min(1).max(10_000_000).nullish(),
  }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    if (input.id) {
      const cur = (await tx.query(
        `select c.*, ${SIG} as signatures from site_campaigns c where c.id = $1 and c.workspace_id = $2 and c.deleted_at is null for update`, [input.id, ws],
      )).rows[0];
      if (!cur) throw httpError(404, 'That petition is gone — reload the list');
      const kind = input.kind || cur.kind;
      if (kind !== cur.kind && Number(cur.signatures) > 0) throw httpError(409, 'People have signed it already — it stays a ' + cur.kind);
      const slug = input.slug && input.slug.trim().toLowerCase() !== cur.slug
        ? await freeSlug(tx, ws, 'site_campaigns', input.slug, null, cur.id, { pages: false }) : cur.slug;
      const row = (await tx.query(
        `update site_campaigns set kind = $3, slug = $4, title = $5, excerpt = $6, body = $7, statement = $8, goal = $9, updated_at = now()
         where id = $1 and workspace_id = $2 returning *, ${SIG.replace(/c\./g, 'site_campaigns.')} as signatures`,
        [cur.id, ws, kind, slug, input.title, input.excerpt ?? cur.excerpt, input.body ?? cur.body, input.statement ?? cur.statement,
         input.goal === undefined ? cur.goal : input.goal],
      )).rows[0];
      emit('site_campaign', cur.id, 'update', { kind, slug, title: input.title, statement: row.statement, goal: row.goal });
      return { campaign: campaignOut(row) };
    }
    if (!input.kind) throw httpError(400, 'A petition or a pledge?');
    const slug = await freeSlug(tx, ws, 'site_campaigns', input.slug, input.title, null, { pages: false });
    const id = newId();
    const row = (await tx.query(
      `insert into site_campaigns (id, workspace_id, slug, kind, title, excerpt, body, statement, goal)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *, 0 as signatures`,
      [id, ws, slug, input.kind, input.title, input.excerpt || '', input.body || '', input.statement || '', input.goal ?? null],
    )).rows[0];
    emit('site_campaign', id, 'create', { kind: input.kind, slug, title: input.title, statement: row.statement, goal: row.goal });
    return { campaign: campaignOut(row) };
  }),

  'site.campaign.close': siteAction(z.object({ id: uuid(), open: z.boolean().default(false) }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const row = (await tx.query(
      `update site_campaigns set status = $3, updated_at = now() where id = $1 and workspace_id = $2 and deleted_at is null
       returning *, ${SIG.replace(/c\./g, 'site_campaigns.')} as signatures`,
      [input.id, ws, input.open ? 'open' : 'closed'],
    )).rows[0];
    if (!row) throw httpError(404, 'That petition is gone — reload the list');
    emit('site_campaign', input.id, 'update', { status: row.status });
    return { campaign: campaignOut(row) };
  }),

  'site.campaign.delete': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const n = await tx.query('update site_campaigns set deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2 and deleted_at is null', [input.id, ctx.workspaceId]);
    if (!n.affectedRows) throw httpError(404, 'That petition is gone — reload the list');
    emit('site_campaign', input.id, 'void', {});
    return { id: input.id };
  }),

  'site.campaign.restore': siteAction(z.object({ id: uuid() }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const { cur, slug } = await restoreRow(tx, ws, 'site_campaigns', input.id, 'That petition can’t be brought back — reload the list');
    const row = (await tx.query(
      `update site_campaigns set deleted_at = null, slug = $3, updated_at = now() where id = $1 and workspace_id = $2
       returning *, ${SIG.replace(/c\./g, 'site_campaigns.')} as signatures`, [cur.id, ws, slug],
    )).rows[0];
    emit('site_campaign', cur.id, 'restore', { slug, ...(slug !== cur.slug ? { was: cur.slug } : {}) });
    return { campaign: campaignOut(row) };
  }),

  'site.picture': siteAction(z.object({
    data: z.string().min(1).max(3_000_000),
    name: z.string().trim().max(200).optional(),
    width: z.number().int().min(1).max(20_000).optional(),
    height: z.number().int().min(1).max(20_000).optional(),
  }), async (tx, ctx, input, emit) => {
    const up = readUpload(input.data);
    if (up.error) throw httpError(400, up.error);
    const id = newId();
    await tx.query(
      `insert into media (id, workspace_id, content_type, bytes, width, height, name, data, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, ctx.workspaceId, up.type, up.buf.length, input.width ?? null, input.height ?? null, input.name || null, up.buf, ctx.user?.id || null],
    );
    const media = { id, content_type: up.type, bytes: up.buf.length, width: input.width ?? null, height: input.height ?? null, name: input.name || null };
    emit('media', id, 'create', { ...media, for: 'site' });
    return { media: { ...media, url: `/media/${id}` } };
  }),

  'shift.public': {
    roles: DESK,
    input: z.object({ id: uuid(), public: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      const r = (await tx.query(
        'update shifts set public = $3 where id = $1 and workspace_id = $2 and deleted_at is null returning id, public',
        [input.id, ctx.workspaceId, input.public],
      )).rows[0];
      if (!r) throw httpError(404, 'shift not found');
      emit('shift', input.id, 'update', { public: input.public });
      return { id: input.id, public: r.public };
    },
    after: async (db, ctx, result) => {
      cacheClear(ctx.workspaceId);
      return { result };
    },
  },
};

Object.assign(actions, micrositeActions(siteAction));

const SIG = `(select count(distinct a.person_id)::int from site_actions a where a.workspace_id = c.workspace_id and a.campaign_id = c.id and a.kind in ('petition', 'pledge'))`;
