import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { TUMBLR_OAUTH_SCOPES, TumblrConnector, createTumblrConnectors, mapTumblrError, textToBlocks, tumblrNotificationToActivity } from "../src/tumblr.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const API = "https://api.tumblr.com/v2";
const acct: AccountRef = {
  id: "acc-t",
  workspaceId: "w",
  network: "tumblr",
  externalId: "t:uuid-main",
  handle: "acme",
  auth: { accessToken: "tok", refreshToken: "ref", expiresAt: "2026-11-06T12:30:00.000Z", blogName: "acme", blogUuid: "t:uuid-main" },
  config: {},
};
const env = (response: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ meta: { status, msg: status === 200 ? "OK" : "Error" }, response }), { status, headers: { "content-type": "application/json", ...headers } });

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let routes: [string, string, Handler][];
function on(method: string, path: string, handler: Handler | unknown) {
  const h: Handler = typeof handler === "function" ? (handler as Handler) : handler instanceof Response ? () => handler.clone() : () => env(handler);
  routes.push([method, path, h]);
}
function calls(method?: string, path?: string) {
  return fetchMock.mock.calls
    .map(([u, init]) => ({ url: String(u), method: init?.method ?? "GET", body: init?.body }))
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

const connector = () => {
  const c = new TumblrConnector({ clientId: "cid", clientSecret: "csecret", now: () => NOW });
  c.media = { fetch: async (m) => ({ bytes: new Uint8Array([1, 2, 3]), mime: m.kind === "video" ? "video/mp4" : "image/png" }) };
  return c;
};

describe("tumblr connect", () => {
  it("builds the authorize URL and reports configuration", () => {
    const url = new URL(connector().oauthAuthorizeUrl({ state: "s1", codeChallenge: "ch", redirectUri: "https://app.example/oauth/tumblr/callback" }));
    expect(url.origin + url.pathname).toBe("https://www.tumblr.com/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("basic write offline_access");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(TUMBLR_OAUTH_SCOPES).toContain("offline_access");
    expect(createTumblrConnectors({})[0]!.connectConfigured).toBe(false);
    expect(createTumblrConnectors({ TUMBLR_CLIENT_ID: "a", TUMBLR_CLIENT_SECRET: "b" })[0]!.connectConfigured).toBe(true);
  });

  it("exchanges the code and returns one account per blog", async () => {
    on("POST", `${API}/oauth2/token`, () => new Response(JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 2520, scope: "basic write offline_access" }), { status: 200 }));
    on("GET", `${API}/user/info`, {
      user: {
        name: "acme",
        blogs: [
          { uuid: "t:uuid-main", name: "acme", title: "Acme", primary: true, url: "https://acme.tumblr.com/" },
          { uuid: "t:uuid-side", name: "acme-news", title: "Acme News", primary: false },
          { name: "broken" },
        ],
      },
    });
    const accounts = await connector().oauthConnect({ code: "c1", codeVerifier: "v", redirectUri: "https://app.example/oauth/tumblr/callback" });
    expect(accounts.map((a) => a.identity)).toEqual([
      { externalId: "t:uuid-main", handle: "acme", displayName: "Acme" },
      { externalId: "t:uuid-side", handle: "acme-news", displayName: "Acme News" },
    ]);
    expect(accounts[1]!.auth).toEqual({ accessToken: "tok", refreshToken: "ref", expiresAt: "2026-11-06T12:42:00.000Z", scope: "basic write offline_access", blogName: "acme-news", blogUuid: "t:uuid-side" });
    const form = new URLSearchParams(String(calls("POST", `${API}/oauth2/token`)[0]!.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("csecret");
  });

  it("refreshes once for blogs that share a rotated refresh token", async () => {
    on("POST", `${API}/oauth2/token`, () => new Response(JSON.stringify({ access_token: "tok2", refresh_token: "ref2", expires_in: 2520 }), { status: 200 }));
    const c = connector();
    const a = await c.refreshAuth(acct);
    const b = await c.refreshAuth({ ...acct, id: "acc-t2", handle: "acme-news", auth: { ...acct.auth, blogName: "acme-news", blogUuid: "t:uuid-side" } });
    expect(a!.auth).toMatchObject({ accessToken: "tok2", refreshToken: "ref2", blogName: "acme" });
    expect(b!.auth).toMatchObject({ accessToken: "tok2", refreshToken: "ref2", blogName: "acme-news" });
    expect(calls("POST", `${API}/oauth2/token`)).toHaveLength(1);
    expect(await c.refreshAuth({ ...acct, auth: { accessToken: "x", blogName: "acme" } })).toBeNull();
  });
});

describe("tumblr publish", () => {
  const base: PublishInput = { variantId: "v", text: "First paragraph.\n\nSecond paragraph.", media: [], thread: [], idempotencyKey: "k1" };

  it("posts NPF text, heading, link and tags as JSON", async () => {
    on("POST", `${API}/blog/acme/posts`, { id: 123, id_string: "123", state: "published" });
    const c = connector();
    const r = await c.publish(acct, { ...base, options: { title: "Big news", link: "https://acme.example/x", tags: ["launch", "#acme", "a,b"] } });
    expect(r).toMatchObject({ externalId: "123", url: "https://www.tumblr.com/acme/123" });
    const body = JSON.parse(String(calls("POST", `${API}/blog/acme/posts`)[0]!.body));
    expect(body).toEqual({
      content: [
        { type: "text", subtype: "heading1", text: "Big news" },
        { type: "text", text: "First paragraph." },
        { type: "text", text: "Second paragraph." },
        { type: "link", url: "https://acme.example/x", title: "Big news" },
      ],
      state: "published",
      tags: "launch,acme,a b",
    });
    // Idempotent retry.
    await c.publish(acct, { ...base, options: { title: "Big news" } });
    expect(calls("POST", `${API}/blog/acme/posts`)).toHaveLength(1);
  });

  it("uploads images and video as multipart parts referenced by identifier", async () => {
    on("POST", `${API}/blog/acme/posts`, { id_string: "456" });
    const r = await connector().publish(acct, {
      ...base,
      idempotencyKey: "k2",
      media: [
        { kind: "image", url: "https://cdn.example/a.png", alt: "A cat", width: 800, height: 600 },
        { kind: "video", url: "https://cdn.example/v.mp4" },
      ],
    });
    expect(r.externalId).toBe("456");
    const form = calls("POST", `${API}/blog/acme/posts`)[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const json = JSON.parse(await (form.get("json") as Blob).text());
    expect(json.content.slice(2)).toEqual([
      { type: "image", media: [{ type: "image/png", identifier: "image0", width: 800, height: 600 }], alt_text: "A cat" },
      { type: "video", media: { type: "video/mp4", identifier: "video1" } },
    ]);
    expect(form.get("image0")).toBeInstanceOf(Blob);
    expect(form.get("video1")).toBeInstanceOf(Blob);
  });

  it("validates before posting", async () => {
    const c = connector();
    expect(c.validate(acct, { ...base, text: " " }).map((i) => i.code)).toEqual(["empty"]);
    expect(c.validate(acct, { ...base, media: [{ kind: "document", url: "https://cdn.example/a.pdf" }] }).map((i) => i.code)).toContain("unsupported_media");
    expect(c.validate(acct, { ...base, media: Array.from({ length: 11 }, () => ({ kind: "image" as const, url: "https://cdn.example/a.png" })) }).map((i) => i.code)).toContain("too_many_media");
    const e = await rejection(c.publish(acct, { ...base, text: "", idempotencyKey: "k3" }));
    expect(e.kind).toBe("rejected");
  });

  it("splits long paragraphs into blocks", () => {
    const long = `${"a".repeat(30)}\n${"b".repeat(30)}\n${"c".repeat(80)}`;
    const blocks = textToBlocks(long, 64);
    expect(blocks.every((b) => b.text.length <= 64)).toBe(true);
    expect(blocks.map((b) => b.text).join("\n").replace(/\n/g, "")).toBe(long.replace(/\n/g, ""));
  });
});

describe("tumblr inbox", () => {
  it("maps notifications to activity kinds, filters by since and pages with before", async () => {
    const t = (iso: string) => Date.parse(iso) / 1000;
    on("GET", `${API}/blog/acme/notifications`, (url: string) => {
      const before = new URL(url).searchParams.get("before");
      if (!before)
        return env({
          notifications: [
            { type: "reply", timestamp: t("2026-11-06T10:00:00Z"), from_tumblelog_name: "fan1", target_post_id: "123", target_tumblelog_name: "acme", reply_text: "love it" },
            { type: "reblog_with_content", timestamp: t("2026-11-06T09:00:00Z"), from_tumblelog_name: "fan2", target_post_id: "123", post_id: "999", added_text: "so true" },
            { type: "mention_in_post", timestamp: t("2026-11-06T08:00:00Z"), from_tumblelog_name: "fan3", post_id: "777", post_summary: "hey @acme" },
            { type: "like", timestamp: t("2026-11-06T07:00:00Z"), from_tumblelog_name: "fan4", target_post_id: "123" },
            { type: "unknown_type", timestamp: t("2026-11-06T07:00:00Z") },
          ],
          _links: { next: { query_params: { before: String(t("2026-11-06T07:00:00Z")) } } },
        });
      return env({ notifications: [{ type: "follow", timestamp: t("2026-11-06T06:00:00Z"), from_tumblelog_name: "fan5" }, { type: "like", timestamp: t("2026-11-01T00:00:00Z"), from_tumblelog_name: "old", target_post_id: "1" }] });
    });
    const items = await connector().fetchActivity(acct, new Date("2026-11-05T00:00:00Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.authorHandle, i.text, i.parentExternalId])).toEqual([
      ["follow", `follow:fan5:-:${t("2026-11-06T06:00:00Z")}`, "fan5", null, null],
      ["like", `like:fan4:123:${t("2026-11-06T07:00:00Z")}`, "fan4", null, "acme:123"],
      ["mention", "fan3:777", "fan3", "hey @acme", null],
      ["quote", "fan2:999", "fan2", "so true", "acme:123"],
      ["reply", `reply:fan1:123:${t("2026-11-06T10:00:00Z")}`, "fan1", "love it", "acme:123"],
    ]);
    expect(items[3]!.url).toBe("https://www.tumblr.com/fan2/999");
    const first = new URL(calls("GET", `${API}/blog/acme/notifications`)[0]!.url);
    expect(first.searchParams.getAll("types[]")).toEqual(expect.arrayContaining(["reply", "reblog_with_content", "like", "follow"]));
    expect(calls("GET", `${API}/blog/acme/notifications`)).toHaveLength(2);
  });

  it("uses the notification id when Tumblr sends one", () => {
    const a = tumblrNotificationToActivity({ id: "n1", type: "like", timestamp: 1, from_tumblelog_name: "x", target_post_id: "5" }, "acme");
    expect(a?.externalId).toBe("notification:n1");
  });

  it("likes a post with its reblog key and refuses other actions; declares no reply", async () => {
    on("GET", `${API}/blog/fan2/posts/999`, { id_string: "999", reblog_key: "rk" });
    on("POST", `${API}/user/like`, {});
    const c = connector();
    await c.moderate(acct, { externalId: "fan2:999", action: "like" });
    expect(JSON.parse(String(calls("POST", `${API}/user/like`)[0]!.body))).toEqual({ id: "999", reblog_key: "rk" });
    expect((await rejection(c.moderate(acct, { externalId: "fan2:999", action: "hide" }))).kind).toBe("rejected");
    expect(c.capabilities().reply).toBe(false);
    expect((c as { reply?: unknown }).reply).toBeUndefined();
  });
});

describe("tumblr metrics", () => {
  it("maps notes totals per post and followers for the blog", async () => {
    on("GET", `${API}/blog/acme/notes`, { total_notes: 42, total_likes: 30, total_reblogs: 12, notes: [] });
    on("GET", `${API}/blog/acme/followers`, { total_users: 1234, users: [] });
    const c = connector();
    const m = await c.fetchMetrics(acct, ["123"]);
    expect(m.map((x) => [x.entityId, x.metric, x.value])).toEqual([
      ["123", "engagements", 42],
      ["123", "likes", 30],
      ["123", "reposts", 12],
    ]);
    expect(new URL(calls("GET", `${API}/blog/acme/notes`)[0]!.url).searchParams.get("id")).toBe("123");
    expect(await c.fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "acc-t", metric: "followers_total", value: 1234, observedAt: NOW.toISOString(), source: "tumblr" }]);
  });

  it("maps HTTP errors", async () => {
    expect(mapTumblrError(401, new Headers(), {}, "x").kind).toBe("auth");
    const rl = mapTumblrError(429, new Headers({ "retry-after": "30" }), {}, "x");
    expect([rl.kind, rl.retryable, rl.message]).toEqual(["rate_limit", true, expect.stringContaining("30s")]);
    expect(mapTumblrError(503, new Headers(), {}, "x")).toMatchObject({ kind: "network", retryable: true });
    expect(mapTumblrError(400, new Headers(), { errors: [{ detail: "Bad content" }] }, "x")).toMatchObject({ kind: "rejected", retryable: false });
    on("GET", `${API}/blog/acme/followers`, env(null, 403));
    expect((await rejection(connector().fetchAccountMetrics(acct))).kind).toBe("auth");
  });
});
