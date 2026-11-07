import { and, eq } from "drizzle-orm";
import { after, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { campaignSignatures, campaigns, newsletterSubscribers } from "@/lib/db/schema";
import { neighbourhoodForPostalCode, normalizePostalCode } from "@/lib/neighbourhoods";
import { error, json, parseBody } from "@/lib/server/api";
import { creditReferral, sourceLabel, trackingFromRequest } from "@/lib/server/attribution";
import { invalidate, TAGS } from "@/lib/server/cache";
import { CONSENT_WORDING, consentMeta, recordConsent } from "@/lib/server/consent";
import { handle } from "@/lib/server/handle";
import { subscribe } from "@/lib/server/newsletter";
import { normalizePhone } from "@/lib/server/sms";
import { notifySignature } from "@/lib/server/notifications";
import { findOrCreatePerson } from "@/lib/server/people";
import { forwardSignature } from "@/lib/server/base-ground-forward";
import { signatureSchema } from "@/lib/validation";

/**
 * Sign a petition or pledge. Signing twice is harmless: the first signature
 * stands. The response carries no count: signature numbers are admin-only.
 * Email and text consent come only from the person's own ticks and are
 * written to the consent ledger with the wording they saw.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, signatureSchema, "signatures", { human: true });
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;
    const db = getDb();

    const campaign = await db.query.campaigns.findFirst({ where: and(eq(campaigns.slug, data.campaign), eq(campaigns.active, true)) });
    if (!campaign) return error("This campaign is closed.", 404);
    const slug = campaign.slug;

    const tracking = trackingFromRequest(req, data);
    const source = sourceLabel(`petition:${slug}`, tracking);
    const postalCode = normalizePostalCode(data.postalCode);
    const neighbourhood = neighbourhoodForPostalCode(postalCode);
    const { firstName, lastName, email, address, phone, answer } = data;

    const person = await findOrCreatePerson(
      db,
      email,
      { firstName, lastName, postalCode, address, phone, neighbourhood, locale: data.locale },
      { source, referredByCode: tracking.ref },
    );
    await creditReferral(db, person.id, tracking.ref);

    const [inserted] = await db
      .insert(campaignSignatures)
      .values({ campaign: slug, personId: person.id, firstName, lastName, email, postalCode, address, phone, answer, neighbourhood, source })
      .onConflictDoNothing()
      .returning({ id: campaignSignatures.id });

    const meta = consentMeta(req);
    let updatesGranted = false;
    if (data.updatesConsent) {
      const granted = await recordConsent(db, {
        personId: person.id,
        email,
        channel: "email",
        purpose: "updates",
        action: "grant",
        wording: CONSENT_WORDING.updates,
        source: `petition:${slug}`,
        ...meta,
      });
      // A refused grant (the address withdrew earlier) must not re-subscribe it either, and an
      // address that unsubscribed is only re-subscribed by its own confirmation click.
      const existing = await db.query.newsletterSubscribers.findFirst({ where: eq(newsletterSubscribers.email, email.toLowerCase()), columns: { status: true } });
      if (granted && existing?.status !== "unsubscribed") await subscribe(db, email, `petition:${slug}`, person.id);
      updatesGranted = granted;
    }
    // Texts only to a number typed into this form, never one already on file.
    if (data.smsConsent && normalizePhone(phone)) {
      await recordConsent(db, {
        personId: person.id,
        email,
        channel: "sms",
        purpose: "sms",
        action: "grant",
        wording: CONSENT_WORDING.sms,
        source: `petition:${slug}`,
        ...meta,
      });
    }

    invalidate(TAGS.counters);
    if (inserted) {
      // A new signature goes to the desk too; base ground's newsletter only on a recorded grant.
      await forwardSignature(db, {
        personId: person.id,
        campaign: { kind: campaign.kind, slug, title: campaign.title },
        firstName,
        lastName,
        email,
        phone,
        address,
        postalCode,
        newsletter: updatesGranted,
      });
      after(async () => {
        try {
          await notifySignature(db, { signatureId: inserted.id });
        } catch (err) {
          console.error("notifySignature failed", err);
        }
      });
    }

    return json({ ok: true, campaign: { slug, title: campaign.title, kind: campaign.kind, shareText: campaign.shareText } });
  });
}
