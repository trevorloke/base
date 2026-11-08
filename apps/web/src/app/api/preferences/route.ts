import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { neighbourhoodForPostalCode, normalizePostalCode, OUTSIDE_SURREY } from "@/lib/neighbourhoods";
import { error, json, parseBody } from "@/lib/server/api";
import { CONSENT_WORDING, consentMeta, recordConsent } from "@/lib/server/consent";
import { handle } from "@/lib/server/handle";
import { forwardConsentWithdrawal } from "@/lib/server/base-ground-forward";
import { findPersonByEmail, updatePerson, type PersonFields } from "@/lib/server/people";
import { consumeToken, createToken } from "@/lib/server/tokens";
import { preferencesSchema } from "@/lib/validation";
import { clientProfile } from "@/seeds/client";

const TTL_MINUTES = 60;

/**
 * Save email and text preferences. The token proves control of the address
 * and is single use; the response carries a fresh one so the page can save
 * again. Every tick that changed is written to the consent ledger, and a
 * withdrawal is passed to base ground.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, preferencesSchema, "preferences");
    if (!parsed.ok) return parsed.response;
    const data = parsed.data;
    const db = getDb();

    const token = await consumeToken(db, "preferences", data.token);
    if (!token) return error("This link has expired or was already used. Ask for a new one below.", 410, { token: "Expired link" });
    const person = await findPersonByEmail(db, token.email);
    if (!person) return error(`We couldn’t find your record. Email ${clientProfile.email} and we’ll sort it out.`, 404);

    const phone = data.phone ?? person.phone ?? null;
    if (data.sms && !phone) return error("Please check the highlighted fields.", 422, { phone: "Add a mobile number so we can text you, or untick the text box" });

    const meta = consentMeta(req);
    const hadUpdates = Boolean(person.contactConsentAt);
    const hadSms = Boolean(person.smsConsentAt);
    if (data.updates !== hadUpdates) {
      await recordConsent(db, {
        personId: person.id,
        email: person.email,
        channel: "email",
        purpose: "updates",
        action: data.updates ? "grant" : "withdraw",
        wording: CONSENT_WORDING.updates,
        source: "preferences",
        verified: true,
        ...meta,
      });
      if (!data.updates) await forwardConsentWithdrawal(db, { personId: person.id, email: person.email, channel: "email", reason: "preference" });
    }
    if (data.sms !== hadSms) {
      await recordConsent(db, {
        personId: person.id,
        email: person.email,
        channel: "sms",
        purpose: "sms",
        action: data.sms ? "grant" : "withdraw",
        wording: CONSENT_WORDING.sms,
        source: "preferences",
        verified: true,
        ...meta,
      });
      if (!data.sms) await forwardConsentWithdrawal(db, { personId: person.id, email: person.email, phone: person.phone, channel: "sms", reason: "preference" });
    }

    const fields: PersonFields = {};
    if (data.locale) fields.locale = data.locale;
    if (data.phone !== undefined) fields.phone = data.phone;
    if (data.postalCode) {
      const postalCode = normalizePostalCode(data.postalCode);
      fields.postalCode = postalCode;
      fields.neighbourhood = neighbourhoodForPostalCode(postalCode) ?? OUTSIDE_SURREY;
    }
    if (Object.keys(fields).length > 0) await updatePerson(db, person.id, fields);

    const next = await createToken(db, "preferences", person.email, { ttlMinutes: TTL_MINUTES });
    return json({ ok: true, token: next });
  });
}
