"use server";

import { z } from "zod";
import { brandSchema, contrastPairs } from "@/lib/brand";
import { getDb } from "@/lib/db";
import { ActionError, adminAction, checkbox } from "@/lib/server/actions";
import { audit } from "@/lib/server/audit";
import { saveBrand } from "@/lib/server/brand";
import { fieldErrors } from "@/lib/validation";

/**
 * Save the brand. Any text-and-background pair under 4.5:1 must be
 * confirmed ("Save anyway"), here as well as in the form. Audited with the
 * whole brand and the pairs that were confirmed.
 */
export const saveBrandAction = adminAction("settings", z.object({ brand: z.string().max(20_000), confirmLowContrast: checkbox() }), async (d, { user }) => {
  let raw: unknown;
  try {
    raw = JSON.parse(d.brand);
  } catch {
    throw new ActionError("The form data could not be read. Reload the page and try again.");
  }
  const parsed = brandSchema.safeParse(raw);
  if (!parsed.success) throw new ActionError("Please check the highlighted fields.", fieldErrors(parsed.error));
  const brand = parsed.data;
  const low = contrastPairs(brand).filter((p) => !p.ok);
  if (low.length > 0 && !d.confirmLowContrast) {
    throw new ActionError(
      `${low.length === 1 ? "One pair is" : `${low.length} pairs are`} under 4.5:1 (${low.map((p) => `${p.label}: ${p.ratio.toFixed(2)}:1`).join("; ")}). Change the colours, or tick “Save anyway” to keep them.`,
      { confirmLowContrast: "Confirm to save colours under 4.5:1." },
    );
  }
  await saveBrand(getDb(), brand, user.id);
  await audit(user, "brand.save", { ...brand, lowContrast: low.map((p) => ({ pair: p.id, ratio: p.ratio })) }, "brand", "site");
  return "Saved. Every public page now uses this look.";
});
