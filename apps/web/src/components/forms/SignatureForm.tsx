"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { campaignShareLinks, nextAsks, SHARE_CHANNELS } from "@/app/act/links";
import { clientProfile } from "@/seeds/client";
import { signatureSchema } from "@/lib/validation";
import { ConsentCheckbox, ErrorSummary, Honeypot, LiveRegion, PostalCodeField, SubmitButton, SuccessCard, TextField, TrackingFields } from "./Field";
import { HumanCheck } from "./HumanCheck";
import { readForm, useApiForm } from "./useApiForm";

export type SignatureResult = {
  ok: true;
  campaign: { slug: string; title: string; kind: "petition" | "pledge"; shareText: string };
};

export type SignatureFormProps = {
  /** The campaign slug (campaigns.slug). */
  campaign: string;
  /** petition | pledge; drives the wording. Defaults to `variant`, then "petition". */
  kind?: "petition" | "pledge";
  /** @deprecated Use `kind`. Kept so existing call sites keep working. */
  variant?: "pledge" | "petition";
  /** The optional free-text question (campaigns.question). Omit for none. */
  question?: string | null;
  /** Shown above the fields on petitions. Pass "" for none. */
  heading?: string;
  /** Called with the API response after a successful sign. */
  onSigned?: (result: SignatureResult) => void;
  /** Replaces the default next asks (join, donate, volunteer) in the success card. */
  nextSteps?: ReactNode;
  /** Prefix for field ids when the same campaign's form appears twice on a page. */
  idPrefix?: string;
};

/** Sign a petition or pledge. Consent to email and texts are separate, unticked boxes. */
export function SignatureForm({ campaign, kind, variant, question, heading, onSigned, nextSteps, idPrefix }: SignatureFormProps) {
  const resolvedKind = kind ?? variant ?? "petition";
  const petition = resolvedKind === "petition";
  const p = idPrefix ?? `sig-${campaign}`;
  const { submit, pending, error, fields, summaryRef, fail, human } = useApiForm<Partial<SignatureResult> & { ok: true }>("/api/signatures", { schema: signatureSchema });
  // A honeypot hit gets a bare {ok:true}; the card still renders.
  const [done, setDone] = useState<{ campaign: SignatureResult["campaign"] } | null>(null);
  const [live, setLive] = useState("");
  const [copied, setCopied] = useState(false);

  if (done) {
    const url = `${typeof window === "undefined" ? "" : window.location.origin}/act/${done.campaign.slug}`;
    const links = campaignShareLinks({ url, text: done.campaign.shareText || `I signed "${done.campaign.title}". Add your name:`, subject: done.campaign.title });
    return (
      <>
        <LiveRegion message={live} />
        <SuccessCard title={petition ? "Your name is on the petition" : "You’ve signed the pledge"} style={{ flex: "1 1 380px" }}>
          <p>
            Thanks.{" "}
            {petition ? "We’ll deliver the names to City Hall." : "We’ll hold City Hall to it."}
          </p>
          <p style={{ fontWeight: 700, color: "var(--primary)" }}>Share it with a neighbour:</p>
          <div className="success-actions">
            {SHARE_CHANNELS.map((c) => (
              <a key={c.key} className="btn btn--outline" href={links[c.key]} target={c.key === "sms" || c.key === "email" ? undefined : "_blank"} rel="noopener noreferrer">
                {c.label}
              </a>
            ))}
            <button
              type="button"
              className="btn btn--outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(links.copy);
                  setCopied(true);
                  setLive("Link copied");
                } catch {
                  window.prompt("Copy this link", links.copy);
                }
              }}
            >
              {copied ? "Link copied" : "Copy link"}
            </button>
          </div>
          <p style={{ fontWeight: 700, color: "var(--primary)" }}>Three ways to help next:</p>
          {nextSteps ?? (
            <div className="success-actions">
              {nextAsks(done.campaign.slug).map((a) => (
                <Link key={a.href} href={a.href} className="btn btn--accent">
                  {a.label}
                </Link>
              ))}
            </div>
          )}
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
          const body: Record<string, unknown> = { ...readForm(e.currentTarget), campaign };
          if (body.smsConsent === true && !String(body.phone ?? "").trim()) {
            fail("Please check the highlighted fields.", { phone: "Add a mobile number so we can text you, or untick the text box" });
            return;
          }
          const result = await submit(body);
          if (!result) return;
          const summary = result.campaign ?? { slug: campaign, title: "", kind: resolvedKind, shareText: "" };
          setLive(petition ? "Thanks, your name is on the petition." : "Thanks, you’ve signed the pledge.");
          setDone({ campaign: summary });
          if (result.campaign) onSigned?.({ ok: true, campaign: result.campaign });
        }}
      >
        <Honeypot />
        <TrackingFields />
        {(heading ?? (petition ? "Add your name" : "")) && (
          <h3 style={{ margin: 0, fontWeight: 800, fontSize: 26, lineHeight: 1.15, color: "var(--primary)" }}>{heading ?? "Add your name"}</h3>
        )}
        <div className="form-row" style={petition ? undefined : { gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <TextField id={`${p}-first`} name="firstName" label="First name" required autoComplete="given-name" error={fields.firstName} />
          <TextField id={`${p}-last`} name="lastName" label="Last name" required autoComplete="family-name" error={fields.lastName} />
        </div>
        <div className="form-row" style={petition ? undefined : { gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <TextField id={`${p}-email`} name="email" type="email" label="Email" required autoComplete="email" error={fields.email} />
          <PostalCodeField id={`${p}-postal`} required error={fields.postalCode} />
        </div>
        <div className="form-row" style={petition ? undefined : { gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          {petition && <TextField id={`${p}-address`} name="address" label="Street address (optional)" autoComplete="street-address" error={fields.address} />}
          <TextField id={`${p}-phone`} name="phone" type="tel" label="Mobile number (optional)" autoComplete="tel" error={fields.phone} />
        </div>
        {question && <TextField id={`${p}-answer`} name="answer" label={question} maxLength={200} error={fields.answer} />}
        <ConsentCheckbox id={`${p}-updates`} kind="updates" error={fields.updatesConsent} />
        <ConsentCheckbox id={`${p}-sms`} kind="sms" error={fields.smsConsent} />
        <HumanCheck control={human} error={fields.human} />
        <ErrorSummary ref={summaryRef} error={error} fields={fields} />
        <SubmitButton pending={pending} className="btn btn--accent btn--lg" style={{ minHeight: petition ? 56 : 54, fontSize: 19 }}>
          {petition ? "Add my name" : "Sign the pledge"}
        </SubmitButton>
        <p className="small">
          {petition ? "We’ll deliver the names to City Hall. " : ""}Your details stay with {clientProfile.orgName}. Read our <a href="/privacy">privacy policy</a>.
        </p>
      </form>
    </>
  );
}
