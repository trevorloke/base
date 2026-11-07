"use client";

import { useId, useRef, useState } from "react";
import { shareLinks } from "@/lib/share";
import "./engage.css";

/**
 * A share sheet with WhatsApp first: the channel relational organizing in
 * Surrey runs on. Every option is a real link that works without JavaScript;
 * "Copy link" uses the clipboard and falls back to selecting the URL.
 *
 *   <ShareSheet url="https://imaginesurrey.ca/r/ABCD2345" text="I’m with Imagine Surrey. Join me:" />
 */
export function ShareSheet({ url, text, subject, label = "Share" }: { url: string; text: string; subject?: string; label?: string }) {
  const links = shareLinks({ url, text, subject });
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setStatus("Copied");
    } catch {
      const input = inputRef.current;
      input?.focus();
      input?.select();
      setStatus("The link is selected below: press Ctrl+C, or long-press to copy it.");
    }
  }

  const items: { key: string; label: string; href: string; external: boolean; icon: React.ReactNode }[] = [
    { key: "whatsapp", label: "WhatsApp", href: links.whatsapp, external: true, icon: <WhatsAppIcon /> },
    { key: "sms", label: "Text", href: links.sms, external: false, icon: <ChatIcon /> },
    { key: "facebook", label: "Facebook", href: links.facebook, external: true, icon: <FacebookIcon /> },
    { key: "x", label: "X", href: links.x, external: true, icon: <XIcon /> },
    { key: "email", label: "Email", href: links.email, external: false, icon: <MailIcon /> },
  ];

  return (
    <div className="share-sheet" role="group" aria-labelledby={`${id}-label`}>
      <p id={`${id}-label`} className="share-sheet__label">
        {label}
      </p>
      <ul className="share-sheet__list">
        {items.map((item) => (
          <li key={item.key}>
            <a className={`share-sheet__link share-sheet__link--${item.key}`} href={item.href} {...(item.external ? { target: "_blank", rel: "noopener" } : {})}>
              {item.icon}
              <span>{item.label}</span>
            </a>
          </li>
        ))}
        <li>
          <button type="button" className="share-sheet__link share-sheet__link--copy" onClick={copy}>
            <CopyIcon />
            <span>Copy link</span>
          </button>
        </li>
      </ul>
      <div className="field">
        <label htmlFor={`${id}-url`} className="visually-hidden">
          Your link
        </label>
        <input ref={inputRef} id={`${id}-url`} className="input share-sheet__url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      </div>
      <p className="share-sheet__status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

const svg = { "aria-hidden": true, width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function WhatsAppIcon() {
  return (
    <svg {...svg}>
      <path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z" />
      <path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.5-2-1-1 1a4.5 4.5 0 0 1-2.5-2.5l1-1-1-2-1.5 1z" fill="currentColor" stroke="none" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg {...svg}>
      <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4v-4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  );
}
function FacebookIcon() {
  return (
    <svg {...svg}>
      <path d="M15 4h-2a4 4 0 0 0-4 4v3H7v3h2v6h3v-6h3l1-3h-4V8a1 1 0 0 1 1-1h2z" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg {...svg}>
      <path d="M4 4l16 16M20 4L4 20" />
    </svg>
  );
}
function MailIcon() {
  return (
    <svg {...svg}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}
function CopyIcon() {
  return (
    <svg {...svg}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a1 1 0 0 1 1-1h10" />
    </svg>
  );
}
