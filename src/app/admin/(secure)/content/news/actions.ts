"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { ADMIN_PATHS, LOCAL_DATETIME_RE, pacificLocalToDate, SLUG_RE, slugify } from "@/components/admin/content/fields";
import { getDb } from "@/lib/db";
import { newsPosts } from "@/lib/db/schema";
import { ActionError, adminAction, optionalText } from "@/lib/server/actions";
import { isUniqueViolation } from "@/lib/server/admin-api";
import { invalidate, TAGS } from "@/lib/server/cache";
import { fillMediaAlt } from "@/lib/server/content-admin";

const FIELDS = "Please check the highlighted fields.";
const SLUG_HELP = "Use lowercase letters, numbers and hyphens.";

const imageUrl = () => optionalText(1000).refine((v) => !v || /^(https?:\/\/|\/)/i.test(v), "Use a full address (https://…) or a path on this site (/uploads/…).");

const newsSchema = z
  .object({
    id: z.uuid().optional(),
    title: z.string().trim().min(1, "Required").max(200),
    slug: z.string().trim().toLowerCase().max(80).optional().default(""),
    summary: z.string().trim().min(1, "Required").max(400),
    body: z.string().trim().min(1, "Required").max(50_000),
    imageUrl: imageUrl(),
    imageAlt: optionalText(300),
    publish: z.enum(["now", "draft", "schedule", "keep"]),
    scheduledAt: z.string().trim().max(20).optional().default(""),
  })
  .superRefine((d, ctx) => {
    if (d.imageUrl && !d.imageAlt) ctx.addIssue({ code: "custom", path: ["imageAlt"], message: "Describe the image for people who can't see it." });
    if (d.publish === "schedule") {
      if (!LOCAL_DATETIME_RE.test(d.scheduledAt)) ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "Pick a date and time." });
      else if (pacificLocalToDate(d.scheduledAt).getTime() <= Date.now()) ctx.addIssue({ code: "custom", path: ["scheduledAt"], message: "Pick a time in the future, or use Publish now." });
    }
  });

function describe(publishedAt: Date | null): string {
  if (!publishedAt) return "Saved as a draft.";
  if (publishedAt.getTime() > Date.now()) return `Scheduled for ${publishedAt.toLocaleString("en-CA", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" })}.`;
  return "Published.";
}

/** Create or update a post. The submit button decides its status. */
export const saveNews = adminAction(
  "content",
  newsSchema,
  async (d) => {
    const db = getDb();
    const slug = d.slug || slugify(d.title);
    if (!SLUG_RE.test(slug)) throw new ActionError(FIELDS, { slug: SLUG_HELP });
    const existing = d.id ? await db.query.newsPosts.findFirst({ where: eq(newsPosts.id, d.id) }) : undefined;
    if (d.id && !existing) throw new ActionError("That post no longer exists.");

    const now = new Date();
    let publishedAt: Date | null;
    switch (d.publish) {
      case "now":
        publishedAt = existing?.publishedAt && existing.publishedAt <= now ? existing.publishedAt : now;
        break;
      case "draft":
        publishedAt = null;
        break;
      case "schedule":
        publishedAt = pacificLocalToDate(d.scheduledAt);
        break;
      default:
        publishedAt = existing?.publishedAt ?? null;
    }
    const values = { slug, title: d.title, summary: d.summary, body: d.body, imageUrl: d.imageUrl ?? null, imageAlt: d.imageUrl ? (d.imageAlt ?? null) : null, publishedAt, updatedAt: now };

    let id = existing?.id;
    try {
      if (existing) await db.update(newsPosts).set(values).where(eq(newsPosts.id, existing.id));
      else [{ id }] = await db.insert(newsPosts).values(values).returning({ id: newsPosts.id });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ActionError(FIELDS, { slug: "Another post already uses this address." });
      throw err;
    }
    await fillMediaAlt(db, values.imageUrl, values.imageAlt);
    invalidate(TAGS.news);
    return existing ? { ok: true, message: describe(publishedAt) } : { ok: true, redirect: `${ADMIN_PATHS.news}/${id}?saved=created` };
  },
  "news.save",
);

export const setNewsPublished = adminAction(
  "content",
  z.object({ id: z.uuid(), publish: z.enum(["1", "0"]) }),
  async (d) => {
    const db = getDb();
    const existing = await db.query.newsPosts.findFirst({ where: eq(newsPosts.id, d.id) });
    if (!existing) throw new ActionError("That post no longer exists.");
    const now = new Date();
    const publishedAt = d.publish === "1" ? (existing.publishedAt && existing.publishedAt <= now ? existing.publishedAt : now) : null;
    await db.update(newsPosts).set({ publishedAt, updatedAt: now }).where(eq(newsPosts.id, d.id));
    invalidate(TAGS.news);
    return d.publish === "1" ? "Published." : "Unpublished. It is now a draft.";
  },
  "news.publish",
);

export const deleteNews = adminAction(
  "content",
  z.object({ id: z.uuid() }),
  async (d) => {
    await getDb().delete(newsPosts).where(eq(newsPosts.id, d.id));
    invalidate(TAGS.news);
    return { ok: true, redirect: `${ADMIN_PATHS.news}?deleted=1` };
  },
  "news.delete",
);
