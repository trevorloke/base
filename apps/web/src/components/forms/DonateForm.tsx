"use client";

import { CONSENT_WORDING } from "@/lib/consent-wording";
import { useState } from "react";
import { MIN_DONATION_CENTS, starClubCents } from "@/lib/contributions";
import { formatCents } from "@/lib/money";
import { donationSchema } from "@/lib/validation";
import { AmountPicker, choiceLabel, type Choice } from "./AmountPicker";
import { Checkbox, ErrorSummary, Honeypot, PostalCodeField, SubmitButton, TextField, TrackingFields } from "./Field";
import { readForm, useApiForm } from "./useApiForm";
import { clientProfile } from "@/seeds/client";

const CUSTOM_ID = "amount-custom";

export function DonateForm({
  initial,
  limitCents,
  year,
  monthlyNote,
  clubNote,
}: {
  initial: Choice;
  limitCents: number;
  /** The contribution year shown next to the limit. */
  year?: number;
  monthlyNote?: string;
  clubNote?: string;
}) {
  const [choice, setChoice] = useState<Choice>(initial);
  const [customError, setCustomError] = useState<string | null>(null);
  const { submit, pending, error, fields, summaryRef, fail } = useApiForm<{ url: string }>("/api/donations/checkout", { schema: donationSchema });
  const summaryFields = customError ? { [CUSTOM_ID]: customError, ...fields } : fields;

  function amountProblem(): string | null {
    if (customError) return customError;
    if (choice.tier !== "standard") return null;
    if (choice.amountCents < MIN_DONATION_CENTS) return `The smallest contribution we can take online is ${formatCents(MIN_DONATION_CENTS)}.`;
    const max = starClubCents(choice.frequency, limitCents);
    if (choice.amountCents > max) return choice.frequency === "monthly" ? `The most you can give monthly is ${formatCents(max)} a month.` : `The most you can give is ${formatCents(limitCents)} a year under BC law.`;
    return null;
  }

  return (
    <form
      className="donate-card"
      style={{ flex: "1 1 520px" }}
      noValidate
      aria-busy={pending || undefined}
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending) return;
        const problem = amountProblem();
        if (problem) {
          setCustomError(problem);
          fail("Please check the highlighted fields.", { [CUSTOM_ID]: problem });
          return;
        }
        const result = await submit({ ...readForm(e.currentTarget), ...choice });
        if (result) window.location.assign(result.url);
      }}
    >
      <Honeypot />
      <TrackingFields locale={false} />
      <AmountPicker choice={choice} onChange={setChoice} onCustomError={setCustomError} limitCents={limitCents} allowCustom monthlyNote={monthlyNote} clubNote={clubNote} />

      <fieldset className="group" style={{ gap: 14 }}>
        <legend style={{ fontSize: 18, fontWeight: 700, color: "var(--primary)" }}>Your details</legend>
        <p className="hint" style={{ margin: "-4px 0 0" }}>
          BC law requires us to record the name and address of everyone who contributes.
        </p>
        <div className="form-row">
          <TextField id="d-first" name="firstName" label="First name" required autoComplete="given-name" error={fields.firstName} />
          <TextField id="d-last" name="lastName" label="Last name" required autoComplete="family-name" error={fields.lastName} />
        </div>
        <div className="form-row">
          <TextField id="d-email" name="email" type="email" label="Email" required autoComplete="email" error={fields.email} />
          <TextField id="d-phone" name="phone" type="tel" label="Phone (optional)" autoComplete="tel" error={fields.phone} />
        </div>
        <TextField id="d-address" name="address" label="Street address" required autoComplete="street-address" error={fields.address} />
        <div className="form-row">
          <TextField id="d-city" name="city" label="City" required defaultValue={clientProfile.defaultCity} autoComplete="address-level2" error={fields.city} />
          <PostalCodeField id="d-postal" required error={fields.postalCode} hint="A BC postal code" />
        </div>
      </fieldset>

      <fieldset className="group">
        <legend>I confirm that</legend>
        <Checkbox id="d-attest-citizen" name="attestCitizenOrPR" required error={fields.attestCitizenOrPR}>
          I’m a Canadian citizen or permanent resident
        </Checkbox>
        <Checkbox id="d-attest-bc" name="attestBcResident" required error={fields.attestBcResident}>
          I live in British Columbia
        </Checkbox>
        <Checkbox id="d-attest-funds" name="attestOwnFunds" required error={fields.attestOwnFunds}>
          This contribution is my own money, and no one will pay me back for it
        </Checkbox>
      </fieldset>
      <Checkbox id="d-newsletter" name="newsletter" error={fields.newsletter}>
        {CONSENT_WORDING.newsletter}
      </Checkbox>

      <ErrorSummary ref={summaryRef} error={error} fields={summaryFields} />
      <SubmitButton pending={pending} className="btn btn--accent btn--xl btn--block" pendingLabel="Taking you to secure checkout…">
        Donate {choiceLabel(choice, limitCents)}
      </SubmitButton>
      <p className="small">
        You’ll pay securely with Stripe. {choice.frequency === "monthly" && "You can cancel a monthly gift at any time by emailing us. "}Contributions can’t exceed{" "}
        {formatCents(limitCents)} {year ? `in ${year}` : "a year"} under BC’s Local Elections Campaign Financing Act, and aren’t tax deductible.
      </p>
    </form>
  );
}
