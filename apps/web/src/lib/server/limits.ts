import "server-only";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { contributionLimits, contributions, recurringDonations } from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import {
  checkAnnualLimit,
  limitFromRows,
  pacificMonthBounds,
  pacificYearBounds,
  pacificYear,
  pacificYearMonth,
  remainingMonthlyPayments,
  SLATES,
  type Frequency,
  type Slate,
  type SlateAmounts,
} from "@/lib/contributions";
import { formatCents } from "@/lib/money";
import { cached, TAGS } from "./cache";

/** A database handle or a transaction: everything here works inside either. */
export type Querier = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

export class UserFacingError extends Error {
  constructor(
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const SLATE_LABEL: Record<Slate, string> = { council: "city council slate", school_board: "school board slate" };

/**
 * The only thing a public form says about the limit. It never mentions what
 * this email has given before, so nobody can probe a supporter's giving.
 */
export function overLimitMessage(slate: Slate, limitCents: number): string {
  return `That would take you over this year's ${formatCents(limitCents)} contribution limit for our ${SLATE_LABEL[slate]}. Try a smaller amount, or email hello@imaginesurrey.ca if you think this is a mistake.`;
}

// ── The limit for a year ───────────────────────────────────────────────────

/**
 * The annual contribution limit for a Pacific calendar year: the row stored
 * for that year in Admin → Contribution limits, else CONTRIBUTION_LIMIT_CENTS.
 * Every limit check asks for the year of the contribution it is checking, so
 * a new year's figure takes effect at midnight on January 1, Pacific time.
 * Reads the database directly (no cache): checks must see an edit at once.
 */
export async function limitForYear(year: number, q: Querier = getDb()): Promise<number> {
  const rows = await q.select({ year: contributionLimits.year, cents: contributionLimits.cents }).from(contributionLimits).where(eq(contributionLimits.year, year));
  return limitFromRows(rows, year, env.contributionLimitCents);
}

const cachedLimitForYear = cached("contribution-limit", [TAGS.settings], async (year: number) => limitForYear(year));

/**
 * The limit the public site shows: this Pacific year's, through the page
 * cache (an admin edit clears it). The year is worked out here, outside the
 * cache, so the figure switches at midnight on January 1 Pacific.
 */
export async function currentLimit(now = new Date()): Promise<{ year: number; cents: number }> {
  const year = pacificYear(now);
  try {
    return { year, cents: await cachedLimitForYear(year) };
  } catch (err) {
    console.error("Could not read the contribution limit; showing the configured figure", err);
    return { year, cents: env.contributionLimitCents };
  }
}

/**
 * Serialize everything that counts toward one person's limit: the checkout
 * pre-check and the webhook's enforcement both take this lock first, so two
 * simultaneous checkouts can't both pass. Released when the transaction ends.
 */
export async function lockPerson(tx: Querier, personId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${personId}::text))`);
}

export interface ContributionTotals {
  /** Accepted this calendar year, per slate, net of refunds. */
  yearToDate: SlateAmounts;
  /** What active monthly gifts will still take this year, per slate. */
  committed: SlateAmounts;
  /** The monthly amounts of active monthly gifts, per slate. */
  monthlyActive: SlateAmounts;
  monthIndex: number;
  year: number;
}

/**
 * What this person has given this year and what their active monthly gifts
 * will still take. Open (unpaid) checkouts are not counted: the webhook
 * returns anything that ends up over the limit, so a second tab can't lock a
 * donor out, and neither can a stranger typing their email.
 */
export async function contributionTotals(q: Querier, personId: string, now = new Date()): Promise<ContributionTotals> {
  const { year, monthIndex } = pacificYearMonth(now);
  const [start, end] = pacificYearBounds(year);
  const [monthStart, monthEnd] = pacificMonthBounds(year, monthIndex);

  const net = sql`${contributions.amountCents} - ${contributions.refundedCents} - ${contributions.refundPendingCents}`;
  const rows = await q
    .select({ slate: contributions.slate, cents: sql<string>`coalesce(sum(${net}), 0)` })
    .from(contributions)
    .where(
      and(
        eq(contributions.personId, personId),
        eq(contributions.status, "succeeded"),
        gte(contributions.paidAt, start),
        lt(contributions.paidAt, end),
      ),
    )
    .groupBy(contributions.slate);
  const yearToDate: SlateAmounts = {};
  for (const r of rows) yearToDate[r.slate] = Number(r.cents);

  const gifts = await q
    .select({ amounts: recurringDonations.slateAmounts, subscriptionId: recurringDonations.stripeSubscriptionId })
    .from(recurringDonations)
    .where(and(eq(recurringDonations.personId, personId), eq(recurringDonations.status, "active")));
  const committed: SlateAmounts = {};
  const monthlyActive: SlateAmounts = {};
  if (gifts.length) {
    const paidThisMonth = new Set(
      (
        await q
          .selectDistinct({ subscriptionId: contributions.stripeSubscriptionId })
          .from(contributions)
          .where(
            and(
              eq(contributions.personId, personId),
              isNotNull(contributions.stripeSubscriptionId),
              gte(contributions.paidAt, monthStart),
              lt(contributions.paidAt, monthEnd),
            ),
          )
      ).map((r) => r.subscriptionId),
    );
    for (const gift of gifts) {
      const payments = remainingMonthlyPayments(monthIndex, gift.subscriptionId !== null && paidThisMonth.has(gift.subscriptionId));
      for (const slate of SLATES) {
        const monthly = gift.amounts[slate] ?? 0;
        if (!monthly) continue;
        committed[slate] = (committed[slate] ?? 0) + monthly * payments;
        monthlyActive[slate] = (monthlyActive[slate] ?? 0) + monthly;
      }
    }
  }
  return { yearToDate, committed, monthlyActive, monthIndex, year };
}

export interface SlateRoom {
  givenCents: number;
  committedCents: number;
  remainingCents: number;
}

/**
 * How much room a supporter has left this year, per slate. For the signed-in
 * supporter's own portal and the admin; never for a public response.
 */
export async function contributionRoom(db: Querier, personId: string, now = new Date()): Promise<Record<Slate, SlateRoom>> {
  const totals = await contributionTotals(db, personId, now);
  const limit = await limitForYear(totals.year, db);
  const room = {} as Record<Slate, SlateRoom>;
  for (const slate of SLATES) {
    const givenCents = totals.yearToDate[slate] ?? 0;
    const committedCents = totals.committed[slate] ?? 0;
    room[slate] = { givenCents, committedCents, remainingCents: Math.max(0, limit - givenCents - committedCents) };
  }
  return room;
}

/**
 * Refuse a gift that would take the person over the limit for a slate. Call
 * it inside a transaction that holds lockPerson, right before inserting the
 * rows, so the check and the insert can't interleave with another checkout.
 */
export async function assertWithinLimit(q: Querier, personId: string, frequency: Frequency, slateAmounts: SlateAmounts, now = new Date()): Promise<void> {
  const { yearToDate, committed, monthlyActive, monthIndex, year } = await contributionTotals(q, personId, now);
  const limitCents = await limitForYear(year, q);
  const result = checkAnnualLimit({ frequency, slateAmounts, yearToDate, committed, monthlyActive, limitCents, monthIndex });
  if (!result.ok) throw new UserFacingError(overLimitMessage(result.slate ?? "council", limitCents));
}
