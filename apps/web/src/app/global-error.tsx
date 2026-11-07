"use client";

import { useEffect } from "react";
import { clientProfile } from "@/seeds/client";

// Replaces the whole document when the root layout itself fails, so it
// carries its own minimal styles.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "Montserrat, system-ui, sans-serif", background: "#003979", color: "#fff" }}>
        <title>{`Something went wrong · ${clientProfile.orgName}`}</title>
        <main id="main" style={{ maxWidth: 720, margin: "0 auto", padding: "96px 24px" }}>
          <h1 style={{ fontSize: 40, fontWeight: 900, lineHeight: 1.1, margin: "0 0 16px" }}>Something went wrong</h1>
          <p style={{ fontSize: 19, lineHeight: 1.55, color: "#d3deef", margin: "0 0 28px" }}>
            Sorry, the site didn&apos;t load properly. It&apos;s usually a short hiccup: please try again in a moment.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            <button
              type="button"
              onClick={() => retry()}
              style={{ minHeight: 48, padding: "0 24px", border: 0, borderRadius: 999, background: "#FFF100", color: "#003979", fontWeight: 800, fontSize: 17, cursor: "pointer" }}
            >
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full reload is the point here */}
            <a href="/" style={{ display: "inline-flex", alignItems: "center", minHeight: 48, padding: "0 24px", borderRadius: 999, border: "2px solid #fff", color: "#fff", fontWeight: 700, textDecoration: "none" }}>
              Go to the home page
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
