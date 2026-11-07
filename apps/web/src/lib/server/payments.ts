import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { contributions, memberships, orderItems, orders, people, products, recurringDonations } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { getStripe, type Stripe } from "@/lib/stripe";
import {
  isYouthMember,
  membershipAmountProblem,
  membershipMinimumFor,
  membershipMinimums as minimumsFrom,
  membershipTerm,
  MIN_DONATION_CENTS,
  pacificYear,
  slateAmountsFor,
  totalCents,
  type MembershipMinimums,
  type Slate,
} from "@/lib/contributions";
import { formatCents } from "@/lib/money";
import { ageOn, BC_POSTAL_CODE_RE, MIN_MEMBER_AGE, normalizePostalCode, OUTSIDE_SURREY } from "@/lib/neighbourhoods";
import type { cartSchema, donationSchema, membershipSchema } from "@/lib/validation";
import { assertWithinLimit, limitForYear, lockPerson, SLATE_LABEL, UserFacingError, type Querier } from "./limits";
import { notifyMembershipActive } from "./notifications";
import { findOrCreatePerson, type Person } from "./people";
import { subscribe } from "./newsletter";
import { trackingFromRequest, type Tracking } from "./attribution";
import { CONSENT_WORDING, consentMeta, recordConsent } from "./consent";
import { normalizePhone } from "./sms";
import { forwardMembership } from "./base-ground-forward";

export { contributionRoom, contributionTotals, currentLimit, limitForYear, UserFacingError } from "./limits";
export { addYear } from "@/lib/contributions";

// Stripe's minimum Checkout lifetime is 30 minutes, measured when the request
// arrives, so a little slack keeps a slow request from being refused.
const CHECKOUT_TTL_MINUTES = 35;

// ── Public form context ────────────────────────────────────────────────────

/**
 * What a public form's request carries besides its fields: where the visit
 * came from and who referred it (body fields first, then the tracking
 * cookie), and the request details the consent ledger keeps as proof.
 */
export interface PublicFormContext {
  tracking?: Tracking;
  meta?: { ip: string | null; userAgent: string | null };
}

export function publicFormContext(req: Request, body: { source?: unknown; ref?: unknown }): PublicFormContext {
  return { tracking: trackingFromRequest(req, body), meta: consentMeta(req) };
}

/**
 * The donate form's newsletter tick, word for word as the form shows it
 * (src/components/forms/DonateForm.tsx), for the consent ledger.
 */
export const DONATION_NEWSLETTER_WORDING = CONSENT_WORDING.newsletter;

/**
 * Express consent from a public form's own ticks, and nothing without them:
 * each tick is written to the consent ledger with the wording the person saw
 * (which also sets the person's consent columns), and an email tick
 * subscribes them. A text tick counts only with a phone number typed on this
 * same form, never one stored from before. Returns whether the email grant
 * was recorded.
 */
async function recordFormConsent(
  db: Db,
  person: Person,
  ctx: PublicFormContext,
  consent: {
    source: string;
    email?: { purpose: "updates" | "newsletter"; wording: string; subscribeAs: string } | null;
    sms?: { phone: string | undefined } | null;
  },
): Promise<{ emailGranted: boolean }> {
  const meta = ctx.meta ?? { ip: null, userAgent: null };
  let emailGranted = false;
  if (consent.email) {
    // A public form cannot undo an earlier withdrawal: subscribe only when the grant was recorded.
    const granted = await recordConsent(db, {
      personId: person.id,
      email: person.email,
      channel: "email",
      purpose: consent.email.purpose,
      action: "grant",
      wording: consent.email.wording,
      source: consent.source,
      ...meta,
    });
    if (granted) await subscribe(db, person.email, consent.email.subscribeAs, person.id);
    emailGranted = granted;
  }
  if (consent.sms && consent.sms.phone?.trim() && normalizePhone(consent.sms.phone)) {
    await recordConsent(db, {
      personId: person.id,
      email: person.email,
      channel: "sms",
      purpose: "sms",
      action: "grant",
      wording: CONSENT_WORDING.sms,
      source: consent.source,
      ...meta,
    });
  }
  return { emailGranted };
}

// ── Stripe customers ───────────────────────────────────────────────────────

/** A stored customer id is only reused in the Stripe mode that created it. */
function reusableCustomerId(person: Person): string | null {
  return person.stripeCustomerId && person.stripeCustomerMode === env.stripeMode ? person.stripeCustomerId : null;
}

function isMissingCustomer(err: unknown): boolean {
  const e = err as { code?: unknown; param?: unknown } | null;
  return Boolean(e) && e?.code === "resource_missing" && e?.param === "customer";
}

type CustomerParams = { customer: string } | { customer_email: string; customer_creation?: "always" };

function customerParams(customerId: string | null, email: string, mode: "payment" | "subscription"): CustomerParams {
  if (customerId) return { customer: customerId };
  // Subscriptions always create a customer; payments must ask for one so the next checkout can reuse it.
  return mode === "payment" ? { customer_email: email, customer_creation: "always" } : { customer_email: email };
}

/**
 * Create a Checkout session for a person. When Stripe no longer knows the
 * stored customer (deleted, or captured in the other mode before modes were
 * recorded), the id is forgotten and the session is created once more as a
 * new customer.
 */
async function createCheckoutSession(
  db: Db,
  person: Person,
  build: (customerId: string | null) => Stripe.Checkout.SessionCreateParams,
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripe();
  const reusable = reusableCustomerId(person);
  try {
    return await stripe.checkout.sessions.create(build(reusable));
  } catch (err) {
    if (!reusable || !isMissingCustomer(err)) throw err;
    await db
      .update(people)
      .set({ stripeCustomerId: null, stripeCustomerMode: null })
      .where(and(eq(people.id, person.id), eq(people.stripeCustomerId, reusable)));
    return stripe.checkout.sessions.create(build(null));
  }
}

function checkoutBase() {
  return {
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_MINUTES * 60,
    locale: "en" as const,
  };
}

// ── Donations ──────────────────────────────────────────────────────────────

export async function createDonationCheckout(db: Db, input: z.output<typeof donationSchema>, ctx: PublicFormContext = {}) {
  // The Star and Superstar clubs give this year's limit.
  const limitCents = await limitForYear(pacificYear(new Date()), db);
  if (input.tier === "standard" && input.amountCents < MIN_DONATION_CENTS) {
    throw new UserFacingError(`The smallest contribution we can take online is ${formatCents(MIN_DONATION_CENTS)}.`);
  }
  const slateAmounts = slateAmountsFor(input.tier, input.frequency, input.amountCents, limitCents);
  const postalCode = normalizePostalCode(input.postalCode);

  const person = await findOrCreatePerson(
    db,
    input.email,
    {
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      address: input.address,
      city: input.city,
      province: "BC",
      postalCode,
    },
    { source: ctx.tracking?.source ?? "donation", referredByCode: ctx.tracking?.ref },
  );
  await recordFormConsent(db, person, ctx, {
    source: "donation-form",
    email: input.newsletter ? { purpose: "newsletter", wording: DONATION_NEWSLETTER_WORDING, subscribeAs: "donation" } : null,
  });

  const snapshot = {
    personId: person.id,
    contributorName: `${input.firstName} ${input.lastName}`,
    contributorAddress: input.address,
    contributorCity: input.city,
    contributorPostalCode: postalCode,
    eligibilityAttestedAt: new Date(),
  };
  const slates = Object.keys(slateAmounts) as Slate[];
  const lineName = (slate: Slate) =>
    slates.length > 1 ? `Contribution to Imagine Surrey (${SLATE_LABEL[slate]})` : "Contribution to Imagine Surrey";

  if (input.frequency === "monthly") {
    // The limit check and the row insert share one transaction and the person's lock.
    const gift = await db.transaction(async (tx) => {
      await lockPerson(tx, person.id);
      await assertWithinLimit(tx, person.id, "monthly", slateAmounts);
      const [row] = await tx.insert(recurringDonations).values({ ...snapshot, slateAmounts }).returning();
      return row;
    });

    const metadata = { type: "recurring_donation", recurringDonationId: gift.id, personId: person.id };
    let session: Stripe.Checkout.Session;
    try {
      session = await createCheckoutSession(db, person, (customerId) => ({
        ...customerParams(customerId, person.email, "subscription"),
        ...checkoutBase(),
        mode: "subscription",
        line_items: slates.map((slate) => ({
          quantity: 1,
          price_data: {
            currency: "cad",
            unit_amount: slateAmounts[slate]!,
            recurring: { interval: "month" as const },
            product_data: { name: `Monthly ${lineName(slate).toLowerCase()} · Imagine Victory Fund` },
          },
        })),
        metadata,
        subscription_data: { metadata },
        success_url: `${env.siteUrl}/donate/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.siteUrl}/donate?frequency=monthly&cancelled=1`,
      }));
    } catch (err) {
      await db
        .update(recurringDonations)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(and(eq(recurringDonations.id, gift.id), eq(recurringDonations.status, "pending")));
      throw err;
    }
    await db.update(recurringDonations).set({ stripeCheckoutSessionId: session.id }).where(eq(recurringDonations.id, gift.id));
    return { url: session.url! };
  }

  const rows = await db.transaction(async (tx) => {
    await lockPerson(tx, person.id);
    await assertWithinLimit(tx, person.id, "one_time", slateAmounts);
    return tx
      .insert(contributions)
      .values(slates.map((slate) => ({ ...snapshot, kind: "donation" as const, frequency: "one_time" as const, slate, amountCents: slateAmounts[slate]! })))
      .returning({ id: contributions.id });
  });

  const ids = rows.map((r) => r.id);
  const metadata = { type: "donation", personId: person.id };
  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSession(db, person, (customerId) => ({
      ...customerParams(customerId, person.email, "payment"),
      ...checkoutBase(),
      mode: "payment",
      submit_type: "donate",
      line_items: slates.map((slate) => ({
        quantity: 1,
        price_data: { currency: "cad", unit_amount: slateAmounts[slate]!, product_data: { name: lineName(slate) } },
      })),
      metadata,
      payment_intent_data: { metadata, description: `Contribution of ${formatCents(totalCents(slateAmounts))}` },
      success_url: `${env.siteUrl}/donate/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.siteUrl}/donate?cancelled=1`,
    }));
  } catch (err) {
    await db
      .update(contributions)
      .set({ status: "failed" })
      .where(and(inArray(contributions.id, ids), eq(contributions.status, "pending")));
    throw err;
  }
  await db.update(contributions).set({ stripeCheckoutSessionId: session.id }).where(inArray(contributions.id, ids));
  return { url: session.url! };
}

// ── Memberships ────────────────────────────────────────────────────────────

/**
 * The membership minimums: MEMBERSHIP_FEE_CENTS for everyone, and for youth
 * members (14 to 30) MEMBERSHIP_YOUTH_MIN_CENTS or else half of it.
 */
export function membershipMinimums(): MembershipMinimums {
  return minimumsFrom(env.membershipFeeCents, env.membershipYouthMinCents);
}

/**
 * The only two answers the membership form gets: "received" when there is no
 * fee, otherwise a checkout for the amount chosen, whoever the email belongs to.
 * Neither says whether the email already belongs to a member, nor whether its
 * owner has given close to the contribution limit: either would tell anyone
 * who typed an address which party its owner supports. So a fee is never
 * refused up front for being over the limit; if one that is gets paid, the
 * webhook returns it, cancels the membership and emails the payer why.
 */
export type MembershipResult = { status: "checkout"; url: string } | { status: "received" };

/** When the person's latest active membership ends, if any is still running. */
export async function latestActiveMembershipExpiry(q: Querier, personId: string, now = new Date()): Promise<Date | null> {
  const latest = await q.query.memberships.findFirst({
    where: and(eq(memberships.personId, personId), eq(memberships.status, "active"), gt(memberships.expiresAt, now)),
    orderBy: (m, { desc }) => [desc(m.expiresAt)],
    columns: { expiresAt: true },
  });
  return latest?.expiresAt ?? null;
}

export async function createMembership(db: Db, input: z.output<typeof membershipSchema>, ctx: PublicFormContext = {}): Promise<MembershipResult> {
  const now = new Date();
  const age = ageOn(input.birthdate, now);
  if (age === undefined || age < MIN_MEMBER_AGE) {
    throw new UserFacingError(`Members must be ${MIN_MEMBER_AGE} or older.`, { birthdate: `Members must be ${MIN_MEMBER_AGE} or older` });
  }
  // Membership is by donation. The amount is checked against the minimum that
  // applies (youth from the birthdate) and against this year's contribution
  // limit, which is the most anyone can give, and is the same for everyone:
  // nothing here depends on who the email belongs to.
  const minimums = membershipMinimums();
  const youth = isYouthMember(input.birthdate, now);
  const minCents = membershipMinimumFor(minimums, youth);
  const feeCents = minimums.standardCents === 0 ? 0 : (input.amountCents ?? minCents);
  if (minimums.standardCents > 0) {
    const problem = membershipAmountProblem(feeCents, minimums, youth, await limitForYear(pacificYear(now), db));
    if (problem) throw new UserFacingError(problem, { amountCents: problem });
  }
  if (feeCents > 0) {
    if (input.citizenshipStatus === "Other") {
      throw new UserFacingError("Under BC election law we can only take membership fees from Canadian citizens and permanent residents.", {
        citizenshipStatus: "Membership fees count as contributions under BC law",
      });
    }
    if (!BC_POSTAL_CODE_RE.test(input.postalCode)) {
      throw new UserFacingError("Under BC election law we can only take membership fees from people who live in BC.", {
        postalCode: "Enter a BC postal code",
      });
    }
  }

  const postalCode = normalizePostalCode(input.postalCode);
  const person = await findOrCreatePerson(
    db,
    input.email,
    {
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      address: input.address,
      city: input.city,
      province: BC_POSTAL_CODE_RE.test(postalCode) ? "BC" : undefined,
      postalCode,
      neighbourhood: input.neighbourhood,
      birthdate: input.birthdate,
      citizenshipStatus: input.citizenshipStatus,
      gender: input.gender || undefined,
      languages: input.languages,
      student: input.student,
      campus: input.student ? input.campus || undefined : undefined,
      issue: input.issue,
      interestVolunteer: input.interestVolunteer,
      interestLawnSign: input.interestLawnSign,
      locale: input.locale,
    },
    { source: ctx.tracking?.source ?? "membership", referredByCode: ctx.tracking?.ref },
  );
  // Joining is not consent to marketing: only the form's own unticked boxes are.
  const { emailGranted } = await recordFormConsent(db, person, ctx, {
    source: "membership-form",
    email: input.updatesConsent ? { purpose: "updates", wording: CONSENT_WORDING.updates, subscribeAs: "membership" } : null,
    sms: input.smsConsent ? { phone: input.phone } : null,
  });

  const votingEligible = input.neighbourhood !== OUTSIDE_SURREY && input.city.trim().toLowerCase() === "surrey";
  // The details as given on this form, kept with the membership for the voting roll.
  const snapshot = {
    personId: person.id,
    feeCents,
    youth,
    votingEligible,
    memberName: `${input.firstName} ${input.lastName}`,
    memberAddress: input.address,
    memberCity: input.city,
    memberPostalCode: postalCode,
    memberNeighbourhood: input.neighbourhood,
    memberPhone: input.phone ?? null,
    // What is forwarded to the desk once the membership is active.
    interestVolunteer: input.interestVolunteer,
    interestLawnSign: input.interestLawnSign,
    updatesConsent: emailGranted,
  };

  if (feeCents === 0) {
    // Free membership: active at once, extending any membership still running.
    const membership = await db.transaction(async (tx) => {
      await lockPerson(tx, person.id);
      const term = membershipTerm(await latestActiveMembershipExpiry(tx, person.id), new Date());
      const [row] = await tx
        .insert(memberships)
        .values({ ...snapshot, status: "active", ...term })
        .returning({ id: memberships.id });
      return row;
    });
    try {
      await notifyMembershipActive(db, { membershipId: membership.id });
    } catch (err) {
      console.error("Membership notification failed", err);
    }
    await forwardMembership(db, membership.id);
    return { status: "received" };
  }

  // No limit check here (see MembershipResult): the webhook's backstop, under
  // the same person lock, runs on the amount chosen and returns whatever of it
  // turns out to be over the limit for the year it is paid in.
  const { membership, contribution } = await db.transaction(async (tx) => {
    await lockPerson(tx, person.id);
    const [membership] = await tx.insert(memberships).values(snapshot).returning({ id: memberships.id });
    const [contribution] = await tx
      .insert(contributions)
      .values({
        personId: person.id,
        kind: "membership_fee",
        frequency: "one_time",
        slate: "council",
        amountCents: feeCents,
        contributorName: `${input.firstName} ${input.lastName}`,
        contributorAddress: input.address,
        contributorCity: input.city,
        contributorPostalCode: postalCode,
        eligibilityAttestedAt: new Date(),
      })
      .returning({ id: contributions.id });
    return { membership, contribution };
  });


  const metadata = { type: "membership", membershipId: membership.id, personId: person.id };
  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSession(db, person, (customerId) => ({
      ...customerParams(customerId, person.email, "payment"),
      ...checkoutBase(),
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "cad", unit_amount: feeCents, product_data: { name: "Imagine Surrey membership (1 year, by donation)" } } }],
      metadata,
      payment_intent_data: { metadata, description: `Imagine Surrey membership by donation: ${formatCents(feeCents)}` },
      success_url: `${env.siteUrl}/join/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.siteUrl}/#join`,
    }));
  } catch (err) {
    await db
      .update(memberships)
      .set({ status: "cancelled" })
      .where(and(eq(memberships.id, membership.id), eq(memberships.status, "pending_payment")));
    await db
      .update(contributions)
      .set({ status: "failed" })
      .where(and(eq(contributions.id, contribution.id), eq(contributions.status, "pending")));
    throw err;
  }
  await db.update(memberships).set({ stripeCheckoutSessionId: session.id }).where(eq(memberships.id, membership.id));
  await db.update(contributions).set({ stripeCheckoutSessionId: session.id }).where(eq(contributions.id, contribution.id));
  return { status: "checkout", url: session.url! };
}

// ── Shop ───────────────────────────────────────────────────────────────────

export async function createOrderCheckout(db: Db, input: z.output<typeof cartSchema>) {
  const slugs = [...new Set(input.items.map((i) => i.slug))];
  const found = await db.select().from(products).where(and(inArray(products.slug, slugs), eq(products.active, true)));
  const bySlug = new Map(found.map((p) => [p.slug, p]));
  const missing = slugs.filter((s) => !bySlug.has(s));
  if (missing.length) throw new UserFacingError("Some items in your cart are no longer available. Please refresh the page.");

  // Merge duplicate lines for the same product.
  const quantities = new Map<string, number>();
  for (const item of input.items) quantities.set(item.slug, (quantities.get(item.slug) ?? 0) + item.quantity);
  const lines = [...quantities].map(([slug, quantity]) => ({ product: bySlug.get(slug)!, quantity }));
  const total = lines.reduce((sum, l) => sum + l.product.priceCents * l.quantity, 0);

  const [order] = await db.insert(orders).values({ totalCents: total }).returning();
  await db.insert(orderItems).values(
    lines.map((l) => ({ orderId: order.id, productId: l.product.id, name: l.product.name, unitPriceCents: l.product.priceCents, quantity: l.quantity })),
  );

  const metadata = { type: "order", orderId: order.id };
  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.create({
      ...checkoutBase(),
      mode: "payment",
      line_items: lines.map((l) => ({
        quantity: l.quantity,
        price_data: { currency: "cad", unit_amount: l.product.priceCents, product_data: { name: l.product.name } },
      })),
      shipping_address_collection: { allowed_countries: ["CA"] },
      phone_number_collection: { enabled: true },
      metadata,
      payment_intent_data: { metadata },
      success_url: `${env.siteUrl}/shop/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.siteUrl}/shop`,
    });
  } catch (err) {
    await db
      .update(orders)
      .set({ status: "cancelled" })
      .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")));
    throw err;
  }
  await db.update(orders).set({ stripeCheckoutSessionId: session.id }).where(eq(orders.id, order.id));
  return { url: session.url! };
}
