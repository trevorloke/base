"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { mergeTracking } from "@/lib/engagement";
import { TRACKING_COOKIE, trackingFromLocation } from "@/lib/share";

/**
 * Remembers where a visit came from. A link carrying ?ref=<code> (a
 * supporter's referral) or ?source=<tag> (a flyer, an email, a WhatsApp
 * group) is written to the `is_track` cookie for 30 days, merged over what
 * the cookie already holds, so the forms can credit the sign-up. Renders
 * nothing. Mount it once in the root layout.
 */
export function TrackingCapture() {
  const pathname = usePathname();
  useEffect(() => {
    try {
      const incoming = trackingFromLocation(window.location.search);
      if (!incoming.ref && !incoming.source) return;
      const existing = readCookie(TRACKING_COOKIE);
      const merged = mergeTracking(existing, incoming);
      if (!merged || merged === existing) return;
      const secure = window.location.protocol === "https:" ? "; secure" : "";
      document.cookie = `${TRACKING_COOKIE}=${merged}; path=/; max-age=2592000; samesite=lax${secure}`;
    } catch {
      // Cookies blocked: nothing to remember.
    }
  }, [pathname]);
  return null;
}

function readCookie(name: string): string | null {
  const match = document.cookie.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return null;
  }
}
