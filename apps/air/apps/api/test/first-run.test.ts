import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox } from "@base-air/core";
import { createApp } from "../src/app.ts";

/** A deployment whose only users have no password: seeded data, or users from before sign-in existed. */
let h: DbHandle;
let m: BaseAir;
let app: ReturnType<typeof createApp>;
let seededWs: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-base-air-csrf": "1", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("base_air_session="))!.split(";")[0]!;

beforeAll(async () => {
  h = await createTestDb();
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry(), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), auth: { allowSignup: () => false } });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme Outdoor" }, { type: "human", id: "u_trevor" });
  seededWs = ws.id;
  const u = await m.workspaces.ensureUser("trevor@example.com", "Trevor");
  await m.workspaces.addMember(ws.id, u.id, "owner");
  app = createApp(m, { publicUrl: "https://air.test" });
});
afterAll(() => h.close());

describe("first run on a deployment with only passwordless users", () => {
  it("tells the sign-in screen nobody can sign in yet", async () => {
    const r = await app.request("/v1/auth/session");
    expect(r.status).toBe(401);
    expect((await json(r)).error.details).toEqual({ signupAllowed: true, firstRun: true, mail: false });
  });

  it("lets that user claim their account with a password and keeps their workspace", async () => {
    const r = await post("/v1/auth/signup", { name: "Trevor L", email: "Trevor@Example.com", password: "a long enough password", workspaceName: "Ignored" });
    expect(r.status).toBe(201);
    const session = await json(r);
    expect(session.currentWorkspaceId).toBe(seededWs);
    expect(session.workspaces.map((w: { id: string }) => w.id)).toEqual([seededWs]);
    const me = await app.request("/v1/me", { headers: { cookie: cookieOf(r) } });
    expect((await json(me)).role).toBe("owner");
  });

  it("then closes: the hint flips, and sign-up needs an invite", async () => {
    expect((await json(await app.request("/v1/auth/session"))).error.details).toEqual({ signupAllowed: false, firstRun: false, mail: false });
    expect((await post("/v1/auth/signup", { name: "X", email: "x@example.com", password: "a long enough password", workspaceName: "X" })).status).toBe(403);
    expect((await post("/v1/auth/login", { email: "trevor@example.com", password: "a long enough password" })).status).toBe(200);
  });

  it("recovers a forgotten password from the server shell without mail", async () => {
    const link = await m.auth.adminResetLink("trevor@example.com", "https://air.test");
    const token = new URL(link).searchParams.get("reset")!;
    expect(link.startsWith("https://air.test/?reset=")).toBe(true);
    expect((await post("/v1/auth/reset", { token, password: "a brand new password" })).status).toBe(204);
    expect((await post("/v1/auth/login", { email: "trevor@example.com", password: "a brand new password" })).status).toBe(200);
    await expect(m.auth.adminResetLink("nobody@example.com")).rejects.toMatchObject({ code: "not_found" });
    expect(await m.auth.listUsers()).toEqual([expect.objectContaining({ email: "trevor@example.com", canSignIn: true })]);
  });
});
