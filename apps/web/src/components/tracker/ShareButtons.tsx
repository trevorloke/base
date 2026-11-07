"use client";

import { useState } from "react";
import type { ShareLinks } from "@/lib/share";

/** A share sheet for one promise: WhatsApp first, then text, X, Facebook, email and copy. */
export function ShareButtons({ links, label }: { links: ShareLinks; label: string }) {
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const items: { key: keyof ShareLinks; text: string }[] = [
    { key: "whatsapp", text: "WhatsApp" },
    { key: "sms", text: "Text message" },
    { key: "x", text: "X" },
    { key: "facebook", text: "Facebook" },
    { key: "email", text: "Email" },
  ];
  return (
    <div className="stack" style={{ gap: 8 }}>
      <ul className="share-row" aria-label={label}>
        {items.map((i) => (
          <li key={i.key}>
            <a href={links[i.key]} className="share-link" target={i.key === "sms" || i.key === "email" ? undefined : "_blank"} rel="noopener noreferrer">
              {i.text}
            </a>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="share-link"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(links.copy);
                setCopied("done");
              } catch {
                setCopied("failed");
              }
            }}
          >
            Copy link
          </button>
        </li>
      </ul>
      <p className="copy-status" role="status" aria-live="polite" style={{ margin: 0, minHeight: 20 }}>
        {copied === "done" ? "Link copied." : copied === "failed" ? `Copy this link: ${links.copy}` : ""}
      </p>
    </div>
  );
}
