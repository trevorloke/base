"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ADMIN_PATHS, LOCAL_DATETIME_RE, pacificLocalToDate, SLUG_RE, slugify } from "@/components/admin/content/fields";
import { getDb } from "@/lib/db";
import { eventRsvps, events } from "@/lib/db/schema";
import { NEIGHBOURHOODS } from "@/lib/neighbourhoods";
import { ActionError, adminAction, checkbox, optionalText } from "@/lib/server/actions";
import { isUniqueViolation } from "@/lib/server/admin-api";
import { invalidate, TAGS } from "@/lib/server/cache";
import { rsvpCount } from "@/lib/server/content-admin";
import { findOrCreatePerson } from "@/lib/server/people";

const FIELDS = "Please check the highlighted fields.";

const wholeNumber = (max: number) =>
  z
    .string()
    .trim()
    .optional()
    .default("")
    .transform((v) => (v === "" ? null : Number(v)))
    .refine((v) => v === null || (Number.isInteger(v) && v > 0 && v <= max), `Enter a whole number up to ${max.toLocaleString("en-CA")}.`);

const eventSchema = z
  .object({
    id: z.uuid().optional(),
    title: z.string().trim().min(1, "Required").max(200),
    slug: z.string().trim().toLowerCase().max(80).optional().default(""),
    startsAt: z.string().trim().regex(LOCAL_DATETIME_RE, "Pick a date and time."),
    endsAt: z
      .string()
      .trim()
      .optional()
      .default("")
      .refine((v) => v === "" || LOCAL_DATETIME_RE.test(v), "Pick a date and time, or leave it empty."),
    location: z.string().trim().min(1, "Required").max(200),
    address: optionalText(300),
    neighbourhood: z.enum(["", ...NEIGHBOURHOODS] as [string, ...string[]]).optional().default(""),
    capacity: wholeNumber(100_000),
    summary: z.string().trim().min(1, "Required").max(300),
    description: z.string().trim().max(20_000).optional().default(""),
    imageUrl: optionalText(1000).refine((v) => !v || /^(https?:\/\/|\/)/i.test(v), "Use a full address (https://…) or a path on this site (/uploads/…)."),
    published: checkbox(),
  })
  .superRefine((d, ctx) => {
    if (d.endsAt && pacificLocalToDate(d.endsAt) <= pacificLocalToDate(d.startsAt)) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end must be after the start." });
  });

export const saveEvent = adminAction(
  "content",
  eventSchema,
  async (d) => {
    const db = getDb();
    const slug = d.slug || slugify(d.title);
    if (!SLUG_RE.test(slug)) throw new ActionError(FIELDS, { slug: "Use lowercase letters, numbers and hyphens." });
    const existing = d.id ? await db.query.events.findFirst({ where: eq(events.id, d.id) }) : undefined;
    if (d.id && !existing) throw new ActionError("That event no longer exists.");
    const values = {
      slug,
      title: d.title,
      startsAt: pacificLocalToDate(d.startsAt),
      endsAt: d.endsAt ? pacificLocalToDate(d.endsAt) : null,
      location: d.location,
      address: d.address ?? null,
      neighbourhood: d.neighbourhood || null,
      capacity: d.capacity,
      summary: d.summary,
      description: d.description,
      imageUrl: d.imageUrl ?? null,
      published: d.published,
      updatedAt: new Date(),
    };
    let id = existing?.id;
    try {
      if (existing) await db.update(events).set(values).where(eq(events.id, existing.id));
      else [{ id }] = await db.insert(events).values(values).returning({ id: events.id });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ActionError(FIELDS, { slug: "Another event already uses this address." });
      throw err;
    }
    invalidate(TAGS.events);
    return existing ? { ok: true, message: d.published ? "Saved and published." : "Saved. The event is unpublished." } : { ok: true, redirect: `${ADMIN_PATHS.events}/${id}?saved=created` };
  },
  "event.save",
);

export const setEventPublished = adminAction(
  "content",
  z.object({ id: z.uuid(), publish: z.enum(["1", "0"]) }),
  async (d) => {
    await getDb()
      .update(events)
      .set({ published: d.publish === "1", updatedAt: new Date() })
      .where(eq(events.id, d.id));
    invalidate(TAGS.events);
    return d.publish === "1" ? "Published." : "Unpublished. The event is hidden and RSVPs are closed.";
  },
  "event.publish",
);

export const deleteEvent = adminAction(
  "content",
  z.object({ id: z.uuid() }),
  async (d) => {
    const db = getDb();
    if ((await rsvpCount(db, d.id)) > 0) throw new ActionError("This event has RSVPs, so it can't be deleted. Unpublish it instead.");
    await db.delete(events).where(eq(events.id, d.id));
    invalidate(TAGS.events);
    return { ok: true, redirect: `${ADMIN_PATHS.events}?deleted=1` };
  },
  "event.delete",
);

/** Mark an RSVP as arrived, or clear it. */
export const setRsvpCheckedIn = adminAction(
  "content",
  z.object({ rsvpId: z.uuid(), checkedIn: z.enum(["1", "0"]) }),
  async (d) => {
    const [row] = await getDb()
      .update(eventRsvps)
      .set({ checkedInAt: d.checkedIn === "1" ? new Date() : null })
      .where(eq(eventRsvps.id, d.rsvpId))
      .returning({ eventId: eventRsvps.eventId, name: eventRsvps.name });
    if (!row) throw new ActionError("That RSVP no longer exists.");
    revalidatePath(`${ADMIN_PATHS.events}/${row.eventId}`);
    return d.checkedIn === "1" ? `${row.name} checked in.` : `Check-in cleared for ${row.name}.`;
  },
  "event.check-in",
);

/** Someone who turned up without an RSVP. They get a person record and are checked in at once. */
export const addWalkIn = adminAction(
  "content",
  z.object({
    eventId: z.uuid(),
    name: z.string().trim().min(1, "Required").max(120),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address")),
    guests: z.coerce.number().int().min(0).max(10).default(0),
  }),
  async (d) => {
    const db = getDb();
    const event = await db.query.events.findFirst({ where: eq(events.id, d.eventId) });
    if (!event) throw new ActionError("That event no longer exists.");
    const [firstName, ...rest] = d.name.split(/\s+/);
    const person = await findOrCreatePerson(db, d.email, { firstName, lastName: rest.join(" ") || undefined }, { source: `event:${event.slug}` });
    const now = new Date();
    await db
      .insert(eventRsvps)
      .values({ eventId: event.id, personId: person.id, name: d.name, email: d.email, guests: d.guests, source: "walk-in", checkedInAt: now })
      .onConflictDoUpdate({ target: [eventRsvps.eventId, eventRsvps.email], set: { name: d.name, guests: sql`greatest(${eventRsvps.guests}, ${d.guests})`, checkedInAt: now } });
    revalidatePath(`${ADMIN_PATHS.events}/${event.id}`);
    return `${d.name} added and checked in.`;
  },
  "event.walk-in",
);
