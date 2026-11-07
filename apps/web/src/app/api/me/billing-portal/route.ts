import { NextResponse, type NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { env } from "@/lib/env";
import { getMember } from "@/lib/server/member-auth";
import { getStripe } from "@/lib/stripe";

/**
 * Open Stripe's billing portal for the supporter's monthly gift. The customer
 * id must belong to the Stripe mode the site runs in; a test-mode customer
 * is never sent to the live portal. Any Stripe failure comes back to /me
 * with a friendly message rather than an error page.
 */
export async function POST(req: NextRequest) {
  const person = await getMember();
  if (!person) return redirectTo("/me/login?next=%2Fme", 303);
  if (!person.stripeCustomerId || person.stripeCustomerMode !== env.stripeMode) return redirectTo("/me?billing=none", 303);
  try {
    const session = await getStripe().billingPortal.sessions.create({ customer: person.stripeCustomerId, return_url: `${env.siteUrl}/me` });
    return NextResponse.redirect(session.url, 303);
  } catch (err) {
    console.error("billing portal session failed", err instanceof Error ? err.message : err);
    return redirectTo("/me?billing=unavailable", 303);
  }
}
