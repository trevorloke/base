// The website's events, for calendars (ext/calendar owns the rest):
//   <root>/events.ics           the upcoming public shifts of the Events list
//   <root>/events/<id>.ics      one public, upcoming shift from either list
// Only where this site lists them: a published page of THIS site (the main
// site, or the other website being served: site.micro) has an
// Events or Volunteer openings section that isn't hidden. Elsewhere both
// are the site's 404, so a microsite with no such section never serves the
// campaign's events.
// What a public entry carries: its title, times (UTC), the place's words
// (none for an unnamed pin), GEO when pinned, and the page it is listed on.
// Never instructions, a link, counts or people.
import { icsCalendar, shiftEvent } from '@starbase/shared/ics';
import { pinPoint } from '@starbase/shared/shiftkinds';
import { icsFileName, ICS_TYPE } from '../../lib/calendar.js';
import { loadEvents } from './loaders.js';

// null is the main site.
export const siteListsEvents = async (q, ws, siteId = null) => (await q.query(
  `select 1 from site_pages p
     cross join lateral jsonb_array_elements(case when jsonb_typeof(p.published->'modules') = 'array' then p.published->'modules' else '[]'::jsonb end) m
    where p.workspace_id = $1 and p.deleted_at is null and p.status = 'published'
      and (to_jsonb(p)->>'site_id') is not distinct from $2::text
      and m->>'kind' in ('events', 'shifts') and coalesce(m->>'hidden', 'false') <> 'true'
    limit 1`,
  [ws.id, siteId],
)).rows.length > 0;

// One public, upcoming shift, from either list (every kind is on one of
// them), shaped as loadEvents shapes a row: a pin's words are no words.
const loadOne = async (q, ws, id) => {
  const s = (await q.query(
    `select s.id, s.title, s.kind, s.starts_at, s.ends_at, s.location, pl.lat, pl.lng
       from shifts s left join places pl on pl.id = s.place_id
      where s.id = $1 and s.workspace_id = $2 and s.deleted_at is null and s.public
        and coalesce(s.ends_at, s.starts_at) >= now()`, [id, ws.id],
  )).rows[0];
  if (!s) return null;
  const pin = pinPoint(s.location);
  return {
    ...s, location: pin ? '' : s.location || '',
    lat: s.lat == null ? pin?.lat ?? null : Number(s.lat), lng: s.lng == null ? pin?.lng ?? null : Number(s.lng),
  };
};

// org: the site's org (name, authorization) as the pages draw it.
const publicEvent = (e, { tz, org, home, address }) => {
  const ev = shiftEvent({ ...e, place_lat: e.lat, place_lng: e.lng }, { tz, private: false });
  const sign = [`${org.name} — ${address}`, org.authorization || null].filter(Boolean).join('\n');
  return { ...ev, details: `${ev.details}\n${sign}`, url: home };
};

// The two routes' answers, or null for the site's 404.
export const eventsCalendar = async (site, org, { id = null } = {}) => {
  if (!await siteListsEvents(site.db, site.ws, site.micro?.id ?? null)) return null;
  const tz = site.ws.settings?.tz || 'America/Vancouver';
  const home = `${site.address}${site.root}/`;
  const at = { tz, org, home, address: `${site.address}${site.root}` };
  if (id) {
    const e = await loadOne(site.db, site.ws, id);
    if (!e) return null;
    return { body: icsCalendar({ name: `${org.name} events`, events: [publicEvent(e, at)] }), filename: icsFileName(e.title) };
  }
  const list = await loadEvents(site.db, site.ws, 200, 'event');
  return { body: icsCalendar({ name: `${org.name} events`, events: list.map((e) => publicEvent(e, at)) }), filename: 'events.ics' };
};

export const calendarHeaders = (filename, noindex) => ({
  'Content-Type': ICS_TYPE,
  'Content-Disposition': `inline; filename="${filename}"`,
  'Cache-Control': 'public, max-age=600',
  'X-Content-Type-Options': 'nosniff',
  ...(noindex ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
});
