// What the renderer gets as `data` (SITE.md), read live from base.win:
//
//   posts      [{ slug, title, excerpt, image, published_at }]  newest first, published only
//   events     [{ id, title, starts_at, ends_at, location, spots_left, lat, lng, drop_in? }]
//              upcoming shifts the desk made public that are events (the
//              Event kind: shared/shiftkinds.js); spots_left null when
//              there's no limit (booked = assigned or confirmed, as the app
//              counts); lat/lng: the pin of its saved place, when it has one.
//              A place nobody has named has no words ('') — only its pin:
//              the card says "See the map", never its coordinates
//   shifts     the same rows for every other kind — the volunteer openings.
//              A shift made before kinds has none and is in both lists, as
//              it always was
//   counts     { members, signatures: { [campaignId]: n } }
//   campaigns  { [id]: { id, slug, kind, title, excerpt, statement, goal, count, status } }
//   payments   { ready, limit_cents, monthly_max_cents }  this year's limit (lib/cap.js)
//   roles      [string]  the volunteer roles base.win offers
//
// A few small indexed reads; the page cache (cache.js) keeps the drawn page.
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import { SHIFT_KIND_CODES, SITE_KINDS, pinPoint } from '@starbase/shared/shiftkinds';
import { capFor } from '../../lib/cap.js';
import { paymentsReady } from './payments.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));

// The contribution year: the campaign's calendar year (Pacific for BC).
export const campaignYear = (ws) => {
  const tz = ws?.settings?.tz || 'America/Vancouver';
  try { return Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date())); } catch { return new Date().getUTCFullYear(); }
};

// This year's limit and the most a month may be (a twelfth, whole dollars).
export const limitsFor = async (q, ws) => {
  const rule = await capFor(q, ws.jurisdiction, campaignYear(ws), ws.settings || {});
  if (!rule) return { limit_cents: null, monthly_max_cents: null };
  return { limit_cents: rule.capCents, monthly_max_cents: Math.floor(rule.capCents / 12 / 100) * 100 };
};

export const loadPosts = async (q, ws, limit = 24) => (await q.query(
  `select slug, title, excerpt, image, published_at from site_posts
    where workspace_id = $1 and deleted_at is null and status = 'published' and published_at <= now()
    order by published_at desc, created_at desc limit $2`, [ws.id, limit],
)).rows.map((r) => ({ slug: r.slug, title: r.title, excerpt: r.excerpt || '', image: parseJ(r.image, {}) || {}, published_at: iso(r.published_at) }));

// Upcoming public shifts for one of the website's lists — 'event' or
// 'opening' — soonest first. The kind decides the list (ext/schedule); a
// shift with no kind (or one this build doesn't know) is in both.
export const loadEvents = async (q, ws, limit = 24, list = 'event') => (await q.query(
  `select s.id, s.title, s.starts_at, s.ends_at, s.location, s.capacity, s.drop_in, pl.lat, pl.lng,
          (select count(*)::int from shift_assignments a
            where a.shift_id = s.id and a.workspace_id = s.workspace_id and a.status in ('assigned', 'confirmed')) as booked
     from shifts s left join places pl on pl.id = s.place_id
    where s.workspace_id = $1 and s.deleted_at is null and s.public and coalesce(s.ends_at, s.starts_at) >= now()
      and (s.kind is null or s.kind = any($3::text[]) or not (s.kind = any($4::text[])))
    order by s.starts_at, s.id limit $2`, [ws.id, limit, SITE_KINDS[list] || SITE_KINDS.event, SHIFT_KIND_CODES],
)).rows.map((s) => {
  // Words that are only a pin's coordinates: no words, the pin (its place's,
  // else the words' own) gives the card its map.
  const pin = pinPoint(s.location);
  return {
    id: s.id, title: s.title, starts_at: iso(s.starts_at), ends_at: iso(s.ends_at), location: pin ? '' : s.location || '',
    ...(s.drop_in ? { drop_in: true } : {}),
    spots_left: s.capacity ? Math.max(0, s.capacity - s.booked) : null,
    lat: s.lat == null ? pin?.lat ?? null : Number(s.lat), lng: s.lng == null ? pin?.lng ?? null : Number(s.lng),
  };
});

export const loadData = async (q, ws, { posts = 24 } = {}) => {
  const [postRows, events, shifts, members, sigs, campaigns, limits, ready] = [
    await loadPosts(q, ws, posts),
    await loadEvents(q, ws, 24, 'event'),
    await loadEvents(q, ws, 24, 'opening'),
    (await q.query(
      `select count(distinct person_id)::int as n from member_terms
        where workspace_id = $1 and voided_at is null and starts_on <= current_date and ends_on >= current_date`, [ws.id],
    )).rows[0].n,
    (await q.query(
      `select campaign_id, count(distinct person_id)::int as n from site_actions
        where workspace_id = $1 and campaign_id is not null and kind in ('petition', 'pledge') group by campaign_id`, [ws.id],
    )).rows,
    (await q.query(
      `select id, slug, kind, title, excerpt, statement, goal, status from site_campaigns
        where workspace_id = $1 and deleted_at is null order by created_at`, [ws.id],
    )).rows,
    await limitsFor(q, ws),
    await paymentsReady(),
  ];
  const signatures = Object.fromEntries(sigs.map((r) => [r.campaign_id, r.n]));
  return {
    posts: postRows,
    events,
    shifts,
    counts: { members, signatures },
    campaigns: Object.fromEntries(campaigns.map((c) => [c.id, {
      id: c.id, slug: c.slug, kind: c.kind, title: c.title, excerpt: c.excerpt || '', statement: c.statement || '',
      goal: c.goal == null ? null : Number(c.goal), count: signatures[c.id] || 0, status: c.status,
    }])),
    payments: { ready, ...limits },
    roles: VOLUNTEER_ROLES.map((r) => r.label),
  };
};
