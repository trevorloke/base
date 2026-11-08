import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { CoreError, type BaseAir } from "@base-air/core";
import type { Env } from "./app.ts";
import { meta, readSessionCookie, setSessionCookie, type AuthRouteOptions } from "./auth-routes.ts";
import { normalizeBasePath, safeNextPath } from "./base-path.ts";

/**
 * Sign in with Base: the consumer side of SUITE.md "The hand-off". Base Ground is the hub; Base Air asks it who the
 * person is and signs them in to their own existing account **by link, not by email**: a Base Ground manager can make
 * a ground login for any address, so the email alone is never enough. The first time, the person proves the account
 * is theirs with its own Base Air password; after that, (client, sub) points at it. No account is ever created here.
 *
 *   GET  /auth/base?next=<path>   → Base Ground's /api/sso/authorize, state kept in a short-lived HttpOnly cookie
 *   GET  /auth/base/callback      → check state, exchange the code server-side; linked: start Base Air's own session;
 *                                   not yet: the "Link your Base Air account" page, the verified hand-off kept
 *                                   server-side behind a ten-minute, single-use, HttpOnly cookie
 *   GET  /auth/base/link          → that page again
 *   POST /auth/base/link          → the account's password (form): link, then sign in
 */

export interface SsoConfig {
  /** BASE_GROUND_URL: Base Ground's public address, the root of the client's subdomain (the browser is sent here). */
  groundUrl: string;
  /** BASE_GROUND_INTERNAL_URL: Base Ground over the private network, for the token call. May be a bare host:port. */
  groundInternalUrl?: string;
  /** BASE_SSO_SECRET: shared with Base Ground (its BASE_AIR_SSO_SECRET). */
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
 * origin is used — `http://` is assumed when it has no scheme — followed by the path of BASE_GROUND_URL (none when Base
 * Ground is at the root of the client's subdomain, as SUITE.md has it), so the call reaches the same route the browser
 * would.
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
/** Holds the token of a verified hand-off waiting for the account's password (never the identity itself). */
export const SSO_LINK_COOKIE = "base_air_sso_link";
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

/** What a hand-off page offers below its text: a button to the sign-in page (default), or the password form. */
type PageAction = { kind: "home"; label?: string; href?: string } | { kind: "link"; action: string; email: string; error?: string };

/** A small page in Base Air's look for the ways a hand-off can end without a session, and for linking an account. */
export function handoffPage(title: string, body: string, home: string, action: PageAction = { kind: "home" }): string {
  const foot =
    action.kind === "home"
      ? `<a class="btn" href="${esc(action.href ?? home)}">${esc(action.label ?? "Go to sign-in")}</a>`
      : `<form method="post" action="${esc(action.action)}" autocomplete="on">
<input type="email" name="username" value="${esc(action.email)}" autocomplete="username" readonly hidden />
<label for="pw">Base Air password for <strong>${esc(action.email)}</strong></label>
<input id="pw" type="password" name="password" autocomplete="current-password" required autofocus maxlength="1024"${action.error ? ` aria-invalid="true" aria-describedby="err"` : ""} />
${action.error ? `<p id="err" class="err" role="alert">${esc(action.error)}</p>` : ""}
<button class="btn" type="submit">Link and sign in</button>
</form>
<p class="small"><a href="${esc(home)}">Not you? Sign in another way</a></p>`;
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>${esc(title)} · Base Air</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--surface:#121a33;--ink:#e6ecff;--muted:#9aa7c7;--primary:#38bdf8;--on-primary:#04121f;--line:#24304f;--bad:#fca5a5}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:30rem;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:28px 28px 24px}
.mark{font:600 14px/1 ui-monospace,"IBM Plex Mono",monospace;letter-spacing:.08em;color:var(--primary);margin-bottom:18px}
h1{font-size:1.3rem;margin:0 0 10px}p{margin:0 0 18px;color:var(--muted)}p.small{font-size:.9rem;margin:16px 0 0}
a{color:var(--primary)}
label{display:block;margin:0 0 6px;color:var(--ink)}
input[type=password]{display:block;width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 12px}
input:focus-visible{outline:3px solid #a78bfa;outline-offset:1px}
.err{color:var(--bad);margin:-4px 0 12px}
.btn{display:inline-block;background:var(--primary);color:var(--on-primary);text-decoration:none;font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:10px;cursor:pointer}
.btn:focus-visible{outline:3px solid #a78bfa;outline-offset:2px}
</style></head>
<body><main><div class="mark">Base Air</div><h1>${esc(title)}</h1><p>${body}</p>${foot}</main></body></html>`;
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const LINK_TITLE = "Link your Base Air account";
const linkBody = (email: string) =>
  `Base Ground says you're ${esc(email)}. The first time you sign in this way, enter the password of the Base Air account for that address, so Base Air knows it's yours. After that, Base Ground signs you straight in.`;

export function registerSsoRoutes(app: Hono<Env>, m: BaseAir, opts: SsoRouteOptions): void {
  const basePath = normalizeBasePath(opts.basePath);
  const home = `${basePath}/`;
  const secure = !!opts.publicUrl?.startsWith("https");
  const stateCookie = { httpOnly: true, sameSite: "Lax" as const, path: basePath || "/", secure };
  // Strict: only this app's own password form ever sends it back.
  const linkCookie = { httpOnly: true, sameSite: "Strict" as const, path: basePath || "/", secure };
  const linkAction = `${basePath}/auth/base/link`;
  const doFetch = opts.fetch ?? fetch;
  /** This app's callback, as Base Ground must see it (it checks it begins with BASE_AIR_URL + "/"). */
  const redirectUri = (c: Context<Env>) => `${(opts.publicUrl ?? `${new URL(c.req.url).origin}${basePath}`).replace(/\/+$/, "")}/auth/base/callback`;
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  const page = (c: Context<Env>, status: 200 | 400 | 401 | 403 | 404 | 409 | 429 | 502, title: string, body: string, action?: PageAction) =>
    c.html(handoffPage(title, body, home, action), status, headers);
  const notSetUp = (c: Context<Env>) => page(c, 404, "Sign in with Base isn't set up here", "This Base Air has no link to Base Ground yet. Sign in with your email and password instead.");
  const expired = (c: Context<Env>) => page(c, 400, "That sign-in expired", "Linking your account has to finish within ten minutes, once. Start again from Base Ground or the sign-in page.");
  /** Sign the person in, replacing whatever session this browser had, exactly as signing in with a password does. */
  const signIn = async (c: Context<Env>, token: string) => {
    await m.auth.logout(readSessionCookie(c, opts));
    setSessionCookie(c, token, opts);
  };

  app.get("/auth/base", async (c) => {
    const cfg = opts.sso;
    if (!cfg) return notSetUp(c);
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
      return notSetUp(c);
    }
    const raw = getCookie(c, SSO_STATE_COOKIE) ?? "";
    deleteCookie(c, SSO_STATE_COOKIE, stateCookie); // one try per start
    const [want, nextB64] = raw.split(".");
    const state = c.req.query("state") ?? "";
    if (!want || !state || !sameSecret(want, state)) {
      await m.auth.recordBaseHandoff({ outcome: "bad_state", ip });
      return page(c, 400, "That sign-in didn't finish", "The sign-in link expired or was opened in a different browser. Start again from Base Ground or the sign-in page.");
    }
    const next = safeNextPath(nextB64 ? Buffer.from(nextB64, "base64url").toString("utf8") : null, basePath);
    const code = c.req.query("code");
    if (!code) {
      await m.auth.recordBaseHandoff({ outcome: "invalid_grant", ip, detail: c.req.query("error") ?? "missing code" });
      return page(c, 400, "Base Ground didn't sign you in", "No sign-in code came back. Start again, or sign in with your email and password.");
    }

    type Answer = { sub?: unknown; email?: unknown; name?: unknown; client?: unknown };
    let who: Answer | null = null as Answer | null;
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
        return page(c, 400, "That sign-in didn't finish", "Base Ground didn't accept the sign-in (it may have expired). Start again.");
      }
      if (!res.ok) throw new Error(`Base Ground answered ${res.status}`);
      who = (await res.json()) as Answer;
    } catch (e) {
      await m.auth.recordBaseHandoff({ outcome: "ground_error", ip, detail: (e as Error).message.slice(0, 200) });
      return page(c, 502, "Base Ground isn't answering", "Base Air couldn't confirm who you are with Base Ground. Try again in a minute, or sign in with your email and password.");
    }
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const [sub, client, email] = [str(who?.sub), str(who?.client), str(who?.email)];
    if (!sub || !client || sub.length > 200 || client.length > 200) {
      await m.auth.recordBaseHandoff({ outcome: "ground_error", ip, email: email || null, detail: "no sub or client in the answer" });
      return page(c, 502, "Base Ground isn't answering", "Base Ground's answer didn't say who you are. Try again, or sign in with your email and password.");
    }

    const r = await m.auth.signInFromBase({ client, sub, email, name: str(who?.name) || null }, meta(c, opts), next);
    switch (r.kind) {
      case "signed_in":
        await signIn(c, r.token);
        return c.redirect(r.next, 302);
      case "link_required":
        setCookie(c, SSO_LINK_COOKIE, r.pendingToken, { ...linkCookie, maxAge: Math.floor((r.expiresAt.getTime() - m.ctx.now().getTime()) / 1000) });
        return page(c, 200, LINK_TITLE, linkBody(r.email), { kind: "link", action: linkAction, email: r.email });
      case "linked_elsewhere":
        return page(
          c,
          403,
          "Already linked to another login",
          `The Base Air account for ${esc(r.email)} is linked to a different Base Ground login, so Base Air won't sign you in to it from this one. If that's wrong, ask an owner to remove the old link (Team), then try again — or sign in with your email and password.`,
        );
      case "no_password":
        return page(
          c,
          403,
          "Set a Base Air password first",
          `The Base Air account for ${esc(r.email)} has no password yet, and linking it to Base Ground needs one. Set one with "Forgot password?" on the sign-in page, then sign in with Base again.`,
          { kind: "home", label: "Set a password", href: `${home}?forgot=1` },
        );
      case "no_account":
        return page(c, 403, "No Base Air account", `No Base Air account for ${esc(r.email || "that address")} — ask an owner to invite you.`);
    }
  });

  /** The password page again (a refresh, or back from a typo). Shows nothing once the pending link is gone. */
  app.get("/auth/base/link", async (c) => {
    if (!opts.sso) return notSetUp(c);
    const pending = await m.auth.pendingBaseLink(getCookie(c, SSO_LINK_COOKIE));
    if (!pending) {
      deleteCookie(c, SSO_LINK_COOKIE, linkCookie);
      return expired(c);
    }
    return page(c, 200, LINK_TITLE, linkBody(pending.email), { kind: "link", action: linkAction, email: pending.email });
  });

  app.post("/auth/base/link", async (c) => {
    if (!opts.sso) return notSetUp(c);
    // Same-origin only. The cookie is SameSite=Strict too; this also covers browsers that send Origin but not that.
    const origin = c.req.header("origin");
    const ours = opts.publicUrl ? new URL(opts.publicUrl).origin : new URL(c.req.url).origin;
    if (origin && origin !== "null" && origin !== ours) return page(c, 403, "That sign-in didn't finish", "That form came from somewhere else. Start again from Base Ground.");
    const token = getCookie(c, SSO_LINK_COOKIE);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const password = typeof form.password === "string" ? form.password : "";
    try {
      const r = await m.auth.completeBaseLink(token, password, meta(c, opts));
      deleteCookie(c, SSO_LINK_COOKIE, linkCookie);
      await signIn(c, r.token);
      return c.redirect(r.next, 303);
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      if (e.code === "unauthorized" || e.code === "rate_limited") {
        const pending = await m.auth.pendingBaseLink(token);
        if (!pending) {
          deleteCookie(c, SSO_LINK_COOKIE, linkCookie);
          return expired(c);
        }
        const wait = Math.max(1, Math.ceil(Number((e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 60) / 60));
        const error = e.code === "rate_limited" ? `Too many wrong passwords. Try again in ${wait} minute${wait === 1 ? "" : "s"}.` : "That isn't the password for this Base Air account. Try again, or use “Forgot password?” on the sign-in page.";
        return page(c, e.code === "rate_limited" ? 429 : 401, LINK_TITLE, linkBody(pending.email), { kind: "link", action: linkAction, email: pending.email, error });
      }
      deleteCookie(c, SSO_LINK_COOKIE, linkCookie);
      if (e.code === "conflict") return page(c, 409, "Already linked to another login", `${esc(sentenceCase(e.message))}. Ask an owner to remove the old link (Team), then try again.`);
      return expired(c);
    }
  });

  /** For the sign-in screen and the Base switcher (public: the addresses of this client's own apps). */
  app.get("/api/suite", (c) => c.json(suiteInfo(opts.sso, opts.suite ?? {})));
}

const sentenceCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** What the browser needs to show "Sign in with Base" and the switcher. Also written into index.html. */
export function suiteInfo(sso: SsoConfig | null, links: SuiteLinks): { signInWithBase: boolean; groundUrl: string | null; webUrl: string | null } {
  return { signInWithBase: !!sso, groundUrl: links.groundUrl ?? null, webUrl: links.webUrl ?? null };
}

