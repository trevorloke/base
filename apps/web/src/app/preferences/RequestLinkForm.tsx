"use client";

import { useState } from "react";
import { ErrorSummary, Honeypot, LiveRegion, SubmitButton, SuccessCard, TextField } from "@/components/forms/Field";
import { HumanCheck } from "@/components/forms/HumanCheck";
import { readForm, useApiForm } from "@/components/forms/useApiForm";
import { preferencesRequestSchema } from "@/lib/validation";
import { clientProfile } from "@/seeds/client";

/** "Send me a link": the public way into the preference centre. */
export function RequestLinkForm({ expired = false }: { expired?: boolean }) {
  const { submit, pending, error, fields, summaryRef, human } = useApiForm("/api/preferences/request", { schema: preferencesRequestSchema });
  const [done, setDone] = useState(false);
  const [live, setLive] = useState("");

  if (done) {
    return (
      <>
        <LiveRegion message={live} />
        <SuccessCard title="Check your inbox">
          <p>If that address is on our list, we’ve emailed you a link to your preferences. It works once and expires in 60 minutes.</p>
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
          if (await submit(readForm(e.currentTarget))) {
            setLive("If that address is on our list, we’ve emailed you a link.");
            setDone(true);
          }
        }}
      >
        <Honeypot />
        <h2 className="h3" style={{ fontSize: 24 }}>
          {expired ? "That link has expired or was already used" : "Get a link to your preferences"}
        </h2>
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55 }}>
          Enter the email address we have for you and we’ll send a one-time link. You can also use the “manage preferences” link at the bottom of any
          {clientProfile.orgName} email.
        </p>
        <TextField id="pref-request-email" name="email" type="email" label="Email" required autoComplete="email" error={fields.email} />
        <HumanCheck control={human} error={fields.human} />
        <ErrorSummary ref={summaryRef} error={error} fields={fields} />
        <SubmitButton pending={pending} className="btn btn--primary btn--lg">
          Send me a link
        </SubmitButton>
      </form>
    </>
  );
}
