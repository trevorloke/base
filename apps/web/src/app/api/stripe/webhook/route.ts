import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { error, json } from "@/lib/server/api";
import { handleStripeEvent } from "@/lib/server/webhooks";
import { getStripe, type Stripe } from "@/lib/stripe";

// Stripe → Dashboard → Developers → Webhooks. Subscribe this endpoint to:
// checkout.session.completed, checkout.session.async_payment_succeeded,
// checkout.session.async_payment_failed, checkout.session.expired,
// invoice.paid, customer.subscription.updated, customer.subscription.paused,
// customer.subscription.resumed, customer.subscription.deleted, charge.refunded.
// Set the endpoint's API version to the SDK's pinned version (see SETUP.md):
// objects delivered in another version's shape are re-read from Stripe.
export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return error("Missing Stripe signature.", 400);
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(payload, signature, env.stripeWebhookSecret);
  } catch {
    return error("Invalid Stripe signature.", 400);
  }

  try {
    const result = await handleStripeEvent(getDb(), event);
    return json({ received: true, result });
  } catch (err) {
    // A 500 makes Stripe retry with backoff.
    console.error(`Stripe webhook ${event.type} ${event.id} failed`, err);
    return error("Webhook handler failed.", 500);
  }
}
