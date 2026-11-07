// "Sign in with base" (SUITE.md, "The hand-off"), against a fake base ground
// that behaves like the real one: one-time codes bound to the app and the
// redirect_uri, the shared secret checked, and 400 invalid_grant for anything
// wrong.
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
const config = { groundUrl: "https://base.win/imaginesurrey", secret: SECRET, siteUrl: "https://imaginesurrey.ca", cookieSecret: "cookie-signing-secret-0123456789" };

/** A base ground with one signed-in person, answering /api/sso/token like the real one. */
function fakeGround(email: string, opts: { secret?: string } = {}) {
  const codes = new Map<string, { email: string; redirectUri: string; used: boolean; expires: number }>();
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const authorize = (location: string) => {
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe("https://base.win/imaginesurrey/api/sso/authorize");
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
    return Response.json({ email: entry.email, name: "Pat Organizer", role: "manager", areas: [], organization: "Imagine Surrey", client: "imaginesurrey" });
  }) as typeof fetch;
  return { authorize, fetch: fetchFn, calls };
}

const staff: AdminUser = { id: "00000000-0000-0000-0000-000000000001", email: "pat@example.ca", name: "Pat", role: "organizer" };

function deps(ground: ReturnType<typeof fakeGround>, login: (email: string, next: string) => Promise<LoginResult>) {
  const audits: { user: AdminUser | null; action: string; details: Record<string, unknown> }[] = [];
  const logins: { email: string; next: string }[] = [];
  return {
    audits,
    logins,
    deps: {
      fetch: ground.fetch,
      login: async (email: string, next: string) => {
        logins.push({ email, next });
        return login(email, next);
      },
      audit: async (user: AdminUser | null, action: string, details: Record<string, unknown>) => void audits.push({ user, action, details }),
    },
  };
}

const sessionFor = async (): Promise<LoginResult> => ({ ok: true, cookie: { value: "session-cookie", maxAge: 43200 }, user: staff });

describe("sign in with base: the happy path", () => {
  it("goes to ground, comes back with a code, exchanges it from the server and signs in the same email", async () => {
    const ground = fakeGround("Pat@Example.ca");
    const start = sso.startHandOff(config, "/admin/people?tag=x");
    const { code, state } = ground.authorize(start.location);
    expect(state).toBe(start.state);
    const t = deps(ground, sessionFor);
    const outcome = await sso.finishHandOff(config, { code, state }, start.cookie, t.deps);

    expect(outcome).toMatchObject({ kind: "session", next: "/admin/people?tag=x", cookie: { value: "session-cookie" } });
    expect(t.logins).toEqual([{ email: "Pat@Example.ca", next: "/admin/people?tag=x" }]);
    expect(ground.calls).toHaveLength(1);
    expect(ground.calls[0]).toMatchObject({ url: "https://base.win/imaginesurrey/api/sso/token", auth: `Bearer ${SECRET}`, body: { code, redirect_uri: "https://imaginesurrey.ca/auth/base/callback" } });
    expect(t.audits).toEqual([{ user: staff, action: "signin", details: { method: "base", client: "imaginesurrey" } }]);
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

describe("sign in with base: refusals", () => {
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

  it("an email with no staff account here: 'No staff account', with the email, audited, nothing created", async () => {
    const ground = fakeGround("newcomer@example.ca");
    const start = sso.startHandOff(config, "/admin");
    const t = deps(ground, async () => ({ ok: false, reason: "invalid" }));
    const outcome = await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps);
    expect(outcome).toEqual({ kind: "refused", error: "base-no-account", email: "newcomer@example.ca" });
    expect(t.audits).toEqual([{ user: null, action: "signin.base-refused", details: { reason: "base-no-account", email: "newcomer@example.ca", client: "imaginesurrey" } }]);
  });

  it("without BASE_GROUND_URL and BASE_SSO_SECRET it is off, and says so", async () => {
    const t = deps(fakeGround("x@y.ca"), sessionFor);
    expect(await sso.finishHandOff(null, { code: "c", state: "s" }, "x", t.deps)).toMatchObject({ kind: "refused", error: "base-not-configured" });
  });
});

describe("sign in with base: two-factor sign-in still applies", () => {
  it("an account with two-factor on gets the code step, not a session", async () => {
    const ground = fakeGround("owner@example.ca");
    const start = sso.startHandOff(config, "/admin/brand");
    const owner: AdminUser = { ...staff, role: "owner", email: "owner@example.ca" };
    const t = deps(ground, async () => ({ ok: "second-step", pending: { value: "pending-token", maxAge: 600 }, user: owner }));
    const outcome = await sso.finishHandOff(config, ground.authorize(start.location), start.cookie, t.deps);
    expect(outcome).toEqual({ kind: "second-step", pending: { value: "pending-token", maxAge: 600 }, user: owner });
    expect(t.audits).toEqual([{ user: owner, action: "signin.base", details: { outcome: "second-step", client: "imaginesurrey" } }]);
  });
});

describe("sign in with base: where it sends people afterwards", () => {
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

describe("sign in with base: the token call's address", () => {
  it("uses BASE_GROUND_URL when there is no internal address", () => {
    expect(sso.tokenEndpoint("https://base.win/imaginesurrey")).toBe("https://base.win/imaginesurrey/api/sso/token");
    expect(sso.tokenEndpoint("https://base.win/imaginesurrey/")).toBe("https://base.win/imaginesurrey/api/sso/token");
    expect(sso.tokenEndpoint("https://ground.example.org")).toBe("https://ground.example.org/api/sso/token");
  });

  it("treats Render's bare host:port as an origin: http://, then ground's prefix from BASE_GROUND_URL", () => {
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
    expect(ground.calls[0].url).toBe("http://base-ground-imaginesurrey-staging:10000/imaginesurrey/api/sso/token");
    // The browser still goes to the public address.
    expect(start.location.startsWith("https://base.win/imaginesurrey/api/sso/authorize?")).toBe(true);
  });
});

// The account lookup itself, against a real database when TEST_DATABASE_URL
// names one ending in _test or _e2e.
const url = process.env.TEST_DATABASE_URL;
const usable = Boolean(url && /(_e2e|_test)$/.test(new URL(url).pathname));

describe.skipIf(!usable)("loginWithBase (database)", async () => {
  vi.stubEnv("ADMIN_SESSION_SECRET", "test-session-secret-0123456789abcdef");
  const { loginWithBase } = await import("@/lib/server/admin-auth");
  const client = usable ? postgres(url!, { max: 1, onnotice: () => {} }) : null;
  const db = client ? (drizzle(client, { schema }) as unknown as import("@/lib/db").Db) : null;
  const stamp = Date.now();
  const emails = [`sso-editor-${stamp}@example.ca`, `sso-owner-${stamp}@example.ca`, `sso-gone-${stamp}@example.ca`];

  beforeAll(async () => {
    await db!.insert(schema.adminUsers).values([
      { email: emails[0], name: "Editor", role: "editor" },
      { email: emails[1], name: "Owner", role: "owner", totpSecret: "x", totpEnabledAt: new Date() },
      { email: emails[2], name: "Gone", role: "admin", active: false },
    ]);
  });
  afterAll(async () => {
    const ids = (await db!.select({ id: schema.adminUsers.id }).from(schema.adminUsers).where(inArray(schema.adminUsers.email, emails))).map((r) => r.id);
    if (ids.length) {
      await db!.delete(schema.adminSessions).where(inArray(schema.adminSessions.userId, ids));
      await db!.delete(schema.adminUsers).where(inArray(schema.adminUsers.id, ids));
    }
    await db!.delete(schema.authTokens).where(inArray(schema.authTokens.email, emails));
    await client!.end();
    vi.unstubAllEnvs();
  });

  it("matches the email whatever its case and starts a session", async () => {
    const r = await loginWithBase(emails[0].toUpperCase(), {}, "/admin", db!);
    expect(r.ok).toBe(true);
    if (r.ok === true) expect(r.user.email).toBe(emails[0]);
  });
  it("asks an account with two-factor on for its code", async () => {
    const r = await loginWithBase(`  ${emails[1].replace("sso", "SSO")} `, {}, "/admin", db!);
    expect(r.ok).toBe("second-step");
  });
  it("refuses a deactivated account and an unknown email, and never creates one", async () => {
    expect((await loginWithBase(emails[2], {}, "/admin", db!)).ok).toBe(false);
    const stranger = `sso-stranger-${stamp}@example.ca`;
    expect((await loginWithBase(stranger, {}, "/admin", db!)).ok).toBe(false);
    expect(await db!.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, stranger))).toEqual([]);
  });
});
