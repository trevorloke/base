import "server-only";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { campaigns, campaignSignatures, contributions, eventRsvps, events, memberships, orderItems, orders, people, promiseFollows, recurringDonations, shiftOpenings, shifts, trackerPromises, trackerUpdates, volunteerTasks } from "@/lib/db/schema";
import {
  donationThanksEmail,
  membershipWelcomeEmail,
  orderPaidEmail,
  promiseStatusEmail,
  recurringStartedEmail,
  rsvpEmail,
  shiftConfirmationEmail,
  signatureEmail,
  type OrderShipping,
} from "@/lib/email/notifications";
import { CAMPAIGNS } from "@/lib/validation";
import { emailContext, queueEmails, sendEmail, sendQueued, type OutgoingEmail } from "./email";
import { ensureReferralCode } from "./people";
import { tokenUrl } from "./tokens";

/**
 * Hooks called after a supporter does something, from route handlers and the
 * Stripe webhook (after its transaction commits). Each one loads what it
 * needs by id, builds the right email, respects consent, and records it.
 * They never throw into the caller: a failed email must not undo a payment
 * or a signature.
 *
 * Every email here is about the person's own action, so none needs
 * newsletter consent and none carries an unsubscribe link.
 */
async function safely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`${name} failed`, err);
  }
}

export async function notifyMembershipActive(db: Db, input: { membershipId: string }): Promise<void> {
  return safely("notifyMembershipActive", async () => {
    const membership = await db.query.memberships.findFirst({ where: eq(memberships.id, input.membershipId) });
    if (!membership || membership.status !== "active") return;
    const person = await db.query.people.findFirst({ where: eq(people.id, membership.personId) });
    if (!person) return;
    const referralCode = await ensureReferralCode(db, person.id);
    const ctx = await emailContext();
    const built = membershipWelcomeEmail(ctx, {
      firstName: person.firstName ?? membership.memberName?.split(/\s+/)[0],
      expiresAt: membership.expiresAt,
      votingEligible: membership.votingEligible,
      referralCode,
    });
    await sendEmail(db, { to: person.email, ...built, kind: "membership-welcome", personId: person.id, unsubscribeUrl: null });
  });
}

export async function notifyDonationSucceeded(db: Db, input: { contributionIds: string[] }): Promise<void> {
  return safely("notifyDonationSucceeded", async () => {
    if (input.contributionIds.length === 0) return;
    // Membership fees are contributions too, but the welcome email covers them.
    const rows = (await db.select().from(contributions).where(inArray(contributions.id, input.contributionIds))).filter(
      (c) => c.kind === "donation" && (c.status === "succeeded" || c.status === "refunded_over_limit"),
    );
    if (rows.length === 0) return;
    const person = await db.query.people.findFirst({ where: eq(people.id, rows[0].personId) });
    if (!person) return;
    const amounts: Partial<Record<"council" | "school_board", number>> = {};
    for (const c of rows) amounts[c.slate] = (amounts[c.slate] ?? 0) + c.amountCents;
    const ctx = await emailContext();
    const built = donationThanksEmail(ctx, {
      firstName: person.firstName ?? rows[0].contributorName.split(/\s+/)[0],
      frequency: rows[0].frequency,
      amounts,
      refundedOverLimit: rows.some((c) => c.refundedCents > 0 || c.refundPendingCents > 0),
    });
    await sendEmail(db, { to: person.email, ...built, kind: "donation-thanks", personId: person.id, unsubscribeUrl: null });
  });
}

export async function notifyRecurringStarted(db: Db, input: { recurringDonationId: string }): Promise<void> {
  return safely("notifyRecurringStarted", async () => {
    const gift = await db.query.recurringDonations.findFirst({ where: eq(recurringDonations.id, input.recurringDonationId) });
    if (!gift) return;
    const person = await db.query.people.findFirst({ where: eq(people.id, gift.personId) });
    if (!person) return;
    const ctx = await emailContext();
    const built = recurringStartedEmail(ctx, { firstName: person.firstName ?? gift.contributorName.split(/\s+/)[0], slateAmounts: gift.slateAmounts });
    await sendEmail(db, { to: person.email, ...built, kind: "recurring-started", personId: person.id, unsubscribeUrl: null });
  });
}

export async function notifyOrderPaid(db: Db, input: { orderId: string }): Promise<void> {
  return safely("notifyOrderPaid", async () => {
    const order = await db.query.orders.findFirst({ where: eq(orders.id, input.orderId) });
    if (!order) return;
    const person = order.personId ? await db.query.people.findFirst({ where: eq(people.id, order.personId) }) : undefined;
    const to = order.email ?? person?.email;
    if (!to) return;
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const ctx = await emailContext();
    const shipping = (order.shipping ?? null) as OrderShipping;
    const built = orderPaidEmail(ctx, { firstName: person?.firstName ?? shipping?.name?.split(/\s+/)[0], items, totalCents: order.totalCents, shipping });
    await sendEmail(db, { to, ...built, kind: "order", personId: person?.id ?? null, unsubscribeUrl: null });
  });
}

export async function notifySignature(db: Db, input: { signatureId: string }): Promise<void> {
  return safely("notifySignature", async () => {
    const signature = await db.query.campaignSignatures.findFirst({ where: eq(campaignSignatures.id, input.signatureId) });
    if (!signature) return;
    const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.slug, signature.campaign) });
    const referralCode = await ensureReferralCode(db, signature.personId);
    const ctx = await emailContext();
    const built = signatureEmail(ctx, {
      firstName: signature.firstName,
      lastName: signature.lastName,
      referralCode,
      campaign: campaign
        ? { slug: campaign.slug, title: campaign.title, kind: campaign.kind, shareText: campaign.shareText, statement: campaign.statement, targetEmails: campaign.targetEmails }
        : { slug: signature.campaign, title: CAMPAIGNS[signature.campaign as keyof typeof CAMPAIGNS]?.title ?? signature.campaign, kind: "petition", shareText: "", statement: "", targetEmails: [] },
    });
    await sendEmail(db, { to: signature.email, ...built, kind: "signature", personId: signature.personId, unsubscribeUrl: null });
  });
}

export async function notifyRsvp(db: Db, input: { rsvpId: string }): Promise<void> {
  return safely("notifyRsvp", async () => {
    const rsvp = await db.query.eventRsvps.findFirst({ where: eq(eventRsvps.id, input.rsvpId) });
    if (!rsvp) return;
    const event = await db.query.events.findFirst({ where: eq(events.id, rsvp.eventId) });
    if (!event) return;
    const referralCode = await ensureReferralCode(db, rsvp.personId);
    const ctx = await emailContext();
    const built = rsvpEmail(ctx, { name: rsvp.name, guests: rsvp.guests, event, referralCode });
    await sendEmail(db, { to: rsvp.email, ...built, kind: "rsvp", personId: rsvp.personId, unsubscribeUrl: null });
  });
}

export async function notifyShiftSignup(db: Db, input: { shiftId: string }): Promise<void> {
  return safely("notifyShiftSignup", async () => {
    const shift = await db.query.shifts.findFirst({ where: eq(shifts.id, input.shiftId) });
    if (!shift || shift.status === "cancelled") return;
    const person = await db.query.people.findFirst({ where: eq(people.id, shift.personId) });
    if (!person) return;
    const opening = shift.openingId ? await db.query.shiftOpenings.findFirst({ where: eq(shiftOpenings.id, shift.openingId) }) : undefined;
    const task = shift.taskId ? await db.query.volunteerTasks.findFirst({ where: eq(volunteerTasks.id, shift.taskId) }) : undefined;
    const ctx = await emailContext();
    const built = shiftConfirmationEmail(ctx, {
      firstName: person.firstName,
      shift: { id: shift.id, date: shift.date, slot: shift.slot, title: opening?.title ?? task?.name ?? "Volunteer", location: opening?.location || null, notes: opening?.notes || null },
    });
    await sendEmail(db, { to: person.email, ...built, kind: "shift", personId: person.id, unsubscribeUrl: null });
  });
}

export async function notifyPromiseStatusChanged(db: Db, input: { promiseId: string; previous: string; next: string }): Promise<void> {
  return safely("notifyPromiseStatusChanged", async () => {
    if (input.previous === input.next) return;
    const promise = await db.query.trackerPromises.findFirst({ where: eq(trackerPromises.id, input.promiseId) });
    if (!promise) return;
    const followers = await db
      .select()
      .from(promiseFollows)
      .where(and(eq(promiseFollows.promiseId, promise.id), isNotNull(promiseFollows.confirmedAt)));
    if (followers.length === 0) return;
    // The update that came with the change, if there was one.
    const [latest] = await db.select().from(trackerUpdates).where(eq(trackerUpdates.promiseId, promise.id)).orderBy(desc(trackerUpdates.createdAt)).limit(1);
    const note = latest && (latest.status === input.next || Date.now() - latest.createdAt.getTime() < 10 * 60_000) ? latest.note : null;
    const ctx = await emailContext();
    const emails: OutgoingEmail[] = followers.map((f) => {
      const built = promiseStatusEmail(ctx, { promise, previous: input.previous, next: input.next, note, unfollowUrl: tokenUrl("/api/newsletter/unfollow", f.token) });
      return { to: f.email, ...built, kind: "promise-update", personId: f.personId };
    });
    await queueEmails(db, emails);
    await sendQueued(db, 100);
  });
}
