import "server-only";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { events, shiftOpenings, shifts, trackerPromises, trackerUpdates } from "@/lib/db/schema";
import { defaultSettings, type Settings } from "@/lib/settings";
import { todayInSurrey, type Slot } from "@/lib/shifts";
import type { PromiseStatus } from "@/lib/tracker";
import { TAGS } from "./cache";
import { getSettings } from "./settings";

export type HomeLive = {
  /** Dates are ISO strings: cached values travel as JSON. */
  nextEvents: { slug: string; title: string; startsAt: string; location: string; neighbourhood: string | null }[];
  nextShift:
    | { kind: "opening"; date: string; slot: Slot; title: string; location: string; neighbourhood: string | null }
    | { kind: "scheduled"; date: string; slot: Slot }
    | null;
  trackerUpdates: { number: number; title: string; status: PromiseStatus; date: string; note: string }[];
};

async function loadHomeLive(): Promise<HomeLive> {
  const db = getDb();
  const today = todayInSurrey();

  const [eventRows, openingRows, updateRows] = await Promise.all([
    db
      .select({ slug: events.slug, title: events.title, startsAt: events.startsAt, location: events.location, neighbourhood: events.neighbourhood })
      .from(events)
      .where(and(eq(events.published, true), gte(events.startsAt, new Date())))
      .orderBy(asc(events.startsAt))
      .limit(2),
    db
      .select({ date: shiftOpenings.date, slot: shiftOpenings.slot, title: shiftOpenings.title, location: shiftOpenings.location, neighbourhood: shiftOpenings.neighbourhood })
      .from(shiftOpenings)
      .where(and(eq(shiftOpenings.published, true), gte(shiftOpenings.date, today)))
      .orderBy(asc(shiftOpenings.date), asc(shiftOpenings.slot))
      .limit(1),
    db
      .select({
        number: trackerPromises.number,
        title: trackerPromises.title,
        status: sql<PromiseStatus>`coalesce(${trackerUpdates.status}, ${trackerPromises.status})`,
        date: trackerUpdates.date,
        note: trackerUpdates.note,
      })
      .from(trackerUpdates)
      .innerJoin(trackerPromises, eq(trackerUpdates.promiseId, trackerPromises.id))
      .orderBy(desc(trackerUpdates.date), desc(trackerUpdates.createdAt))
      .limit(3),
  ]);

  let nextShift: HomeLive["nextShift"] = null;
  if (openingRows[0]) {
    nextShift = { kind: "opening", ...openingRows[0] };
  } else {
    const [scheduled] = await db
      .select({ date: shifts.date, slot: shifts.slot })
      .from(shifts)
      .where(and(gte(shifts.date, today), inArray(shifts.status, ["scheduled", "confirmed"])))
      .orderBy(asc(shifts.date), asc(shifts.slot))
      .limit(1);
    if (scheduled) nextShift = { kind: "scheduled", ...scheduled };
  }

  return {
    nextEvents: eventRows.map((e) => ({ ...e, startsAt: e.startsAt.toISOString() })),
    nextShift,
    trackerUpdates: updateRows,
  };
}

/**
 * The next steps for the home page's "Act now" rail. Cached for five minutes
 * and dropped early when events, shifts or the tracker change.
 */
export const homeLive = unstable_cache(loadHomeLive, ["home-live"], {
  tags: [TAGS.counters, TAGS.events, TAGS.tracker],
  revalidate: 300,
});

/**
 * Site settings for the shell. A database outage (or a build without one)
 * falls back to the defaults in code instead of taking every page down.
 */
export async function shellSettings(): Promise<Settings> {
  try {
    return await getSettings();
  } catch (err) {
    console.error("Site settings could not be loaded; using the defaults", err);
    return defaultSettings();
  }
}
