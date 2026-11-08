import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { redirectTo } from "@/lib/redirect";
import { requestMeta } from "@/lib/server/admin-auth";
import { LINK_COOKIE, LINK_PAGE, linkWithEmailedToken, requestLinkEmail } from "@/lib/server/base-link";
import { respondToLink } from "../respond";

export const dynamic = "force-dynamic";

/** Ask for the one-time link, sent to the staff account's own address. */
export async function POST(req: NextRequest) {
  try {
    const result = await requestLinkEmail(getDb(), req.cookies.get(LINK_COOKIE)?.value, requestMeta(req));
    if (result === "expired") return redirectTo("/admin/login?error=base-link-expired", 303);
    return redirectTo(`${LINK_PAGE}?${result === "sent" ? "sent=1" : `error=${result}`}`, 303);
  } catch (err) {
    console.error("Sending a Base link email failed", err);
    return redirectTo(`${LINK_PAGE}?error=failed`, 303);
  }
}

/** The link in that email, opened in the browser where the hand-off is waiting. */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("token") ?? "";
  try {
    const outcome = await linkWithEmailedToken(getDb(), req.cookies.get(LINK_COOKIE)?.value, raw, requestMeta(req));
    return respondToLink(outcome, "email-link");
  } catch (err) {
    console.error("Linking a Base Ground login by email failed", err);
    return redirectTo("/admin/login?error=setup", 303);
  }
}
