// Where a form submission came from, read on the client. Pure helpers so the
// cookie parsing can be unit-tested; the hook is the only browser-touching part.
import { useEffect, useState } from "react";
import { TRACKING_COOKIE, trackingFromLocation } from "@/lib/share";
import { localeFromLang, type Locale } from "@/lib/validation";

export type Tracking = { source?: string; ref?: string };

const SAFE = /^[A-Za-z0-9_.:-]+$/;
const clean = (value: string | null, max: number) => {
  const v = (value ?? "").trim().slice(0, max);
  return v && SAFE.test(v) ? v : undefined;
};

/** `ref` and `source` from the tracking cookie (a URLSearchParams string), if the document has one. */
export function readTrackingCookie(cookieHeader: string): Tracking {
  const match = cookieHeader
    .split(/;\s*/)
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${TRACKING_COOKIE}=`));
  if (!match) return {};
  let value = match.slice(TRACKING_COOKIE.length + 1);
  try {
    value = decodeURIComponent(value);
  } catch {
    return {};
  }
  const p = new URLSearchParams(value);
  const out: Tracking = {};
  const ref = clean(p.get("ref"), 20);
  const source = clean(p.get("source"), 80);
  if (ref) out.ref = ref;
  if (source) out.source = source;
  return out;
}

export type TrackingValues = Tracking & { locale?: Locale };

/** Query string first, then the cookie; the locale comes from <html lang>. */
export function trackingFromDocument(doc: { search: string; cookie: string; lang: string }): TrackingValues {
  const fromUrl = trackingFromLocation(doc.search);
  const fromCookie = readTrackingCookie(doc.cookie);
  const out: TrackingValues = {};
  const source = clean(fromUrl.source ?? null, 80) ?? fromCookie.source;
  const ref = clean(fromUrl.ref ?? null, 20) ?? fromCookie.ref;
  const locale = localeFromLang(doc.lang);
  if (source) out.source = source;
  if (ref) out.ref = ref;
  if (locale) out.locale = locale;
  return out;
}

/** Filled on mount, so server rendering and the first client render match. */
export function useTracking(): TrackingValues {
  const [values, setValues] = useState<TrackingValues>({});
  useEffect(() => {
    setValues(trackingFromDocument({ search: window.location.search, cookie: document.cookie, lang: document.documentElement.lang }));
  }, []);
  return values;
}
