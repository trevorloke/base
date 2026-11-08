"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Checkbox, Honeypot, TextField } from "@/components/forms/Field";
import { HumanCheck } from "@/components/forms/HumanCheck";
import { readForm, useApiForm } from "@/components/forms/useApiForm";
import { followCopy } from "@/content/tracker";

type Result = { ok: true; status: "confirmed" | "pending" };

/** Email + the person's own tick → POST /api/tracker/follow. */
export function FollowForm({ promiseId, promiseNumber }: { promiseId: string; promiseNumber: number }) {
  const { submit, pending, error, fields, human } = useApiForm<Result>("/api/tracker/follow");
  const [done, setDone] = useState<Result["status"] | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  // Arriving from a confirmation email: /tracker/10#followed
  useEffect(() => {
    if (window.location.hash === "#followed") setDone("confirmed");
  }, []);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  useEffect(() => {
    if (!error) return;
    const firstInvalid = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']");
    (firstInvalid ?? alertRef.current)?.focus();
  }, [error, fields]);

  if (done) {
    return (
      <div ref={doneRef} tabIndex={-1} role="status" className="follow-done" data-follow-done={done} style={{ outline: "none" }}>
        <strong>{done === "confirmed" ? "You're following this promise." : "One more step."}</strong>
        <p className="small" style={{ margin: 0 }}>
          {done === "confirmed" ? followCopy.confirmed : followCopy.pending}
        </p>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      id="follow-form"
      className="stack"
      style={{ gap: 12 }}
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const data = readForm(e.currentTarget);
        const result = await submit({ promiseId, email: data.email, consent: data.consent === true, website: data.website });
        if (result) setDone(result.status);
      }}
    >
      <Honeypot />
      {error && (
        <div ref={alertRef} tabIndex={-1} style={{ outline: "none" }}>
          <Alert>{error}</Alert>
        </div>
      )}
      <TextField id="follow-email" name="email" type="email" label="Email" autoComplete="email" required maxLength={254} error={fields.email} placeholder="you@example.com" />
      <Checkbox name="consent" id="follow-consent" error={fields.consent} aria-invalid={fields.consent ? true : undefined}>
        {followCopy.consent}
      </Checkbox>
      <HumanCheck control={human} />
      <button type="submit" className="btn btn--primary" aria-busy={pending} aria-disabled={pending} onClick={(e) => pending && e.preventDefault()}>
        {pending ? "Saving…" : followCopy.button}
      </button>
      <p className="small" style={{ margin: 0 }}>
        Promise {promiseNumber} only. One click in any email stops them.
      </p>
    </form>
  );
}
