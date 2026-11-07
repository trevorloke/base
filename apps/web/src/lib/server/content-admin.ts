import "server-only";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { adminUsers, campaignSignatures, campaigns, emailLog, eventRsvps, events, media, newsPosts, orderItems, products, sitePages, siteSettings, stripeEvents } from "@/lib/db/schema";
import { CAMPAIGNS } from "@/lib/validation";

// Queries for the admin content pages. Admin pages render per request, so
// nothing here is cached; the public loaders live in content.ts.

/** The two campaigns the home page is built around; their slugs can't change. */
export const FIXED_CAMPAIGN_SLUGS: readonly string[] = Object.keys(CAMPAIGNS);

/** Top-level paths that already exist as routes, so a page can't take them. */
export const RESERVED_PAGE_SLUGS: readonly string[] = ["admin", "api", "news", "events", "shop", "donate", "tracker", "join", "newsletter", "act", "images", "uploads", "fonts", "_next", "login", "account", "volunteer"];

const count = sql<number>`count(*)::int`;

// ── News ──────────────────────────────────────────────────────────────────

export async function listNews(db: Db) {
  return db.select().from(newsPosts).orderBy(desc(sql`coalesce(${newsPosts.publishedAt}, ${newsPosts.createdAt})`)).limit(300);
}

export async function loadNews(db: Db, id: string) {
  return db.query.newsPosts.findFirst({ where: eq(newsPosts.id, id) });
}

// ── Events ────────────────────────────────────────────────────────────────

export async function listEvents(db: Db) {
  const rows = await db
    .select({ event: events, rsvps: sql<number>`count(${eventRsvps.id})::int`, guests: sql<number>`coalesce(sum(${eventRsvps.guests}), 0)::int` })
    .from(events)
    .leftJoin(eventRsvps, eq(eventRsvps.eventId, events.id))
    .groupBy(events.id)
    .orderBy(desc(events.startsAt))
    .limit(300);
  return rows.map((r) => ({ ...r.event, rsvps: r.rsvps, guests: r.guests }));
}

export async function loadEvent(db: Db, id: string) {
  const event = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!event) return undefined;
  const rsvps = await db.select().from(eventRsvps).where(eq(eventRsvps.eventId, id)).orderBy(asc(eventRsvps.name));
  const counts = {
    rsvps: rsvps.length,
    guests: rsvps.reduce((n, r) => n + r.guests, 0),
    checkedIn: rsvps.filter((r) => r.checkedInAt).length,
  };
  return { event, rsvps, counts };
}

export async function rsvpCount(db: Db, eventId: string): Promise<number> {
  const [row] = await db.select({ n: count }).from(eventRsvps).where(eq(eventRsvps.eventId, eventId));
  return row?.n ?? 0;
}

// ── Shop ──────────────────────────────────────────────────────────────────

export async function listProducts(db: Db) {
  const rows = await db
    .select({ product: products, orders: sql<number>`count(${orderItems.id})::int` })
    .from(products)
    .leftJoin(orderItems, eq(orderItems.productId, products.id))
    .groupBy(products.id)
    .orderBy(asc(products.sortOrder), asc(products.name));
  return rows.map((r) => ({ ...r.product, orders: r.orders }));
}

export async function loadProduct(db: Db, id: string) {
  const product = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!product) return undefined;
  const [row] = await db.select({ n: count }).from(orderItems).where(eq(orderItems.productId, id));
  return { product, orders: row?.n ?? 0 };
}

// ── Campaigns ─────────────────────────────────────────────────────────────

export async function listCampaigns(db: Db) {
  const rows = await db
    .select({ campaign: campaigns, signatures: sql<number>`count(${campaignSignatures.id})::int` })
    .from(campaigns)
    .leftJoin(campaignSignatures, eq(campaignSignatures.campaign, campaigns.slug))
    .groupBy(campaigns.id)
    .orderBy(asc(campaigns.sortOrder), asc(campaigns.createdAt));
  return rows.map((r) => ({ ...r.campaign, signatures: r.signatures }));
}

export async function loadCampaign(db: Db, id: string) {
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!campaign) return undefined;
  return { campaign, signatures: await signatureCount(db, campaign.slug) };
}

export async function signatureCount(db: Db, slug: string): Promise<number> {
  const [row] = await db.select({ n: count }).from(campaignSignatures).where(eq(campaignSignatures.campaign, slug));
  return row?.n ?? 0;
}

// ── Pages ─────────────────────────────────────────────────────────────────

export async function listPages(db: Db) {
  return db.select().from(sitePages).orderBy(asc(sitePages.title));
}

export async function loadPage(db: Db, id: string) {
  return db.query.sitePages.findFirst({ where: eq(sitePages.id, id) });
}

// ── Media ─────────────────────────────────────────────────────────────────

/** The media library, newest first. `imagesOnly` leaves out PDFs and anything else that can't be shown as a picture. */
export async function listMedia(db: Db, options: { q?: string; limit?: number; imagesOnly?: boolean } = {}) {
  const q = options.q?.trim();
  const search = q ? sql`(${media.filename} ilike ${"%" + q + "%"} or ${media.alt} ilike ${"%" + q + "%"})` : undefined;
  const images = options.imagesOnly ? sql`${media.mime} like 'image/%'` : undefined;
  const rows = await db
    .select({ media, uploadedBy: adminUsers.name })
    .from(media)
    .leftJoin(adminUsers, eq(adminUsers.id, media.uploadedById))
    .where(and(search, images))
    .orderBy(desc(media.createdAt))
    .limit(options.limit ?? 200);
  return rows.map((r) => ({ ...r.media, uploadedBy: r.uploadedBy }));
}

/** A post's alt text is usually typed after the upload: copy it onto the library row when that is still blank. */
export async function fillMediaAlt(db: Db, url: string | null | undefined, alt: string | null | undefined): Promise<void> {
  if (!url || !alt) return;
  await db
    .update(media)
    .set({ alt })
    .where(and(eq(media.url, url), eq(media.alt, "")));
}

// ── Site settings ─────────────────────────────────────────────────────────

export async function settingsOverrides(db: Db) {
  const rows = await db
    .select({ key: siteSettings.key, updatedAt: siteSettings.updatedAt, updatedBy: adminUsers.name })
    .from(siteSettings)
    .leftJoin(adminUsers, eq(adminUsers.id, siteSettings.updatedById));
  return new Map(rows.map((r) => [r.key, { updatedAt: r.updatedAt, updatedBy: r.updatedBy }]));
}

export async function settingsOverride(db: Db, key: string) {
  const [row] = await db
    .select({ value: siteSettings.value, updatedAt: siteSettings.updatedAt, updatedBy: adminUsers.name })
    .from(siteSettings)
    .leftJoin(adminUsers, eq(adminUsers.id, siteSettings.updatedById))
    .where(eq(siteSettings.key, key));
  return row;
}

// ── Hub and integrations ──────────────────────────────────────────────────

export async function contentCounts(db: Db) {
  const [row] = await db.execute<Record<string, number>>(sql`
    select
      (select count(*) from news_posts where published_at is not null and published_at <= now())::int as news_published,
      (select count(*) from news_posts where published_at is null or published_at > now())::int as news_unpublished,
      (select count(*) from events where published and starts_at >= now() - interval '6 hours')::int as events_upcoming,
      (select count(*) from products where active)::int as products_active,
      (select count(*) from campaigns where active)::int as campaigns_active,
      (select count(*) from site_pages where published)::int as pages_published,
      (select count(*) from site_pages where not published)::int as pages_draft,
      (select count(*) from media)::int as media
  `);
  return row;
}

export async function integrationStats(db: Db) {
  // Bound as text with a cast: raw sql fragments can't bind a Date directly.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [stripe] = await db.select({ last: sql<Date | null>`max(${stripeEvents.processedAt})`, total: count }).from(stripeEvents);
  const [email] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${emailLog.status} = 'sent' and ${emailLog.createdAt} >= ${since}::timestamptz)::int`,
      failed: sql<number>`count(*) filter (where ${emailLog.status} in ('failed', 'skipped') and ${emailLog.createdAt} >= ${since}::timestamptz)::int`,
      queued: sql<number>`count(*) filter (where ${emailLog.status} = 'queued')::int`,
      oldestQueued: sql<Date | null>`min(${emailLog.createdAt}) filter (where ${emailLog.status} = 'queued')`,
      // Queued mail is only ever sent by the cron job, so its newest send time shows the job ran.
      lastCron: sql<Date | null>`max(${emailLog.sentAt}) filter (where ${emailLog.campaignId} is not null or ${emailLog.attempts} > 1)`,
    })
    .from(emailLog);
  let database: { ok: boolean; migrations: number | null; error?: string };
  try {
    const [m] = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    database = { ok: true, migrations: m?.n ?? null };
  } catch (err) {
    database = { ok: false, migrations: null, error: err instanceof Error ? err.message : String(err) };
  }
  const toDate = (v: Date | string | null) => (v ? (v instanceof Date ? v : new Date(v)) : null);
  return {
    stripe: { lastEventAt: toDate(stripe?.last ?? null), total: stripe?.total ?? 0 },
    email: { sent7d: email?.sent ?? 0, failed7d: email?.failed ?? 0, queued: email?.queued ?? 0, oldestQueuedAt: toDate(email?.oldestQueued ?? null), lastCronAt: toDate(email?.lastCron ?? null) },
    database,
  };
}

/** Published events coming up, for the hub's quick list. */
export async function nextEvents(db: Db, limit = 5) {
  return db
    .select({ id: events.id, title: events.title, startsAt: events.startsAt })
    .from(events)
    .where(and(eq(events.published, true), gte(events.startsAt, new Date())))
    .orderBy(asc(events.startsAt))
    .limit(limit);
}

