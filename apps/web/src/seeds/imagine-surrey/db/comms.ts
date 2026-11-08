// A sample draft campaign so the composer has an example of merge fields
// and Markdown to start from. Safe to re-run: it is added only when there
// are no campaigns at all.
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { emailCampaigns } from "../../../lib/db/schema";

export const sampleCampaign = {
  subject: "What's happening in your neighbourhood this month",
  preheader: "Events near you, the promise tracker, and a quick way to bring a friend along.",
  body: `Hi {{first_name}},

Here's what Imagine Surrey members and neighbours are up to this month.

## Near you

Town hall meetings are coming to every town centre. Check the events page for dates: {{site_url}}/events

## The promise tracker

We score every campaign promise against the public record. See what's kept, partly kept or broken: {{site_url}}/tracker

## Bring a neighbour

Most people join because someone they know asked. Your personal link credits you when a friend signs up: {{referral_link}}

Thanks for being part of this.

*The Imagine Surrey team*`,
  audience: { lists: ["newsletter"] },
};

export async function seed<T extends Record<string, unknown>>(db: PostgresJsDatabase<T>): Promise<void> {
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from email_campaigns`)) as unknown as { n: number }[];
  if (n > 0) return;
  await db.insert(emailCampaigns).values({ ...sampleCampaign, status: "draft" });
}
