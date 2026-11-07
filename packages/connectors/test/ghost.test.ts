import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { GhostConnector, createGhostConnectors, ghostToken, ghostVisibility } from "../src/ghost.ts";
import { escapeHtml, firstLine, firstParagraph, htmlToText, inlineHtml, plainText, textToHtml, uploadFileName } from "../src/html.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const KEY_ID = "6489a1b2c3d4e5f6a7b8c9d0";
const KEY_SECRET = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
const KEY = `${KEY_ID}:${KEY_SECRET}`;
const acct = (config: Record<string, unknown> = {}): AccountRef => ({
  id: "g1",
  workspaceId: "w",
  network: "ghost",
  externalId: "blog.example.com",
  handle: "blog.example.com",
  auth: { apiUrl: "https://blog.example.com", adminApiKey: KEY },
  config: { siteUrl: "https://blog.example.com", newsletter: null, ...config },
});
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
  const c = new GhostConnector({ now: () => NOW });
  c.media = { fetch: async () => ({ bytes: new Uint8Array([9, 9]), mime: "image/png" }) };
  return c;
};
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

describe("ghost admin token", () => {
  it("is an HS256 JWT with kid, aud /admin/ and a 5-minute expiry, signed with the hex-decoded secret", () => {
    const token = ghostToken(KEY, NOW);
    const [h, p, s] = token.split(".");
    expect(decode(h ?? "")).toEqual({ alg: "HS256", typ: "JWT", kid: KEY_ID });
    const payload = decode(p ?? "");
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(payload).toEqual({ iat, exp: iat + 300, aud: "/admin/" });
    expect(s).toBe(createHmac("sha256", Buffer.from(KEY_SECRET, "hex")).update(`${h}.${p}`).digest("base64url"));
    // Signing with the secret as a UTF-8 string (a common mistake) gives a different signature.
    expect(s).not.toBe(createHmac("sha256", KEY_SECRET).update(`${h}.${p}`).digest("base64url"));
  });

  it("sends a fresh token on every request with Accept-Version", async () => {
    let t = NOW.getTime();
    const c = new GhostConnector({ now: () => new Date(t) });
    route(() => json({ meta: { pagination: { total: 1234 } } }));
    await c.fetchAccountMetrics(acct());
    t += 10 * 60 * 1000;
    await c.fetchAccountMetrics(acct());
    const tokens = calls.map((x) => x.headers.authorization?.replace(/^Ghost /, "") ?? "");
    expect(calls[0]?.headers["accept-version"]).toBe("v6.0");
    expect(decode(tokens[1]?.split(".")[1] ?? "").iat).toBe(decode(tokens[0]?.split(".")[1] ?? "").iat as number + 600);
  });
});

describe("ghost connect", () => {
  it("reads the site, proves the key, checks the newsletter and returns the account", async () => {
    route((c) => {
      const p = c.url.pathname;
      if (p === "/ghost/api/admin/site/") return json({ site: { title: "Acme Journal", url: "https://blog.example.com/" } });
      if (p === "/ghost/api/admin/posts/") return json({ posts: [{ id: "x" }], meta: {} });
      if (p === "/ghost/api/admin/newsletters/") return json({ newsletters: [{ slug: "weekly", status: "active" }] });
      return json({}, 404);
    });
    const accounts = await connector().connectWithInputs({ network: "ghost", inputs: { apiUrl: "https://blog.example.com/ghost/", adminApiKey: ` ${KEY} `, newsletter: "weekly" } });
    expect(calls.map((x) => x.url.pathname)).toEqual(["/ghost/api/admin/site/", "/ghost/api/admin/posts/", "/ghost/api/admin/newsletters/"]);
    expect(calls[2]?.url.searchParams.get("filter")).toBe("slug:weekly");
    expect(calls[1]?.headers.authorization).toMatch(/^Ghost [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(accounts).toEqual([
      {
        network: "ghost",
        identity: { externalId: "blog.example.com", handle: "blog.example.com", displayName: "Acme Journal" },
        auth: { apiUrl: "https://blog.example.com", adminApiKey: KEY },
        config: { siteUrl: "https://blog.example.com", siteTitle: "Acme Journal", newsletter: "weekly" },
      },
    ]);
  });

  it("refuses a malformed key, a rejected key and an unknown newsletter", async () => {
    await expect(connector().connectWithInputs({ network: "ghost", inputs: { apiUrl: "https://b.test", adminApiKey: "content-api-key" } })).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
    route((c) => (c.url.pathname.endsWith("/site/") ? json({ site: { title: "B" } }) : json({ errors: [{ message: "Invalid token", type: "UnauthorizedError" }] }, 401)));
    const err = (await connector().connectWithInputs({ network: "ghost", inputs: { apiUrl: "https://b.test", adminApiKey: KEY } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).toContain("UnauthorizedError: Invalid token");
    expect(err.message).not.toContain(KEY_SECRET);
    route((c) => (c.url.pathname.endsWith("/newsletters/") ? json({ newsletters: [] }) : json({ site: {}, posts: [] })));
    await expect(connector().connectWithInputs({ network: "ghost", inputs: { apiUrl: "https://b.test", adminApiKey: KEY, newsletter: "nope" } })).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/no newsletter/) });
  });

  it("declares inputs (newsletter optional), capabilities and its factory", () => {
    const [c] = createGhostConnectors({});
    expect(c?.name).toBe("ghost");
    expect(c?.credentialInputs?.find((i) => i.key === "newsletter")?.optional).toBe(true);
    expect(c?.credentialInputs?.find((i) => i.key === "adminApiKey")?.secret).toBe(true);
    expect(c?.capabilities("ghost")).toMatchObject({ publish: true, reply: false, accountMetrics: true, video: false });
  });
});

describe("ghost publish", () => {
  const input = (options: PublishInput["options"], media: PublishInput["media"] = []): PublishInput => ({ variantId: "v", text: "Hi <b>there</b>\n\n**Bold** move", media, thread: [], idempotencyKey: `k-${Math.random()}`, options });

  it("uploads images, sets the feature image and tags, and posts HTML with source=html", async () => {
    let n = 0;
    route((c) => {
      if (c.url.pathname === "/ghost/api/admin/images/upload/") return json({ images: [{ url: `https://blog.example.com/content/images/${++n}.png`, ref: "x" }] }, 201);
      if (c.url.pathname === "/ghost/api/admin/posts/") return json({ posts: [{ id: "65aa00000000000000000001", url: "https://blog.example.com/hello/", status: "published" }] }, 201);
      return json({}, 404);
    });
    const res = await connector().publish(acct(), input({ title: "Hello", tags: ["News", "news", "Launch"], visibility: "unlisted" }, [{ kind: "image", url: "https://cdn.test/a/cover.png", alt: "Cover" }, { kind: "image", url: "https://cdn.test/b.png" }]));
    expect(res).toMatchObject({ externalId: "65aa00000000000000000001", url: "https://blog.example.com/hello/" });

    const upload = calls[0];
    expect(upload?.body).toBeInstanceOf(FormData);
    const form = upload?.body as FormData;
    expect((form.get("file") as File).name).toBe("cover.png");
    expect((form.get("file") as File).type).toBe("image/png");
    expect(form.get("purpose")).toBe("image");

    const create = calls.find((x) => x.url.pathname === "/ghost/api/admin/posts/");
    expect(create?.url.searchParams.get("source")).toBe("html");
    expect(create?.url.searchParams.get("newsletter")).toBeNull();
    const post = (bodyJson(create).posts as Record<string, unknown>[])[0];
    expect(post).toMatchObject({ title: "Hello", status: "published", visibility: "members", feature_image: "https://blog.example.com/content/images/1.png", feature_image_alt: "Cover", tags: [{ name: "News" }, { name: "Launch" }] });
    expect(post?.html).toBe('<p>Hi &lt;b&gt;there&lt;/b&gt;</p>\n<p><strong>Bold</strong> move</p>\n<figure><img src="https://blog.example.com/content/images/2.png" alt=""></figure>');
  });

  it("emails posts tagged #newsletter to the configured newsletter (tag stripped), with a paid segment for paid posts", async () => {
    route(() => json({ posts: [{ id: "65aa00000000000000000002", url: "https://blog.example.com/p/" }] }, 201));
    await connector().publish(acct({ newsletter: "weekly" }), input({ title: "T", tags: ["#newsletter", "Tips"], visibility: "private", thumbnailUrl: "https://cdn.test/t.jpg" }));
    expect(calls[0]?.url.searchParams.get("newsletter")).toBe("weekly");
    expect(calls[0]?.url.searchParams.get("email_segment")).toBe("status:-free");
    const post = (bodyJson(calls[0]).posts as Record<string, unknown>[])[0];
    expect(post).toMatchObject({ visibility: "paid", tags: [{ name: "Tips" }], feature_image: "https://cdn.test/t.jpg" });
    calls = [];
    await connector().publish(acct({ newsletter: "weekly", emailEveryPost: true, emailSegment: "status:free" }), input({ title: "T" }));
    expect(calls[0]?.url.searchParams.get("email_segment")).toBe("status:free");
    calls = [];
    await connector().publish(acct({ newsletter: "weekly" }), input({ title: "T" }));
    expect(calls[0]?.url.searchParams.get("newsletter")).toBeNull();
  });

  it("validates title, video and #newsletter without a slug", async () => {
    const c = connector();
    const issues = c.validate(acct(), input({ tags: ["#newsletter"] }, [{ kind: "video", url: "https://cdn.test/v.mp4" }]));
    expect(issues.map((i) => i.code)).toEqual(["empty", "unsupported_media", "empty"]);
    await expect(c.publish(acct(), input({}))).rejects.toMatchObject({ kind: "rejected" });
    await expect(c.publish(acct(), input({ title: "T", tags: ["#newsletter"] }))).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/newsletter slug/) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ghostVisibility({})).toBe("public");
    expect(ghostVisibility({ visibility: "direct" })).toBe("paid");
  });

  it("maps Ghost errors: 422 rejected, 429 rate limit, 503 retryable", async () => {
    route(() => json({ errors: [{ message: "Validation error, cannot save post.", type: "ValidationError", context: "Title is too long" }] }, 422));
    const e1 = (await connector().publish(acct(), input({ title: "T" })).catch((e: unknown) => e)) as ConnectorError;
    expect(e1).toMatchObject({ kind: "rejected", retryable: false });
    expect(e1.message).toContain("ValidationError: Validation error, cannot save post. (Title is too long)");
    route(() => json({ errors: [{ message: "Too many requests", type: "TooManyRequestsError" }] }, 429, { "retry-after": "12" }));
    await expect(connector().publish(acct(), input({ title: "T" }))).rejects.toMatchObject({ kind: "rate_limit", retryable: true, message: expect.stringContaining("retry after 12s") });
    route(() => new Response("down", { status: 503 }));
    await expect(connector().publish(acct(), input({ title: "T" }))).rejects.toMatchObject({ kind: "network", retryable: true });
  });
});

describe("ghost comments and metrics", () => {
  it("maps admin comments to activity and stops asking when the endpoint is missing", async () => {
    route(() =>
      json({
        comments: [{ id: "c0000000000000000000000a", post_id: "65aa00000000000000000001", html: "<p>Great &amp; useful</p>", status: "published", created_at: "2026-11-06T09:00:00.000Z", member: { id: "m1", name: "Pat", email: "pat@example.com" }, post: { id: "65aa00000000000000000001", url: "https://blog.example.com/hello/" } }],
        meta: { pagination: { next: null } },
      }),
    );
    const c = connector();
    const items = await c.fetchActivity(acct(), new Date("2026-11-05T00:00:00Z"));
    expect(calls[0]?.url.pathname).toBe("/ghost/api/admin/comments/");
    expect(calls[0]?.url.searchParams.get("filter")).toBe("created_at:>'2026-11-05T00:00:00Z'");
    expect(items).toEqual([
      { network: "ghost", kind: "comment", externalId: "c0000000000000000000000a", authorHandle: null, authorName: "Pat", text: "Great & useful", url: "https://blog.example.com/hello/", parentExternalId: "65aa00000000000000000001", occurredAt: "2026-11-06T09:00:00.000Z", raw: expect.anything() },
    ]);
    expect(JSON.stringify(items.map(({ raw: _raw, ...rest }) => rest))).not.toContain("pat@example.com");

    route(() => json({ errors: [{ message: "Resource not found", type: "NotFoundError" }] }, 404));
    expect(await c.fetchActivity(acct(), null)).toEqual([]);
    calls = [];
    expect(await c.fetchActivity(acct(), null)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("hides and shows comments, refuses delete", async () => {
    route(() => json({ comments: [{}] }));
    await connector().moderate(acct(), { externalId: "c0000000000000000000000a", action: "hide" });
    expect(calls[0]?.method).toBe("PUT");
    expect(bodyJson(calls[0])).toEqual({ comments: [{ id: "c0000000000000000000000a", status: "hidden" }] });
    await expect(connector().moderate(acct(), { externalId: "c0000000000000000000000a", action: "delete" })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("reads newsletter metrics for emailed posts and members as followers_total", async () => {
    route((c) => {
      if (c.url.pathname.endsWith("/members/")) return json({ members: [{ id: "m" }], meta: { pagination: { total: 4321 } } });
      if (c.url.pathname.endsWith("/p1/")) return json({ posts: [{ id: "p1", email: { email_count: 1000, delivered_count: 990, opened_count: 450 }, count: { clicks: 37 } }] });
      if (c.url.pathname.endsWith("/p2/")) return json({ posts: [{ id: "p2", email: null }] });
      return json({ errors: [{ type: "NotFoundError", message: "Post not found" }] }, 404);
    });
    const metrics = await connector().fetchMetrics(acct(), ["p1", "p2", "gone"]);
    expect(metrics.map((m) => [m.entityId, m.metric, m.value])).toEqual([
      ["p1", "reach", 990],
      ["p1", "impressions", 450],
      ["p1", "link_clicks", 37],
    ]);
    expect(calls[0]?.url.searchParams.get("include")).toBe("email,count.clicks");
    expect(await connector().fetchAccountMetrics(acct())).toEqual([{ entityType: "social_account", entityId: "g1", metric: "followers_total", value: 4321, observedAt: NOW.toISOString(), source: "ghost" }]);
  });
});

describe("text → HTML helper", () => {
  it("escapes everything that is not a supported construct", () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
    expect(textToHtml("<img src=x onerror=alert(1)>")).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(inlineHtml("[click](javascript:alert(1))")).toBe("[click](javascript:alert(1))");
    expect(inlineHtml('[a"b](https://x.test/?q="1")')).toBe('<a href="https://x.test/?q=%221%22">a&quot;b</a>');
    expect(inlineHtml("see https://x.test/a_b_c.")).toBe('see <a href="https://x.test/a_b_c">https://x.test/a_b_c</a>.');
    expect(inlineHtml("keep *|UNSUB|* intact and *this*")).toBe("keep *|UNSUB|* intact and <em>this</em>");
  });

  it("renders paragraphs, line breaks, headings, lists and quotes", () => {
    const html = textToHtml("# Title\nIntro line\nsecond line\n\n- one\n- **two**\n\n1. a\n2. b\n\n> quoted\n\nUse `code` and _em_");
    expect(html).toBe(
      ["<h2>Title</h2>", "<p>Intro line<br>second line</p>", "<ul><li>one</li><li><strong>two</strong></li></ul>", "<ol><li>a</li><li>b</li></ol>", "<blockquote><p>quoted</p></blockquote>", "<p>Use <code>code</code> and <em>em</em></p>"].join("\n"),
    );
    expect(textToHtml("x", { link: "https://l.test/", images: [{ src: "https://i.test/a.png", alt: "<A>" }, { src: "javascript:x" }] })).toBe('<p>x</p>\n<p><a href="https://l.test/">https://l.test/</a></p>\n<figure><img src="https://i.test/a.png" alt="&lt;A&gt;"></figure>');
  });

  it("derives plain text, first line, first paragraph, readable comment text and file names", () => {
    expect(plainText("# **Big** [news](https://x.test)")).toBe("Big news");
    expect(firstLine("\n\n## Subject here\nbody")).toBe("Subject here");
    expect(firstParagraph("word ".repeat(100), 20)).toBe("word word word word…");
    expect(htmlToText("<p>Hi&nbsp;there &#8217;s &#x1F600;</p><p>two</p>")).toBe("Hi there ’s 😀\ntwo");
    expect(uploadFileName("https://cdn.test/a/b/photo.final.JPG?x=1", "image/jpeg")).toBe("photo.final.JPG");
    expect(uploadFileName("https://cdn.test/assets/9f8e", "image/jpeg")).toBe("9f8e.jpg");
    expect(uploadFileName("https://cdn.test/", "image/png", "f")).toBe("f.png");
  });
});
