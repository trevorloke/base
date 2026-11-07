"use client";

import { useEffect, useRef, useState } from "react";
import { newsletterSchema } from "@/lib/validation";
import { Honeypot, LiveRegion, SubmitButton } from "./Field";
import { useTracking } from "./tracking";
import { HumanCheck } from "./HumanCheck";
import { useApiForm } from "./useApiForm";

type Result = { ok: true; status?: "pending" | "subscribed" | "unsubscribed" };

const MESSAGES: Record<NonNullable<Result["status"]>, string> = {
  pending: "Check your inbox to confirm your subscription.",
  subscribed: "You’re on the list.",
  unsubscribed: "This address unsubscribed earlier. Email hello@imaginesurrey.ca to rejoin.",
};

/**
 * The one-field newsletter sign-up. `id` is the email input's id, so a label
 * outside the form can point at it (the home page does).
 */
export function NewsletterForm({ source = "website", id = "nl-email" }: { source?: string; id?: string }) {
  const { submit, pending, error, fields, fail, human } = useApiForm<Result>("/api/newsletter", { schema: newsletterSchema });
  const tracking = useTracking();
  const [done, setDone] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const message = fields.email ?? error;

  useEffect(() => {
    if (message) input.current?.focus();
  }, [message]);
  useEffect(() => {
    if (done) status.current?.focus();
  }, [done]);

  if (done) {
    return (
      <>
        <LiveRegion message={done} />
        <p ref={status} role="status" tabIndex={-1} style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "var(--primary)" }}>
          {done}
        </p>
      </>
    );
  }

  return (
    <form
      className="newsletter-form"
      noValidate
      aria-busy={pending || undefined}
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending) return;
        const data = new FormData(e.currentTarget);
        const email = String(data.get("email") ?? "").trim();
        if (!email) {
          fail("Enter your email address", { email: "Enter your email address" });
          return;
        }
        const result = await submit({ email, website: data.get("website"), source, ref: tracking.ref ?? "" });
        if (result) setDone(MESSAGES[result.status ?? "subscribed"]);
      }}
    >
      <Honeypot />
      <input
        ref={input}
        id={id}
        name="email"
        type="email"
        required
        placeholder="you@example.com"
        autoComplete="email"
        className="input"
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? `${id}-error` : undefined}
      />
      <HumanCheck control={human} />
      <SubmitButton pending={pending} className="btn btn--primary" pendingLabel="Sending…">
        Subscribe
      </SubmitButton>
      {message && (
        <p className="field-error" id={`${id}-error`} role="alert" style={{ flexBasis: "100%" }}>
          {message}
        </p>
      )}
    </form>
  );
}
