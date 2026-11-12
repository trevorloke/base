// The website inside base.win (SITE.md is the contract; ROADMAP.md "Build now" 2–3).
//
// Admin API — signed in, the 'site' area ("Website": managers, or whoever a
// manager grants it to under Admin → Permissions); everyone else gets 403.
//   GET  /api/site                 { settings, pages: [page, without draft and
//                                  published], counts: { pages, published, posts,
//                                  posts_published, campaigns, campaigns_open,
//                                  actions, actions_week, actions_week_by_kind },
//                                  urls: { site, domains, hosts, app_hosts, used_hosts },
//                                  payments: { ready } }
//                                  — the first look makes the campaign's site
//                                  from its brand's seed (seeds/)
//   GET  /api/site/pages/:id       { page: { id, slug, title, description, status,
//                                  version, show_in_nav, nav_order, published_at,
//                                  created_at, updated_at, changed, modules (count),
//                                  draft, published } }  draft/published: { title,
//                                  description, modules: [{ id, kind, hidden, props }] }
//   GET  /api/site/posts           { posts: [{ id, slug, title, excerpt, image, status, published_at, … }] }
//   GET  /api/site/posts/:id       { post: { …, body } }
//   GET  /api/site/campaigns       { campaigns: [{ id, slug, kind, title, excerpt, statement,
//                                  goal, status, signatures, signers_tag, … }] }
//   GET  /api/site/campaigns/:id   { campaign: { …, body } }
//   GET  /api/site/pictures        { pictures: [{ id, url, name, width, height, bytes, … }] }
//   POST /api/site/preview-token   { pageId } → { url, expires_at }  a link to the
//                                  page's draft for 30 minutes (frameable by the app)
// Writes are actions (POST /api/actions/:name, actions.js has the inputs):
//   site.settings.save · site.page.create | save | publish | unpublish |
//   duplicate | delete | restore | reorder · site.microsite.create | save |
//   domains | live | delete | restore | release (the campaign's other
//   websites: microsites.js) · site.post.save | publish |
//   delete | restore · site.campaign.save | close | delete | restore
//   (restore: the Website screens' Undo) · site.picture (a picture for the
//   site, served at /media/:id like Outreach's) · shift.public (the desk:
//   a shift on the site's events).
//
// The public site: public.js (routes, host rule, cache, preview, headers),
// forms.js (POST {site}/api/forms/:kind), consent.js, people.js,
// loaders.js (the renderer's data), tokens.js (signed links), seeds/.
// Rendering is ./render (renderSite, SITE.md "Rendering").
//
// For the rest of base.win:
//   personToken(workspaceId, personId) → a token for {site}/preferences?t=…
//     and {site}/unsubscribe?t=… in an email (a supporter's own choices)
//   the events hook records base.win's own consent changes (an unsubscribe
//     link, STOP/START, the desk's Add/Remove, a do-not-email/-text tag) in
//     consent_events, and keeps a referral pointing at a merged record
//   site_action events (kind, person_id, campaign_id, page_id, module_id,
//     source, referrer_id) are the hook for follow-ups, ladders and filters
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { publicRoutes, siteGate, personToken } from './public.js';
import { consentFromEvents, consentEventsToRead } from './consent.js';

// A record merged into another (ext/duplicates moves every person_id column;
// a referrer is site_actions.referrer_id): the referrals follow it.
const merges = (events) => events.filter((e) => e.entityType === 'person' && e.op === 'void' && e.payload?.merged_into);
const referralsFollowMerge = async (tx, meta, events) => {
  for (const e of merges(events)) {
    await tx.query(
      'update site_actions set referrer_id = $3 where workspace_id = $1 and referrer_id = $2',
      [meta.workspaceId, e.entityId, e.payload.merged_into],
    );
  }
};

// Every write in base.win passes here. Most have nothing for the website
// (no query at all); what does is done inside a savepoint, so a problem
// here never costs the write it rides on — it is logged, and the write goes on.
export const hooks = {
  events: async (tx, meta, events) => {
    if (!consentEventsToRead(meta, events).length && !merges(events).length) return;
    await tx.query('savepoint site_hook');
    try {
      await consentFromEvents(tx, meta, events);
      await referralsFollowMerge(tx, meta, events);
      await tx.query('release savepoint site_hook');
    } catch (e) {
      await tx.query('rollback to savepoint site_hook');
      console.error(`site: the consent record missed ${meta.action}: ${e.message}`);
    }
  },
};

// In GET /api/export (rows of this campaign). site_keys holds the server's
// signing secret and is never exported.
export const exportTables = ['site_settings', 'site_pages', 'site_posts', 'site_campaigns', 'site_actions', 'consent_events', 'microsites'];
