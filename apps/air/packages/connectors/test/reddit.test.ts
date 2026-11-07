import { describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type Connector, type PublishInput } from "../src/index.ts";
import { REDDIT_DEFAULT_USER_AGENT, RedditConnector, createRedditConnectors, mapRedditApiErrors, redditPostKind, type RedditConnectorOptions } from "../src/reddit.ts";

const NOW = new Date("2026-11-03T00:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const UA = "web:base-air:0.1 (by /u/acme_owner)";

const acct: AccountRef = {
  id: "acc-rd",
  workspaceId: "w",
  network: "reddit",
  externalId: "t2_abc",
  handle: "u/acme",
  auth: { accessToken: "tok", refreshToken: "rt", userId: "t2_abc", username: "acme", expiresAt: "2026-11-03T01:00:00.000Z" },
  config: {},
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const listing = (children: { kind: string; data: Record<string, unknown> }[], after: string | null = null) => ({ kind: "Listing", data: { after, children } });

type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

function setup(route: Route, opts: RedditConnectorOptions = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const i = init ?? {};
    calls.push({ url, init: i });
    const r = await route(url, i);
    if (!r) throw new Error(`unexpected ${i.method ?? "GET"} ${url}`);
    return r;
  });
  const c = new RedditConnector({ clientId: "cid", clientSecret: "sec", userAgent: UA, fetch: fetchMock as unknown as typeof fetch, now: () => NOW, sleep: async () => {}, ...opts });
  c.media = { fetch: async (m) => ({ bytes: new Uint8Array([1, 2, 3]), mime: m.kind === "video" ? "video/mp4" : "image/jpeg" }) };
  const form = (path: string, n = 0) => {
    const hit = calls.filter((x) => x.url.pathname === path)[n];
    if (!hit) throw new Error(`no call to ${path}`);
    return Object.fromEntries(new URLSearchParams(String(hit.init.body)));
  };
  return { c, calls, form };
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

const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v1", text: "Body text", media: [], thread: [], idempotencyKey: "k1", options: { subreddit: "baseair", title: "Hello Reddit" }, ...over });

const lease = (n: string) =>
  json({
    args: { action: "//reddit-uploaded-media.s3-accelerate.amazonaws.com", fields: [{ name: "key", value: `rte_images/${n}.jpg` }, { name: "policy", value: "p" }] },
    asset: { asset_id: `asset-${n}`, websocket_url: "wss://ws.example" },
  });
const s3ok = (n: string) => new Response(`<?xml version="1.0"?><PostResponse><Location>https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images%2F${n}.jpg</Location></PostResponse>`, { status: 201 });

describe("reddit connect", () => {
  it("builds the authorize URL with duration=permanent and space-separated scopes", () => {
    const { c } = setup(() => undefined);
    const u = new URL(c.oauthAuthorizeUrl({ state: "st", codeChallenge: "ch", redirectUri: "https://app.example/oauth/reddit/callback" }));
    expect(u.origin + u.pathname).toBe("https://www.reddit.com/api/v1/authorize");
    expect(u.searchParams.get("duration")).toBe("permanent");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("scope")).toBe("identity submit read edit history privatemessages mysubreddits flair vote modposts");
    expect(u.searchParams.get("code_challenge")).toBeNull();
    expect(createRedditConnectors({})[0]!.connectConfigured).toBe(false);
    const env = createRedditConnectors({ REDDIT_CLIENT_ID: "a", REDDIT_CLIENT_SECRET: "b" })[0] as RedditConnector;
    expect([env.name, env.networks, env.connectConfigured, env.userAgent]).toEqual(["reddit", ["reddit"], true, REDDIT_DEFAULT_USER_AGENT]);
  });

  it("exchanges the code with Basic auth and a User-Agent, then connects the user as t2_ / u/name", async () => {
    const { c, calls } = setup((url) => {
      if (url.href === "https://www.reddit.com/api/v1/access_token") return json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "identity submit", token_type: "bearer" });
      if (url.pathname === "/api/v1/me") return json({ id: "abc", name: "acme", total_karma: 1234, subreddit: { title: "Acme Co", subscribers: 56 } });
      return undefined;
    });
    const accounts = await c.oauthConnect({ code: "code", codeVerifier: "v", redirectUri: "https://app.example/oauth/reddit/callback" });
    expect(accounts).toEqual([
      { network: "reddit", identity: { externalId: "t2_abc", handle: "u/acme", displayName: "Acme Co" }, auth: { accessToken: "at", refreshToken: "rt", expiresAt: "2026-11-03T01:00:00.000Z", userId: "t2_abc", username: "acme", scope: "identity submit" } },
    ]);
    const tokenHeaders = calls[0]!.init.headers as Record<string, string>;
    expect(tokenHeaders.authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(tokenHeaders["user-agent"]).toBe(UA);
    const meHeaders = calls[1]!.init.headers as Record<string, string>;
    expect(meHeaders.authorization).toBe("bearer at");
    expect(meHeaders["user-agent"]).toBe(UA);
    expect(await c.describeAccount({ accessToken: "at" })).toEqual({ externalId: "t2_abc", handle: "u/acme", displayName: "Acme Co" });
  });

  it("refreshes and keeps the non-rotated refresh token", async () => {
    const { c, calls } = setup((url) => (url.pathname === "/api/v1/access_token" ? json({ access_token: "at2", expires_in: 3600 }) : undefined));
    expect((await c.refreshAuth(acct))?.auth).toEqual({ accessToken: "at2", refreshToken: "rt", expiresAt: "2026-11-03T01:00:00.000Z", userId: "t2_abc", username: "acme" });
    expect(new URLSearchParams(String(calls[0]!.init.body)).get("grant_type")).toBe("refresh_token");
    expect(await c.refreshAuth({ ...acct, auth: { accessToken: "a", userId: "t2_abc", username: "acme" } })).toBeNull();
    const dead = setup(() => json({ error: "invalid_grant" }, 400));
    expect((await rejection(dead.c.refreshAuth(acct))).kind).toBe("auth");
  });
});

describe("reddit publish", () => {
  it("submits a self post with flair, spoiler and NSFW, and posts the first comment", async () => {
    const { c, form, calls } = setup((url) => {
      if (url.pathname === "/api/submit") return json({ json: { errors: [], data: { url: "https://www.reddit.com/r/baseair/comments/p1/hello_reddit/", id: "p1", name: "t3_p1" } } });
      if (url.pathname === "/api/comment") return json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "c1", name: "t1_c1", permalink: "/r/baseair/comments/p1/hello_reddit/c1/" } }] } } });
      return undefined;
    });
    const res = await c.publish(acct, input({ options: { subreddit: "baseair", title: "Hello Reddit", flairId: "flair-1", contentWarning: "plot", tags: ["NSFW"], firstComment: "Sources in thread" } }));
    expect(res).toEqual({ externalId: "t3_p1", url: "https://www.reddit.com/r/baseair/comments/p1/hello_reddit/", raw: { kind: "self", subreddit: "baseair" } });
    expect(form("/api/submit")).toEqual({ sr: "baseair", title: "Hello Reddit", api_type: "json", sendreplies: "true", resubmit: "true", nsfw: "true", spoiler: "true", flair_id: "flair-1", kind: "self", text: "Body text" });
    expect(form("/api/comment")).toEqual({ thing_id: "t3_p1", text: "Sources in thread" });
    expect(calls[0]!.url.origin).toBe("https://oauth.reddit.com");
    expect((calls[0]!.init.headers as Record<string, string>)["user-agent"]).toBe(UA);
    // Idempotent on retry.
    await c.publish(acct, input({ options: { subreddit: "baseair", title: "Hello Reddit" } }));
    expect(calls.filter((x) => x.url.pathname === "/api/submit")).toHaveLength(1);
  });

  it("submits link posts and posts the body text as the first comment", async () => {
    const { c, form } = setup((url) => {
      if (url.pathname === "/api/submit") return json({ json: { errors: [], data: { url: "https://www.reddit.com/r/baseair/comments/p2/x/", id: "p2", name: "t3_p2" } } });
      if (url.pathname === "/api/comment") return json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "c2", name: "t1_c2" } }] } } });
      return undefined;
    });
    const res = await c.publish(acct, input({ options: { subreddit: "baseair", title: "Read this", link: "https://acme.example/post" } }));
    expect(res.externalId).toBe("t3_p2");
    expect(form("/api/submit")).toMatchObject({ kind: "link", url: "https://acme.example/post", nsfw: "false", spoiler: "false" });
    expect(form("/api/submit").text).toBeUndefined();
    expect(form("/api/comment")).toEqual({ thing_id: "t3_p2", text: "Body text" });
  });

  it("uploads an image through the media lease, submits kind=image and finds the new post", async () => {
    let listed = 0;
    const { c, form, calls } = setup((url) => {
      if (url.pathname === "/api/media/asset.json") return lease("i1");
      if (url.host === "reddit-uploaded-media.s3-accelerate.amazonaws.com") return s3ok("i1");
      if (url.pathname === "/api/submit") return json({ json: { errors: [], data: { user_submitted_page: "https://www.reddit.com/user/acme/submitted/", websocket_url: "wss://ws.example/x" } } });
      if (url.pathname === "/user/acme/submitted")
        return json(listing(++listed < 2 ? [] : [{ kind: "t3", data: { id: "p3", name: "t3_p3", title: "Hello Reddit", subreddit: "baseair", created_utc: NOW_S, permalink: "/r/baseair/comments/p3/hello_reddit/" } }]));
      if (url.pathname === "/api/comment") return json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "c3", name: "t1_c3" } }] } } });
      return undefined;
    });
    const res = await c.publish(acct, input({ media: [{ kind: "image", url: "https://media.acme.example/photo.jpg", alt: "a photo" }] }));
    expect(res).toMatchObject({ externalId: "t3_p3", url: "https://www.reddit.com/r/baseair/comments/p3/hello_reddit/" });
    expect(form("/api/media/asset.json")).toEqual({ filepath: "photo.jpg", mimetype: "image/jpeg" });
    const s3 = calls.find((x) => x.url.host.startsWith("reddit-uploaded-media"))!;
    expect(s3.init.body).toBeInstanceOf(FormData);
    expect((s3.init.body as FormData).get("key")).toBe("rte_images/i1.jpg");
    expect((s3.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
    expect(form("/api/submit")).toMatchObject({ kind: "image", url: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images/i1.jpg" });
    expect(listed).toBe(2);
  });

  it("resumes finding a processing media post on retry without submitting twice", async () => {
    let ready = false;
    const { c, calls } = setup((url) => {
      if (url.pathname === "/api/media/asset.json") return lease("v1");
      if (url.host.startsWith("reddit-uploaded-media")) return s3ok("v1");
      if (url.pathname === "/api/submit") return json({ json: { errors: [], data: { websocket_url: "wss://ws.example/x" } } });
      if (url.pathname === "/user/acme/submitted") return json(listing(ready ? [{ kind: "t3", data: { id: "p4", name: "t3_p4", title: "Hello Reddit", subreddit: "BaseAir", created_utc: NOW_S } }] : []));
      if (url.pathname === "/api/comment") return json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "c4", name: "t1_c4" } }] } } });
      return undefined;
    }, { maxPolls: 2 });
    const vid = input({ media: [{ kind: "video", url: "https://media.acme.example/clip.mp4" }], options: { subreddit: "baseair", title: "Hello Reddit", thumbnailUrl: "https://media.acme.example/poster.jpg" } });
    const e = await rejection(c.publish(acct, vid));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    const submit = calls.find((x) => x.url.pathname === "/api/submit")!;
    expect(Object.fromEntries(new URLSearchParams(String(submit.init.body)))).toMatchObject({ kind: "video", url: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/rte_images/v1.jpg", video_poster_url: expect.stringContaining("reddit-uploaded-media") });
    ready = true;
    const res = await c.publish(acct, vid);
    expect(res).toMatchObject({ externalId: "t3_p4", url: "https://www.reddit.com/r/baseair/comments/p4/" });
    expect(calls.filter((x) => x.url.pathname === "/api/submit")).toHaveLength(1);
    expect(calls.filter((x) => x.url.pathname === "/api/media/asset.json")).toHaveLength(2); // video + poster, once
  });

  it("submits multi-image posts as a gallery", async () => {
    const { c, calls } = setup((url) => {
      if (url.pathname === "/api/media/asset.json") return lease(String(calls.filter((x) => x.url.pathname === "/api/media/asset.json").length));
      if (url.host.startsWith("reddit-uploaded-media")) return s3ok("g");
      if (url.pathname === "/api/submit_gallery_post.json") return json({ json: { errors: [], data: { url: "https://www.reddit.com/gallery/p5" } } });
      if (url.pathname === "/api/comment") return json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "c5", name: "t1_c5" } }] } } });
      return undefined;
    });
    const res = await c.publish(acct, input({ media: [{ kind: "image", url: "https://m.example/a.jpg", alt: "A" }, { kind: "image", url: "https://m.example/b.jpg" }], options: { subreddit: "baseair", title: "Gallery", kind: "carousel" } }));
    expect(res).toMatchObject({ externalId: "t3_p5", url: "https://www.reddit.com/gallery/p5" });
    const g = calls.find((x) => x.url.pathname === "/api/submit_gallery_post.json")!;
    expect(JSON.parse(String(g.init.body))).toMatchObject({ sr: "baseair", title: "Gallery", items: [{ media_id: "asset-1", caption: "A", outbound_url: "" }, { media_id: "asset-2", caption: "", outbound_url: "" }], api_type: "json" });
  });

  it("maps json.errors: RATELIMIT to rate_limit, others to rejected; HTTP 429 with X-Ratelimit headers", async () => {
    const limited = setup(() => json({ json: { errors: [["RATELIMIT", "Take a break for 5 minutes", "ratelimit"]] } }));
    expect(await rejection(limited.c.publish(acct, input()))).toMatchObject({ kind: "rate_limit", retryable: true });
    const noFlair = setup(() => json({ json: { errors: [["SUBMIT_VALIDATION_FLAIR_REQUIRED", "Your post must contain post flair.", "flair"]] } }));
    const e = await rejection(noFlair.c.publish(acct, input()));
    expect(e).toMatchObject({ kind: "rejected", retryable: false });
    expect(e.message).toMatch(/FLAIR_REQUIRED/);
    const http429 = setup(() => json({ message: "Too Many Requests" }, 429, { "x-ratelimit-reset": "42", "x-ratelimit-remaining": "0", "x-ratelimit-used": "100" }));
    const r = await rejection(http429.c.fetchActivity(acct, null));
    expect(r).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(r.message).toContain("2026-11-03T00:00:42.000Z");
    expect((await rejection(setup(() => json({}, 401)).c.fetchActivity(acct, null))).kind).toBe("auth");
    expect((await rejection(setup(() => json({}, 503)).c.fetchActivity(acct, null))).kind).toBe("network");
    expect((await rejection(setup(() => json({}, 403)).c.publish(acct, input()))).kind).toBe("rejected");
    expect((await rejection(setup(() => json({}, 403)).c.fetchActivity(acct, null))).kind).toBe("auth");
    expect(mapRedditApiErrors([["USER_REQUIRED", "Please log in"]], "x").kind).toBe("auth");
    expect((await rejection(setup(() => {
      throw new TypeError("fetch failed");
    }).c.fetchActivity(acct, null))).kind).toBe("network");
  });

  it("refuses to publish without subreddit or title", async () => {
    const { c, calls } = setup(() => undefined);
    expect((await rejection(c.publish(acct, input({ options: { title: "x" } })))).kind).toBe("rejected");
    expect((await rejection(c.publish(acct, input({ idempotencyKey: "k2", options: { subreddit: "baseair" } })))).kind).toBe("rejected");
    expect(calls).toHaveLength(0);
  });
});

describe("reddit inbox", () => {
  it("maps inbox comments, mentions, replies and DMs plus own posts", async () => {
    const { c } = setup((url) => {
      if (url.pathname === "/message/inbox")
        return json(
          listing([
            { kind: "t1", data: { id: "c1", name: "t1_c1", author: "fan", body: "great post", type: "post_reply", was_comment: true, parent_id: "t3_p1", context: "/r/baseair/comments/p1/x/c1/?context=3", created_utc: NOW_S - 60 } },
            { kind: "t1", data: { id: "c2", name: "t1_c2", author: "pal", body: "hey u/acme", type: "username_mention", was_comment: true, parent_id: "t3_zz", context: "/r/other/comments/zz/y/c2/?context=3", created_utc: NOW_S - 120 } },
            { kind: "t1", data: { id: "c3", name: "t1_c3", author: "op", body: "agreed", type: "comment_reply", was_comment: true, parent_id: "t1_c0", context: "/r/baseair/comments/p1/x/c3/?context=3", created_utc: NOW_S - 180 } },
            { kind: "t4", data: { id: "m1", name: "t4_m1", author: "buyer", subject: "question", body: "price?", parent_id: null, created_utc: NOW_S - 240 } },
            { kind: "t1", data: { id: "old", name: "t1_old", body: "old", type: "post_reply", created_utc: NOW_S - 86400 * 30 } },
          ]),
        );
      if (url.pathname === "/user/acme/submitted") return json(listing([{ kind: "t3", data: { id: "p1", name: "t3_p1", title: "Hello", selftext: "Body", permalink: "/r/baseair/comments/p1/x/", created_utc: NOW_S - 3600 } }]));
      return undefined;
    });
    const items = await c.fetchActivity(acct, new Date(NOW.getTime() - 86400_000));
    expect(items.map((i) => [i.kind, i.externalId, i.parentExternalId, i.authorHandle])).toEqual([
      ["own_post", "t3_p1", null, "acme"],
      ["dm", "t4_m1", null, "buyer"],
      ["reply", "t1_c3", "t1_c0", "op"],
      ["mention", "t1_c2", "t3_zz", "pal"],
      ["comment", "t1_c1", "t3_p1", "fan"],
    ]);
    expect(items.find((i) => i.kind === "comment")!.url).toBe("https://www.reddit.com/r/baseair/comments/p1/x/c1/?context=3");
    expect(items.find((i) => i.kind === "dm")!.text).toBe("question\n\nprice?");
    expect(items.find((i) => i.kind === "own_post")!.text).toBe("Hello\n\nBody");
  });

  it("replies with api/comment, idempotently", async () => {
    const { c, form, calls } = setup((url) => (url.pathname === "/api/comment" ? json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "r1", name: "t1_r1", permalink: "/r/baseair/comments/p1/x/r1/" } }] } } }) : undefined));
    const res = await c.reply(acct, { parentExternalId: "t1_c1", text: "thanks!", idempotencyKey: "r" });
    expect(res).toMatchObject({ externalId: "t1_r1", url: "https://www.reddit.com/r/baseair/comments/p1/x/r1/" });
    expect(form("/api/comment")).toEqual({ thing_id: "t1_c1", text: "thanks!" });
    await c.reply(acct, { parentExternalId: "t1_c1", text: "thanks!", idempotencyKey: "r" });
    expect(calls).toHaveLength(1);
    expect((await rejection(c.reply(acct, { parentExternalId: "c1", text: "x", idempotencyKey: "r2" }))).kind).toBe("rejected");
  });

  it("moderates: delete, vote, and moderator remove/approve", async () => {
    const { c, calls } = setup((url) => (url.pathname === "/api/remove" && calls.filter((x) => x.url.pathname === "/api/remove").length > 1 ? json({}, 403) : json({})));
    await c.moderate(acct, { externalId: "t1_c1", action: "delete" });
    await c.moderate(acct, { externalId: "t1_c1", action: "like" });
    await c.moderate(acct, { externalId: "t1_c1", action: "unlike" });
    await c.moderate(acct, { externalId: "t1_c1", action: "hide" });
    await c.moderate(acct, { externalId: "t1_c1", action: "unhide" });
    expect(calls.map((x) => [x.url.pathname, Object.fromEntries(new URLSearchParams(String(x.init.body)))])).toEqual([
      ["/api/del", { id: "t1_c1" }],
      ["/api/vote", { id: "t1_c1", dir: "1" }],
      ["/api/vote", { id: "t1_c1", dir: "0" }],
      ["/api/remove", { id: "t1_c1", spam: "false" }],
      ["/api/approve", { id: "t1_c1" }],
    ]);
    const e = await rejection(c.moderate(acct, { externalId: "t1_c9", action: "hide" }));
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/moderator/);
  });
});

describe("reddit metrics", () => {
  it("maps score, comments and crossposts from api/info", async () => {
    const { c, calls } = setup((url) =>
      url.pathname === "/api/info"
        ? json(listing([{ kind: "t3", data: { id: "p1", name: "t3_p1", score: 120, ups: 120, num_comments: 14, num_crossposts: 2, upvote_ratio: 0.96, view_count: null } }]))
        : undefined,
    );
    const rows = await c.fetchMetrics(acct, ["p1"]);
    expect(calls[0]!.url.searchParams.get("id")).toBe("t3_p1");
    expect(calls[0]!.url.searchParams.get("raw_json")).toBe("1");
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ likes: 120, replies: 14, reposts: 2, engagements: 134 });
    expect(rows.every((r) => r.entityId === "p1" && r.entityType === "post_variant" && r.source === "reddit")).toBe(true);
  });

  it("reports profile followers when present and total karma as account engagements", async () => {
    const { c } = setup((url) => (url.pathname === "/api/v1/me" ? json({ id: "abc", name: "acme", total_karma: 4321, subreddit: { subscribers: 12 } }) : undefined));
    expect(await c.fetchAccountMetrics(acct)).toEqual([
      { entityType: "social_account", entityId: "acc-rd", metric: "followers_total", value: 12, observedAt: NOW.toISOString(), source: "reddit" },
      { entityType: "social_account", entityId: "acc-rd", metric: "engagements", value: 4321, observedAt: NOW.toISOString(), source: "reddit" },
    ]);
    expect(c.capabilities()).toMatchObject({ reply: true, moderate: true, webhooks: false, accountMetrics: true });
    expect((c as Connector).webhook).toBeUndefined();
  });
});

describe("reddit validate", () => {
  it("requires subreddit and title, a link for link posts, a poster for video, and no mixed media", () => {
    const { c } = setup(() => undefined);
    const msgs = (i: PublishInput) => c.validate(acct, i).map((x) => x.message).join(" | ");
    expect(msgs(input())).toBe("");
    expect(msgs(input({ options: {} }))).toMatch(/subreddit.*title/s);
    expect(msgs(input({ options: { subreddit: "s1", title: "t".repeat(301) } }))).toMatch(/300/);
    expect(msgs(input({ options: { subreddit: "s1", title: "t", kind: "link" } }))).toMatch(/options.link/);
    expect(msgs(input({ media: [{ kind: "video", url: "https://m/v.mp4" }] }))).toMatch(/poster/);
    expect(msgs(input({ media: [{ kind: "video", url: "https://m/v.mp4" }, { kind: "image", url: "https://m/a.jpg" }], options: { subreddit: "s1", title: "t", thumbnailUrl: "https://m/p.jpg" } }))).toMatch(/mix/);
    expect(msgs(input({ options: { subreddit: "s1", title: "t", poll: { options: ["a", "b"], durationMinutes: 60 } } }))).toMatch(/polls/);
    expect(redditPostKind(input({ media: [{ kind: "image", url: "https://m/a.jpg" }, { kind: "image", url: "https://m/b.jpg" }] }))).toBe("gallery");
    expect(redditPostKind(input({ options: { link: "https://a.example" } }))).toBe("link");
  });
});
