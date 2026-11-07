import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { TWITCH_OAUTH_SCOPES, TwitchConnector, createTwitchConnectors, mapTwitchError, twitchSignature } from "../src/twitch.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const HELIX = "https://api.twitch.tv/helix";
const TOKEN = "https://id.twitch.tv/oauth2/token";
const SECRET = "eventsub-secret-0123456789";
const acct: AccountRef = {
  id: "acc-tw",
  workspaceId: "w",
  network: "twitch",
  externalId: "1001",
  handle: "acmelive",
  auth: { accessToken: "utok", refreshToken: "uref", expiresAt: "2026-11-06T16:00:00.000Z", userId: "1001", login: "acmelive" },
  config: { broadcasterId: "1001" },
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let routes: [string, string, Handler][];
function on(method: string, path: string, handler: Handler | unknown) {
  const h: Handler = typeof handler === "function" ? (handler as Handler) : handler instanceof Response ? () => handler.clone() : () => json(handler);
  routes.push([method, path, h]);
}
function calls(method?: string, path?: string) {
  return fetchMock.mock.calls
    .map(([u, init]) => ({ url: String(u), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body }))
    .filter((c) => (!method || c.method === method) && (!path || c.url.split("?")[0] === path));
}
async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return e as ConnectorError;
  }
  throw new Error("expected rejection");
}

beforeEach(() => {
  routes = [];
  fetchMock = vi.fn<typeof fetch>(async (u, init) => {
    const url = String(u);
    const method = init?.method ?? "GET";
    const hit = routes.find(([m, p]) => m === method && url.split("?")[0] === p);
    if (!hit) throw new Error(`unexpected ${method} ${url}`);
    return hit[2](url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = (opts: ConstructorParameters<typeof TwitchConnector>[0] = {}) => new TwitchConnector({ clientId: "cid", clientSecret: "csecret", now: () => NOW, ...opts });
const withEventSub = () => connector({ eventsubSecret: SECRET, publicUrl: "https://starsign.example/" });

function signed(body: unknown, opts: { ts?: string; secret?: string; id?: string } = {}) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? "msg-1";
  const ts = opts.ts ?? NOW.toISOString();
  return {
    raw,
    headers: {
      "twitch-eventsub-message-id": id,
      "twitch-eventsub-message-timestamp": ts,
      "twitch-eventsub-message-signature": twitchSignature(opts.secret ?? SECRET, id, ts, raw),
      "twitch-eventsub-message-type": "notification",
    },
  };
}

const chat = (over: Record<string, unknown> = {}) => ({
  subscription: { id: "sub1", type: "channel.chat.message", version: "1", status: "enabled", condition: { broadcaster_user_id: "1001", user_id: "1001" } },
  event: {
    broadcaster_user_id: "1001",
    broadcaster_user_login: "acmelive",
    broadcaster_user_name: "AcmeLive",
    chatter_user_id: "2002",
    chatter_user_login: "viewer",
    chatter_user_name: "Viewer",
    message_id: "m-1",
    message: { text: "hello chat", fragments: [{ type: "text", text: "hello chat" }] },
    message_type: "text",
    reply: null,
    ...over,
  },
});

describe("twitch connect", () => {
  it("builds the authorize URL with the minimal scopes", () => {
    const url = new URL(connector().oauthAuthorizeUrl({ state: "s", codeChallenge: "c", redirectUri: "https://starsign.example/oauth/twitch/callback" }));
    expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual(TWITCH_OAUTH_SCOPES);
    expect(TWITCH_OAUTH_SCOPES).toEqual(expect.arrayContaining(["user:read:chat", "user:write:chat", "moderator:manage:chat_messages", "moderator:read:followers"]));
    expect(createTwitchConnectors({})[0]!.connectConfigured).toBe(false);
  });

  it("connects the broadcaster and explains when EventSub is not configured", async () => {
    on("POST", TOKEN, { access_token: "utok", refresh_token: "uref", expires_in: 14400, scope: ["user:read:chat", "user:write:chat"], token_type: "bearer" });
    on("GET", `${HELIX}/users`, { data: [{ id: "1001", login: "acmelive", display_name: "AcmeLive", broadcaster_type: "affiliate" }] });
    const [a, ...rest] = await connector().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "https://starsign.example/oauth/twitch/callback" });
    expect(rest).toHaveLength(0);
    expect(a!.identity).toEqual({ externalId: "1001", handle: "acmelive", displayName: "AcmeLive" });
    expect(a!.auth).toEqual({ accessToken: "utok", refreshToken: "uref", expiresAt: "2026-11-06T16:00:00.000Z", scope: "user:read:chat user:write:chat", userId: "1001", login: "acmelive" });
    expect(a!.config).toMatchObject({ broadcasterId: "1001", eventsub: { status: "not_configured" } });
    expect(calls("GET", `${HELIX}/users`)[0]!.headers["client-id"]).toBe("cid");
  });

  it("creates chat and follow webhook subscriptions with an app token (409 = already there)", async () => {
    on("POST", TOKEN, (_u: string, init: RequestInit | undefined) => {
      const f = new URLSearchParams(String(init?.body));
      return f.get("grant_type") === "client_credentials" ? json({ access_token: "apptok", expires_in: 5000000 }) : json({ access_token: "utok", refresh_token: "uref", expires_in: 14400 });
    });
    on("GET", `${HELIX}/users`, { data: [{ id: "1001", login: "acmelive" }] });
    let n = 0;
    on("POST", `${HELIX}/eventsub/subscriptions`, () => (n++ === 0 ? json({ data: [{ id: "s1", status: "webhook_callback_verification_pending" }] }, 202) : json({ error: "Conflict", status: 409, message: "subscription already exists" }, 409)));
    const [a] = await withEventSub().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "r" });
    expect(a!.config).toMatchObject({ eventsub: { status: "subscribed", callback: "https://starsign.example/webhooks/twitch" } });
    const subs = calls("POST", `${HELIX}/eventsub/subscriptions`);
    expect(subs.map((c) => c.headers.authorization)).toEqual(["Bearer apptok", "Bearer apptok"]);
    expect(subs.map((c) => JSON.parse(String(c.body)))).toEqual([
      { type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: "1001", user_id: "1001" }, transport: { method: "webhook", callback: "https://starsign.example/webhooks/twitch", secret: SECRET } },
      { type: "channel.follow", version: "2", condition: { broadcaster_user_id: "1001", moderator_user_id: "1001" }, transport: { method: "webhook", callback: "https://starsign.example/webhooks/twitch", secret: SECRET } },
    ]);
  });

  it("keeps the connection when subscribing fails", async () => {
    on("POST", TOKEN, (_u: string, init: RequestInit | undefined) => (new URLSearchParams(String(init?.body)).get("grant_type") === "client_credentials" ? json({ access_token: "apptok", expires_in: 100 }) : json({ access_token: "utok" })));
    on("GET", `${HELIX}/users`, { data: [{ id: "1001", login: "acmelive" }] });
    on("POST", `${HELIX}/eventsub/subscriptions`, json({ error: "Forbidden", status: 403, message: "subscription missing proper authorization" }, 403));
    const [a] = await withEventSub().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "r" });
    expect(a!.config).toMatchObject({ eventsub: { status: "failed", detail: expect.stringContaining("missing proper authorization") } });
  });

  it("refreshes the user token", async () => {
    on("POST", TOKEN, { access_token: "utok2", refresh_token: "uref2", expires_in: 14400 });
    const r = await connector().refreshAuth(acct);
    expect(r!.auth).toMatchObject({ accessToken: "utok2", refreshToken: "uref2", userId: "1001", login: "acmelive" });
    expect(new URLSearchParams(String(calls("POST", TOKEN)[0]!.body)).get("grant_type")).toBe("refresh_token");
  });
});

describe("twitch eventsub webhook", () => {
  it("verifies good signatures and rejects bad, stale or unsigned ones", () => {
    const c = withEventSub();
    const good = signed(chat());
    expect(c.webhook.verify(good.headers, good.raw)).toBe(true);
    expect(c.webhook.verify(good.headers, good.raw.replace("hello", "HELLO"))).toBe(false);
    const wrong = signed(chat(), { secret: "another-secret-123456" });
    expect(c.webhook.verify(wrong.headers, wrong.raw)).toBe(false);
    const stale = signed(chat(), { ts: new Date(NOW.getTime() - 11 * 60_000).toISOString() });
    expect(c.webhook.verify(stale.headers, stale.raw)).toBe(false);
    const { "twitch-eventsub-message-signature": _sig, ...unsigned } = good.headers;
    expect(c.webhook.verify(unsigned, good.raw)).toBe(false);
    expect(connector().webhook.verify(good.headers, good.raw)).toBe(false); // no secret configured
  });

  it("answers the callback verification with the challenge as text/plain", () => {
    const c = withEventSub();
    const body = { challenge: "pogchamp-kappa-360noscope-vohiyo", subscription: { id: "s1", type: "channel.chat.message", status: "webhook_callback_verification_pending" } };
    expect(c.webhook.challenge()).toBeNull();
    expect(c.webhook.parse(body)).toEqual([]);
    expect(c.webhook.respond(body)).toEqual({ body: "pogchamp-kappa-360noscope-vohiyo", contentType: "text/plain" });
    expect(c.webhook.respond(chat())).toBeNull();
  });

  it("ignores revocations", () => {
    expect(withEventSub().webhook.parse({ subscription: { id: "s1", type: "channel.chat.message", status: "authorization_revoked" } })).toEqual([]);
  });

  it("parses chat messages, mentions, replies and follows", () => {
    const c = withEventSub();
    const [batch] = c.webhook.parse(chat());
    expect(batch).toEqual({
      network: "twitch",
      accountExternalId: "1001",
      items: [
        {
          network: "twitch",
          kind: "message",
          externalId: "1001:m-1",
          authorHandle: "viewer",
          authorName: "Viewer",
          text: "hello chat",
          url: "https://www.twitch.tv/acmelive",
          parentExternalId: null,
          occurredAt: NOW.toISOString(),
          raw: chat().event,
          conversation: { id: "1001", name: "acmelive", type: "channel" },
        },
      ],
    });
    const mention = c.webhook.parse(chat({ message_id: "m-2", message: { text: "@AcmeLive hi", fragments: [{ type: "mention", text: "@AcmeLive", mention: { user_id: "1001", user_login: "acmelive" } }, { type: "text", text: " hi" }] } }));
    expect(mention[0]!.items[0]!.kind).toBe("mention");
    const reply = c.webhook.parse(chat({ message_id: "m-3", reply: { parent_message_id: "m-0", parent_user_id: "1001", parent_user_login: "acmelive", parent_message_body: "welcome" } }));
    expect(reply[0]!.items[0]).toMatchObject({ kind: "reply", parentExternalId: "1001:m-0" });
    const replyToOther = c.webhook.parse(chat({ message_id: "m-4", reply: { parent_message_id: "m-9", parent_user_id: "3003" } }));
    expect(replyToOther[0]!.items[0]).toMatchObject({ kind: "message", parentExternalId: "1001:m-9" });
    expect(c.webhook.parse(chat({ chatter_user_id: "1001" }))).toEqual([]); // the broadcaster's own message
    const follow = c.webhook.parse({
      subscription: { type: "channel.follow", version: "2" },
      event: { user_id: "4004", user_login: "newfan", user_name: "NewFan", broadcaster_user_id: "1001", broadcaster_user_login: "acmelive", followed_at: "2026-11-06T11:59:00.123456789Z" },
    });
    expect(follow[0]!.items[0]).toMatchObject({ kind: "follow", externalId: "1001:follow:4004", authorHandle: "newfan", occurredAt: "2026-11-06T11:59:00.123Z", url: "https://www.twitch.tv/newfan" });
  });

  it("fetchActivity is webhook-only", async () => {
    expect(await connector().fetchActivity()).toEqual([]);
    expect(connector().capabilities()).toMatchObject({ webhooks: true, fetchActivity: false, reply: true, moderate: true });
  });
});

describe("twitch chat actions", () => {
  const input: PublishInput = { variantId: "v", text: "We are live!", media: [], thread: [], idempotencyKey: "k1" };

  it("sends a chat message as the broadcaster (idempotent)", async () => {
    on("POST", `${HELIX}/chat/messages`, { data: [{ message_id: "sent-1", is_sent: true }] });
    const c = connector();
    const r = await c.publish(acct, input);
    expect(r).toMatchObject({ externalId: "1001:sent-1", url: "https://www.twitch.tv/acmelive" });
    await c.publish(acct, input);
    const sent = calls("POST", `${HELIX}/chat/messages`);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ broadcaster_id: "1001", sender_id: "1001", message: "We are live!" });
    expect(sent[0]!.headers.authorization).toBe("Bearer utok");
  });

  it("validates length and media, and surfaces dropped messages", async () => {
    const c = connector();
    expect(c.validate(acct, { ...input, text: "x".repeat(501) }).map((i) => i.code)).toEqual(["too_long"]);
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png" }] }).map((i) => i.code)).toEqual(["unsupported_media"]);
    expect((await rejection(c.publish(acct, { ...input, text: "x".repeat(501), idempotencyKey: "k2" }))).kind).toBe("rejected");
    on("POST", `${HELIX}/chat/messages`, { data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_duplicate", message: "duplicate" } }] });
    const e = await rejection(c.publish(acct, { ...input, idempotencyKey: "k3" }));
    expect([e.kind, e.message]).toEqual(["rejected", expect.stringContaining("msg_duplicate")]);
  });

  it("replies with reply_parent_message_id", async () => {
    on("POST", `${HELIX}/chat/messages`, { data: [{ message_id: "sent-2", is_sent: true }] });
    const r = await connector().reply(acct, { parentExternalId: "1001:m-1", text: "thanks!", idempotencyKey: "r1" });
    expect(r.externalId).toBe("1001:sent-2");
    expect(JSON.parse(String(calls("POST", `${HELIX}/chat/messages`)[0]!.body))).toMatchObject({ reply_parent_message_id: "m-1", message: "thanks!" });
    expect((await rejection(connector().reply(acct, { parentExternalId: "9999:m-1", text: "x", idempotencyKey: "r2" }))).kind).toBe("rejected");
  });

  it("deletes chat messages and refuses other moderation", async () => {
    on("DELETE", `${HELIX}/moderation/chat`, new Response(null, { status: 204 }));
    await connector().moderate(acct, { externalId: "1001:m-1", action: "delete" });
    const q = new URL(calls("DELETE", `${HELIX}/moderation/chat`)[0]!.url).searchParams;
    expect(Object.fromEntries(q)).toEqual({ broadcaster_id: "1001", moderator_id: "1001", message_id: "m-1" });
    expect((await rejection(connector().moderate(acct, { externalId: "1001:m-1", action: "hide" }))).kind).toBe("rejected");
  });

  it("reads followers_total", async () => {
    on("GET", `${HELIX}/channels/followers`, { total: 8765, data: [], pagination: {} });
    expect(await connector().fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "acc-tw", metric: "followers_total", value: 8765, observedAt: NOW.toISOString(), source: "twitch" }]);
    expect(new URL(calls("GET", `${HELIX}/channels/followers`)[0]!.url).searchParams.get("broadcaster_id")).toBe("1001");
    expect(await connector().fetchMetrics()).toEqual([]);
  });

  it("maps HTTP errors", async () => {
    const rl = mapTwitchError(429, new Headers({ "ratelimit-reset": String(NOW.getTime() / 1000 + 30) }), { error: "Too Many Requests" }, "x");
    expect([rl.kind, rl.retryable, rl.message]).toEqual(["rate_limit", true, expect.stringContaining("2026-11-06T12:00:30.000Z")]);
    expect(mapTwitchError(401, new Headers(), {}, "x").kind).toBe("auth");
    expect(mapTwitchError(500, new Headers(), {}, "x")).toMatchObject({ kind: "network", retryable: true });
    on("POST", `${HELIX}/chat/messages`, json({ error: "Bad Request", status: 400, message: "invalid message" }, 400));
    expect((await rejection(connector().publish(acct, { ...input, idempotencyKey: "k9" }))).kind).toBe("rejected");
  });
});
