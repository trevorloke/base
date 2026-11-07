"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { ADMIN_PATHS, SLUG_RE, slugify } from "@/components/admin/content/fields";
import { getDb } from "@/lib/db";
import { sitePages } from "@/lib/db/schema";
import { ActionError, adminAction, checkbox } from "@/lib/server/actions";
import { isUniqueViolation } from "@/lib/server/admin-api";
import { invalidate, TAGS } from "@/lib/server/cache";
import { RESERVED_PAGE_SLUGS } from "@/lib/server/content-admin";

const FIELDS = "Please check the highlighted fields.";

const pageSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1, "Required").max(200),
  slug: z.string().trim().toLowerCase().max(80).optional().default(""),
  summary: z.string().trim().max(300).optional().default(""),
  body: z.string().trim().min(1, "Required").max(100_000),
  published: checkbox(),
  showInFooter: checkbox(),
});

export const savePage = adminAction(
  "content",
  pageSchema,
  async (d) => {
    const db = getDb();
    const slug = d.slug || slugify(d.title);
    if (!SLUG_RE.test(slug)) throw new ActionError(FIELDS, { slug: "Use lowercase letters, numbers and hyphens." });
    if (RESERVED_PAGE_SLUGS.includes(slug)) throw new ActionError(FIELDS, { slug: "That address is already part of the site. Choose another." });
    const existing = d.id ? await db.query.sitePages.findFirst({ where: eq(sitePages.id, d.id) }) : undefined;
    if (d.id && !existing) throw new ActionError("That page no longer exists.");
    const values = { slug, title: d.title, summary: d.summary, body: d.body, published: d.published, showInFooter: d.showInFooter, updatedAt: new Date() };
    let id = existing?.id;
    try {
      if (existing) await db.update(sitePages).set(values).where(eq(sitePages.id, existing.id));
      else [{ id }] = await db.insert(sitePages).values(values).returning({ id: sitePages.id });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ActionError(FIELDS, { slug: "Another page already uses this address." });
      throw err;
    }
    invalidate(TAGS.pages);
    return existing ? { ok: true, message: d.published ? `Saved and published at /${slug}.` : "Saved as a draft." } : { ok: true, redirect: `${ADMIN_PATHS.pages}/${id}?saved=created` };
  },
  "page.save",
);

export const deletePage = adminAction(
  "content",
  z.object({ id: z.uuid() }),
  async (d) => {
    await getDb().delete(sitePages).where(eq(sitePages.id, d.id));
    invalidate(TAGS.pages);
    return { ok: true, redirect: `${ADMIN_PATHS.pages}?deleted=1` };
  },
  "page.delete",
);
