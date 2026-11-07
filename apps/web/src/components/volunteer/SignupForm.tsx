"use client";

import { useEffect, useRef } from "react";
import { Alert, ConsentCheckbox, Honeypot, TextField, TrackingFields } from "@/components/forms/Field";
import { HumanCheck } from "@/components/forms/HumanCheck";
import { readForm, useApiForm } from "@/components/forms/useApiForm";
import type { PublicOpening, SignupConfirmation } from "@/lib/shifts";

type Result = { ok: true; confirmation: SignupConfirmation };

/**
 * One opening's sign-up form. Sends name, email, phone (optional), postal
 * code, the two optional consent ticks (email updates, texts), plus the
 * `source` and `ref` from the page URL or the tracking cookie. Booking the
 * shift needs neither tick: messages about the shift itself are transactional.
 */
export function SignupForm({ opening, onDone, onCancel }: { opening: PublicOpening; onDone: (c: SignupConfirmation) => void; onCancel: () => void }) {
  const { submit, pending, error, fields, human } = useApiForm<Result>("/api/volunteer/signup");
  const formRef = useRef<HTMLFormElement>(null);
  const prefix = `su-${opening.id.slice(0, 8)}`;

  useEffect(() => formRef.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus(), []);

  // After a failed submit, focus goes to the first field with a problem, else the message.
  useEffect(() => {
    if (!error) return;
    const first = Object.keys(fields)[0];
    const el = first ? formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`) : null;
    (el ?? formRef.current?.querySelector<HTMLElement>("[role=alert]"))?.focus();
  }, [error, fields]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = readForm(e.currentTarget);
    const result = await submit({ ...data, openingId: opening.id });
    if (result) onDone(result.confirmation);
  }

  return (
    <form ref={formRef} className="opening-form" onSubmit={onSubmit} aria-label={`Sign up for ${opening.title}`}>
      <Honeypot />
      <TrackingFields locale={false} />
      <h4>Sign up for this shift</h4>
      <div className="form-row">
        <TextField id={`${prefix}-name`} name="name" label="Your name" required autoComplete="name" maxLength={120} error={fields.name} />
        <TextField id={`${prefix}-email`} name="email" type="email" label="Email" required autoComplete="email" maxLength={254} error={fields.email} />
      </div>
      <div className="form-row">
        <TextField id={`${prefix}-phone`} name="phone" type="tel" label="Phone (optional)" autoComplete="tel" maxLength={30} error={fields.phone} />
        <TextField id={`${prefix}-postal`} name="postalCode" label="Postal code" required autoComplete="postal-code" placeholder="V3T 1V8" maxLength={7} error={fields.postalCode} />
      </div>
      <p className="hint">We&apos;ll email you about this shift. The boxes below are optional.</p>
      <ConsentCheckbox id={`${prefix}-updates`} kind="updates" error={fields.updatesConsent} />
      <ConsentCheckbox id={`${prefix}-sms`} kind="sms" error={fields.smsConsent} />
      <HumanCheck control={human} />
      {error && <Alert>{error}</Alert>}
      <div className="btn-row" style={{ gap: 10 }}>
        <button type="submit" className="btn btn--red" aria-busy={pending} aria-disabled={pending}>
          {pending ? "One moment…" : "Sign me up"}
        </button>
        <button type="button" className="btn btn--outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
