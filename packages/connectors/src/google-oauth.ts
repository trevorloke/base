import { z } from "zod";
import { asNetworkError, classifyHttpStatus, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import { ConnectorError } from "./types.ts";

/**
 * Shared Google plumbing for the YouTube and Google Business Profile connectors: one Google Cloud OAuth client
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), separate scopes per connector, and one error mapper for the
 * two error shapes Google APIs answer with (legacy `error.errors[].reason` and AIP-193 `error.status` + `details`).
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The credential blob both Google connectors store. Connector-specific ids (channelId, locationName) ride alongside. */
export const GoogleAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** ISO time the access token expires (Google issues 1-hour tokens). Core refreshes 5 minutes before. */
  expiresAt: z.string().optional(),
  scope: z.string().optional(),
});
export type GoogleAuth = z.infer<typeof GoogleAuth>;

export interface GoogleOAuthOptions {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike | undefined;
  now?: (() => Date) | undefined;
}

/** Google credentials from the environment: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. */
export function googleClientFromEnv(env: NodeJS.ProcessEnv): { clientId?: string; clientSecret?: string } {
  return clientFromEnv(env, "GOOGLE");
}

/**
 * An OAuth2Client for Google's web-server flow. `access_type=offline` + `prompt=consent` make Google issue a
 * refresh token on every consent (without prompt=consent it only does so the first time a user grants the app).
 * PKCE (S256) is supported by Google for web clients and is sent as an extra safeguard; the secret is still required.
 */
export function googleOAuthClient(name: string, scopes: string[], opts: GoogleOAuthOptions): OAuth2Client {
  return new OAuth2Client(
    {
      name,
      authorizeUrl: GOOGLE_AUTHORIZE_URL,
      tokenUrl: GOOGLE_TOKEN_URL,
      scopes,
      pkce: true,
      clientAuth: "body",
      extraAuthorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
    },
    opts.fetch,
    opts.now,
  );
}

/** Token response → the stored blob. */
export function googleTokenToAuth(t: OAuth2Token): GoogleAuth {
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
  };
}

/**
 * Refresh a Google access token. Google does not rotate refresh tokens (OAuth2Client keeps the old one when the
 * response omits it), so several accounts that came from one login may each hold a copy safely.
 * Returns null when there is no refresh token: the person has to reconnect.
 */
export async function refreshGoogleAuth<T extends GoogleAuth>(client: OAuth2Client, auth: T): Promise<T | null> {
  if (!auth.refreshToken) return null;
  if (!client.configured || !client.config.clientSecret) {
    throw new ConnectorError(`${client.config.name} refreshAuth: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured`, "auth", false);
  }
  const t = await client.refresh(auth.refreshToken);
  // invalid_grant (revoked, password change, 7-day expiry for apps in "Testing" status) surfaces as kind "auth" from OAuth2Client.
  return { ...auth, ...googleTokenToAuth(t) };
}

/** Attached as `cause` on every ConnectorError raised from a Google HTTP response. */
export interface GoogleHttpFailure {
  status: number;
  reason: string | undefined;
  body: unknown;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string; domain?: string }[];
    details?: { "@type"?: string; reason?: string; metadata?: Record<string, string> }[];
  };
}

/** The most specific machine-readable reason in a Google error body. */
export function googleErrorReason(body: unknown): string | undefined {
  const err = (body as GoogleErrorBody | undefined)?.error;
  if (!err || typeof err !== "object") return undefined;
  const legacy = err.errors?.find((e) => typeof e.reason === "string")?.reason;
  const detail = err.details?.find((d) => typeof d.reason === "string")?.reason;
  return legacy ?? detail ?? err.status;
}

function googleErrorMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  const err = (body as GoogleErrorBody | undefined)?.error;
  return typeof err?.message === "string" ? err.message : "";
}

/** Reasons that mean "you are out of quota or going too fast", whatever the HTTP status (YouTube uses 403). */
const RATE_REASONS = new Set([
  "quotaExceeded",
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "uploadLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);

/** Reasons that mean the credential or project setup is wrong, which no retry fixes. */
const AUTH_REASONS = new Set([
  "authError",
  "insufficientPermissions",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "accessNotConfigured",
  "SERVICE_DISABLED",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "youtubeSignupRequired",
]);

export interface GoogleErrorContext {
  /** e.g. "youtube videos.insert". */
  what: string;
  /** A create/update: a 403 that is not about credentials means the request itself was refused. */
  creating?: boolean;
  /** Extra hint appended to rate-limit messages (quota reset time, access form). */
  rateHint?: string;
}

/** Google HTTP failure → ConnectorError. Quota errors become rate_limit regardless of status (YouTube answers 403). */
export function mapGoogleError(status: number, headers: Headers, body: unknown, ctx: GoogleErrorContext): ConnectorError {
  const reason = googleErrorReason(body);
  const detail = googleErrorMessage(body);
  const msg = `${ctx.what}: HTTP ${status}${reason ? ` ${reason}` : ""}${detail ? `: ${detail}` : ""}`;
  const cause: GoogleHttpFailure = { status, reason, body };
  if (status === 429 || (reason && RATE_REASONS.has(reason))) {
    const retryAfter = headers.get("retry-after");
    const hint = [retryAfter ? `retry after ${retryAfter}s` : null, ctx.rateHint ?? null].filter(Boolean).join("; ");
    return new ConnectorError(`${msg}${hint ? ` (${hint})` : ""}`, "rate_limit", true, cause);
  }
  if (status === 401) return new ConnectorError(`${msg} (access token rejected; refreshAuth() mints a new one from the refresh token)`, "auth", false, cause);
  if (status === 403) {
    // A credential/scope/project problem is "auth"; a specific refusal (forbidden, commentsDisabled...) or any refused
    // write is "rejected" so core does not mark a healthy account as needing reconnection.
    if (reason && AUTH_REASONS.has(reason)) return new ConnectorError(msg, "auth", false, cause);
    if (ctx.creating || reason) return new ConnectorError(msg, "rejected", false, cause);
    return new ConnectorError(msg, "auth", false, cause);
  }
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

export function googleStatusOf(err: unknown): number | undefined {
  const cause = err instanceof ConnectorError ? (err.cause as Partial<GoogleHttpFailure> | undefined) : undefined;
  return typeof cause?.status === "number" ? cause.status : undefined;
}

export interface GoogleRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | string[] | undefined>;
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
  ctx: GoogleErrorContext;
}

/** One authenticated JSON call to a Google API. Returns the parsed body (undefined for empty 2xx bodies). */
export async function googleRequest<T>(fetchImpl: FetchLike | undefined, accessToken: string, url: string, opts: GoogleRequestOptions): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, item);
    else u.searchParams.set(k, v);
  }
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(opts.headers ?? {}) };
  let body: string | Uint8Array | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(opts.json);
  } else if (opts.body) {
    body = opts.body;
  }
  let res: Response;
  try {
    res = await resolveFetch(fetchImpl)(u.toString(), { method: opts.method ?? "GET", headers, body: body as RequestInit["body"] });
  } catch (err) {
    throw asNetworkError(err, opts.ctx.what);
  }
  const data = await readJson(res);
  if (!res.ok) throw mapGoogleError(res.status, res.headers, data, opts.ctx);
  return data as T;
}
