"use server";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ADMIN_PATHS, dollarsToCents, HEX_COLOR_RE, SLUG_RE, slugify } from "@/components/admin/content/fields";
import { getDb } from "@/lib/db";
import { orderItems, products } from "@/lib/db/schema";
import { ActionError, adminAction, checkbox, optionalText } from "@/lib/server/actions";
import { isUniqueViolation } from "@/lib/server/admin-api";
import { invalidate, TAGS } from "@/lib/server/cache";

const FIELDS = "Please check the highlighted fields.";
const MAX_PRICE_CENTS = 1_000_000;

const productSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1, "Required").max(120),
  slug: z.string().trim().toLowerCase().max(80).optional().default(""),
  price: z.string().trim().min(1, "Required").max(20),
  description: z.string().trim().max(5000).optional().default(""),
  tileLabel: z.string().trim().min(1, "Required").max(60),
  tileBackground: z.string().trim().regex(HEX_COLOR_RE, "Pick a colour."),
  tileForeground: z.string().trim().regex(HEX_COLOR_RE, "Pick a colour."),
  imageUrl: optionalText(1000).refine((v) => !v || /^(https?:\/\/|\/)/i.test(v), "Use a full address (https://…) or a path on this site (/uploads/…)."),
  active: checkbox(),
  sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
});

export const saveProduct = adminAction(
  "content",
  productSchema,
  async (d) => {
    const db = getDb();
    const slug = d.slug || slugify(d.title);
    if (!SLUG_RE.test(slug)) throw new ActionError(FIELDS, { slug: "Use lowercase letters, numbers and hyphens." });
    const priceCents = dollarsToCents(d.price);
    if (priceCents === null) throw new ActionError(FIELDS, { price: "Enter a price in dollars, like 20 or 12.50." });
    if (priceCents > MAX_PRICE_CENTS) throw new ActionError(FIELDS, { price: "Prices are capped at $10,000." });
    const existing = d.id ? await db.query.products.findFirst({ where: eq(products.id, d.id) }) : undefined;
    if (d.id && !existing) throw new ActionError("That product no longer exists.");
    const values = {
      slug,
      name: d.title,
      description: d.description,
      priceCents,
      tileLabel: d.tileLabel,
      tileBackground: d.tileBackground.toUpperCase(),
      tileForeground: d.tileForeground.toUpperCase(),
      imageUrl: d.imageUrl ?? null,
      active: d.active,
      sortOrder: d.sortOrder,
    };
    let id = existing?.id;
    try {
      if (existing) await db.update(products).set(values).where(eq(products.id, existing.id));
      else [{ id }] = await db.insert(products).values(values).returning({ id: products.id });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ActionError(FIELDS, { slug: "Another product already uses this address." });
      throw err;
    }
    invalidate(TAGS.products);
    return existing ? { ok: true, message: "Saved." } : { ok: true, redirect: `${ADMIN_PATHS.products}/${id}?saved=created` };
  },
  "product.save",
);

export const deleteProduct = adminAction(
  "content",
  z.object({ id: z.uuid() }),
  async (d) => {
    const db = getDb();
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(orderItems).where(eq(orderItems.productId, d.id));
    if (n > 0) throw new ActionError("This product is on past orders, so it can't be deleted. Untick 'For sale' instead.");
    await db.delete(products).where(eq(products.id, d.id));
    invalidate(TAGS.products);
    return { ok: true, redirect: `${ADMIN_PATHS.products}?deleted=1` };
  },
  "product.delete",
);
