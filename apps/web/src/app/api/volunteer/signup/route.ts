import { after, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { error, json, parseBody } from "@/lib/server/api";
import { creditReferral, trackingFromRequest } from "@/lib/server/attribution";
import { invalidate, TAGS } from "@/lib/server/cache";
import { CONSENT_WORDING, consentMeta, recordConsent } from "@/lib/server/consent";
import { handle } from "@/lib/server/handle";
import { notifyShiftSignup } from "@/lib/server/notifications";
import { ensureReferralCode } from "@/lib/server/people";
import { normalizePhone } from "@/lib/server/sms";
import { forwardShift } from "@/lib/server/base-ground-forward";
import { withRef } from "@/lib/share";
import { openingGoogleUrl, signUpForOpening } from "@/lib/server/volunteer";
import { volunteerSignupSchema } from "@/lib/shift-validation";
import { formatLongDate, slotLabel, todayInSurrey, type SignupConfirmation } from "@/lib/shifts";

// One tap from "I'll come" to a booked shift: the person is created or filled
// in, the shift is booked against the opening, and the confirmation carries
// calendar links. The .ics file has no personal data, so its URL can be shared.
// Emailing the volunteer about the shift they booked is transactional; the two
// optional ticks (updates, texts) go to the consent ledger. A repeat sign-up
// gets the same answer as a new one.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const parsed = await parseBody(req, volunteerSignupSchema, "volunteer-signup", { human: true });
    if (!parsed.ok) return parsed.response;
    const { openingId, name, email, phone, postalCode, updatesConsent, smsConsent } = parsed.data;
    const db = getDb();
    const tracking = trackingFromRequest(req, parsed.data);
    const result = await signUpForOpening(db, { openingId, name, email, phone, postalCode, source: tracking.source, ref: tracking.ref }, todayInSurrey());
    if (!result.ok) return error(result.message, result.status);
    await creditReferral(db, result.personId, tracking.ref);

    const meta = consentMeta(req);
    const consentSource = `volunteer:${openingId}`;
    // A public form can't undo an earlier withdrawal: recordConsent refuses, and the desk isn't told either.
    const updatesGranted = updatesConsent
      ? await recordConsent(db, { personId: result.personId, email, channel: "email", purpose: "updates", action: "grant", wording: CONSENT_WORDING.updates, source: consentSource, ...meta })
      : false;
    // Texts only to a number typed into this form, never one already on file.
    if (smsConsent && normalizePhone(phone)) {
      await recordConsent(db, { personId: result.personId, email, channel: "sms", purpose: "sms", action: "grant", wording: CONSENT_WORDING.sms, source: consentSource, ...meta });
    }

    if (result.created) {
      const shiftId = result.shiftId;
      after(async () => {
        try {
          await notifyShiftSignup(db, { shiftId });
        } catch (err) {
          console.error("shift sign-up notification failed", err);
        }
      });
      invalidate(TAGS.counters);
      // A new booking is a "Wants to volunteer" request at the desk, with the shift in the note.
      await forwardShift(db, {
        personId: result.personId,
        name,
        email,
        phone,
        postalCode,
        opening: { title: result.opening.title, date: result.opening.date, slot: result.opening.slot, location: result.opening.location },
        newsletter: updatesGranted,
      });
    }

    // Their share link credits the people they bring in.
    let referralCode: string | null = null;
    try {
      referralCode = await ensureReferralCode(db, result.personId);
    } catch (err) {
      console.error("referral code allocation failed", err);
    }

    const { opening } = result;
    const siteUrl = env.siteUrl;
    const confirmation: SignupConfirmation = {
      openingId: opening.id,
      title: opening.title,
      date: opening.date,
      dateLabel: formatLongDate(opening.date, true),
      slot: opening.slot,
      slotLabel: slotLabel(opening.slot),
      location: opening.location,
      neighbourhood: opening.neighbourhood,
      googleUrl: openingGoogleUrl(opening, siteUrl),
      icsUrl: `${siteUrl}/volunteer/openings/${opening.id}.ics`,
      shareUrl: withRef(`${siteUrl}/volunteer`, referralCode),
      spotsLeft: result.spotsLeft,
    };
    return json({ ok: true, confirmation });
  });
}
