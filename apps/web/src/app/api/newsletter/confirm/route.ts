import type { NextRequest } from "next/server";
import { redirectTo } from "@/lib/redirect";
import { getDb } from "@/lib/db";
import { consentMeta } from "@/lib/server/consent";
import { confirmSubscriptionDetails, type ConfirmResult } from "@/lib/server/newsletter";
import { forwardNewsletter } from "@/lib/server/base-ground-forward";

// The link in the double opt-in email. One click subscribes the address and
// records contact consent; a used or expired link explains itself, and an
// address that unsubscribed in the meantime stays unsubscribed. A newly
// confirmed address is forwarded to the desk's list too.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  let result: ConfirmResult = "invalid";
  try {
    if (token) {
      const db = getDb();
      const confirmed = await confirmSubscriptionDetails(db, token, consentMeta(req));
      result = confirmed.result;
      if (confirmed.result === "subscribed" && confirmed.newlySubscribed && confirmed.email) {
        await forwardNewsletter(db, { personId: confirmed.personId ?? null, email: confirmed.email, source: confirmed.source });
      }
    }
  } catch (err) {
    console.error("newsletter confirmation failed", err);
  }
  const target = result === "subscribed" ? "/newsletter/confirmed" : result === "unsubscribed" ? "/newsletter/confirmed?unsubscribed=1" : "/newsletter/confirmed?invalid=1";
  return redirectTo(target, 303);
}
