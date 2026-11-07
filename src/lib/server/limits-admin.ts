import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { contributionLimits, adminUsers } from "@/lib/db/schema";
import { limitYearNeeded, pacificYear } from "@/lib/contributions";
import { env } from "@/lib/env";
import { formatCents } from "@/lib/money";
import type { Querier } from "./limits";

// Admin → Contribution limits: one row per Pacific calendar year. Every
// limit check uses the row for the contribution's year (limitForYear in
// limits.ts), falling back to CONTRIBUTION_LIMIT_CENTS for a year with none.

export const LIMIT_YEAR_MIN = 2020;
export const LIMIT_YEAR_MAX = 2100;
/** Far above any BC limit; only here to catch a typo of an extra digit or two. */
export const LIMIT_MAX_CENTS = 10_000_000;

export type LimitRow = { year: number; cents: number; note: string | null; updatedAt: Date; updatedBy: string | null };

/** Every stored year, newest first, with who last changed it. */
export async function listLimits(q: Querier): Promise<LimitRow[]> {
  return q
    .select({
      year: contributionLimits.year,
      cents: contributionLimits.cents,
      note: contributionLimits.note,
      updatedAt: contributionLimits.updatedAt,
      updatedBy: adminUsers.name,
    })
    .from(contributionLimits)
    .leftJoin(adminUsers, eq(adminUsers.id, contributionLimits.updatedById))
    .orderBy(desc(contributionLimits.year));
}

/** Add a year's limit or change it. Returns the figure it replaced, if any, for the audit log. */
export async function saveLimit(q: Querier, input: { year: number; cents: number; note: string | null }, userId: string | null): Promise<{ previousCents: number | null }> {
  const [before] = await q.select({ cents: contributionLimits.cents }).from(contributionLimits).where(eq(contributionLimits.year, input.year));
  await q
    .insert(contributionLimits)
    .values({ year: input.year, cents: input.cents, note: input.note, updatedById: userId })
    .onConflictDoUpdate({
      target: contributionLimits.year,
      set: { cents: input.cents, note: input.note, updatedById: userId, updatedAt: sql`now()` },
    });
  return { previousCents: before?.cents ?? null };
}

/**
 * The dashboard's "Needs attention" item for limits: from December 1
 * (Pacific) when next year has no stored limit, and whenever this year has
 * none. Null when nothing is needed. Never throws.
 */
export async function limitsAttention(db: Querier, now = new Date()): Promise<{ text: string; href: string } | null> {
  try {
    const rows = await db.select({ year: contributionLimits.year }).from(contributionLimits);
    const year = limitYearNeeded(
      now,
      rows.map((r) => r.year),
    );
    if (year === null) return null;
    const fallback = formatCents(env.contributionLimitCents);
    const text =
      year === pacificYear(now)
        ? `No ${year} contribution limit is stored, so gifts are checked against ${fallback} (CONTRIBUTION_LIMIT_CENTS). Enter the Elections BC figure.`
        : `Enter the ${year} contribution limit when Elections BC publishes it. Until then, ${year} gifts are checked against ${fallback} (CONTRIBUTION_LIMIT_CENTS).`;
    return { text, href: "/admin/limits" };
  } catch (err) {
    console.error("Could not check the contribution limits", err);
    return null;
  }
}
