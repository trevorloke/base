import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@starsign/db/test";
import type { DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector } from "@starsign/connectors";
import { InMemoryScheduler, Starsign, SecretBox } from "@starsign/core";
import { createApp } from "../src/app.ts";

let h: DbHandle;
let app: ReturnType<typeof createApp>;
let ownerKey: string;
let agentKey: string;
let viewerKey: string;
const auth = (k: string) => ({ "content-type": "application/json", authorization: `Bearer ${k}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const PHONE = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36";

beforeAll(async () => {
  h = await createTestDb();
  const m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), linkBaseUrl: "https://app.acme.test/l" });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
  ownerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "o", actorType: "human", actorId: "u1", role: "owner" })).secret;
  viewerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "v", actorType: "human", actorId: "u2", role: "viewer" })).secret;
  agentKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "site", actorType: "operator", actorId: "shop-backend" })).secret;
  app = createApp(m, { publicUrl: "https://app.acme.test" });
});
afterAll(() => h.close());

describe("links api", () => {
  it("creates a link, redirects with a click id, takes conversions from the site and the browser, and reports", async () => {
    const created = await app.request("/v1/links", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ url: "https://shop.acme.test/sale", network: "linkedin", campaign: "fall" }) });
    expect(created.status).toBe(201);
    const link = await json(created);
    expect(link.shortUrl).toMatch(/^https:\/\/app\.acme\.test\/l\/\w{7}$/);
    expect((await app.request("/v1/links", { method: "POST", headers: auth(viewerKey), body: JSON.stringify({ url: "https://a.test" }) })).status).toBe(403);
    expect((await app.request("/v1/links", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ url: "javascript:alert(1)" }) })).status).toBe(400);

    // The redirect is public, uncached, and carries UTM tags plus ssclid.
    const r = await app.request(`/l/${link.slug}`, { headers: { "user-agent": PHONE, "x-forwarded-for": "9.9.9.9, 10.0.0.1" } });
    expect(r.status).toBe(302);
    expect(r.headers.get("cache-control")).toContain("no-store");
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("utm_source")).toBe("linkedin");
    expect(loc.searchParams.get("utm_campaign")).toBe("fall");
    const clickId = loc.searchParams.get("ssclid")!;
    expect((await app.request("/l/zzzzzzz")).status).toBe(404);

    // Server-to-server conversion with an API key; replays are recognised.
    const conv = await app.request("/v1/conversions", { method: "POST", headers: auth(agentKey), body: JSON.stringify({ clickId, name: "purchase", value: 120.5, currency: "CAD", externalId: "o-9" }) });
    expect(conv.status).toBe(201);
    expect((await app.request("/v1/conversions", { method: "POST", headers: auth(agentKey), body: JSON.stringify({ clickId, name: "purchase", externalId: "o-9" }) })).status).toBe(200);
    expect((await app.request("/v1/conversions", { method: "POST", headers: auth(agentKey), body: JSON.stringify({ value: -1 }) })).status).toBe(400);

    // Browser beacon: text/plain, CORS-open, always 204.
    const pre = await app.request("/c", { method: "OPTIONS" });
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect((await app.request("/c", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ clickId, name: "signup" }) })).status).toBe(204);
    expect((await app.request("/c", { method: "POST", body: "not json" })).status).toBe(204);

    const report = await json(await app.request("/v1/links/report", { headers: auth(ownerKey) }));
    expect(report.totals).toMatchObject({ clicks: 1, uniqueVisitors: 1, conversions: 2, conversionValue: 120.5 });
    expect(report.totals.valueByCurrency).toEqual([{ currency: "CAD", value: 120.5 }]);
    const list = await json(await app.request("/v1/links", { headers: auth(ownerKey) }));
    expect(list.links[0].stats).toMatchObject({ clicks: 1, conversions: 2 });
    expect(list.baseUrl).toBe("https://app.acme.test/l");

    // Settings are owner-only; turning click ids off stops ssclid.
    expect((await app.request("/v1/links/settings", { method: "PATCH", headers: auth(agentKey), body: JSON.stringify({ clickIds: false }) })).status).toBe(403);
    const s = await json(await app.request("/v1/links/settings", { method: "PATCH", headers: auth(ownerKey), body: JSON.stringify({ clickIds: false }) }));
    expect(s).toMatchObject({ clickIds: false, enabled: true, utm: true });
    const r2 = await app.request(`/l/${link.slug}`, { headers: { "user-agent": PHONE } });
    expect(new URL(r2.headers.get("location")!).searchParams.has("ssclid")).toBe(false);

    expect((await app.request(`/v1/links/${link.id}`, { method: "DELETE", headers: auth(ownerKey) })).status).toBe(204);
    expect((await app.request(`/l/${link.slug}`, { headers: { "user-agent": PHONE } })).status).toBe(404);
  });

  it("serves the conversion snippet pointed at this deployment", async () => {
    const r = await app.request("/s.js");
    expect(r.headers.get("content-type")).toContain("javascript");
    const js = await r.text();
    expect(js).toContain('"https://app.acme.test"');
    expect(js).toContain("ssclid");
    expect(() => new Function(js)).not.toThrow(); // it parses
  });
});
