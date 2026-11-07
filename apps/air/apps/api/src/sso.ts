import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { BaseAir } from "@base-air/core";
import type { Env } from "./app.ts";
import { meta, readSessionCookie, setSessionCookie, type AuthRouteOptions } from "./auth-routes.ts";
import { normalizeBasePath, safeNextPath } from "./base-path.ts";

/**
 * Sign in with base: the consumer side of SUITE.md "The hand-off". base ground is the hub; base air asks it who the
 * person is and signs them in to their own existing account with the same email. No account is ever created here.
 *
 *   GET /auth/base?next=<path>     → base ground's /api/sso/authorize, state kept in a short-lived HttpOnly cookie
 *   GET /auth/base/callback        → check state, exchange the code server-side, start base air's own session
 */

export interface SsoConfig {
  /** BASE_GROUND_URL: base ground's public address, prefix included (the browser is sent here). */
  groundUrl: string;
  /** BASE_GROUND_INTERNAL_URL: base ground over the private network, for the token call. May be a bare host:port. */
  groundInternalUrl?: string;
  /** BASE_SSO_SECRET: shared with base ground (its BASE_AIR_SSO_SECRET). */
  secret: string;
}

export interface SuiteLinks {
  /** BASE_GROUND_URL */
  groundUrl?: string;
  /** BASE_WEB_URL: the client's website, whose admin lives at /admin. */
  webUrl?: string;
}

export function ssoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SsoConfig | null {
  const groundUrl = env.BASE_GROUND_URL?.trim();
  const secret = env.BASE_SSO_SECRET?.trim();
  if (!groundUrl || !secret) return null;
  const internal = env.BASE_GROUND_INTERNAL_URL?.trim();
  return { groundUrl: groundUrl.replace(/\/+$/, ""), secret, ...(internal ? { groundInternalUrl: internal } : {}) };
}

export function suiteLinksFromEnv(env: NodeJS.ProcessEnv = process.env): SuiteLinks {
  const g = env.BASE_GROUND_URL?.trim().replace(/\/+$/, "");
  const w = env.BASE_WEB_URL?.trim().replace(/\/+$/, "");
  return { ...(g ? { groundUrl: g } : {}), ...(w ? { webUrl: w } : {}) };
}

/**
 * Where to post the code. With an internal URL (Render's private "hostport", often a bare `host:port`), only its
 * origin is used — `http://` is assumed when it has no scheme — followed by the path of BASE_GROUND_URL (ground's own
 * prefix, e.g. /imaginesurrey), so the call reaches the same route the browser would.
 */
export function tokenEndpoint(cfg: Pick<SsoConfig, "groundUrl" | "groundInternalUrl">): string {
  const pub = new URL(cfg.groundUrl);
  const prefix = pub.pathname.replace(/\/+$/, "");
  let origin = pub.origin;
  if (cfg.groundInternalUrl) {
    const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(cfg.groundInternalUrl) ? cfg.groundInternalUrl : `http://${cfg.groundInternalUrl}`;
    origin = new URL(raw).origin;
  }
  return `${origin}${prefix}/api/sso/token`;
}

export const SSO_STATE_COOKIE = "base_air_sso_state";
const STATE_TTL_SECONDS = 600;
const TOKEN_TIMEOUT_MS = 10_000;

export interface SsoRouteOptions extends AuthRouteOptions {
  sso: SsoConfig | null;
  /** The other apps' addresses, for the switcher. */
  suite?: SuiteLinks;
  /** Test seam: the token call. */
  fetch?: typeof fetch;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A small page in base air's look for the ways a hand-off can end without a session. */
export function handoffPage(title: string, body: string, home: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>${esc(title)} · base air</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--surface:#121a33;--ink:#e6ecff;--muted:#9aa7c7;--primary:#38bdf8;--on-primary:#04121f;--line:#24304f}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:30rem;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:28px 28px 24px}
.mark{font:600 14px/1 ui-monospace,"IBM Plex Mono",monospace;letter-spacing:.08em;color:var(--primary);margin-bottom:18px}
h1{font-size:1.3rem;margin:0 0 10px}p{margin:0 0 18px;color:var(--muted)}
a.btn{display:inline-block;background:var(--primary);color:var(--on-primary);text-decoration:none;font-weight:600;padding:10px 16px;border-radius:10px}
a.btn:focus-visible{outline:3px solid #a78bfa;outline-offset:2px}
</style></head>
<body><main><div class="mark">base air</div><h1>${esc(title)}</h1><p>${body}</p><a class="btn" href="${esc(home)}">Go to sign-in</a></main></body></html>`;
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function registerSsoRoutes(app: Hono<Env>, m: BaseAir, opts: SsoRouteOptions): void {
  const basePath = normalizeBasePath(opts.basePath);
  const home = `${basePath}/`;
  const secure = !!opts.publicUrl?.startsWith("https");
  const stateCookie = { httpOnly: true, sameSite: "Lax" as const, path: basePath || "/", secure };
  const doFetch = opts.fetch ?? fetch;
  /** This app's callback, as base ground must see it (it checks it begins with BASE_AIR_URL + "/"). */
  const redirectUri = (c: Context<Env>) => `${(opts.publicUrl ?? `${new URL(c.req.url).origin}${basePath}`).replace(/\/+$/, "")}/auth/base/callback`;
  const page = (c: Context<Env>, status: 400 | 403 | 404 | 502, title: string, body: string) =>
    c.html(handoffPage(title, body, home), status, { "cache-control": "no-store", "referrer-policy": "no-referrer" });

  app.get("/auth/base", async (c) => {
    const cfg = opts.sso;
    if (!cfg) return page(c, 404, "Sign in with base isn't set up here", "This base air has no link to base ground yet. Sign in with your email and password instead.");
    const next = safeNextPath(c.req.query("next"), basePath);
    const state = randomBytes(32).toString("base64url");
    setCookie(c, SSO_STATE_COOKIE, `${state}.${Buffer.from(next).toString("base64url")}`, { ...stateCookie, maxAge: STATE_TTL_SECONDS });
    const url = new URL(`${cfg.groundUrl}/api/sso/authorize`);
    url.searchParams.set("app", "air");
    url.searchParams.set("redirect_uri", redirectUri(c));
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.get("/auth/base/callback", async (c) => {
    const cfg = opts.sso;
    const ip = meta(c, opts).ip ?? null;
    if (!cfg) {
      await m.auth.recordBaseHandoff({ outcome: "not_configured", ip });
      return page(c, 404, "Sign in with base isn't set up here", "This base air has no link to base ground yet. Sign in with your email and password instead.");
    }
    const raw = getCookie(c, SSO_STATE_COOKIE) ?? "";
    deleteCookie(c, SSO_STATE_COOKIE, stateCookie); // one try per start
    const [want, nextB64] = raw.split(".");
    const state = c.req.query("state") ?? "";
    if (!want || !state || !sameSecret(want, state)) {
      await m.auth.recordBaseHandoff({ outcome: "bad_state", ip });
      return page(c, 400, "That sign-in didn't finish", "The sign-in link expired or was opened in a different browser. Start again from base ground or the sign-in page.");
    }
    const next = safeNextPath(nextB64 ? Buffer.from(nextB64, "base64url").toString("utf8") : null, basePath);
    const code = c.req.query("code");
    if (!code) {
      await m.auth.recordBaseHandoff({ outcome: "invalid_grant", ip, detail: c.req.query("error") ?? "missing code" });
      return page(c, 400, "base ground didn't sign you in", "No sign-in code came back. Start again, or sign in with your email and password.");
    }

    let who: { email?: unknown; name?: unknown } | null = null;
    try {
      const res = await doFetch(tokenEndpoint(cfg), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}`, accept: "application/json" },
        body: JSON.stringify({ code, redirect_uri: redirectUri(c) }),
        redirect: "error",
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      if (res.status === 400) {
        await m.auth.recordBaseHandoff({ outcome: "invalid_grant", ip });
        return page(c, 400, "That sign-in didn't finish", "base ground didn't accept the sign-in (it may have expired). Start again.");
      }
      if (!res.ok) throw new Error(`base ground answered ${res.status}`);
      who = (await res.json()) as { email?: unknown; name?: unknown };
    } catch (e) {
      await m.auth.recordBaseHandoff({ outcome: "ground_error", ip, detail: (e as Error).message.slice(0, 200) });
      return page(c, 502, "base ground isn't answering", "base air couldn't confirm who you are with base ground. Try again in a minute, or sign in with your email and password.");
    }
    const email = typeof who?.email === "string" ? who.email : "";
    if (!email) {
      await m.auth.recordBaseHandoff({ outcome: "ground_error", ip, detail: "no email in the answer" });
      return page(c, 502, "base ground isn't answering", "base ground's answer didn't say who you are. Try again, or sign in with your email and password.");
    }

    const started = await m.auth.signInFromBase(email, meta(c, opts));
    if (!started) {
      return page(c, 403, "No base air account", `No base air account for ${esc(email)} — ask an owner to invite you.`);
    }
    // Replace whatever session this browser had, exactly as signing in with a password does.
    await m.auth.logout(readSessionCookie(c, opts));
    setSessionCookie(c, started.token, opts);
    return c.redirect(next, 302);
  });

  /** For the sign-in screen and the base switcher (public: the addresses of this client's own apps). */
  app.get("/api/suite", (c) => c.json(suiteInfo(opts.sso, opts.suite ?? {})));
}

/** What the browser needs to show "Sign in with base" and the switcher. Also written into index.html. */
export function suiteInfo(sso: SsoConfig | null, links: SuiteLinks): { signInWithBase: boolean; groundUrl: string | null; webUrl: string | null } {
  return { signInWithBase: !!sso, groundUrl: links.groundUrl ?? null, webUrl: links.webUrl ?? null };
}

