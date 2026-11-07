// The parts of the Stripe webhook that don't need a database: reading the
// objects Stripe sends in either of its API-version shapes.
import { describe, expect, it, vi } from "vitest";
import type { Stripe } from "@/lib/stripe";

vi.mock("server-only", () => ({}));
const { eventTime, invoicePaymentIntentId, invoiceSubscription, sessionShipping } = await import("@/lib/server/webhooks");

const asInvoice = (o: unknown) => o as Stripe.Invoice;
const asSession = (o: unknown) => o as Stripe.Checkout.Session;

describe("invoiceSubscription", () => {
  it("reads the current shape (invoice.parent.subscription_details)", () => {
    const invoice = asInvoice({ id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: { recurringDonationId: "g1" } } } });
    expect(invoiceSubscription(invoice)).toEqual({ subscriptionId: "sub_1", metadata: { recurringDonationId: "g1" }, known: true });
  });

  it("reads the pre-2025-03-31 shape (invoice.subscription, invoice.subscription_details)", () => {
    const invoice = asInvoice({ id: "in_1", subscription: { id: "sub_1" }, subscription_details: { metadata: { recurringDonationId: "g1" } } });
    expect(invoiceSubscription(invoice)).toEqual({ subscriptionId: "sub_1", metadata: { recurringDonationId: "g1" }, known: true });
    expect(invoiceSubscription(asInvoice({ id: "in_2", subscription: "sub_2" }))).toEqual({ subscriptionId: "sub_2", metadata: null, known: true });
  });

  it("knows a one-off invoice in either shape is not a subscription invoice", () => {
    expect(invoiceSubscription(asInvoice({ id: "in_1", parent: null }))).toEqual({ subscriptionId: null, metadata: null, known: true });
    expect(invoiceSubscription(asInvoice({ id: "in_1", subscription: null }))).toEqual({ subscriptionId: null, metadata: null, known: true });
  });

  it("asks for the object to be re-read when neither shape is present", () => {
    expect(invoiceSubscription(asInvoice({ id: "in_1", object: "invoice" })).known).toBe(false);
  });
});

describe("invoicePaymentIntentId", () => {
  it("uses the legacy top-level payment_intent when present", () => {
    expect(invoicePaymentIntentId(asInvoice({ payment_intent: "pi_1" }))).toBe("pi_1");
    expect(invoicePaymentIntentId(asInvoice({ payment_intent: { id: "pi_2" } }))).toBe("pi_2");
  });
  it("uses an expanded payments list, preferring the paid one", () => {
    const invoice = asInvoice({
      payments: { data: [{ status: "open", payment: { payment_intent: "pi_open" } }, { status: "paid", payment: { payment_intent: "pi_paid" } }] },
    });
    expect(invoicePaymentIntentId(invoice)).toBe("pi_paid");
  });
  it("returns null when the object carries nothing, so the caller lists the invoice's payments", () => {
    expect(invoicePaymentIntentId(asInvoice({ id: "in_1" }))).toBeNull();
  });
});

describe("sessionShipping", () => {
  const address = { line1: "1 Main", city: "Surrey", country: "CA", postal_code: "V3T 1V8", state: "BC" };
  it("reads collected_information and adds the phone", () => {
    const session = asSession({ collected_information: { shipping_details: { name: "Buyer", address } }, customer_details: { phone: "6045550100" } });
    expect(sessionShipping(session)).toEqual({ name: "Buyer", address, phone: "6045550100" });
  });
  it("falls back to the legacy top-level shipping_details", () => {
    const session = asSession({ shipping_details: { name: "Buyer", address }, customer_details: { email: "b@example.com" } });
    expect(sessionShipping(session)).toEqual({ name: "Buyer", address, phone: null });
  });
  it("is null when nothing was collected", () => {
    expect(sessionShipping(asSession({ collected_information: null }))).toBeNull();
  });
});

describe("eventTime", () => {
  it("uses the event's created timestamp", () => {
    expect(eventTime({ created: 1_700_000_000 })).toEqual(new Date("2023-11-14T22:13:20.000Z"));
  });
  it("falls back to now when it is missing", () => {
    const before = Date.now();
    expect(eventTime({ created: 0 }).getTime()).toBeGreaterThanOrEqual(before);
  });
});
