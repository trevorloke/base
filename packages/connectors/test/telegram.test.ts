import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { TelegramConnector, createTelegramConnectors, parseMessageId, telegramEscapeHtml, telegramMessageUrl, telegramUpdateToActivity, type TelegramUpdate } from "../src/telegram.ts";

const TOKEN = "123456789:AAEhBP0av28_test_token_abcdefghij";
const NOW = new Date("2026-11-02T00:00:00.000Z");
const acct: AccountRef = {
  id: "t1",
  workspaceId: "w",
  network: "telegram",
  externalId: "-1001234567890",
  handle: "@acmenews",
  auth: { botToken: TOKEN },
  config: { chatId: "-1001234567890", chatType: "channel", username: "acmenews", title: "Acme News", linkedChatId: "-1009876543210", botId: 123456789, botUsername: "acme_bot", webhook: false },
};
const input: PublishInput = { variantId: "v1", text: "Big <news> & more", media: [], thread: [], idempotencyKey: "k1" };

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
const fail = (status: number, description: string, parameters?: Record<string, unknown>) => new Response(JSON.stringify({ ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) }), { status });
const msg = (id: number, chat: Record<string, unknown> = { id: -1001234567890, type: "channel", username: "acmenews" }) => ({ message_id: id, date: 1793577600, chat });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: String(url), method: String(url).split("/").pop(), body: init?.body, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const connector = (opts: ConstructorParameters<typeof TelegramConnector>[0] = {}) => new TelegramConnector({ now: () => NOW, ...opts });

describe("telegram connect", () => {
  it("verifies the bot, the chat and admin rights, registers the webhook and returns the channel", async () => {
    fetchMock.mockImplementation(async (url) => {
      const m = String(url).split("/").pop();
      if (m === "getMe") return ok({ id: 123456789, is_bot: true, username: "acme_bot", first_name: "Acme" });
      if (m === "getChat") return ok({ id: -1001234567890, type: "channel", title: "Acme News", username: "acmenews", linked_chat_id: -1009876543210 });
      if (m === "getChatMember") return ok({ status: "administrator", can_post_messages: true, user: { id: 123456789 } });
      if (m === "setWebhook") return ok(true);
      throw new Error(`unexpected ${m}`);
    });
    const c = connector({ webhookSecret: "s3cret_value", publicUrl: "https://app.example/" });
    const accounts = await c.connectWithInputs({ network: "telegram", inputs: { botToken: ` ${TOKEN} `, chat: "https://t.me/acmenews" } });
    expect(call(0).url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(call(1).json()).toEqual({ chat_id: "@acmenews" });
    expect(call(2).json()).toEqual({ chat_id: -1001234567890, user_id: 123456789 });
    expect(call(3).json()).toEqual({ url: "https://app.example/webhooks/telegram", secret_token: "s3cret_value", allowed_updates: ["message", "channel_post"] });
    expect(accounts).toEqual([
      {
        network: "telegram",
        identity: { externalId: "-1001234567890", handle: "@acmenews", displayName: "Acme News" },
        auth: { botToken: TOKEN },
        config: { chatId: "-1001234567890", chatType: "channel", username: "acmenews", title: "Acme News", linkedChatId: "-1009876543210", botId: 123456789, botUsername: "acme_bot", webhook: true },
      },
    ]);
    expect(c.capabilities()).toMatchObject({ webhooks: true, fetchMetrics: false, accountMetrics: true });
  });

  it("refuses a bot that is not an admin, a malformed token and a rejected token", async () => {
    fetchMock.mockImplementation(async (url) => {
      const m = String(url).split("/").pop();
      if (m === "getMe") return ok({ id: 1, username: "b" });
      if (m === "getChat") return ok({ id: -100555, type: "channel", title: "Other" });
      return ok({ status: "member" });
    });
    await expect(connector().connectWithInputs({ network: "telegram", inputs: { botToken: TOKEN, chat: "-100555" } })).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/not an admin/) });
    expect(call(1).json()).toEqual({ chat_id: "-100555" });
    await expect(connector().connectWithInputs({ network: "telegram", inputs: { botToken: "nope", chat: "@x" } })).rejects.toMatchObject({ kind: "auth" });
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(fail(401, "Unauthorized"));
    const err = (await connector().connectWithInputs({ network: "telegram", inputs: { botToken: TOKEN, chat: "@x" } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).not.toContain(TOKEN);
  });

  it("declares its credential inputs and factory", () => {
    const c = createTelegramConnectors({ TELEGRAM_WEBHOOK_SECRET: "abc" })[0]!;
    expect(c.name).toBe("telegram");
    expect(c.connectMethod).toBe("bot_token");
    expect(c.credentialInputs?.map((i) => i.key)).toEqual(["botToken", "chat"]);
    expect(createTelegramConnectors({})[0]!.webhook).toBeUndefined();
  });
});

describe("telegram publish", () => {
  it("sends HTML-escaped text with a bold title and appended link", async () => {
    fetchMock.mockResolvedValueOnce(ok(msg(42)));
    const res = await connector().publish(acct, { ...input, options: { title: "A & B", link: "https://acme.example/x?a=1&b=2" } });
    expect(call(0).method).toBe("sendMessage");
    expect(call(0).json()).toEqual({ chat_id: "-1001234567890", text: "<b>A &amp; B</b>\n\nBig &lt;news&gt; &amp; more\n\nhttps://acme.example/x?a=1&amp;b=2", parse_mode: "HTML" });
    expect(res).toMatchObject({ externalId: "-1001234567890:42", url: "https://t.me/acmenews/42" });
  });

  it("sends a single photo by URL with caption, falling back to upload when Telegram cannot fetch it", async () => {
    fetchMock.mockResolvedValueOnce(ok(msg(43)));
    await connector().publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png" }] });
    expect(call(0).method).toBe("sendPhoto");
    expect(call(0).json()).toMatchObject({ photo: "https://cdn.example/a.png", caption: "Big &lt;news&gt; &amp; more", parse_mode: "HTML" });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(fail(400, "Bad Request: failed to get HTTP URL content"))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }))
      .mockResolvedValueOnce(ok(msg(44)));
    await connector().publish(acct, { ...input, idempotencyKey: "k2", media: [{ kind: "video", url: "https://cdn.example/v.mp4", durationSeconds: 12.4 }] });
    expect(call(0).method).toBe("sendVideo");
    expect(call(2).method).toBe("sendVideo");
    const form = call(2).body as FormData;
    expect(form.get("video")).toBeInstanceOf(Blob);
    expect(form.get("chat_id")).toBe("-1001234567890");
    expect(form.get("duration")).toBe("12");
  });

  it("uploads oversized media straight through the core media fetcher", async () => {
    fetchMock.mockResolvedValueOnce(ok(msg(45)));
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([5]), mime: "application/pdf" }) };
    await c.publish(acct, { ...input, media: [{ kind: "document", url: "https://cdn.example/report.pdf", bytes: 30_000_000 }] });
    expect(call(0).method).toBe("sendDocument");
    expect(((call(0).body as FormData).get("document") as File).name).toBe("report.pdf");
  });

  it("sends several media as one album with the caption on the first item", async () => {
    fetchMock.mockResolvedValueOnce(ok([msg(50), msg(51)]));
    const res = await connector().publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png" }, { kind: "video", url: "https://cdn.example/v.mp4" }] });
    expect(call(0).method).toBe("sendMediaGroup");
    expect(call(0).json().media).toEqual([
      { type: "photo", media: "https://cdn.example/a.png", caption: "Big &lt;news&gt; &amp; more", parse_mode: "HTML" },
      { type: "video", media: "https://cdn.example/v.mp4", supports_streaming: true },
    ]);
    expect(res).toMatchObject({ externalId: "-1001234567890:50", raw: { messages: ["-1001234567890:50", "-1001234567890:51"] } });
  });

  it("uploads an album with attach:// references when the media cannot be fetched by URL", async () => {
    fetchMock.mockImplementation(async (url) => (String(url).startsWith("http://") ? new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }) : ok([msg(52), msg(53)])));
    await connector().publish(acct, { ...input, media: [{ kind: "image", url: "http://localhost/a.png" }, { kind: "image", url: "http://localhost/b.png" }] });
    const group = fetchMock.mock.calls.find(([u]) => String(u).endsWith("sendMediaGroup"))!;
    const form = group[1]!.body as FormData;
    expect(JSON.parse(String(form.get("media")))).toMatchObject([{ type: "photo", media: "attach://file0" }, { type: "photo", media: "attach://file1" }]);
    expect(form.get("file1")).toBeInstanceOf(Blob);
  });

  it("sends a long caption as a separate message after the media", async () => {
    fetchMock.mockResolvedValueOnce(ok(msg(60))).mockResolvedValueOnce(ok(msg(61)));
    const long = "x".repeat(1500);
    await connector().publish(acct, { ...input, text: long, media: [{ kind: "image", url: "https://cdn.example/a.png" }] });
    expect(call(0).json().caption).toBeUndefined();
    expect(call(1).method).toBe("sendMessage");
    expect(call(1).json().text).toBe(long);
  });

  it("sends an anonymous poll, with open_period only when it fits Telegram's 600s cap", async () => {
    fetchMock.mockImplementation(async () => ok(msg(70)));
    await connector().publish(acct, { ...input, text: "Which one?", options: { poll: { options: ["A", "B"], durationMinutes: 5 } } });
    expect(call(0).method).toBe("sendPoll");
    expect(call(0).json()).toEqual({ chat_id: "-1001234567890", question: "Which one?", options: [{ text: "A" }, { text: "B" }], is_anonymous: true, open_period: 300 });
    await connector().publish(acct, { ...input, idempotencyKey: "k9", text: "Long?", options: { poll: { options: ["A", "B"], durationMinutes: 1440 } } });
    expect(call(1).json().open_period).toBeUndefined();
  });

  it("validates polls with media, long questions and mixed albums", () => {
    const c = connector();
    expect(c.validate(acct, { ...input, text: "q".repeat(301), options: { poll: { options: ["a", "b"], durationMinutes: 5 } } })).toMatchObject([{ code: "too_long" }]);
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "https://a/a.png" }, { kind: "document", url: "https://a/a.pdf" }] })).toMatchObject([{ code: "unsupported_media" }]);
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "https://a/a.png" }, { kind: "gif", url: "https://a/a.gif" }] })).toMatchObject([{ code: "unsupported_media" }]);
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "https://a/a.png" }], options: { poll: { options: ["a", "b"], durationMinutes: 5 } } })).toMatchObject([{ code: "unsupported_media" }]);
    expect(c.validate(acct, input)).toEqual([]);
  });

  it("caches by idempotency key", async () => {
    fetchMock.mockImplementation(async () => ok(msg(80)));
    const c = connector();
    expect(await c.publish(acct, input)).toBe(await c.publish(acct, input));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("telegram engage and listen", () => {
  const autoForward: TelegramUpdate = { update_id: 10, message: { message_id: 900, date: 1793577600, chat: { id: -1009876543210, type: "supergroup" }, sender_chat: { id: -1001234567890, title: "Acme News", username: "acmenews" }, is_automatic_forward: true, forward_origin: { type: "channel", chat: { id: -1001234567890 }, message_id: 42 }, text: "post" } };
  const comment: TelegramUpdate = { update_id: 11, message: { message_id: 901, date: 1793581200, chat: { id: -1009876543210, type: "supergroup" }, from: { id: 77, username: "fan", first_name: "Fan", last_name: "One" }, text: "love it", reply_to_message: autoForward.message! } };
  const channelPost: TelegramUpdate = { update_id: 12, channel_post: { message_id: 43, date: 1793584800, chat: { id: -1001234567890, type: "channel", title: "Acme News", username: "acmenews" }, text: "hello" } };

  it("maps channel posts, discussion comments, replies to the bot and mentions", () => {
    expect(telegramUpdateToActivity(channelPost)).toMatchObject({ accountExternalId: "-1001234567890", item: { kind: "own_post", externalId: "-1001234567890:43", url: "https://t.me/acmenews/43", text: "hello", occurredAt: "2026-11-02T02:00:00.000Z" } });
    expect(telegramUpdateToActivity(autoForward)).toBeNull();
    expect(telegramUpdateToActivity(comment)).toMatchObject({ accountExternalId: "-1001234567890", item: { kind: "comment", externalId: "-1009876543210:901", parentExternalId: "-1001234567890:42", authorHandle: "@fan", authorName: "Fan One", url: "https://t.me/c/9876543210/901" } });
    const toBot: TelegramUpdate = { update_id: 13, message: { message_id: 902, date: 1793581200, chat: { id: -100777, type: "supergroup" }, from: { id: 78 }, text: "ok", reply_to_message: { message_id: 5, date: 1, chat: { id: -100777, type: "supergroup" }, from: { id: 123456789, is_bot: true } } } };
    expect(telegramUpdateToActivity(toBot, { botId: 123456789 })).toMatchObject({ accountExternalId: "-100777", item: { kind: "reply", parentExternalId: "-100777:5" } });
    const mention: TelegramUpdate = { update_id: 14, message: { message_id: 903, date: 1793581200, chat: { id: -100777, type: "supergroup" }, from: { id: 79 }, text: "hey @Acme_Bot" } };
    expect(telegramUpdateToActivity(mention, { botUsername: "acme_bot" })?.item.kind).toBe("mention");
    expect(telegramUpdateToActivity({ update_id: 15, message: { message_id: 1, date: 1, chat: { id: 5, type: "private" }, text: "dm" } })).toBeNull();
  });

  it("verifies the secret token header in constant time and parses updates into batches", () => {
    const c = connector({ webhookSecret: "s3cret" });
    expect(c.webhook!.verify({ "X-Telegram-Bot-Api-Secret-Token": "s3cret" }, "{}")).toBe(true);
    expect(c.webhook!.verify({ "x-telegram-bot-api-secret-token": "s3cret!" }, "{}")).toBe(false);
    expect(c.webhook!.verify({}, "{}")).toBe(false);
    expect(c.webhook!.parse(autoForward)).toEqual([]);
    expect(c.webhook!.parse(comment)).toMatchObject([{ network: "telegram", accountExternalId: "-1001234567890", items: [{ kind: "comment" }] }]);
    expect(c.webhook!.parse({ nope: true })).toEqual([]);
    expect(connector({ webhookSecret: "bad secret with spaces" }).webhook).toBeUndefined();
  });

  it("polls getUpdates with a shared offset, keeps this chat's items and answers comments in the discussion copy", async () => {
    fetchMock.mockResolvedValueOnce(ok([autoForward, comment, channelPost])).mockResolvedValueOnce(ok([]));
    const c = connector();
    const items = await c.fetchActivity(acct, new Date("2026-11-02T00:30:00Z"));
    expect(call(0).method).toBe("getUpdates");
    expect(call(0).json()).toMatchObject({ limit: 100, allowed_updates: ["message", "channel_post"] });
    expect(items.map((i) => i.kind)).toEqual(["comment", "own_post"]);
    await c.fetchActivity(acct, null);
    expect(call(1).json()).toMatchObject({ offset: 13 });

    fetchMock.mockResolvedValueOnce(ok({ ...msg(904, { id: -1009876543210, type: "supergroup" }) }));
    const r = await c.reply(acct, { parentExternalId: "-1001234567890:42", text: "thanks", idempotencyKey: "r1" });
    expect(call(2).json()).toEqual({ chat_id: "-1009876543210", reply_parameters: { message_id: 900, allow_sending_without_reply: true }, text: "thanks", parse_mode: "HTML" });
    expect(r.externalId).toBe("-1009876543210:904");

    fetchMock.mockResolvedValueOnce(ok(msg(905, { id: -1009876543210, type: "supergroup" })));
    await c.reply(acct, { parentExternalId: "-1009876543210:901", text: "you too", idempotencyKey: "r2" });
    expect(call(3).json()).toMatchObject({ chat_id: "-1009876543210", reply_parameters: { message_id: 901 } });
  });

  it("returns nothing from polling when a webhook delivers updates", async () => {
    expect(await connector().fetchActivity({ ...acct, config: { ...acct.config, webhook: true } }, null)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes messages, reacts for like/unlike and refuses hide", async () => {
    fetchMock.mockImplementation(async () => ok(true));
    const c = connector();
    await c.moderate(acct, { externalId: "-1009876543210:901", action: "delete" });
    expect(call(0).method).toBe("deleteMessage");
    expect(call(0).json()).toEqual({ chat_id: "-1009876543210", message_id: 901 });
    await c.moderate(acct, { externalId: "42", action: "like" });
    expect(call(1).json()).toEqual({ chat_id: "-1001234567890", message_id: 42, reaction: [{ type: "emoji", emoji: "👍" }] });
    await c.moderate(acct, { externalId: "42", action: "unlike" });
    expect(call(2).json().reaction).toEqual([]);
    await expect(c.moderate(acct, { externalId: "42", action: "hide" })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("reports member count as followers_total and no per-post metrics", async () => {
    fetchMock.mockResolvedValueOnce(ok(5120));
    expect(await connector().fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "t1", metric: "followers_total", value: 5120, observedAt: NOW.toISOString(), source: "telegram" }]);
    expect(call(0).method).toBe("getChatMemberCount");
    expect(await connector().fetchMetrics()).toEqual([]);
  });
});

describe("telegram errors and helpers", () => {
  it("maps 429 retry_after, 403, 400, 409, 5xx and network failures", async () => {
    fetchMock.mockResolvedValueOnce(fail(429, "Too Many Requests: retry after 17", { retry_after: 17 }));
    const e = (await connector().publish(acct, input).catch((x: unknown) => x)) as ConnectorError;
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(e.message).toContain("retry after 17s");
    fetchMock.mockResolvedValueOnce(fail(403, "Forbidden: bot was kicked from the channel chat"));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "auth", retryable: false });
    fetchMock.mockResolvedValueOnce(fail(400, "Bad Request: message text is empty"));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "rejected" });
    fetchMock.mockResolvedValueOnce(fail(409, "Conflict: can't use getUpdates method while webhook is active"));
    await expect(connector().fetchActivity(acct, null)).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/webhook/) });
    fetchMock.mockResolvedValueOnce(fail(502, "Bad Gateway"));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
    const n = (await connector().publish(acct, input).catch((x: unknown) => x)) as ConnectorError;
    expect(n).toMatchObject({ kind: "network", retryable: true });
    expect(n.message).not.toContain(TOKEN);
  });

  it("escapes HTML, builds message URLs and parses ids", () => {
    expect(telegramEscapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
    expect(telegramMessageUrl({ id: -1001, username: "chan" }, 5)).toBe("https://t.me/chan/5");
    expect(telegramMessageUrl({ id: "-1001234" }, 5)).toBe("https://t.me/c/1234/5");
    expect(telegramMessageUrl({ id: 55 }, 5)).toBeNull();
    expect(parseMessageId("-100:7", "-1")).toEqual({ chatId: "-100", messageId: 7 });
    expect(parseMessageId("7", "-1")).toEqual({ chatId: "-1", messageId: 7 });
    expect(() => parseMessageId("x", "-1")).toThrow();
  });
});
