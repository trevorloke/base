import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { newsletterSubscribers } from "@/lib/db/schema";
import { json, parseBody } from "@/lib/server/api";
import { creditReferral, trackingFromRequest } from "@/lib/server/attribution";
import { consentMeta } from "@/lib/server/consent";
import { handle } from "@/lib/server/handle";
import { subscribe } from "@/lib/server/newsletter";
import { findOrCreatePerson } from "@/lib/server/people";
import { forwardNewsletter } from "@/lib/server/base-ground-forward";
import { newsletterSchema } from "@/lib/validation";

// Request: { email, source?, ref?, website (honeypot) }.
// Returns { ok: true, status } where status is:
//   "pending"      – a confirmation email is on its way (double opt-in; also
//                    for an address that unsubscribed earlier, which stays
//                    unsubscribed until that link is clicked)
//   "subscribed"   – on the list now (email not configured, or already confirmed)
//   "unsubscribed" – this address opted out earlier and email isn't
//                    configured, so nothing changed
// A referral code (body `ref`, else the tracking cookie) is credited once.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, newsletterSchema, "newsletter", { human: true });
    if (!parsed.ok) return parsed.response;
    const db = getDb();
    const tracking = trackingFromRequest(req, parsed.data);
    const person = await findOrCreatePerson(db, parsed.data.email, {}, { source: "newsletter" });
    const source = parsed.data.source ?? tracking.source ?? "website";
    const before = await db.query.newsletterSubscribers.findFirst({ where: eq(newsletterSubscribers.email, person.email), columns: { status: true } });
    const status = await subscribe(db, parsed.data.email, source, person.id, consentMeta(req));
    // Single opt-in: subscribed now, so the desk's list gets it now. (With
    // email on, that happens at the confirmation click instead.)
    if (status === "subscribed" && before?.status !== "subscribed") await forwardNewsletter(db, { personId: person.id, email: person.email, source });
    if (tracking.ref) {
      try {
        await creditReferral(db, person.id, tracking.ref);
      } catch (err) {
        console.error("referral credit failed", err);
      }
    }
    return json({ ok: true, status });
  });
}
