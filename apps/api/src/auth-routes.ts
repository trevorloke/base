import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { CoreError, SESSION_TTL_MS, type RequestMeta, type ResolvedSession, type Starsign } from "@starsign/core";
import type { Env } from "./app.ts";

export const SESSION_COOKIE = "starsign_session";
export const CSRF_HEADER = "x-starsign-csrf";

export interface AuthRouteOptions {
  /** Public base URL. https → the session cookie is Secure; also the base of invite and reset links. */
  publicUrl?: string;
}

type C = Context<Env>;

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const isWrite = (method: string) => WRITES.has(method.toUpperCase());
export const csrfOk = (c: C) => c.req.header(CSRF_HEADER) === "1";

const PUBLIC_POSTS = new Set(["/v1/auth/signup", "/v1/auth/login", "/v1/auth/logout", "/v1/auth/forgot", "/v1/auth/reset", "/v1/auth/accept-invite"]);
/** Routes that answer without credentials. Each handles an optional session itself. */
export function isPublicAuthRoute(method: string, path: string): boolean {
  if (method === "POST") return PUBLIC_POSTS.has(path);
  if (method === "GET") return /^\/v1\/invites\/[^/]+$/.test(path);
  return false;
}
/** Routes a signed-in person with no workspace (removed from all of them) can still use. */
export function allowedWithoutWorkspace(method: string, path: string): boolean {
  return path.startsWith("/v1/auth/") || (method === "POST" && path === "/v1/workspaces");
}

const cookieBase = (opts: AuthRouteOptions) => ({ httpOnly: true, sameSite: "Lax" as const, path: "/", secure: !!opts.publicUrl?.startsWith("https") });
export function setSessionCookie(c: C, token: string, opts: AuthRouteOptions): void {
  setCookie(c, SESSION_COOKIE, token, { ...cookieBase(opts), maxAge: Math.floor(SESSION_TTL_MS / 1000) });
}
export function clearSessionCookie(c: C, opts: AuthRouteOptions): void {
  deleteCookie(c, SESSION_COOKIE, cookieBase(opts));
}

function meta(c: C): RequestMeta {
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return { userAgent: c.req.header("user-agent") ?? null, ip: fwd || c.req.header("x-real-ip") || null };
}

/**
 * Session-creating routes take JSON only. A cross-site HTML form cannot send application/json without a CORS
 * preflight, so this closes login CSRF (an attacker signing the victim into the attacker's account).
 */
async function jsonBody(c: C): Promise<unknown> {
  if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) throw new CoreError("invalid", "send a JSON body (content-type: application/json)");
  return c.req.json();
}

function needSession(c: C): ResolvedSession {
  const s = c.get("session");
  if (!s) throw new CoreError("unauthorized", "sign in first: this route needs a signed-in person, not an API key");
  return s;
}

/** People: sign-up, sign-in, sessions, workspaces, members, invites, password reset. See docs/API.md (v1.2). */
export function registerAuthRoutes(app: Hono<Env>, m: Starsign, opts: AuthRouteOptions = {}): void {
  /** A cookie on a public write counts only with the CSRF header; without it the request is anonymous. */
  const optionalSession = async (c: C) => (csrfOk(c) ? m.auth.resolveSession(getCookie(c, SESSION_COOKIE)) : null);
  /** Signing in again replaces whatever session this browser had. */
  const replaceSession = async (c: C, token: string) => {
    await m.auth.logout(getCookie(c, SESSION_COOKIE));
    setSessionCookie(c, token, opts);
  };

  app.post("/v1/auth/signup", async (c) => {
    const r = await m.auth.signup(await jsonBody(c), meta(c));
    await replaceSession(c, r.token);
    return c.json(r.view, 201);
  });

  app.post("/v1/auth/login", async (c) => {
    const r = await m.auth.login(await jsonBody(c), meta(c));
    await replaceSession(c, r.token);
    return c.json(r.view);
  });

  app.post("/v1/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      if (!csrfOk(c)) throw new CoreError("forbidden", `cookie-authenticated writes must send ${CSRF_HEADER}: 1`);
      await m.auth.logout(token);
    }
    clearSessionCookie(c, opts);
    return c.body(null, 204);
  });

  app.get("/v1/auth/session", async (c) => {
    const s = needSession(c);
    return c.json(await m.auth.view(s.user.id, s.currentWorkspaceId));
  });

  app.post("/v1/auth/switch", async (c) => {
    const s = needSession(c);
    const body = z.object({ workspaceId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await m.auth.switchWorkspace(s, body.workspaceId));
  });

  app.post("/v1/auth/forgot", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    await m.auth.requestPasswordReset(body?.email, opts.publicUrl);
    return c.body(null, 204);
  });

  app.post("/v1/auth/reset", async (c) => {
    await m.auth.resetPassword(await c.req.json());
    clearSessionCookie(c, opts);
    return c.body(null, 204);
  });

  app.post("/v1/auth/accept-invite", async (c) => {
    const body = await jsonBody(c);
    const r = await m.auth.acceptInvite(body, await optionalSession(c), meta(c));
    setSessionCookie(c, r.token, opts);
    return c.json(r.view);
  });

  app.get("/v1/invites/:token", async (c) => c.json(await m.auth.viewInvite(c.req.param("token"))));

  // ---------------------------------------------------------------- workspaces, members, invites (authenticated)
  app.post("/v1/workspaces", async (c) => {
    const s = c.get("session");
    if (!s) throw new CoreError("forbidden", "creating a workspace needs a signed-in person");
    return c.json(await m.auth.createWorkspace(s.user.id, await c.req.json()), 201);
  });

  app.get("/v1/members", async (c) => c.json(await m.auth.listMembers(c.get("principal"))));
  app.patch("/v1/members/:id", async (c) => {
    const body = (await c.req.json()) as { role?: unknown };
    return c.json(await m.auth.updateMemberRole(c.get("principal"), c.req.param("id"), body.role));
  });
  app.delete("/v1/members/:id", async (c) => {
    await m.auth.removeMember(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/v1/invites", async (c) => c.json(await m.auth.createInvite(c.get("principal"), await c.req.json(), opts.publicUrl), 201));
  /** Pending invites (owners only). GET /v1/invites/:token stays the public peek at one invite. */
  app.get("/v1/invites", async (c) => c.json(await m.auth.listInvites(c.get("principal"))));
  app.delete("/v1/invites/:id", async (c) => {
    await m.auth.revokeInvite(c.get("principal"), c.req.param("id"));
    return c.body(null, 204);
  });
}
