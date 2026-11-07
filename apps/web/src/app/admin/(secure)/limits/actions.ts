"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseDollars } from "@/components/forms/amount";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { ActionError, adminAction, optionalText } from "@/lib/server/actions";
import { audit } from "@/lib/server/audit";
import { invalidate, TAGS } from "@/lib/server/cache";
import { LIMIT_MAX_CENTS, LIMIT_YEAR_MAX, LIMIT_YEAR_MIN, saveLimit } from "@/lib/server/limits-admin";

const limitSchema = z.object({
  year: z.coerce
    .number({ error: "Enter a year" })
    .int("Enter a year")
    .min(LIMIT_YEAR_MIN, `Enter a year from ${LIMIT_YEAR_MIN}`)
    .max(LIMIT_YEAR_MAX, `Enter a year up to ${LIMIT_YEAR_MAX}`),
  amount: z.string().trim().min(1, "Enter the limit in dollars, like 1,429.70").max(20),
  note: optionalText(500),
});

/**
 * Add a year's contribution limit or change one. The note records where the
 * figure came from (the Elections BC notice). Audited with the old figure.
 */
export const saveLimitAction = adminAction("money", limitSchema, async ({ year, amount, note }, { user }) => {
  const { cents, error } = parseDollars(amount);
  if (error || cents === null) throw new ActionError("Please check the highlighted fields.", { amount: error ?? "Enter the limit in dollars, like 1,429.70" });
  if (cents <= 0 || cents > LIMIT_MAX_CENTS) throw new ActionError("Please check the highlighted fields.", { amount: `Enter an amount between $0.01 and ${formatCents(LIMIT_MAX_CENTS)}` });
  const { previousCents } = await saveLimit(getDb(), { year, cents, note: note ?? null }, user.id);
  await audit(user, "limits.save", { year, cents, previousCents, note: note ?? null }, "contribution_limit", String(year));
  // The donate page, forms and portal show this year's figure.
  invalidate(TAGS.settings);
  revalidatePath("/admin/limits");
  return previousCents === null
    ? `Saved the ${year} limit: ${formatCents(cents)}.`
    : previousCents === cents
      ? `Saved the ${year} note. The limit stays ${formatCents(cents)}.`
      : `Changed the ${year} limit from ${formatCents(previousCents)} to ${formatCents(cents)}.`;
});
