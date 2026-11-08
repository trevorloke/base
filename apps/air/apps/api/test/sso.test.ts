import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { count } from "drizzle-orm";
import { createTestDb } from "@base-air/db/test";
import { users, type DbHandle } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox } from "@base-air/core";
import { createApp } from "../src/app.ts";
import { withBasePath } from "../src/base-path.ts";
import { ssoConfigFromEnv, suiteLinksFromEnv, tokenEndpoint } from "../src/sso.ts";

const ORIGIN = "https://base.win";
const BASE = "/imaginesurrey/air";
const GROUND = `${ORIGIN}/imaginesurrey`;
const INTERNAL = "base-ground-imaginesurrey-staging:10000";
const SECRET = "s".repeat(48);
const CALLBACK = `${ORIGIN}${BASE}/auth/base/callback`;

/**
 * A fake base ground: issues one-time codes for whoever "signed in" there, and answers the token call the way
 * SUITE.md says — secret checked, code known, unused and for the same redirect_uri, else 400 invalid_grant.
 */
class FakeGround {
  codes = new Map<string, { email: string; redirectUri: string; used: boolean }>();
  calls: { url: string; auth: string | null; body: unknown }[] = [];
  down = false;
  issue(email: string, redirectUri = CALLBACK): string {
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { email, redirectUri, used: false });
    return code;
  }
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as { code?: string; redirect_uri?: string };
    const auth = new Headers(init?.headers).get("authorization");
    this.calls.push({ url, auth, body });
    if (this.down) throw new Error("connect ECONNREFUSED");
    const bad = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
    if (auth !== `Bearer ${SECRET}`) return bad();
    const c = body.code ? this.codes.get(body.code) : undefined;
    if (!c || c.used || c.redirectUri !== body.redirect_uri) return bad();
    c.used = true;
    return new Response(JSON.stringify({ email: c.email, name: "Someone", role: "staff", areas: [], organization: "Imagine Surrey", client: "imaginesurrey" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

let h: DbHandle;
let m: BaseAir;
let ground: FakeGround;
let fetchApp: (r: Request) => Promise<Response>;
let wsId = "";

beforeAll(async () => {
  h = await createTestDb();
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const r = await m.auth.signup({ email: "ann@imaginesurrey.ca", password: "correct horse 1", name: "Ann", workspaceName: "Imagine Surrey" }, {});
  wsId = r.view.currentWorkspaceId!;
});
afterAll(async () => h.close());
beforeEach(() => {
  ground = new FakeGround();
  const sso = ssoConfigFromEnv({ BASE_GROUND_URL: GROUND, BASE_GROUND_INTERNAL_URL: INTERNAL, BASE_SSO_SECRET: SECRET })!;
  const app = createApp(m, { basePath: BASE, publicUrl: `${ORIGIN}${BASE}`, sso, suite: suiteLinksFromEnv({ BASE_GROUND_URL: GROUND, BASE_WEB_URL: "https://imaginesurrey.ca" }), ssoFetch: ground.fetch });
  fetchApp = async (req) => withBasePath(app.fetch, BASE)(req) as Promise<Response>;
});

const get = (path: string, cookie?: string) => fetchApp(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }));
const cookieValue = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const pair = (setCookie: string | undefined) => setCookie?.split(";")[0] ?? "";

/** Steps 1–3: start at /auth/base, "sign in" at ground, and come back with the code. */
async function start(next?: string) {
  const r = await get(`${BASE}/auth/base${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location")!);
  const stateCookie = cookieValue(r, "base_air_sso_state")!;
  return { loc, state: loc.searchParams.get("state")!, stateCookie, cookie: pair(stateCookie) };
}

async function handoffs() {
  return (await m.events.list({ workspaceId: wsId, types: ["auth.base_handoff"], afterSeq: 0 })).map((e) => (e.data as { outcome: string }).outcome);
}

describe("sign in with base", () => {
  it("sends the browser to base ground with app, redirect_uri and state, keeping state in a short-lived cookie", async () => {
    const { loc, state, stateCookie } = await start(`${BASE}/?tab=queue`);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${GROUND}/api/sso/authorize`);
    expect(loc.searchParams.get("app")).toBe("air");
    expect(loc.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain(`Path=${BASE}`);
    expect(stateCookie).toMatch(/Max-Age=600/);
    expect(stateCookie).toContain("Secure");
  });

  it("happy path: exchanges the code server-side over the internal URL and signs the person in to their own account", async () => {
    const before = await handoffs();
    const { state, cookie } = await start(`${BASE}/?tab=queue`);
    const code = ground.issue("Ann@ImagineSurrey.CA"); // ground's spelling of the email may differ in case
    const r = await get(`${BASE}/auth/base/callback?code=${encodeURIComponent(code)}&state=${state}`, cookie);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${BASE}/?tab=queue`);
    // The token call: internal host:port as an origin, then ground's own prefix.
    expect(ground.calls).toHaveLength(1);
    expect(ground.calls[0]!.url).toBe(`http://${INTERNAL}/imaginesurrey/api/sso/token`);
    expect(ground.calls[0]!.auth).toBe(`Bearer ${SECRET}`);
    expect(ground.calls[0]!.body).toEqual({ code, redirect_uri: CALLBACK });
    // base air's own session, scoped to the prefix; the state cookie is spent.
    const session = cookieValue(r, "base_air_session")!;
    expect(session).toContain(`Path=${BASE}`);
    expect(cookieValue(r, "base_air_sso_state")).toMatch(/Max-Age=0/);
    const me = await get(`${BASE}/v1/auth/session`, pair(session));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("ann@imaginesurrey.ca");
    expect(await handoffs()).toEqual([...before, "signed_in"]);
  });

  it("refuses a state that does not match the cookie, or no cookie at all, without calling ground", async () => {
    const { cookie } = await start();
    const code = ground.issue("ann@imaginesurrey.ca");
    const wrong = await get(`${BASE}/auth/base/callback?code=${code}&state=${"x".repeat(43)}`, cookie);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("sign-in didn&#39;t finish");
    expect(cookieValue(wrong, "base_air_session")).toBeUndefined();
    const { state } = await start();
    const noCookie = await get(`${BASE}/auth/base/callback?code=${code}&state=${state}`);
    expect(noCookie.status).toBe(400);
    expect(ground.calls).toHaveLength(0);
    expect((await handoffs()).slice(-2)).toEqual(["bad_state", "bad_state"]);
  });

  it("shows invalid_grant from ground as a clear page, and a code works only once", async () => {
    const { state, cookie } = await start();
    const r = await get(`${BASE}/auth/base/callback?code=never-issued&state=${state}`, cookie);
    expect(r.status).toBe(400);
    expect(cookieValue(r, "base_air_session")).toBeUndefined();

    const code = ground.issue("ann@imaginesurrey.ca");
    const a = await start();
    expect((await get(`${BASE}/auth/base/callback?code=${code}&state=${a.state}`, a.cookie)).status).toBe(302);
    const b = await start();
    const replay = await get(`${BASE}/auth/base/callback?code=${code}&state=${b.state}`, b.cookie);
    expect(replay.status).toBe(400);
    expect((await handoffs()).slice(-3)).toEqual(["invalid_grant", "signed_in", "invalid_grant"]);
  });

  it("tells someone without an account to ask for an invite, and creates nobody", async () => {
    const usersBefore = (await m.ctx.db.select({ n: count() }).from(users))[0]!.n;
    const { state, cookie } = await start();
    const r = await get(`${BASE}/auth/base/callback?code=${ground.issue("stranger@example.org")}&state=${state}`, cookie);
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("No base air account for stranger@example.org — ask an owner to invite you.");
    expect(cookieValue(r, "base_air_session")).toBeUndefined();
    const usersAfter = (await m.ctx.db.select({ n: count() }).from(users))[0]!.n;
    expect(usersAfter).toBe(usersBefore);
    expect((await handoffs()).at(-1)).toBe("no_account");
  });

  it("escapes the email it shows", async () => {
    const { state, cookie } = await start();
    const r = await get(`${BASE}/auth/base/callback?code=${ground.issue("<script>x</script>@evil.test")}&state=${state}`, cookie);
    expect(await r.text()).not.toContain("<script>x</script>");
  });

  it("never sends anyone off the prefix: open-redirect attempts land on the room", async () => {
    for (const next of ["https://evil.test/phish", "//evil.test", "/\\evil.test", "/imaginesurrey/ground/", `${BASE}/../web`, "javascript:alert(1)"]) {
      const { state, cookie } = await start(next);
      const r = await get(`${BASE}/auth/base/callback?code=${ground.issue("ann@imaginesurrey.ca")}&state=${state}`, cookie);
      expect(r.status, next).toBe(302);
      expect(r.headers.get("location"), next).toBe(`${BASE}/`);
    }
  });

  it("says plainly when ground cannot be reached", async () => {
    ground.down = true;
    const { state, cookie } = await start();
    const r = await get(`${BASE}/auth/base/callback?code=abc&state=${state}`, cookie);
    expect(r.status).toBe(502);
    expect((await handoffs()).at(-1)).toBe("ground_error");
  });

  it("tells the browser what the suite offers", async () => {
    const r = await get(`${BASE}/api/suite`);
    expect(await r.json()).toEqual({ signInWithBase: true, groundUrl: GROUND, webUrl: "https://imaginesurrey.ca" });
  });

  it("is off without BASE_GROUND_URL and BASE_SSO_SECRET", async () => {
    expect(ssoConfigFromEnv({ BASE_GROUND_URL: GROUND })).toBeNull();
    expect(ssoConfigFromEnv({ BASE_SSO_SECRET: SECRET })).toBeNull();
    const app = createApp(m, { basePath: BASE, publicUrl: `${ORIGIN}${BASE}` });
    const r = await withBasePath(app.fetch, BASE)(new Request(`${ORIGIN}${BASE}/auth/base`));
    expect(r.status).toBe(404);
    expect(await (await withBasePath(app.fetch, BASE)(new Request(`${ORIGIN}${BASE}/api/suite`))).json()).toEqual({ signInWithBase: false, groundUrl: null, webUrl: null });
  });
});

describe("where the token call goes", () => {
  it("uses BASE_GROUND_URL when there is no internal URL", () => {
    expect(tokenEndpoint({ groundUrl: GROUND })).toBe(`${GROUND}/api/sso/token`);
    expect(tokenEndpoint({ groundUrl: "http://localhost:3000" })).toBe("http://localhost:3000/api/sso/token");
  });
  it("treats the internal URL as an origin only, assuming http:// for a bare host:port", () => {
    expect(tokenEndpoint({ groundUrl: GROUND, groundInternalUrl: INTERNAL })).toBe(`http://${INTERNAL}/imaginesurrey/api/sso/token`);
    expect(tokenEndpoint({ groundUrl: GROUND, groundInternalUrl: "https://ground.internal:8443/ignored/path" })).toBe("https://ground.internal:8443/imaginesurrey/api/sso/token");
    expect(tokenEndpoint({ groundUrl: `${GROUND}/`, groundInternalUrl: "10.0.0.5:10000" })).toBe("http://10.0.0.5:10000/imaginesurrey/api/sso/token");
  });
});
