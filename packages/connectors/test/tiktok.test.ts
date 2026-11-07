import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { TikTokConnector, createTikTokConnectors, mapTikTokError, parseTikTokWebhook, tiktokChunkPlan, type TikTokConnectorOptions } from "../src/tiktok.ts";

const NOW = new Date("2026-11-03T00:00:00.000Z");
const API = "https://open.tiktokapis.com";

const acct: AccountRef = {
  id: "acc-tt",
  workspaceId: "w",
  network: "tiktok",
  externalId: "open-1",
  handle: "acme",
  auth: { accessToken: "tok", refreshToken: "rt", openId: "open-1", expiresAt: "2026-11-04T00:00:00.000Z" },
  config: {},
};

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, error: { code: "ok", message: "", log_id: "l" } }), { status, headers: { "content-type": "application/json" } });
const fail = (code: string, status: number, message = "nope") => new Response(JSON.stringify({ data: {}, error: { code, message, log_id: "l" } }), { status });

const CREATOR = {
  creator_username: "acme",
  creator_nickname: "Acme Studio",
  privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
  comment_disabled: false,
  duet_disabled: false,
  stitch_disabled: true,
  max_video_post_duration_sec: 600,
};

type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

function setup(route: Route, opts: TikTokConnectorOptions = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const i = init ?? {};
    calls.push({ url, init: i });
    const r = await route(url, i);
    if (!r) throw new Error(`unexpected ${i.method ?? "GET"} ${url}`);
    return r;
  });
  const c = new TikTokConnector({ clientKey: "ck", clientSecret: "cs", fetch: fetchMock as unknown as typeof fetch, now: () => NOW, sleep: async () => {}, ...opts });
  c.media = { fetch: async (m) => ({ bytes: new Uint8Array(m.bytes ?? 1000).fill(7), mime: "video/mp4" }) };
  const bodyOf = (path: string, n = 0) => {
    const hit = calls.filter((x) => x.url.pathname === path)[n];
    if (!hit) throw new Error(`no call to ${path}`);
    return JSON.parse(String(hit.init.body)) as Record<string, any>;
  };
  return { c, calls, fetchMock, bodyOf };
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

const video = (extra: Partial<PublishInput["media"][number]> = {}) => ({ kind: "video" as const, url: "https://media.acme.example/v.mp4", mime: "video/mp4", bytes: 1000, durationSeconds: 30, ...extra });
const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v1", text: "launch #fyp", media: [video()], thread: [], idempotencyKey: "k1", options: { privacy: "public" }, ...over });

describe("tiktok connect", () => {
  it("builds the Login Kit URL with client_key and comma scopes, and is unconfigured without credentials", () => {
    const { c } = setup(() => undefined);
    const u = new URL(c.oauthAuthorizeUrl({ state: "st", codeChallenge: "ch", redirectUri: "https://app.example/oauth/tiktok/callback" }));
    expect(u.origin + u.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(u.searchParams.get("client_key")).toBe("ck");
    expect(u.searchParams.get("scope")).toBe("user.info.basic,user.info.profile,user.info.stats,video.publish,video.upload,video.list");
    expect(u.searchParams.get("client_id")).toBeNull();
    expect(c.connectConfigured).toBe(true);
    expect(new TikTokConnector({ clientKey: "ck" }).connectConfigured).toBe(false);
    expect(createTikTokConnectors({})[0]!.connectConfigured).toBe(false);
    const fromEnv = createTikTokConnectors({ TIKTOK_CLIENT_KEY: "a", TIKTOK_CLIENT_SECRET: "b" });
    expect(fromEnv.map((x) => [x.name, x.networks, x.connectConfigured])).toEqual([["tiktok", ["tiktok"], true]]);
  });

  it("exchanges the code and describes the creator", async () => {
    const { c, calls } = setup((url) => {
      if (url.pathname === "/v2/oauth/token/") return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 86400, refresh_expires_in: 31536000, open_id: "open-9", scope: "user.info.basic,video.publish" }));
      if (url.pathname === "/v2/user/info/") return ok({ user: { open_id: "open-9", username: "acme", display_name: "Acme Studio" } });
      return undefined;
    });
    const accounts = await c.oauthConnect({ code: "code", codeVerifier: "v", redirectUri: "https://app.example/oauth/tiktok/callback" });
    expect(accounts).toEqual([
      {
        network: "tiktok",
        identity: { externalId: "open-9", handle: "acme", displayName: "Acme Studio" },
        auth: { accessToken: "at", refreshToken: "rt", expiresAt: "2026-11-04T00:00:00.000Z", refreshExpiresAt: "2027-11-03T00:00:00.000Z", openId: "open-9", scope: "user.info.basic,video.publish" },
      },
    ]);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("client_key")).toBe("ck");
    expect(form.get("client_secret")).toBe("cs");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer at");
  });

  it("refreshes tokens and keeps the open_id; returns null without a usable refresh token", async () => {
    const { c, calls } = setup((url) => (url.pathname === "/v2/oauth/token/" ? new Response(JSON.stringify({ access_token: "at2", refresh_token: "rt2", expires_in: 86400, open_id: "open-1" })) : undefined));
    const r = await c.refreshAuth(acct);
    expect(r?.auth).toMatchObject({ accessToken: "at2", refreshToken: "rt2", openId: "open-1", expiresAt: "2026-11-04T00:00:00.000Z" });
    expect(new URLSearchParams(String(calls[0]!.init.body)).get("grant_type")).toBe("refresh_token");
    expect(await c.refreshAuth({ ...acct, auth: { accessToken: "a", openId: "o" } })).toBeNull();
    expect(await c.refreshAuth({ ...acct, auth: { accessToken: "a", openId: "o", refreshToken: "r", refreshExpiresAt: "2026-01-01T00:00:00Z" } })).toBeNull();
  });
});

describe("tiktok publish", () => {
  it("queries creator info, uploads the file in one chunk, and polls until PUBLISH_COMPLETE", async () => {
    let polls = 0;
    const { c, calls, bodyOf } = setup((url, init) => {
      if (url.pathname === "/v2/post/publish/creator_info/query/") return ok(CREATOR);
      if (url.pathname === "/v2/post/publish/video/init/") return ok({ publish_id: "v_pub_file~v2-1.1", upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=1" });
      if (url.host === "open-upload.tiktokapis.com" && init.method === "PUT") return new Response(null, { status: 201 });
      if (url.pathname === "/v2/post/publish/status/fetch/") return ++polls < 3 ? ok({ status: "PROCESSING_UPLOAD" }) : new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]},"error":{"code":"ok"}}');
      return undefined;
    });
    const res = await c.publish(acct, input({ options: { privacy: "public", allowComments: true, brandedContent: true } }));
    expect(res.externalId).toBe("7300000000000000001");
    expect(res.url).toBe("https://www.tiktok.com/@acme/video/7300000000000000001");
    expect(res.raw).toMatchObject({ publishId: "v_pub_file~v2-1.1", creatorNickname: "Acme Studio" });
    expect(polls).toBe(3);
    const init = bodyOf("/v2/post/publish/video/init/");
    expect(init.post_info).toEqual({ title: "launch #fyp", privacy_level: "PUBLIC_TO_EVERYONE", disable_comment: false, disable_duet: true, disable_stitch: true, brand_content_toggle: true, brand_organic_toggle: false });
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 1000, chunk_size: 1000, total_chunk_count: 1 });
    const put = calls.find((x) => x.init.method === "PUT")!;
    expect((put.init.headers as Record<string, string>)["content-range"]).toBe("bytes 0-999/1000");
    expect((put.init.headers as Record<string, string>)["content-type"]).toBe("video/mp4");
    // creator_info comes before init, as TikTok requires.
    expect(calls.findIndex((x) => x.url.pathname.includes("creator_info"))).toBeLessThan(calls.findIndex((x) => x.url.pathname.includes("video/init")));
  });

  it("plans and sends multi-chunk uploads with Content-Range per chunk", async () => {
    expect(tiktokChunkPlan(4_000_000)).toMatchObject({ chunkSize: 4_000_000, totalChunks: 1 });
    const big = tiktokChunkPlan(150_000_123);
    expect(big.chunkSize).toBe(10_000_000);
    expect(big.totalChunks).toBe(15);
    expect(big.ranges.at(-1)).toEqual({ start: 140_000_000, end: 150_000_122 });
    expect(big.ranges[1]).toEqual({ start: 10_000_000, end: 19_999_999 });

    const ranges: string[] = [];
    const { c, bodyOf } = setup((url, init) => {
      if (url.pathname.endsWith("creator_info/query/")) return ok(CREATOR);
      if (url.pathname.endsWith("video/init/")) return ok({ publish_id: "v_pub_file~2", upload_url: "https://open-upload.tiktokapis.com/u" });
      if (init.method === "PUT") {
        ranges.push((init.headers as Record<string, string>)["content-range"]!);
        expect((init.body as Uint8Array).length).toBeGreaterThan(0);
        return new Response(null, { status: ranges.length < 7 ? 206 : 201 });
      }
      if (url.pathname.endsWith("status/fetch/")) return ok({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["73"] });
      return undefined;
    });
    await c.publish(acct, input({ media: [video({ bytes: 70_000_123 })] }));
    expect(bodyOf("/v2/post/publish/video/init/").source_info).toEqual({ source: "FILE_UPLOAD", video_size: 70_000_123, chunk_size: 10_000_000, total_chunk_count: 7 });
    expect(ranges).toHaveLength(7);
    expect(ranges[0]).toBe("bytes 0-9999999/70000123");
    expect(ranges[6]).toBe("bytes 60000000-70000122/70000123");
  });

  it("uses PULL_FROM_URL when the account is configured for it, and returns the publish_id while the post is not public", async () => {
    const { c, bodyOf } = setup((url) => {
      if (url.pathname.endsWith("creator_info/query/")) return ok(CREATOR);
      if (url.pathname.endsWith("video/init/")) return ok({ publish_id: "v_pub_url~3" });
      if (url.pathname.endsWith("status/fetch/")) return ok({ status: "PUBLISH_COMPLETE" });
      return undefined;
    });
    const res = await c.publish({ ...acct, config: { videoSource: "PULL_FROM_URL" } }, input({ options: { privacy: "self" } }));
    expect(bodyOf("/v2/post/publish/video/init/").source_info).toEqual({ source: "PULL_FROM_URL", video_url: "https://media.acme.example/v.mp4" });
    expect(bodyOf("/v2/post/publish/video/init/").post_info.privacy_level).toBe("SELF_ONLY");
    expect(res).toMatchObject({ externalId: "v_pub_url~3", url: null });
  });

  it("publishes photo posts through content/init with media_type PHOTO", async () => {
    const { c, bodyOf } = setup((url) => {
      if (url.pathname.endsWith("creator_info/query/")) return ok(CREATOR);
      if (url.pathname === "/v2/post/publish/content/init/") return ok({ publish_id: "p_pub_url~4" });
      if (url.pathname.endsWith("status/fetch/")) return ok({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["74"] });
      return undefined;
    });
    const media = [
      { kind: "image" as const, url: "https://media.acme.example/a.jpg", mime: "image/jpeg" },
      { kind: "image" as const, url: "https://media.acme.example/b.webp", mime: "image/webp" },
    ];
    const res = await c.publish(acct, input({ text: "carousel caption", media, options: { privacy: "friends", title: "Launch", kind: "carousel" } }));
    expect(res.externalId).toBe("74");
    expect(bodyOf("/v2/post/publish/content/init/")).toEqual({
      post_info: { title: "Launch", description: "carousel caption", privacy_level: "MUTUAL_FOLLOW_FRIENDS", disable_comment: true, auto_add_music: false, brand_content_toggle: false, brand_organic_toggle: false },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: ["https://media.acme.example/a.jpg", "https://media.acme.example/b.webp"] },
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
    });
  });

  it("validates against creator info before posting", async () => {
    const route: Route = (url) => (url.pathname.endsWith("creator_info/query/") ? ok({ ...CREATOR, privacy_level_options: ["SELF_ONLY"], comment_disabled: true, max_video_post_duration_sec: 60 }) : undefined);
    const { c, calls } = setup(route);
    const e1 = await rejection(c.publish(acct, input({ idempotencyKey: "a" })));
    expect(e1.kind).toBe("rejected");
    expect(e1.message).toMatch(/PUBLIC_TO_EVERYONE is not available.*audited/s);
    expect((await rejection(c.publish(acct, input({ idempotencyKey: "b", options: { privacy: "self", allowComments: true } })))).message).toMatch(/comments are turned off/);
    expect((await rejection(c.publish(acct, input({ idempotencyKey: "c", options: { privacy: "self" }, media: [video({ durationSeconds: 120 })] })))).message).toMatch(/at most 60s/);
    expect((await rejection(c.publish(acct, input({ idempotencyKey: "d", options: {} })))).message).toMatch(/choose a privacy/);
    expect((await rejection(c.publish(acct, input({ idempotencyKey: "e", options: { privacy: "self", brandedContent: true } })))).message).toMatch(/branded content cannot be private/);
    expect(calls.some((x) => x.url.pathname.includes("init"))).toBe(false);
  });

  it("explains the audit when TikTok refuses an unaudited client", async () => {
    const { c } = setup((url) => {
      if (url.pathname.endsWith("creator_info/query/")) return ok(CREATOR);
      if (url.pathname.endsWith("video/init/")) return fail("unaudited_client_can_only_post_to_private_accounts", 403);
      return undefined;
    });
    const e = await rejection(c.publish(acct, input()));
    expect(e.kind).toBe("rejected");
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/unaudited.*audited for Direct Post/s);
  });

  it("gives up with a retryable error while processing, then resumes polling the same publish on retry", async () => {
    let done = false;
    const { c, calls } = setup((url) => {
      if (url.pathname.endsWith("creator_info/query/")) return ok(CREATOR);
      if (url.pathname.endsWith("video/init/")) return ok({ publish_id: "v_pub_url~5" });
      if (url.pathname.endsWith("status/fetch/")) return ok(done ? { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["75"] } : { status: "PROCESSING_DOWNLOAD" });
      return undefined;
    }, { maxPolls: 3 });
    const e = await rejection(c.publish({ ...acct, config: { videoSource: "PULL_FROM_URL" } }, input()));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    expect(calls.filter((x) => x.url.pathname.endsWith("status/fetch/"))).toHaveLength(3);
    done = true;
    const res = await c.publish({ ...acct, config: { videoSource: "PULL_FROM_URL" } }, input());
    expect(res.externalId).toBe("75");
    expect(calls.filter((x) => x.url.pathname.endsWith("video/init/"))).toHaveLength(1);
    // Same key again: served from the idempotency cache, no network.
    const before = calls.length;
    expect((await c.publish(acct, input())).externalId).toBe("75");
    expect(calls.length).toBe(before);
  });

  it("maps a FAILED status to rejected", async () => {
    const { c } = setup((url) => {
      if (url.pathname.endsWith("creator_info/query/")) return ok(CREATOR);
      if (url.pathname.endsWith("video/init/")) return ok({ publish_id: "v_pub_url~6" });
      if (url.pathname.endsWith("status/fetch/")) return ok({ status: "FAILED", fail_reason: "video_pull_failed" });
      return undefined;
    });
    const e = await rejection(c.publish({ ...acct, config: { videoSource: "PULL_FROM_URL" } }, input()));
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/video_pull_failed.*domain verified/);
  });
});

describe("tiktok reading", () => {
  it("lists own videos as activity since a date", async () => {
    const { c, bodyOf, calls } = setup((url) =>
      url.pathname === "/v2/video/list/"
        ? ok({
            videos: [
              { id: "2", video_description: "newer", create_time: 1762128000, share_url: "https://www.tiktok.com/@acme/video/2" }, // 2025-11-03
              { id: "1", title: "older", create_time: 1600000000 },
            ],
            cursor: 123,
            has_more: true,
          })
        : undefined,
    );
    const items = await c.fetchActivity(acct, new Date("2025-01-01T00:00:00Z"));
    expect(items).toEqual([{ network: "tiktok", kind: "own_post", externalId: "2", authorHandle: "acme", authorName: null, text: "newer", url: "https://www.tiktok.com/@acme/video/2", parentExternalId: null, occurredAt: "2025-11-03T00:00:00.000Z", raw: expect.anything() }]);
    expect(bodyOf("/v2/video/list/")).toEqual({ max_count: 20 });
    expect(calls).toHaveLength(1); // stopped at the first older video
    expect(c.capabilities()).toMatchObject({ reply: false, moderate: false, webhooks: true, accountMetrics: true, video: true });
  });

  it("maps video metrics and resolves publish ids to video ids", async () => {
    const { c, bodyOf } = setup((url) => {
      if (url.pathname.endsWith("status/fetch/")) return ok({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["900"] });
      if (url.pathname === "/v2/video/query/")
        return ok({ videos: [{ id: "900", view_count: 1000, like_count: 50, comment_count: 5, share_count: 3 }, { id: "901", view_count: 10, like_count: 1, comment_count: 0, share_count: 0 }] });
      return undefined;
    });
    const rows = await c.fetchMetrics(acct, ["v_pub_url~9", "901"]);
    expect(bodyOf("/v2/video/query/")).toEqual({ filters: { video_ids: ["900", "901"] } });
    const of = (id: string) => Object.fromEntries(rows.filter((r) => r.entityId === id).map((r) => [r.metric, r.value]));
    expect(of("v_pub_url~9")).toEqual({ video_views: 1000, likes: 50, replies: 5, shares: 3, engagements: 58 });
    expect(of("901")).toEqual({ video_views: 10, likes: 1, replies: 0, shares: 0, engagements: 1 });
    expect(rows[0]).toMatchObject({ entityType: "post_variant", source: "tiktok", observedAt: NOW.toISOString() });
  });

  it("reads follower count for account metrics", async () => {
    const { c, calls } = setup((url) => (url.pathname === "/v2/user/info/" ? ok({ user: { follower_count: 4200, likes_count: 99000 } }) : undefined));
    expect(await c.fetchAccountMetrics(acct)).toEqual([
      { entityType: "social_account", entityId: "acc-tt", metric: "followers_total", value: 4200, observedAt: NOW.toISOString(), source: "tiktok" },
      { entityType: "social_account", entityId: "acc-tt", metric: "likes", value: 99000, observedAt: NOW.toISOString(), source: "tiktok" },
    ]);
    expect(calls[0]!.url.searchParams.get("fields")).toContain("follower_count");
  });
});

describe("tiktok errors", () => {
  it("maps TikTok error codes and HTTP statuses", async () => {
    expect(mapTikTokError(401, { error: { code: "access_token_invalid" } }, "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapTikTokError(401, { error: { code: "scope_not_authorized" } }, "x").kind).toBe("auth");
    expect(mapTikTokError(429, { error: { code: "rate_limit_exceeded" } }, "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapTikTokError(403, { error: { code: "spam_risk_too_many_posts" } }, "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapTikTokError(403, { error: { code: "url_ownership_unverified" } }, "x").message).toMatch(/verified/);
    expect(mapTikTokError(500, { error: { code: "internal_error" } }, "x")).toMatchObject({ kind: "network", retryable: true });
    expect(mapTikTokError(400, { error: { code: "invalid_params" } }, "x").kind).toBe("rejected");
    const { c } = setup(() => {
      throw new TypeError("fetch failed");
    });
    expect(await rejection(c.fetchAccountMetrics(acct))).toMatchObject({ kind: "network", retryable: true });
    const bad = setup(() => fail("access_token_invalid", 401));
    expect((await rejection(bad.c.fetchActivity(acct, null))).kind).toBe("auth");
    await expect(bad.c.publish({ ...acct, auth: { accessToken: "t" } }, input())).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("tiktok webhooks", () => {
  const body = JSON.stringify({ client_key: "ck", event: "post.publish.publicly_available", create_time: 1762128000, user_openid: "open-1", content: JSON.stringify({ publish_id: "v_pub_url~5", post_id: "75", publish_type: "DIRECT_PUBLISH" }) });
  const sign = (t: number, raw: string, secret = "cs") => `t=${t},s=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
  const t = NOW.getTime() / 1000;

  it("verifies TikTok-Signature with the client secret and rejects bad or stale signatures", () => {
    const { c } = setup(() => undefined);
    expect(c.webhook.verify({ "TikTok-Signature": sign(t, body) }, body)).toBe(true);
    expect(c.webhook.verify({ "tiktok-signature": sign(t, body) }, body)).toBe(true);
    expect(c.webhook.verify({ "tiktok-signature": sign(t, body, "other") }, body)).toBe(false);
    expect(c.webhook.verify({ "tiktok-signature": sign(t - 3600, body) }, body)).toBe(false);
    expect(c.webhook.verify({ "tiktok-signature": sign(t, body) }, `${body} `)).toBe(false);
    expect(c.webhook.verify({}, body)).toBe(false);
    const withSecret = setup(() => undefined, { webhookSecret: "whs" }).c;
    expect(withSecret.webhook.verify({ "tiktok-signature": sign(t, body, "whs") }, body)).toBe(true);
  });

  it("parses publicly_available events into own_post items routed by open_id", () => {
    expect(parseTikTokWebhook(JSON.parse(body))).toEqual([
      { network: "tiktok", accountExternalId: "open-1", items: [{ network: "tiktok", kind: "own_post", externalId: "75", authorHandle: null, authorName: null, text: null, url: null, parentExternalId: "v_pub_url~5", occurredAt: "2025-11-03T00:00:00.000Z", raw: expect.anything() }] },
    ]);
    expect(parseTikTokWebhook({ event: "post.publish.failed", user_openid: "open-1", content: "{\"publish_id\":\"x\",\"reason\":\"y\"}" })).toEqual([]);
    expect(parseTikTokWebhook({ nonsense: true })).toEqual([]);
  });
});

describe("tiktok validate", () => {
  it("flags missing privacy, mixed media, GIFs, PNG photos, caption length and branded private posts", () => {
    const { c } = setup(() => undefined);
    const codes = (i: PublishInput) => c.validate(acct, i).map((x) => x.message);
    expect(codes(input())).toEqual([]);
    expect(codes(input({ options: {} })).join()).toMatch(/privacy/);
    expect(codes(input({ options: { privacy: "unlisted" } })).join()).toMatch(/unlisted/);
    expect(codes(input({ media: [] })).join()).toMatch(/need a video/);
    expect(codes(input({ media: [video(), { kind: "image", url: "https://m/a.jpg" }] })).join()).toMatch(/mix/);
    expect(codes(input({ media: [{ kind: "gif", url: "https://m/a.gif" }] })).join()).toMatch(/GIF/);
    expect(codes(input({ media: [{ kind: "image", url: "https://m/a.png", mime: "image/png" }] })).join()).toMatch(/JPEG or WebP/);
    expect(codes(input({ text: "x".repeat(2201) })).join()).toMatch(/2200/);
    expect(codes(input({ options: { privacy: "self", brandedContent: true } })).join()).toMatch(/branded/);
  });
});

describe("tiktok json", () => {
  it("keeps int64 post ids exact", async () => {
    const { parseTikTokJson } = await import("../src/tiktok.ts");
    expect(parseTikTokJson('{"data":{"publicaly_available_post_id":[7300000000000000001, 7300000000000000003],"uploaded_bytes":10},"error":{"code":"ok"}}')).toEqual({
      data: { publicaly_available_post_id: ["7300000000000000001", "7300000000000000003"], uploaded_bytes: 10 },
      error: { code: "ok" },
    });
    expect(parseTikTokJson('{"post_id":7300000000000000001}')).toEqual({ post_id: "7300000000000000001" });
    expect(parseTikTokJson('{"publicly_available_post_id":["1", 2]}')).toEqual({ publicly_available_post_id: ["1", "2"] });
    expect(parseTikTokWebhook({ event: "post.publish.publicly_available", user_openid: "o", content: '{"post_id":7300000000000000001}' })[0]!.items[0]!.externalId).toBe("7300000000000000001");
  });
});
