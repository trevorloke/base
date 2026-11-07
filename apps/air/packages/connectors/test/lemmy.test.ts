import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { LemmyConnector, createLemmyConnectors, lemmyTime, mapLemmyError, normalizeCommunity, parseLemmyId } from "../src/lemmy.ts";

const NOW = new Date("2026-11-06T00:00:00.000Z");
const acct: AccountRef = {
  id: "lm1",
  workspaceId: "w",
  network: "lemmy",
  externalId: "77@lemmy.world",
  handle: "@acme@lemmy.world",
  auth: { host: "lemmy.world", usernameOrEmail: "acme", password: "pw", jwt: "jwt-1", personId: 77 },
  config: { host: "lemmy.world", apiBase: "/api/v3", communities: [{ name: "acme@lemmy.world", id: 5, title: "Acme" }, { name: "technology@lemmy.world", id: 9, title: "Technology" }], personName: "acme" },
};
const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v1", text: "Body **markdown**", media: [], thread: [], idempotencyKey: `k-${Math.random()}`, options: { title: "Launch day" }, ...over });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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

const connector = (opts: ConstructorParameters<typeof LemmyConnector>[0] = {}) => new LemmyConnector({ now: () => NOW, ...opts });
const person = { id: 77, name: "acme", display_name: "Acme", actor_id: "https://lemmy.world/u/acme", local: true };
const site = () => json({ my_user: { local_user_view: { person } } });
const bob = { id: 8, name: "bob", display_name: null, actor_id: "https://beehaw.org/u/bob" };
const community = { id: 5, name: "acme", title: "Acme", actor_id: "https://lemmy.world/c/acme" };

describe("lemmy connect", () => {
  it("logs in, reads the person from /site and resolves communities (local and remote via resolve_object)", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ jwt: "jwt-1", registration_created: false, verify_email_sent: false }))
      .mockResolvedValueOnce(site())
      .mockResolvedValueOnce(json({ community_view: { community } }))
      .mockResolvedValueOnce(json({ error: "couldnt_find_community" }, 404))
      .mockResolvedValueOnce(json({ community: { community: { id: 12, name: "rust", title: "Rust", actor_id: "https://programming.dev/c/rust" } } }));
    const c = connector();
    const accounts = await c.connectWithInputs({ network: "lemmy", inputs: { host: "https://lemmy.world", username: "acme", password: "pw", totp: "123456", communities: "acme, !rust@programming.dev" } });
    expect(call(0).url.href).toBe("https://lemmy.world/api/v3/user/login");
    expect(call(0).json()).toEqual({ username_or_email: "acme", password: "pw", totp_2fa_token: "123456" });
    expect(call(1).url.pathname).toBe("/api/v3/site");
    expect(call(1).headers.authorization).toBe("Bearer jwt-1");
    expect(call(2).url.search).toBe("?name=acme");
    expect(call(3).url.search).toBe("?name=rust%40programming.dev");
    expect(call(4).url.pathname).toBe("/api/v3/resolve_object");
    expect(call(4).url.searchParams.get("q")).toBe("!rust@programming.dev");
    expect(accounts).toEqual([
      {
        network: "lemmy",
        identity: { externalId: "77@lemmy.world", handle: "@acme@lemmy.world", displayName: "Acme" },
        auth: { host: "lemmy.world", usernameOrEmail: "acme", password: "pw", jwt: "jwt-1", personId: 77 },
        config: { host: "lemmy.world", apiBase: "/api/v3", communities: [{ name: "acme@lemmy.world", id: 5, title: "Acme" }, { name: "rust@programming.dev", id: 12, title: "Rust" }], personName: "acme" },
      },
    ]);
    expect(c.connectConfigured).toBe(true);
    expect(c.credentialInputs.find((i) => i.key === "totp")).toMatchObject({ optional: true, secret: true });
  });

  it("maps login failures to auth, including 2FA", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "incorrect_login" }, 400)).mockResolvedValueOnce(json({ error: "missing_totp_token" }, 400)).mockResolvedValueOnce(json({ registration_created: false, verify_email_sent: true }));
    const inputs = { host: "lemmy.world", username: "acme", password: "bad" };
    await expect(connector().connectWithInputs({ network: "lemmy", inputs })).rejects.toMatchObject({ kind: "auth" });
    await expect(connector().connectWithInputs({ network: "lemmy", inputs })).rejects.toThrow(/two-factor/);
    await expect(connector().connectWithInputs({ network: "lemmy", inputs })).rejects.toThrow(/verify the account's email/);
    await expect(connector().connectWithInputs({ network: "lemmy", inputs: { host: "lemmy.world", username: "", password: "" } })).rejects.toMatchObject({ kind: "auth" });
  });

  it("uses a configurable API base", async () => {
    fetchMock.mockResolvedValueOnce(json({ jwt: "j" })).mockResolvedValueOnce(site());
    await connector({ apiBase: "api/v4/" }).connectWithInputs({ network: "lemmy", inputs: { host: "lemmy.world", username: "acme", password: "pw" } });
    expect(call(0).url.pathname).toBe("/api/v4/user/login");
    expect(createLemmyConnectors({ LEMMY_API_BASE: "/api/v4" })[0]?.name).toBe("lemmy");
  });
});

describe("lemmy auth refresh", () => {
  it("refreshAuth logs in again with the stored credentials", async () => {
    fetchMock.mockResolvedValueOnce(json({ jwt: "jwt-2" }));
    const res = await connector().refreshAuth(acct);
    expect(call(0).json()).toEqual({ username_or_email: "acme", password: "pw" });
    expect(res?.auth).toMatchObject({ jwt: "jwt-2", password: "pw", personId: 77 });
  });

  it("re-logs in once on 401 / not_logged_in and retries with the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "not_logged_in" }, 400))
      .mockResolvedValueOnce(json({ jwt: "jwt-3" }))
      .mockResolvedValueOnce(json({ post_view: { post: { id: 1 }, counts: { upvotes: 1, downvotes: 0, comments: 0 } } }))
      .mockResolvedValueOnce(json({ post_view: { post: { id: 2 }, counts: { upvotes: 2, downvotes: 0, comments: 0 } } }));
    const c = connector();
    await c.fetchMetrics(acct, ["post:1@lemmy.world"]);
    expect(call(1).url.pathname).toBe("/api/v3/user/login");
    expect(call(2).headers.authorization).toBe("Bearer jwt-3");
    await c.fetchMetrics(acct, ["2"]);
    expect(call(3).headers.authorization).toBe("Bearer jwt-3");
  });
});

describe("lemmy publish", () => {
  it("creates a text post in the first configured community, with nsfw and a first comment", async () => {
    fetchMock.mockResolvedValueOnce(json({ post_view: { post: { id: 101 } } })).mockResolvedValueOnce(json({ comment_view: { comment: { id: 900 } } }));
    const res = await connector().publish(acct, input({ options: { title: "Launch day", nsfw: true, firstComment: "AMA below" } }));
    expect(call(0).url.href).toBe("https://lemmy.world/api/v3/post");
    expect(call(0).json()).toEqual({ name: "Launch day", community_id: 5, body: "Body **markdown**", nsfw: true });
    expect(call(1).json()).toEqual({ post_id: 101, content: "AMA below" });
    expect(res).toMatchObject({ externalId: "post:101@lemmy.world", url: "https://lemmy.world/post/101", raw: { postId: 101, firstCommentId: "comment:900@lemmy.world" } });
  });

  it("posts a link to a named community", async () => {
    fetchMock.mockResolvedValueOnce(json({ post_view: { post: { id: 102 } } }));
    await connector().publish(acct, input({ options: { title: "Read this", link: "https://acme.example/blog", subreddit: "technology" } }));
    expect(call(0).json()).toEqual({ name: "Read this", community_id: 9, url: "https://acme.example/blog", body: "Body **markdown**" });
  });

  it("uploads an image to pict-rs and uses it as the post URL; falls back to the media URL when uploads are refused", async () => {
    fetchMock.mockResolvedValueOnce(json({ msg: "ok", files: [{ file: "abc.png", delete_token: "d" }] })).mockResolvedValueOnce(json({ post_view: { post: { id: 103 } } }));
    const c = connector();
    c.media = { fetch: vi.fn(async () => ({ bytes: new Uint8Array([1]), mime: "image/png" })) };
    await c.publish(acct, input({ media: [{ kind: "image", url: "https://cdn.example/a.png", alt: "a chart" }] }));
    expect(call(0).url.href).toBe("https://lemmy.world/pictrs/image");
    expect(call(0).headers.authorization).toBe("Bearer jwt-1");
    expect((call(0).body as FormData).get("images[]")).toBeInstanceOf(Blob);
    expect(call(1).json()).toMatchObject({ url: "https://lemmy.world/pictrs/image/abc.png", alt_text: "a chart" });

    fetchMock.mockResolvedValueOnce(json({ error: "image_upload_disabled" }, 400)).mockResolvedValueOnce(json({ post_view: { post: { id: 104 } } }));
    await c.publish(acct, input({ media: [{ kind: "image", url: "https://cdn.example/b.png" }], options: { title: "t", link: "https://acme.example" } }));
    expect(call(3).json()).toMatchObject({ url: "https://acme.example", body: "Body **markdown**\n\n![](https://cdn.example/b.png)" });
  });

  it("keeps the post when the first comment fails, reports partial, and only retries the comment", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ post_view: { post: { id: 105 } } }))
      .mockResolvedValueOnce(json({ error: "rate_limit_error" }, 429))
      .mockResolvedValueOnce(json({ comment_view: { comment: { id: 901 } } }));
    const c = connector();
    const inp = input({ options: { title: "t", firstComment: "first!" }, idempotencyKey: "fc" });
    const err = (await c.publish(acct, inp).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true, partial: { externalId: "post:105@lemmy.world" } });
    const res = await c.publish(acct, inp);
    expect(call(2).url.pathname).toBe("/api/v3/comment");
    expect(res.externalId).toBe("post:105@lemmy.world");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("validates title, threads, media count and community", () => {
    const c = connector();
    expect(c.validate(acct, input({ options: {} }))[0]).toMatchObject({ code: "empty", message: expect.stringMatching(/title/) });
    expect(c.validate(acct, input({ thread: ["x"] }))[0]?.code).toBe("thread_unsupported");
    expect(c.validate(acct, input({ media: [{ kind: "image", url: "https://a/1" }, { kind: "image", url: "https://a/2" }] }))[0]?.code).toBe("too_many_media");
    expect(c.validate({ ...acct, config: { host: "lemmy.world" } }, input())[0]?.message).toMatch(/community/);
    expect(c.validate(acct, input())).toEqual([]);
  });
});

describe("lemmy listen", () => {
  const comment = (id: number, path: string, published = "2026-11-05T10:00:00.000000Z") => ({ id, creator_id: 8, post_id: 101, content: `comment ${id}`, published, path });
  const view = (c: ReturnType<typeof comment>, extra: Record<string, unknown> = {}) => ({ comment: c, creator: bob, post: { id: 101, name: "p", creator_id: 77, community_id: 5, published: c.published }, community, ...extra });

  it("maps mentions, comments on our posts, replies to our comments and community posts", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ mentions: [view(comment(1, "0.1"), { person_mention: { id: 1, published: "2026-11-05T10:00:00Z" } }), view(comment(0, "0.0", "2026-10-01T00:00:00"))] }))
      .mockResolvedValueOnce(json({ replies: [view(comment(2, "0.2")), view(comment(3, "0.50.3"))] }))
      .mockResolvedValueOnce(json({ posts: [{ post: { id: 200, name: "New in Acme", body: "hello", creator_id: 8, community_id: 5, published: "2026-11-05T11:00:00Z" }, creator: bob, community }, { post: { id: 201, name: "Mine", creator_id: 77, community_id: 5, published: "2026-11-05T12:00:00Z" }, creator: person, community }] }))
      .mockResolvedValueOnce(json({ posts: [] }));
    const items = await connector().fetchActivity(acct, new Date("2026-11-01T00:00:00Z"));
    expect(call(0).url.pathname).toBe("/api/v3/user/mention");
    expect(Object.fromEntries(call(0).url.searchParams)).toEqual({ sort: "New", limit: "50", page: "1", unread_only: "false" });
    expect(call(2).url.pathname).toBe("/api/v3/post/list");
    expect(Object.fromEntries(call(2).url.searchParams)).toMatchObject({ community_id: "5", type_: "All", sort: "New" });
    expect(items.map((i) => [i.kind, i.externalId, i.parentExternalId])).toEqual([
      ["mention", "comment:1@lemmy.world", "post:101@lemmy.world"],
      ["comment", "comment:2@lemmy.world", "post:101@lemmy.world"],
      ["reply", "comment:3@lemmy.world", "comment:50@lemmy.world"],
      ["message", "post:200@lemmy.world", null],
      ["own_post", "post:201@lemmy.world", null],
    ]);
    expect(items[0]).toMatchObject({ authorHandle: "@bob@beehaw.org", authorName: null, text: "comment 1", url: "https://lemmy.world/comment/1", conversation: { id: "acme@lemmy.world", name: "Acme", type: "group" } });
    expect(items[3]).toMatchObject({ text: "New in Acme\n\nhello", url: "https://lemmy.world/post/200", conversation: { id: "acme@lemmy.world", name: "Acme", type: "group" } });
  });

  it("helpers: ids, timestamps, communities, errors", () => {
    expect(parseLemmyId("comment:5@lemmy.world")).toEqual({ type: "comment", id: 5, host: "lemmy.world" });
    expect(parseLemmyId("42")).toEqual({ type: "post", id: 42, host: null });
    expect(() => parseLemmyId("x")).toThrow(ConnectorError);
    expect(lemmyTime("2026-11-05T10:00:00.123456")).toBe("2026-11-05T10:00:00.123Z");
    expect(normalizeCommunity("https://lemmy.ml/c/Linux", "lemmy.world")).toBe("linux@lemmy.ml");
    expect(normalizeCommunity("memes", "lemmy.world")).toBe("memes@lemmy.world");
    expect(() => normalizeCommunity("bad name!", "lemmy.world")).toThrow(ConnectorError);
    expect(mapLemmyError(429, { error: "rate_limit_error" }, "x")).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(mapLemmyError(400, { error: "couldnt_find_post" }, "x")).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapLemmyError(503, "down", "x")).toMatchObject({ kind: "network", retryable: true });
    expect(mapLemmyError(403, {}, "x", true).kind).toBe("rejected");
  });
});

describe("lemmy engage and measure", () => {
  it("replies to a post and to a comment (looking up its post)", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ comment_view: { comment: { id: 950 } } }))
      .mockResolvedValueOnce(json({ comment_view: { comment: { id: 3, post_id: 101 } } }))
      .mockResolvedValueOnce(json({ comment_view: { comment: { id: 951 } } }));
    const c = connector();
    const r1 = await c.reply(acct, { parentExternalId: "post:101@lemmy.world", text: "thanks", idempotencyKey: "a" });
    expect(call(0).json()).toEqual({ content: "thanks", post_id: 101 });
    expect(r1).toMatchObject({ externalId: "comment:950@lemmy.world", url: "https://lemmy.world/comment/950" });
    await c.reply(acct, { parentExternalId: "comment:3@lemmy.world", text: "agreed", idempotencyKey: "b" });
    expect(call(1).url.search).toBe("?id=3");
    expect(call(2).json()).toEqual({ content: "agreed", post_id: 101, parent_id: 3 });
  });

  it("votes, clears votes and deletes own posts and comments", async () => {
    fetchMock.mockImplementation(async () => json({}));
    const c = connector();
    await c.moderate(acct, { externalId: "post:101@lemmy.world", action: "like" });
    await c.moderate(acct, { externalId: "comment:3@lemmy.world", action: "unlike" });
    await c.moderate(acct, { externalId: "comment:3@lemmy.world", action: "delete" });
    await c.moderate(acct, { externalId: "post:101", action: "delete" });
    expect([call(0).url.pathname, call(0).json()]).toEqual(["/api/v3/post/like", { post_id: 101, score: 1 }]);
    expect([call(1).url.pathname, call(1).json()]).toEqual(["/api/v3/comment/like", { comment_id: 3, score: 0 }]);
    expect([call(2).url.pathname, call(2).json()]).toEqual(["/api/v3/comment/delete", { comment_id: 3, deleted: true }]);
    expect([call(3).url.pathname, call(3).json()]).toEqual(["/api/v3/post/delete", { post_id: 101, deleted: true }]);
    await expect(c.moderate(acct, { externalId: "post:1", action: "hide" })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("maps post and comment counts, skipping deleted items", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ post_view: { post: { id: 101 }, counts: { score: 8, upvotes: 10, downvotes: 2, comments: 4 } } }))
      .mockResolvedValueOnce(json({ comment_view: { comment: { id: 3 }, counts: { upvotes: 3, downvotes: 0, child_count: 1 } } }))
      .mockResolvedValueOnce(json({ error: "couldnt_find_post" }, 404));
    const rows = await connector().fetchMetrics(acct, ["post:101@lemmy.world", "comment:3@lemmy.world", "post:999@lemmy.world"]);
    expect(rows.map((r) => [r.entityId, r.metric, r.value])).toEqual([
      ["post:101@lemmy.world", "likes", 10],
      ["post:101@lemmy.world", "replies", 4],
      ["post:101@lemmy.world", "engagements", 16],
      ["comment:3@lemmy.world", "likes", 3],
      ["comment:3@lemmy.world", "replies", 1],
      ["comment:3@lemmy.world", "engagements", 4],
    ]);
    expect(call(0).url.href).toBe("https://lemmy.world/api/v3/post?id=101");
    expect(connector().capabilities().accountMetrics).toBe(false);
  });

  it("surfaces transport failures as retryable network errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(connector().publish(acct, input())).rejects.toMatchObject({ kind: "network", retryable: true });
  });
});
