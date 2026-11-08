import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox } from "@base-air/core";
import { FakeGateway, defaultFakeHandlers } from "@base-air/ai";
import { createApp } from "../src/app.ts";

let h: DbHandle;
let m: BaseAir;
let app: ReturnType<typeof createApp>;
let ownerKey: string;
let viewerKey: string;
let agentKey: string;
let acct: string;
let wsId: string;
const auth = (k: string) => ({ "content-type": "application/json", authorization: `Bearer ${k}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
let n = 0;
const msg = (text: string, authorHandle = `p${++n}`) => ({ network: "bluesky", kind: "mention", externalId: `b${++n}`, authorHandle, authorName: null, text, url: null, parentExternalId: null, occurredAt: new Date().toISOString(), raw: {} });

beforeAll(async () => {
  h = await createTestDb();
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const ws = await m.workspaces.create({ slug: "agency", name: "Agency" }, { type: "human", id: "u1" });
  wsId = ws.id;
  ownerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "o", actorType: "human", actorId: "u1", role: "owner" })).secret;
  viewerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "v", actorType: "human", actorId: "u2", role: "viewer" })).secret;
  agentKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "a", actorType: "mcp", actorId: "claude" })).secret;
  acct = (await m.accounts.connect({ workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" }, { network: "bluesky", externalId: "did:1", handle: "agency.bsky.social", connector: "mock" })).id;
  app = createApp(m, { gateway: new FakeGateway(defaultFakeHandlers()) });
});
afterAll(() => h.close());

describe("tracker api", () => {
  it("tracks a prospect's brand and its founder, reports, filters the feed, and suggests aliases", async () => {
    const brand = await json(await app.request("/v1/entities", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ kind: "organization", name: "Northwind Coffee", role: "brand", relation: "prospect", aliases: ["Northwind"], context: ["coffee", "café", "beans"] }) }));
    expect(brand).toMatchObject({ name: "Northwind Coffee", relation: "prospect", trendTopicId: expect.any(String) });
    // An agent can add a person; a viewer cannot.
    const founder = await app.request("/v1/entities", { method: "POST", headers: auth(agentKey), body: JSON.stringify({ kind: "person", name: "Ana Kim", role: "founder", parentId: brand.id, handles: { bluesky: ["anakim.bsky.social"] } }) });
    expect(founder.status).toBe(201);
    const ana = await json(founder);
    expect((await app.request("/v1/entities", { method: "POST", headers: auth(viewerKey), body: JSON.stringify({ kind: "person", name: "Z" }) })).status).toBe(403);
    expect((await app.request("/v1/entities", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ kind: "robot", name: "Z" }) })).status).toBe(400);

    await m.listening.ingestItems(wsId, acct, [msg("Northwind beans are the best"), msg("Ana Kim on building a coffee brand"), msg("New roast drops Friday", "anakim.bsky.social"), msg("Northwind Airlines delayed again")]);
    const report = await json(await app.request("/v1/entities/report", { headers: auth(viewerKey) }));
    const by = Object.fromEntries(report.entities.map((e: { name: string }) => [e.name, e]));
    expect(by["Northwind Coffee"]).toMatchObject({ mentions: 1, familyMentions: 2, shareOfVoice: 100 }); // the airline is not the coffee brand
    expect(by["Ana Kim"]).toMatchObject({ mentions: 1, authored: 1, shareWithinParent: 100 });

    const feed = await json(await app.request(`/v1/feed?entity=${brand.id}&children=1`, { headers: auth(viewerKey) }));
    expect(feed.map((a: { text: string }) => a.text).sort()).toEqual(["Ana Kim on building a coffee brand", "New roast drops Friday", "Northwind beans are the best"]);
    expect(await json(await app.request(`/v1/feed?entity=${brand.id}`, { headers: auth(viewerKey) }))).toHaveLength(1);
    const mentions = await json(await app.request(`/v1/entities/${ana.id}/mentions`, { headers: auth(viewerKey) }));
    expect(mentions.map((r: { mention: { how: string } }) => r.mention.how).sort()).toEqual(["author", "name"]);

    const sugg = await json(await app.request(`/v1/entities/${ana.id}/suggest-aliases`, { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ languages: ["ko", "en"] }) }));
    expect(sugg).toMatchObject({ languages: ["ko", "en"], aliases: [{ text: "#AnaKim", lang: "und" }] });
    const patched = await json(await app.request(`/v1/entities/${ana.id}`, { method: "PATCH", headers: auth(ownerKey), body: JSON.stringify({ aliases: ["#AnaKim", "김아나"] }) }));
    expect(patched.aliases).toEqual(["#AnaKim", "김아나"]);

    expect((await app.request(`/v1/entities/${ana.id}`, { method: "DELETE", headers: auth(viewerKey) })).status).toBe(403);
    expect((await app.request(`/v1/entities/${ana.id}`, { method: "DELETE", headers: auth(ownerKey) })).status).toBe(204);
    expect((await json(await app.request("/v1/entities", { headers: auth(viewerKey) }))).map((e: { name: string }) => e.name)).toEqual(["Northwind Coffee"]);
  });
});
