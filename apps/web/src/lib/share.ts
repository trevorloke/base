// Share links and tracked URLs. Pure functions, usable on server and client.

/** Add a referral code to a site URL so the sign-up is credited to the sharer. */
export function withRef(url: string, code: string | null | undefined): string {
  if (!code) return url;
  const u = new URL(url, "https://placeholder.invalid");
  u.searchParams.set("ref", code);
  return url.startsWith("http") ? u.toString() : u.pathname + u.search + u.hash;
}

/** Tag a site URL with where it was shared, e.g. "whatsapp", "email-nov-2026". */
export function withSource(url: string, source: string | null | undefined): string {
  if (!source) return url;
  const u = new URL(url, "https://placeholder.invalid");
  u.searchParams.set("source", source);
  return url.startsWith("http") ? u.toString() : u.pathname + u.search + u.hash;
}

export type ShareLinks = { whatsapp: string; sms: string; x: string; facebook: string; email: string; copy: string };

/**
 * Links for a share sheet. WhatsApp first: it is the most used messaging app
 * in Surrey's communities and the channel relational organizing runs on.
 */
export function shareLinks(input: { url: string; text: string; subject?: string }): ShareLinks {
  const { url, text } = input;
  const message = `${text} ${url}`;
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(message)}`,
    sms: `sms:?&body=${encodeURIComponent(message)}`,
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    email: `mailto:?subject=${encodeURIComponent(input.subject ?? text)}&body=${encodeURIComponent(message)}`,
    copy: url,
  };
}

/** The query-string values a form should carry along, read on the client. */
export function trackingFromLocation(search: string): { source?: string; ref?: string } {
  const p = new URLSearchParams(search);
  const source = p.get("source")?.slice(0, 80) || undefined;
  const ref = p.get("ref")?.slice(0, 20) || undefined;
  return { source, ref };
}

export const TRACKING_COOKIE = "is_track";
