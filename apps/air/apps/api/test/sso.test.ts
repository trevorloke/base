import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { createTestDb } from "@base-air/db/test";
import { baseLinks, members, users, type DbHandle } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox } from "@base-air/core";
import { createApp } from "../src/app.ts";
import { withBasePath } from "../src/base-path.ts";
import { ssoConfigFromEnv, suiteLinksFromEnv, tokenEndpoint } from "../src/sso.ts";

const ORIGIN = "https://imaginesurrey.base.win";
const BASE = "/air";
const GROUND = ORIGIN;
const INTERNAL = "base-ground-imaginesurrey-staging:10000";
const SECRET = "s".repeat(48);
const CALLBACK = `${ORIGIN}${BASE}/auth/base/callback`;

/**
 * A fake Base Ground: issues one-time codes for whoever "signed in" there, and answers the token call the way
 * SUITE.md says — secret checked, code known, unused and for the same redirect_uri, else 400 invalid_grant.
 */
class FakeGround {
  codes = new Map<string, { email: string; sub: string | null; redirectUri: string; used: boolean }>();
  calls: { url: string; auth: string | null; body: unknown }[] = [];
  down = false;
  /** `sub` defaults to one derived from the email, as a stable id for that ground login. */
  issue(email: string, sub: string | null = `g-${email.toLowerCase()}`, redirectUri = CALLBACK): string {
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { email, sub, redirectUri, used: false });
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
    return new Response(JSON.stringify({ ...(c.sub ? { sub: c.sub } : {}), email: c.email, name: "Someone", role: "staff", areas: [], organization: "Imagine Surrey", client: "imaginesurrey" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

let h: DbHandle;
let m: BaseAir;
let ground: FakeGround;
let fetchApp: (r: Request) => Promise<Response>;
let wsId = "";
let clock = Date.parse("2026-11-08T12:00:00Z");
const ANN = { email: "ann@imaginesurrey.ca", password: "correct horse 1" };

beforeAll(async () => {
  h = await createTestDb();
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now: () => new Date(clock) });
  const r = await m.auth.signup({ ...ANN, name: "Ann", workspaceName: "Imagine Surrey" }, {});
  wsId = r.view.currentWorkspaceId!;
});
afterAll(async () => h.close());
beforeEach(() => {
  clock += 3_600_000; // an hour between tests: lockouts and pending links from one never reach the next
  ground = new FakeGround();
  const sso = ssoConfigFromEnv({ BASE_GROUND_URL: GROUND, BASE_GROUND_INTERNAL_URL: INTERNAL, BASE_SSO_SECRET: SECRET })!;
  const app = createApp(m, { basePath: BASE, publicUrl: `${ORIGIN}${BASE}`, sso, suite: suiteLinksFromEnv({ BASE_GROUND_URL: GROUND, BASE_WEB_URL: "https://imaginesurrey.ca" }), ssoFetch: ground.fetch });
  fetchApp = async (req) => withBasePath(app.fetch, BASE)(req) as Promise<Response>;
});

const get = (path: string, cookie?: string) => fetchApp(new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} }));
const cookieValue = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const pair = (setCookie: string | undefined) => setCookie?.split(";")[0] ?? "";
const postLink = (password: string, cookie: string, origin: string | null = ORIGIN) =>
  fetchApp(
    new Request(`${ORIGIN}${BASE}/auth/base/link`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
      body: new URLSearchParams({ password }).toString(),
    }),
  );

/** Steps 1–3: start at /auth/base, "sign in" at ground, and come back with the code. */
async function start(next?: string) {
  const r = await get(`${BASE}/auth/base${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location")!);
  const stateCookie = cookieValue(r, "base_air_sso_state")!;
  return { loc, state: loc.searchParams.get("state")!, stateCookie, cookie: pair(stateCookie) };
}

/** A whole hand-off up to the callback's answer, for a ground login (email, sub). */
async function handoff(email: string, sub?: string | null, next?: string) {
  const { state, cookie } = await start(next);
  const code = sub === undefined ? ground.issue(email) : ground.issue(email, sub);
  return get(`${BASE}/auth/base/callback?code=${encodeURIComponent(code)}&state=${state}`, cookie);
}

/** First-time link: the hand-off, then the password page. Returns the link cookie to post with. */
async function linkPage(email: string, sub?: string | null, next?: string) {
  const r = await handoff(email, sub, next);
  expect(r.status).toBe(200);
  const set = cookieValue(r, "base_air_sso_link")!;
  expect(set).toBeTruthy();
  return { r, set, cookie: pair(set) };
}

async function sessionEmail(r: Response): Promise<string | null> {
  const session = cookieValue(r, "base_air_session");
  if (!session) return null;
  const me = await get(`${BASE}/v1/auth/session`, pair(session));
  return me.status === 200 ? ((await me.json()) as { user: { email: string } }).user.email : null;
}

async function events(type: string, ws = wsId) {
  return (await m.events.list({ workspaceId: ws, types: [type as never], afterSeq: 0 })).map((e) => e.data as Record<string, unknown>);
}
async function handoffs() {
  return (await events("auth.base_handoff")).map((d) => d.outcome as string);
}

/** A member of the workspace with a password, and no link yet. */
async function addPerson(email: string, password: string | null, role: "owner" | "editor" = "editor") {
  const id = `usr_${randomBytes(6).toString("hex")}`;
  await h.db.insert(users).values({ id, email, name: email.split("@")[0]!, passwordHash: null });
  if (password) await m.auth.setPassword(id, password);
  await h.db.insert(members).values({ id: `mem_${id}`, workspaceId: wsId, userId: id, role });
  return id;
}

describe("Sign in with Base: the hand-off", () => {
  it("sends the browser to Base Ground with app, redirect_uri and state, keeping state in a short-lived cookie", async () => {
    const { loc, state, stateCookie } = await start(`${BASE}/?tab=queue`);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${GROUND}/api/sso/authorize`);
    expect(loc.searchParams.get("app")).toBe("air");
    expect(loc.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain(`Path=${BASE}`);
    expect(stateCookie).not.toMatch(/Domain=/i);
    expect(stateCookie).toMatch(/Max-Age=600/);
    expect(stateCookie).toContain("Secure");
  });

  it("refuses a state that does not match the cookie, or no cookie at all, without calling Base Ground", async () => {
    const { cookie } = await start();
    const code = ground.issue(ANN.email);
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

  it("shows invalid_grant from Base Ground as a clear page, and a code works only once", async () => {
    const { state, cookie } = await start();
    const r = await get(`${BASE}/auth/base/callback?code=never-issued&state=${state}`, cookie);
    expect(r.status).toBe(400);
    expect(cookieValue(r, "base_air_session")).toBeUndefined();

    const code = ground.issue("stranger@example.org");
    const a = await start();
    expect((await get(`${BASE}/auth/base/callback?code=${code}&state=${a.state}`, a.cookie)).status).toBe(403);
    const b = await start();
    const replay = await get(`${BASE}/auth/base/callback?code=${code}&state=${b.state}`, b.cookie);
    expect(replay.status).toBe(400);
    expect((await handoffs()).slice(-3)).toEqual(["invalid_grant", "no_account", "invalid_grant"]);
  });

  it("refuses an answer without sub or client", async () => {
    const r = await handoff(ANN.email, null);
    expect(r.status).toBe(502);
    expect(cookieValue(r, "base_air_session")).toBeUndefined();
    expect(cookieValue(r, "base_air_sso_link")).toBeUndefined();
    expect((await handoffs()).at(-1)).toBe("ground_error");
  });

  it("tells someone without an account to ask for an invite, and creates nobody", async () => {
    const usersBefore = (await m.ctx.db.select({ n: count() }).from(users))[0]!.n;
    const r = await handoff("stranger@example.org");
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("No Base Air account for stranger@example.org — ask an owner to invite you.");
    expect(cookieValue(r, "base_air_session")).toBeUndefined();
    const usersAfter = (await m.ctx.db.select({ n: count() }).from(users))[0]!.n;
    expect(usersAfter).toBe(usersBefore);
    expect((await handoffs()).at(-1)).toBe("no_account");
  });

  it("escapes the email it shows", async () => {
    const r = await handoff("<script>x</script>@evil.test");
    expect(await r.text()).not.toContain("<script>x</script>");
  });

  it("says plainly when Base Ground cannot be reached", async () => {
    ground.down = true;
    const { state, cookie } = await start();
    const r = await get(`${BASE}/auth/base/callback?code=abc&state=${state}`, cookie);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("Base Ground isn&#39;t answering");
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
    expect(await r.text()).toContain("Sign in with Base isn&#39;t set up here");
    expect(await (await withBasePath(app.fetch, BASE)(new Request(`${ORIGIN}${BASE}/api/suite`))).json()).toEqual({ signInWithBase: false, groundUrl: null, webUrl: null });
  });
});

describe("Sign in with Base: by link, not by email", () => {
  it("first time: asks for the account's own password, keeping the hand-off server-side; a wrong one is refused, the right one links and signs in", async () => {
    const before = await handoffs();
    const { r, set, cookie } = await linkPage("Ann@ImagineSurrey.CA", "g-ann", `${BASE}/?tab=queue`); // ground's spelling may differ in case
    // The token call: internal host:port as an origin, then Base Ground's path (the root of the subdomain).
    expect(ground.calls).toHaveLength(1);
    expect(ground.calls[0]!.url).toBe(`http://${INTERNAL}/api/sso/token`);
    expect(ground.calls[0]!.auth).toBe(`Bearer ${SECRET}`);
    const page = await r.text();
    expect(page).toContain("Link your Base Air account");
    expect(page).toContain(`action="${BASE}/auth/base/link"`);
    expect(page).toContain('type="password"');
    // No session yet; the identity is not in any URL, and the cookie holds only an opaque token.
    expect(cookieValue(r, "base_air_session")).toBeUndefined();
    expect(r.headers.get("location")).toBeNull();
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain(`Path=${BASE}`);
    expect(set).toContain("Secure");
    expect(set).toMatch(/Max-Age=600/);
    expect(set).not.toMatch(/ann|g-ann/i);
    expect(cookieValue(r, "base_air_sso_state")).toMatch(/Max-Age=0/);

    // The page again, on a refresh.
    const again = await get(`${BASE}/auth/base/link`, cookie);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain(ANN.email);

    const wrong = await postLink("not the password", cookie);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("That isn&#39;t the password for this Base Air account");
    expect(cookieValue(wrong, "base_air_session")).toBeUndefined();
    expect(await h.db.select().from(baseLinks)).toHaveLength(0);

    const right = await postLink(ANN.password, cookie);
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe(`${BASE}/?tab=queue`);
    expect(cookieValue(right, "base_air_sso_link")).toMatch(/Max-Age=0/);
    expect(cookieValue(right, "base_air_session")).toContain(`Path=${BASE}`);
    expect(await sessionEmail(right)).toBe(ANN.email);

    const links = await h.db.select().from(baseLinks);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ client: "imaginesurrey", sub: "g-ann", groundEmail: "ann@imaginesurrey.ca" });
    expect((await events("base_link.created")).at(-1)).toMatchObject({ client: "imaginesurrey", sub: "g-ann" });
    expect((await events("base_link.refused")).at(-1)).toMatchObject({ reason: "wrong_password", sub: "g-ann" });
    expect((await handoffs()).slice(before.length)).toEqual(["link_required", "signed_in"]);
  });

  it("linked: signs the same account in, whatever email Base Ground sends now", async () => {
    await addPerson("bob@imaginesurrey.ca", "bobs password 1");
    for (const email of ["ann@imaginesurrey.ca", "ann.new@elsewhere.org", "bob@imaginesurrey.ca", ""]) {
      const r = await handoff(email, "g-ann", `${BASE}/?tab=feed`);
      expect(r.status, email).toBe(302);
      expect(r.headers.get("location")).toBe(`${BASE}/?tab=feed`);
      expect(await sessionEmail(r), email).toBe(ANN.email);
    }
    expect((await handoffs()).slice(-4)).toEqual(["signed_in", "signed_in", "signed_in", "signed_in"]);
  });

  it("refuses an account already linked to a different sub, even with the account's own email", async () => {
    const r = await handoff(ANN.email, "g-someone-else");
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("Already linked to another login");
    expect(cookieValue(r, "base_air_session")).toBeUndefined();
    expect(cookieValue(r, "base_air_sso_link")).toBeUndefined();
    expect((await events("base_link.refused")).at(-1)).toMatchObject({ reason: "linked_to_another", sub: "g-someone-else" });
    expect((await handoffs()).at(-1)).toBe("linked_elsewhere");
  });

  it("a pending link works once: replayed after success, or expired, it is refused", async () => {
    await addPerson("cat@imaginesurrey.ca", "cats password 1");
    const { cookie } = await linkPage("cat@imaginesurrey.ca", "g-cat");
    const ok = await postLink("cats password 1", cookie);
    expect(ok.status).toBe(303);
    const replay = await postLink("cats password 1", cookie);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("That sign-in expired");
    expect(cookieValue(replay, "base_air_session")).toBeUndefined();
    expect((await handoffs()).at(-1)).toBe("link_expired");

    await addPerson("dan@imaginesurrey.ca", "dans password 1");
    const late = await linkPage("dan@imaginesurrey.ca", "g-dan");
    clock += 10 * 60_000 + 1;
    expect((await get(`${BASE}/auth/base/link`, late.cookie)).status).toBe(400);
    const r = await postLink("dans password 1", late.cookie);
    expect(r.status).toBe(400);
    expect(cookieValue(r, "base_air_session")).toBeUndefined();
    const [dan] = await h.db.select().from(users).where(eq(users.email, "dan@imaginesurrey.ca"));
    expect(await h.db.select().from(baseLinks).where(eq(baseLinks.userId, dan!.id))).toHaveLength(0);

    // No cookie at all.
    expect((await postLink("dans password 1", "")).status).toBe(400);
  });

  it("refuses a password form posted from another origin", async () => {
    await addPerson("eve@imaginesurrey.ca", "eves password 1");
    const { cookie } = await linkPage("eve@imaginesurrey.ca", "g-eve");
    const r = await postLink("eves password 1", cookie, "https://evil.test");
    expect(r.status).toBe(403);
    expect(cookieValue(r, "base_air_session")).toBeUndefined();
    expect((await postLink("eves password 1", cookie)).status).toBe(303); // still usable from here
  });

  it("wrong passwords count toward the sign-in lockout for that email", async () => {
    await addPerson("fay@imaginesurrey.ca", "fays password 1");
    const { cookie } = await linkPage("fay@imaginesurrey.ca", "g-fay");
    for (let i = 0; i < 5; i++) expect((await postLink(`guess ${i}`, cookie)).status).toBe(401);
    const locked = await postLink("fays password 1", cookie);
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many wrong passwords");
    expect(cookieValue(locked, "base_air_session")).toBeUndefined();
    // The same lockout as the password sign-in.
    const login = await fetchApp(new Request(`${ORIGIN}${BASE}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fay@imaginesurrey.ca", password: "fays password 1" }) }));
    expect(login.status).toBe(429);
    expect((await events("base_link.refused")).at(-1)).toMatchObject({ reason: "rate_limited", sub: "g-fay" });
  });

  it("an account with no password is told to set one first, and nothing is linked", async () => {
    await addPerson("gus@imaginesurrey.ca", null);
    const r = await handoff("gus@imaginesurrey.ca", "g-gus");
    expect(r.status).toBe(403);
    const text = await r.text();
    expect(text).toContain("Set a Base Air password first");
    expect(text).toContain(`href="${BASE}/?forgot=1"`);
    expect(cookieValue(r, "base_air_sso_link")).toBeUndefined();
    expect((await handoffs()).at(-1)).toBe("no_password");
  });

  it("never sends anyone off the prefix: open-redirect attempts land on the room", async () => {
    for (const next of ["https://evil.test/phish", "//evil.test", "/\\evil.test", "/ground/", `${BASE}/../web`, "javascript:alert(1)"]) {
      const r = await handoff(ANN.email, "g-ann", next);
      expect(r.status, next).toBe(302);
      expect(r.headers.get("location"), next).toBe(`${BASE}/`);
    }
  });

  it("owners see and remove links (audited); the next hand-off asks for the password again", async () => {
    const owner = pair(cookieValue(await handoff(ANN.email, "g-ann"), "base_air_session"));
    const editor = pair(cookieValue(await handoff("cat@imaginesurrey.ca", "g-cat"), "base_air_session"));
    const api = (method: string, path: string, cookie: string) => fetchApp(new Request(`${ORIGIN}${BASE}${path}`, { method, headers: { cookie, "x-base-air-csrf": "1" } }));

    expect((await api("GET", "/v1/base-links", editor)).status).toBe(403);
    const list = (await (await api("GET", "/v1/base-links", owner)).json()) as { id: string; email: string; sub: string; client: string; groundEmail: string; linkedAt: string }[];
    expect(list.map((l) => l.email).sort()).toEqual(["ann@imaginesurrey.ca", "cat@imaginesurrey.ca", "eve@imaginesurrey.ca"]);
    const cat = list.find((l) => l.email === "cat@imaginesurrey.ca")!;
    expect(cat).toMatchObject({ client: "imaginesurrey", sub: "g-cat", groundEmail: "cat@imaginesurrey.ca" });

    expect((await api("DELETE", `/v1/base-links/${cat.id}`, editor)).status).toBe(403);
    expect((await api("DELETE", `/v1/base-links/${cat.id}`, owner)).status).toBe(204);
    expect((await api("DELETE", `/v1/base-links/${cat.id}`, owner)).status).toBe(404);
    expect((await events("base_link.removed")).at(-1)).toMatchObject({ client: "imaginesurrey", sub: "g-cat" });

    // Cat's ground login no longer signs her straight in; her password links it again.
    const { cookie } = await linkPage("cat@imaginesurrey.ca", "g-cat");
    expect((await postLink("cats password 1", cookie)).status).toBe(303);
  });
});

describe("where the token call goes", () => {
  it("uses BASE_GROUND_URL when there is no internal URL", () => {
    expect(tokenEndpoint({ groundUrl: GROUND })).toBe(`${GROUND}/api/sso/token`);
    expect(tokenEndpoint({ groundUrl: "http://localhost:3000" })).toBe("http://localhost:3000/api/sso/token");
  });
  it("treats the internal URL as an origin only, assuming http:// for a bare host:port", () => {
    expect(tokenEndpoint({ groundUrl: GROUND, groundInternalUrl: INTERNAL })).toBe(`http://${INTERNAL}/api/sso/token`);
    expect(tokenEndpoint({ groundUrl: GROUND, groundInternalUrl: "https://ground.internal:8443/ignored/path" })).toBe("https://ground.internal:8443/api/sso/token");
    expect(tokenEndpoint({ groundUrl: `${GROUND}/`, groundInternalUrl: "10.0.0.5:10000" })).toBe("http://10.0.0.5:10000/api/sso/token");
    // A Base Ground under a path keeps it.
    expect(tokenEndpoint({ groundUrl: "https://example.org/ground", groundInternalUrl: "10.0.0.5:10000" })).toBe("http://10.0.0.5:10000/ground/api/sso/token");
  });
});
