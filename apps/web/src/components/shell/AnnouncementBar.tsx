"use client";

import { useEffect, useState } from "react";
import { SmartLink } from "./SmartLink";

const STORAGE_PREFIX = "is_announcement_dismissed:";

/**
 * The one-line notice from settings.announcement. Dismissing it is remembered
 * per message, so a new announcement shows again.
 */
export function AnnouncementBar({ text, linkLabel, linkHref }: { text: string; linkLabel?: string; linkHref?: string }) {
  const [dismissed, setDismissed] = useState(false);
  const key = STORAGE_PREFIX + text;

  useEffect(() => {
    try {
      if (localStorage.getItem(key) === "1") setDismissed(true);
    } catch {
      // Storage blocked: the bar just stays.
    }
  }, [key]);

  if (dismissed) return null;
  return (
    <div role="region" aria-label="Announcement" className="announcement">
      <div className="announcement-inner">
        <p className="announcement-text">
          {text}
          {linkLabel && linkHref && (
            <>
              {" "}
              <SmartLink href={linkHref} className="announcement-link">
                {linkLabel}
              </SmartLink>
            </>
          )}
        </p>
        <button
          type="button"
          className="announcement-close"
          aria-label="Dismiss announcement"
          onClick={() => {
            try {
              localStorage.setItem(key, "1");
            } catch {
              // Not remembered, but still hidden for this page view.
            }
            setDismissed(true);
          }}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
