import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { LineConnector, createLineConnectors, lineEventToActivities, lineMessageText, lineRetryKey, lineSignatureValid, mapLineError, tokyoDate, type LineEvent } from "../src/line.ts";

const TOKEN = "lineLongLivedChannelAccessToken_abcdefghijklmnopqrstuvwxyz0123456789=";
const SECRET_A = "0123456789abcdef0123456789abcdef";
const SECRET_B = "fedcba9876543210fedcba9876543210";
const BOT = "U" + "a".repeat(32);
const GROUP = "C" + "1".repeat(32);
const ROOM = "R" + "2".repeat(32);
const USER = "U" + "3".repeat(32);
const NOW = new Date("2026-11-06T01:00:00.000Z"); // 10:00 in Tokyo on Nov 6

const acct: AccountRef = {
  id: "acc1",
  workspaceId: "w",
  network: "line",
  externalId: BOT,
  handle: "@123abcde",
  auth: { channelAccessToken: TOKEN, channelSecret: SECRET_A },
  config: { botUserId: BOT, basicId: "@123abcde" },
};
const otherAcct: AccountRef = { ...acct, id: "acc2", auth: { channelAccessToken: TOKEN, channelSecret: SECRET_B } };
const input: PublishInput = { variantId: "v1", text: "新商品が出ました", media: [], thread: [], idempotencyKey: "k1" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return { url: String(url), method: init?.method, headers, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const connector = (opts: ConstructorParameters<typeof LineConnector>[0] = {}) => new LineConnector({ now: () => NOW, ...opts });

const base = (over: Partial<LineEvent>): LineEvent => ({ type: "message", timestamp: 1793929200000, mode: "active", webhookEventId: "01JEVT0000000000000000000A", deliveryContext: { isRedelivery: false }, replyToken: "rtok", ...over });
const textMsg = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, type: "text", text, quoteToken: `q-${id}`, ...extra });
const groupSrc = { type: "group", groupId: GROUP, userId: USER };

async function rejects(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    return err as ConnectorError;
  }
  throw new Error("expected a rejection");
}

describe("line connect", () => {
  it("reads the bot info and returns one account keyed by the bot user id", async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/v2/bot/info")) return json({ userId: BOT, basicId: "@123abcde", displayName: "Acme Japan", pictureUrl: "https://profile.line-scdn.net/x", chatMode: "bot", markAsReadMode: "auto" });
      if (u.endsWith("/v2/bot/channel/webhook/endpoint")) return json({ endpoint: "https://app.example/webhooks/line", active: true });
      throw new Error(`unexpected ${u}`);
    });
    const c = connector({ publicUrl: "https://app.example/" });
    const accounts = await c.connectWithInputs({ network: "line", inputs: { channelAccessToken: ` ${TOKEN} `, channelSecret: SECRET_A } });
    expect(call(0)).toMatchObject({ url: "https://api.line.me/v2/bot/info", method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(accounts).toEqual([
      {
        network: "line",
        identity: { externalId: BOT, handle: "@123abcde", displayName: "Acme Japan" },
        auth: { channelAccessToken: TOKEN, channelSecret: SECRET_A },
        config: { botUserId: BOT, basicId: "@123abcde", premiumId: null, displayName: "Acme Japan", pictureUrl: "https://profile.line-scdn.net/x", chatMode: "bot", webhookEndpoint: "https://app.example/webhooks/line", webhookActive: true, webhookPointsHere: true },
      },
    ]);
    expect(c.connectMethod).toBe("bot_token");
    expect(c.credentialInputs.map((i) => [i.key, i.secret])).toEqual([["channelAccessToken", true], ["channelSecret", true]]);
    expect(c.capabilities()).toMatchObject({ publish: true, fetchActivity: false, reply: true, moderate: false, accountMetrics: true, webhooks: true });
  });

  it("still connects when the channel has no webhook URL yet", async () => {
    fetchMock.mockImplementation(async (url) => (String(url).endsWith("/v2/bot/info") ? json({ userId: BOT, basicId: "@123abcde", displayName: "Acme", chatMode: "bot", markAsReadMode: "auto" }) : json({ message: "Not found" }, 404)));
    const [a] = await connector().connectWithInputs({ network: "line", inputs: { channelAccessToken: TOKEN, channelSecret: SECRET_A } });
    expect(a?.config).toMatchObject({ webhookEndpoint: null, webhookActive: null, webhookPointsHere: null });
  });

  it("maps a bad token to an auth error without echoing it", async () => {
    fetchMock.mockResolvedValue(json({ message: "Authentication failed. Confirm that the access token in the authorization header is valid." }, 401));
    const err = await rejects(connector().connectWithInputs({ network: "line", inputs: { channelAccessToken: TOKEN, channelSecret: SECRET_A } }));
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).not.toContain(TOKEN);
  });

  it("refuses missing inputs before calling LINE", async () => {
    const err = await rejects(connector().connectWithInputs({ network: "line", inputs: { channelAccessToken: TOKEN } }));
    expect(err.kind).toBe("auth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("describeAccount reads the bot info", async () => {
    fetchMock.mockResolvedValue(json({ userId: BOT, basicId: "@123abcde", displayName: "Acme", chatMode: "bot", markAsReadMode: "auto" }));
    expect(await connector().describeAccount({ channelAccessToken: TOKEN })).toEqual({ externalId: BOT, handle: "@123abcde", displayName: "Acme" });
  });

  it("factory builds one connector named line", () => {
    const [c] = createLineConnectors({ STARSIGN_PUBLIC_URL: "https://app.example" });
    expect(c).toMatchObject({ name: "line", networks: ["line"] });
  });
});

describe("line webhooks", () => {
  const raw = JSON.stringify({ destination: BOT, events: [base({ source: groupSrc, message: textMsg("100", "こんにちは") })] });
  const sig = (secret: string, body = raw) => createHmac("sha256", secret).update(body).digest("base64");

  it("routes by destination and ignores unreadable bodies", () => {
    const c = connector();
    expect(c.webhook.route?.(raw, {}, {})).toEqual({ network: "line", accountExternalId: BOT });
    expect(c.webhook.route?.("", {}, {})).toBeNull();
    expect(c.webhook.route?.("not json", {}, {})).toBeNull();
    expect(c.webhook.route?.(JSON.stringify({ events: [] }), {}, {})).toBeNull();
    expect(c.webhook.verify({}, raw)).toBe(false);
  });

  it("verifies x-line-signature with the account's own channel secret", () => {
    const c = connector();
    expect(c.webhook.verifyAccount?.(acct, { "x-line-signature": sig(SECRET_A) }, raw, {})).toBe(true);
    expect(c.webhook.verifyAccount?.(acct, { "X-Line-Signature": sig(SECRET_A) }, raw, {})).toBe(true);
    expect(c.webhook.verifyAccount?.(acct, { "x-line-signature": sig(SECRET_A) }, raw + " ", {})).toBe(false); // tampered body
    expect(c.webhook.verifyAccount?.(acct, { "x-line-signature": "bm9wZQ==" }, raw, {})).toBe(false);
    expect(c.webhook.verifyAccount?.(acct, {}, raw, {})).toBe(false);
    // Another channel's secret cannot speak for this account, and this account's secret cannot speak for it.
    expect(c.webhook.verifyAccount?.(acct, { "x-line-signature": sig(SECRET_B) }, raw, {})).toBe(false);
    expect(c.webhook.verifyAccount?.(otherAcct, { "x-line-signature": sig(SECRET_A) }, raw, {})).toBe(false);
    expect(lineSignatureValid("", raw, sig(SECRET_A))).toBe(false);
  });

  it("parses a group text message into a message in a group conversation, keeping the reply token in raw", () => {
    const [batch, ...rest] = connector().webhook.parse(JSON.parse(raw));
    expect(rest).toEqual([]);
    expect(batch).toMatchObject({ network: "line", accountExternalId: BOT });
    expect(batch?.items).toEqual([
      {
        network: "line",
        kind: "message",
        externalId: `${GROUP}:100`,
        authorHandle: USER,
        authorName: null,
        text: "こんにちは",
        url: null,
        parentExternalId: null,
        occurredAt: new Date(1793929200000).toISOString(),
        raw: expect.objectContaining({ replyToken: "rtok", webhookEventId: "01JEVT0000000000000000000A" }),
        conversation: { id: GROUP, name: null, type: "group" },
      },
    ]);
  });

  it("returns nothing for LINE's empty verification delivery", () => {
    expect(connector().webhook.parse({ destination: BOT, events: [] })).toEqual([]);
  });

  it("maps rooms to group conversations and 1:1 chats to dm", () => {
    const room = lineEventToActivities(BOT, base({ source: { type: "room", roomId: ROOM, userId: USER }, message: textMsg("101", "hi") }));
    expect(room[0]).toMatchObject({ kind: "message", externalId: `${ROOM}:101`, conversation: { id: ROOM, type: "group" } });
    const dm = lineEventToActivities(BOT, base({ source: { type: "user", userId: USER }, message: textMsg("102", "在庫ありますか？") }));
    expect(dm[0]).toMatchObject({ kind: "dm", externalId: `${USER}:102`, authorHandle: USER, conversation: { id: USER, type: "direct" } });
  });

  it("marks a mention of the bot (isSelf) as mention, not mentions of others", () => {
    const mention = (isSelf: boolean) => lineEventToActivities(BOT, base({ source: groupSrc, message: textMsg("103", "@Acme 営業時間は？", { mention: { mentionees: [{ index: 0, length: 5, type: "user", userId: isSelf ? BOT : USER, isSelf }] } }) }));
    expect(mention(true)[0]?.kind).toBe("mention");
    expect(mention(false)[0]?.kind).toBe("message");
  });

  it("summarizes stickers, images, video, audio, files and locations", () => {
    expect(lineMessageText({ id: "1", type: "sticker", packageId: "446", stickerId: "1988", keywords: ["happy", "smile", "joy", "fun"] })).toBe("[Sticker: happy, smile, joy]");
    expect(lineMessageText({ id: "1", type: "sticker", text: "おめでとう" })).toBe("[Sticker] おめでとう");
    expect(lineMessageText({ id: "1", type: "image" })).toBe("[Image]");
    expect(lineMessageText({ id: "1", type: "image", imageSet: { id: "s", index: 2, total: 3 } })).toBe("[Image 2/3]");
    expect(lineMessageText({ id: "1", type: "video", duration: 65_000 })).toBe("[Video 1:05]");
    expect(lineMessageText({ id: "1", type: "audio", duration: 4_000 })).toBe("[Audio 0:04]");
    expect(lineMessageText({ id: "1", type: "file", fileName: "menu.pdf", fileSize: 2_400_000 })).toBe("[File: menu.pdf (2.4 MB)]");
    expect(lineMessageText({ id: "1", type: "location", title: "Acme Shibuya", address: "Tokyo", latitude: 35.6, longitude: 139.7 })).toBe("[Location: Acme Shibuya, Tokyo]");
    const [img] = lineEventToActivities(BOT, base({ source: groupSrc, message: { id: "104", type: "image", quoteToken: "q" } }));
    expect(img).toMatchObject({ kind: "message", text: "[Image]", externalId: `${GROUP}:104` });
  });

  it("links a quoted message as the parent, and quoting one of the bot's own pushes is a reply", async () => {
    const quoted = lineEventToActivities(BOT, base({ source: groupSrc, message: textMsg("105", "これです", { quotedMessageId: "99" }) }));
    expect(quoted[0]).toMatchObject({ kind: "message", parentExternalId: `${GROUP}:99` });

    const c = connector();
    fetchMock.mockResolvedValue(json({ sentMessages: [{ id: "500", quoteToken: "q500" }] }));
    await c.reply(acct, { parentExternalId: `${GROUP}:105`, text: "ありがとうございます", idempotencyKey: "r0" });
    const [batch] = c.webhook.parse({ destination: BOT, events: [base({ source: groupSrc, message: textMsg("106", "了解", { quotedMessageId: "500" }) })] });
    expect(batch?.items[0]).toMatchObject({ kind: "reply", parentExternalId: `${GROUP}:500` });
  });

  it("maps join, memberJoined and follow to follow, and ignores unsend and others", () => {
    const join = lineEventToActivities(BOT, base({ type: "join", source: { type: "group", groupId: GROUP } }));
    expect(join).toEqual([expect.objectContaining({ kind: "follow", externalId: `${GROUP}:join:01JEVT0000000000000000000A`, authorHandle: null, conversation: { id: GROUP, name: null, type: "group" } })]);
    const joined = lineEventToActivities(BOT, base({ type: "memberJoined", source: { type: "group", groupId: GROUP }, joined: { members: [{ type: "user", userId: USER }, { type: "user", userId: BOT.replace("a", "b") }] } }));
    expect(joined.map((a) => [a.kind, a.authorHandle])).toEqual([["follow", USER], ["follow", BOT.replace("a", "b")]]);
    const follow = lineEventToActivities(BOT, base({ type: "follow", source: { type: "user", userId: USER }, follow: { isUnblocked: false } }));
    expect(follow[0]).toMatchObject({ kind: "follow", authorHandle: USER, text: "[Added the account as a friend]", conversation: { id: USER, type: "direct" } });
    expect(lineEventToActivities(BOT, base({ type: "unsend", source: groupSrc }))).toEqual([]);
    expect(lineEventToActivities(BOT, base({ type: "leave", source: { type: "group", groupId: GROUP } }))).toEqual([]);
    expect(lineEventToActivities(BOT, base({ type: "postback", source: groupSrc }))).toEqual([]);
  });

  it("fills names from the cache after resolveNames, and parse stays network-free", async () => {
    const c = connector();
    const body = { destination: BOT, events: [base({ source: groupSrc, message: textMsg("107", "first") })] };
    c.webhook.parse(body);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith(`/v2/bot/group/${GROUP}/summary`)) return json({ groupId: GROUP, groupName: "Acmeファン" });
      if (u.endsWith(`/v2/bot/group/${GROUP}/member/${USER}`)) return json({ userId: USER, displayName: "さくら" });
      throw new Error(`unexpected ${u}`);
    });
    expect(await c.resolveNames(acct)).toBe(2);
    const [batch] = c.webhook.parse({ destination: BOT, events: [base({ source: groupSrc, message: textMsg("108", "second") })] });
    expect(batch?.items[0]).toMatchObject({ authorName: "さくら", conversation: { id: GROUP, name: "Acmeファン", type: "group" } });
    expect(c.cachedName(BOT, GROUP)).toBe("Acmeファン");
    expect(await c.resolveNames(acct)).toBe(0); // nothing left to look up
  });
});

describe("line reply", () => {
  it("pushes into the parent's conversation with a retry key and the parent's quote token", async () => {
    const c = connector();
    c.webhook.parse({ destination: BOT, events: [base({ source: groupSrc, message: textMsg("200", "営業時間は？") })] });
    fetchMock.mockResolvedValue(json({ sentMessages: [{ id: "600", quoteToken: "q600" }] }, 200, { "x-line-request-id": "req-1" }));
    const r = await c.reply(acct, { parentExternalId: `${GROUP}:200`, text: "10時から19時です", idempotencyKey: "rk1" });
    expect(call(0)).toMatchObject({ url: "https://api.line.me/v2/bot/message/push", method: "POST", headers: { "x-line-retry-key": lineRetryKey("rk1") } });
    expect(call(0).json()).toEqual({ to: GROUP, messages: [{ type: "text", text: "10時から19時です", quoteToken: "q-200" }] });
    expect(r).toMatchObject({ externalId: `${GROUP}:600`, url: null });
    // Same idempotency key in-process: no second request.
    await c.reply(acct, { parentExternalId: `${GROUP}:200`, text: "10時から19時です", idempotencyKey: "rk1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("derives a stable UUID retry key", () => {
    expect(lineRetryKey("abc")).toBe(lineRetryKey("abc"));
    expect(lineRetryKey("abc")).not.toBe(lineRetryKey("abd"));
    expect(lineRetryKey("abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("treats 409 (retry key already accepted) as sent", async () => {
    fetchMock.mockResolvedValue(json({ message: "The retry key is already accepted", sentMessages: [{ id: "601", quoteToken: "q601" }] }, 409, { "x-line-accepted-request-id": "req-0" }));
    const r = await connector().reply(acct, { parentExternalId: `${USER}:201`, text: "はい", idempotencyKey: "rk2" });
    expect(call(0).json()).toEqual({ to: USER, messages: [{ type: "text", text: "はい" }] });
    expect(r).toMatchObject({ externalId: `${USER}:601`, raw: expect.objectContaining({ alreadyAccepted: true, requestId: "req-0" }) });
  });

  it("falls back to the accepted request id when a 409 carries no message ids", async () => {
    fetchMock.mockResolvedValue(json({ message: "The retry key is already accepted" }, 409, { "x-line-accepted-request-id": "req-9" }));
    const r = await connector().reply(acct, { parentExternalId: `${USER}:202`, text: "はい", idempotencyKey: "rk3" });
    expect(r.externalId).toBe(`${USER}:req-req-9`);
  });

  it("refuses parents that do not name a chat", async () => {
    expect(await rejects(connector().reply(acct, { parentExternalId: "12345", text: "x", idempotencyKey: "rk4" }))).toMatchObject({ kind: "rejected" });
    expect(await rejects(connector().reply(acct, { parentExternalId: "broadcast:req-1", text: "x", idempotencyKey: "rk5" }))).toMatchObject({ kind: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moderate is not available", async () => {
    expect(await rejects(connector().moderate(acct, { externalId: `${GROUP}:1`, action: "delete" }))).toMatchObject({ kind: "rejected", retryable: false });
  });
});

describe("line publish", () => {
  const image = { kind: "image" as const, url: "https://cdn.example/a.jpg", mime: "image/jpeg", bytes: 800_000 };

  it("broadcasts text plus an image to all friends with a retry key", async () => {
    fetchMock.mockResolvedValue(json({}, 200, { "x-line-request-id": "bc-1" }));
    const r = await connector().publish(acct, { ...input, media: [image], options: { link: "https://acme.example/new" } });
    expect(call(0)).toMatchObject({ url: "https://api.line.me/v2/bot/message/broadcast", method: "POST", headers: { "x-line-retry-key": lineRetryKey("k1"), "content-type": "application/json" } });
    expect(call(0).json()).toEqual({
      messages: [
        { type: "text", text: "新商品が出ました\n\nhttps://acme.example/new" },
        { type: "image", originalContentUrl: "https://cdn.example/a.jpg", previewImageUrl: "https://cdn.example/a.jpg" },
      ],
    });
    expect(r).toMatchObject({ externalId: "broadcast:bc-1", url: null });
  });

  it("pushes to the configured default group, using the thumbnail as preview", async () => {
    fetchMock.mockResolvedValue(json({ sentMessages: [{ id: "700", quoteToken: "q700" }, { id: "701", quoteToken: "q701" }] }));
    const groupAcct = { ...acct, config: { ...acct.config, defaultGroupId: GROUP } };
    const big = { ...image, bytes: 5_000_000 };
    const r = await connector().publish(groupAcct, { ...input, media: [big], options: { thumbnailUrl: "https://cdn.example/a-small.jpg" } });
    expect(call(0).url).toBe("https://api.line.me/v2/bot/message/push");
    expect(call(0).json()).toEqual({ to: GROUP, messages: [{ type: "text", text: "新商品が出ました" }, { type: "image", originalContentUrl: "https://cdn.example/a.jpg", previewImageUrl: "https://cdn.example/a-small.jpg" }] });
    expect(r).toMatchObject({ externalId: `${GROUP}:700`, threadExternalIds: [`${GROUP}:701`] });
  });

  it("treats a broadcast 409 as already accepted", async () => {
    fetchMock.mockResolvedValue(json({ message: "The retry key is already accepted" }, 409, { "x-line-accepted-request-id": "bc-0" }));
    const r = await connector().publish(acct, input);
    expect(r).toMatchObject({ externalId: "broadcast:bc-0", raw: expect.objectContaining({ alreadyAccepted: true }) });
  });

  it("validates HTTPS, format, sizes, count and threads", () => {
    const c = connector();
    const codes = (p: Partial<PublishInput>) => c.validate(acct, { ...input, ...p }).map((i) => i.code);
    expect(codes({})).toEqual([]);
    expect(codes({ text: "", media: [] })).toEqual(["empty"]);
    expect(codes({ text: "あ".repeat(5001) })).toEqual(["too_long"]);
    expect(codes({ thread: ["more"] })).toEqual(["thread_unsupported"]);
    expect(codes({ media: [image, image] })).toEqual(["too_many_media"]);
    expect(codes({ media: [{ ...image, url: "http://cdn.example/a.jpg" }] })).toEqual(["unsupported_media"]);
    expect(codes({ media: [{ ...image, mime: "image/gif" }] })).toEqual(["unsupported_media"]);
    expect(codes({ media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] })).toEqual(["unsupported_media"]);
    expect(codes({ media: [{ ...image, bytes: 11_000_000 }], options: { thumbnailUrl: "https://cdn.example/t.jpg" } })).toEqual(["unsupported_media"]);
    expect(codes({ media: [{ ...image, bytes: 3_000_000 }] })).toEqual(["unsupported_media"]); // preview would exceed 1 MB
    expect(codes({ media: [{ ...image, bytes: 3_000_000 }], options: { thumbnailUrl: "https://cdn.example/t.jpg" } })).toEqual([]);
  });

  it("refuses invalid posts before calling LINE", async () => {
    const err = await rejects(connector().publish(acct, { ...input, media: [{ ...image, url: "http://insecure.example/a.jpg" }] }));
    expect(err).toMatchObject({ kind: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the monthly quota 429 to a non-retryable rejection", async () => {
    fetchMock.mockResolvedValue(json({ message: "You have reached your monthly limit." }, 429));
    const err = await rejects(connector().publish(acct, input));
    expect(err).toMatchObject({ kind: "rejected", retryable: false });
    expect(err.message).toMatch(/monthly message allowance/);
  });

  it("maps rate limits, server errors and other failures", async () => {
    expect(mapLineError(429, { message: "Too Many Requests" }, "push")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapLineError(500, { message: "Internal" }, "push")).toMatchObject({ kind: "network", retryable: true });
    expect(mapLineError(401, { message: "Authentication failed" }, "push")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapLineError(403, { message: "Access to this API is not available for your account" }, "insight")).toMatchObject({ kind: "rejected", retryable: false });
    const bad = mapLineError(400, { message: "The request body has 1 error(s)", details: [{ message: "must be specified", property: "messages[0].text" }] }, "push");
    expect(bad).toMatchObject({ kind: "rejected" });
    expect(bad.message).toContain("messages[0].text: must be specified");
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await rejects(connector().publish(acct, { ...input, idempotencyKey: "net" }))).toMatchObject({ kind: "network", retryable: true });
  });
});

describe("line metrics", () => {
  it("reads followers_total from yesterday's insight (Tokyo date)", async () => {
    fetchMock.mockResolvedValue(json({ status: "ready", followers: 7620, targetedReaches: 5848, blocks: 237 }));
    const m = await connector().fetchAccountMetrics(acct);
    expect(call(0).url).toBe("https://api.line.me/v2/bot/insight/followers?date=20261105");
    expect(m).toEqual([{ entityType: "social_account", entityId: "acc1", metric: "followers_total", value: 7620, observedAt: NOW.toISOString(), source: "line" }]);
  });

  it("falls back one more day when yesterday is unready, and returns nothing when still unready", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "unready" })).mockResolvedValueOnce(json({ status: "ready", followers: 7600 }));
    expect((await connector().fetchAccountMetrics(acct))[0]?.value).toBe(7600);
    expect(call(1).url).toContain("date=20261104");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ status: "unready" }));
    expect(await connector().fetchAccountMetrics(acct)).toEqual([]);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ status: "out_of_service" }));
    expect(await connector().fetchAccountMetrics(acct)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("computes the Tokyo date across the UTC day boundary", () => {
    expect(tokyoDate(new Date("2026-11-05T16:00:00Z"))).toBe("20261105"); // 01:00 Nov 6 in Tokyo → yesterday Nov 5
    expect(tokyoDate(new Date("2026-11-05T14:00:00Z"))).toBe("20261104"); // 23:00 Nov 5 in Tokyo → Nov 4
  });

  it("reports the message quota and its use", async () => {
    fetchMock.mockImplementation(async (url) => (String(url).endsWith("/quota") ? json({ type: "limited", value: 5000 }) : json({ totalUsage: 1234 })));
    expect(await connector().fetchMessageQuota(acct)).toEqual({ type: "limited", limit: 5000, used: 1234 });
  });

  it("fetchActivity and fetchMetrics are empty (webhook-only)", async () => {
    expect(await connector().fetchActivity(acct)).toEqual([]);
    expect(await connector().fetchMetrics()).toEqual([]);
  });
});
