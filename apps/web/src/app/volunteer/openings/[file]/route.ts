import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { error } from "@/lib/server/api";
import { findOpening, openingIcs } from "@/lib/server/volunteer";
import { idParam } from "@/lib/shift-validation";

// GET /volunteer/openings/<id>.ics: a calendar file for the opening's slot.
// It carries the opening only, never who signed up, so the link is safe to share.
export async function GET(_req: Request, ctx: RouteContext<"/volunteer/openings/[file]">) {
  const { file } = await ctx.params;
  const id = idParam.safeParse(file.endsWith(".ics") ? file.slice(0, -4) : "");
  if (!id.success) return error("Not found.", 404);
  const opening = await findOpening(getDb(), id.data);
  if (!opening) return error("That opening no longer exists.", 404);
  return new Response(openingIcs(opening, env.siteUrl), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="imagine-surrey-volunteer-${opening.date}-${opening.slot}.ics"`,
      "cache-control": "public, max-age=300",
    },
  });
}
