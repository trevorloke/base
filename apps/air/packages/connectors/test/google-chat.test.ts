import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { GoogleChatConnector, chatThreadKey, createGoogleChatConnectors, linkCard, mapGoogleChatError, parseGoogleChatWebhookUrl, toChatText } from "../src/google-chat.ts";

const KEY = "AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI";
const TOKEN = "Xk3vR9n2Qp-AbCdEfGhIjKlMnOpQrStUvWxYz0123=";
const URL_OK = `https://chat.googleapis.com/v1/spaces/AAAAbcd1234/messages?key=${KEY}&token=${encodeURIComponent(TOKEN)}`;

const acct: AccountRef = { id: "acc1", workspaceId: "w", network: "google_chat", externalId: "spaces/AAAAbcd1234", handle: "Google Chat space AAAAbcd1234", auth: { webhookUrl: URL_OK }, config: {} };
const input: PublishInput = { variantId: "v1", text: "Launch is **live** — [details](https://acme.example/l)", media: [], thread: [], idempotencyKey: "k1" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: String(url), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function rejects(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    return err as ConnectorError;
  }
  throw new Error("expected a rejection");
}

const msg = (n: string, thread = "spaces/AAAAbcd1234/threads/T1") => ({ name: `spaces/AAAAbcd1234/messages/${n}`, createTime: "2026-11-06T10:00:00Z", thread: { name: thread } });

describe("google chat URL validation", () => {
  it("accepts space webhook URLs and rejects everything else", () => {
    expect(parseGoogleChatWebhookUrl(` ${URL_OK} `)).toMatchObject({ spaceId: "AAAAbcd1234", key: KEY, token: TOKEN });
    expect(parseGoogleChatWebhookUrl(`${URL_OK}&threadKey=x`)!.url).toBe(URL_OK); // extra params dropped
    expect(parseGoogleChatWebhookUrl(`http://chat.googleapis.com/v1/spaces/AAAAbcd1234/messages?key=${KEY}&token=t`)).toBeNull();
    expect(parseGoogleChatWebhookUrl(`https://chat.googleapis.com.evil.example/v1/spaces/AAAAbcd1234/messages?key=${KEY}&token=t`)).toBeNull();
    expect(parseGoogleChatWebhookUrl(`https://chat.googleapis.com/v1/spaces/AAAAbcd1234/messages?key=${KEY}`)).toBeNull(); // no token
    expect(parseGoogleChatWebhookUrl("https://chat.googleapis.com/v1/spaces/AAAAbcd1234/messages")).toBeNull();
  });

  it("connects without any network call and never posts to test", async () => {
    const c = new GoogleChatConnector();
    expect(await c.connectWithInputs({ network: "google_chat", inputs: { webhookUrl: URL_OK } })).toEqual([{ network: "google_chat", identity: { externalId: "spaces/AAAAbcd1234", handle: "Google Chat space AAAAbcd1234", displayName: null }, auth: { webhookUrl: URL_OK }, config: { spaceName: "spaces/AAAAbcd1234" } }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rejects(c.connectWithInputs({ network: "google_chat", inputs: { webhookUrl: "https://example.com/hook" } }))).toMatchObject({ kind: "auth" });
    expect(c.capabilities()).toEqual({ publish: true, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: false, moderate: false, accountMetrics: false, webhooks: false, video: false, kinds: ["post", "link"] });
    expect(c.credentialInputs[0]).toMatchObject({ key: "webhookUrl", secret: true });
    expect(await c.describeAccount({ webhookUrl: URL_OK })).toMatchObject({ externalId: "spaces/AAAAbcd1234" });
  });
});

describe("google chat publish", () => {
  it("posts Chat-formatted text in a thread keyed by the idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(json(msg("M1")));
    const r = await new GoogleChatConnector().publish(acct, input);
    const u = new URL(call(0).url);
    expect(u.searchParams.get("key")).toBe(KEY);
    expect(u.searchParams.get("token")).toBe(TOKEN);
    expect(u.searchParams.get("messageReplyOption")).toBe("REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    expect(call(0)).toMatchObject({ method: "POST", headers: { "content-type": "application/json; charset=UTF-8" } });
    expect(call(0).json()).toEqual({ text: "Launch is *live* — <https://acme.example/l|details>", thread: { threadKey: chatThreadKey("k1") } });
    expect(r).toEqual({ externalId: "spaces/AAAAbcd1234/messages/M1", url: null, raw: msg("M1") });
  });

  it("adds a cardsV2 link card with image and button when options.link is set", async () => {
    fetchMock.mockResolvedValueOnce(json(msg("M2")));
    await new GoogleChatConnector().publish(acct, { ...input, idempotencyKey: "k2", options: { link: "https://acme.example/launch", title: "Launch notes", thumbnailUrl: "https://cdn.example/t.png" } });
    expect(call(0).json().cardsV2).toEqual([
      {
        cardId: "base-air-link",
        card: {
          header: { title: "Launch notes", subtitle: "acme.example" },
          sections: [{ widgets: [{ image: { imageUrl: "https://cdn.example/t.png", altText: "Launch notes" } }, { buttonList: { buttons: [{ text: "Open", onClick: { openLink: { url: "https://acme.example/launch" } } }] } }] }],
        },
      },
    ]);
    expect(linkCard("not a url")).toMatchObject({ card: { header: { title: "not a url" } } });
  });

  it("posts thread segments into the root's thread and replies to an earlier post by its thread key", async () => {
    fetchMock.mockResolvedValueOnce(json(msg("R"))).mockResolvedValueOnce(json(msg("S1"))).mockResolvedValueOnce(json(msg("S2")));
    const c = new GoogleChatConnector();
    const r = await c.publish(acct, { ...input, idempotencyKey: "k3", thread: ["two", "three"] });
    expect(call(1).json()).toEqual({ text: "two", thread: { name: "spaces/AAAAbcd1234/threads/T1" } });
    expect(r.threadExternalIds).toEqual(["spaces/AAAAbcd1234/messages/S1", "spaces/AAAAbcd1234/messages/S2"]);
    fetchMock.mockResolvedValueOnce(json(msg("A")));
    await c.publish(acct, { ...input, text: "follow-up", idempotencyKey: "k4", replyToExternalId: "spaces/AAAAbcd1234/messages/R" });
    expect(call(3).json()).toMatchObject({ thread: { threadKey: chatThreadKey("k3") } });
    fetchMock.mockResolvedValueOnce(json(msg("B")));
    await c.publish(acct, { ...input, text: "into a thread", idempotencyKey: "k5", replyToExternalId: "spaces/AAAAbcd1234/threads/T9" });
    expect(call(4).json()).toMatchObject({ thread: { name: "spaces/AAAAbcd1234/threads/T9" } });
    expect(await rejects(c.publish(acct, { ...input, idempotencyKey: "k6", replyToExternalId: "spaces/AAAAbcd1234/messages/unknown" }))).toMatchObject({ kind: "rejected" });
  });

  it("is idempotent per key, validates, and maps errors without leaking the key or token", async () => {
    fetchMock.mockResolvedValueOnce(json(msg("M1")));
    const c = new GoogleChatConnector();
    await c.publish(acct, input);
    await c.publish(acct, input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "https://a/x.png" }] }).map((i) => i.code)).toEqual(["unsupported_media"]);
    expect(c.validate(acct, { ...input, text: "é".repeat(16_000) }).map((i) => i.code)).toEqual(["too_long"]);
    expect(c.validate(acct, { ...input, text: " " }).map((i) => i.code)).toEqual(["empty"]);
    expect(mapGoogleChatError(429, new Headers(), { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, "post")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapGoogleChatError(400, new Headers(), { error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload" } }, "post")).toMatchObject({ kind: "rejected" });
    expect(mapGoogleChatError(503, new Headers(), undefined, "post")).toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockResolvedValueOnce(json({ error: { code: 404, status: "NOT_FOUND", message: "Space not found" } }, 404));
    const e = await rejects(c.publish(acct, { ...input, idempotencyKey: "k9" }));
    expect(e).toMatchObject({ kind: "auth", retryable: false });
    fetchMock.mockRejectedValueOnce(new TypeError(`request to ${URL_OK} failed`));
    const n = await rejects(c.publish(acct, { ...input, idempotencyKey: "k10" }));
    expect(n).toMatchObject({ kind: "network", retryable: true });
    expect(n.message).not.toContain(KEY);
    expect(n.message).not.toContain("Xk3vR9n2Qp");
    expect(toChatText("~~old~~ **new**")).toBe("~old~ *new*");
    expect(createGoogleChatConnectors({}).map((x) => x.name)).toEqual(["google_chat"]);
  });
});
