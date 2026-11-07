import { env } from "@/lib/env";
import { buildRss, noonInSurrey, promisePath, STATUS_BY_ID } from "@/lib/tracker";
import { latestUpdates } from "@/lib/server/tracker";

// RSS 2.0 of the newest updates across every promise. Rendered per request
// from the cached loader, so it is never more than one admin write behind.
export const dynamic = "force-dynamic";

export async function GET() {
  const siteUrl = env.siteUrl;
  const updates = await latestUpdates(50);
  const xml = buildRss({
    title: "Safe Surrey promise tracker: updates",
    link: `${siteUrl}/tracker`,
    description: "Every change to the score of a Safe Surrey Coalition promise, with the record behind it. From Imagine Surrey.",
    selfUrl: `${siteUrl}/tracker/feed.xml`,
    lastBuildDate: updates[0] ? new Date(updates[0].createdAt) : new Date(),
    items: updates.map((u) => ({
      title: `Promise ${u.promiseNumber}${u.status ? ` is now ${STATUS_BY_ID[u.status].label.toLowerCase()}` : " has a new update"}: ${u.promiseTitle}`,
      link: `${siteUrl}${promisePath(u.promiseNumber)}#update-${u.id}`,
      guid: `${siteUrl}${promisePath(u.promiseNumber)}#update-${u.id}`,
      pubDate: noonInSurrey(u.date),
      description: u.url ? `${u.note} Source: ${u.url}` : u.note,
      category: u.area,
    })),
  });
  return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
}
