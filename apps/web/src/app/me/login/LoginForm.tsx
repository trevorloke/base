"use client";

import { useState } from "react";
import { Honeypot } from "@/components/forms/Field";
import { HumanCheck } from "@/components/forms/HumanCheck";
import { HUMAN_NOT_READY, humanHeaders, useHumanControl } from "@/components/forms/human";

type Status = "idle" | "sending" | "sent" | "error";

export const SENT_MESSAGE = "If that address has an account, a sign-in link is on its way. Links last 30 minutes.";

/** Email in, link out. The same reply whether or not the address is known. */
export function LoginForm({ next }: { next: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const human = useHumanControl();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;
    const data = new FormData(e.currentTarget);
    setStatus("sending");
    setError("");
    const headers = await humanHeaders(human);
    if (!headers) {
      setStatus("error");
      setError(HUMAN_NOT_READY);
      return;
    }
    try {
      const res = await fetch("/api/me/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ email: data.get("email"), website: data.get("website") ?? "", next }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string> };
      if (!res.ok) {
        setStatus("error");
        setError(body.fields?.email ?? body.error ?? "Something went wrong. Please try again.");
        return;
      }
      setStatus("sent");
    } catch {
      setStatus("error");
      setError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      // The token worked once; the next try needs a fresh one.
      human.reset();
    }
  }

  return (
    <form className="form-card" onSubmit={onSubmit} aria-busy={status === "sending"} data-status={status}>
      <Honeypot />
      <div className="field">
        <label htmlFor="member-email">Email</label>
        <input
          id="member-email"
          name="email"
          type="email"
          className="input"
          required
          autoComplete="email"
          maxLength={254}
          aria-invalid={status === "error" ? true : undefined}
          aria-describedby="member-login-hint member-login-error"
        />
        <p id="member-login-hint" className="hint">
          Use the address you joined, signed or donated with.
        </p>
      </div>
      <HumanCheck control={human} />
      <button type="submit" className="btn btn--navy btn--lg" aria-busy={status === "sending"} aria-disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>
      <div id="member-login-status" role="status" aria-live="polite" className={status === "sent" ? "alert alert--note" : undefined}>
        {status === "sent" && (
          <>
            <span aria-hidden="true" className="alert-icon">
              ✓
            </span>
            <span>{SENT_MESSAGE}</span>
          </>
        )}
      </div>
      <div id="member-login-error" role="alert" className={error ? "alert" : undefined}>
        {error && (
          <>
            <span aria-hidden="true" className="alert-icon">
              !
            </span>
            <span>{error}</span>
          </>
        )}
      </div>
    </form>
  );
}
