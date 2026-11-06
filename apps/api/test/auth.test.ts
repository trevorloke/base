import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { ledgerEvents, sessions, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, Starsign, SecretBox, type MailMessage } from "@starsign/core";
import { createApp } from "../src/app.ts";

const PUBLIC_URL = "https://starsign.test";
let h: DbHandle;
let m: Starsign;
let app: ReturnType<typeof createApp>;
let clock = Date.parse("2026-11-03T12:00:00Z");
const now = () => new Date(clock);
const MIN = 60_000;
const DAY = 86_400_000;
let allowSignup = false;
const mail: MailMessage[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

interface CallOpts {
  body?: unknown;
  cookie?: string;
  csrf?: boolean;
  headers?: Record<string, string>;
}
function call(method: string, path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.body !== undefined && !("content-type" in headers)) headers["content-type"] = "application/json";
  if (o.cookie) headers.cookie = `starsign_session=${o.cookie}`;
  if (o.csrf ?? true) headers["x-starsign-csrf"] = "1";
  return Promise.resolve(app.request(path, { method, headers, body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body) }));
}
function setCookie(r: Response): { value: string; raw: string } | null {
  for (const c of r.headers.getSetCookie()) {
    const match = /^starsign_session=([^;]*)/.exec(c);
    if (match) return { value: match[1]!, raw: c };
  }
  return null;
}
async function login(email: string, password: string): Promise<{ cookie: string; view: { user: { id: string }; currentWorkspaceId: string; workspaces: { id: string; role: string }[] } }> {
  const r = await call("POST", "/v1/auth/login", { body: { email, password } });
  expect(r.status).toBe(200);
  return { cookie: setCookie(r)!.value, view: await json(r) };
}
const tokenFrom = (url: string, param: string) => new URL(url, PUBLIC_URL).searchParams.get(param)!;
const lastLinkTo = (to: string, param: string) => {
  const msg = [...mail].reverse().find((x) => x.to === to);
  const url = msg?.text.match(/https:\/\/\S+/)?.[0];
  return url ? tokenFrom(url, param) : null;
};
const ledgerTypes = async (workspaceId: string) => (await m.ctx.db.select().from(ledgerEvents).where(eq(ledgerEvents.workspaceId, workspaceId))).map((e) => e.type);

const ANN = { email: "ann@acme.test", password: "correct horse 1", name: "Ann", workspaceName: "Acme Outdoor", timezone: "America/Vancouver" };
const BOB = { email: "bob@client.test", password: "bob's long password", name: "Bob", workspaceName: "Bob Co" };
const CARL = { email: "carl@acme.test", password: "carl's password!", name: "Carl", workspaceName: "Carl Co" };
let annId = "";
let annWs = "";
let bobWs = "";
let annKey = "";

beforeAll(async () => {
  h = await createTestDb();
  m = new Starsign({
    handle: h,
    connectors: new ConnectorRegistry().register(new MockConnector()),
    scheduler: new InMemoryScheduler(),
    secrets: new SecretBox(randomBytes(32)),
    now,
    auth: { allowSignup: () => allowSignup, mailer: { send: async (msg) => void mail.push(msg) }, logLinks: false },
  });
  app = createApp(m, { publicUrl: PUBLIC_URL });
});
afterAll(() => h.close());

describe("people: sign-up, sign-in, sessions", () => {
  it("lets the first person sign up, then closes sign-up unless STARSIGN_ALLOW_SIGNUP", async () => {
    const notJson = await call("POST", "/v1/auth/signup", { body: JSON.stringify(ANN), headers: { "content-type": "text/plain" } });
    expect(notJson.status).toBe(400);

    const r = await call("POST", "/v1/auth/signup", { body: ANN });
    expect(r.status).toBe(201);
    const view = await json(r);
    expect(view.user).toMatchObject({ email: ANN.email, name: "Ann" });
    expect(view.workspaces).toHaveLength(1);
    expect(view.workspaces[0]).toMatchObject({ name: "Acme Outdoor", slug: "acme-outdoor", role: "owner" });
    expect(view.currentWorkspaceId).toBe(view.workspaces[0].id);
    annId = view.user.id;
    annWs = view.currentWorkspaceId;
    // The workspace starts in the timezone the browser sent, so schedules and quiet hours read where the brand is.
    expect((await m.policy.getActive(annWs)).timezone).toBe("America/Vancouver");
    const cookie = setCookie(r)!;
    expect(cookie.raw).toMatch(/HttpOnly/i);
    expect(cookie.raw).toMatch(/SameSite=Lax/i);
    expect(cookie.raw).toMatch(/Path=\//);
    expect(cookie.raw).toMatch(/Max-Age=2592000/);
    expect(cookie.raw).toMatch(/Secure/);
    // The token is not what the database holds.
    expect(JSON.stringify(await m.ctx.db.select().from(sessions))).not.toContain(cookie.value);

    expect((await call("POST", "/v1/auth/signup", { body: BOB })).status).toBe(403);
    expect((await call("POST", "/v1/auth/signup", { body: { ...BOB, password: "short" } })).status).toBe(400);
    allowSignup = true;
    // A timezone the server does not know never blocks a sign-up; the workspace falls back to UTC.
    const bob = await call("POST", "/v1/auth/signup", { body: { ...BOB, timezone: "Mars/Olympus_Mons" } });
    expect(bob.status).toBe(201);
    bobWs = (await json(bob)).currentWorkspaceId;
    expect((await m.policy.getActive(bobWs)).timezone).toBe("UTC");
    expect((await call("POST", "/v1/auth/signup", { body: CARL })).status).toBe(201);
    expect((await call("POST", "/v1/auth/signup", { body: { ...BOB, email: "BOB@client.test" } })).status).toBe(409);
    allowSignup = false;

    const types = await ledgerTypes(annWs);
    expect(types).toEqual(expect.arrayContaining(["workspace.created", "member.added", "user.signed_up"]));
    annKey = (await m.workspaces.createApiKey({ workspaceId: annWs, name: "ann automation", actorType: "human", actorId: annId, role: "owner" })).secret;
  });

  it("signs in with a uniform error, acts as the person, and signs out", async () => {
    const wrong = await call("POST", "/v1/auth/login", { body: { email: ANN.email, password: "not the password" } });
    const unknown = await call("POST", "/v1/auth/login", { body: { email: "nobody@acme.test", password: "not the password" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const [a, b] = [await json(wrong), await json(unknown)];
    expect(a.error.code).toBe("unauthorized");
    expect(a.error.message).toBe(b.error.message);

    // A stale cookie does not get in the way of signing in.
    const r = await call("POST", "/v1/auth/login", { body: { email: "ANN@acme.test", password: ANN.password }, cookie: "stale" });
    expect(r.status).toBe(200);
    const cookie = setCookie(r)!.value;
    const session = await json(await call("GET", "/v1/auth/session", { cookie, csrf: false }));
    expect(session).toEqual({ user: { id: annId, email: ANN.email, name: "Ann" }, workspaces: [expect.objectContaining({ id: annWs, role: "owner" })], currentWorkspaceId: annWs });
    const me = await json(await call("GET", "/v1/me", { cookie, csrf: false }));
    expect(me.actor).toEqual({ type: "human", id: annId });
    expect(me.role).toBe("owner");
    expect(me.workspace.id).toBe(annWs);

    expect((await call("POST", "/v1/auth/logout", { cookie, csrf: false })).status).toBe(403);
    const out = await call("POST", "/v1/auth/logout", { cookie });
    expect(out.status).toBe(204);
    expect(setCookie(out)!.raw).toMatch(/Max-Age=0/);
    const after = await call("GET", "/v1/me", { cookie, csrf: false });
    expect(after.status).toBe(401);
    expect(setCookie(after)!.raw).toMatch(/Max-Age=0/);
    expect((await call("GET", "/v1/me", { csrf: false })).status).toBe(401);
  });

  it("answers 429 after five failures for an email, for fifteen minutes", async () => {
    for (let i = 0; i < 5; i++) expect((await call("POST", "/v1/auth/login", { body: { email: CARL.email, password: `wrong ${i}` } })).status).toBe(401);
    const locked = await call("POST", "/v1/auth/login", { body: { email: CARL.email, password: CARL.password } });
    expect(locked.status).toBe(429);
    expect((await json(locked)).error.code).toBe("rate_limited");
    // Other emails are unaffected.
    await login(ANN.email, ANN.password);
    clock += 15 * MIN + 1000;
    await login(CARL.email, CARL.password);
  });

  it("requires x-starsign-csrf on cookie writes, never on bearer keys", async () => {
    const { cookie } = await login(ANN.email, ANN.password);
    const stream = { name: "Support", query: { keywords: ["warranty"] } };
    const noHeader = await call("POST", "/v1/streams", { cookie, csrf: false, body: stream });
    expect(noHeader.status).toBe(403);
    expect((await json(noHeader)).error.code).toBe("forbidden");
    expect((await call("PATCH", "/v1/workspace/profile", { cookie, csrf: false, body: { profile: {} } })).status).toBe(403);
    expect((await call("POST", "/v1/streams", { cookie, body: stream })).status).toBe(201);
    expect((await call("GET", "/v1/streams", { cookie, csrf: false })).status).toBe(200);
    expect((await call("POST", "/v1/streams", { csrf: false, body: stream, headers: { authorization: `Bearer ${annKey}` } })).status).toBe(201);
  });

  it("slides the session forward on use and refuses it once expired or revoked", async () => {
    const { cookie } = await login(ANN.email, ANN.password);
    clock += 10 * MIN;
    const touched = await call("GET", "/v1/me", { cookie, csrf: false });
    expect(touched.status).toBe(200);
    expect(setCookie(touched)?.value).toBe(cookie); // re-issued with a fresh Max-Age
    clock += 29 * DAY;
    expect((await call("GET", "/v1/me", { cookie, csrf: false })).status).toBe(200); // slid: still alive
    clock += 31 * DAY;
    expect((await call("GET", "/v1/me", { cookie, csrf: false })).status).toBe(401);

    const second = await login(ANN.email, ANN.password);
    expect((await call("GET", "/v1/me", { cookie: second.cookie, csrf: false })).status).toBe(200);
    await m.auth.revokeAllSessions(annId);
    expect((await call("GET", "/v1/me", { cookie: second.cookie, csrf: false })).status).toBe(401);
  });

  it("creates workspaces for agencies and switches only between memberships", async () => {
    clock += 1000;
    const { cookie } = await login(ANN.email, ANN.password);
    expect((await call("POST", "/v1/workspaces", { cookie, csrf: false, body: { name: "Client Two" } })).status).toBe(403);
    expect((await call("POST", "/v1/workspaces", { cookie, body: { name: "Client Two", timezone: "Mars/Olympus" } })).status).toBe(400);
    expect((await call("POST", "/v1/workspaces", { csrf: false, body: { name: "Via key" }, headers: { authorization: `Bearer ${annKey}` } })).status).toBe(403);
    const created = await call("POST", "/v1/workspaces", { cookie, body: { name: "Client Two", timezone: "Europe/London" } });
    expect(created.status).toBe(201);
    const ws2 = await json(created);
    expect(ws2).toMatchObject({ name: "Client Two", slug: "client-two" });
    expect((await call("POST", "/v1/workspaces", { cookie, body: { name: "Client Two" } })).status).toBe(201); // slug made unique
    expect((await call("POST", "/v1/workspaces", { cookie, body: { name: "Again", slug: "client-two" } })).status).toBe(409);

    const before = await json(await call("GET", "/v1/auth/session", { cookie, csrf: false }));
    expect(before.workspaces).toHaveLength(3);
    expect(before.currentWorkspaceId).toBe(annWs);
    expect(before.workspaces.find((w: { id: string }) => w.id === ws2.id).role).toBe("owner");

    const switched = await call("POST", "/v1/auth/switch", { cookie, body: { workspaceId: ws2.id } });
    expect(switched.status).toBe(200);
    expect((await json(switched)).currentWorkspaceId).toBe(ws2.id);
    expect((await json(await call("GET", "/v1/me", { cookie, csrf: false }))).workspace.id).toBe(ws2.id);
    expect((await call("GET", "/v1/policy", { cookie, csrf: false })).status).toBe(200); // the new workspace has a default policy

    const notMine = await call("POST", "/v1/auth/switch", { cookie, body: { workspaceId: bobWs } });
    expect(notMine.status).toBe(403);
    expect((await json(await call("GET", "/v1/me", { cookie, csrf: false }))).workspace.id).toBe(ws2.id);
    expect((await call("POST", "/v1/auth/switch", { csrf: false, body: { workspaceId: ws2.id }, headers: { authorization: `Bearer ${annKey}` } })).status).toBe(401);

    // The next sign-in lands where the person left off.
    expect((await login(ANN.email, ANN.password)).view.currentWorkspaceId).toBe(ws2.id);
    clock += 1000;
    await call("POST", "/v1/auth/switch", { cookie, body: { workspaceId: annWs } });
    expect((await login(ANN.email, ANN.password)).view.currentWorkspaceId).toBe(annWs);
  });
});

describe("people: invites and members", () => {
  let annCookie = "";
  let danaCookie = "";
  let bobCookie = "";

  it("owners invite; the link shows who it is for; a new person accepts and becomes a member", async () => {
    annCookie = (await login(ANN.email, ANN.password)).cookie;
    expect((await call("POST", "/v1/invites", { cookie: annCookie, body: { email: "not-an-email", role: "editor" } })).status).toBe(400);
    const r = await call("POST", "/v1/invites", { cookie: annCookie, body: { email: "Dana@Acme.test", role: "editor" } });
    expect(r.status).toBe(201);
    const inv = await json(r);
    expect(inv.inviteUrl.startsWith(`${PUBLIC_URL}/?invite=`)).toBe(true);
    expect(Date.parse(inv.expiresAt)).toBe(clock + 7 * DAY);
    const token = tokenFrom(inv.inviteUrl, "invite");
    expect(lastLinkTo("dana@acme.test", "invite")).toBe(token);

    const peek = await call("GET", `/v1/invites/${token}`, { csrf: false });
    expect(peek.status).toBe(200);
    expect(await json(peek)).toMatchObject({ workspaceName: "Acme Outdoor", email: "dana@acme.test", role: "editor", userExists: false });
    expect((await call("GET", "/v1/invites/nope", { csrf: false })).status).toBe(404);

    expect((await call("POST", "/v1/auth/accept-invite", { body: { token, password: "short" } })).status).toBe(400);
    const acc = await call("POST", "/v1/auth/accept-invite", { body: { token, name: "Dana", password: "dana's password" } });
    expect(acc.status).toBe(200);
    const view = await json(acc);
    danaCookie = setCookie(acc)!.value;
    expect(view.user).toMatchObject({ email: "dana@acme.test", name: "Dana" });
    expect(view.currentWorkspaceId).toBe(annWs);
    expect(view.workspaces).toEqual([expect.objectContaining({ id: annWs, role: "editor" })]);
    expect((await json(await call("GET", "/v1/me", { cookie: danaCookie, csrf: false }))).role).toBe("editor");

    // Single use.
    expect((await call("POST", "/v1/auth/accept-invite", { body: { token, password: "dana's password" } })).status).toBe(404);
    expect((await call("GET", `/v1/invites/${token}`, { csrf: false })).status).toBe(404);
    // Editors cannot invite; agents cannot invite.
    expect((await call("POST", "/v1/invites", { cookie: danaCookie, body: { email: "x@acme.test", role: "viewer" } })).status).toBe(403);
    const agent = (await m.workspaces.createApiKey({ workspaceId: annWs, name: "agent", actorType: "mcp", actorId: "claude" })).secret;
    expect((await call("POST", "/v1/invites", { csrf: false, body: { email: "x@acme.test", role: "viewer" }, headers: { authorization: `Bearer ${agent}` } })).status).toBe(403);
    // Already a member.
    expect((await call("POST", "/v1/invites", { cookie: annCookie, body: { email: "dana@acme.test", role: "viewer" } })).status).toBe(409);

    const types = await ledgerTypes(annWs);
    expect(types).toEqual(expect.arrayContaining(["invite.created", "invite.accepted", "user.signed_up", "member.added"]));
  });

  it("an existing person accepts with their password, or signed in with the matching email", async () => {
    const inv = await json(await call("POST", "/v1/invites", { cookie: annCookie, body: { email: BOB.email, role: "viewer" } }));
    const token = tokenFrom(inv.inviteUrl, "invite");
    expect((await json(await call("GET", `/v1/invites/${token}`, { csrf: false }))).userExists).toBe(true);
    expect((await call("POST", "/v1/auth/accept-invite", { body: { token } })).status).toBe(401);
    expect((await call("POST", "/v1/auth/accept-invite", { body: { token, password: "not bob's password" } })).status).toBe(401);
    const acc = await call("POST", "/v1/auth/accept-invite", { body: { token, password: BOB.password } });
    expect(acc.status).toBe(200);
    const view = await json(acc);
    bobCookie = setCookie(acc)!.value;
    expect(view.currentWorkspaceId).toBe(annWs);
    expect(view.workspaces.map((w: { id: string; role: string }) => [w.id, w.role]).sort()).toEqual([[annWs, "viewer"], [bobWs, "owner"]].sort());

    // Signed in as Carl, accepting Carl's invite: no password needed.
    const carl = await login(CARL.email, CARL.password);
    const carlInv = tokenFrom((await json(await call("POST", "/v1/invites", { cookie: annCookie, body: { email: CARL.email, role: "approver" } }))).inviteUrl, "invite");
    const carlAcc = await call("POST", "/v1/auth/accept-invite", { cookie: carl.cookie, body: { token: carlInv } });
    expect(carlAcc.status).toBe(200);
    expect((await json(carlAcc)).workspaces.find((w: { id: string }) => w.id === annWs).role).toBe("approver");
    // The old session was replaced by the new one.
    expect((await call("GET", "/v1/me", { cookie: carl.cookie, csrf: false })).status).toBe(401);
  });

  it("refuses an invite for a different email and an expired invite", async () => {
    const frank = tokenFrom((await json(await call("POST", "/v1/invites", { cookie: annCookie, body: { email: "frank@acme.test", role: "viewer" } }))).inviteUrl, "invite");
    const mismatch = await call("POST", "/v1/auth/accept-invite", { cookie: bobCookie, body: { token: frank } });
    expect(mismatch.status).toBe(403);
    expect((await json(mismatch)).error.message).toContain("frank@acme.test");
    expect((await call("GET", `/v1/invites/${frank}`, { csrf: false })).status).toBe(200); // still usable by Frank

    clock += 7 * DAY + MIN;
    expect((await call("GET", `/v1/invites/${frank}`, { csrf: false })).status).toBe(404);
    expect((await call("POST", "/v1/auth/accept-invite", { body: { token: frank, password: "frank's password" } })).status).toBe(404);
  });

  it("lists members; owners change roles and remove people; the last owner is protected", async () => {
    annCookie = (await login(ANN.email, ANN.password)).cookie;
    const list = await json(await call("GET", "/v1/members", { cookie: annCookie, csrf: false }));
    const byEmail = Object.fromEntries(list.map((x: { email: string }) => [x.email, x]));
    expect(Object.keys(byEmail).sort()).toEqual([ANN.email, BOB.email, CARL.email, "dana@acme.test"].sort());
    expect(byEmail[ANN.email]).toMatchObject({ userId: annId, name: "Ann", role: "owner" });
    expect(byEmail["dana@acme.test"]).toEqual(expect.objectContaining({ id: expect.any(String), role: "editor", createdAt: expect.any(String) }));
    const ann = byEmail[ANN.email].id;
    const dana = byEmail["dana@acme.test"].id;
    const bob = byEmail[BOB.email].id;

    danaCookie = (await login("dana@acme.test", "dana's password")).cookie;
    expect((await call("GET", "/v1/members", { cookie: danaCookie, csrf: false })).status).toBe(200);
    expect((await call("PATCH", `/v1/members/${bob}`, { cookie: danaCookie, body: { role: "editor" } })).status).toBe(403);
    expect((await call("DELETE", `/v1/members/${bob}`, { cookie: danaCookie })).status).toBe(403);

    const demoteLast = await call("PATCH", `/v1/members/${ann}`, { cookie: annCookie, body: { role: "editor" } });
    expect(demoteLast.status).toBe(409);
    expect((await call("DELETE", `/v1/members/${ann}`, { cookie: annCookie })).status).toBe(409);
    expect((await call("PATCH", `/v1/members/${dana}`, { cookie: annCookie, body: { role: "boss" } })).status).toBe(400);
    expect((await call("PATCH", "/v1/members/mem_nope", { cookie: annCookie, body: { role: "editor" } })).status).toBe(404);

    const promoted = await call("PATCH", `/v1/members/${dana}`, { cookie: annCookie, body: { role: "owner" } });
    expect(promoted.status).toBe(200);
    expect(await json(promoted)).toMatchObject({ id: dana, role: "owner", email: "dana@acme.test" });
    // Roles apply on the next request, no re-login.
    expect((await json(await call("GET", "/v1/me", { cookie: danaCookie, csrf: false }))).role).toBe("owner");
    expect((await call("PATCH", `/v1/members/${ann}`, { cookie: annCookie, body: { role: "approver" } })).status).toBe(200);
    expect((await json(await call("GET", "/v1/me", { cookie: annCookie, csrf: false }))).role).toBe("approver");
    expect((await call("PATCH", `/v1/members/${dana}`, { cookie: danaCookie, body: { role: "viewer" } })).status).toBe(409); // Dana is now the last owner

    // Bob is removed; his session falls back to the workspace he still belongs to.
    expect((await json(await call("GET", "/v1/me", { cookie: bobCookie, csrf: false }))).workspace.id).toBe(annWs);
    expect((await call("DELETE", `/v1/members/${bob}`, { cookie: danaCookie })).status).toBe(204);
    const bobMe = await json(await call("GET", "/v1/me", { cookie: bobCookie, csrf: false }));
    expect(bobMe.workspace.id).toBe(bobWs);
    expect((await call("POST", "/v1/auth/switch", { cookie: bobCookie, body: { workspaceId: annWs } })).status).toBe(403);

    const types = await ledgerTypes(annWs);
    expect(types).toEqual(expect.arrayContaining(["member.role_changed", "member.removed"]));
  });

  it("a person in no workspace can only use sign-in routes and create a workspace", async () => {
    const r = await call("POST", "/v1/invites", { cookie: danaCookie, body: { email: "solo@acme.test", role: "viewer" } });
    const token = tokenFrom((await json(r)).inviteUrl, "invite");
    const solo = setCookie(await call("POST", "/v1/auth/accept-invite", { body: { token, password: "solo's password" } }))!.value;
    const soloId = (await json(await call("GET", "/v1/members", { cookie: danaCookie, csrf: false }))).find((x: { email: string }) => x.email === "solo@acme.test").id;
    expect((await call("DELETE", `/v1/members/${soloId}`, { cookie: danaCookie })).status).toBe(204);
    expect((await call("GET", "/v1/me", { cookie: solo, csrf: false })).status).toBe(403);
    const s = await json(await call("GET", "/v1/auth/session", { cookie: solo, csrf: false }));
    expect(s).toMatchObject({ workspaces: [], currentWorkspaceId: null });
    const ws = await call("POST", "/v1/workspaces", { cookie: solo, body: { name: "Solo Studio" } });
    expect(ws.status).toBe(201);
    expect((await json(await call("GET", "/v1/me", { cookie: solo, csrf: false }))).workspace.name).toBe("Solo Studio");
  });
});

describe("people: password reset", () => {
  it("answers 204 to every forgot request and emails a link only to real accounts", async () => {
    const before = mail.length;
    expect((await call("POST", "/v1/auth/forgot", { body: { email: "nobody@acme.test" } })).status).toBe(204);
    expect((await call("POST", "/v1/auth/forgot", { body: { email: "not an email" } })).status).toBe(204);
    expect((await call("POST", "/v1/auth/forgot", { body: "{not json" })).status).toBe(204);
    expect(mail.length).toBe(before);
    expect((await call("POST", "/v1/auth/forgot", { body: { email: ANN.email } })).status).toBe(204);
    expect(mail.length).toBe(before + 1);
    expect(mail.at(-1)!.text).toContain(`${PUBLIC_URL}/?reset=`);
  });

  it("resets once, signs the person out everywhere, and expires after an hour", async () => {
    const { cookie } = await login(ANN.email, ANN.password);
    const token = lastLinkTo(ANN.email, "reset")!;
    expect((await call("POST", "/v1/auth/reset", { body: { token, password: "short" } })).status).toBe(400);
    expect((await call("POST", "/v1/auth/reset", { body: { token, password: "a brand new password" } })).status).toBe(204);
    expect((await call("GET", "/v1/me", { cookie, csrf: false })).status).toBe(401);
    expect((await call("POST", "/v1/auth/reset", { body: { token, password: "another new password" } })).status).toBe(400);
    expect((await call("POST", "/v1/auth/login", { body: { email: ANN.email, password: ANN.password } })).status).toBe(401);
    await login(ANN.email, "a brand new password");

    await call("POST", "/v1/auth/forgot", { body: { email: ANN.email } });
    const late = lastLinkTo(ANN.email, "reset")!;
    clock += 61 * MIN;
    expect((await call("POST", "/v1/auth/reset", { body: { token: late, password: "too late password" } })).status).toBe(400);
  });
});

describe("api keys and dev mode still work", () => {
  it("bearer keys authenticate as before and are not sessions", async () => {
    const me = await json(await call("GET", "/v1/me", { csrf: false, headers: { authorization: `Bearer ${annKey}` } }));
    expect(me.actor).toEqual({ type: "human", id: annId });
    expect(me.role).toBe("owner");
    expect((await call("GET", "/v1/me", { csrf: false, headers: { authorization: "Bearer star_nope" } })).status).toBe(401);
    expect((await call("GET", "/v1/auth/session", { csrf: false, headers: { authorization: `Bearer ${annKey}` } })).status).toBe(401);
    // A bearer key wins over a cookie.
    const both = await json(await call("GET", "/v1/me", { csrf: false, cookie: "garbage", headers: { authorization: `Bearer ${annKey}` } }));
    expect(both.workspace.id).toBe(annWs);
  });

  it("the dev workspace convenience stays", async () => {
    const dev = createApp(m, { devWorkspace: "acme-outdoor" });
    const me = await json(await dev.request("/v1/me"));
    expect(me.actor).toEqual({ type: "human", id: "dev" });
  });
});
