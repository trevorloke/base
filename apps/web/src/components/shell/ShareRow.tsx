"use client";

import { useState } from "react";
import { shareLinks } from "@/lib/share";

/** Share this page: WhatsApp first, then text, X, Facebook, email and copy. */
export function ShareRow({ url, text, subject }: { url: string; text: string; subject?: string }) {
  const links = shareLinks({ url, text, subject });
  const [copied, setCopied] = useState(false);
  const items = [
    { href: links.whatsapp, label: "WhatsApp" },
    { href: links.sms, label: "Text" },
    { href: links.x, label: "X" },
    { href: links.facebook, label: "Facebook" },
    { href: links.email, label: "Email" },
  ];
  return (
    <div className="share-row">
      <h2 className="share-title" id="share-title">
        Share this
      </h2>
      <ul className="share-list" role="list" aria-labelledby="share-title">
        {items.map((item) => (
          <li key={item.label}>
            <a href={item.href} className="share-link" target={item.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">
              {item.label}
              {item.href.startsWith("http") && <span className="visually-hidden"> (opens in a new tab)</span>}
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
                setCopied(true);
                setTimeout(() => setCopied(false), 3000);
              } catch {
                window.prompt("Copy this link", links.copy);
              }
            }}
          >
            Copy link
          </button>
        </li>
      </ul>
      <p role="status" className="share-status">
        {copied ? "Link copied." : ""}
      </p>
    </div>
  );
}
