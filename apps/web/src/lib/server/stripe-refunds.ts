import "server-only";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { contributions, memberships } from "@/lib/db/schema";
import { getStripe } from "@/lib/stripe";
import { allocateRefund, type RefundChange } from "@/lib/contributions";
import { lockPerson, type Querier } from "./limits";

type Contribution = typeof contributions.$inferSelect;

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

/**
 * Send Stripe every refund the webhook decided on. The webhook transaction
 * only records what must go back (refund_pending_cents), so no Stripe call
 * ever runs while a database connection is pinned; this runs after it
 * commits, and again on every later webhook, so a refund that failed is
 * retried. Once Stripe has it, the amount moves into refunded_cents.
 */
export async function issuePendingRefunds(db: Db): Promise<{ issued: number; failed: number }> {
  const rows = await db.select().from(contributions).where(gt(contributions.refundPendingCents, 0));
  let issued = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await issueRefund(db, row);
      issued += 1;
    } catch (err) {
      failed += 1;
      console.error(`Over-limit refund for contribution ${row.id} failed; it will be retried on the next webhook.`, err);
    }
  }
  return { issued, failed };
}

/**
 * Bring our rows for one payment into line with what Stripe has returned on
 * it (see allocateRefund). `confirmed` names the refunds Stripe attributes
 * to particular rows, when the caller has the list. A membership whose fee
 * is wholly returned is cancelled. Call it with the webhook's transaction or
 * inside one; it takes the person's lock.
 */
export async function reconcileRefunds(q: Querier, paymentIntentId: string, amountRefundedCents: number, confirmed = new Map<string, number>()): Promise<RefundChange[]> {
  const found = await q.query.contributions.findFirst({ where: eq(contributions.stripePaymentIntentId, paymentIntentId), columns: { personId: true } });
  if (!found) return [];
  await lockPerson(q, found.personId);
  const rows = await q.query.contributions.findMany({
    where: and(eq(contributions.stripePaymentIntentId, paymentIntentId), inArray(contributions.status, ["succeeded", "refunded", "refunded_over_limit"])),
  });
  const changes = allocateRefund(
    rows.map((r) => ({ ...r, confirmedCents: confirmed.get(r.id) })),
    amountRefundedCents,
  );
  for (const change of changes) {
    await q
      .update(contributions)
      .set({ refundedCents: change.refundedCents, refundPendingCents: change.refundPendingCents, ...(change.status ? { status: change.status } : {}) })
      .where(eq(contributions.id, change.id));
    const row = rows.find((r) => r.id === change.id);
    if (change.fullyRefunded && row?.kind === "membership_fee" && row.stripeCheckoutSessionId) {
      await q
        .update(memberships)
        .set({ status: "cancelled" })
        .where(and(eq(memberships.stripeCheckoutSessionId, row.stripeCheckoutSessionId), ne(memberships.status, "cancelled")));
    }
  }
  return changes;
}

/**
 * One row's pending refund. Before anything is sent, what Stripe already
 * lists as refunded on the payment is counted: a refund of ours that went
 * through but was never recorded (it carries the contribution id), or one an
 * operator made from the dashboard whose event has not arrived. Either would
 * otherwise be sent twice, or be refused by Stripe and retried for ever. The
 * idempotency key names the row and the amount, so a retry of the same
 * request can't refund twice while a changed amount is a new request.
 */
async function issueRefund(db: Db, row: Contribution): Promise<void> {
  const stripe = getStripe();
  const paymentIntentId = row.stripePaymentIntentId ?? (await resolvePaymentIntent(db, row));
  if (!paymentIntentId) throw new Error("No payment intent to refund against.");

  const listed = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
  const counted = listed.data.filter((r) => r.status !== "failed" && r.status !== "canceled");
  const confirmed = new Map<string, number>();
  for (const r of counted) {
    const id = r.metadata?.contributionId;
    if (id) confirmed.set(id, (confirmed.get(id) ?? 0) + r.amount);
  }
  const total = counted.reduce((sum, r) => sum + r.amount, 0);
  await db.transaction((tx) => reconcileRefunds(tx, paymentIntentId, total, confirmed));

  const fresh = await db.query.contributions.findFirst({ where: eq(contributions.id, row.id), columns: { refundPendingCents: true } });
  const amount = fresh?.refundPendingCents ?? 0;
  if (amount <= 0) return; // Already returned, by us or from the dashboard.

  await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount,
      reason: "requested_by_customer",
      metadata: { reason: "over_annual_contribution_limit", contributionId: row.id },
    },
    { idempotencyKey: `over-limit-${row.id}-${amount}` },
  );
  // Guarded by the pending amount: a charge.refunded event that got here first has already recorded it.
  await db
    .update(contributions)
    .set({
      refundedCents: sql`${contributions.refundedCents} + ${amount}`,
      refundPendingCents: 0,
      status: sql`case when ${contributions.refundedCents} + ${amount} >= ${contributions.amountCents} then 'refunded_over_limit'::contribution_status else ${contributions.status} end`,
    })
    .where(and(eq(contributions.id, row.id), eq(contributions.refundPendingCents, amount)));
}

/** A monthly payment recorded before its payment intent was known: look it up from the invoice. */
async function resolvePaymentIntent(db: Db, row: Contribution): Promise<string | null> {
  if (!row.stripeInvoiceId) return null;
  const payments = await getStripe().invoicePayments.list({ invoice: row.stripeInvoiceId, limit: 10 });
  const paid = payments.data.find((p) => p.status === "paid") ?? payments.data[0];
  const paymentIntentId = idOf(paid?.payment?.payment_intent);
  if (paymentIntentId) {
    await db.update(contributions).set({ stripePaymentIntentId: paymentIntentId }).where(eq(contributions.id, row.id));
  }
  return paymentIntentId;
}
