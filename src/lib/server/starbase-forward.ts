import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { memberships, orders, people } from "@/lib/db/schema";
import { env } from "@/lib/env";
import type { Slot } from "@/lib/shifts";
import {
  consentPayload,
  deletionRequestPerson,
  followPerson,
  membershipPerson,
  newsletterPerson,
  orderPerson,
  portalPerson,
  rsvpPerson,
  shiftPerson,
  signaturePerson,
  type ConsentReason,
  type ConsentSyncChannel,
  type StarbasePerson,
} from "./starbase";
import { deliverSoon, enqueueConsent, enqueueStarbase, type OutboxKind } from "./starbase-outbox";
import { normalizePhone } from "./sms";

// What the website forwards to Starbase, and from where. Each is called only
// after the website itself has accepted the submission, with only what the
// person typed into that form. None of them throws: a problem with Starbase
// must never fail a visitor's form or a Stripe webhook.
//
// RSVPs, paid shop orders and confirmed promise follows go as a tag on the
// person, nothing more. Consent withdrawals go to /in/v1/consent.
//
// Never forwarded: money of any kind (donations, monthly gifts, fees, order
// totals or items), and admin edits to a supporter
// (tests/starbase-boundary.test.ts holds that line). Gifts are logged at the
// desk by the treasurer (/admin/desk-gifts), where the limits are checked.

async function forward(db: Db, kind: OutboxKind, personId: string | null, person: StarbasePerson | null): Promise<void> {
  try {
    if (await enqueueStarbase(db, { kind, personId, person })) deliverSoon(db);
  } catch (err) {
    console.error(`Could not forward a ${kind} to Starbase`, err);
  }
}

/** A new petition or pledge signature (/api/signatures). */
export async function forwardSignature(
  db: Db,
  s: {
    personId: string;
    campaign: { kind: "petition" | "pledge"; slug: string; title: string };
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    address?: string | null;
    postalCode?: string | null;
    /** True only when the email-updates grant was recorded for this submission. */
    newsletter: boolean;
  },
): Promise<void> {
  const person = signaturePerson({ kind: s.campaign.kind, slug: s.campaign.slug, title: s.campaign.title, firstName: s.firstName, lastName: s.lastName, email: s.email, phone: s.phone, address: s.address, postalCode: s.postalCode, newsletter: s.newsletter });
  await forward(db, s.campaign.kind, s.personId, person);
}

/** A newsletter address that has just become "subscribed" (single opt-in, or the confirmation click). */
export async function forwardNewsletter(db: Db, s: { personId: string | null; email: string; source?: string | null }): Promise<void> {
  await forward(db, "newsletter", s.personId, newsletterPerson({ email: s.email, source: s.source }));
}

/** A new volunteer shift sign-up (/api/volunteer/signup). */
export async function forwardShift(
  db: Db,
  s: {
    personId: string;
    name: string;
    email: string;
    phone?: string | null;
    postalCode?: string | null;
    opening: { title: string; date: string; slot: Slot; location?: string | null };
    /** The form's email-updates tick. */
    newsletter: boolean;
  },
): Promise<void> {
  await forward(db, "volunteer-shift", s.personId, shiftPerson(s));
}

/**
 * A membership that has just become active (after the Stripe webhook commits,
 * or at once when the fee is 0), from its own snapshot. Never the fee.
 */
export async function forwardMembership(db: Db, membershipId: string): Promise<void> {
  try {
    const m = await db.query.memberships.findFirst({ where: eq(memberships.id, membershipId) });
    if (!m || m.status !== "active") return;
    const person = await db.query.people.findFirst({ where: eq(people.id, m.personId), columns: { email: true } });
    if (!person) return;
    const payload = membershipPerson({
      memberName: m.memberName,
      email: person.email,
      memberPhone: m.memberPhone,
      memberAddress: m.memberAddress,
      memberCity: m.memberCity,
      memberPostalCode: m.memberPostalCode,
      interestVolunteer: m.interestVolunteer,
      interestLawnSign: m.interestLawnSign,
      updatesConsent: m.updatesConsent,
    });
    await forward(db, "membership", m.personId, payload);
  } catch (err) {
    console.error("Could not forward a membership to Starbase", err);
  }
}

/** "Delete my account" from the supporter portal: a request for the desk to do the same. */
export async function forwardDeletionRequest(db: Db, p: { id: string; email: string; firstName: string | null; lastName: string | null }, date: string): Promise<void> {
  await forward(db, "deletion-request", p.id, deletionRequestPerson({ firstName: p.firstName, lastName: p.lastName, email: p.email, date }));
}

/** A new RSVP to an event (/api/events/[slug]/rsvp): the "RSVP: <event>" tag. */
export async function forwardRsvp(db: Db, r: { personId: string; name: string; email: string; eventTitle: string }): Promise<void> {
  await forward(db, "rsvp", r.personId, rsvpPerson(r));
}

/**
 * A shop order that has just been paid (after the Stripe webhook commits):
 * the "Bought merch" tag on the buyer, read from the order's email and the
 * person's name. Never the total, the items or the payment.
 */
export async function forwardOrder(db: Db, orderId: string): Promise<void> {
  try {
    const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId), columns: { email: true, personId: true, status: true } });
    if (order?.status !== "paid") return;
    const person = order.personId ? await db.query.people.findFirst({ where: eq(people.id, order.personId), columns: { email: true, firstName: true, lastName: true } }) : undefined;
    const email = order.email ?? person?.email;
    if (!email) return;
    await forward(db, "order", order.personId, orderPerson({ firstName: person?.firstName, lastName: person?.lastName, email }));
  } catch (err) {
    console.error("Could not forward an order to Starbase", err);
  }
}

/** A promise-tracker follow that has just been confirmed: "Follows: promise <n>". */
export async function forwardFollow(db: Db, f: { personId: string | null; email: string; number: number }): Promise<void> {
  await forward(db, "follow", f.personId, followPerson(f));
}

/** Details a signed-in supporter changed at /me/preferences. Starbase fills blanks only. */
export async function forwardPortalEdit(
  db: Db,
  p: { id: string; email: string; firstName?: string | null; lastName?: string | null; phone?: string | null; address?: string | null; postalCode?: string | null },
): Promise<void> {
  await forward(db, "portal", p.id, portalPerson(p));
}

/**
 * A withdrawal recorded on the website (newsletter unsubscribe, the
 * preference centre, /me, a text STOP, a deletion), for Starbase's
 * /in/v1/consent, so neither app contacts the person on that channel again.
 * Never called for a withdrawal that came from Starbase (no echo back).
 *
 * A deletion carries the details being erased, so it is written only when
 * Starbase is connected (and they are scrubbed from the row once sent).
 */
export async function forwardConsentWithdrawal(
  db: Db,
  w: { personId?: string | null; email?: string | null; phone?: string | null; channel: ConsentSyncChannel; reason: ConsentReason },
): Promise<void> {
  try {
    if (w.reason === "deletion" && !env.starbaseEnabled) return;
    const consent = consentPayload({ email: w.email, phone: normalizePhone(w.phone) ?? w.phone, channel: w.channel, reason: w.reason });
    if (await enqueueConsent(db, { personId: w.personId ?? null, consent })) deliverSoon(db);
  } catch (err) {
    console.error("Could not forward a consent withdrawal to Starbase", err);
  }
}
