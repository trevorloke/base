import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { AccountRef, ConnectorError } from "../src/index.ts";
import { WeChatConnector, createWeChatConnectors, mapWeChatError, openidOf, wechatMessageToActivity } from "../src/wechat.ts";
import { parseWeChatXml, toWeChatXml, wechatDecrypt, wechatEncrypt, wechatSignature } from "../src/wechat-crypto.ts";

const APPID = "wx1234567890abcdef";
const SECRET = "0123456789abcdef0123456789abcdef";
const GH = "gh_0123456789ab";
const TOKEN = "starsignToken42";
// 43 chars: base64 of 32 bytes without the trailing "=".
const AES = randomBytes(32).toString("base64").replace(/=$/, "").replace(/[+/]/g, "A");
const NOW = new Date("2026-11-06T10:00:00.000Z");
const TS = String(Math.floor(NOW.getTime() / 1000));
const OPENID = "oABCD1234efgh5678ijkl9012mn";

const acct = (auth: Record<string, unknown> = { appId: APPID, appSecret: SECRET, originalId: GH, token: TOKEN }): AccountRef => ({
  id: "acc1",
  workspaceId: "w",
  network: "wechat",
  externalId: GH,
  handle: GH,
  auth,
  config: { appId: APPID, mode: auth.encodingAesKey ? "safe" : "plaintext" },
});
const safeAcct = () => acct({ appId: APPID, appSecret: SECRET, originalId: GH, token: TOKEN, encodingAesKey: AES });

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let clock: Date;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: String(url), method: init?.method, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  clock = NOW;
});
afterEach(() => vi.unstubAllGlobals());
const connector = () => new WeChatConnector({ now: () => clock, publicUrl: "https://app.example/" });
const inputs = { appId: APPID, appSecret: SECRET, originalId: GH, token: TOKEN, encodingAesKey: AES };

const textMsg = (fields: Record<string, string | number> = {}) =>
  toWeChatXml({ ToUserName: GH, FromUserName: OPENID, CreateTime: Number(TS), MsgType: "text", Content: "你好，营业时间？", MsgId: "24680135792468013579", ...fields });

describe("wechat connect", () => {
  it("gets a stable access token and returns the Official Account keyed by its original ID", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "AT-1", expires_in: 7200 }));
    const c = connector();
    const accounts = await c.connectWithInputs({ network: "wechat", inputs: { ...inputs, appId: ` ${APPID} ` } });
    expect(call(0).url).toBe("https://api.weixin.qq.com/cgi-bin/stable_token");
    expect(call(0).method).toBe("POST");
    expect(call(0).json()).toEqual({ grant_type: "client_credential", appid: APPID, secret: SECRET });
    expect(accounts).toEqual([
      {
        network: "wechat",
        identity: { externalId: GH, handle: GH, displayName: null },
        auth: { appId: APPID, appSecret: SECRET, originalId: GH, token: TOKEN, encodingAesKey: AES },
        config: { appId: APPID, mode: "safe", webhookUrl: `https://app.example/webhooks/wechat?account=${GH}` },
      },
    ]);
    expect(c.capabilities()).toMatchObject({ publish: false, reply: true, webhooks: true, accountMetrics: true, fetchActivity: false });
    expect(c.credentialInputs.map((i) => i.key)).toEqual(["appId", "appSecret", "originalId", "token", "encodingAesKey"]);
  });

  it("accepts - for plaintext mode", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "AT-1", expires_in: 7200 }));
    const [a] = await connector().connectWithInputs({ network: "wechat", inputs: { ...inputs, encodingAesKey: "-" } });
    expect(a?.auth).not.toHaveProperty("encodingAesKey");
    expect(a?.config).toMatchObject({ mode: "plaintext" });
  });

  it("explains the IP whitelist error without leaking the secret", async () => {
    fetchMock.mockResolvedValueOnce(json({ errcode: 40164, errmsg: "invalid ip 203.0.113.7 ipv6 ::ffff:203.0.113.7, not in whitelist rid: 1" }));
    const err = (await connector().connectWithInputs({ network: "wechat", inputs }).catch((e: unknown) => e)) as ConnectorError;
    expect(err.kind).toBe("rejected");
    expect(err.message).toMatch(/IP whitelist/);
    expect(err.message).toContain("203.0.113.7");
    expect(err.message).not.toContain(SECRET);
  });

  it("maps a bad AppSecret to auth", async () => {
    fetchMock.mockResolvedValueOnce(json({ errcode: 40125, errmsg: `invalid appsecret ${SECRET}` }));
    const err = (await connector().connectWithInputs({ network: "wechat", inputs }).catch((e: unknown) => e)) as ConnectorError;
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain(SECRET);
  });

  it("rejects malformed inputs before calling WeChat, without echoing them", async () => {
    const err = (await connector().connectWithInputs({ network: "wechat", inputs: { ...inputs, originalId: "acme" } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err.message).toMatch(/original ID/);
    const bad = (await connector().connectWithInputs({ network: "wechat", inputs: { ...inputs, encodingAesKey: "short-key" } }).catch((e: unknown) => e)) as ConnectorError;
    expect(bad.message).not.toContain("short-key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps other error codes", () => {
    expect(mapWeChatError(41004, "appsecret missing", "x").kind).toBe("auth");
    expect(mapWeChatError(40001, "invalid credential", "x").kind).toBe("auth");
    expect(mapWeChatError(45009, "reach max api daily quota limit", "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapWeChatError(-1, "system error", "x")).toMatchObject({ kind: "network", retryable: true });
  });
});

describe("wechat access token", () => {
  it("caches the token per AppID until it nears expiry", async () => {
    fetchMock.mockImplementation(async (url) => (String(url).includes("stable_token") ? json({ access_token: `AT-${fetchMock.mock.calls.length}`, expires_in: 7200 }) : json({ total: 5, count: 5 })));
    const c = connector();
    await c.fetchAccountMetrics(acct());
    await c.fetchAccountMetrics(acct());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("stable_token"))).toHaveLength(1);
    clock = new Date(NOW.getTime() + 7000 * 1000); // within the 5-minute renewal margin
    await c.fetchAccountMetrics(acct());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("stable_token"))).toHaveLength(2);
  });

  it("refreshes once on 40001 and retries", async () => {
    const tokens = ["AT-old", "AT-new"];
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("stable_token")) return json({ access_token: tokens.shift(), expires_in: 7200 });
      if (u.includes("access_token=AT-old")) return json({ errcode: 40001, errmsg: "invalid credential, access_token is invalid or not latest" });
      return json({ total: 42, count: 42 });
    });
    const metrics = await connector().fetchAccountMetrics(acct());
    expect(metrics[0]?.value).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(call(2).json()).toEqual({ grant_type: "client_credential", appid: APPID, secret: SECRET });
  });

  it("forces a refresh when stable_token keeps returning the rejected token", async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("stable_token")) return json({ access_token: JSON.parse(String(init?.body)).force_refresh ? "AT-forced" : "AT-same", expires_in: 7200 });
      n++;
      return u.includes("AT-same") ? json({ errcode: 42001, errmsg: "access_token expired" }) : json({ total: 1 });
    });
    await connector().fetchAccountMetrics(acct());
    expect(n).toBe(2);
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('"force_refresh":true'))).toBe(true);
  });

  it("gives up after one refresh", async () => {
    fetchMock.mockImplementation(async (url) => (String(url).includes("stable_token") ? json({ access_token: `AT-${Math.random()}`, expires_in: 7200 }) : json({ errcode: 40001, errmsg: "invalid credential" })));
    const err = (await connector().fetchAccountMetrics(acct()).catch((e: unknown) => e)) as ConnectorError;
    expect(err.kind).toBe("auth");
    expect(err.message).not.toMatch(/AT-/);
  });
});

describe("wechat webhook handshake and verification", () => {
  const c = () => connector();
  const signed = (token = TOKEN, ts = TS, nonce = "n0nce") => ({ timestamp: ts, nonce, signature: wechatSignature([token, ts, nonce]) });

  it("routes by ?account= and by the XML ToUserName", () => {
    const h = c().webhook;
    expect(h.route!("", { account: GH }, {})).toEqual({ network: "wechat", accountExternalId: GH });
    expect(h.route!(textMsg(), {}, {})).toEqual({ network: "wechat", accountExternalId: GH });
    expect(h.route!(toWeChatXml({ ToUserName: "gh_fedcba987654", Encrypt: "xyz" }), {}, {})).toEqual({ network: "wechat", accountExternalId: "gh_fedcba987654" });
    expect(h.route!("not xml", {}, {})).toBeNull();
    expect(h.route!("", {}, {})).toBeNull();
  });

  it("echoes echostr only for a good signature", () => {
    const h = c().webhook;
    expect(h.challengeAccount!(acct(), { account: GH, ...signed(), echostr: "1234567890" })).toBe("1234567890");
    expect(h.challengeAccount!(acct(), { account: GH, ...signed("wrongToken"), echostr: "1234567890" })).toBeNull();
    expect(h.challengeAccount!(acct(), { account: GH, timestamp: TS, nonce: "n", echostr: "1" })).toBeNull();
    expect(h.challengeAccount!(acct(), { account: GH, ...signed(TOKEN, String(Number(TS) - 3600)), echostr: "1" })).toBeNull();
  });

  it("verifies plaintext deliveries with the signature over token, timestamp and nonce", () => {
    const h = c().webhook;
    const raw = textMsg();
    expect(h.verifyAccount!(acct(), {}, raw, { account: GH, ...signed(), openid: OPENID })).toBe(true);
    expect(h.verifyAccount!(acct(), {}, raw, { account: GH, ...signed("otherToken") })).toBe(false);
    expect(h.verify({}, raw, {})).toBe(false);
  });

  it("rejects stale timestamps", () => {
    const h = c().webhook;
    const old = String(Number(TS) - 301);
    expect(h.verifyAccount!(acct(), {}, textMsg(), { ...signed(TOKEN, old) })).toBe(false);
  });

  it("safe mode: encrypt → verify msg_signature → decrypt → parse", () => {
    const h = c().webhook;
    const inner = textMsg({ Content: "订单 <123> & ]]> 什么时候发货？" });
    const encrypt = wechatEncrypt(inner, AES, APPID);
    const raw = toWeChatXml({ ToUserName: GH, Encrypt: encrypt });
    const nonce = "998877";
    const query = { account: GH, timestamp: TS, nonce, signature: wechatSignature([TOKEN, TS, nonce]), encrypt_type: "aes", msg_signature: wechatSignature([TOKEN, TS, nonce, encrypt]) };
    expect(h.route!(raw, {}, {})).toEqual({ network: "wechat", accountExternalId: GH });
    expect(h.verifyAccount!(safeAcct(), {}, raw, query)).toBe(true);
    // `signature` alone is not enough in safe mode
    expect(h.verifyAccount!(safeAcct(), {}, raw, { ...query, msg_signature: query.signature })).toBe(false);
    const body = h.decodeAccount!(safeAcct(), raw, query);
    const batches = h.parse(body);
    expect(batches).toEqual([
      {
        network: "wechat",
        accountExternalId: GH,
        items: [expect.objectContaining({ kind: "dm", text: "订单 <123> & ]]> 什么时候发货？", externalId: `${OPENID}:24680135792468013579`, authorHandle: OPENID, conversation: { id: OPENID, type: "direct" } })],
      },
    ]);
    expect(h.ack).toEqual({ body: "success", contentType: "text/plain" });
  });

  it("safe mode: a message encrypted for another AppID is refused", () => {
    const h = c().webhook;
    const encrypt = wechatEncrypt(textMsg(), AES, "wxffffffffffffffff");
    const raw = toWeChatXml({ ToUserName: GH, Encrypt: encrypt });
    expect(() => h.decodeAccount!(safeAcct(), raw, {})).toThrow();
    expect(() => wechatDecrypt(encrypt, AES, APPID)).toThrow(/another AppID/);
  });

  it("safe mode: plaintext round trip of the crypto helpers handles block-aligned messages", () => {
    for (const len of [0, 1, 11, 12, 31, 32, 100]) {
      const msg = "x".repeat(len);
      expect(wechatDecrypt(wechatEncrypt(msg, AES, APPID), AES, APPID)).toBe(msg);
    }
  });

  it("an encrypted delivery for an account without an AES key cannot be decoded", () => {
    const raw = toWeChatXml({ ToUserName: GH, Encrypt: wechatEncrypt(textMsg(), AES, APPID) });
    expect(() => c().webhook.decodeAccount!(acct(), raw, {})).toThrow(/EncodingAESKey/);
  });
});

describe("wechat XML", () => {
  it("parses flat XML with CDATA, numbers, entities and nested elements", () => {
    const xml = `<?xml version="1.0"?>
<xml>
  <ToUserName><![CDATA[gh_0123456789ab]]></ToUserName>
  <FromUserName><![CDATA[${OPENID}]]></FromUserName>
  <CreateTime>1793613600</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[a <b> ]]]]><![CDATA[> c]]></Content>
  <Escaped>1 &lt; 2 &amp; &#x4F60;</Escaped>
  <Empty/>
  <ScanCodeInfo><ScanType><![CDATA[qrcode]]></ScanType><ScanResult><![CDATA[1]]></ScanResult></ScanCodeInfo>
  <MsgId>1234567890123456</MsgId>
</xml>`;
    expect(parseWeChatXml(xml)).toEqual({
      ToUserName: GH,
      FromUserName: OPENID,
      CreateTime: "1793613600",
      MsgType: "text",
      Content: "a <b> ]]> c",
      Escaped: "1 < 2 & 你",
      Empty: "",
      ScanCodeInfo: { ScanType: "qrcode", ScanResult: "1" },
      MsgId: "1234567890123456",
    });
  });

  it("refuses input that is not a WeChat message", () => {
    expect(() => parseWeChatXml("<foo>1</foo>")).toThrow();
    expect(() => parseWeChatXml("<xml><A><![CDATA[x</A></xml>")).toThrow();
  });
});

describe("wechat message mapping", () => {
  const map = (fields: Record<string, string | number>) => wechatMessageToActivity(parseWeChatXml(toWeChatXml({ ToUserName: GH, FromUserName: OPENID, CreateTime: Number(TS), ...fields })));

  it("text → dm", () => {
    const r = map({ MsgType: "text", Content: "hello", MsgId: "111" });
    expect(r).toEqual({
      accountExternalId: GH,
      item: { network: "wechat", kind: "dm", externalId: `${OPENID}:111`, authorHandle: OPENID, authorName: null, text: "hello", url: null, parentExternalId: null, occurredAt: NOW.toISOString(), raw: expect.any(Object), conversation: { id: OPENID, type: "direct" } },
    });
  });

  it("falls back to CreateTime for the id when MsgId is absent", () => {
    expect(map({ MsgType: "text", Content: "x" })?.item.externalId).toBe(`${OPENID}:${TS}`);
  });

  it("image, voice with recognition, voice without, location and link become text summaries", () => {
    expect(map({ MsgType: "image", PicUrl: "http://mmbiz.qpic.cn/x", MediaId: "m", MsgId: "2" })?.item).toMatchObject({ kind: "dm", text: "[image] http://mmbiz.qpic.cn/x", url: "http://mmbiz.qpic.cn/x" });
    expect(map({ MsgType: "voice", MediaId: "m", Format: "amr", Recognition: "明天开门吗", MsgId: "3" })?.item.text).toBe("[voice] 明天开门吗");
    expect(map({ MsgType: "voice", MediaId: "m", Format: "amr", MsgId: "4" })?.item.text).toBe("[voice message]");
    expect(map({ MsgType: "location", Location_X: "23.13", Location_Y: "113.26", Scale: "20", Label: "广州", MsgId: "5" })?.item.text).toBe("[location] 广州 (23.13, 113.26)");
    expect(map({ MsgType: "link", Title: "Our menu", Description: "", Url: "https://example.cn/m", MsgId: "6" })?.item).toMatchObject({ text: "[link] Our menu https://example.cn/m", url: "https://example.cn/m" });
    expect(map({ MsgType: "video", MediaId: "m", ThumbMediaId: "t", MsgId: "7" })?.item.text).toBe("[video]");
  });

  it("subscribe → follow; unsubscribe and other events are ignored", () => {
    expect(map({ MsgType: "event", Event: "subscribe" })?.item).toMatchObject({ kind: "follow", externalId: `${OPENID}:subscribe:${TS}`, text: null });
    expect(map({ MsgType: "event", Event: "subscribe", EventKey: "qrscene_store42", Ticket: "t" })?.item.text).toBe("followed (QR scene store42)");
    expect(map({ MsgType: "event", Event: "unsubscribe" })).toBeNull();
    expect(map({ MsgType: "event", Event: "CLICK", EventKey: "MENU_1" })).toBeNull();
  });

  it("parse returns nothing for non-objects", () => {
    expect(connector().webhook.parse(null)).toEqual([]);
  });
});

describe("wechat reply, publish, metrics", () => {
  it("sends a customer service text message to the openid from the parent id", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "AT-1", expires_in: 7200 })).mockResolvedValueOnce(json({ errcode: 0, errmsg: "ok" }));
    const c = connector();
    const r = await c.reply(acct(), { parentExternalId: `${OPENID}:24680135792468013579`, text: "周一到周五 9:00-18:00", idempotencyKey: "rk1" });
    expect(call(1).url).toBe("https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=AT-1");
    expect(call(1).json()).toEqual({ touser: OPENID, msgtype: "text", text: { content: "周一到周五 9:00-18:00" } });
    expect(r).toMatchObject({ externalId: `${OPENID}:reply:rk1`, url: null });
    // idempotent
    await c.reply(acct(), { parentExternalId: `${OPENID}:1`, text: "again", idempotencyKey: "rk1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps 45015 (outside the 48-hour window) to rejected with a plain explanation", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "AT-1", expires_in: 7200 })).mockResolvedValueOnce(json({ errcode: 45015, errmsg: "response out of time limit or subscription is canceled" }));
    const err = (await connector().reply(acct(), { parentExternalId: `${OPENID}:1`, text: "hi", idempotencyKey: "rk2" }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "rejected", retryable: false });
    expect(err.message).toMatch(/48 hours/);
    expect(err.message).not.toContain("AT-1");
  });

  it("refuses ids that do not name a user", () => {
    expect(() => openidOf("bad id!")).toThrow();
    expect(openidOf(OPENID)).toBe(OPENID);
  });

  it("publish is not supported yet", async () => {
    await expect(connector().publish()).rejects.toMatchObject({ kind: "rejected" });
  });

  it("reads followers_total from user/get, and nothing when not permitted", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "AT-1", expires_in: 7200 })).mockResolvedValueOnce(json({ total: 1234, count: 1234, data: { openid: [] }, next_openid: "" }));
    const c = connector();
    expect(await c.fetchAccountMetrics(acct())).toEqual([{ entityType: "social_account", entityId: "acc1", metric: "followers_total", value: 1234, observedAt: NOW.toISOString(), source: "wechat" }]);
    expect(call(1).url).toBe("https://api.weixin.qq.com/cgi-bin/user/get?access_token=AT-1");
    expect(call(1).method).toBe("GET");
    fetchMock.mockResolvedValueOnce(json({ errcode: 48001, errmsg: "api unauthorized" }));
    expect(await c.fetchAccountMetrics(acct())).toEqual([]);
  });

  it("fetchActivity is webhook-only", async () => {
    expect(await connector().fetchActivity()).toEqual([]);
  });

  it("factory builds one connector honoring env", () => {
    const [c] = createWeChatConnectors({ STARSIGN_PUBLIC_URL: "https://s.example", WECHAT_API_BASE: "https://api2.weixin.qq.com/" });
    expect(c?.name).toBe("wechat");
    expect(c?.networks).toEqual(["wechat"]);
  });
});
