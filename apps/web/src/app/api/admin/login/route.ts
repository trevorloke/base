import type { NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { loginWithPassword, PENDING_COOKIE, requestMeta, SESSION_COOKIE, sessionCookieOptions } from "@/lib/server/admin-auth";
import { safeNext } from "@/lib/server/admin-redirect";
import { audit } from "@/lib/server/audit";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const next = safeNext(form.get("next"));
  const back = (query: string) => redirectTo(`/admin/login?${query}&email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`, 303);

  if (!email || !password) return back("error=invalid");
  try {
    const result = await loginWithPassword(email, password, requestMeta(req), next);
    if (!result.ok) return back(`error=${result.reason}`);
    if (result.ok === "second-step") {
      // Two-factor sign-in is on: no session yet, a code first.
      const res = redirectTo("/admin/login/verify", 303);
      res.cookies.set(PENDING_COOKIE, result.pending.value, { ...sessionCookieOptions, maxAge: result.pending.maxAge });
      return res;
    }

    const res = redirectTo(next, 303);
    res.cookies.set(SESSION_COOKIE, result.cookie.value, { ...sessionCookieOptions, maxAge: result.cookie.maxAge });
    await audit(result.user, "signin", { method: "password" });
    return res;
  } catch (err) {
    // A missing setting (e.g. ADMIN_SESSION_SECRET) or an unreachable
    // database: say so on the sign-in page instead of a bare 500.
    console.error("Staff sign-in failed", err);
    return back("error=setup");
  }
}
