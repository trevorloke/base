import { env } from "@/lib/env";
import { error } from "@/lib/server/api";
import { eventIcs, eventPublic } from "@/lib/server/neighbourhoods";

// GET /events/<slug>/calendar.ics: the event for Apple Calendar, Outlook and friends.
export async function GET(_req: Request, ctx: RouteContext<"/events/[slug]/calendar.ics">) {
  const { slug } = await ctx.params;
  const event = await eventPublic(slug);
  if (!event) return error("We couldn't find that event.", 404);
  return new Response(eventIcs(event, env.siteUrl), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="imagine-surrey-${event.slug}.ics"`,
      "cache-control": "public, max-age=300",
    },
  });
}
