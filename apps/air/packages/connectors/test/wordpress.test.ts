import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { WordPressConnector, createWordPressConnectors, wordpressCommentId, wordpressStatus } from "../src/wordpress.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const PASSWORD = "abcdEFGHijklMNOPqrstUVWX";
const BASIC = `Basic ${Buffer.from(`editor:${PASSWORD}`).toString("base64")}`;
const acct: AccountRef = {
  id: "a1",
  workspaceId: "w",
  network: "wordpress",
  externalId: "blog.example.com",
  handle: "blog.example.com",
  auth: { siteUrl: "https://blog.example.com", username: "editor", applicationPassword: PASSWORD, restMode: "pretty" },
  config: { siteUrl: "https://blog.example.com", userId: 7 },
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };
let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function route(handler: (c: Call) => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (input, init) => {
    const c: Call = { method: init?.method ?? "GET", url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body };
    calls.push(c);
    return handler(c);
  });
}
const bodyJson = (c: Call | undefined) => JSON.parse(String(c?.body)) as Record<string, unknown>;
beforeEach(() => {
  calls = [];
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const connector = () => {
  const c = new WordPressConnector({ now: () => NOW });
  c.media = { fetch: async (m) => ({ bytes: new Uint8Array([1, 2, 3]), mime: m.kind === "video" ? "video/mp4" : "image/jpeg" }) };
  return c;
};

describe("wordpress connect", () => {
  it("verifies the Application Password with users/me?context=edit and returns the site", async () => {
    route((c) => {
      if (c.url.pathname === "/wp-json/wp/v2/users/me") return json({ id: 7, name: "Ed Itor", roles: ["editor"], capabilities: { publish_posts: true } });
      if (c.url.pathname === "/wp-json/") return json({ name: "Acme &amp; Co Blog", home: "https://blog.example.com/" });
      return json({}, 404);
    });
    const accounts = await connector().connectWithInputs({ network: "wordpress", inputs: { siteUrl: "blog.example.com/", username: " editor ", applicationPassword: "abcd EFGH ijkl MNOP qrst UVWX" } });
    expect(calls[0]?.url.toString()).toBe("https://blog.example.com/wp-json/wp/v2/users/me?context=edit");
    expect(calls[0]?.headers.authorization).toBe(BASIC);
    expect(accounts).toEqual([
      {
        network: "wordpress",
        identity: { externalId: "blog.example.com", handle: "blog.example.com", displayName: "Acme & Co Blog" },
        auth: { siteUrl: "https://blog.example.com", username: "editor", applicationPassword: PASSWORD, restMode: "pretty" },
        config: { siteUrl: "https://blog.example.com", userId: 7, userName: "Ed Itor", siteName: "Acme & Co Blog", roles: ["editor"] },
      },
    ]);
  });

  it("falls back to ?rest_route= when /wp-json is not routed", async () => {
    route((c) => {
      if (c.url.pathname.startsWith("/wp-json")) return new Response("<html>Not found</html>", { status: 404 });
      const r = c.url.searchParams.get("rest_route");
      if (r === "/wp/v2/users/me") return json({ id: 7, name: "Ed" });
      if (r === "/") return json({ name: "Plain" });
      return json({}, 404);
    });
    const [a] = await connector().connectWithInputs({ network: "wordpress", inputs: { siteUrl: "https://example.org/blog", username: "editor", applicationPassword: PASSWORD } });
    expect(a?.auth.restMode).toBe("plain");
    expect(a?.identity.externalId).toBe("example.org/blog");
    expect(calls[1]?.url.toString()).toBe("https://example.org/blog/?rest_route=%2Fwp%2Fv2%2Fusers%2Fme&context=edit");
  });

  it("maps bad credentials to auth without leaking the password, and refuses http and contributors", async () => {
    route(() => json({ code: "incorrect_password", message: "The provided password is an invalid application password.", data: { status: 401 } }, 401));
    const err = (await connector().connectWithInputs({ network: "wordpress", inputs: { siteUrl: "https://blog.example.com", username: "editor", applicationPassword: PASSWORD } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).toContain("incorrect_password");
    expect(err.message).not.toContain(PASSWORD);
    await expect(connector().connectWithInputs({ network: "wordpress", inputs: { siteUrl: "http://blog.example.com", username: "e", applicationPassword: "x" } })).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/HTTPS/) });
    route(() => json({ id: 9, name: "Con", roles: ["contributor"], capabilities: { publish_posts: false } }));
    await expect(connector().connectWithInputs({ network: "wordpress", inputs: { siteUrl: "https://blog.example.com", username: "c", applicationPassword: "x" } })).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/cannot publish/) });
  });

  it("declares inputs, capabilities and its factory", () => {
    const [c] = createWordPressConnectors({});
    expect(c?.name).toBe("wordpress");
    expect(c?.connectMethod).toBe("app_password");
    expect(c?.credentialInputs?.find((i) => i.key === "applicationPassword")?.secret).toBe(true);
    expect(c?.capabilities("wordpress")).toMatchObject({ publish: true, fetchActivity: true, fetchMetrics: false, reply: true, moderate: true });
  });
});

describe("wordpress publish", () => {
  const input: PublishInput = {
    variantId: "v1",
    text: "Hello <world> & friends\n\nSecond para with https://example.com/x",
    media: [
      { kind: "image", url: "https://cdn.air.test/a/cover.jpg", alt: 'Cover "art"' },
      { kind: "image", url: "https://cdn.air.test/a/second" },
    ],
    thread: [],
    idempotencyKey: "k1",
    options: { title: "Launch day", tags: ["News", "#launch", "news", "Existing"] },
  };

  it("uploads media, resolves tags, creates the post with escaped HTML and a featured image", async () => {
    let mediaId = 100;
    route((c) => {
      const p = c.url.pathname;
      if (p === "/wp-json/wp/v2/media") return json({ id: ++mediaId, source_url: `https://blog.example.com/wp-content/uploads/${mediaId}.jpg` }, 201);
      if (p === "/wp-json/wp/v2/tags" && c.method === "GET") {
        const s = c.url.searchParams.get("search");
        if (s === "News") return json([{ id: 5, name: "News &amp; Views" }, { id: 6, name: "news" }]);
        return json([]);
      }
      if (p === "/wp-json/wp/v2/tags" && c.method === "POST") {
        if (bodyJson(c).name === "Existing") return json({ code: "term_exists", message: "exists", data: { status: 400, term_id: 42 } }, 400);
        return json({ id: 77 }, 201);
      }
      if (p === "/wp-json/wp/v2/posts") return json({ id: 555, link: "https://blog.example.com/launch-day/", status: "publish" }, 201);
      return json({}, 404);
    });
    const c = connector();
    const res = await c.publish(acct, input);
    expect(res).toMatchObject({ externalId: "555", url: "https://blog.example.com/launch-day/" });

    const uploads = calls.filter((x) => x.url.pathname === "/wp-json/wp/v2/media");
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.headers["content-disposition"]).toBe('attachment; filename="cover.jpg"');
    expect(uploads[0]?.headers["content-type"]).toBe("image/jpeg");
    expect(uploads[0]?.url.searchParams.get("alt_text")).toBe('Cover "art"');
    expect(uploads[1]?.headers["content-disposition"]).toBe('attachment; filename="second.jpg"');
    expect(uploads[0]?.body).toBeInstanceOf(Uint8Array);

    const post = bodyJson(calls.find((x) => x.url.pathname === "/wp-json/wp/v2/posts"));
    expect(post.title).toBe("Launch day");
    expect(post.status).toBe("publish");
    expect(post.featured_media).toBe(101);
    expect(post.tags).toEqual([6, 77, 42]);
    expect(post.excerpt).toBe("Hello <world> & friends");
    expect(post.content).toContain("<p>Hello &lt;world&gt; &amp; friends</p>");
    expect(post.content).toContain('<a href="https://example.com/x">https://example.com/x</a>');
    // The featured image is not repeated inline; the second upload is.
    expect(post.content).not.toContain("101.jpg");
    expect(post.content).toContain('<img src="https://blog.example.com/wp-content/uploads/102.jpg" alt="" class="wp-image-102">');

    // Idempotent: the same key does not post twice.
    const n = calls.length;
    await c.publish(acct, input);
    expect(calls.length).toBe(n);
  });

  it("maps visibility to status, adds the link and a first comment, and uploads a thumbnail as featured image", async () => {
    route((c) => {
      if (c.url.pathname === "/wp-json/wp/v2/posts") return json({ id: 9, link: "https://blog.example.com/?p=9" }, 201);
      if (c.url.pathname === "/wp-json/wp/v2/comments") return json({ id: 1 }, 201);
      if (c.url.pathname === "/wp-json/wp/v2/media") return json({ id: 3, source_url: "https://blog.example.com/t.jpg" }, 201);
      return json({}, 404);
    });
    const c = connector();
    await c.publish(acct, { variantId: "v", text: "Body", media: [], thread: [], idempotencyKey: "k2", options: { title: "T", link: "https://acme.test/p", firstComment: "First!", thumbnailUrl: "https://cdn.air.test/thumb.png" } });
    const post = bodyJson(calls.find((x) => x.url.pathname === "/wp-json/wp/v2/posts"));
    expect(post).toMatchObject({ status: "publish", featured_media: 3 });
    expect(post.content).toBe('<p>Body</p>\n<p><a href="https://acme.test/p">https://acme.test/p</a></p>');
    expect(post.excerpt).toBeUndefined();
    expect(bodyJson(calls.find((x) => x.url.pathname === "/wp-json/wp/v2/comments"))).toEqual({ post: 9, content: "<p>First!</p>" });

    calls = [];
    await c.publish(acct, { variantId: "v", text: "Body", media: [], thread: [], idempotencyKey: "k3", options: { title: "T", visibility: "private", firstComment: "x" } });
    expect(bodyJson(calls.find((x) => x.url.pathname === "/wp-json/wp/v2/posts")).status).toBe("private");
    expect(calls.some((x) => x.url.pathname === "/wp-json/wp/v2/comments")).toBe(false);
    expect(wordpressStatus({ visibility: "unlisted" })).toBe("draft");
    expect(wordpressStatus({ privacy: "self" })).toBe("private");
    expect(wordpressStatus({})).toBe("publish");
  });

  it("requires a title", async () => {
    const c = connector();
    expect(c.validate(acct, { variantId: "v", text: "x", media: [{ kind: "document", url: "https://x.test/a.pdf" }], thread: [], idempotencyKey: "k" })).toEqual([
      { code: "empty", message: "wordpress posts need a title (options.title)" },
      { code: "unsupported_media", message: "wordpress: attach documents as links in the text" },
    ]);
    await expect(c.publish(acct, { variantId: "v", text: "x", media: [], thread: [], idempotencyKey: "k9" })).rejects.toMatchObject({ kind: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 429 to a retryable rate limit with Retry-After, and 5xx to network", async () => {
    route(() => json({ code: "too_many", message: "slow down" }, 429, { "retry-after": "30" }));
    const err = (await connector().publish(acct, { variantId: "v", text: "x", media: [], thread: [], idempotencyKey: "r1", options: { title: "T" } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(err.message).toContain("retry after 30s");
    route(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(connector().publish(acct, { variantId: "v", text: "x", media: [], thread: [], idempotencyKey: "r2", options: { title: "T" } })).rejects.toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(connector().publish(acct, { variantId: "v", text: "x", media: [], thread: [], idempotencyKey: "r3", options: { title: "T" } })).rejects.toMatchObject({ kind: "network", retryable: true });
  });
});

describe("wordpress comments", () => {
  const comment = (id: number, extra: Record<string, unknown> = {}) => ({ id, post: 555, parent: 0, author: 0, author_name: "Reader", author_url: "https://reader.test", date_gmt: "2026-11-06T10:00:00", content: { rendered: "<p>Nice &amp; clear</p>\n" }, link: `https://blog.example.com/launch-day/#comment-${id}`, status: "approved", ...extra });

  it("reads approved and held comments since a date, skipping our own", async () => {
    route((c) => {
      if (c.url.pathname !== "/wp-json/wp/v2/comments") return json({}, 404);
      if (c.url.searchParams.get("status") === "approve") return json([comment(1), comment(2, { author: 7 })]);
      return json([comment(3, { date_gmt: "2026-11-06T09:00:00", status: "hold" })]);
    });
    const items = await connector().fetchActivity(acct, new Date("2026-11-05T00:00:00Z"));
    expect(calls[0]?.url.searchParams.get("after")).toBe("2026-11-05T00:00:00Z");
    expect(calls[0]?.url.searchParams.get("per_page")).toBe("100");
    expect(calls[1]?.url.searchParams.get("status")).toBe("hold");
    expect(items.map((i) => i.externalId)).toEqual(["blog.example.com#comment-3", "blog.example.com#comment-1"]);
    expect(items[1]).toMatchObject({ network: "wordpress", kind: "comment", authorName: "Reader", authorHandle: "https://reader.test/", text: "Nice & clear", parentExternalId: "555", occurredAt: "2026-11-06T10:00:00.000Z", url: "https://blog.example.com/launch-day/#comment-1" });
    expect(items[1]?.raw).toBeDefined();
  });

  it("skips held comments when the user may not moderate", async () => {
    route((c) => (c.url.searchParams.get("status") === "approve" ? json([comment(1)]) : json({ code: "rest_forbidden_param", message: "no" }, 403)));
    expect(await connector().fetchActivity(acct, null)).toHaveLength(1);
  });

  it("replies under a comment or on a post", async () => {
    route((c) => {
      if (c.method === "GET" && c.url.pathname === "/wp-json/wp/v2/comments/12") return json(comment(12));
      if (c.method === "POST" && c.url.pathname === "/wp-json/wp/v2/comments") return json({ id: 99, post: 555, link: "https://blog.example.com/launch-day/#comment-99" }, 201);
      return json({}, 404);
    });
    const c = connector();
    const r = await c.reply(acct, { parentExternalId: "blog.example.com#comment-12", text: "Thanks <3", idempotencyKey: "rp1" });
    expect(r).toEqual({ externalId: "blog.example.com#comment-99", url: "https://blog.example.com/launch-day/#comment-99", raw: expect.anything() });
    expect(bodyJson(calls[1])).toEqual({ post: 555, parent: 12, content: "<p>Thanks &lt;3</p>" });
    calls = [];
    await c.reply(acct, { parentExternalId: "555", text: "On the post", idempotencyKey: "rp2" });
    expect(calls).toHaveLength(1);
    expect(bodyJson(calls[0])).toEqual({ post: 555, parent: 0, content: "<p>On the post</p>" });
    await expect(c.reply(acct, { parentExternalId: "nope", text: "x", idempotencyKey: "rp3" })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("moderates: hide → hold, unhide → approve, delete → trash, like refused", async () => {
    route(() => json({ id: 12 }));
    const c = connector();
    await c.moderate(acct, { externalId: "blog.example.com#comment-12", action: "hide" });
    await c.moderate(acct, { externalId: "comment-12", action: "unhide" });
    await c.moderate(acct, { externalId: "12", action: "delete" });
    expect(calls.map((x) => [x.method, x.url.pathname])).toEqual([
      ["POST", "/wp-json/wp/v2/comments/12"],
      ["POST", "/wp-json/wp/v2/comments/12"],
      ["DELETE", "/wp-json/wp/v2/comments/12"],
    ]);
    expect(bodyJson(calls[0])).toEqual({ status: "hold" });
    expect(bodyJson(calls[1])).toEqual({ status: "approve" });
    expect(calls[2]?.url.searchParams.get("force")).toBeNull();
    await expect(c.moderate(acct, { externalId: "12", action: "like" })).rejects.toMatchObject({ kind: "rejected" });
    expect(wordpressCommentId("x.com/blog#comment-4")).toBe(4);
    expect(wordpressCommentId("abc")).toBeNull();
  });

  it("has no metrics through core REST", async () => {
    expect(await connector().fetchMetrics()).toEqual([]);
  });
});
