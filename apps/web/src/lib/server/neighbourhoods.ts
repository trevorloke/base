import "server-only";
import { and, arrayContains, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { campaigns, eventRsvps, events, trackerPromises } from "@/lib/db/schema";
import { googleCalendarUrl, icsCalendar, pacificDate, type IcsEvent } from "@/lib/ics";
import type { Neighbourhood } from "@/lib/neighbourhoods";
import { spotsLeft } from "@/lib/shifts";
import { cached, TAGS } from "./cache";
import { queryPublicOpenings, type PublicOpening } from "./volunteer";
import { clientProfile } from "@/seeds/client";

/** A published event as the public pages show it. Dates are ISO strings: cached values are served as JSON. */
export type PublicEvent = {
  id: string;
  slug: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string;
  address: string | null;
  summary: string;
  description: string;
  imageUrl: string | null;
  capacity: number | null;
  neighbourhood: string | null;
  /** People going: RSVPs plus the guests they bring. */
  going: number;
  /** Spots left when the event has a capacity, else null. */
  spotsLeft: number | null;
};

type EventRow = typeof events.$inferSelect;

async function goingByEvent(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ eventId: eventRsvps.eventId, going: sql<number>`(count(*) + coalesce(sum(${eventRsvps.guests}), 0))::int` })
    .from(eventRsvps)
    .where(inArray(eventRsvps.eventId, ids))
    .groupBy(eventRsvps.eventId);
  return new Map(rows.map((r) => [r.eventId, r.going]));
}

function toPublic(e: EventRow, going: number): PublicEvent {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt?.toISOString() ?? null,
    location: e.location,
    address: e.address,
    summary: e.summary,
    description: e.description,
    imageUrl: e.imageUrl,
    capacity: e.capacity,
    neighbourhood: e.neighbourhood,
    going,
    spotsLeft: e.capacity == null ? null : spotsLeft(e.capacity, going),
  };
}

async function withCounts(rows: EventRow[]): Promise<PublicEvent[]> {
  const going = await goingByEvent(rows.map((r) => r.id));
  return rows.map((r) => toPublic(r, going.get(r.id) ?? 0));
}

/** Events from the start of `today` (Surrey time) on, so today's are listed until the day ends. */
async function queryUpcoming(today: string, where?: ReturnType<typeof eq>, limit = 50): Promise<PublicEvent[]> {
  const rows = await getDb()
    .select()
    .from(events)
    .where(and(eq(events.published, true), gte(events.startsAt, pacificDate(today, 0)), where))
    .orderBy(asc(events.startsAt))
    .limit(limit);
  return withCounts(rows);
}

export const upcomingEventsPublic = cached("public-events", [TAGS.events, TAGS.counters], async (today: string): Promise<PublicEvent[]> => queryUpcoming(today));

export const eventPublic = cached("public-event", [TAGS.events, TAGS.counters], async (slug: string): Promise<PublicEvent | null> => {
  const row = await getDb().query.events.findFirst({ where: and(eq(events.slug, slug), eq(events.published, true)) });
  if (!row) return null;
  const [withGoing] = await withCounts([row]);
  return withGoing;
});

/** The calendar entry for an event. */
export function eventCalendarEvent(event: PublicEvent, siteUrl: string): IcsEvent {
  return {
    uid: `event-${event.id}@${clientProfile.uidDomain}`,
    title: event.title,
    start: new Date(event.startsAt),
    end: event.endsAt ? new Date(event.endsAt) : undefined,
    location: [event.location, event.address].filter(Boolean).join(", ") || undefined,
    description: event.summary,
    url: `${siteUrl}/events/${event.slug}`,
  };
}

export const eventIcs = (event: PublicEvent, siteUrl: string) => icsCalendar([eventCalendarEvent(event, siteUrl)]);
export const eventGoogleUrl = (event: PublicEvent, siteUrl: string) => googleCalendarUrl(eventCalendarEvent(event, siteUrl));

export function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// ── Neighbourhood pages ───────────────────────────────────────────────────

export type NeighbourhoodPromise = { id: string; number: number; title: string; status: typeof trackerPromises.$inferSelect.status };
export type NeighbourhoodCampaign = { slug: string; title: string; kind: "petition" | "pledge" };

export type NeighbourhoodPageData = {
  events: PublicEvent[];
  cityWide: PublicEvent[];
  openings: PublicOpening[];
  promises: NeighbourhoodPromise[];
  /** Active petitions and pledges, to ask people to sign. No counts: the public site shows none. */
  campaigns: NeighbourhoodCampaign[];
};

/** Everything a town centre's page shows, in one cached read. */
export const neighbourhoodPage = cached("neighbourhood-page", [TAGS.events, TAGS.tracker, TAGS.counters, TAGS.pages], async (name: Neighbourhood, today: string): Promise<NeighbourhoodPageData> => {
  const db = getDb();
  const [here, cityWide, openings, promises, activeCampaigns] = await Promise.all([
    queryUpcoming(today, eq(events.neighbourhood, name), 20),
    queryUpcoming(today, isNull(events.neighbourhood), 20),
    queryPublicOpenings(db, today, name),
    db
      .select({ id: trackerPromises.id, number: trackerPromises.number, title: trackerPromises.title, status: trackerPromises.status })
      .from(trackerPromises)
      .where(arrayContains(trackerPromises.neighbourhoods, [name]))
      .orderBy(asc(trackerPromises.number)),
    db
      .select({ slug: campaigns.slug, title: campaigns.title, kind: campaigns.kind })
      .from(campaigns)
      .where(eq(campaigns.active, true))
      .orderBy(asc(campaigns.sortOrder), asc(campaigns.title)),
  ]);
  return {
    events: here,
    cityWide,
    openings,
    promises,
    campaigns: activeCampaigns,
  };
});
