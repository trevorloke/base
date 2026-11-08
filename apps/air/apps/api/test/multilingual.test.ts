import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb } from "@base-air/db/test";
import type { DbHandle } from "@base-air/db";
import { ConnectorRegistry, WeChatConnector, toWeChatXml, wechatSignature } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox } from "@base-air/core";
import { FakeGateway, defaultFakeHandlers } from "@base-air/ai";
import { createApp } from "../src/app.ts";

let h: DbHandle;
let m: BaseAir;
let app: ReturnType<typeof createApp>;
let ownerKey: string;
let editorKey: string;
const TOKEN = "wxtoken123";
const auth = (k: string) => ({ "content-type": "application/json", authorization: `Bearer ${k}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();
const wechatFetch = async (url: string | URL | Request) =>
  String(url).includes("stable_token") ? new Response(JSON.stringify({ access_token: "AT", expires_in: 7200 }), { headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ errcode: 0 }));

beforeAll(async () => {
  h = await createTestDb();
  const wechat = new WeChatConnector({ fetch: wechatFetch as typeof fetch, publicUrl: "https://air.test" });
  m = new BaseAir({ handle: h, connectors: new ConnectorRegistry().register(wechat), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)) });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme" }, { type: "human", id: "u1" });
  ownerKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "o", actorType: "human", actorId: "u1", role: "owner" })).secret;
  editorKey = (await m.workspaces.createApiKey({ workspaceId: ws.id, name: "e", actorType: "human", actorId: "u2", role: "editor" })).secret;
  app = createApp(m, { gateway: new FakeGateway(defaultFakeHandlers()), publicUrl: "https://air.test" });
});
afterAll(() => h.close());

describe("WeChat end to end over HTTP, then reading it in English", () => {
  it("connects with the encryption key left empty, answers WeChat's handshake, takes a signed XML message and replies 'success'", async () => {
    const connect = await app.request("/v1/accounts/connect/wechat/credentials", {
      method: "POST",
      headers: auth(ownerKey),
      body: JSON.stringify({ network: "wechat", inputs: { appId: "wx1234567890abcdef", appSecret: "a".repeat(32), originalId: "gh_0123456789ab", token: TOKEN, encodingAesKey: "" } }),
    });
    expect(connect.status).toBe(201);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = wechatSignature([TOKEN, ts, "nonce1"]);
    const hs = await app.request(`/webhooks/wechat?account=gh_0123456789ab&signature=${sig}&timestamp=${ts}&nonce=nonce1&echostr=hello123`);
    expect(await hs.text()).toBe("hello123");
    expect((await app.request(`/webhooks/wechat?account=gh_0123456789ab&signature=bad&timestamp=${ts}&nonce=nonce1&echostr=hello123`)).status).toBe(400);

    const xml = toWeChatXml({ ToUserName: "gh_0123456789ab", FromUserName: "oUser123", CreateTime: ts, MsgType: "text", Content: "你们的新雨衣什么时候上市？", MsgId: "1234567890" });
    const ok = await app.request(`/webhooks/wechat?account=gh_0123456789ab&signature=${sig}&timestamp=${ts}&nonce=nonce1`, { method: "POST", headers: { "content-type": "text/xml" }, body: xml });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/plain");
    expect(await ok.text()).toBe("success");
    const forged = await app.request(`/webhooks/wechat?account=gh_0123456789ab&signature=${wechatSignature(["other", ts, "nonce1"])}&timestamp=${ts}&nonce=nonce1`, { method: "POST", body: xml });
    expect(forged.status).toBe(403);
  });

  it("filters the feed by language, translates on demand, searches the translation, and owns the settings", async () => {
    const feed = await json(await app.request("/v1/feed?languages=zh", { headers: auth(editorKey) }));
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ network: "wechat", kind: "dm", lang: "zh", conversationType: "direct", translation: null });
    expect(await json(await app.request("/v1/feed?languages=ja", { headers: auth(editorKey) }))).toHaveLength(0);

    const tr = await app.request(`/v1/feed/${feed[0].id}/translate`, { method: "POST", headers: auth(editorKey) });
    expect(tr.status).toBe(200);
    expect(await json(tr)).toMatchObject({ translation: "[en] 你们的新雨衣什么时候上市？", translationLang: "en" });
    expect(await json(await app.request("/v1/feed?q=%5Ben%5D", { headers: auth(editorKey) }))).toHaveLength(1);

    const langs = await json(await app.request("/v1/languages", { headers: auth(editorKey) }));
    expect(langs).toMatchObject({ settings: { home: "en", autoTranslate: true }, seen: [{ lang: "zh", n: 1 }], translationAvailable: true });
    expect((await app.request("/v1/languages/settings", { method: "PATCH", headers: auth(editorKey), body: JSON.stringify({ home: "ja" }) })).status).toBe(403);
    expect(await json(await app.request("/v1/languages/settings", { method: "PATCH", headers: auth(ownerKey), body: JSON.stringify({ home: "ja", dailyLimit: 500 }) }))).toMatchObject({ home: "ja", dailyLimit: 500 });
    expect((await app.request("/v1/languages/settings", { method: "PATCH", headers: auth(ownerKey), body: JSON.stringify({ home: "Japanese" }) })).status).toBe(400);
  });

  it("expands a stream's keywords, and refuses model work when the spend cap is reached", async () => {
    const s = await json(await app.request("/v1/streams", { method: "POST", headers: auth(ownerKey), body: JSON.stringify({ name: "Rain gear", query: { keywords: ["rain jacket"] } }) }));
    const ex = await app.request(`/v1/streams/${s.id}/expand`, { method: "POST", headers: auth(editorKey), body: JSON.stringify({ languages: ["zh", "ja"] }) });
    expect(ex.status).toBe(200);
    expect((await json(ex)).query.translations).toEqual({ zh: ["rain jacket (zh)"], ja: ["rain jacket (ja)"] });

    const p = await m.policy.getActive((await json(await app.request("/v1/me", { headers: auth(ownerKey) }))).workspace.id);
    await app.request("/v1/policy", { method: "PUT", headers: auth(ownerKey), body: JSON.stringify({ ...p, spendCaps: { ...p.spendCaps, modelUsdMonthly: 0 } }) });
    const capped = await app.request(`/v1/streams/${s.id}/expand`, { method: "POST", headers: auth(editorKey), body: JSON.stringify({ languages: ["es"] }) });
    expect(capped.status).toBe(503);
    expect((await json(capped)).error.message).toMatch(/spend cap/);
  });
});
