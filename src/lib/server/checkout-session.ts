import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { getStripe } from "@/lib/stripe";

/** Look up a completed Checkout session for a thank-you page. Never throws. */
export async function completedSession(sessionId: unknown) {
  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_")) return null;
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    return session.status === "complete" ? session : null;
  } catch {
    return null;
  }
}

/**
 * The membership a Checkout session paid for, once the webhook has activated
 * it. Only the person who paid holds the session id, so the welcome page can
 * show them when their membership runs to. Never throws.
 */
export async function membershipForCheckoutSession(db: Db, sessionId: string) {
  try {
    return (
      (await db.query.memberships.findFirst({
        where: eq(memberships.stripeCheckoutSessionId, sessionId),
        columns: { status: true, startsAt: true, expiresAt: true, personId: true, feeCents: true },
      })) ?? null
    );
  } catch {
    return null;
  }
}
