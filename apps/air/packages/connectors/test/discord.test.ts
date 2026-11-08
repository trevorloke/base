import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { DiscordConnector, createDiscordConnectors, parseDiscordWebhookUrl } from "../src/discord.ts";

const ID = "1234567890123456789";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnopqrstuvwxyzABCD";
const URL_IN = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
const BASE = `https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`;
const acct: AccountRef = { id: "d1", workspaceId: "w", network: "discord", externalId: ID, handle: "Base Air", auth: { webhookUrl: BASE }, config: { webhookId: ID, guildId: "111", channelId: "222", threadId: null, name: "Base Air" } };
const input: PublishInput = { variantId: "v1", text: "Launch day @everyone", media: [], thread: [], idempotencyKey: "k1" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: new URL(String(url)), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("discord connect", () => {
  it("validates webhook URLs from discord.com and discordapp.com, keeping thread_id", () => {
    expect(parseDiscordWebhookUrl(URL_IN)).toEqual({ id: ID, token: TOKEN, threadId: null, base: BASE });
    expect(parseDiscordWebhookUrl(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`)?.base).toBe(BASE);
    expect(parseDiscordWebhookUrl(`https://discord.com/api/v10/webhooks/${ID}/${TOKEN}?thread_id=999`)?.threadId).toBe("999");
    expect(parseDiscordWebhookUrl(`https://evil.example/api/webhooks/${ID}/${TOKEN}`)).toBeNull();
    expect(parseDiscordWebhookUrl(`http://discord.com/api/webhooks/${ID}/${TOKEN}`)).toBeNull();
    expect(parseDiscordWebhookUrl("https://discord.com/api/webhooks/abc/def")).toBeNull();
  });

  it("GETs the webhook to verify it and returns its guild and channel", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: ID, type: 1, name: "Base Air", guild_id: "111", channel_id: "222", token: TOKEN }));
    const c = createDiscordConnectors({})[0] as DiscordConnector;
    const accounts = await c.connectWithInputs({ network: "discord", inputs: { webhookUrl: URL_IN } });
    expect(call(0).url.href).toBe(BASE);
    expect(call(0).method).toBe("GET");
    expect(accounts).toEqual([{ network: "discord", identity: { externalId: ID, handle: "Base Air", displayName: "Base Air" }, auth: { webhookUrl: BASE }, config: { webhookId: ID, guildId: "111", channelId: "222", threadId: null, name: "Base Air" } }]);
    expect(c.connectMethod).toBe("webhook_url");
    expect(c.capabilities()).toMatchObject({ fetchActivity: false, fetchMetrics: false, reply: false, accountMetrics: false, moderate: true });
  });

  it("refuses a malformed URL and a deleted webhook", async () => {
    const c = new DiscordConnector();
    await expect(c.connectWithInputs({ network: "discord", inputs: { webhookUrl: "https://example.com" } })).rejects.toMatchObject({ kind: "auth" });
    fetchMock.mockResolvedValueOnce(json({ message: "Unknown Webhook", code: 10015 }, 404));
    const err = (await c.connectWithInputs({ network: "discord", inputs: { webhookUrl: URL_IN } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).not.toContain(TOKEN);
    fetchMock.mockResolvedValueOnce(json({ id: ID, name: "x" }));
    expect(await c.describeAccount({ webhookUrl: URL_IN })).toEqual({ externalId: ID, handle: "x", displayName: "x" });
  });
});

describe("discord publish", () => {
  it("executes the webhook with wait=true, no pings, and a link embed", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "555", channel_id: "222" }));
    const res = await new DiscordConnector().publish(acct, { ...input, options: { link: "https://acme.example/launch", title: "Launch post" } });
    expect(call(0).url.searchParams.get("wait")).toBe("true");
    expect(call(0).method).toBe("POST");
    expect(call(0).json()).toEqual({ content: "Launch day @everyone", allowed_mentions: { parse: [] }, embeds: [{ url: "https://acme.example/launch", title: "Launch post" }] });
    expect(res).toMatchObject({ externalId: "555", url: "https://discord.com/channels/111/222/555" });
  });

  it("uploads files as multipart with payload_json and alt text descriptions", async () => {
    fetchMock.mockImplementation(async (url) => (String(url).startsWith("https://cdn.example") ? new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }) : json({ id: "556", channel_id: "222" })));
    await new DiscordConnector().publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png", alt: "chart" }, { kind: "video", url: "https://cdn.example/clip.mp4" }] });
    const post = call(2);
    const form = post.body as FormData;
    expect(JSON.parse(String(form.get("payload_json")))).toMatchObject({ content: "Launch day @everyone", attachments: [{ id: 0, filename: "a.png", description: "chart" }, { id: 1, filename: "clip.mp4" }] });
    expect((form.get("files[0]") as File).name).toBe("a.png");
    expect(form.get("files[1]")).toBeInstanceOf(Blob);
  });

  it("uses the core media fetcher and posts into the webhook's thread", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "557", channel_id: "333" }));
    const c = new DiscordConnector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([3]), mime: "application/pdf" }) };
    await c.publish({ ...acct, auth: { webhookUrl: `${BASE}?thread_id=333` } }, { ...input, media: [{ kind: "document", url: "https://cdn.example/r.pdf", assetId: "a" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).url.searchParams.get("thread_id")).toBe("333");
  });

  it("sends a poll with hours rounded up", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "558", channel_id: "222" }));
    await new DiscordConnector().publish(acct, { ...input, text: "Which colour?", options: { poll: { options: ["Red", "Blue"], durationMinutes: 90 } } });
    expect(call(0).json()).toMatchObject({ content: "", poll: { question: { text: "Which colour?" }, answers: [{ poll_media: { text: "Red" } }, { poll_media: { text: "Blue" } }], duration: 2, allow_multiselect: false } });
  });

  it("validates file counts, sizes and poll limits", () => {
    const c = new DiscordConnector();
    const many = Array.from({ length: 11 }, (_, i) => ({ kind: "image" as const, url: `https://cdn.example/${i}.png` }));
    expect(c.validate(acct, { ...input, media: many })).toMatchObject([{ code: "too_many_media" }]);
    expect(c.validate(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/big.mp4", bytes: 50 * 1024 * 1024 }] })).toMatchObject([{ code: "unsupported_media" }]);
    expect(c.validate(acct, { ...input, options: { poll: { options: ["x".repeat(56), "b"], durationMinutes: 60 } } })).toMatchObject([{ code: "too_long" }]);
    expect(c.validate(acct, input)).toEqual([]);
  });

  it("caches by idempotency key", async () => {
    fetchMock.mockImplementation(async () => json({ id: "559", channel_id: "222" }));
    const c = new DiscordConnector();
    expect(await c.publish(acct, input)).toBe(await c.publish(acct, input));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("discord moderate and errors", () => {
  it("deletes its own message and refuses other actions", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const c = new DiscordConnector();
    await c.moderate(acct, { externalId: "555", action: "delete" });
    expect(call(0).method).toBe("DELETE");
    expect(call(0).url.href).toBe(`${BASE}/messages/555`);
    await expect(c.moderate(acct, { externalId: "555", action: "hide" })).rejects.toMatchObject({ kind: "rejected" });
    expect(await c.fetchActivity()).toEqual([]);
    expect(await c.fetchMetrics()).toEqual([]);
  });

  it("maps 429 retry_after, 400, 5xx and network failures without leaking the token", async () => {
    const c = new DiscordConnector();
    fetchMock.mockResolvedValueOnce(json({ message: "You are being rate limited.", retry_after: 1.5, global: false }, 429));
    const e = (await c.publish(acct, input).catch((x: unknown) => x)) as ConnectorError;
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(e.message).toContain("retry after 1.5s");
    fetchMock.mockResolvedValueOnce(json({ message: "Invalid Form Body", code: 50035, errors: { content: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH" }] } } }, 400));
    await expect(c.publish(acct, input)).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("50035") });
    fetchMock.mockResolvedValueOnce(new Response("upstream", { status: 503 }));
    await expect(c.publish(acct, input)).rejects.toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${BASE}`));
    const n = (await c.publish(acct, input).catch((x: unknown) => x)) as ConnectorError;
    expect(n).toMatchObject({ kind: "network", retryable: true });
    expect(n.message).not.toContain(TOKEN);
    await expect(c.publish({ ...acct, auth: null }, input)).rejects.toMatchObject({ kind: "auth" });
  });
});
