import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import type { AdminUser, LoginResult } from "./admin-auth";

// "Sign in with base": base ground is the sign-in hub (SUITE.md, "Signing in
// once"). The admin sends the browser to ground's authorize endpoint with a
// random state kept in a short-lived cookie; ground sends it back to
// /auth/base/callback with a one-time code, which this server exchanges for
// the person's email over a server-to-server call with the shared secret.
// The email signs in the existing staff account with that address; the
// two-factor step still applies to the roles that need it.

/** The state cookie: `<state>.<next, base64url>.<hmac>`, HttpOnly, SameSite=Lax. */
export const STATE_COOKIE = "base_sso_state";
export const STATE_COOKIE_PATH = "/auth/base";
export const STATE_MINUTES = 10;
export const CALLBACK_PATH = "/auth/base/callback";
const EXCHANGE_TIMEOUT_MS = 10_000;

export type SsoConfig = {
  /** base ground's public address, e.g. https://base.win/imaginesurrey (the browser goes here). */
  groundUrl: string;
  /** Optional private address for the token call: a URL or a bare host:port. */
  internalUrl?: string;
  /** BASE_SSO_SECRET, shared with ground (its BASE_WEB_SSO_SECRET). */
  secret: string;
  /** This site's public address (NEXT_PUBLIC_SITE_URL): the callback lives here. */
  siteUrl: string;
  /** Signs the state cookie (ADMIN_SESSION_SECRET). */
  cookieSecret: string;
};

/** The settings for the hand-off, or null when it isn't set up (BASE_GROUND_URL and BASE_SSO_SECRET). */
export function ssoConfig(): SsoConfig | null {
  const groundUrl = env.baseGroundUrl;
  const secret = env.baseSsoSecret;
  if (!groundUrl || !secret) return null;
  return { groundUrl, internalUrl: env.baseGroundInternalUrl, secret, siteUrl: env.siteUrl, cookieSecret: env.adminSessionSecret };
}

/**
 * A `next` that stays on this site: a relative path starting with a single
 * "/", with no backslashes, whitespace or control characters (browsers read
 * "//host", "/\host" and "\/host" as another site). Anything else is the
 * admin's home.
 */
export function safeRelativePath(value: unknown, fallback = "/admin"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return fallback;
  // Percent-encoded slashes or backslashes right after the first "/" could be
  // decoded into "//" by something downstream; there's no reason to allow them.
  if (/^\/(%2f|%5c)/i.test(value)) return fallback;
  return value;
}

/**
 * Where the code is exchanged. With BASE_GROUND_INTERNAL_URL (on Render,
 * the private "hostport", e.g. base-ground-imaginesurrey:10000), that is an
 * origin only: http:// is added when it has no scheme, and ground's own path
 * prefix comes from BASE_GROUND_URL (e.g. /imaginesurrey).
 */
export function tokenEndpoint(groundUrl: string, internalUrl?: string): string {
  const publicUrl = new URL(groundUrl);
  const prefix = publicUrl.pathname.replace(/\/+$/, "");
  if (!internalUrl) return `${publicUrl.origin}${prefix}/api/sso/token`;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(internalUrl) ? internalUrl : `http://${internalUrl}`;
  return `${new URL(withScheme).origin}${prefix}/api/sso/token`;
}

export function callbackUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`base-sso:${payload}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Step 1: where to send the browser, and the state cookie's value. */
export function startHandOff(config: SsoConfig, next: string, random: (n: number) => Buffer = randomBytes): { location: string; cookie: string; state: string } {
  const state = random(32).toString("base64url");
  const nextPart = Buffer.from(safeRelativePath(next)).toString("base64url");
  const cookie = `${state}.${nextPart}.${mac(config.cookieSecret, `${state}.${nextPart}`)}`;
  const authorize = new URL(`${config.groundUrl.replace(/\/+$/, "")}/api/sso/authorize`);
  authorize.searchParams.set("app", "web");
  authorize.searchParams.set("redirect_uri", callbackUrl(config.siteUrl));
  authorize.searchParams.set("state", state);
  return { location: authorize.toString(), cookie, state };
}

/** The state and next carried by a cookie this server signed, or null. */
export function readStateCookie(value: string | undefined, cookieSecret: string): { state: string; next: string } | null {
  if (!value) return null;
  const [state, nextPart, signature] = value.split(".");
  if (!state || !nextPart || !signature) return null;
  if (!safeEqual(signature, mac(cookieSecret, `${state}.${nextPart}`))) return null;
  return { state, next: safeRelativePath(Buffer.from(nextPart, "base64url").toString("utf8")) };
}

export type GroundIdentity = { email: string; name?: string; role?: string; areas?: unknown; organization?: string; client?: string };

export type Exchange = { ok: true; identity: GroundIdentity } | { ok: false; reason: "invalid_grant" | "unreachable" | "bad-answer" };

/** Step 4: the code for the person's identity, from this server to ground's. */
export async function exchangeCode(config: SsoConfig, code: string, fetchFn: typeof fetch = fetch): Promise<Exchange> {
  let res: Response;
  try {
    res = await fetchFn(tokenEndpoint(config.groundUrl, config.internalUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.secret}`, accept: "application/json" },
      body: JSON.stringify({ code, redirect_uri: callbackUrl(config.siteUrl) }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, reason: "invalid_grant" };
  if (!res.ok) return { ok: false, reason: "unreachable" };
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@") || email.length > 320) return { ok: false, reason: "bad-answer" };
  const text = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string).slice(0, 200) : undefined);
  return { ok: true, identity: { email, name: text("name"), role: text("role"), areas: body?.areas, organization: text("organization"), client: text("client") } };
}

/** Why a hand-off didn't sign anyone in; each is a message on the sign-in page. */
export type HandOffError = "base-not-configured" | "base-state" | "base-denied" | "base-refused" | "base-unreachable" | "base-no-account";

export type HandOffOutcome =
  | { kind: "session"; next: string; cookie: { value: string; maxAge: number }; user: AdminUser }
  | { kind: "second-step"; pending: { value: string; maxAge: number }; user: AdminUser }
  | { kind: "refused"; error: HandOffError; email?: string };

export type HandOffDeps = {
  fetch?: typeof fetch;
  /** loginWithBase: the existing staff account for this email, then a session or the second step. */
  login: (email: string, next: string) => Promise<LoginResult>;
  /** Writes one audit entry. Every hand-off is recorded, refused or not. */
  audit: (user: AdminUser | null, action: string, details: Record<string, unknown>) => Promise<void>;
};

/** Steps 4 to 6, at /auth/base/callback. */
export async function finishHandOff(
  config: SsoConfig | null,
  query: { code?: string | null; state?: string | null; error?: string | null },
  stateCookie: string | undefined,
  deps: HandOffDeps,
): Promise<HandOffOutcome> {
  const refuse = async (error: HandOffError, details: Record<string, unknown> = {}, email?: string): Promise<HandOffOutcome> => {
    await deps.audit(null, "signin.base-refused", { reason: error, ...details });
    return { kind: "refused", error, email };
  };
  if (!config) return refuse("base-not-configured");
  const saved = readStateCookie(stateCookie, config.cookieSecret);
  const state = query.state ?? "";
  if (!saved || !state || !safeEqual(saved.state, state)) return refuse("base-state");
  if (query.error) return refuse("base-denied", { groundError: query.error.slice(0, 100) });
  const code = query.code ?? "";
  if (!code || code.length > 200) return refuse("base-refused");

  const exchange = await exchangeCode(config, code, deps.fetch);
  if (!exchange.ok) return refuse(exchange.reason === "invalid_grant" ? "base-refused" : "base-unreachable", { exchange: exchange.reason });
  const { email, client } = exchange.identity;

  const result = await deps.login(email, saved.next);
  if (result.ok === false) return refuse("base-no-account", { email, client }, email);
  if (result.ok === "second-step") {
    await deps.audit(result.user, "signin.base", { outcome: "second-step", client });
    return { kind: "second-step", pending: result.pending, user: result.user };
  }
  await deps.audit(result.user, "signin", { method: "base", client });
  return { kind: "session", next: saved.next, cookie: result.cookie, user: result.user };
}
