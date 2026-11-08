/**
 * Where this deployment lives on its host (SUITE.md, "BASE_PATH"). Each client has its own subdomain; Base Air for the
 * client `imaginesurrey` is served at `https://imaginesurrey.base.win/air`, so BASE_PATH is `/air`. The front door
 * passes the path on as it is; the server strips the prefix and handles the rest as if it were at the root. Empty
 * means the root (local development), with today's behaviour unchanged.
 */

/** "" or "/a/b": one leading slash, no trailing slash, no empty or dot segments. */
export function normalizeBasePath(raw: string | undefined | null): string {
  const parts = (raw ?? "")
    .trim()
    .split("/")
    .filter((p) => p && p !== "." && p !== "..");
  return parts.length ? `/${parts.join("/")}` : "";
}

/** Paths that answer without the prefix too, so the host's health check works whichever way it asks. */
export const UNPREFIXED_HEALTH_PATHS = ["/api/health"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fetch = (req: Request, ...rest: any[]) => Response | Promise<Response>;

/**
 * Wrap the app's fetch so it serves under `basePath`:
 * - `${basePath}` and `${basePath}/…` are handled as `/` and `/…`;
 * - `/api/health` answers as usual without the prefix;
 * - anything else without the prefix gets a 308 to the same path (and query) under it.
 */
export function withBasePath<F extends Fetch>(fetch: F, basePath: string): F {
  const base = normalizeBasePath(basePath);
  if (!base) return fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = (req: Request, ...rest: any[]) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === base || path.startsWith(`${base}/`)) {
      url.pathname = path.slice(base.length) || "/";
      return fetch(rewrite(req, url), ...rest);
    }
    if ((UNPREFIXED_HEALTH_PATHS as readonly string[]).includes(path)) return fetch(req, ...rest);
    const location = `${base}${path === "/" ? "/" : path}${url.search}`;
    return new Response(null, { status: 308, headers: { location, "cache-control": "no-store" } });
  };
  return wrapped as F;
}

function rewrite(req: Request, url: URL): Request {
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? req.body : undefined,
    redirect: req.redirect,
    signal: req.signal,
    // Node's fetch needs this to pass a streaming body on.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** An absolute path inside the app, under the prefix: `prefixed("/air", "/v1/x")` → `/air/v1/x`. */
export function prefixed(basePath: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBasePath(basePath)}${p}`;
}

/**
 * A `next` path the app may send someone to after signing in: same origin, under the prefix, no scheme or host, no
 * protocol-relative tricks, no backslashes or control characters. Anything else gives `fallback`.
 */
export function safeNextPath(next: string | undefined | null, basePath: string, fallback?: string): string {
  const base = normalizeBasePath(basePath);
  const home = fallback ?? `${base}/`;
  if (!next || typeof next !== "string" || next.length > 2048) return home;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return home;
  if (!next.startsWith("/") || next.startsWith("//")) return home;
  let url: URL;
  try {
    url = new URL(next, "http://same.origin");
  } catch {
    return home;
  }
  if (url.origin !== "http://same.origin") return home;
  const path = url.pathname;
  // Resolve dot segments (URL already did) and insist the result is still under the prefix.
  if (base && path !== base && !path.startsWith(`${base}/`)) return home;
  return `${path}${url.search}${url.hash}`;
}

/**
 * The client's IP from X-Forwarded-For. Each proxy appends the address it received the request from, so the
 * client is `trustedProxies` entries from the right: 0 when the host's own load balancer is the only proxy (its
 * entry is the client), 1 (the default) when Base's front door sits behind that load balancer, which makes the
 * client the second-to-last entry. Setting: BASE_AIR_TRUSTED_PROXIES.
 */
export function clientIpFrom(header: (name: string) => string | undefined, trustedProxies = 1): string | null {
  const xff = header("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length) return hops[Math.max(0, hops.length - 1 - Math.max(0, Math.floor(trustedProxies)))] ?? null;
  }
  return header("x-real-ip")?.trim() || header("cf-connecting-ip")?.trim() || null;
}

export function trustedProxiesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BASE_AIR_TRUSTED_PROXIES?.trim();
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}
