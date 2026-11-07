"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";

  return (
    <>
      <section className="section--navy on-dark page-head">
        <div className="container stack" style={{ gap: 14 }}>
          <h1 className="display pop">Something went wrong</h1>
          <p className="lede" style={{ maxWidth: 760 }}>
            Sorry, this page didn&apos;t load properly. It&apos;s usually a short hiccup: please try again.
          </p>
        </div>
      </section>
      <section className="section">
        <div className="container stack" style={{ gap: 20 }}>
          <div className="btn-row">
            <button type="button" className="btn btn--red btn--lg" onClick={() => retry()}>
              Try again
            </button>
            <Link href="/" className="btn btn--outline btn--lg">
              Go to the home page
            </Link>
          </div>
          {digest && <p className="small">Reference: {digest}</p>}
        </div>
      </section>
    </>
  );
}
