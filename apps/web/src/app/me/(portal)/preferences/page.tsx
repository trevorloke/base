import type { Metadata } from "next";
import { requireMember } from "@/lib/server/member-auth";
import { PreferencesForm } from "./PreferencesForm";

export const metadata: Metadata = { title: "Preferences", robots: { index: false } };

export default async function Preferences() {
  const person = await requireMember("/me/preferences");
  return (
    <>
      <h1>Preferences</h1>
      <p className="portal-intro">Your details, the language you&apos;d like to hear from us in, and whether we can email or text you. Every change to a tick box is recorded with the wording you saw.</p>
      <PreferencesForm
        person={{
          email: person.email,
          firstName: person.firstName,
          lastName: person.lastName,
          phone: person.phone,
          address: person.address,
          postalCode: person.postalCode,
          neighbourhood: person.neighbourhood,
          locale: person.locale,
          emailUpdates: Boolean(person.contactConsentAt),
          texts: Boolean(person.smsConsentAt),
        }}
      />
    </>
  );
}
