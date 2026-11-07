import type { NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { PENDING_COOKIE, requestMeta, SESSION_COOKIE, sessionCookieOptions } from "@/lib/server/admin-auth";
import { safeNext } from "@/lib/server/admin-redirect";
import { audit } from "@/lib/server/audit";
import { verifySecondStep } from "@/lib/server/mfa";

/** The second sign-in step: a code from the authenticator app, or a recovery code. */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const code = String(form.get("code") ?? "").slice(0, 40);
  const pending = req.cookies.get(PENDING_COOKIE)?.value ?? "";
  const toLogin = (error: string) => {
    const res = redirectTo(`/admin/login?error=${error}`, 303);
    res.cookies.delete(PENDING_COOKIE);
    return res;
  };
  if (!pending) return toLogin("expired");
  try {
    const result = await verifySecondStep(pending, code, requestMeta(req));
    if (!result.ok) {
      if (result.reason !== "invalid" || !result.pending) return toLogin(result.reason);
      const res = redirectTo("/admin/login/verify?error=code", 303);
      res.cookies.set(PENDING_COOKIE, result.pending.value, { ...sessionCookieOptions, maxAge: result.pending.maxAge });
      return res;
    }
    const res = redirectTo(safeNext(result.next), 303);
    res.cookies.delete(PENDING_COOKIE);
    res.cookies.set(SESSION_COOKIE, result.cookie.value, { ...sessionCookieOptions, maxAge: result.cookie.maxAge });
    await audit(result.user, "signin", { method: result.method });
    return res;
  } catch (err) {
    console.error("Staff sign-in (second step) failed", err);
    return toLogin("setup");
  }
}
