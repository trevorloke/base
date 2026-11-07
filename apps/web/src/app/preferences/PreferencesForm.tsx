"use client";

import Link from "next/link";
import { useState } from "react";
import { Checkbox, ErrorSummary, Honeypot, LiveRegion, PostalCodeField, SelectField, SubmitButton, TextField } from "@/components/forms/Field";
import { readForm, useApiForm } from "@/components/forms/useApiForm";
import { CONSENT_WORDING } from "@/lib/consent-wording";
import { preferencesSchema, type Locale } from "@/lib/validation";
import type { PreferenceState } from "./server";

const LOCALE_LABELS: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "pa", label: "ਪੰਜਾਬੀ (Punjabi)" },
  { value: "hi", label: "हिन्दी (Hindi)" },
  { value: "zh-Hans", label: "简体中文 (Chinese, Simplified)" },
  { value: "zh-Hant", label: "繁體中文 (Chinese, Traditional)" },
  { value: "tl", label: "Tagalog" },
];

type Result = { ok: true; token: string };

/** The person's current choices, saved with a single-use token that the response renews. */
export function PreferencesForm({ token: initialToken, initial }: { token: string; initial: PreferenceState }) {
  const { submit, pending, error, fields, summaryRef, fail } = useApiForm<Result>("/api/preferences", { schema: preferencesSchema });
  const [token, setToken] = useState(initialToken);
  const [saved, setSaved] = useState(false);
  const [live, setLive] = useState("");
  // The route answers 410 with a `token` field error when the link is spent.
  const expired = Boolean(fields.token);

  return (
    <>
      <LiveRegion message={live} />
      <form
        className="form-card"
        noValidate
        aria-busy={pending || undefined}
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending || expired) return;
          setSaved(false);
          const body = readForm(e.currentTarget);
          if (body.sms === true && !String(body.phone ?? "").trim() && !initial.phone) {
            fail("Please check the highlighted fields.", { phone: "Add a mobile number so we can text you, or untick the text box" });
            return;
          }
          const result = await submit(body);
          if (!result) return;
          setToken(result.token);
          setSaved(true);
          setLive("Your preferences are saved.");
        }}
      >
        <Honeypot />
        <input type="hidden" name="token" value={token} />
        <h2 className="h3" style={{ fontSize: 24 }}>
          {initial.firstName ? `Hi ${initial.firstName}, here’s what we send to ${initial.email}` : `What we send to ${initial.email}`}
        </h2>
        {saved && (
          <p role="status" className="prefs-saved">
            Saved. You can change these again any time.
          </p>
        )}
        <fieldset className="group">
          <legend>Email and texts</legend>
          <Checkbox id="pref-updates" name="updates" defaultChecked={initial.updates} error={fields.updates}>
            {CONSENT_WORDING.updates}
          </Checkbox>
          <Checkbox id="pref-sms" name="sms" defaultChecked={initial.sms} error={fields.sms}>
            {CONSENT_WORDING.sms}
          </Checkbox>
        </fieldset>
        <div className="form-row">
          <TextField id="pref-phone" name="phone" type="tel" label="Mobile number" autoComplete="tel" defaultValue={initial.phone ?? ""} error={fields.phone} />
          <SelectField id="pref-locale" name="locale" label="Language" defaultValue={initial.locale ?? ""} error={fields.locale}>
            <option value="">No preference</option>
            {LOCALE_LABELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </SelectField>
        </div>
        <PostalCodeField id="pref-postal" label="Postal code" defaultValue={initial.postalCode ?? ""} error={fields.postalCode} hint="So we can tell you about things near you." />
        <ErrorSummary ref={summaryRef} error={error} fields={fields} />
        {expired ? (
          <p className="small">
            <Link href="/preferences" className="text-link">
              Ask for a new link
            </Link>
          </p>
        ) : null}
        <SubmitButton pending={pending} disabled={expired} className="btn btn--navy btn--lg" pendingLabel="Saving…">
          Save my preferences
        </SubmitButton>
        <p className="small">
          To stop all email, use the unsubscribe link at the bottom of any message. Texts stop the moment you reply STOP.
        </p>
      </form>
    </>
  );
}
