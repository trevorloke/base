"use client";

import { useEffect, useRef, useState } from "react";
import type { ShareLinks } from "@/lib/share";

const CHANNELS: { key: keyof ShareLinks; label: string; external: boolean }[] = [
  { key: "whatsapp", label: "WhatsApp", external: true },
  { key: "sms", label: "Text", external: false },
  { key: "x", label: "X", external: true },
  { key: "facebook", label: "Facebook", external: true },
  { key: "email", label: "Email", external: false },
];

/**
 * A share sheet from `shareLinks()`: WhatsApp first, then text, X, Facebook,
 * email and a copy-link button. Plain links, so every button works without
 * JavaScript except "Copy link", which falls back to selecting the URL.
 */
export function ShareButtons({ links, label = "Share", heading }: { links: ShareLinks; label?: string; heading?: string }) {
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(links.copy);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 3000);
  }

  return (
    <div className="share" role="group" aria-label={label}>
      {heading && <p className="share-heading">{heading}</p>}
      <ul className="share-buttons">
        {CHANNELS.map((c) => (
          <li key={c.key}>
            <a className={`share-button share-button--${c.key}`} href={links[c.key]} {...(c.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {c.label}
              {c.external && <span className="visually-hidden"> (opens in a new tab)</span>}
            </a>
          </li>
        ))}
        <li>
          <button type="button" className="share-button share-button--copy" onClick={copy}>
            Copy link
          </button>
        </li>
      </ul>
      <p className="share-status small" role="status">
        {copied === "done" ? "Link copied." : copied === "failed" ? `Copy this link: ${links.copy}` : ""}
      </p>
    </div>
  );
}
