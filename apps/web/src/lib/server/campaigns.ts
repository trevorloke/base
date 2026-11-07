import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { campaigns } from "@/lib/db/schema";
import { cached, TAGS } from "./cache";

// Petitions and pledges come from the `campaigns` table, so organizers launch
// a new one from the admin. Content is cached with the pages tag (an hour, or
// until the admin saves). Signature counts are not published: they are in the
// admin only (Content → Campaigns, the dashboard and the signatures export).

export type Campaign = typeof campaigns.$inferSelect;

export const listActiveCampaigns = cached("campaigns-active", [TAGS.pages], async (): Promise<Campaign[]> => {
  return getDb().select().from(campaigns).where(eq(campaigns.active, true)).orderBy(asc(campaigns.sortOrder), asc(campaigns.title));
});

/** An active campaign by slug, or null (inactive campaigns are closed to the public). */
export const getCampaign = cached("campaign", [TAGS.pages], async (slug: string): Promise<Campaign | null> => {
  const row = await getDb().query.campaigns.findFirst({ where: and(eq(campaigns.slug, slug), eq(campaigns.active, true)) });
  return row ?? null;
});
