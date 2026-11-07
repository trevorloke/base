import type { NextRequest } from "next/server";
import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { eventRsvps, events, newsletterSubscribers } from "@/lib/db/schema";
import { neighbourhoodForPostalCode, normalizePostalCode } from "@/lib/neighbourhoods";
import { error, json, parseBody } from "@/lib/server/api";
import { creditReferral, sourceLabel, trackingFromRequest } from "@/lib/server/attribution";
import { invalidate, TAGS } from "@/lib/server/cache";
import { CONSENT_WORDING, consentMeta, recordConsent } from "@/lib/server/consent";
import { handle } from "@/lib/server/handle";
import { subscribe } from "@/lib/server/newsletter";
import { notifyRsvp } from "@/lib/server/notifications";
import { findOrCreatePerson } from "@/lib/server/people";
import { normalizePhone } from "@/lib/server/sms";
import { forwardRsvp } from "@/lib/server/base-ground-forward";
import { rsvpRequestSchema } from "@/lib/shift-validation";

const FULL = "This event is full. Get the newsletter and we'll tell you about the next one.";

// Body: { name, email, guests?, newsletter?, phone?, postalCode?, smsConsent?, source?, ref?, website? }.
// Anyone can type anyone's email, so an RSVP that already exists is never
// changed from here, and the answer is the same whether or not the address
// had already RSVP'd: { ok: true } when there is room, the same 409 when full.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/events/[slug]/rsvp">) {
  return handle(async () => {
    const { slug } = await ctx.params;
    const parsed = await parseBody(req, rsvpRequestSchema, "rsvp", { human: true });
    if (!parsed.ok) return parsed.response;
    const db = getDb();
    const event = await db.query.events.findFirst({ where: and(eq(events.slug, slug), eq(events.published, true)) });
    if (!event) return error("We couldn't find that event.", 404);
    if (event.startsAt < new Date()) return error("This event has already happened.", 410);

    const { name, email, guests, newsletter, phone, smsConsent } = parsed.data;
    const tracking = trackingFromRequest(req, parsed.data);
    const postalCode = parsed.data.postalCode ? normalizePostalCode(parsed.data.postalCode) : undefined;
    const neighbourhood = postalCode ? (neighbourhoodForPostalCode(postalCode) ?? undefined) : undefined;

    const [firstName, ...rest] = name.split(/\s+/);
    const person = await findOrCreatePerson(
      db,
      email,
      { firstName, lastName: rest.join(" ") || undefined, phone, postalCode, neighbourhood },
      { source: sourceLabel(`event:${slug}`, tracking), referredByCode: tracking.ref },
    );
    await creditReferral(db, person.id, tracking.ref);

    // Count and insert with the event row locked, so two people cannot both take the last spot.
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: events.id, capacity: events.capacity }).from(events).where(eq(events.id, event.id)).for("update");
      if (!locked) return { ok: false as const, message: "We couldn't find that event.", status: 404 };
      if (locked.capacity != null) {
        const [{ going }] = await tx
          .select({ going: sql<number>`(count(*) + coalesce(sum(${eventRsvps.guests}), 0))::int` })
          .from(eventRsvps)
          .where(eq(eventRsvps.eventId, locked.id));
        const remaining = locked.capacity - going;
        if (remaining <= 0) return { ok: false as const, message: FULL, status: 409 };
        if (1 + guests > remaining) {
          return {
            ok: false as const,
            status: 409,
            message: remaining === 1 ? "There's one spot left, so there isn't room for guests this time." : `There are only ${remaining} spots left, so bring at most ${remaining - 1} guests.`,
          };
        }
      }
      const [inserted] = await tx
        .insert(eventRsvps)
        .values({ eventId: locked.id, personId: person.id, name, email, guests, source: tracking.source })
        .onConflictDoNothing({ target: [eventRsvps.eventId, eventRsvps.email] })
        .returning({ id: eventRsvps.id });
      return { ok: true as const, rsvpId: inserted?.id ?? null };
    });
    if (!outcome.ok) return error(outcome.message, outcome.status);

    if (smsConsent && normalizePhone(phone)) {
      await recordConsent(db, {
        personId: person.id,
        email,
        channel: "sms",
        purpose: "sms",
        action: "grant",
        wording: CONSENT_WORDING.sms,
        source: `event:${slug}`,
        ...consentMeta(req),
      });
    }
    if (newsletter) {
      // An address that unsubscribed is only re-subscribed by its own confirmation click, never by a public form.
      const existing = await db.query.newsletterSubscribers.findFirst({ where: eq(newsletterSubscribers.email, email), columns: { status: true } });
      if (existing?.status !== "unsubscribed") await subscribe(db, email, `event:${slug}`, person.id);
    }

    const rsvpId = outcome.rsvpId;
    if (rsvpId) {
      after(async () => {
        try {
          await notifyRsvp(db, { rsvpId });
        } catch (err) {
          console.error("RSVP notification failed", err);
        }
      });
      // The desk sees who is coming: an "RSVP: <event>" tag on the person, nothing more.
      await forwardRsvp(db, { personId: person.id, name, email, eventTitle: event.title });
      // The public pages show how many are going and the spots left.
      invalidate(TAGS.counters);
    }
    return json({ ok: true });
  });
}
