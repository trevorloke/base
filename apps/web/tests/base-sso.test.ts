// "Sign in with Base" (SUITE.md, "The hand-off"), against a fake Base Ground
// that behaves like the real one: one-time codes bound to the app and the
// redirect_uri, the shared secret checked, and 400 invalid_grant for anything
// wrong. The person is signed in by their link (client + sub), never by the
// email alone; tests/base-link.test.ts covers making a link against a
// database.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

vi.mock("server-only", () => ({}));

const sso = await import("@/lib/server/base-sso");
type LoginResult = import("@/lib/server/admin-auth").LoginResult;
type AdminUser = import("@/lib/server/admin-auth").AdminUser;

const SECRET = "shared-secret-for-web-0123456789";
const config = { groundUrl: "https://imaginesurrey.base.win", secret: SECRET, siteUrl: "https://imaginesurrey.ca", cookieSecret: "cookie-signing-secret-0123456789" };

/** A Base Ground with one signed-in person, answering /api/sso/token like the real one. */
function fakeGround(email: string, opts: { secret?: string; sub?: string | null } = {}) {
  const codes = new Map<string, { email: string; redirectUri: string; used: boolean; expires: number }>();
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const authorize = (location: string) => {
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe("https://imaginesurrey.base.win/api/sso/authorize");
    expect(url.searchParams.get("app")).toBe("web");
    const redirectUri = url.searchParams.get("redirect_uri")!;
    // Ground's own check: the redirect_uri begins with BASE_WEB_URL + "/".
    expect(redirectUri.startsWith("https://imaginesurrey.ca/")).toBe(true);
    const code = randomBytes(32).toString("base64url");
    codes.set(createHash("sha256").update(code).digest("hex"), { email, redirectUri, used: false, expires: Date.now() + 60_000 });
    return { code, state: url.searchParams.get("state")! };
  };
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url: String(input), auth, body });
    const bad = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
    if (auth !== `Bearer ${opts.secret ?? SECRET}`) return bad();
    const entry = codes.get(createHash("sha256").update(String(body.code ?? "")).digest("hex"));
    if (!entry || entry.used || entry.expires < Date.now() || entry.redirectUri !== body.redirect_uri) return bad();
    entry.used = true;
    const sub = opts.sub === undefined ? "ground-user-1" : opts.sub;
    return Response.json({ ...(sub === null ? {} : { sub }), email: entry.email, name: "Pat Organizer", role: "manager", areas: [], organization: "Imagine Surrey", client: "imaginesurrey" });
  }) as typeof fetch;
  return { authorize, fetch: fetchFn, calls };
}

const staff: AdminUser = { id: "00000000-0000-0000-0000-000000000001", email: "pat@example.ca", name: "Pat", role: "organizer" };

type Linked = (link: { client: string; sub: string }, next: string) => Promise<LoginResult | null>;
type Account = { user: AdminUser; linked: boolean } | null;

/** The app's side: which Base Ground login is linked to what, and which staff accounts exist. */
function deps(ground: ReturnType<typeof fakeGround>, linked: Linked, account: Account = null) {
  const audits: { user: AdminUser | null; action: string; details: Record<string, unknown> }[] = [];
  const logins: { link: { client: string; sub: string }; next: string }[] = [];
  const lookups: string[] = [];
  const started: { identity: import("@/lib/server/base-sso").GroundIdentity; user: AdminUser; next: string }[] = [];
  return {
    audits,
    logins,
    lookups,
    started,
    deps: {
      fetch: ground.fetch,
      loginLinked: async (link: { client: string; sub: string }, next: string) => {
        logins.push({ link, next });
        return linked(link, next);
      },
      findAccount: async (email: string) => {
        lookups.push(email);
        return account;
      },
      startLinking: async (identity: import("@/lib/server/base-sso").GroundIdentity, user: AdminUser, next: string) => {
        started.push({ identity, user, next });
        return { value: "waiting-hand-off", maxAge: 900 };
      },
      audit: async (user: AdminUser | null, action: string, details: Record<string, unknown>) => void audits.push({ user, action, details }),
    },
  };
}

const noLink: Linked = async () => null;
const sessionFor = async (): Promise<LoginResult> => ({ ok: true, cookie: { value: "session-cookie", maxAge: 43200 }, user: staff });

describe("sign in with Base: the happy path", () => {
  it("goes to Base Ground, comes back with a code, exchanges it from the server and signs in the linked account", async () => {
    const ground = fakeGround("Pat@Example.ca");
    const start = sso.startHandOff(config, "/admin/people?tag=x");
    const { code, state } = ground.authorize(start.location);
    expect(state).toBe(start.state);
    const t = deps(ground, sessionFor);
    const outcome = await sso.finishHandOff(config, { code, state }, start.cookie, t.deps);

    expect(outcome).toMatchObject({ kind: "session", next: "/admin/people?tag=x", cookie: { value: "session-cookie" } });
    expect(t.logins).toEqual([{ link: { client: "imaginesurrey", sub: "ground-user-1" }, next: "/admin/people?tag=x" }]);
    expect(t.lookups).toEqual([]);
    expect(ground.calls).toHaveLength(1);
    expect(ground.calls[0]).toMatchObject({ url: "https://imaginesurrey.base.win/api/sso/token", auth: `Bearer ${SECRET}`, body: { code, redirect_uri: "https://imaginesurrey.ca/auth/base/callback" } });
    expect(t.audits).toEqual([{ user: staff, action: "signin", details: { method: "base", client: "imaginesurrey", sub: "ground-user-1" } }]);
  });

  it("a linked login is signed in by its sub: the email Base Ground sends is ignored", async () => {
    // The email changed on Base Ground (or names someone else entirely): the link decides.
    const ground = fakeGround("somebody-else@example.org", { sub: "ground-user-1" });
    const start = sso.startHandOff(config, "/admin");
    const t = deps(ground, async (link) => (link.sub === "ground-user-1" ? sessionFor() : null));
    expect(await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps)).toMatchObject({ kind: "session", user: staff });
    expect(t.lookups).toEqual([]);
  });

  it("the authorize URL carries app=web, the callback and the state; the state is 32 random bytes", () => {
    const { location, state, cookie } = sso.startHandOff(config, "/admin");
    const url = new URL(location);
    expect(url.searchParams.get("redirect_uri")).toBe("https://imaginesurrey.ca/auth/base/callback");
    expect(Buffer.from(state, "base64url")).toHaveLength(32);
    expect(cookie.startsWith(`${state}.`)).toBe(true);
    expect(sso.readStateCookie(cookie, config.cookieSecret)).toEqual({ state, next: "/admin" });
  });
});

describe("sign in with Base: refusals", () => {
  it("a state that doesn't match the cookie (or no cookie, or a forged one) stops before ground is called", async () => {
    const ground = fakeGround("pat@example.ca");
    const start = sso.startHandOff(config, "/admin");
    const { code } = ground.authorize(start.location);
    const other = sso.startHandOff(config, "/admin");
    const [s, n] = start.cookie.split(".");
    for (const [state, cookie] of [
      [other.state, start.cookie],
      [start.state, undefined],
      [start.state, other.cookie],
      [start.state, `${s}.${n}.forged`],
      ["", start.cookie],
    ] as const) {
      const t = deps(ground, sessionFor);
      expect(await sso.finishHandOff(config, { code, state }, cookie, t.deps)).toEqual({ kind: "refused", error: "base-state", email: undefined });
      expect(t.logins).toEqual([]);
      expect(t.audits).toEqual([{ user: null, action: "signin.base-refused", details: { reason: "base-state" } }]);
    }
    expect(ground.calls).toEqual([]);
  });

  it("invalid_grant: a code used twice, a wrong secret or a made-up code signs nobody in", async () => {
    const ground = fakeGround("pat@example.ca");
    const start = sso.startHandOff(config, "/admin");
    const { code, state } = ground.authorize(start.location);
    const first = deps(ground, sessionFor);
    expect((await sso.finishHandOff(config, { code, state }, start.cookie, first.deps)).kind).toBe("session");
    const again = deps(ground, sessionFor);
    expect(await sso.finishHandOff(config, { code, state }, start.cookie, again.deps)).toMatchObject({ kind: "refused", error: "base-refused" });
    expect(again.logins).toEqual([]);
    expect(again.audits[0]).toMatchObject({ action: "signin.base-refused", details: { reason: "base-refused", exchange: "invalid_grant" } });

    const strict = fakeGround("pat@example.ca", { secret: "ground-has-another-secret" });
    const s2 = sso.startHandOff(config, "/admin");
    const c2 = strict.authorize(s2.location);
    const t2 = deps(strict, sessionFor);
    expect(await sso.finishHandOff(config, c2, s2.cookie, t2.deps)).toMatchObject({ kind: "refused", error: "base-refused" });

    const t3 = deps(ground, sessionFor);
    const s3 = sso.startHandOff(config, "/admin");
    expect(await sso.finishHandOff(config, { code: "made-up", state: s3.state }, s3.cookie, t3.deps)).toMatchObject({ kind: "refused", error: "base-refused" });
  });

  it("ground down or answering nonsense is 'unreachable', not a sign-in", async () => {
    const start = sso.startHandOff(config, "/admin");
    const down = deps(fakeGround("x@y.ca"), sessionFor);
    down.deps.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await sso.finishHandOff(config, { code: "c", state: start.state }, start.cookie, down.deps)).toMatchObject({ kind: "refused", error: "base-unreachable" });
    const odd = deps(fakeGround("x@y.ca"), sessionFor);
    odd.deps.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
    expect(await sso.finishHandOff(config, { code: "c", state: start.state }, start.cookie, odd.deps)).toMatchObject({ kind: "refused", error: "base-unreachable" });
    expect(odd.logins).toEqual([]);
  });

  it("ground saying no (?error=…) is passed on, not a sign-in", async () => {
    const start = sso.startHandOff(config, "/admin");
    const t = deps(fakeGround("x@y.ca"), sessionFor);
    expect(await sso.finishHandOff(config, { error: "access_denied", state: start.state }, start.cookie, t.deps)).toMatchObject({ kind: "refused", error: "base-denied" });
  });

  it("an email with no staff account here: 'No Base Web staff account', with the email, audited, nothing created", async () => {
    const ground = fakeGround("newcomer@example.ca");
    const start = sso.startHandOff(config, "/admin");
    const t = deps(ground, noLink, null);
    const outcome = await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps);
    expect(outcome).toEqual({ kind: "refused", error: "base-no-account", email: "newcomer@example.ca" });
    expect(t.started).toEqual([]);
    expect(t.audits).toEqual([{ user: null, action: "signin.base-refused", details: { reason: "base-no-account", email: "newcomer@example.ca", client: "imaginesurrey", sub: "ground-user-1" } }]);
  });

  it("no link yet: the account with that email must be proven first; nobody is signed in", async () => {
    const ground = fakeGround("Pat@Example.ca", { sub: "ground-user-7" });
    const start = sso.startHandOff(config, "/admin/people");
    const t = deps(ground, noLink, { user: staff, linked: false });
    const outcome = await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps);
    expect(outcome).toEqual({ kind: "link", pending: { value: "waiting-hand-off", maxAge: 900 }, user: staff });
    expect(t.lookups).toEqual(["Pat@Example.ca"]);
    expect(t.started).toHaveLength(1);
    expect(t.started[0]).toMatchObject({ identity: { sub: "ground-user-7", client: "imaginesurrey", email: "Pat@Example.ca" }, user: staff, next: "/admin/people" });
    expect(t.audits).toEqual([{ user: null, action: "signin.base-link-started", details: { accountId: staff.id, email: "Pat@Example.ca", client: "imaginesurrey", sub: "ground-user-7" } }]);
  });

  it("an account already linked to a different Base Ground login is refused", async () => {
    const ground = fakeGround("pat@example.ca", { sub: "a-new-ground-login" });
    const start = sso.startHandOff(config, "/admin");
    const t = deps(ground, noLink, { user: staff, linked: true });
    expect(await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps)).toEqual({ kind: "refused", error: "base-linked-elsewhere", email: undefined });
    expect(t.started).toEqual([]);
    expect(t.audits[0]).toMatchObject({ action: "signin.base-refused", details: { reason: "base-linked-elsewhere", sub: "a-new-ground-login" } });
  });

  it("a link to a deactivated account signs nobody in", async () => {
    const ground = fakeGround("pat@example.ca");
    const start = sso.startHandOff(config, "/admin");
    const t = deps(ground, async () => ({ ok: false, reason: "invalid" }), { user: staff, linked: true });
    expect(await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps)).toMatchObject({ kind: "refused", error: "base-inactive" });
    expect(t.lookups).toEqual([]);
  });

  it("an answer without a sub is not a sign-in", async () => {
    const ground = fakeGround("pat@example.ca", { sub: null });
    const start = sso.startHandOff(config, "/admin");
    const t = deps(ground, sessionFor, { user: staff, linked: false });
    expect(await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps)).toMatchObject({ kind: "refused", error: "base-unreachable" });
    expect(t.logins).toEqual([]);
    expect(t.lookups).toEqual([]);
  });

  it("without BASE_GROUND_URL and BASE_SSO_SECRET it is off, and says so", async () => {
    const t = deps(fakeGround("x@y.ca"), sessionFor);
    expect(await sso.finishHandOff(null, { code: "c", state: "s" }, "x", t.deps)).toMatchObject({ kind: "refused", error: "base-not-configured" });
  });
});

describe("sign in with Base: two-factor sign-in still applies", () => {
  it("a linked account with two-factor on gets the code step, not a session", async () => {
    const ground = fakeGround("owner@example.ca");
    const start = sso.startHandOff(config, "/admin/brand");
    const owner: AdminUser = { ...staff, role: "owner", email: "owner@example.ca" };
    const t = deps(ground, async () => ({ ok: "second-step", pending: { value: "pending-token", maxAge: 600 }, user: owner }));
    const outcome = await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps);
    expect(outcome).toEqual({ kind: "second-step", pending: { value: "pending-token", maxAge: 600 }, user: owner });
    expect(t.audits).toEqual([{ user: owner, action: "signin.base", details: { outcome: "second-step", client: "imaginesurrey", sub: "ground-user-1" } }]);
  });
});

describe("sign in with Base: where it sends people afterwards", () => {
  it("honours only same-origin relative paths", () => {
    for (const ok of ["/admin", "/admin/people?tag=Member%20(joined%20online)", "/admin/brand#preview", "/"]) expect(sso.safeRelativePath(ok)).toBe(ok);
    for (const bad of ["//evil.example", "https://evil.example/admin", "/\\evil.example", "\\/evil.example", "/%2F%2Fevil.example", "/%5cevil.example", " /admin", "/admin\n/x", "javascript:alert(1)", "admin", "", null, 42, "/" + "a".repeat(2001)]) {
      expect(sso.safeRelativePath(bad)).toBe("/admin");
    }
  });

  it("an open-redirect attempt in ?next= ends at the admin's home after signing in", async () => {
    const ground = fakeGround("pat@example.ca");
    const start = sso.startHandOff(config, "//evil.example/steal");
    const t = deps(ground, sessionFor);
    expect(await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps)).toMatchObject({ kind: "session", next: "/admin" });
    expect(t.logins[0].next).toBe("/admin");
  });

  it("a next smuggled into a re-signed cookie still has to be a relative path", () => {
    const state = "s".repeat(43);
    const nextPart = Buffer.from("https://evil.example").toString("base64url");
    const sig = createHmac("sha256", config.cookieSecret).update(`base-sso:${state}.${nextPart}`).digest("base64url");
    expect(sso.readStateCookie(`${state}.${nextPart}.${sig}`, config.cookieSecret)).toEqual({ state, next: "/admin" });
  });
});

describe("sign in with Base: the token call's address", () => {
  it("uses BASE_GROUND_URL when there is no internal address", () => {
    expect(sso.tokenEndpoint("https://imaginesurrey.base.win")).toBe("https://imaginesurrey.base.win/api/sso/token");
    expect(sso.tokenEndpoint("https://imaginesurrey.base.win/")).toBe("https://imaginesurrey.base.win/api/sso/token");
    expect(sso.tokenEndpoint("https://base.win/imaginesurrey")).toBe("https://base.win/imaginesurrey/api/sso/token");
    expect(sso.tokenEndpoint("https://ground.example.org")).toBe("https://ground.example.org/api/sso/token");
  });

  it("treats Render's bare host:port as an origin: http://, then any prefix from BASE_GROUND_URL", () => {
    expect(sso.tokenEndpoint("https://imaginesurrey.base.win", "base-ground-imaginesurrey-staging:10000")).toBe("http://base-ground-imaginesurrey-staging:10000/api/sso/token");
    expect(sso.tokenEndpoint("https://base.win/imaginesurrey", "base-ground-imaginesurrey-staging:10000")).toBe("http://base-ground-imaginesurrey-staging:10000/imaginesurrey/api/sso/token");
    expect(sso.tokenEndpoint("https://base.win/imaginesurrey", "http://base-ground-imaginesurrey:10000/")).toBe("http://base-ground-imaginesurrey:10000/imaginesurrey/api/sso/token");
    // An origin only: any path on the internal address is ignored.
    expect(sso.tokenEndpoint("https://base.win/imaginesurrey", "https://ground.internal:8443/other")).toBe("https://ground.internal:8443/imaginesurrey/api/sso/token");
  });

  it("the exchange goes to the internal address when it is set", async () => {
    const ground = fakeGround("pat@example.ca");
    const internal = { ...config, internalUrl: "base-ground-imaginesurrey-staging:10000" };
    const start = sso.startHandOff(internal, "/admin");
    const t = deps(ground, sessionFor);
    expect((await sso.finishHandOff(internal, ground.authorize(start.location), start.cookie, t.deps)).kind).toBe("session");
    expect(ground.calls[0].url).toBe("http://base-ground-imaginesurrey-staging:10000/api/sso/token");
    // The browser still goes to the public address.
    expect(start.location.startsWith("https://imaginesurrey.base.win/api/sso/authorize?")).toBe(true);
  });
});

