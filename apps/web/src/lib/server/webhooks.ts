import "server-only";
import { and, eq, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { contributions, memberships, orders, people, recurringDonations, stripeEvents } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { getStripe, type Stripe } from "@/lib/stripe";
import {
  allocatePayment,
  excessOverLimit,
  membershipTerm,
  pacificYearBounds,
  pacificYearMonth,
  recurringStatusFor,
  SLATES,
  subscriptionEndsBeforeNextPayment,
} from "@/lib/contributions";
import { membershipFeeReturnedEmail } from "@/lib/email/membership-fee";
import { sendEmail } from "./email";
import { limitForYear, lockPerson, type Querier } from "./limits";
import { notifyDonationSucceeded, notifyMembershipActive, notifyOrderPaid, notifyRecurringStarted } from "./notifications";
import { latestActiveMembershipExpiry } from "./payments";
import { findOrCreatePerson } from "./people";
import { getSettings } from "./settings";
import { forwardMembership, forwardOrder } from "./base-ground-forward";
import { issuePendingRefunds, reconcileRefunds } from "./stripe-refunds";

type Tx = Querier;
type Contribution = typeof contributions.$inferSelect;

export type WebhookResult = "processed" | "duplicate" | "ignored";

/** What happened in the transaction, for the notification hooks after it commits. */
interface Effects {
  membershipIds: string[];
  /** Memberships cancelled because their fee went back as over the limit; the payer is told privately. */
  feeReturnedMembershipIds: string[];
  contributionIds: string[];
  recurringIds: string[];
  orderIds: string[];
}

/**
 * Everything the transaction needs, gathered beforehand. Stripe round trips
 * (re-retrieving an object the endpoint's API version delivered in an older
 * shape, looking up an invoice's payment intent) and people records happen
 * here, so no database connection is ever pinned waiting on Stripe.
 */
type Prepared =
  | { kind: "checkout_paid"; session: Stripe.Checkout.Session; paidAt: Date; orderPersonId: string | null }
  | { kind: "checkout_abandoned"; session: Stripe.Checkout.Session }
  | { kind: "invoice_paid"; invoice: Stripe.Invoice; subscriptionId: string | null; giftId: string | null; paymentIntentId: string | null; paidAt: Date }
  | { kind: "subscription_status"; subscriptionId: string; status: string; endsBeforeNextPayment: boolean; at: Date }
  | { kind: "charge_refunded"; charge: Stripe.Charge }
  | { kind: "noop" }
  | { kind: "ignored" };

/**
 * Apply one Stripe event to the database, exactly once. The event id is
 * recorded in the same transaction as its effects, so a failure rolls both
 * back and Stripe's retry gets a clean second attempt. Refunds decided in the
 * transaction are sent to Stripe after it commits, then supporters are told.
 */
export async function handleStripeEvent(db: Db, event: Stripe.Event): Promise<WebhookResult> {
  // A replay never costs a Stripe round trip; the insert below is the real guard.
  const seen = await db.query.stripeEvents.findFirst({ where: eq(stripeEvents.id, event.id), columns: { id: true } });
  if (seen) {
    await issuePendingRefunds(db);
    return "duplicate";
  }

  const prepared = await prepare(db, event);
  const effects: Effects = { membershipIds: [], feeReturnedMembershipIds: [], contributionIds: [], recurringIds: [], orderIds: [] };
  const result = await db.transaction(async (tx): Promise<WebhookResult> => {
    const inserted = await tx.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning();
    if (inserted.length === 0) return "duplicate";
    return apply(tx, prepared, effects);
  });

  await issuePendingRefunds(db);
  await notify(db, effects);
  return result;
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

/** Re-read an object from Stripe; null when Stripe no longer has it (so the event is a no-op, not a retry loop). */
async function retrieve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: unknown }).code === "resource_missing") return null;
    throw err;
  }
}

/** When Stripe says it happened, not when we got round to processing it. */
export function eventTime(event: Pick<Stripe.Event, "created">): Date {
  return typeof event.created === "number" && event.created > 0 ? new Date(event.created * 1000) : new Date();
}

// ── Shapes that differ between Stripe API versions ─────────────────────────

/**
 * Which subscription an invoice belongs to, and the subscription metadata
 * snapshotted on it. Endpoints on API versions from 2025-03-31 send
 * `invoice.parent.subscription_details`; older ones send `invoice.subscription`
 * and `invoice.subscription_details`.
 */
export function invoiceSubscription(invoice: Stripe.Invoice): { subscriptionId: string | null; metadata: Record<string, string> | null; known: boolean } {
  const modern = invoice.parent?.subscription_details;
  if (modern) return { subscriptionId: idOf(modern.subscription), metadata: modern.metadata ?? null, known: true };
  const legacy = invoice as unknown as { subscription?: string | { id: string } | null; subscription_details?: { metadata?: Record<string, string> | null } | null };
  if (legacy.subscription !== undefined || legacy.subscription_details !== undefined) {
    return { subscriptionId: idOf(legacy.subscription), metadata: legacy.subscription_details?.metadata ?? null, known: true };
  }
  // Neither shape: the object as delivered can't tell us; the caller re-retrieves it.
  return { subscriptionId: null, metadata: null, known: invoice.parent !== undefined };
}

/** The payment intent an invoice was paid with, when the delivered object carries it. */
export function invoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as unknown as { payment_intent?: string | { id: string } | null }).payment_intent;
  if (legacy) return idOf(legacy);
  const paid = invoice.payments?.data?.find((p) => p.status === "paid") ?? invoice.payments?.data?.[0];
  return idOf(paid?.payment?.payment_intent);
}

/**
 * When a subscription's next payment is due, in seconds: on its items from
 * API version 2025-03-31, on the subscription itself before that.
 */
export function subscriptionPeriodEnd(subscription: Stripe.Subscription): number | null {
  const ends = (subscription.items?.data ?? []).map((item) => item.current_period_end).filter((n): n is number => typeof n === "number");
  if (ends.length) return Math.min(...ends);
  const legacy = (subscription as unknown as { current_period_end?: number | null }).current_period_end;
  return typeof legacy === "number" ? legacy : null;
}

/** Shipping as collected at checkout, from either the current or the pre-2025-03-31 shape. */
export function sessionShipping(session: Stripe.Checkout.Session): Record<string, unknown> | null {
  const legacy = (session as unknown as { shipping_details?: Record<string, unknown> | null }).shipping_details;
  const shipping = session.collected_information?.shipping_details ?? legacy ?? null;
  return shipping ? { ...shipping, phone: session.customer_details?.phone ?? null } : null;
}

// ── Prepare: Stripe round trips and people, before the transaction ────────

async function prepare(db: Db, event: Stripe.Event): Promise<Prepared> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      let session: Stripe.Checkout.Session | null = event.data.object;
      // An endpoint on another API version may leave out what we rely on; the pinned SDK's view is authoritative.
      if (!session.metadata?.type) session = await retrieve(() => getStripe().checkout.sessions.retrieve(event.data.object.id));
      if (!session) return { kind: "noop" };
      if (session.payment_status === "unpaid") return { kind: "noop" }; // Async method: wait for the success event.
      let orderPersonId: string | null = null;
      if (session.metadata?.type === "order") {
        const email = session.customer_details?.email?.trim().toLowerCase();
        if (email) orderPersonId = (await findOrCreatePerson(db, email, {}, { source: "shop" })).id;
      }
      return { kind: "checkout_paid", session, paidAt: eventTime(event), orderPersonId };
    }
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      return { kind: "checkout_abandoned", session: event.data.object };
    case "invoice.paid":
      return prepareInvoice(db, event.data.object, eventTime(event));
    case "customer.subscription.deleted":
      return { kind: "subscription_status", subscriptionId: event.data.object.id, status: "canceled", endsBeforeNextPayment: true, at: eventTime(event) };
    case "customer.subscription.updated":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const subscription = event.data.object;
      return {
        kind: "subscription_status",
        subscriptionId: subscription.id,
        status: subscription.status,
        endsBeforeNextPayment: subscriptionEndsBeforeNextPayment({
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          cancelAt: subscription.cancel_at,
          periodEnd: subscriptionPeriodEnd(subscription),
        }),
        at: eventTime(event),
      };
    }
    case "charge.refunded":
      return { kind: "charge_refunded", charge: event.data.object };
    default:
      return { kind: "ignored" };
  }
}

async function prepareInvoice(db: Db, delivered: Stripe.Invoice, fallbackPaidAt: Date): Promise<Prepared> {
  const stripe = getStripe();
  let invoice = delivered;
  let ref = invoiceSubscription(invoice);
  if (!ref.known) {
    const fresh = await retrieve(() => stripe.invoices.retrieve(delivered.id));
    if (!fresh) return { kind: "noop" };
    invoice = fresh;
    ref = invoiceSubscription(invoice);
  }
  let { subscriptionId } = ref;
  let giftId = ref.metadata?.recurringDonationId ?? null;
  if (!subscriptionId && !giftId) return { kind: "noop" }; // Not a subscription invoice.

  if (!giftId && subscriptionId) {
    const known = await db.query.recurringDonations.findFirst({
      where: eq(recurringDonations.stripeSubscriptionId, subscriptionId),
      columns: { id: true },
    });
    if (known) giftId = known.id;
    else {
      // The invoice carried no metadata (older endpoints before the first checkout event): the subscription itself has it.
      const subscription = await retrieve(() => stripe.subscriptions.retrieve(subscriptionId!));
      giftId = subscription?.metadata?.recurringDonationId ?? null;
      if (!giftId) return { kind: "noop" }; // Not one of our gifts.
    }
  }

  let paymentIntentId = invoicePaymentIntentId(invoice);
  if (!paymentIntentId) {
    const payments = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 10 });
    const paid = payments.data.find((p) => p.status === "paid") ?? payments.data[0];
    paymentIntentId = idOf(paid?.payment?.payment_intent);
  }
  const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : fallbackPaidAt;
  return { kind: "invoice_paid", invoice, subscriptionId, giftId, paymentIntentId, paidAt };
}

// ── Apply: database only ───────────────────────────────────────────────────

async function apply(tx: Tx, p: Prepared, effects: Effects): Promise<WebhookResult> {
  switch (p.kind) {
    case "checkout_paid":
      await checkoutPaid(tx, p, effects);
      return "processed";
    case "checkout_abandoned":
      await checkoutAbandoned(tx, p.session);
      return "processed";
    case "invoice_paid":
      await invoicePaid(tx, p, effects);
      return "processed";
    case "subscription_status":
      await subscriptionStatus(tx, p.subscriptionId, p.status, p.endsBeforeNextPayment, p.at);
      return "processed";
    case "charge_refunded":
      await chargeRefunded(tx, p.charge);
      return "processed";
    case "noop":
      return "processed";
    case "ignored":
      return "ignored";
  }
}

async function checkoutPaid(tx: Tx, p: Extract<Prepared, { kind: "checkout_paid" }>, effects: Effects) {
  const { session, paidAt } = p;
  const type = session.metadata?.type;
  const paymentIntentId = idOf(session.payment_intent);
  const customerId = idOf(session.customer);
  const personId = session.metadata?.personId ?? null;

  if (personId) {
    await lockPerson(tx, personId);
    if (customerId) {
      // Remember the customer for next time, in this Stripe mode; an id from the other mode is replaced.
      const mode = env.stripeMode;
      await tx
        .update(people)
        .set({ stripeCustomerId: customerId, stripeCustomerMode: mode })
        .where(and(eq(people.id, personId), sql`(${people.stripeCustomerId} is null or ${people.stripeCustomerMode} is distinct from ${mode})`));
    }
  }

  if (type === "donation" || type === "membership") {
    const rows = await tx
      .update(contributions)
      .set({ status: "succeeded", paidAt, stripePaymentIntentId: paymentIntentId })
      .where(and(eq(contributions.stripeCheckoutSessionId, session.id), eq(contributions.status, "pending")))
      .returning();
    const pending = await enforceLimit(tx, rows, paidAt);
    // The membership hook covers a fee; donations are told about on their own.
    effects.contributionIds.push(...rows.filter((r) => r.kind === "donation" && (pending.get(r.id) ?? 0) < r.amountCents).map((r) => r.id));
  }

  if (type === "membership") {
    const membership = await tx.query.memberships.findFirst({ where: eq(memberships.stripeCheckoutSessionId, session.id) });
    if (membership?.status === "pending_payment") {
      // A fee returned in full as over the limit is no membership.
      const fee = await tx.query.contributions.findFirst({
        where: and(eq(contributions.stripeCheckoutSessionId, session.id), eq(contributions.kind, "membership_fee")),
      });
      const paidInFull = fee?.status === "succeeded" && fee.refundPendingCents < fee.amountCents;
      if (paidInFull) {
        const term = membershipTerm(await latestActiveMembershipExpiry(tx, membership.personId, paidAt), paidAt);
        await tx.update(memberships).set({ status: "active", ...term }).where(eq(memberships.id, membership.id));
        effects.membershipIds.push(membership.id);
      } else {
        await tx.update(memberships).set({ status: "cancelled" }).where(eq(memberships.id, membership.id));
        if (fee && fee.refundPendingCents + fee.refundedCents >= fee.amountCents) effects.feeReturnedMembershipIds.push(membership.id);
      }
    }
  }

  if (type === "recurring_donation") {
    const started = await tx
      .update(recurringDonations)
      .set({ status: "active", stripeSubscriptionId: idOf(session.subscription) })
      .where(and(eq(recurringDonations.stripeCheckoutSessionId, session.id), eq(recurringDonations.status, "pending")))
      .returning({ id: recurringDonations.id });
    effects.recurringIds.push(...started.map((r) => r.id));
  }

  if (type === "order") {
    const paid = await tx
      .update(orders)
      .set({
        status: "paid",
        paidAt,
        email: session.customer_details?.email?.trim().toLowerCase() ?? null,
        personId: p.orderPersonId,
        shipping: sessionShipping(session),
        stripePaymentIntentId: paymentIntentId,
      })
      .where(and(eq(orders.stripeCheckoutSessionId, session.id), eq(orders.status, "pending_payment")))
      .returning({ id: orders.id });
    effects.orderIds.push(...paid.map((r) => r.id));
  }
}

async function checkoutAbandoned(tx: Tx, session: Stripe.Checkout.Session) {
  await tx
    .update(contributions)
    .set({ status: "failed" })
    .where(and(eq(contributions.stripeCheckoutSessionId, session.id), eq(contributions.status, "pending")));
  await tx
    .update(memberships)
    .set({ status: "cancelled" })
    .where(and(eq(memberships.stripeCheckoutSessionId, session.id), eq(memberships.status, "pending_payment")));
  await tx
    .update(recurringDonations)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(and(eq(recurringDonations.stripeCheckoutSessionId, session.id), eq(recurringDonations.status, "pending")));
  await tx
    .update(orders)
    .set({ status: "cancelled" })
    .where(and(eq(orders.stripeCheckoutSessionId, session.id), eq(orders.status, "pending_payment")));
}

/**
 * Each monthly payment is recorded as a contribution per slate, for what the
 * invoice actually collected: the gift's amounts when it was paid in full,
 * shared out in proportion when a coupon or credit made it less (or a
 * dashboard price change more). An invoice that collected nothing records
 * nothing.
 */
async function invoicePaid(tx: Tx, p: Extract<Prepared, { kind: "invoice_paid" }>, effects: Effects) {
  const { invoice, subscriptionId, giftId, paymentIntentId, paidAt } = p;
  const gift = giftId
    ? await tx.query.recurringDonations.findFirst({ where: eq(recurringDonations.id, giftId) })
    : subscriptionId
      ? await tx.query.recurringDonations.findFirst({ where: eq(recurringDonations.stripeSubscriptionId, subscriptionId) })
      : undefined;
  if (!gift) return;
  await lockPerson(tx, gift.personId);

  // The first invoice can arrive before checkout.session.completed.
  if (gift.status === "pending") {
    await tx
      .update(recurringDonations)
      .set({ status: "active", stripeSubscriptionId: subscriptionId ?? gift.stripeSubscriptionId })
      .where(eq(recurringDonations.id, gift.id));
    effects.recurringIds.push(gift.id);
  } else if (!gift.stripeSubscriptionId && subscriptionId) {
    await tx.update(recurringDonations).set({ stripeSubscriptionId: subscriptionId }).where(eq(recurringDonations.id, gift.id));
  }

  const amounts = typeof invoice.amount_paid === "number" ? allocatePayment(gift.slateAmounts, invoice.amount_paid) : gift.slateAmounts;
  const slates = SLATES.filter((slate) => (amounts[slate] ?? 0) > 0);
  if (slates.length === 0) return;
  const rows = await tx
    .insert(contributions)
    .values(
      slates.map((slate) => ({
        personId: gift.personId,
        kind: "donation" as const,
        frequency: "monthly" as const,
        slate,
        fund: "imagine_victory_fund",
        amountCents: amounts[slate]!,
        status: "succeeded" as const,
        paidAt,
        contributorName: gift.contributorName,
        contributorAddress: gift.contributorAddress,
        contributorCity: gift.contributorCity,
        contributorPostalCode: gift.contributorPostalCode,
        eligibilityAttestedAt: gift.eligibilityAttestedAt,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: subscriptionId ?? gift.stripeSubscriptionId,
        stripePaymentIntentId: paymentIntentId,
      })),
    )
    .onConflictDoNothing()
    .returning();
  const pending = await enforceLimit(tx, rows, paidAt);
  effects.contributionIds.push(...rows.filter((r) => (pending.get(r.id) ?? 0) < r.amountCents).map((r) => r.id));
}

/**
 * Backstop for the annual limit, run on every successful payment while the
 * person's lock is held: anything that takes a contributor over the limit
 * for a slate is marked to go back to them. The refund itself is sent after
 * the transaction commits. Returns the amount marked per row.
 */
async function enforceLimit(tx: Tx, rows: Contribution[], paidAt: Date): Promise<Map<string, number>> {
  const pending = new Map<string, number>();
  // The limit of each payment's own contribution year (Pacific).
  const limits = new Map<number, number>();
  for (const row of rows) {
    const { year } = pacificYearMonth(row.paidAt ?? paidAt);
    if (!limits.has(year)) limits.set(year, await limitForYear(year, tx));
    const limit = limits.get(year)!;
    const [start, end] = pacificYearBounds(year);
    const [{ accepted }] = await tx
      .select({
        accepted: sql<string>`coalesce(sum(${contributions.amountCents} - ${contributions.refundedCents} - ${contributions.refundPendingCents}), 0)`,
      })
      .from(contributions)
      .where(
        and(
          eq(contributions.personId, row.personId),
          eq(contributions.slate, row.slate),
          eq(contributions.status, "succeeded"),
          gte(contributions.paidAt, start),
          lt(contributions.paidAt, end),
          ne(contributions.id, row.id),
        ),
      );
    const excess = excessOverLimit(Number(accepted), row.amountCents, limit);
    if (excess === 0) continue;
    await tx.update(contributions).set({ refundPendingCents: excess }).where(eq(contributions.id, row.id));
    pending.set(row.id, excess);
  }
  return pending;
}

/**
 * A subscription Stripe has stopped (or resumed) collecting on, or that will
 * take no further payment. A gift is made active again only by an event newer
 * than its cancellation, so a stale update Stripe delivers late can't revive
 * a gift that has since ended.
 */
async function subscriptionStatus(tx: Tx, subscriptionId: string, status: string, endsBeforeNextPayment: boolean, at: Date) {
  const next = recurringStatusFor(status, endsBeforeNextPayment);
  if (next === "cancelled") {
    await tx
      .update(recurringDonations)
      .set({ status: "cancelled", cancelledAt: at })
      .where(and(eq(recurringDonations.stripeSubscriptionId, subscriptionId), ne(recurringDonations.status, "cancelled")));
  } else if (next === "active") {
    await tx
      .update(recurringDonations)
      .set({ status: "active", cancelledAt: null })
      .where(
        and(
          eq(recurringDonations.stripeSubscriptionId, subscriptionId),
          eq(recurringDonations.status, "cancelled"),
          or(isNull(recurringDonations.cancelledAt), lte(recurringDonations.cancelledAt, at)),
        ),
      );
  }
}

/**
 * A refund on one of our payments, from the dashboard or our own, in full or
 * in part. Our rows for the payment are brought into line with the charge's
 * refunded total, which also settles any refund we had decided on that an
 * operator returned by hand (so it is never sent again).
 */
async function chargeRefunded(tx: Tx, charge: Stripe.Charge) {
  const paymentIntentId = idOf(charge.payment_intent);
  if (!paymentIntentId) return;
  await reconcileRefunds(tx, paymentIntentId, charge.amount_refunded);
  if (charge.amount_refunded >= charge.amount) {
    await tx.update(orders).set({ status: "refunded" }).where(eq(orders.stripePaymentIntentId, paymentIntentId));
  }
}

// ── After commit ───────────────────────────────────────────────────────────

/** Tell supporters what happened. A failed message must never fail the webhook. */
async function notify(db: Db, effects: Effects) {
  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`${label} notification failed`, err);
    }
  };
  for (const membershipId of effects.membershipIds) await run("Membership", () => notifyMembershipActive(db, { membershipId }));
  // A new member goes to the desk too, from the membership's own snapshot (never the fee).
  for (const membershipId of effects.membershipIds) await forwardMembership(db, membershipId);
  for (const membershipId of effects.feeReturnedMembershipIds) await run("Membership fee returned", () => tellFeeReturned(db, membershipId));
  if (effects.contributionIds.length) await run("Donation", () => notifyDonationSucceeded(db, { contributionIds: effects.contributionIds }));
  for (const recurringDonationId of effects.recurringIds) await run("Recurring gift", () => notifyRecurringStarted(db, { recurringDonationId }));
  for (const orderId of effects.orderIds) await run("Order", () => notifyOrderPaid(db, { orderId }));
  // A paid order goes to the desk as the "Bought merch" tag only: never the total or the items.
  for (const orderId of effects.orderIds) await forwardOrder(db, orderId);
}

/**
 * The membership form gives everyone the same answer, so a fee over the
 * contribution limit is only found out once it is paid: it goes back, the
 * membership is cancelled, and only the person who paid is told why.
 */
async function tellFeeReturned(db: Db, membershipId: string) {
  const membership = await db.query.memberships.findFirst({ where: eq(memberships.id, membershipId), columns: { personId: true } });
  if (!membership) return;
  const person = await db.query.people.findFirst({ where: eq(people.id, membership.personId), columns: { email: true, firstName: true } });
  if (!person?.email) return;
  const { org } = await getSettings();
  const message = membershipFeeReturnedEmail({ siteUrl: env.siteUrl, orgName: org.name, orgEmail: org.email }, { firstName: person.firstName ?? "" });
  await sendEmail(db, { to: person.email, kind: "membership-fee-limit", personId: membership.personId, ...message });
}
