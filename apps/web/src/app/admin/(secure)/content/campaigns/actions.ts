"use server";

import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { ADMIN_PATHS, parseEmailList, SLUG_RE, slugify } from "@/components/admin/content/fields";
import { getDb } from "@/lib/db";
import { campaignSignatures, campaigns } from "@/lib/db/schema";
import { ActionError, adminAction, checkbox, optionalText } from "@/lib/server/actions";
import { isUniqueViolation } from "@/lib/server/admin-api";
import { invalidate, TAGS } from "@/lib/server/cache";
import { FIXED_CAMPAIGN_SLUGS } from "@/lib/server/content-admin";

const FIELDS = "Please check the highlighted fields.";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * The campaign row, locked for the rest of the transaction, so a save and a
 * delete of the same campaign can't interleave.
 */
async function lockCampaign(tx: Tx, id: string) {
  const [row] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).for("update");
  return row;
}

/** Signatures are stored against the campaign's address (its slug), not its id. */
async function signaturesFor(tx: Tx, slug: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(campaignSignatures).where(eq(campaignSignatures.campaign, slug));
  return row?.n ?? 0;
}

const campaignSchema = z.object({
  id: z.uuid().optional(),
  kind: z.enum(["petition", "pledge"]),
  title: z.string().trim().min(1, "Required").max(200),
  slug: z.string().trim().toLowerCase().max(80).optional().default(""),
  body: z.string().trim().max(10_000).optional().default(""),
  statement: z.string().trim().max(1000).optional().default(""),
  goal: z
    .string()
    .trim()
    .optional()
    .default("")
    .transform((v) => (v === "" ? null : Number(v)))
    .refine((v) => v === null || (Number.isInteger(v) && v > 0 && v <= 10_000_000), "Enter a whole number."),
  question: optionalText(200),
  shareText: z.string().trim().max(300).optional().default(""),
  targetEmails: z.string().trim().max(5000).optional().default(""),
  imageUrl: optionalText(1000).refine((v) => !v || /^(https?:\/\/|\/)/i.test(v), "Use a full address (https://…) or a path on this site (/uploads/…)."),
  active: checkbox(),
  sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
});

export const saveCampaign = adminAction(
  "content",
  campaignSchema,
  async (d) => {
    const { emails, invalid } = parseEmailList(d.targetEmails);
    if (invalid.length) throw new ActionError(FIELDS, { targetEmails: `Not an email address: ${invalid.slice(0, 3).join(", ")}` });
    const saved = await getDb().transaction(async (tx) => {
      const existing = d.id ? await lockCampaign(tx, d.id) : undefined;
      if (d.id && !existing) throw new ActionError("That campaign no longer exists.");
      // The two campaigns built into the home page keep their address; so does
      // any campaign people have signed, since the signatures are stored
      // against it and would otherwise be cut loose (and the delete guard,
      // which counts them by address, would pass).
      let slug = d.slug || slugify(d.title);
      if (existing && FIXED_CAMPAIGN_SLUGS.includes(existing.slug)) slug = existing.slug;
      else if (existing && slug !== existing.slug && (await signaturesFor(tx, existing.slug)) > 0) {
        throw new ActionError(FIELDS, { slug: "This campaign has signatures, so its address can't change. Make a new campaign for a new address." });
      }
      if (!SLUG_RE.test(slug)) throw new ActionError(FIELDS, { slug: "Use lowercase letters, numbers and hyphens." });
      const values = {
        slug,
        kind: d.kind,
        title: d.title,
        body: d.body,
        statement: d.statement,
        goal: d.goal,
        question: d.question ?? null,
        shareText: d.shareText,
        targetEmails: emails,
        imageUrl: d.imageUrl ?? null,
        active: d.active,
        sortOrder: d.sortOrder,
        updatedAt: new Date(),
      };
      if (existing) {
        await tx.update(campaigns).set(values).where(eq(campaigns.id, existing.id));
        // A signature that landed after the check above moves with the address.
        if (slug !== existing.slug) await tx.update(campaignSignatures).set({ campaign: slug }).where(eq(campaignSignatures.campaign, existing.slug));
        return { id: existing.id, created: false };
      }
      const [row] = await tx.insert(campaigns).values(values).returning({ id: campaigns.id });
      return { id: row.id, created: true };
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new ActionError(FIELDS, { slug: "Another campaign already uses this address." });
      throw err;
    });
    invalidate(TAGS.pages, TAGS.counters);
    return saved.created ? { ok: true, redirect: `${ADMIN_PATHS.campaigns}/${saved.id}?saved=created` } : { ok: true, message: "Saved." };
  },
  "campaign.save",
);

export const deleteCampaign = adminAction(
  "content",
  z.object({ id: z.uuid() }),
  async (d) => {
    await getDb().transaction(async (tx) => {
      const existing = await lockCampaign(tx, d.id);
      if (!existing) throw new ActionError("That campaign no longer exists.");
      if (FIXED_CAMPAIGN_SLUGS.includes(existing.slug)) throw new ActionError("This campaign is built into the home page and can't be deleted. Untick 'Active' instead.");
      if ((await signaturesFor(tx, existing.slug)) > 0) throw new ActionError("This campaign has signatures, so it can't be deleted. Untick 'Active' instead.");
      await tx.delete(campaigns).where(eq(campaigns.id, d.id));
    });
    invalidate(TAGS.pages, TAGS.counters);
    return { ok: true, redirect: `${ADMIN_PATHS.campaigns}?deleted=1` };
  },
  "campaign.delete",
);
