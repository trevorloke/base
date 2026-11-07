"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { TRACKING_COOKIE, trackingFromLocation } from "@/lib/share";
import { isBotUserAgent, isUntrackedPath } from "@/lib/visits";

/**
 * The first-party visit counter: on every page view, including moves between
 * pages inside the site, it posts the path, the referring page and the
 * ?source / ?ref to /api/v. It sets no cookie and stores nothing in the
 * browser; it reads the existing attribution cookie only to tag the view with
 * where the visit came from. The admin, the supporter portal and bots are
 * skipped. Renders nothing. Mount it once in the root layout.
 */
export function VisitBeacon() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || last.current === pathname) return;
    const first = last.current === null;
    last.current = pathname;
    if (isUntrackedPath(pathname)) return;
    try {
      if (isBotUserAgent(navigator.userAgent)) return;
      const fromUrl = trackingFromLocation(window.location.search);
      const fromCookie = new URLSearchParams(readCookie(TRACKING_COOKIE) ?? "");
      const body = JSON.stringify({
        path: pathname,
        // Only the first page of a visit has an outside referrer; later moves are within the site.
        referrer: first ? document.referrer : "",
        source: fromUrl.source ?? fromCookie.get("source") ?? undefined,
        ref: fromUrl.ref ?? fromCookie.get("ref") ?? undefined,
      });
      if (!(typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/v", body))) {
        void fetch("/api/v", { method: "POST", body, keepalive: true, credentials: "omit" }).catch(() => {});
      }
    } catch {
      // Counting a visit must never get in the way of the page.
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
