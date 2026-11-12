// "Did on the website" — a People filter, so every audience has it: People,
// Calls, a saved list, a send and a phone bank built from one
// (lib/audience.js personsWhere and its FILTER_KEYS):
//   web=petition            did that kind of thing on the website (words.js
//                           WEB_KINDS: newsletter, petition, pledge,
//                           volunteer, rsvp, contact, join, donate)
//   web=campaign:<id>       signed that petition or took that pledge
//   web=any                 did anything on the website
//   web=site:<id>           did something on one of the campaign's other
//                           websites (never by the money forms)
// Read from the site server's site_actions (SITE.md), which name the person
// each action is about. A value it doesn't know matches nobody, never
// everybody; so does every value before the website exists. A volunteer
// can't sort people by the money forms (join, donate): they never see money.
//
//   GET /webdid   any role: what the filter can offer, with how many people
//       did each — { kinds: [{ kind, label, n }], campaigns: [{ id, kind,
//       title, label, n }], sites: [{ id, name, label, n }] } (a volunteer:
//       no money forms). Empty before the website exists.
import { Hono } from 'hono';
import {
  WEB_KINDS, WEB_WORDS, MONEY_KINDS, campaignOf, campaignWords, campaignsOf, hasTable, siteOfValue,
} from './words.js';

const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);

// The WHERE piece (alias p) for one value, on w's params — also what a map
// filter would use. Returns false for a value that matches nobody.
export const webWhere = (ctx, value, w) => {
  const v = str(value).toLowerCase();
  const vol = ctx.role === 'volunteer';
  const next = (x) => { w.params.push(x); return `$${w.params.length}`; };
  const base = 'select 1 from site_actions a where a.workspace_id = p.workspace_id and a.person_id = p.id';
  if (v === 'any') {
    w.where += ` and exists (${base}${vol ? ` and a.kind <> all(${next([...MONEY_KINDS])}::text[])` : ''})`;
    return true;
  }
  const campaign = campaignOf(v);
  if (campaign) {
    // As text: the same whether the site server keeps the id as a uuid or text.
    w.where += ` and exists (${base} and a.campaign_id::text = ${next(campaign)})`;
    return true;
  }
  const site = siteOfValue(v);
  if (site) {
    w.where += ` and exists (${base} and a.site_id::text = ${next(site)} and a.kind <> all(${next([...MONEY_KINDS])}::text[]))`;
    return true;
  }
  if (WEB_KINDS.includes(v) && !(vol && MONEY_KINDS.has(v))) {
    w.where += ` and exists (${base} and a.kind = ${next(v)})`;
    return true;
  }
  return false;
};

const personsWhere = async (db, ctx, query, w) => {
  const v = str(query?.web);
  if (!v) return;
  if (!(await hasTable(db, 'site_actions')) || !webWhere(ctx, v, w)) w.where += ' and false';
};

export const hooks = { personsWhere };

export const api = new Hono();

api.get('/webdid', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  if (!(await hasTable(db, 'site_actions'))) return c.json({ kinds: [], campaigns: [], sites: [] });
  const vol = ctx.role === 'volunteer';
  const byKind = new Map((await db.query(
    `select a.kind, count(distinct a.person_id)::int as n
     from site_actions a join persons p on p.id = a.person_id and p.deleted_at is null
     where a.workspace_id = $1 group by a.kind`,
    [ws],
  )).rows.map((r) => [r.kind, r.n]));
  const byCampaign = new Map((await db.query(
    `select a.campaign_id::text as id, count(distinct a.person_id)::int as n
     from site_actions a join persons p on p.id = a.person_id and p.deleted_at is null
     where a.workspace_id = $1 and a.campaign_id is not null group by a.campaign_id::text`,
    [ws],
  )).rows.map((r) => [String(r.id), r.n]));
  const campaigns = (await campaignsOf(db, ws))
    .filter((x) => byCampaign.has(String(x.id)))
    .map((x) => ({ id: x.id, kind: x.kind, title: x.title, label: campaignWords(x), n: byCampaign.get(String(x.id)) }));
  // The other websites people did something on (not the money forms).
  const sites = (await hasTable(db, 'microsites')) ? (await db.query(
    `select m.id, m.name, m.domains->>0 as domain, count(distinct a.person_id)::int as n
       from microsites m
       join site_actions a on a.workspace_id = m.workspace_id and a.site_id = m.id and a.kind <> all($2::text[])
       join persons p on p.id = a.person_id and p.deleted_at is null
      where m.workspace_id = $1 and m.deleted_at is null
      group by m.id, m.name, m.domains, m.created_at order by m.created_at`,
    [ws, [...MONEY_KINDS]],
  )).rows.map((r) => ({ id: r.id, name: r.name, label: `Did something on ${r.domain || r.name}`, n: r.n })) : [];
  return c.json({
    sites,
    kinds: WEB_KINDS.filter((k) => byKind.get(k) && !(vol && MONEY_KINDS.has(k))).map((k) => ({ kind: k, label: WEB_WORDS[k], n: byKind.get(k) })),
    campaigns,
  });
});
