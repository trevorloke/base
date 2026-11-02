import type { AppBskyFeedDefs, AppBskyNotificationListNotifications, BlobRef } from "@atproto/api";
import { XRPCError } from "@atproto/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlueskyConnector, ConnectorError, mapBlueskyError, type AccountRef, type BlueskyAgentLike, type BlueskyPostRecord, type PublishInput } from "../src/index.ts";

type Notification = AppBskyNotificationListNotifications.Notification;

const DID = "did:plc:acme";
const HANDLE = "acme.bsky.social";
const NOW = new Date("2026-11-02T00:00:00.000Z");
const FAKE_BLOB = { $type: "blob", mimeType: "image/png", size: 3 } as unknown as BlobRef;

const acct: AccountRef = {
  id: "a1",
  workspaceId: "w",
  network: "bluesky",
  externalId: DID,
  handle: HANDLE,
  auth: { identifier: HANDLE, appPassword: "abcd-efgh-ijkl-mnop" },
  config: {},
};

const input: PublishInput = { variantId: "v1", text: "hello world", media: [], thread: [], idempotencyKey: "k1" };

/** A fake agent that never touches the network; every XRPC call is a vi.fn the test can shape. */
function fakeAgent() {
  const state = { session: undefined as { did: string; handle: string } | undefined, posts: 0 };
  return {
    get session() {
      return state.session;
    },
    login: vi.fn(async (_opts: { identifier: string; password: string }) => {
      state.session = { did: DID, handle: HANDLE };
    }),
    resolveHandle: vi.fn(async ({ handle }: { handle: string }) => ({ data: { did: `did:plc:${handle.replace(/\W/g, "")}` } })),
    uploadBlob: vi.fn(async (_data: Uint8Array, _opts?: { encoding?: string }) => ({ data: { blob: FAKE_BLOB } })),
    post: vi.fn(async (_record: BlueskyPostRecord) => {
      state.posts++;
      return { uri: `at://${DID}/app.bsky.feed.post/r${state.posts}`, cid: `c${state.posts}` };
    }),
    getPosts: vi.fn(async (_p: { uris: string[] }) => ({ data: { posts: [] as AppBskyFeedDefs.PostView[] } })),
    getAuthorFeed: vi.fn(async (_p: { actor: string; limit?: number; cursor?: string; filter?: string }) => ({ data: { feed: [] as AppBskyFeedDefs.FeedViewPost[], cursor: undefined as string | undefined } })),
    listNotifications: vi.fn(async (_p: { limit?: number; cursor?: string }) => ({ data: { notifications: [] as Notification[], cursor: undefined as string | undefined } })),
  } satisfies BlueskyAgentLike;
}

function connector(agent: BlueskyAgentLike) {
  return new BlueskyConnector({ agentFactory: () => agent, now: () => NOW });
}

function postView(uri: string, extra: Partial<AppBskyFeedDefs.PostView> = {}): AppBskyFeedDefs.PostView {
  return { uri, cid: `cid-${uri.split("/").pop()}`, author: { did: DID, handle: HANDLE }, record: { text: "own words" }, indexedAt: "2026-11-01T12:00:00.000Z", ...extra };
}

function notification(reason: string, extra: Partial<Notification> = {}): Notification {
  return {
    uri: `at://did:plc:bob/app.bsky.feed.post/${reason}`,
    cid: "c",
    author: { did: "did:plc:bob", handle: "bob.bsky.social", displayName: "Bob" },
    reason,
    record: {},
    isRead: false,
    indexedAt: "2026-11-01T12:00:00.000Z",
    ...extra,
  };
}

afterEach(() => vi.unstubAllGlobals());

/** Await a promise expected to reject and hand back the ConnectorError for closer inspection. */
async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return e as ConnectorError;
  }
  throw new Error("expected the promise to reject");
}

describe("bluesky publish", () => {
  it("logs in with the app password, detects facets and maps the result", async () => {
    const agent = fakeAgent();
    const res = await connector(agent).publish(acct, { ...input, text: "hi @bob.bsky.social read https://example.com/a #news" });

    expect(agent.login).toHaveBeenCalledWith({ identifier: HANDLE, password: "abcd-efgh-ijkl-mnop" });
    expect(res).toMatchObject({ externalId: `at://${DID}/app.bsky.feed.post/r1`, url: `https://bsky.app/profile/${HANDLE}/post/r1` });
    expect(res.threadExternalIds).toBeUndefined();

    const record = agent.post.mock.calls[0]?.[0];
    expect(record?.text).toBe("hi @bob.bsky.social read https://example.com/a #news");
    expect(record?.createdAt).toBe(NOW.toISOString());
    expect(record?.reply).toBeUndefined();
    const features = (record?.facets ?? []).flatMap((f) => f.features);
    expect(features).toEqual(expect.arrayContaining([
      expect.objectContaining({ $type: "app.bsky.richtext.facet#mention", did: "did:plc:bobbskysocial" }),
      expect.objectContaining({ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a" }),
      expect.objectContaining({ $type: "app.bsky.richtext.facet#tag", tag: "news" }),
    ]));
  });

  it("drops a mention whose handle does not resolve instead of posting a broken facet", async () => {
    const agent = fakeAgent();
    agent.resolveHandle.mockRejectedValue(new Error("HandleNotFound"));
    await connector(agent).publish(acct, { ...input, text: "hi @nobody.bsky.social and https://example.com" });
    const features = (agent.post.mock.calls[0]?.[0]?.facets ?? []).flatMap((f) => f.features);
    expect(features.map((f) => f.$type)).toEqual(["app.bsky.richtext.facet#link"]);
  });

  it("downloads images, uploads them as blobs and embeds them on the root post", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const agent = fakeAgent();
    await connector(agent).publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png", alt: "A cat", width: 4, height: 3 }] });

    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example/a.png");
    expect(agent.uploadBlob).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), { encoding: "image/png" });
    expect(agent.post.mock.calls[0]?.[0]?.embed).toEqual({
      $type: "app.bsky.embed.images",
      images: [{ image: FAKE_BLOB, alt: "A cat", aspectRatio: { width: 4, height: 3 } }],
    });
  });

  it("posts thread segments as replies chained to the root", async () => {
    const agent = fakeAgent();
    const res = await connector(agent).publish(acct, { ...input, thread: ["two", "three"] });
    const [r1, r2, r3] = [1, 2, 3].map((n) => ({ uri: `at://${DID}/app.bsky.feed.post/r${n}`, cid: `c${n}` }));
    expect(agent.post).toHaveBeenCalledTimes(3);
    expect(agent.post.mock.calls[1]?.[0]?.reply).toEqual({ root: r1, parent: r1 });
    expect(agent.post.mock.calls[2]?.[0]?.reply).toEqual({ root: r1, parent: r2 });
    expect(res.externalId).toBe(r1?.uri);
    expect(res.threadExternalIds).toEqual([r1?.uri, r2?.uri, r3?.uri]);
  });

  it("replies into an existing thread using the parent's root", async () => {
    const agent = fakeAgent();
    const parentUri = "at://did:plc:bob/app.bsky.feed.post/parent";
    agent.getPosts.mockResolvedValueOnce({
      data: { posts: [postView(parentUri, { cid: "parent-cid", record: { text: "parent", reply: { root: { uri: "at://did:plc:bob/app.bsky.feed.post/root", cid: "root-cid" } } } })] },
    });
    await connector(agent).publish(acct, { ...input, replyToExternalId: parentUri });
    expect(agent.getPosts).toHaveBeenCalledWith({ uris: [parentUri] });
    expect(agent.post.mock.calls[0]?.[0]?.reply).toEqual({
      root: { uri: "at://did:plc:bob/app.bsky.feed.post/root", cid: "root-cid" },
      parent: { uri: parentUri, cid: "parent-cid" },
    });
  });

  it("re-publishing the same idempotency key returns the cached result without posting again", async () => {
    const agent = fakeAgent();
    const c = connector(agent);
    const first = await c.publish(acct, input);
    const second = await c.publish(acct, input);
    expect(second).toBe(first);
    expect(agent.post).toHaveBeenCalledTimes(1);
    expect(agent.login).toHaveBeenCalledTimes(1);
  });

  it("resumes a thread that failed part-way without re-posting the root", async () => {
    const agent = fakeAgent();
    let calls = 0;
    agent.post.mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new XRPCError(502, "UpstreamFailure", "upstream failed");
      return { uri: `at://${DID}/app.bsky.feed.post/r${calls}`, cid: `c${calls}` };
    });
    const c = connector(agent);
    const threaded = { ...input, thread: ["two", "three"], idempotencyKey: "k-thread" };
    await expect(c.publish(acct, threaded)).rejects.toMatchObject({ kind: "network", retryable: true });
    const res = await c.publish(acct, threaded);
    // root, failed segment, retried segment, last segment
    expect(agent.post).toHaveBeenCalledTimes(4);
    expect(res.threadExternalIds).toEqual([`at://${DID}/app.bsky.feed.post/r1`, `at://${DID}/app.bsky.feed.post/r3`, `at://${DID}/app.bsky.feed.post/r4`]);
  });

  it("flags video in validate() because upload is not supported yet", () => {
    const issues = connector(fakeAgent()).validate(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] });
    expect(issues).toMatchObject([{ code: "unsupported_media" }]);
    expect(issues[0]?.message).toMatch(/video/);
    expect(connector(fakeAgent()).validate(acct, input)).toEqual([]);
  });
});

describe("bluesky error mapping", () => {
  it("maps a failed login to a non-retryable auth error and a missing blob the same way", async () => {
    const agent = fakeAgent();
    agent.login.mockRejectedValueOnce(new XRPCError(401, "AuthenticationRequired", "Invalid identifier or password"));
    await expect(connector(agent).publish(acct, input)).rejects.toMatchObject({ name: "ConnectorError", kind: "auth", retryable: false });
    await expect(connector(agent).publish({ ...acct, auth: null }, input)).rejects.toMatchObject({ kind: "auth", retryable: false });
  });

  it("maps 429 to a retryable rate limit carrying the reset header", async () => {
    const agent = fakeAgent();
    agent.post.mockRejectedValueOnce(new XRPCError(429, "RateLimitExceeded", "Rate Limit Exceeded", { "ratelimit-reset": "1700000000" }));
    const err = await rejection(connector(agent).publish(acct, input));
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(err.message).toContain("ratelimit-reset=1700000000");
  });

  it("maps 5xx and no-response to retryable network errors and 400 to rejected", () => {
    expect(mapBlueskyError(new XRPCError(503, "NotEnoughResources", "busy"))).toMatchObject({ kind: "network", retryable: true });
    expect(mapBlueskyError(new XRPCError(1, "Unknown", "fetch failed"))).toMatchObject({ kind: "network", retryable: true });
    expect(mapBlueskyError(new TypeError("fetch failed"))).toMatchObject({ kind: "network", retryable: true });
    expect(mapBlueskyError(new XRPCError(400, "InvalidRequest", "record too long"))).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapBlueskyError(new XRPCError(400, "ExpiredToken", "token expired"))).toMatchObject({ kind: "auth", retryable: false });
    expect(mapBlueskyError(new Error("weird"))).toMatchObject({ kind: "unknown", retryable: false });
  });

  it("drops the cached session after an auth error so the next call logs in again", async () => {
    const agent = fakeAgent();
    const c = connector(agent);
    agent.getPosts.mockRejectedValueOnce(new XRPCError(401, "ExpiredToken", "expired"));
    await expect(c.fetchMetrics(acct, [`at://${DID}/app.bsky.feed.post/r1`])).rejects.toMatchObject({ kind: "auth" });
    await c.fetchMetrics(acct, [`at://${DID}/app.bsky.feed.post/r1`]);
    expect(agent.login).toHaveBeenCalledTimes(2);
  });
});

describe("bluesky fetchActivity", () => {
  it("maps notification reasons and own posts to activity kinds, honoring since", async () => {
    const agent = fakeAgent();
    const since = new Date("2026-11-01T00:00:00Z");
    agent.listNotifications.mockResolvedValueOnce({
      data: {
        cursor: "page2",
        notifications: [
          notification("mention", { record: { text: "hey @acme" } }),
          notification("reply", { reasonSubject: `at://${DID}/app.bsky.feed.post/mine`, record: { text: "nice", reply: { parent: { uri: `at://${DID}/app.bsky.feed.post/mine` } } } }),
          notification("repost", { reasonSubject: `at://${DID}/app.bsky.feed.post/mine` }),
          notification("like-via-repost", { reasonSubject: `at://${DID}/app.bsky.feed.post/mine` }),
          notification("follow"),
          notification("quote", { reasonSubject: `at://${DID}/app.bsky.feed.post/mine`, record: { text: "look" } }),
          notification("verified"),
          // Older than `since`: dropped, and it tells the pager to stop.
          notification("like", { indexedAt: "2026-10-01T00:00:00.000Z" }),
        ],
      },
    });
    agent.getAuthorFeed.mockResolvedValueOnce({
      data: {
        cursor: undefined,
        feed: [
          { post: postView(`at://${DID}/app.bsky.feed.post/mine`, { indexedAt: "2026-11-01T13:00:00.000Z" }) },
          // A repost by the account of someone else's post is not an own post.
          { post: postView("at://did:plc:bob/app.bsky.feed.post/theirs", { author: { did: "did:plc:bob", handle: "bob.bsky.social" } }), reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { did: DID, handle: HANDLE }, indexedAt: "2026-11-01T14:00:00.000Z" } },
        ],
      },
    });

    const items = await connector(agent).fetchActivity(acct, since);
    expect(items.map((i) => i.kind).sort()).toEqual(["follow", "like", "mention", "own_post", "quote", "reply", "repost"]);
    expect(agent.listNotifications).toHaveBeenCalledTimes(1);
    expect(agent.getAuthorFeed).toHaveBeenCalledWith(expect.objectContaining({ actor: DID }));

    const reply = items.find((i) => i.kind === "reply");
    expect(reply).toMatchObject({
      network: "bluesky",
      externalId: "at://did:plc:bob/app.bsky.feed.post/reply",
      authorHandle: "bob.bsky.social",
      authorName: "Bob",
      text: "nice",
      url: "https://bsky.app/profile/bob.bsky.social/post/reply",
      parentExternalId: `at://${DID}/app.bsky.feed.post/mine`,
      occurredAt: "2026-11-01T12:00:00.000Z",
    });
    expect(items.find((i) => i.kind === "like")).toMatchObject({ text: null, url: null, parentExternalId: `at://${DID}/app.bsky.feed.post/mine` });
    expect(items.find((i) => i.kind === "follow")).toMatchObject({ url: "https://bsky.app/profile/bob.bsky.social", parentExternalId: null });
    expect(items.find((i) => i.kind === "own_post")).toMatchObject({ externalId: `at://${DID}/app.bsky.feed.post/mine`, authorHandle: HANDLE, text: "own words", url: `https://bsky.app/profile/${HANDLE}/post/mine` });
    // Chronological, oldest first.
    expect(items.at(-1)?.kind).toBe("own_post");
    expect(items.every((i) => i.raw !== undefined)).toBe(true);
  });

  it("keeps paging notifications while every item is newer than since", async () => {
    const agent = fakeAgent();
    agent.listNotifications
      .mockResolvedValueOnce({ data: { cursor: "c2", notifications: [notification("like", { indexedAt: "2026-11-01T12:00:00.000Z" })] } })
      .mockResolvedValueOnce({ data: { cursor: undefined, notifications: [notification("repost", { indexedAt: "2026-11-01T11:00:00.000Z" })] } });
    const items = await connector(agent).fetchActivity(acct, new Date("2026-11-01T00:00:00Z"));
    expect(agent.listNotifications).toHaveBeenCalledTimes(2);
    expect(agent.listNotifications.mock.calls[1]?.[0]).toEqual({ limit: 100, cursor: "c2" });
    expect(items).toHaveLength(2);
  });
});

describe("bluesky fetchMetrics", () => {
  it("maps counts to canonical metrics and chunks uris by 25", async () => {
    const agent = fakeAgent();
    const uris = Array.from({ length: 30 }, (_, i) => `at://${DID}/app.bsky.feed.post/p${i}`);
    agent.getPosts.mockImplementation(async ({ uris: chunk }) => ({
      data: { posts: chunk.map((u) => postView(u, { likeCount: 3, repostCount: 2, replyCount: 1, quoteCount: 4, bookmarkCount: 5 })) },
    }));
    const rows = await connector(agent).fetchMetrics(acct, uris);

    expect(agent.getPosts).toHaveBeenCalledTimes(2);
    expect(agent.getPosts.mock.calls[0]?.[0]?.uris).toHaveLength(25);
    expect(agent.getPosts.mock.calls[1]?.[0]?.uris).toHaveLength(5);

    const first = rows.filter((r) => r.entityId === uris[0]);
    const byMetric = Object.fromEntries(first.map((r) => [r.metric, r.value]));
    expect(byMetric).toEqual({ likes: 3, reposts: 2, replies: 1, quotes: 4, engagements: 10, saves: 5 });
    expect(first[0]).toMatchObject({ entityType: "post_variant", source: "bluesky", observedAt: NOW.toISOString() });
    expect(rows).toHaveLength(30 * 6);
  });

  it("returns nothing for an empty id list without logging in", async () => {
    const agent = fakeAgent();
    expect(await connector(agent).fetchMetrics(acct, [])).toEqual([]);
    expect(agent.login).not.toHaveBeenCalled();
  });
});
