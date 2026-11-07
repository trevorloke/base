import "server-only";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { campaignSignatures, contributions, memberships, newsletterSubscribers, people, recurringDonations, shifts } from "@/lib/db/schema";
import { CAMPAIGN_SLUGS, EMPTY_STATE, type EngagementState } from "@/lib/engagement";
import type { Person } from "./people";

export type Who = string | { personId?: string | null; email?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person behind an id or an email address, or null when we don't know them. */
export async function resolvePerson(db: Db, who: Who): Promise<Person | null> {
  const id = typeof who === "string" ? (UUID.test(who) ? who : null) : (who.personId ?? null);
  const email = typeof who === "string" ? (who.includes("@") ? who : null) : (who.email ?? null);
  if (id && UUID.test(id)) {
    const row = await db.query.people.findFirst({ where: eq(people.id, id) });
    if (row) return row;
  }
  if (email) {
    const row = await db.query.people.findFirst({ where: eq(people.email, email.trim().toLowerCase()) });
    if (row) return row;
  }
  return null;
}

/**
 * Where a supporter is on the ladder, from what the database holds about
 * them. Unknown people get the empty state. Read-only.
 */
export async function engagementState(db: Db, who: Who, now = new Date()): Promise<EngagementState> {
  const person = await resolvePerson(db, who);
  if (!person) return { ...EMPTY_STATE };
  return engagementStateFor(db, person, now);
}

export async function engagementStateFor(db: Db, person: Person, now = new Date()): Promise<EngagementState> {
  const [signed, subscriber, shift, membership, recurring, monthly, referred] = await Promise.all([
    db
      .select({ campaign: campaignSignatures.campaign })
      .from(campaignSignatures)
      .where(and(eq(campaignSignatures.personId, person.id), inArray(campaignSignatures.campaign, [CAMPAIGN_SLUGS.pledge, CAMPAIGN_SLUGS.petition]))),
    db.query.newsletterSubscribers.findFirst({ columns: { status: true }, where: and(eq(newsletterSubscribers.email, person.email), eq(newsletterSubscribers.status, "subscribed")) }),
    db.query.shifts.findFirst({ columns: { id: true }, where: and(eq(shifts.personId, person.id), inArray(shifts.status, ["scheduled", "confirmed", "attended"])) }),
    db.query.memberships.findFirst({
      columns: { id: true },
      where: and(eq(memberships.personId, person.id), eq(memberships.status, "active"), or(isNull(memberships.expiresAt), gt(memberships.expiresAt, now))),
    }),
    db.query.recurringDonations.findFirst({ columns: { id: true }, where: and(eq(recurringDonations.personId, person.id), eq(recurringDonations.status, "active")) }),
    db.query.contributions.findFirst({
      columns: { id: true },
      where: and(eq(contributions.personId, person.id), eq(contributions.frequency, "monthly"), eq(contributions.status, "succeeded"), gt(contributions.paidAt, new Date(now.getTime() - 45 * 86_400_000))),
    }),
    db.select({ n: sql<number>`count(*)::int` }).from(people).where(eq(people.referredById, person.id)),
  ]);
  const campaignsSigned = new Set(signed.map((s) => s.campaign));
  return {
    signedPledge: campaignsSigned.has(CAMPAIGN_SLUGS.pledge),
    signedPetition: campaignsSigned.has(CAMPAIGN_SLUGS.petition),
    newsletterConfirmed: Boolean(subscriber),
    hasShift: Boolean(shift),
    memberActive: Boolean(membership),
    // An active subscription, or a monthly payment in the last 45 days for gifts set up before the subscription table existed.
    monthlyDonor: Boolean(recurring) || Boolean(monthly),
    hasReferred: (referred[0]?.n ?? 0) > 0,
  };
}
