import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { campaigns, events, newsPosts, sitePages } from "@/lib/db/schema";
import { env } from "@/lib/env";

const STATIC_ROUTES = ["/", "/tracker", "/volunteer", "/events", "/act", "/donate", "/news", "/accessibility", "/privacy"];

/**
 * Every public page: the fixed sections, published news, upcoming events,
 * active petitions and pledges, and published content pages. Read live so a
 * new post is listed as soon as it is published.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const base = env.siteUrl;
  const entries: MetadataRoute.Sitemap = STATIC_ROUTES.map((path) => ({
    url: base + path,
    changeFrequency: path === "/" || path === "/tracker" ? "daily" : "weekly",
    priority: path === "/" ? 1 : 0.7,
  }));

  try {
    const db = getDb();
    const now = new Date();
    const [news, upcoming, active, pages] = await Promise.all([
      db
        .select({ slug: newsPosts.slug, updatedAt: newsPosts.updatedAt })
        .from(newsPosts)
        .where(and(isNotNull(newsPosts.publishedAt), lte(newsPosts.publishedAt, now))),
      db
        .select({ slug: events.slug, updatedAt: events.updatedAt })
        .from(events)
        .where(and(eq(events.published, true), gte(events.startsAt, new Date(now.getTime() - 6 * 3600_000)))),
      db.select({ slug: campaigns.slug, updatedAt: campaigns.updatedAt }).from(campaigns).where(eq(campaigns.active, true)),
      db.select({ slug: sitePages.slug, updatedAt: sitePages.updatedAt }).from(sitePages).where(eq(sitePages.published, true)),
    ]);
    entries.push(
      ...news.map((n) => ({ url: `${base}/news/${n.slug}`, lastModified: n.updatedAt, changeFrequency: "monthly" as const, priority: 0.6 })),
      ...upcoming.map((e) => ({ url: `${base}/events/${e.slug}`, lastModified: e.updatedAt, changeFrequency: "weekly" as const, priority: 0.6 })),
      ...active.map((c) => ({ url: `${base}/act/${c.slug}`, lastModified: c.updatedAt, changeFrequency: "weekly" as const, priority: 0.7 })),
      ...pages.map((p) => ({ url: `${base}/${p.slug}`, lastModified: p.updatedAt, changeFrequency: "monthly" as const, priority: 0.4 })),
    );
  } catch (err) {
    // The fixed routes are still worth serving if the database is unreachable.
    console.error("sitemap: could not read the database", err);
  }

  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}
