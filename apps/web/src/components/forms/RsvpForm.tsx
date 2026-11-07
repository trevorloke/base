"use client";

import { useState } from "react";
import { rsvpSchema } from "@/lib/validation";
import { Checkbox, ConsentCheckbox, ErrorSummary, Honeypot, LiveRegion, PostalCodeField, SubmitButton, SuccessCard, TextField, TrackingFields } from "./Field";
import { HumanCheck } from "./HumanCheck";
import { readForm, useApiForm } from "./useApiForm";

/**
 * RSVP to an event. Sends the full rsvpSchema body: name, email, guests,
 * newsletter, phone, postalCode, smsConsent, source, ref and website.
 */
export function RsvpForm({ slug, eventTitle }: { slug: string; eventTitle?: string }) {
  const { submit, pending, error, fields, summaryRef, fail, human } = useApiForm(`/api/events/${slug}/rsvp`, { schema: rsvpSchema });
  const [done, setDone] = useState(false);
  const [live, setLive] = useState("");

  if (done) {
    return (
      <>
        <LiveRegion message={live} />
        <SuccessCard title="You’re on the list">
          <p>See you there{eventTitle ? ` at ${eventTitle}` : ""}. Bring a neighbour.</p>
        </SuccessCard>
      </>
    );
  }

  return (
    <>
      <LiveRegion message={live} />
      <form
        className="form-card"
        noValidate
        aria-busy={pending || undefined}
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending) return;
          const data = readForm(e.currentTarget);
          const body: Record<string, unknown> = { ...data, guests: Number(data.guests) || 0 };
          if (body.smsConsent === true && !String(body.phone ?? "").trim()) {
            fail("Please check the highlighted fields.", { phone: "Add a mobile number so we can text you, or untick the text box" });
            return;
          }
          if (await submit(body)) {
            setLive("Thanks, you’re on the list.");
            setDone(true);
          }
        }}
      >
        <Honeypot />
        <TrackingFields locale={false} />
        <h2 className="h3" style={{ fontSize: 26 }}>
          RSVP
        </h2>
        <TextField id="r-name" name="name" label="Your name" required autoComplete="name" error={fields.name} />
        <TextField id="r-email" name="email" type="email" label="Email" required autoComplete="email" error={fields.email} />
        <div className="form-row">
          <TextField id="r-phone" name="phone" type="tel" label="Mobile number (optional)" autoComplete="tel" error={fields.phone} />
          <PostalCodeField id="r-postal" label="Postal code (optional)" error={fields.postalCode} />
        </div>
        <TextField
          id="r-guests"
          name="guests"
          type="number"
          inputMode="numeric"
          min={0}
          max={10}
          defaultValue={0}
          label="Guests coming with you"
          style={{ maxWidth: 140 }}
          error={fields.guests}
        />
        <Checkbox id="r-newsletter" name="newsletter" error={fields.newsletter}>
          Send me the Imagine Surrey newsletter too. I can unsubscribe at any time.
        </Checkbox>
        <ConsentCheckbox id="r-sms" kind="sms" error={fields.smsConsent} />
        <HumanCheck control={human} error={fields.human} />
        <ErrorSummary ref={summaryRef} error={error} fields={fields} />
        <SubmitButton pending={pending} className="btn btn--red btn--lg">
          RSVP
        </SubmitButton>
      </form>
    </>
  );
}
