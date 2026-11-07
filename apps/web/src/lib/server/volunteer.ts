import "server-only";
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db";
import { shiftOpenings, shifts, volunteerTasks } from "@/lib/db/schema";
import { googleCalendarUrl, icsCalendar, pacificDate, SLOT_HOURS, type IcsEvent } from "@/lib/ics";
import { neighbourhoodForPostalCode, normalizePostalCode } from "@/lib/neighbourhoods";
import { spotsLeft, type PublicOpening, type Slot } from "@/lib/shifts";

export type { PublicOpening };
import { cached, TAGS } from "./cache";
import { findOrCreatePerson } from "./people";

const signedUpCount = sql<number>`(select count(*)::int from ${shifts} where ${shifts.openingId} = ${shiftOpenings.id} and ${shifts.status} <> 'cancelled')`;

/** Published openings on or after a date, soonest first; optionally only one town centre's. */
export async function queryPublicOpenings(db: Db, today: string, neighbourhood?: string): Promise<PublicOpening[]> {
  const rows = await db
    .select({
      id: shiftOpenings.id,
      date: shiftOpenings.date,
      slot: shiftOpenings.slot,
      title: shiftOpenings.title,
      location: shiftOpenings.location,
      neighbourhood: shiftOpenings.neighbourhood,
      notes: shiftOpenings.notes,
      capacity: shiftOpenings.capacity,
      taskId: shiftOpenings.taskId,
      taskName: volunteerTasks.name,
      taskColor: volunteerTasks.color,
      signedUp: signedUpCount,
    })
    .from(shiftOpenings)
    .leftJoin(volunteerTasks, eq(volunteerTasks.id, shiftOpenings.taskId))
    .where(and(eq(shiftOpenings.published, true), gte(shiftOpenings.date, today), neighbourhood ? eq(shiftOpenings.neighbourhood, neighbourhood) : undefined))
    .orderBy(asc(shiftOpenings.date), asc(shiftOpenings.slot), asc(shiftOpenings.title))
    .limit(200);
  return rows.map((r) => ({ ...r, spotsLeft: spotsLeft(r.capacity, r.signedUp) }));
}

/** Every published future opening, for /volunteer. `today` is the Surrey date, so the cache key changes once a day. */
export const publishedOpenings = cached("volunteer-openings", [TAGS.events, TAGS.counters], async (today: string): Promise<PublicOpening[]> => {
  return queryPublicOpenings(getDb(), today);
});

export type OpeningForCalendar = { id: string; date: string; slot: Slot; title: string; location: string; neighbourhood: string | null; notes: string };

/** One opening by id, published or not, for calendar files people already downloaded links to. */
export async function findOpening(db: Db, id: string): Promise<OpeningForCalendar | undefined> {
  return db.query.shiftOpenings.findFirst({
    where: eq(shiftOpenings.id, id),
    columns: { id: true, date: true, slot: true, title: true, location: true, neighbourhood: true, notes: true },
  });
}

/** The calendar entry for an opening: the slot's hours in Pacific time, no personal data. */
export function openingCalendarEvent(opening: OpeningForCalendar, siteUrl: string): IcsEvent {
  const hours = SLOT_HOURS[opening.slot];
  const where = [opening.location, opening.neighbourhood].filter(Boolean).join(", ");
  return {
    uid: `opening-${opening.id}@imaginesurrey.ca`,
    title: `Volunteer: ${opening.title}`,
    start: pacificDate(opening.date, hours.start),
    end: pacificDate(opening.date, hours.end),
    location: where || undefined,
    description: opening.notes || undefined,
    url: `${siteUrl}/volunteer#opening-${opening.id}`,
  };
}

export function openingIcs(opening: OpeningForCalendar, siteUrl: string): string {
  return icsCalendar([openingCalendarEvent(opening, siteUrl)]);
}

export function openingGoogleUrl(opening: OpeningForCalendar, siteUrl: string): string {
  return googleCalendarUrl(openingCalendarEvent(opening, siteUrl));
}

// ── Sign-up ───────────────────────────────────────────────────────────────

export type SignupInput = {
  openingId: string;
  name: string;
  email: string;
  phone?: string;
  postalCode: string;
  /** The campaign tag from the body or the tracking cookie. */
  source?: string | null;
  /** The referral code from the body or the tracking cookie. */
  ref?: string | null;
};

export type SignupResult =
  | { ok: true; shiftId: string; personId: string; opening: typeof shiftOpenings.$inferSelect; spotsLeft: number; created: boolean }
  | { ok: false; status: 404 | 409 | 410; message: string };

/**
 * Put a volunteer on an opening. The person is created or filled in (never
 * overwritten), the opening row is locked while capacity is checked, and a
 * cancelled shift at that time is revived instead of duplicated. Booking needs
 * no marketing consent; the caller records any optional ticks.
 *
 * Anyone can type anyone's email, so a sign-up for a person who already has a
 * shift at that day and time gets the same answer as a new one (and nothing
 * is written), and a full opening answers the same 409 for everyone.
 */
export async function signUpForOpening(db: Db, input: SignupInput, today: string): Promise<SignupResult> {
  const [firstName, ...rest] = input.name.split(/\s+/);
  const person = await findOrCreatePerson(
    db,
    input.email,
    {
      firstName,
      lastName: rest.join(" ") || undefined,
      phone: input.phone,
      postalCode: normalizePostalCode(input.postalCode),
      neighbourhood: neighbourhoodForPostalCode(input.postalCode),
      interestVolunteer: true,
    },
    { source: input.source ? `volunteer:${input.source}` : "volunteer", referredByCode: input.ref ?? null },
  );

  return db.transaction(async (tx) => {
    const [opening] = await tx.select().from(shiftOpenings).where(eq(shiftOpenings.id, input.openingId)).for("update");
    if (!opening || !opening.published) return { ok: false, status: 404, message: "That shift is no longer open for sign-ups." };
    if (opening.date < today) return { ok: false, status: 410, message: "That shift has already happened. Pick one that's coming up." };

    const [{ taken }] = await tx
      .select({ taken: sql<number>`count(*)::int` })
      .from(shifts)
      .where(and(eq(shifts.openingId, opening.id), ne(shifts.status, "cancelled")));
    if (taken >= opening.capacity) {
      return { ok: false, status: 409, message: "That shift just filled up. Pick another one and we'll see you there." };
    }

    const existing = await tx.query.shifts.findFirst({
      where: and(eq(shifts.personId, person.id), eq(shifts.date, opening.date), eq(shifts.slot, opening.slot)),
    });
    if (existing && existing.status !== "cancelled") {
      // The same answer a new sign-up gets, spots left included.
      return { ok: true, shiftId: existing.id, personId: person.id, opening, spotsLeft: spotsLeft(opening.capacity, taken + 1), created: false };
    }

    const values = { taskId: opening.taskId, openingId: opening.id, status: "scheduled" as const };
    const [row] = existing
      ? await tx.update(shifts).set(values).where(eq(shifts.id, existing.id)).returning({ id: shifts.id })
      : await tx
          .insert(shifts)
          .values({ personId: person.id, date: opening.date, slot: opening.slot, ...values })
          .returning({ id: shifts.id });
    return { ok: true, shiftId: row.id, personId: person.id, opening, spotsLeft: spotsLeft(opening.capacity, taken + 1), created: true };
  });
}
