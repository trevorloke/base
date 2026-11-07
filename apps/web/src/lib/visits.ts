// First-party visit counting: the pure rules shared by the beacon in the
// browser (src/components/VisitBeacon.tsx) and the route that stores a page
// view (src/app/api/v). No cookies, no IP addresses, no user agents stored.

/** Paths the counter never records: the admin, the supporter portal and the API. */
export const UNTRACKED_PREFIXES = ["/admin", "/me", "/api"] as const;

/** Longest path stored; anything longer is cut, so a crafted URL can't bloat the table. */
export const MAX_PATH_LENGTH = 200;

/** Longest hostname DNS allows. */
const MAX_HOST_LENGTH = 253;

// Crawlers, link previews, monitors, scripts and headless browsers.
const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|scrap|archiver|facebookexternalhit|^whatsapp\/|embedly|preview|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl\/|wget|python|httpclient|http-client|java\/|go-http|node-fetch|undici|axios|okhttp|libwww|phantomjs|puppeteer|playwright|selenium|cypress/i;

/** True for a user agent that looks like a bot, a script or a headless browser (and for none at all). */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua || ua.trim().length < 8) return true;
  return BOT_UA.test(ua);
}

/** True for /admin, /me and /api and anything under them. */
export function isUntrackedPath(path: string): boolean {
  return UNTRACKED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`) || path.startsWith(`${p}#`));
}

/**
 * The path as stored: the query string and fragment dropped, cut to
 * MAX_PATH_LENGTH. Null for anything that isn't a plain site path.
 */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.split(/[?#]/, 1)[0];
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (/[\s\\]/.test(path) || [...path].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null;
  return path.slice(0, MAX_PATH_LENGTH);
}

/** "www.facebook.com" → "facebook.com", lower case. */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * The referring site's hostname and nothing else (no path, no query), or null
 * for none, for anything that isn't an http(s) URL, and for the site's own
 * hosts (moving between pages of this site is not a referral).
 */
export function referrerHost(raw: unknown, ownHosts: readonly string[]): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = bareHost(url.hostname);
  if (!host || host.length > MAX_HOST_LENGTH) return null;
  if (ownHosts.some((h) => bareHost(h) === host)) return null;
  return host;
}
