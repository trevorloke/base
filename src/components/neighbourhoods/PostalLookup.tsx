"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, TextField } from "@/components/forms/Field";
import { neighbourhoodForPostalCode, neighbourhoodSlug, normalizePostalCode, POSTAL_CODE_RE } from "@/lib/neighbourhoods";

/** "Find your neighbourhood": a postal code goes straight to its town centre's page, on the client. */
export function PostalLookup() {
  const router = useRouter();
  const [postal, setPostal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUnknown(null);
    const code = normalizePostalCode(postal);
    if (!POSTAL_CODE_RE.test(code)) {
      setError("Enter a postal code like V3T 1V8.");
      return;
    }
    const slug = neighbourhoodSlug(neighbourhoodForPostalCode(code));
    if (!slug) {
      setUnknown(code);
      return;
    }
    setPending(true);
    router.push(`/neighbourhoods/${slug}`);
  }

  return (
    <form className="form-card postal-lookup" onSubmit={onSubmit} aria-labelledby="lookup-title">
      <h2 id="lookup-title" className="h3" style={{ margin: 0 }}>
        Find your neighbourhood
      </h2>
      <div className="postal-lookup-row">
        <TextField
          id="lookup-postal"
          name="postalCode"
          label="Your postal code"
          placeholder="V3T 1V8"
          autoComplete="postal-code"
          maxLength={7}
          value={postal}
          onChange={(e) => setPostal(e.target.value)}
          error={error ?? undefined}
        />
        <button type="submit" className="btn btn--red" aria-busy={pending} aria-disabled={pending}>
          {pending ? "One moment…" : "Find it"}
        </button>
      </div>
      {unknown && (
        <Alert tone="note">
          We don&apos;t have a neighbourhood committee for {unknown} yet. <Link href="/#join">Join as a member</Link> and we&apos;ll connect you with the nearest one.
        </Alert>
      )}
    </form>
  );
}
