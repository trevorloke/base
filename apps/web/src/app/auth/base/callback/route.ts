import type { NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { loginWithBase, PENDING_COOKIE, requestMeta, SESSION_COOKIE, sessionCookieOptions } from "@/lib/server/admin-auth";
import { audit } from "@/lib/server/audit";
import { finishHandOff, ssoConfig, STATE_COOKIE, STATE_COOKIE_PATH } from "@/lib/server/base-sso";

export const dynamic = "force-dynamic";

/** base ground sends the browser back here with a one-time code (SUITE.md, "The hand-off", steps 4 to 6). */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const meta = requestMeta(req);
  let config: ReturnType<typeof ssoConfig> = null;
  try {
    config = ssoConfig();
  } catch {
    config = null;
  }
  const outcome = await finishHandOff(config, { code: sp.get("code"), state: sp.get("state"), error: sp.get("error") }, req.cookies.get(STATE_COOKIE)?.value, {
    login: (email, next) => loginWithBase(email, meta, next),
    audit: (user, action, details) => audit(user, action, details),
  });

  let res;
  if (outcome.kind === "session") {
    res = redirectTo(outcome.next, 303);
    res.cookies.set(SESSION_COOKIE, outcome.cookie.value, { ...sessionCookieOptions, maxAge: outcome.cookie.maxAge });
  } else if (outcome.kind === "second-step") {
    // Owners and administrators (and anyone who turned it on) still give a code.
    res = redirectTo("/admin/login/verify", 303);
    res.cookies.set(PENDING_COOKIE, outcome.pending.value, { ...sessionCookieOptions, maxAge: outcome.pending.maxAge });
  } else {
    const email = outcome.email ? `&email=${encodeURIComponent(outcome.email)}` : "";
    res = redirectTo(`/admin/login?error=${outcome.error}${email}`, 303);
  }
  res.headers.set("cache-control", "no-store");
  // The state works once.
  res.cookies.set(STATE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: STATE_COOKIE_PATH, maxAge: 0 });
  return res;
}
