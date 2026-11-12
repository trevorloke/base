// The campaign's other websites (SITE.md "Other websites"): a small
// one-purpose site — a petition, a contrast site — on a domain of its own,
// with its own name, look and pages, whose forms land in the same people
// database. The organization, the privacy policy, the social accounts and
// "Authorized by …" are always the main site's: the same elector
// organization sponsors every site and keeps what every form collects.
//
//   site.microsite.create   { name, domain? } → { microsite }   a draft, with a
//                           home page (a hero, then the newest open petition,
//                           else the newsletter)
//   site.microsite.save     { id, name?, theme? }  name: managers only
//   site.microsite.domains  { id, domains: [≤ 2] }  the bare domain and its www.
//   site.microsite.live     { id, live }  live: refused with the first thing
//                           missing (its home page published, who authorized
//                           it, the privacy policy link)
//   site.microsite.delete   { id } · site.microsite.restore { id }
//   site.microsite.release  { id }  its closed addresses let go
//
// Everything but a look or a page is a manager's decision (going live
// publishes election advertising under the campaign's name), whoever else
// a manager grants Website to. A domain a site no longer uses — dropped, or
// the site deleted — stays closed ("This website has closed", public.js),
// never handed back to the app, until a manager releases it.
import { z } from 'zod';
import { newModule, checkModules } from '@starbase/shared/site/catalogue';
import { checkTheme } from '@starbase/shared/site/theme';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { brandKey } from '../../lib/brand.js';
import { slugify, hostOf } from './shape.js';
import { parseJ, readSettings, siteOf, isAppHost, envHosts, appHostSeen, usedWhy } from './store.js';

export const MAX_SITES = 5;
export const MAX_PAGES = 50;
const MANAGER_ONLY = 'Only a manager can do this';
const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);

export const micrositeOut = (r) => ({
  id: r.id, key: r.key, name: r.name, status: r.status,
  domains: parseJ(r.domains, []), held_domains: parseJ(r.held_domains, []),
  theme: parseJ(r.theme, {}),
  created_at: iso(r.created_at), updated_at: iso(r.updated_at), deleted_at: iso(r.deleted_at),
});

const manager = (ctx) => {
  if (ctx.role !== 'manager') throw httpError(403, MANAGER_ONLY);
};

// One of this campaign's other websites (not deleted unless asked), locked
// for the write.
export const loadMicrosite = async (tx, ws, id, { deleted = false } = {}) => {
  const r = (await tx.query(
    `select * from microsites where id = $1 and workspace_id = $2 and deleted_at is ${deleted ? 'not null' : 'null'} for update`, [id, ws],
  )).rows[0];
  if (!r) throw httpError(404, 'That website is gone — reload');
  return r;
};

const inUse = async (tx, ws) => Number((await tx.query(
  'select count(*)::int as n from microsites where workspace_id = $1 and deleted_at is null', [ws],
)).rows[0].n);

// A key (its path at /site/sites/<key>/) made from the name, free in the campaign.
const freeKey = async (tx, ws, name) => {
  const base = slugify(String(name).replace(/['’]/g, '')).slice(0, 50) || 'site';
  for (let i = 1; i < 200; i += 1) {
    const k = i === 1 ? base : `${base}-${i}`;
    if (!(await tx.query('select 1 from microsites where workspace_id = $1 and key = $2 and deleted_at is null', [ws, k])).rows[0]) return k;
  }
  throw httpError(409, 'Pick another name');
};

// Why a host can't be a website's address (null: it can). selfMicro: the
// website being saved (its own addresses are fine); main: the save is the
// main site's. → { why } or { take: [{ id, field }] } — an address a
// closed website of this campaign still holds, which this save takes from it.
export const hostProblem = async (tx, ctx, h, { selfMicro = null, main = false, already = [] } = {}) => {
  const ws = ctx.workspaceId;
  if (isAppHost(h, ctx.host ? [ctx.host] : [])) {
    return { why: `${h} is where base.win itself answers — on a website domain only the site does, so the app would stop working there. Add your campaign’s own domain (like yourcampaign.ca).` };
  }
  if (!main && envHosts().includes(h)) return { why: `${h} is your main website’s address` };
  const seen = already.includes(h) || envHosts().includes(h) ? null : await appHostSeen(tx, h);
  if (seen) return { why: usedWhy(h, seen, ctx) };
  const settings = (await tx.query(
    'select workspace_id from site_settings where domains @> $1::jsonb' + (main ? ' and workspace_id <> $2' : ''), main ? [JSON.stringify([h]), ws] : [JSON.stringify([h])],
  )).rows[0];
  if (settings) return { why: settings.workspace_id === ws ? `${h} is your main website’s address` : `${h} is another campaign's address` };
  const live = (await tx.query(
    `select id, workspace_id, name from microsites where deleted_at is null and domains @> $1::jsonb and ($2::uuid is null or id <> $2::uuid)`,
    [JSON.stringify([h]), selfMicro],
  )).rows[0];
  if (live) return { why: live.workspace_id === ws ? `${h} is the address of ${live.name}` : `${h} is another campaign's address` };
  const held = (await tx.query(
    `select id, workspace_id, deleted_at from microsites
      where (held_domains @> $1::jsonb or (deleted_at is not null and domains @> $1::jsonb)) and ($2::uuid is null or id <> $2::uuid)`,
    [JSON.stringify([h]), selfMicro],
  )).rows;
  if (held.some((r) => r.workspace_id !== ws)) return { why: 'That address belongs to a closed website of another campaign on this server' };
  return { take: held.map((r) => r.id) };
};

// Takes a closed address from the websites of this campaign that still hold it.
export const takeHeld = async (tx, ws, h, ids, emit) => {
  for (const id of ids) {
    const r = (await tx.query('select held_domains, domains, deleted_at from microsites where id = $1 and workspace_id = $2 for update', [id, ws])).rows[0];
    if (!r) continue;
    const held = parseJ(r.held_domains, []).filter((d) => d !== h);
    const domains = r.deleted_at ? parseJ(r.domains, []).filter((d) => d !== h) : parseJ(r.domains, []);
    await tx.query('update microsites set held_domains = $3, domains = $4, updated_at = now() where id = $1 and workspace_id = $2',
      [id, ws, JSON.stringify(held), JSON.stringify(domains)]);
    emit('microsite', id, 'update', { released: [h], taken: true });
  }
};

// The addresses a save asks for, checked: at most two, the second the
// www. of the first.
const hostsOf = (list) => {
  const hosts = [];
  for (const d of list) {
    const h = hostOf(d);
    if (!h) throw httpError(400, `“${d}” isn't a web address (like yourcampaign.ca)`);
    if (!hosts.includes(h)) hosts.push(h);
  }
  if (hosts.length > 2) throw httpError(400, 'Two addresses at most: the domain and its www.');
  if (hosts.length === 2 && hosts[1] !== `www.${hosts[0]}` && hosts[0] !== `www.${hosts[1]}`) {
    throw httpError(400, 'The second address must be the www. of the first');
  }
  return hosts;
};

const setDomains = async (tx, ctx, row, list, emit) => {
  const ws = ctx.workspaceId;
  const hosts = hostsOf(list);
  const had = parseJ(row.domains, []);
  for (const h of hosts) {
    const p = await hostProblem(tx, ctx, h, { selfMicro: row.id, already: had });
    if (p.why) throw httpError(400, p.why);
    await takeHeld(tx, ws, h, p.take, emit);
  }
  // What it no longer uses stays closed until a manager releases it.
  const dropped = had.filter((h) => !hosts.includes(h));
  const cur = (await tx.query('select held_domains from microsites where id = $1', [row.id])).rows[0];
  const held = [...new Set([...parseJ(cur.held_domains, []), ...dropped])].filter((h) => !hosts.includes(h));
  const out = (await tx.query(
    'update microsites set domains = $3, held_domains = $4, updated_at = now() where id = $1 and workspace_id = $2 returning *',
    [row.id, ws, JSON.stringify(hosts), JSON.stringify(held)],
  )).rows[0];
  emit('microsite', row.id, 'update', { domains: hosts, ...(dropped.length ? { held: dropped } : {}) });
  return out;
};

// Its first page: a hero with its name, then the newest open petition
// (Website → Petitions) — else the newsletter. The catalogue's own words;
// no buttons to pages it doesn't have.
const homeModules = async (tx, ws, name) => {
  const hero = newModule('hero', 'hero');
  hero.props = { ...hero.props, titlePrefix: name.slice(0, 80), primaryCta: { label: '', href: '' }, secondaryCtas: [] };
  const petition = (await tx.query(
    "select id from site_campaigns where workspace_id = $1 and deleted_at is null and status = 'open' and kind = 'petition' order by created_at desc, id limit 1", [ws],
  )).rows[0];
  const second = petition ? { ...newModule('petition', 'petition'), props: { ...newModule('petition', 'p').props, campaign: petition.id } } : newModule('newsletter', 'newsletter');
  return checkModules([hero, second]);
};

const pageCount = async (tx, ws, siteId) => Number((await tx.query(
  'select count(*)::int as n from site_pages where workspace_id = $1 and site_id = $2 and deleted_at is null', [ws, siteId],
)).rows[0].n);
// Another page on this website: refused past 50.
export const roomForPage = async (tx, ws, siteId) => {
  if (siteId && await pageCount(tx, ws, siteId) >= MAX_PAGES) throw httpError(400, `${MAX_PAGES} pages is the most for one website`);
};

export const micrositeActions = (siteAction) => ({
  'site.microsite.create': siteAction(z.object({
    name: z.string().trim().min(1, 'Give it a name').max(60),
    domain: z.string().max(300).nullish(),
  }), async (tx, ctx, input, emit) => {
    manager(ctx);
    const ws = ctx.workspaceId;
    if (await inUse(tx, ws) >= MAX_SITES) throw httpError(400, 'Five other websites is the most — delete one first');
    const key = await freeKey(tx, ws, input.name);
    // The look the main site wears now, its own from here on.
    const settings = await readSettings(tx, ws);
    const camp = ctx.workspace || (await tx.query('select name, settings from workspaces where id = $1', [ws])).rows[0];
    const drawn = siteOf(settings, [], camp).theme;
    // Its own name in the header, not the campaign's logo.
    const theme = checkTheme({ ...drawn, follow: false, kept: false, logo: { url: '', alt: '' } }, brandKey()).theme;
    const id = newId();
    let row = (await tx.query(
      `insert into microsites (id, workspace_id, key, name, theme) values ($1, $2, $3, $4, $5) returning *`,
      [id, ws, key, input.name, JSON.stringify(theme)],
    )).rows[0];
    emit('microsite', id, 'create', { key, name: input.name });
    const modules = await homeModules(tx, ws, input.name);
    const pageId = newId();
    await tx.query(
      `insert into site_pages (id, workspace_id, site_id, slug, title, description, draft, show_in_nav, nav_order)
       values ($1, $2, $3, 'home', $4, '', $5, false, 0)`,
      [pageId, ws, id, input.name, JSON.stringify({ title: input.name, description: '', modules })],
    );
    emit('site_page', pageId, 'create', { slug: 'home', title: input.name, site_id: id, modules: modules.map((m) => ({ id: m.id, kind: m.kind, hidden: false })) });
    if (input.domain && String(input.domain).trim()) row = await setDomains(tx, ctx, row, [input.domain], emit);
    return { microsite: micrositeOut(row), home_page_id: pageId };
  }),

  'site.microsite.save': siteAction(z.object({
    id: z.uuid(),
    name: z.string().trim().min(1, 'Give it a name').max(60).optional(),
    theme: z.record(z.string(), z.any()).optional(),
  }), async (tx, ctx, input, emit) => {
    const ws = ctx.workspaceId;
    const cur = await loadMicrosite(tx, ws, input.id);
    if (input.name !== undefined && input.name !== cur.name) manager(ctx);
    const sets = [];
    const params = [cur.id, ws];
    const changed = {};
    if (input.name !== undefined && input.name !== cur.name) {
      params.push(input.name); sets.push(`name = $${params.length}`); changed.name = input.name;
    }
    if (input.theme !== undefined) {
      const { theme, problems } = checkTheme({ ...input.theme, follow: false, kept: false }, brandKey());
      if (problems.length) {
        const p = problems[0];
        throw httpError(400, `${p.pair.label}: ${p.ratio.toFixed(1)}:1 is too hard to read — it needs 4.5:1. Pick a darker or lighter colour.`);
      }
      params.push(JSON.stringify(theme)); sets.push(`theme = $${params.length}`); changed.theme = theme;
    }
    if (!sets.length) return { microsite: micrositeOut(cur) };
    const row = (await tx.query(`update microsites set ${sets.join(', ')}, updated_at = now() where id = $1 and workspace_id = $2 returning *`, params)).rows[0];
    emit('microsite', cur.id, 'update', changed);
    return { microsite: micrositeOut(row) };
  }),

  'site.microsite.domains': siteAction(z.object({
    id: z.uuid(),
    domains: z.array(z.string().max(300)).max(2),
  }), async (tx, ctx, input, emit) => {
    manager(ctx);
    const cur = await loadMicrosite(tx, ctx.workspaceId, input.id);
    return { microsite: micrositeOut(await setDomains(tx, ctx, cur, input.domains, emit)) };
  }),

  'site.microsite.live': siteAction(z.object({ id: z.uuid(), live: z.boolean() }), async (tx, ctx, input, emit) => {
    manager(ctx);
    const ws = ctx.workspaceId;
    const cur = await loadMicrosite(tx, ws, input.id);
    if (input.live) {
      const missing = (await liveChecklist(tx, ws, cur.id)).find((x) => !x.done);
      if (missing) throw httpError(400, missing.why);
    }
    const status = input.live ? 'live' : 'draft';
    if (status === cur.status) return { microsite: micrositeOut(cur) };
    const row = (await tx.query("update microsites set status = $3, updated_at = now() where id = $1 and workspace_id = $2 returning *", [cur.id, ws, status])).rows[0];
    emit('microsite', cur.id, 'update', { status });
    return { microsite: micrositeOut(row) };
  }),

  'site.microsite.delete': siteAction(z.object({ id: z.uuid() }), async (tx, ctx, input, emit) => {
    manager(ctx);
    const ws = ctx.workspaceId;
    const cur = await loadMicrosite(tx, ws, input.id);
    // Its pages go with it (now() is the same for both, so a restore brings
    // back exactly these); its addresses stay on it, closed.
    await tx.query('update microsites set deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2', [cur.id, ws]);
    await tx.query('update site_pages set deleted_at = now(), updated_at = now() where workspace_id = $1 and site_id = $2 and deleted_at is null', [ws, cur.id]);
    emit('microsite', cur.id, 'void', { key: cur.key, closed: parseJ(cur.domains, []) });
    return { id: cur.id };
  }),

  'site.microsite.restore': siteAction(z.object({ id: z.uuid() }), async (tx, ctx, input, emit) => {
    manager(ctx);
    const ws = ctx.workspaceId;
    const cur = await loadMicrosite(tx, ws, input.id, { deleted: true });
    if (await inUse(tx, ws) >= MAX_SITES) throw httpError(400, 'Five other websites is the most — delete one first');
    const taken = (await tx.query('select 1 from microsites where workspace_id = $1 and key = $2 and deleted_at is null', [ws, cur.key])).rows[0];
    const key = taken ? await freeKey(tx, ws, cur.key) : cur.key;
    // An address another website (or the main site) took meanwhile stays theirs.
    const had = parseJ(cur.domains, []);
    const domains = [];
    for (const h of had) {
      const p = await hostProblem(tx, ctx, h, { selfMicro: cur.id, already: had });
      if (!p.why) domains.push(h);
    }
    // Its pages deleted with it (the same moment, to the microsecond).
    await tx.query(
      `update site_pages set deleted_at = null, updated_at = now() where workspace_id = $1 and site_id = $2
          and deleted_at = (select deleted_at from microsites where id = $2)`, [ws, cur.id],
    );
    const row = (await tx.query(
      `update microsites set deleted_at = null, key = $3, domains = $4, status = 'draft', updated_at = now() where id = $1 and workspace_id = $2 returning *`,
      [cur.id, ws, key, JSON.stringify(domains)],
    )).rows[0];
    const was = {
      ...(key !== cur.key ? { key: cur.key } : {}),
      ...(cur.status !== 'draft' ? { status: cur.status } : {}),
      ...(domains.length !== had.length ? { domains: had } : {}),
    };
    emit('microsite', cur.id, 'restore', { key, domains, status: 'draft', ...(Object.keys(was).length ? { was } : {}) });
    return { microsite: micrositeOut(row) };
  }),

  'site.microsite.release': siteAction(z.object({ id: z.uuid() }), async (tx, ctx, input, emit) => {
    manager(ctx);
    const ws = ctx.workspaceId;
    const cur = (await tx.query('select * from microsites where id = $1 and workspace_id = $2 for update', [input.id, ws])).rows[0];
    if (!cur) throw httpError(404, 'That website is gone — reload');
    const hosts = [...parseJ(cur.held_domains, []), ...(cur.deleted_at ? parseJ(cur.domains, []) : [])];
    const row = (await tx.query(
      `update microsites set held_domains = '[]', domains = case when deleted_at is null then domains else '[]'::jsonb end, updated_at = now()
        where id = $1 and workspace_id = $2 returning *`, [cur.id, ws],
    )).rows[0];
    emit('microsite', cur.id, 'update', { released: hosts });
    return { microsite: micrositeOut(row), released: hosts };
  }),
});

// What going live needs, in the order the screen and the refusal say it.
export const liveChecklist = async (q, ws, siteId) => {
  const home = (await q.query(
    "select 1 from site_pages where workspace_id = $1 and site_id = $2 and slug = 'home' and status = 'published' and deleted_at is null", [ws, siteId],
  )).rows[0];
  const org = (await readSettings(q, ws))?.org || {};
  return [
    { key: 'home', done: Boolean(home), why: 'Publish the home page first' },
    { key: 'authorized', done: Boolean(org.agentName && org.agentContact), why: 'Add who authorized it: Website → Settings → Organization → Authorized by' },
    { key: 'privacy', done: Boolean(org.privacyUrl), why: 'Add your privacy policy link: Website → Settings → Organization' },
  ];
};
