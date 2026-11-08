import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { VK_API_VERSION, VkConnector, createVkConnectors, mapVkError, parseVkRef } from "../src/vk.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const API = "https://api.vk.com/method";
const TOKEN = "https://id.vk.com/oauth2/auth";
const auth = { accessToken: "tok", refreshToken: "ref", expiresAt: "2026-11-06T13:00:00.000Z", deviceId: "dev-1", userId: "42" };
const userAcct: AccountRef = { id: "acc-u", workspaceId: "w", network: "vk", externalId: "42", handle: "ivan", auth, config: { ownerId: 42, kind: "user" } };
const groupAcct: AccountRef = { id: "acc-g", workspaceId: "w", network: "vk", externalId: "-777", handle: "acme", auth, config: { ownerId: -777, groupId: 777, kind: "group" } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (response: unknown) => json({ response });
const vkErr = (error_code: number, error_msg = "err") => json({ error: { error_code, error_msg, request_params: [] } });

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let routes: [string, Handler][];
/** Route by exact URL (no query): VK method names share prefixes (wall.get / wall.getComments). */
function on(url: string, handler: Handler | unknown) {
  const h: Handler = typeof handler === "function" ? (handler as Handler) : handler instanceof Response ? () => handler.clone() : () => ok(handler);
  routes.push([url, h]);
}
const method = (name: string, handler: Handler | unknown) => on(`${API}/${name}`, handler);
function calls(url: string) {
  return fetchMock.mock.calls.filter(([u]) => String(u).split("?")[0] === url).map(([u, init]) => ({ url: String(u), body: init?.body }));
}
const params = (name: string, i = 0) => new URLSearchParams(String(calls(`${API}/${name}`)[i]!.body));
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
    const hit = routes.find(([p]) => url.split("?")[0] === p);
    if (!hit) throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    return hit[1](url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = () => {
  const c = new VkConnector({ clientId: "51234567", clientSecret: "sec", now: () => NOW });
  c.media = { fetch: async (m) => ({ bytes: new Uint8Array([9, 9]), mime: m.kind === "video" ? "video/mp4" : "image/jpeg" }) };
  return c;
};

describe("vk connect", () => {
  it("builds the VK ID authorize URL with PKCE", () => {
    const url = new URL(connector().oauthAuthorizeUrl({ state: "st", codeChallenge: "chal", redirectUri: "https://air.example/oauth/vk/callback" }));
    expect(url.origin + url.pathname).toBe("https://id.vk.com/authorize");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("wall");
    expect(createVkConnectors({})[0]!.connectConfigured).toBe(false);
    expect(createVkConnectors({ VK_CLIENT_ID: "1" })[0]!.connectConfigured).toBe(true);
  });

  it("exchanges the code with device_id and returns the wall plus managed communities", async () => {
    on(TOKEN, json({ access_token: "tok", refresh_token: "ref", id_token: "idt", expires_in: 3600, user_id: 42, scope: "wall photos groups", state: "st" }));
    method("users.get", [{ id: 42, first_name: "Ivan", last_name: "Petrov", screen_name: "ivan" }]);
    method("groups.get", { count: 2, items: [{ id: 777, name: "Acme", screen_name: "acme", admin_level: 3 }, { id: 888, name: "Acme Shop" }] });
    const accounts = await connector().oauthConnect({ code: "code1", codeVerifier: "ver", redirectUri: "https://air.example/oauth/vk/callback", callbackParams: { device_id: "dev-1", state: "st" } });
    expect(accounts.map((a) => [a.identity.externalId, a.identity.handle, a.identity.displayName, a.config?.ownerId])).toEqual([
      ["42", "ivan", "Ivan Petrov", 42],
      ["-777", "acme", "Acme", -777],
      ["-888", "club888", "Acme Shop", -888],
    ]);
    expect(accounts[0]!.auth).toEqual({ accessToken: "tok", refreshToken: "ref", expiresAt: "2026-11-06T13:00:00.000Z", scope: "wall photos groups", deviceId: "dev-1", userId: "42" });
    const form = new URLSearchParams(String(calls(TOKEN)[0]!.body));
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "code1", code_verifier: "ver", device_id: "dev-1", state: "st", client_id: "51234567" });
    expect(params("groups.get").get("filter")).toBe("admin,editor");
    expect(params("users.get").get("v")).toBe(VK_API_VERSION);
    expect(params("users.get").get("access_token")).toBe("tok");
  });

  it("still connects the wall when groups access is denied", async () => {
    on(TOKEN, json({ access_token: "tok", expires_in: 3600 }));
    method("users.get", [{ id: 42, screen_name: "ivan" }]);
    method("groups.get", vkErr(7, "Permission to perform this action is denied"));
    const accounts = await connector().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "r" });
    expect(accounts).toHaveLength(1);
  });

  it("refreshes with device_id once for accounts sharing a single-use refresh token", async () => {
    on(TOKEN, json({ access_token: "tok2", refresh_token: "ref2", expires_in: 3600 }));
    const c = connector();
    const a = await c.refreshAuth(userAcct);
    const b = await c.refreshAuth(groupAcct);
    expect(a!.auth).toEqual({ accessToken: "tok2", refreshToken: "ref2", expiresAt: "2026-11-06T13:00:00.000Z", deviceId: "dev-1", userId: "42" });
    expect(b!.auth).toEqual(a!.auth);
    expect(calls(TOKEN)).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(String(calls(TOKEN)[0]!.body)))).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref", device_id: "dev-1" });
  });
});

describe("vk publish", () => {
  const input: PublishInput = { variantId: "v", text: "Hello VK", media: [], thread: [], idempotencyKey: "k1" };

  it("posts text and a link to the user's wall", async () => {
    method("wall.post", { post_id: 55 });
    const r = await connector().publish(userAcct, { ...input, options: { link: "https://acme.example/a" } });
    expect(r).toMatchObject({ externalId: "42_55", url: "https://vk.com/wall42_55" });
    const p = params("wall.post");
    expect(Object.fromEntries(p)).toMatchObject({ owner_id: "42", message: "Hello VK", attachments: "https://acme.example/a" });
    expect(p.get("from_group")).toBeNull();
  });

  it("uploads photos for a community wall and posts as the community", async () => {
    method("photos.getWallUploadServer", { upload_url: "https://pu.vk.com/upload/1", album_id: -14, user_id: 42 });
    on("https://pu.vk.com/upload/1", json({ server: 123, photo: '[{"photo":"abc"}]', hash: "h1" }));
    let n = 0;
    method("photos.saveWallPhoto", () => ok([{ id: 1000 + n++, owner_id: -777 }]));
    method("wall.post", { post_id: 9 });
    const r = await connector().publish(groupAcct, {
      ...input,
      idempotencyKey: "k2",
      media: [
        { kind: "image", url: "https://cdn.example/a.jpg", alt: "First" },
        { kind: "image", url: "https://cdn.example/b.jpg" },
      ],
      options: { link: "https://acme.example" },
    });
    expect(r.externalId).toBe("-777_9");
    expect(params("photos.getWallUploadServer").get("group_id")).toBe("777");
    const upload = calls("https://pu.vk.com/upload/1")[0]!.body as FormData;
    expect(upload.get("photo")).toBeInstanceOf(Blob);
    expect(Object.fromEntries(params("photos.saveWallPhoto"))).toMatchObject({ group_id: "777", server: "123", photo: '[{"photo":"abc"}]', hash: "h1", caption: "First" });
    expect(Object.fromEntries(params("wall.post"))).toMatchObject({ owner_id: "-777", from_group: "1", attachments: "photo-777_1000,photo-777_1001,https://acme.example" });
  });

  it("uploads a video with video.save", async () => {
    method("video.save", { upload_url: "https://vu.vk.com/upload/v", video_id: 31, owner_id: -777 });
    on("https://vu.vk.com/upload/v", json({ video_id: 31, owner_id: -777, size: 2 }));
    method("wall.post", { post_id: 10 });
    await connector().publish(groupAcct, { ...input, idempotencyKey: "k3", media: [{ kind: "video", url: "https://cdn.example/v.mp4" }], options: { title: "Launch" } });
    expect(Object.fromEntries(params("video.save"))).toMatchObject({ group_id: "777", name: "Launch", wallpost: "0" });
    expect((calls("https://vu.vk.com/upload/v")[0]!.body as FormData).get("video_file")).toBeInstanceOf(Blob);
    expect(params("wall.post").get("attachments")).toBe("video-777_31");
  });

  it("validates attachments and empty posts", () => {
    const c = connector();
    expect(c.validate(userAcct, { ...input, text: "" }).map((i) => i.code)).toEqual(["empty"]);
    const ten = Array.from({ length: 10 }, () => ({ kind: "image" as const, url: "https://cdn.example/a.jpg" }));
    expect(c.validate(userAcct, { ...input, media: ten, options: { link: "https://acme.example" } }).map((i) => i.code)).toEqual(["too_many_media"]);
  });
});

describe("vk errors", () => {
  it("maps error codes returned with HTTP 200", async () => {
    expect(mapVkError({ error_code: 5, error_msg: "User authorization failed" }, "x")).toMatchObject({ kind: "auth", retryable: false });
    for (const code of [6, 9, 29]) expect(mapVkError({ error_code: code }, "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    for (const code of [15, 214, 100]) expect(mapVkError({ error_code: code }, "x")).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapVkError({ error_code: 10 }, "x")).toMatchObject({ kind: "network", retryable: true });
    expect(mapVkError({ error_code: 14 }, "x").message).toContain("captcha");
    expect(mapVkError({ error_code: 4242 }, "x").kind).toBe("unknown");

    method("wall.post", vkErr(214, "Access to adding post denied"));
    const e = await rejection(connector().publish(userAcct, { variantId: "v", text: "x", media: [], thread: [], idempotencyKey: "e1" }));
    expect([e.kind, e.message]).toEqual(["rejected", expect.stringContaining("error 214")]);
    expect((e.cause as { code: number }).code).toBe(214);
  });

  it("maps HTTP-level failures", async () => {
    method("wall.post", new Response("bad gateway", { status: 502 }));
    expect(await rejection(connector().publish(userAcct, { variantId: "v", text: "x", media: [], thread: [], idempotencyKey: "e2" }))).toMatchObject({ kind: "network", retryable: true });
  });
});

describe("vk inbox", () => {
  it("reads comments and threads on recent posts, skipping the account's own comments", async () => {
    const ts = (iso: string) => Date.parse(iso) / 1000;
    method("wall.get", { count: 2, items: [{ id: 9, owner_id: -777, comments: { count: 3 } }, { id: 8, owner_id: -777, comments: { count: 0 } }] });
    method("wall.getComments", {
      count: 2,
      items: [
        {
          id: 101,
          from_id: 5,
          date: ts("2026-11-06T10:00:00Z"),
          text: "Great!",
          thread: { count: 2, items: [{ id: 102, from_id: -777, date: ts("2026-11-06T10:05:00Z"), text: "Thanks", reply_to_comment: 101 }, { id: 103, from_id: 6, date: ts("2026-11-06T10:10:00Z"), text: "agreed", reply_to_comment: 102 }] },
        },
        { id: 99, from_id: 7, date: ts("2026-11-01T00:00:00Z"), text: "old" },
      ],
      profiles: [{ id: 5, first_name: "Olga", last_name: "S", screen_name: "olga" }],
      groups: [{ id: 777, name: "Acme", screen_name: "acme" }],
    });
    const items = await connector().fetchActivity(groupAcct, new Date("2026-11-05T00:00:00Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.authorHandle, i.authorName, i.text, i.parentExternalId])).toEqual([
      ["comment", "-777_9_101", "olga", "Olga S", "Great!", "-777_9"],
      ["reply", "-777_9_103", "id6", null, "agreed", "-777_9_102"],
    ]);
    expect(items[0]!.url).toBe("https://vk.com/wall-777_9?reply=101");
    expect(calls(`${API}/wall.getComments`)).toHaveLength(1);
    expect(Object.fromEntries(params("wall.getComments"))).toMatchObject({ owner_id: "-777", post_id: "9", extended: "1", thread_items_count: "10" });
  });

  it("replies to a comment as the community", async () => {
    method("wall.createComment", { comment_id: 104 });
    const r = await connector().reply(groupAcct, { parentExternalId: "-777_9_101", text: "Hi Olga", idempotencyKey: "r1" });
    expect(r).toMatchObject({ externalId: "-777_9_104", url: "https://vk.com/wall-777_9?reply=104" });
    expect(Object.fromEntries(params("wall.createComment"))).toMatchObject({ owner_id: "-777", post_id: "9", reply_to_comment: "101", from_group: "777", message: "Hi Olga" });
  });

  it("deletes and likes comments; hide is refused", async () => {
    method("wall.deleteComment", 1);
    method("likes.add", { likes: 3 });
    const c = connector();
    await c.moderate(groupAcct, { externalId: "-777_9_101", action: "delete" });
    expect(Object.fromEntries(params("wall.deleteComment"))).toMatchObject({ owner_id: "-777", comment_id: "101" });
    await c.moderate(groupAcct, { externalId: "-777_9_101", action: "like" });
    expect(Object.fromEntries(params("likes.add"))).toMatchObject({ type: "comment", owner_id: "-777", item_id: "101" });
    expect((await rejection(c.moderate(groupAcct, { externalId: "-777_9_101", action: "hide" }))).kind).toBe("rejected");
    expect(() => parseVkRef("nope")).toThrow(ConnectorError);
  });
});

describe("vk metrics", () => {
  it("maps wall.getById counters (items or bare array)", async () => {
    let n = 0;
    method("wall.getById", () =>
      n++ === 0
        ? ok({ items: [{ id: 9, owner_id: -777, views: { count: 500 }, likes: { count: 20 }, reposts: { count: 3 }, comments: { count: 4 } }] })
        : ok([{ id: 10, owner_id: -777, likes: { count: 1 } }]),
    );
    const c = connector();
    const m = await c.fetchMetrics(groupAcct, ["-777_9", "not-an-id"]);
    expect(m.map((x) => [x.entityId, x.metric, x.value])).toEqual([
      ["-777_9", "impressions", 500],
      ["-777_9", "likes", 20],
      ["-777_9", "reposts", 3],
      ["-777_9", "replies", 4],
      ["-777_9", "engagements", 27],
    ]);
    expect(params("wall.getById").get("posts")).toBe("-777_9");
    const m2 = await c.fetchMetrics(groupAcct, ["-777_10"]);
    expect(m2.map((x) => [x.metric, x.value])).toEqual([
      ["likes", 1],
      ["engagements", 1],
    ]);
  });

  it("reads followers for communities and users", async () => {
    method("groups.getMembers", { count: 15000, items: [] });
    method("users.getFollowers", { count: 321, items: [] });
    const c = connector();
    expect(await c.fetchAccountMetrics(groupAcct)).toEqual([{ entityType: "social_account", entityId: "acc-g", metric: "followers_total", value: 15000, observedAt: NOW.toISOString(), source: "vk" }]);
    expect(params("groups.getMembers").get("group_id")).toBe("777");
    expect((await c.fetchAccountMetrics(userAcct))[0]!.value).toBe(321);
  });
});
