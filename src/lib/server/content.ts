import "server-only";
import { and, asc, desc, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { campaignSignatures, campaigns, events, newsPosts, products, sitePages } from "@/lib/db/schema";
import { cached, TAGS } from "./cache";

// Public loaders. Each one is cached for an hour and thrown away when an
// admin changes the data (see the content actions, which call invalidate()).
// Cached results are stored as JSON, so timestamps come back as strings on a
// cache hit; every loader revives them so callers always get Date objects.

function withDates<T extends object>(row: T, keys: readonly (keyof T)[]): T {
  const out = { ...row } as Record<keyof T, unknown>;
  for (const key of keys) if (typeof out[key] === "string") out[key] = new Date(out[key] as string);
  return out as T;
}

const NEWS_DATES = ["publishedAt", "updatedAt", "createdAt"] as const;
const EVENT_DATES = ["startsAt", "endsAt", "updatedAt", "createdAt"] as const;
const CAMPAIGN_DATES = ["updatedAt", "createdAt"] as const;
const PAGE_DATES = ["updatedAt", "createdAt"] as const;

// ── News ──────────────────────────────────────────────────────────────────

const cachedLatestNews = cached("news-latest", [TAGS.news], async (limit: number) =>
  getDb()
    .select()
    .from(newsPosts)
    .where(and(isNotNull(newsPosts.publishedAt), lte(newsPosts.publishedAt, new Date())))
    .orderBy(desc(newsPosts.publishedAt))
    .limit(limit),
);

export async function latestNews(limit = 3) {
  return (await cachedLatestNews(limit)).map((p) => withDates(p, NEWS_DATES));
}

const cachedNewsBySlug = cached("news-by-slug", [TAGS.news], async (slug: string) => {
  const post = await getDb().query.newsPosts.findFirst({
    where: and(eq(newsPosts.slug, slug), isNotNull(newsPosts.publishedAt), lte(newsPosts.publishedAt, new Date())),
  });
  return post ?? null;
});

export async function newsBySlug(slug: string) {
  const post = await cachedNewsBySlug(slug);
  return post ? withDates(post, NEWS_DATES) : undefined;
}

// ── Events ────────────────────────────────────────────────────────────────

const cachedUpcomingEvents = cached("events-upcoming", [TAGS.events], async (limit: number) => {
  // Keep today's events listed until the end of the day.
  const since = new Date(Date.now() - 6 * 3600_000);
  return getDb()
    .select()
    .from(events)
    .where(and(eq(events.published, true), gte(events.startsAt, since)))
    .orderBy(asc(events.startsAt))
    .limit(limit);
});

export async function upcomingEvents(limit = 20) {
  return (await cachedUpcomingEvents(limit)).map((e) => withDates(e, EVENT_DATES));
}

const cachedEventBySlug = cached("event-by-slug", [TAGS.events], async (slug: string) => {
  const event = await getDb().query.events.findFirst({ where: and(eq(events.slug, slug), eq(events.published, true)) });
  return event ?? null;
});

export async function eventBySlug(slug: string) {
  const event = await cachedEventBySlug(slug);
  return event ? withDates(event, EVENT_DATES) : undefined;
}

// ── Shop ──────────────────────────────────────────────────────────────────

const cachedActiveProducts = cached("products-active", [TAGS.products], async () =>
  getDb().select().from(products).where(eq(products.active, true)).orderBy(asc(products.sortOrder), asc(products.name)),
);

export async function activeProducts() {
  return cachedActiveProducts();
}

// ── Pages ─────────────────────────────────────────────────────────────────

const cachedPublishedPages = cached("pages-published", [TAGS.pages], async () =>
  getDb()
    .select({ id: sitePages.id, slug: sitePages.slug, title: sitePages.title, summary: sitePages.summary, showInFooter: sitePages.showInFooter, updatedAt: sitePages.updatedAt, createdAt: sitePages.createdAt })
    .from(sitePages)
    .where(eq(sitePages.published, true))
    .orderBy(asc(sitePages.title)),
);

/** Every published page, without bodies, for sitemaps and link lists. */
export async function publishedPages() {
  return (await cachedPublishedPages()).map((p) => withDates(p, PAGE_DATES));
}

/** Published pages that asked to be listed in the footer. */
export async function footerPages() {
  return (await publishedPages()).filter((p) => p.showInFooter);
}

const cachedPageBySlug = cached("page-by-slug", [TAGS.pages], async (slug: string) => {
  const page = await getDb().query.sitePages.findFirst({ where: and(eq(sitePages.slug, slug), eq(sitePages.published, true)) });
  return page ?? null;
});

export async function pageBySlug(slug: string) {
  const page = await cachedPageBySlug(slug);
  return page ? withDates(page, PAGE_DATES) : undefined;
}

// ── Petitions and pledges ─────────────────────────────────────────────────

const cachedActiveCampaigns = cached("campaigns-active", [TAGS.pages], async () =>
  getDb().select().from(campaigns).where(eq(campaigns.active, true)).orderBy(asc(campaigns.sortOrder), asc(campaigns.createdAt)),
);

export async function activeCampaigns() {
  return (await cachedActiveCampaigns()).map((c) => withDates(c, CAMPAIGN_DATES));
}

const cachedCampaignBySlug = cached("campaign-by-slug", [TAGS.pages], async (slug: string) => {
  const campaign = await getDb().query.campaigns.findFirst({ where: and(eq(campaigns.slug, slug), eq(campaigns.active, true)) });
  return campaign ?? null;
});

/** An active campaign by slug; inactive ones are not served publicly. */
export async function campaignBySlug(slug: string) {
  const campaign = await cachedCampaignBySlug(slug);
  return campaign ? withDates(campaign, CAMPAIGN_DATES) : undefined;
}

export type SignatureCounts = Record<string, { total: number; byNeighbourhood: Record<string, number> }>;

/** Signatures per campaign slug: the total and a breakdown by town centre ("" for unknown). */
export const signatureCounts = cached("signature-counts", [TAGS.counters], async (): Promise<SignatureCounts> => {
  const rows = await getDb()
    .select({ campaign: campaignSignatures.campaign, neighbourhood: campaignSignatures.neighbourhood, n: sql<number>`count(*)::int` })
    .from(campaignSignatures)
    .groupBy(campaignSignatures.campaign, campaignSignatures.neighbourhood);
  const out: SignatureCounts = {};
  for (const r of rows) {
    const entry = (out[r.campaign] ??= { total: 0, byNeighbourhood: {} });
    entry.total += r.n;
    const key = r.neighbourhood ?? "";
    entry.byNeighbourhood[key] = (entry.byNeighbourhood[key] ?? 0) + r.n;
  }
  return out;
});
