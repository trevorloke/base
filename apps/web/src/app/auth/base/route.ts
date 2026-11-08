import { NextResponse, type NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { getAdminAccount } from "@/lib/server/admin-auth";
import { safeRelativePath, ssoConfig, startHandOff, STATE_COOKIE, STATE_COOKIE_PATH, STATE_MINUTES } from "@/lib/server/base-sso";

export const dynamic = "force-dynamic";

/**
 * "Open Base Web, signed in": /auth/base?next=/admin/… sends the browser to
 * Base Ground to vouch for the person (SUITE.md, "The hand-off"). Someone
 * already signed in here goes straight to `next`.
 */
export async function GET(req: NextRequest) {
  const next = safeRelativePath(req.nextUrl.searchParams.get("next"));
  let config: ReturnType<typeof ssoConfig> = null;
  try {
    config = ssoConfig();
  } catch {
    config = null;
  }
  if (!config) return redirectTo("/admin/login?error=base-not-configured", 303);
  if (await getAdminAccount()) return redirectTo(next, 303);
  const { location, cookie } = startHandOff(config, next);
  const res = NextResponse.redirect(location, 303);
  res.headers.set("cache-control", "no-store");
  res.cookies.set(STATE_COOKIE, cookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: STATE_COOKIE_PATH, maxAge: STATE_MINUTES * 60 });
  return res;
}
