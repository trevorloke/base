import "server-only";
import { redirectTo } from "@/lib/redirect";
import { PENDING_COOKIE, SESSION_COOKIE, sessionCookieOptions } from "@/lib/server/admin-auth";
import { safeNext } from "@/lib/server/admin-redirect";
import { audit } from "@/lib/server/audit";
import { LINK_COOKIE, LINK_PAGE, linkCookieOptions, type LinkOutcome } from "@/lib/server/base-link";

/** Where a linking attempt leads: the usual second step or a session, or back with a message. */
export async function respondToLink(outcome: LinkOutcome, via: "password" | "email-link") {
  let res;
  let spent = true;
  if (outcome.ok) {
    const { result } = outcome;
    if (result.ok === "second-step") {
      res = redirectTo("/admin/login/verify", 303);
      res.cookies.set(PENDING_COOKIE, result.pending.value, { ...sessionCookieOptions, maxAge: result.pending.maxAge });
    } else {
      res = redirectTo(safeNext(outcome.next), 303);
      res.cookies.set(SESSION_COOKIE, result.cookie.value, { ...sessionCookieOptions, maxAge: result.cookie.maxAge });
      await audit(result.user, "signin", { method: "base", linkedBy: via });
    }
  } else if (outcome.reason === "expired") {
    res = redirectTo("/admin/login?error=base-link-expired", 303);
  } else if (outcome.reason === "taken") {
    res = redirectTo("/admin/login?error=base-linked-elsewhere", 303);
  } else if (outcome.reason === "other-browser") {
    // Leave whatever is waiting in this browser alone.
    res = redirectTo("/admin/login?error=base-link-other-browser", 303);
    spent = false;
  } else if (outcome.reason === "link") {
    res = redirectTo(`${LINK_PAGE}?error=link`, 303);
    spent = false;
  } else {
    // A wrong password, a lockout, no password: try again or use the email link.
    res = redirectTo(`${LINK_PAGE}?error=${outcome.reason}`, 303);
    spent = false;
  }
  if (spent) res.cookies.set(LINK_COOKIE, "", { ...linkCookieOptions, maxAge: 0 });
  res.headers.set("cache-control", "no-store");
  return res;
}
