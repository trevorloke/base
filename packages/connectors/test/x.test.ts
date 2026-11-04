import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, XConnector, type AccountRef, type PublishInput } from "../src/index.ts";

const NOW = new Date("2026-11-02T00:00:00.000Z");

const acct: AccountRef = {
  id: "x1",
  workspaceId: "w",
  network: "x",
  externalId: "123",
  handle: "acme",
  auth: { accessToken: "tok", refreshToken: "ref", userId: "123" },
  config: {},
};

const input: PublishInput = { variantId: "v1", text: "hello x", media: [], thread: [], idempotencyKey: "k1" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

/** The i-th fetch call as url + parsed init, so assertions read naturally. */
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return { url: String(url), method: init?.method, headers, body: init?.body, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}

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

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = (opts: ConstructorParameters<typeof XConnector>[0] = {}) => new XConnector({ now: () => NOW, ...opts });

describe("x publish", () => {
  it("posts a tweet with the bearer token and maps the result", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { id: "900", text: "hello x" } }, 201));
    const res = await connector().publish(acct, input);

    expect(res).toEqual({ externalId: "900", url: "https://x.com/acme/status/900", raw: { ids: ["900"] } });
    const c = call(0);
    expect(c.url).toBe("https://api.x.com/2/tweets");
    expect(c.method).toBe("POST");
    expect(c.headers.authorization).toBe("Bearer tok");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.json()).toEqual({ text: "hello x" });
  });

  it("uploads images through v2 media upload and attaches the ids", async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u === "https://cdn.example/a.png") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      if (u === "https://api.x.com/2/media/upload") return json({ data: { id: "m1", media_key: "3_m1" } });
      if (u === "https://api.x.com/2/media/metadata") return json({ data: { id: "m1" } });
      if (u === "https://api.x.com/2/tweets") return json({ data: { id: "901" } });
      throw new Error(`unexpected ${u}`);
    });
    const res = await connector().publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png", alt: "A" }] });

    expect(res.externalId).toBe("901");
    const upload = call(1);
    expect(upload.method).toBe("POST");
    expect(upload.headers.authorization).toBe("Bearer tok");
    expect(upload.body).toBeInstanceOf(FormData);
    const form = upload.body as FormData;
    expect(form.get("media_category")).toBe("tweet_image");
    expect(form.get("media")).toBeInstanceOf(Blob);
    expect(call(2).json()).toEqual({ id: "m1", metadata: { alt_text: { text: "A" } } });
    expect(call(3).json()).toEqual({ text: "hello x", media: { media_ids: ["m1"] } });
  });

  it("posts thread segments as a reply chain and replies to a given tweet", async () => {
    let n = 899;
    fetchMock.mockImplementation(async () => json({ data: { id: String(++n) } }));
    const res = await connector().publish(acct, { ...input, thread: ["two", "three"], replyToExternalId: "500" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(call(0).json()).toEqual({ text: "hello x", reply: { in_reply_to_tweet_id: "500" } });
    expect(call(1).json()).toEqual({ text: "two", reply: { in_reply_to_tweet_id: "900" } });
    expect(call(2).json()).toEqual({ text: "three", reply: { in_reply_to_tweet_id: "901" } });
    expect(res).toMatchObject({ externalId: "900", threadExternalIds: ["900", "901", "902"] });
  });

  it("re-publishing the same idempotency key returns the cached result without a second request", async () => {
    fetchMock.mockResolvedValue(json({ data: { id: "900" } }));
    const c = connector();
    const first = await c.publish(acct, input);
    const second = await c.publish(acct, input);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.readsUsed).toBe(0);
  });

  it("resumes a failed thread without re-posting earlier segments", async () => {
    let n = 899;
    fetchMock
      .mockResolvedValueOnce(json({ data: { id: String(++n) } }))
      .mockResolvedValueOnce(json({ title: "Service Unavailable" }, 503))
      .mockImplementation(async () => json({ data: { id: String(++n) } }));
    const c = connector();
    const threaded = { ...input, thread: ["two"], idempotencyKey: "k-thread" };
    await expect(c.publish(acct, threaded)).rejects.toMatchObject({ kind: "network", retryable: true });
    const res = await c.publish(acct, threaded);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.threadExternalIds).toEqual(["900", "901"]);
  });

  it("accepts a single video in validate() but refuses documents and video mixed with images", () => {
    expect(connector().validate(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] })).toEqual([]);
    expect(connector().validate(acct, { ...input, media: [{ kind: "document", url: "https://cdn.example/a.pdf" }] })).toMatchObject([{ code: "unsupported_media" }]);
    const mixed = connector().validate(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4" }, { kind: "image", url: "https://cdn.example/a.png" }] });
    expect(mixed).toMatchObject([{ code: "too_many_media" }]);
    expect(mixed[0]?.message).toMatch(/video/);
  });
});

describe("x error mapping", () => {
  it("maps 429 to a retryable rate limit that names the reset time", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: "Too Many Requests" }, 429, { "x-rate-limit-reset": "1700000000" }));
    const err = await rejection(connector().publish(acct, input));
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(err.message).toContain("x-rate-limit-reset=1700000000");
    expect(err.message).toContain(new Date(1700000000 * 1000).toISOString());
  });

  it("maps 401 to a non-retryable auth error", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: "Unauthorized", detail: "Unauthorized" }, 401));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "auth", retryable: false });
  });

  it("treats 403 as rejected on create but auth on read, 5xx as network and other 4xx as rejected", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "You are not allowed to create a Tweet with duplicate content." }, 403));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "rejected", retryable: false });

    fetchMock.mockResolvedValueOnce(json({ title: "Forbidden" }, 403));
    await expect(connector().fetchActivity(acct, null)).rejects.toMatchObject({ kind: "auth", retryable: false });

    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(connector().publish(acct, { ...input, idempotencyKey: "k2" })).rejects.toMatchObject({ kind: "network", retryable: true });

    fetchMock.mockResolvedValueOnce(json({ errors: [{ message: "text too long" }] }, 400));
    const err = await rejection(connector().publish(acct, { ...input, idempotencyKey: "k3" }));
    expect(err).toMatchObject({ kind: "rejected", retryable: false });
    expect(err.message).toContain("text too long");

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(connector().publish(acct, { ...input, idempotencyKey: "k4" })).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("rejects an account without an access token before calling X", async () => {
    await expect(connector().publish({ ...acct, auth: { userId: "123" } }, input)).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("x refreshAuth", () => {
  it("exchanges the refresh token with Basic auth for a confidential client", async () => {
    fetchMock.mockResolvedValueOnce(json({ token_type: "bearer", access_token: "new-tok", refresh_token: "new-ref", expires_in: 7200, scope: "tweet.read" }));
    const res = await connector({ clientId: "cid", clientSecret: "sec" }).refreshAuth(acct);

    const c = call(0);
    expect(c.url).toBe("https://api.x.com/2/oauth2/token");
    expect(c.headers.authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(c.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(String(c.body)).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(String(c.body)).get("refresh_token")).toBe("ref");
    expect(res).toEqual({ auth: { accessToken: "new-tok", refreshToken: "new-ref", userId: "123", expiresAt: new Date(NOW.getTime() + 7200_000).toISOString() } });
  });

  it("sends client_id in the body for a public client and keeps the old refresh token when none is issued", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "new-tok", expires_in: 7200 }));
    const res = await connector({ clientId: "cid" }).refreshAuth(acct);
    const c = call(0);
    expect(c.headers.authorization).toBeUndefined();
    expect(new URLSearchParams(String(c.body)).get("client_id")).toBe("cid");
    expect(res?.auth).toMatchObject({ accessToken: "new-tok", refreshToken: "ref" });
  });

  it("returns null without a refresh token and throws auth when the grant is rejected", async () => {
    expect(await connector({ clientId: "cid" }).refreshAuth({ ...acct, auth: { accessToken: "tok", userId: "123" } })).toBeNull();
    fetchMock.mockResolvedValueOnce(json({ error: "invalid_grant", error_description: "revoked" }, 400));
    const err = await rejection(connector({ clientId: "cid" }).refreshAuth(acct));
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).toContain("re-authorize");
    await expect(connector().refreshAuth(acct)).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("x fetchActivity", () => {
  it("classifies mentions by referenced tweet type, adds own tweets and counts reads", async () => {
    const since = new Date("2026-11-01T00:00:00.000Z");
    fetchMock.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/2/users/123/mentions") {
        return json({
          data: [
            { id: "1", text: "@acme hi", author_id: "u1", created_at: "2026-11-01T10:00:00.000Z" },
            { id: "2", text: "@acme reply", author_id: "u1", created_at: "2026-11-01T11:00:00.000Z", referenced_tweets: [{ type: "replied_to", id: "900" }] },
            { id: "3", text: "quote", author_id: "u2", created_at: "2026-11-01T12:00:00.000Z", referenced_tweets: [{ type: "quoted", id: "900" }] },
          ],
          includes: { users: [{ id: "u1", username: "bob", name: "Bob" }] },
          meta: { result_count: 3 },
        });
      }
      if (u.pathname === "/2/users/123/tweets") {
        return json({ data: [{ id: "900", text: "own", author_id: "123", created_at: "2026-11-01T09:00:00.000Z" }], includes: { users: [{ id: "123", username: "acme", name: "Acme" }] }, meta: { result_count: 1 } });
      }
      throw new Error(`unexpected ${u}`);
    });
    const c = connector();
    const items = await c.fetchActivity(acct, since);

    expect(items.map((i) => i.kind)).toEqual(["own_post", "mention", "reply", "quote"]);
    expect(items[1]).toMatchObject({ network: "x", externalId: "1", authorHandle: "bob", authorName: "Bob", text: "@acme hi", url: "https://x.com/bob/status/1", parentExternalId: null, occurredAt: "2026-11-01T10:00:00.000Z" });
    expect(items[2]).toMatchObject({ kind: "reply", parentExternalId: "900" });
    // Author missing from the expansion: still linkable through x.com/i/web.
    expect(items[3]).toMatchObject({ kind: "quote", parentExternalId: "900", authorHandle: null, url: "https://x.com/i/web/status/3" });
    expect(items[0]).toMatchObject({ kind: "own_post", externalId: "900", authorHandle: "acme", authorName: "Acme", url: "https://x.com/acme/status/900" });
    expect(c.readsUsed).toBe(4);

    const mentions = new URL(call(0).url);
    expect(mentions.searchParams.get("start_time")).toBe("2026-11-01T00:00:00Z");
    expect(mentions.searchParams.get("tweet.fields")).toBe("created_at,author_id,conversation_id,referenced_tweets");
    expect(mentions.searchParams.get("expansions")).toBe("author_id");
    expect(mentions.searchParams.get("user.fields")).toBe("username,name");
    expect(new URL(call(1).url).searchParams.get("exclude")).toBe("retweets");
  });

  it("follows pagination tokens and stops at maxPages", async () => {
    let page = 0;
    fetchMock.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/tweets")) return json({ meta: { result_count: 0 } });
      page++;
      return json({ data: [{ id: String(page), text: "m", created_at: "2026-11-01T10:00:00.000Z" }], meta: { next_token: `t${page}` } });
    });
    const c = connector({ maxPages: 2 });
    const items = await c.fetchActivity(acct, null);
    expect(items).toHaveLength(2);
    expect(new URL(call(1).url).searchParams.get("pagination_token")).toBe("t1");
    expect(c.readsUsed).toBe(2);
  });
});

describe("x fetchMetrics", () => {
  const publicMetrics = { impression_count: 100, like_count: 5, reply_count: 2, retweet_count: 3, quote_count: 1, bookmark_count: 4 };

  it("maps public and non-public metrics to canonical names and counts reads", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: "900", public_metrics: publicMetrics, non_public_metrics: { impression_count: 100, url_link_clicks: 7, user_profile_clicks: 6 } }] }));
    const c = connector();
    const rows = await c.fetchMetrics(acct, ["900"]);

    const url = new URL(call(0).url);
    expect(url.pathname).toBe("/2/tweets");
    expect(url.searchParams.get("ids")).toBe("900");
    expect(url.searchParams.get("tweet.fields")).toBe("public_metrics,non_public_metrics");

    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ impressions: 100, likes: 5, replies: 2, reposts: 3, quotes: 1, saves: 4, link_clicks: 7, profile_visits: 6, engagements: 11 });
    expect(rows[0]).toMatchObject({ entityType: "post_variant", entityId: "900", source: "x", observedAt: NOW.toISOString() });
    expect(c.readsUsed).toBe(1);
  });

  it("falls back to public metrics when non-public ones are forbidden", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ title: "Forbidden", detail: "not authorized for non_public_metrics" }, 403))
      .mockResolvedValueOnce(json({ data: [{ id: "900", public_metrics: publicMetrics }, { id: "901", public_metrics: publicMetrics }] }));
    const c = connector();
    const rows = await c.fetchMetrics(acct, ["900", "901"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(call(1).url).searchParams.get("tweet.fields")).toBe("public_metrics");
    expect(rows.filter((r) => r.entityId === "900").map((r) => r.metric).sort()).toEqual(["engagements", "impressions", "likes", "quotes", "replies", "reposts", "saves"]);
    expect(c.readsUsed).toBe(2);
  });

  it("chunks ids by 100 and skips the request for an empty list", async () => {
    fetchMock.mockImplementation(async (url) => {
      const ids = new URL(String(url)).searchParams.get("ids")?.split(",") ?? [];
      return json({ data: ids.map((id) => ({ id, public_metrics: publicMetrics })) });
    });
    const c = connector();
    const ids = Array.from({ length: 150 }, (_, i) => String(i));
    const rows = await c.fetchMetrics(acct, ids);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(150 * 7);
    expect(c.readsUsed).toBe(150);
    expect(await c.fetchMetrics(acct, [])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("x oauth", () => {
  it("builds a PKCE authorize URL with the needed scopes, exchanges the code and reads who it is", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/2/oauth2/token")) return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 7200 }), { status: 200 });
      if (url.endsWith("/2/users/me")) return new Response(JSON.stringify({ data: { id: "42", username: "acmeoutdoor", name: "Acme" } }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const c = new XConnector({ clientId: "cid", fetch: fetchImpl, now: () => new Date("2026-11-02T00:00:00Z") });
    expect(c.connectConfigured).toBe(true);
    expect(new XConnector().connectConfigured).toBe(false);
    const url = new URL(c.oauthAuthorizeUrl({ state: "s1", codeChallenge: "ch", redirectUri: "https://app.example/oauth/x/callback" }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("tweet.read tweet.write users.read media.write like.write tweet.moderate.write offline.access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const auth = await c.oauthExchange({ code: "code1", codeVerifier: "ver", redirectUri: "https://app.example/oauth/x/callback" });
    expect(auth).toEqual({ accessToken: "at", refreshToken: "rt", userId: "42", expiresAt: "2026-11-02T02:00:00.000Z" });
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(form.get("code_verifier")).toBe("ver");
    expect(form.get("client_id")).toBe("cid");
    expect(await c.describeAccount({ accessToken: "at" })).toEqual({ externalId: "42", handle: "acmeoutdoor", displayName: "Acme" });
  });
});

describe("x video, gif and polls", () => {
  it("uploads video in chunks, polls STATUS until processing succeeds and attaches the id", async () => {
    const bytes = new Uint8Array(10).fill(7);
    let statusChecks = 0;
    fetchMock.mockImplementation(async (url, init) => {
      const u = new URL(String(url));
      if (u.href === "https://cdn.example/v.mp4") return new Response(bytes, { headers: { "content-type": "video/mp4" } });
      if (u.pathname === "/2/media/upload/initialize") return json({ data: { id: "vid1", media_key: "7_vid1", expires_after_secs: 86400 } });
      if (u.pathname === "/2/media/upload/vid1/append") return new Response(null, { status: 204 });
      if (u.pathname === "/2/media/upload/vid1/finalize") return json({ data: { id: "vid1", processing_info: { state: "pending", check_after_secs: 1 } } });
      if (u.pathname === "/2/media/upload" && init?.method === "GET") {
        statusChecks++;
        return json({ data: { id: "vid1", processing_info: statusChecks < 2 ? { state: "in_progress", check_after_secs: 3, progress_percent: 40 } : { state: "succeeded", progress_percent: 100 } } });
      }
      if (u.pathname === "/2/tweets") return json({ data: { id: "950" } });
      throw new Error(`unexpected ${u}`);
    });
    const sleeps: number[] = [];
    const c = connector({ chunkBytes: 4, sleep: async (ms) => void sleeps.push(ms) });
    const res = await c.publish(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] });

    expect(res.externalId).toBe("950");
    expect(call(1).json()).toEqual({ media_type: "video/mp4", total_bytes: 10, media_category: "tweet_video" });
    const appends = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/append"));
    expect(appends.map(([, i]) => (i?.body as FormData).get("segment_index"))).toEqual(["0", "1", "2"]);
    expect(call(5).url).toBe("https://api.x.com/2/media/upload/vid1/finalize");
    expect(new URL(call(6).url).searchParams.get("command")).toBe("STATUS");
    expect(new URL(call(6).url).searchParams.get("media_id")).toBe("vid1");
    expect(sleeps).toEqual([3000]);
    expect(call(8).json()).toEqual({ text: "hello x", media: { media_ids: ["vid1"] } });
  });

  it("returns a retryable error while processing runs and resumes from STATUS without re-uploading", async () => {
    let ready = false;
    fetchMock.mockImplementation(async (url, init) => {
      const u = new URL(String(url));
      if (u.href === "https://cdn.example/a.gif") return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/gif" } });
      if (u.pathname === "/2/media/upload/initialize") return json({ data: { id: "g1" } });
      if (u.pathname.endsWith("/append") || u.pathname.endsWith("/finalize")) return json({ data: { id: "g1" } });
      if (u.pathname === "/2/media/upload" && init?.method === "GET") return json({ data: { processing_info: ready ? { state: "succeeded" } : { state: "in_progress", check_after_secs: 1 } } });
      if (u.pathname === "/2/tweets") return json({ data: { id: "951" } });
      throw new Error(`unexpected ${u}`);
    });
    const c = connector({ maxProcessingChecks: 2, sleep: async () => {} });
    const gif = { ...input, idempotencyKey: "k-gif", media: [{ kind: "gif" as const, url: "https://cdn.example/a.gif" }] };
    const err = await rejection(c.publish(acct, gif));
    expect(err).toMatchObject({ retryable: true });
    expect(err.message).toMatch(/still processing/);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ media_category: "tweet_gif" });
    ready = true;
    const before = fetchMock.mock.calls.length;
    expect((await c.publish(acct, gif)).externalId).toBe("951");
    const after = fetchMock.mock.calls.slice(before).map(([u]) => new URL(String(u)).pathname);
    expect(after).toEqual(["/2/media/upload", "/2/tweets"]);
  });

  it("fails without retry when X reports processing failed", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      const u = new URL(String(url));
      if (u.href === "https://cdn.example/v.mp4") return new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } });
      if (u.pathname === "/2/media/upload" && init?.method === "GET") return json({ data: { processing_info: { state: "failed", error: { message: "InvalidMedia" } } } });
      return json({ data: { id: "v9" } });
    });
    await expect(connector({ sleep: async () => {} }).publish(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] })).rejects.toMatchObject({ kind: "rejected", retryable: false });
  });

  it("posts a poll on the root tweet and validates X's poll limits", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { id: "960" } }));
    await connector().publish(acct, { ...input, options: { poll: { options: ["Yes", "No"], durationMinutes: 1440 } } });
    expect(call(0).json()).toEqual({ text: "hello x", poll: { options: ["Yes", "No"], duration_minutes: 1440 } });
    const issues = connector().validate(acct, { ...input, options: { poll: { options: ["a", "b", "c", "d", "e"], durationMinutes: 60 } } });
    expect(issues).toMatchObject([{ code: "too_many_media" }]);
    expect(connector().validate(acct, { ...input, options: { poll: { options: ["a".repeat(26), "b"], durationMinutes: 60 } } })).toMatchObject([{ code: "too_long" }]);
  });
});

describe("x reply, moderate and account metrics", () => {
  it("replies to a tweet once per idempotency key", async () => {
    fetchMock.mockResolvedValue(json({ data: { id: "970" } }));
    const c = connector();
    const r = await c.reply(acct, { parentExternalId: "500", text: "thanks!", idempotencyKey: "r1" });
    await c.reply(acct, { parentExternalId: "500", text: "thanks!", idempotencyKey: "r1" });
    expect(r).toMatchObject({ externalId: "970", url: "https://x.com/acme/status/970" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).json()).toEqual({ text: "thanks!", reply: { in_reply_to_tweet_id: "500" } });
  });

  it("likes, unlikes, hides, unhides and deletes through the right endpoints", async () => {
    fetchMock.mockImplementation(async () => json({ data: {} }));
    const c = connector();
    for (const action of ["like", "unlike", "hide", "unhide", "delete"] as const) await c.moderate(acct, { externalId: "777", action });
    const calls = fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${new URL(String(u)).pathname} ${i?.body ?? ""}`);
    expect(calls).toEqual([
      'POST /2/users/123/likes {"tweet_id":"777"}',
      "DELETE /2/users/123/likes/777 ",
      'PUT /2/tweets/777/hidden {"hidden":true}',
      'PUT /2/tweets/777/hidden {"hidden":false}',
      "DELETE /2/tweets/777 ",
    ]);
  });

  it("maps a refused hide (not our conversation) to rejected", async () => {
    fetchMock.mockResolvedValueOnce(json({ title: "Forbidden", detail: "You cannot hide this reply" }, 403));
    await expect(connector().moderate(acct, { externalId: "1", action: "hide" })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("reads followers_total from users/me public_metrics", async () => {
    fetchMock.mockResolvedValueOnce(json({ data: { id: "123", username: "acme", public_metrics: { followers_count: 4321, following_count: 10 } } }));
    const c = connector();
    const rows = await c.fetchAccountMetrics(acct);
    expect(new URL(call(0).url).searchParams.get("user.fields")).toBe("public_metrics");
    expect(rows).toEqual([{ entityType: "social_account", entityId: "x1", metric: "followers_total", value: 4321, observedAt: NOW.toISOString(), source: "x" }]);
    expect(c.capabilities()).toMatchObject({ reply: true, moderate: true, accountMetrics: true, video: true });
  });

  it("reads media bytes through the core media fetcher when one is set", async () => {
    fetchMock.mockImplementation(async (url) => (String(url).endsWith("/2/media/upload") ? json({ data: { id: "m5" } }) : json({ data: { id: "980" } })));
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([9, 9]), mime: "image/png" }) };
    await c.publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/x.png", assetId: "asset1" }] });
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual(["https://api.x.com/2/media/upload", "https://api.x.com/2/tweets"]);
  });
});
