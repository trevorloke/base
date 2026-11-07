"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { CONSENT_WORDING } from "@/lib/consent-wording";
import { LOCALE_IDS } from "@/lib/engagement";
import { neighbourhoodForPostalCode, normalizePostalCode, OUTSIDE_SURREY, POSTAL_CODE_RE } from "@/lib/neighbourhoods";
import { ActionError, checkbox, optionalText, type ActionState } from "@/lib/server/actions";
import { recordConsent } from "@/lib/server/consent";
import { updatePerson } from "@/lib/server/people";
import { memberAction } from "@/lib/server/portal";
import { forwardConsentWithdrawal, forwardPortalEdit } from "@/lib/server/starbase-forward";

const schema = z.object({
  firstName: optionalText(80),
  lastName: optionalText(80),
  phone: optionalText(30),
  address: optionalText(200),
  postalCode: optionalText(10).refine((v) => !v || POSTAL_CODE_RE.test(v), "Enter a postal code like A1A 1A1"),
  locale: z.enum(LOCALE_IDS),
  updates: checkbox(),
  sms: checkbox(),
});

/**
 * Save the supporter's own details. A changed tick box is a consent event:
 * the ledger gets the exact wording shown, and the person's current-state
 * columns follow from it (recordConsent does both). A signed-in member has
 * proved control of the address, so the grant is verified. A withdrawal goes
 * to Starbase, and so does a changed name, phone, street address or postal
 * code (Starbase fills blanks only). The action gives the submitted values
 * back and the form shows them after React resets it.
 */
const save = memberAction("/me/preferences", schema, async (data, { person, meta }) => {
  const db = getDb();
  const phone = data.phone ?? null;
  if (data.sms && !phone) throw new ActionError("Add a phone number so we can text you.", { phone: "Needed for texts" });

  const postalCode = data.postalCode ? normalizePostalCode(data.postalCode) : null;
  const neighbourhood = postalCode ? (neighbourhoodForPostalCode(postalCode) ?? OUTSIDE_SURREY) : undefined;

  const common = { personId: person.id, email: person.email, source: "preferences", ip: meta.ip, userAgent: meta.userAgent, verified: true } as const;
  if (data.updates !== Boolean(person.contactConsentAt)) {
    await recordConsent(db, { ...common, channel: "email", purpose: "updates", action: data.updates ? "grant" : "withdraw", wording: CONSENT_WORDING.updates });
    if (!data.updates) await forwardConsentWithdrawal(db, { personId: person.id, email: person.email, channel: "email", reason: "preference" });
  }
  if (data.sms !== Boolean(person.smsConsentAt)) {
    await recordConsent(db, { ...common, channel: "sms", purpose: "sms", action: data.sms ? "grant" : "withdraw", wording: CONSENT_WORDING.sms });
    if (!data.sms) await forwardConsentWithdrawal(db, { personId: person.id, email: person.email, phone: person.phone, channel: "sms", reason: "preference" });
  }
  const details = { firstName: data.firstName ?? null, lastName: data.lastName ?? null, phone, address: data.address ?? null, postalCode };
  await updatePerson(db, person.id, {
    ...details,
    ...(neighbourhood !== undefined ? { neighbourhood } : {}),
    locale: data.locale,
  });
  if (portalDetailsChanged(person, details)) await forwardPortalEdit(db, { id: person.id, email: person.email, ...details });
  // Re-render the page with the saved record, so nothing on it is stale.
  refresh();
  return neighbourhood ? `Saved. Your town centre: ${neighbourhood}.` : "Saved.";
});

type Details = { firstName: string | null; lastName: string | null; phone: string | null; address: string | null; postalCode: string | null };

/** Whether any detail Starbase keeps changed: a new value, not a cleared one (Starbase never clears a field from here). */
function portalDetailsChanged(before: Details, after: Details): boolean {
  const same = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  return (Object.keys(after) as (keyof Details)[]).some((k) => Boolean(after[k]?.trim()) && !same(before[k], after[k]));
}

export async function savePreferences(prev: ActionState, form: FormData): Promise<ActionState> {
  return save(prev, form);
}
