"use client";

import { useId, useState } from "react";
import { councilContactUrl } from "@/content/tracker";

/** A letter residents can copy and send to the mayor and council. */
export function CouncilLetter({ text }: { text: string }) {
  const id = useId();
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  return (
    <div className="council-letter stack" style={{ gap: 10 }}>
      <label htmlFor={id} className="field-label">
        Letter text (edit it to say what matters to you)
      </label>
      <textarea id={id} defaultValue={text} rows={12} spellCheck={false} />
      <div className="btn-row" style={{ gap: 10 }}>
        <button
          type="button"
          className="btn btn--primary"
          onClick={async () => {
            const current = (document.getElementById(id) as HTMLTextAreaElement | null)?.value ?? text;
            try {
              await navigator.clipboard.writeText(current);
              setCopied("done");
            } catch {
              setCopied("failed");
            }
          }}
        >
          Copy the letter
        </button>
        <a href={councilContactUrl} className="btn btn--outline" target="_blank" rel="noopener noreferrer">
          Find council&apos;s contact details ↗
        </a>
      </div>
      <p className="copy-status" role="status" aria-live="polite" style={{ margin: 0, minHeight: 20 }}>
        {copied === "done" ? "Letter copied. Paste it into an email or the council contact form." : copied === "failed" ? "Select the text above and copy it." : ""}
      </p>
    </div>
  );
}
