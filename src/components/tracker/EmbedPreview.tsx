"use client";

import Script from "next/script";
import { useId, useState } from "react";

declare global {
  interface Window {
    ImagineSurreyTracker?: { render: (target: HTMLElement, site?: string) => void };
  }
}

/** The widget itself, drawn by public/embed/tracker.js, plus the snippet to copy. */
export function EmbedPreview({ snippet }: { snippet: string }) {
  const id = useId();
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="stack" style={{ gap: 10 }}>
        <h2 className="h3" style={{ fontSize: 22 }}>
          Live preview
        </h2>
        <div id="tracker-embed-preview" className="embed-preview" aria-live="polite" />
        <Script
          src="/embed/tracker.js"
          strategy="afterInteractive"
          data-target="tracker-embed-preview"
          onReady={() => {
            // The script draws the card itself on first load; after a
            // client-side navigation it is already loaded, so draw it again.
            const target = document.getElementById("tracker-embed-preview");
            if (target && !target.firstChild) window.ImagineSurreyTracker?.render(target);
          }}
        />
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <h2 className="h3" style={{ fontSize: 22 }}>
          The snippet
        </h2>
        <label htmlFor={id} className="field-label">
          Copy this HTML into your page
        </label>
        <textarea id={id} className="embed-snippet" readOnly value={snippet} rows={4} spellCheck={false} />
        <div className="btn-row" style={{ gap: 10 }}>
          <button
            type="button"
            className="btn btn--navy"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(snippet);
                setCopied("done");
              } catch {
                setCopied("failed");
              }
            }}
          >
            Copy the snippet
          </button>
        </div>
        <p className="copy-status" role="status" aria-live="polite" style={{ margin: 0, minHeight: 20 }}>
          {copied === "done" ? "Snippet copied." : copied === "failed" ? "Select the text above and copy it." : ""}
        </p>
      </div>
    </div>
  );
}
