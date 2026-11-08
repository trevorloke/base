import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox } from "@base-air/core";
import { createApp } from "../src/app.ts";
import { clientIpFrom, normalizeBasePath, safeNextPath, trustedProxiesFromEnv, withBasePath } from "../src/base-path.ts";
import { registerWebApp, renderIndexHtml } from "../src/web-app.ts";

const BASE = "/imaginesurrey/air";
const ORIGIN = "https://base.win";

describe("BASE_PATH helpers", () => {
  it("normalizes the prefix", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("imaginesurrey/air/")).toBe(BASE);
    expect(normalizeBasePath("//imaginesurrey//air")).toBe(BASE);
    expect(normalizeBasePath("/a/../b")).toBe("/a/b");
  });

  it("honours only same-origin next paths under the prefix", () => {
    expect(safeNextPath(`${BASE}/?tab=queue`, BASE)).toBe(`${BASE}/?tab=queue`);
    expect(safeNextPath(BASE, BASE)).toBe(BASE);
    for (const bad of ["https://evil.test/", "//evil.test/x", "/\\evil.test", "/imaginesurrey/web", "/imaginesurrey/airx", `${BASE}/../../evil`, "javascript:alert(1)", "", undefined, "/x\nSet-Cookie: a=b"]) {
      expect(safeNextPath(bad, BASE), String(bad)).toBe(`${BASE}/`);
    }
    expect(safeNextPath("/anything", "")).toBe("/anything");
    expect(safeNextPath("//evil.test", "")).toBe("/");
  });

  it("finds the client's address behind the front door", () => {
    const h = (xff?: string) => (n: string) => (n === "x-forwarded-for" ? xff : undefined);
    // client, then the front door's address as Render's load balancer saw it
    expect(clientIpFrom(h("203.0.113.9, 10.0.0.7"))).toBe("203.0.113.9");
    expect(clientIpFrom(h("198.51.100.1, 203.0.113.9, 10.0.0.7"))).toBe("203.0.113.9"); // a spoofed first entry is ignored
    expect(clientIpFrom(h("203.0.113.9"), 0)).toBe("203.0.113.9");
    expect(clientIpFrom(h("198.51.100.1, 203.0.113.9"), 0)).toBe("203.0.113.9");
    expect(clientIpFrom(h("203.0.113.9"))).toBe("203.0.113.9"); // fewer hops than proxies: the leftmost
    expect(clientIpFrom(h(undefined))).toBeNull();
    expect(trustedProxiesFromEnv({})).toBe(1);
    expect(trustedProxiesFromEnv({ BASE_AIR_TRUSTED_PROXIES: "0" })).toBe(0);
    expect(trustedProxiesFromEnv({ BASE_AIR_TRUSTED_PROXIES: "lots" })).toBe(1);
  });

  it("writes <base href> and window.__BASE_PATH__ into index.html", () => {
    const html = renderIndexHtml('<!doctype html><html lang="en" data-theme="x"><head><meta charset="UTF-8" /></head><body></body></html>', BASE, {
      head: "<style>:root{--x:1}</style>",
      htmlAttrs: { "data-theme": "dark" },
    });
    expect(html).toContain(`<base href="${BASE}/" />`);
    expect(html).toContain(`window.__BASE_PATH__="${BASE}"`);
    expect(html).toContain("<style>:root{--x:1}</style>");
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(renderIndexHtml("<html><head></head></html>", "")).toContain('<base href="/" />');
  });
});

describe("serving under BASE_PATH", () => {
  let h: DbHandle;
  let fetch: (r: Request) => Promise<Response>;
  let rootFetch: (r: Request) => Promise<Response>;
  let ownerKey = "";
  let dist = "";

  beforeAll(async () => {
    h = await createTestDb();
    const m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
    const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
    ownerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "t", actorType: "human", actorId: "u1", role: "owner" })).secret;
    await m.auth.signup({ email: "ann@acme.test", password: "correct horse 1", name: "Ann", workspaceName: "Ann Co" }, {});
    dist = mkdtempSync(join(tmpdir(), "air-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), '<!doctype html><html lang="en"><head><title>base air</title><script type="module" src="./assets/app.js"></script></head><body></body></html>');
    writeFileSync(join(dist, "assets", "app.js"), "console.log('room')");
    const app = createApp(m, { basePath: BASE, publicUrl: `${ORIGIN}${BASE}` });
    registerWebApp(app, { dist, basePath: BASE });
    fetch = async (r) => withBasePath(app.fetch, BASE)(r) as Promise<Response>;
    const plain = createApp(m, {});
    rootFetch = async (r) => withBasePath(plain.fetch, "")(r) as Promise<Response>;
  });
  afterAll(async () => h.close());

  const req = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);

  it("handles requests under the prefix as if at the root", async () => {
    const r = await fetch(req(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${ownerKey}` } }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { workspace: { slug: string } }).workspace.slug).toBe("acme");
    expect((await fetch(req(`${BASE}/api/health`))).status).toBe(200);
  });

  it("answers /api/health without the prefix and sends everything else there with a 308", async () => {
    expect((await fetch(req("/api/health"))).status).toBe(200);
    const r = await fetch(req("/v1/me?x=1"));
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(`${BASE}/v1/me?x=1`);
    const root = await fetch(req("/"));
    expect(root.status).toBe(308);
    expect(root.headers.get("location")).toBe(`${BASE}/`);
    // a sibling app's path is not ours
    expect((await fetch(req("/imaginesurrey/airplane"))).headers.get("location")).toBe(`${BASE}/imaginesurrey/airplane`);
  });

  it("passes request bodies through the rewrite", async () => {
    const r = await fetch(req(`${BASE}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@acme.test", password: "correct horse 1" }) }));
    expect(r.status).toBe(200);
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith("base_air_session="))!;
    expect(cookie).toContain(`Path=${BASE}`);
    expect(cookie).toContain("Secure");
  });

  it("serves the web app with its prefix written in, and its assets", async () => {
    for (const path of [`${BASE}/`, BASE, `${BASE}/some/deep/link`]) {
      const r = await fetch(req(path));
      expect(r.status, path).toBe(200);
      const html = await r.text();
      expect(html).toContain(`<base href="${BASE}/" />`);
      expect(html).toContain(`window.__BASE_PATH__="${BASE}"`);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    const js = await fetch(req(`${BASE}/assets/app.js`));
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("room");
    expect((await fetch(req(`${BASE}/v1/nothing-here`, { headers: { authorization: `Bearer ${ownerKey}` } }))).status).toBe(404);
  });

  it("sends OAuth callbacks back to the room under the prefix", async () => {
    const r = await fetch(req(`${BASE}/oauth/mock/callback?error=denied`));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${BASE}/?connect_error=denied&connector=mock`);
  });

  it("points the conversion snippet at the prefixed address", async () => {
    expect(await (await fetch(req(`${BASE}/s.js`))).text()).toContain(`"${ORIGIN}${BASE}"`);
  });

  it("with no BASE_PATH behaves as before", async () => {
    const r = await rootFetch(req("/v1/me", { headers: { authorization: `Bearer ${ownerKey}` } }));
    expect(r.status).toBe(200);
    const login = await rootFetch(req("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@acme.test", password: "correct horse 1" }) }));
    expect(login.headers.getSetCookie().find((c) => c.startsWith("base_air_session="))).toContain("Path=/;");
    expect((await rootFetch(req("/oauth/mock/callback?error=denied"))).headers.get("location")).toBe("/?connect_error=denied&connector=mock");
  });
});
