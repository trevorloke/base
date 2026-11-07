"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Outcome = { kind: "confirmed"; number: number } | { kind: "expired" } | { kind: "none" };

/** /tracker/follow#confirmed-10 or #expired, after a click on a confirmation email. */
export function FollowResult() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    const m = /^#confirmed-(\d+)$/.exec(window.location.hash);
    if (m) setOutcome({ kind: "confirmed", number: Number(m[1]) });
    else if (window.location.hash === "#expired") setOutcome({ kind: "expired" });
    else setOutcome({ kind: "none" });
  }, []);
  if (!outcome) return <p className="lede">Checking your link…</p>;
  if (outcome.kind === "confirmed") {
    return (
      <div className="stack" style={{ gap: 14 }} role="status">
        <p className="lede">You&apos;re following promise {outcome.number}. We&apos;ll email you when its status changes, with a link to the record.</p>
        <div className="btn-row">
          <Link href={`/tracker/${outcome.number}`} className="btn btn--primary">
            Back to promise {outcome.number}
          </Link>
          <Link href="/tracker" className="btn btn--outline">
            All promises
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 14 }} role="status">
      <p className="lede">{outcome.kind === "expired" ? "That confirmation link has expired or was already used." : "Nothing to confirm here."}</p>
      <p>Open the promise you want to follow and enter your email again; a fresh link will be sent.</p>
      <div className="btn-row">
        <Link href="/tracker" className="btn btn--primary">
          Go to the tracker
        </Link>
      </div>
    </div>
  );
}
