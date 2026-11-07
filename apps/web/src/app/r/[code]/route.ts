import type { NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { getDb } from "@/lib/db";
import { safeMemberNext } from "@/lib/engagement";
import { cleanRef, cleanSource, encodeTrackingCookie, trackingCookieOptions } from "@/lib/server/attribution";
import { findPersonByReferralCode } from "@/lib/server/people";

/**
 * A personal share link: /r/<code>?to=/events&source=whatsapp. A known code
 * sets the 30-day tracking cookie, so whatever the visitor does next is
 * credited to the sharer, then sends them on to `to` (a path on this site).
 * An unknown code just goes home, with no cookie.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/r/[code]">) {
  const { code } = await ctx.params;
  const to = safeMemberNext(req.nextUrl.searchParams.get("to"), "/");
  const ref = cleanRef(code);
  const person = ref ? await findPersonByReferralCode(getDb(), ref) : undefined;
  if (!person?.referralCode) return redirectTo("/", 302);
  const res = redirectTo(to, 302);
  const { name, ...options } = trackingCookieOptions();
  res.cookies.set(name, encodeTrackingCookie({ ref: person.referralCode, source: cleanSource(req.nextUrl.searchParams.get("source")) }), options);
  return res;
}
