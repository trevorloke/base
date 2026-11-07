import "server-only";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { consentEvents, newsletterSubscribers, people } from "@/lib/db/schema";

export type ConsentChannel = "email" | "sms";
export type ConsentPurpose = "newsletter" | "updates" | "sms" | "fundraising" | "volunteer";
export type ConsentBasis = "express" | "implied-member" | "implied-donor" | "implied-volunteer";

export type ConsentInput = {
  personId?: string | null;
  email: string;
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  action: "grant" | "withdraw";
  basis?: ConsentBasis;
  /** The exact wording the person saw next to the tick box or in the confirmation. */
  wording?: string | null;
  /** Which form or process recorded it, e.g. "membership-form", "petition:skytrain", "preferences", "sms-stop". */
  source?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * True only when the request proves control of the address: the preference
   * centre with a token, or a signed-in member. An unverified grant (any
   * public form) never reverses an earlier withdrawal.
   */
  verified?: boolean;
};

/**
 * Whether a grant may be written, given the latest ledger action for the same
 * person, channel and purpose. Anyone can type anyone's email into a public
 * form, so only a verified request can undo a withdrawal.
 */
export function grantAllowed(latestAction: string | null | undefined, verified: boolean): boolean {
  return verified || latestAction !== "withdraw";
}

export { CONSENT_WORDING } from "@/lib/consent-wording";

/**
 * Append one consent event and keep the person's current-state columns in step:
 * email grants set contactConsentAt (if blank), email withdrawals clear it;
 * sms grants set smsConsentAt, sms withdrawals clear it. An email "updates" or
 * "newsletter" withdrawal also unsubscribes the address from the newsletter.
 *
 * An unverified grant after a withdrawal is refused: nothing is written and
 * the result is false. Otherwise the event is written and the result is true.
 */
export async function recordConsent(db: Db, input: ConsentInput): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  if (input.action === "grant" && !input.verified) {
    const [latest] = await db
      .select({ action: consentEvents.action })
      .from(consentEvents)
      .where(
        and(
          input.personId ? eq(consentEvents.personId, input.personId) : eq(consentEvents.email, email),
          eq(consentEvents.channel, input.channel),
          // Email purposes (news, newsletter, fundraising, volunteer asks) are all
          // marketing mail: a withdrawal of any of them blocks an unverified re-grant.
          input.channel === "email" ? undefined : eq(consentEvents.purpose, input.purpose),
        ),
      )
      .orderBy(desc(consentEvents.createdAt))
      .limit(1);
    if (!grantAllowed(latest?.action, false)) return false;
  }
  await db.insert(consentEvents).values({
    personId: input.personId ?? null,
    email,
    channel: input.channel,
    purpose: input.purpose,
    action: input.action,
    basis: input.basis ?? "express",
    wording: input.wording ?? null,
    source: input.source ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  if (input.channel === "email" && (input.purpose === "updates" || input.purpose === "newsletter") && input.action === "withdraw") {
    await db
      .update(newsletterSubscribers)
      .set({ status: "unsubscribed", unsubscribedAt: new Date() })
      .where(and(eq(newsletterSubscribers.email, email), ne(newsletterSubscribers.status, "unsubscribed")));
  }
  if (!input.personId) return true;
  if (input.channel === "sms") {
    await db
      .update(people)
      .set({ smsConsentAt: input.action === "grant" ? new Date() : null, updatedAt: new Date() })
      .where(eq(people.id, input.personId));
  } else if (input.action === "withdraw") {
    await db.update(people).set({ contactConsentAt: null, updatedAt: new Date() }).where(eq(people.id, input.personId));
  } else {
    const [row] = await db.select({ at: people.contactConsentAt }).from(people).where(eq(people.id, input.personId));
    if (row && !row.at) await db.update(people).set({ contactConsentAt: new Date(), updatedAt: new Date() }).where(eq(people.id, input.personId));
  }
  return true;
}

/** The request details worth keeping as proof, read from a route handler's request. */
export function consentMeta(req: Request): { ip: string | null; userAgent: string | null } {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  const userAgent = req.headers.get("user-agent")?.slice(0, 300) || null;
  return { ip, userAgent };
}

/** The ledger for one person, newest first. */
export async function consentHistory(db: Db, personId: string, limit = 50) {
  return db.select().from(consentEvents).where(eq(consentEvents.personId, personId)).orderBy(desc(consentEvents.createdAt)).limit(limit);
}

/** The latest event for a channel and purpose, or undefined if the person never acted on it. */
export async function latestConsent(db: Db, personId: string, channel: ConsentChannel, purpose: ConsentPurpose) {
  const [row] = await db
    .select()
    .from(consentEvents)
    .where(and(eq(consentEvents.personId, personId), eq(consentEvents.channel, channel), eq(consentEvents.purpose, purpose)))
    .orderBy(desc(consentEvents.createdAt))
    .limit(1);
  return row;
}
