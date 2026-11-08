import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { MastodonConnector, createMastodonConnectors, mastodonHtmlToText, normalizeInstance } from "../src/mastodon.ts";

const NOW = new Date("2026-11-02T00:00:00.000Z");
const acct: AccountRef = {
  id: "m1",
  workspaceId: "w",
  network: "mastodon",
  externalId: "109@mastodon.social",
  handle: "@acme@mastodon.social",
  auth: { accessToken: "tok", instance: "mastodon.social", accountId: "109", clientId: "cid", clientSecret: "sec" },
  config: { instance: "mastodon.social" },
};
const input: PublishInput = { variantId: "v1", text: "hello fediverse", media: [], thread: [], idempotencyKey: "k1" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
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

const connector = (opts: ConstructorParameters<typeof MastodonConnector>[0] = {}) => new MastodonConnector({ now: () => NOW, sleep: async () => {}, ...opts });
const status = (id: string, extra: Record<string, unknown> = {}) => ({ id, created_at: "2026-11-01T12:00:00.000Z", url: `https://mastodon.social/@acme/${id}`, content: "<p>own</p>", account: { id: "109", username: "acme", acct: "acme" }, ...extra });

describe("mastodon connect", () => {
  it("normalizes server input and refuses private hosts", () => {
    expect(normalizeInstance("https://Mastodon.Social/@me")).toBe("mastodon.social");
    expect(normalizeInstance("@me@hachyderm.io")).toBe("hachyderm.io");
    expect(normalizeInstance(" fosstodon.org ")).toBe("fosstodon.org");
    expect(() => normalizeInstance("localhost")).toThrow(ConnectorError);
    expect(() => normalizeInstance("192.168.1.10")).toThrow(/not a public server/);
    expect(() => normalizeInstance("not a host")).toThrow(ConnectorError);
  });

  it("registers an app once per instance and redirect, returns a PKCE authorize URL and the client credentials", async () => {
    fetchMock.mockResolvedValue(json({ id: "1", name: "base air", client_id: "cid-1", client_secret: "sec-1", redirect_uris: ["https://app.example/oauth/mastodon/callback"] }));
    const c = connector();
    const p = { inputs: { instance: "Mastodon.social" }, redirectUri: "https://app.example/oauth/mastodon/callback", state: "st", codeChallenge: "ch" };
    const res = await c.oauthPrepare(p);
    expect(call(0).url.href).toBe("https://mastodon.social/api/v1/apps");
    expect(call(0).json()).toEqual({ client_name: "base air", redirect_uris: "https://app.example/oauth/mastodon/callback", scopes: "read write push" });
    expect(res.config).toEqual({ instance: "mastodon.social", clientId: "cid-1", clientSecret: "sec-1" });
    const url = new URL(res.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://mastodon.social/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "cid-1", redirect_uri: p.redirectUri, scope: "read write push", state: "st", code_challenge: "ch", code_challenge_method: "S256", response_type: "code" });
    await c.oauthPrepare({ ...p, state: "st2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(c.connectConfigured).toBe(true);
    expect(c.oauthInputs[0]).toMatchObject({ key: "instance", label: "Your Mastodon server" });
  });

  it("exchanges the code at the instance with the stored app and reads the account", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "at", token_type: "Bearer", scope: "read write push", created_at: 1 }))
      .mockResolvedValueOnce(json({ id: "109", username: "acme", acct: "acme", display_name: "Acme", url: "https://mastodon.social/@acme", followers_count: 5 }));
    const accounts = await connector().oauthConnect({ code: "code", codeVerifier: "ver", redirectUri: "https://app.example/cb", config: { instance: "mastodon.social", clientId: "cid", clientSecret: "sec" } });
    expect(call(0).url.href).toBe("https://mastodon.social/oauth/token");
    const form = new URLSearchParams(String(call(0).body));
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "code", code_verifier: "ver", client_id: "cid", client_secret: "sec", redirect_uri: "https://app.example/cb" });
    expect(call(1).url.pathname).toBe("/api/v1/accounts/verify_credentials");
    expect(call(1).headers.authorization).toBe("Bearer at");
    expect(accounts).toEqual([
      {
        network: "mastodon",
        identity: { externalId: "109@mastodon.social", handle: "@acme@mastodon.social", displayName: "Acme" },
        auth: { accessToken: "at", instance: "mastodon.social", accountId: "109", clientId: "cid", clientSecret: "sec", scope: "read write push" },
        config: { instance: "mastodon.social", accountUrl: "https://mastodon.social/@acme" },
      },
    ]);
  });

  it("fails connect without the pending app credentials, describes accounts from auth and never refreshes", async () => {
    await expect(connector().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "r", config: { instance: "mastodon.social" } })).rejects.toMatchObject({ kind: "auth" });
    fetchMock.mockResolvedValueOnce(json({ id: "109", username: "acme", acct: "acme" }));
    expect(await connector().describeAccount({ instance: "mastodon.social", accessToken: "tok" })).toEqual({ externalId: "109@mastodon.social", handle: "@acme@mastodon.social", displayName: null });
    expect(await connector().refreshAuth()).toBeNull();
    expect(createMastodonConnectors({}).map((c) => c.name)).toEqual(["mastodon"]);
  });
});

describe("mastodon publish", () => {
  it("posts a status with visibility, content warning and an Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(json(status("200")));
    const res = await connector().publish(acct, { ...input, options: { visibility: "unlisted", contentWarning: "spoilers" } });
    expect(call(0).url.href).toBe("https://mastodon.social/api/v1/statuses");
    expect(call(0).headers["idempotency-key"]).toBe("k1:0");
    expect(call(0).headers.authorization).toBe("Bearer tok");
    expect(call(0).json()).toEqual({ status: "hello fediverse", visibility: "unlisted", spoiler_text: "spoilers", sensitive: true });
    expect(res).toEqual({ externalId: "200", url: "https://mastodon.social/@acme/200", raw: { ids: ["200"] } });
  });

  it("uploads media with alt text, waits for video processing and attaches the ids", async () => {
    let checks = 0;
    fetchMock.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "cdn.example") return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "video/mp4" } });
      if (u.pathname === "/api/v2/media") return json({ id: "m1", type: "video", url: null }, 202);
      if (u.pathname === "/api/v1/media/m1") return ++checks < 2 ? json({ id: "m1", url: null }, 206) : json({ id: "m1", url: "https://files/m1.mp4" });
      if (u.pathname === "/api/v1/statuses") return json(status("201"));
      throw new Error(`unexpected ${u}`);
    });
    await connector().publish(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4", alt: "a demo" }] });
    const form = call(1).body as FormData;
    expect(form.get("description")).toBe("a demo");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(checks).toBe(2);
    expect(call(4).json()).toMatchObject({ media_ids: ["m1"] });
  });

  it("returns a retryable error while media still processes and reuses the upload on retry", async () => {
    let ready = false;
    fetchMock.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.hostname === "cdn.example") return new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } });
      if (u.pathname === "/api/v2/media") return json({ id: "m2", url: null }, 202);
      if (u.pathname === "/api/v1/media/m2") return ready ? json({ id: "m2", url: "https://files/m2" }) : json({ id: "m2", url: null }, 206);
      return json(status("202"));
    });
    const c = connector({ maxProcessingChecks: 2 });
    const vid = { ...input, idempotencyKey: "kv", media: [{ kind: "video" as const, url: "https://cdn.example/v.mp4" }] };
    await expect(c.publish(acct, vid)).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(/still processing/) });
    ready = true;
    expect((await c.publish(acct, vid)).externalId).toBe("202");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/api/v2/media"))).toHaveLength(1);
  });

  it("uses the core media fetcher when set", async () => {
    fetchMock.mockImplementation(async (url) => (String(url).endsWith("/api/v2/media") ? json({ id: "m3", url: "https://files/m3.png" }) : json(status("203"))));
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([7]), mime: "image/png" }) };
    await c.publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png", assetId: "a1" }] });
    expect(fetchMock.mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual(["/api/v2/media", "/api/v1/statuses"]);
  });

  it("posts polls and threads chained with in_reply_to_id", async () => {
    let n = 299;
    fetchMock.mockImplementation(async () => json(status(String(++n))));
    const res = await connector().publish(acct, { ...input, thread: ["two"], options: { poll: { options: ["a", "b"], durationMinutes: 60 } } });
    expect(call(0).json()).toEqual({ status: "hello fediverse", visibility: "public", poll: { options: ["a", "b"], expires_in: 3600 } });
    expect(call(1).json()).toEqual({ status: "two", visibility: "public", in_reply_to_id: "300" });
    expect(call(1).headers["idempotency-key"]).toBe("k1:1");
    expect(res.threadExternalIds).toEqual(["300", "301"]);
  });

  it("resumes a failed thread and reports partial ids", async () => {
    fetchMock.mockResolvedValueOnce(json(status("400"))).mockResolvedValueOnce(json({ error: "busy" }, 503));
    const c = connector();
    const t = { ...input, thread: ["two"], idempotencyKey: "kt" };
    const err = await c.publish(acct, t).catch((e: ConnectorError) => e);
    expect(err).toMatchObject({ kind: "network", retryable: true, partial: { externalId: "400", threadExternalIds: ["400"] } });
    fetchMock.mockResolvedValueOnce(json(status("401")));
    expect((await c.publish(acct, t)).threadExternalIds).toEqual(["400", "401"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("validates polls with media, too many options and documents", () => {
    const c = connector();
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png" }], options: { poll: { options: ["a", "b"], durationMinutes: 5 } } })).toMatchObject([{ code: "unsupported_media" }]);
    expect(c.validate(acct, { ...input, options: { poll: { options: ["a", "b", "c", "d", "e"], durationMinutes: 5 } } })).toMatchObject([{ code: "too_many_media" }]);
    expect(c.validate(acct, { ...input, media: [{ kind: "document", url: "https://cdn.example/a.pdf" }] })).toMatchObject([{ code: "unsupported_media" }]);
    expect(c.validate(acct, input)).toEqual([]);
  });
});

describe("mastodon engage", () => {
  it("replies with the author's mention and the parent's visibility", async () => {
    fetchMock
      .mockResolvedValueOnce(json(status("500", { visibility: "private", account: { id: "77", username: "bob", acct: "bob@other.social" } })))
      .mockResolvedValueOnce(json(status("501")));
    const res = await connector().reply(acct, { parentExternalId: "500", text: "thanks!", idempotencyKey: "r1" });
    expect(call(0).url.pathname).toBe("/api/v1/statuses/500");
    expect(call(1).json()).toEqual({ status: "@bob@other.social thanks!", in_reply_to_id: "500", visibility: "private" });
    expect(call(1).headers["idempotency-key"]).toBe("r1");
    expect(res.externalId).toBe("501");
  });

  it("deletes, favourites and unfavourites; refuses hide", async () => {
    fetchMock.mockImplementation(async () => json({}));
    const c = connector();
    await c.moderate(acct, { externalId: "9", action: "delete" });
    await c.moderate(acct, { externalId: "9", action: "like" });
    await c.moderate(acct, { externalId: "9", action: "unlike" });
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${new URL(String(u)).pathname}`)).toEqual(["DELETE /api/v1/statuses/9", "POST /api/v1/statuses/9/favourite", "POST /api/v1/statuses/9/unfavourite"]);
    await expect(c.moderate(acct, { externalId: "9", action: "hide" })).rejects.toMatchObject({ kind: "rejected" });
  });
});

describe("mastodon activity and metrics", () => {
  it("maps notifications and own statuses to activity", async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/v1/notifications") {
        return json([
          { id: "n1", type: "mention", created_at: "2026-11-01T10:00:00.000Z", account: { id: "77", username: "bob", acct: "bob@other.social", display_name: "Bob" }, status: status("600", { content: "<p>hey <span>@acme</span></p>", in_reply_to_id: "300", in_reply_to_account_id: "109", account: { id: "77", username: "bob", acct: "bob@other.social", display_name: "Bob" } }) },
          { id: "n2", type: "mention", created_at: "2026-11-01T09:00:00.000Z", account: { id: "78", username: "cy", acct: "cy" }, status: status("601", { content: "<p>@acme look</p>", account: { id: "78", username: "cy", acct: "cy" } }) },
          { id: "n3", type: "favourite", created_at: "2026-11-01T08:00:00.000Z", account: { id: "77", username: "bob", acct: "bob@other.social" }, status: status("300") },
          { id: "n4", type: "reblog", created_at: "2026-11-01T07:00:00.000Z", account: { id: "77", username: "bob", acct: "bob@other.social" }, status: status("300") },
          { id: "n5", type: "follow", created_at: "2026-11-01T06:00:00.000Z", account: { id: "79", username: "dee", acct: "dee", url: "https://mastodon.social/@dee" } },
          { id: "n0", type: "favourite", created_at: "2026-10-01T00:00:00.000Z", account: { id: "77", username: "bob", acct: "bob" }, status: status("1") },
        ]);
      }
      if (u.pathname === "/api/v1/accounts/109/statuses") return json([status("300", { created_at: "2026-11-01T05:00:00.000Z" })]);
      throw new Error(`unexpected ${u}`);
    });
    const items = await connector().fetchActivity(acct, new Date("2026-11-01T00:00:00Z"));
    expect(items.map((i) => i.kind)).toEqual(["own_post", "follow", "repost", "like", "reply", "mention"]);
    const notif = call(0).url;
    expect(notif.searchParams.getAll("types[]")).toEqual(["mention", "reblog", "favourite", "follow"]);
    expect(notif.searchParams.get("limit")).toBe("40");
    expect(call(1).url.searchParams.get("exclude_reblogs")).toBe("true");
    expect(items.find((i) => i.kind === "reply")).toMatchObject({ externalId: "600", authorHandle: "@bob@other.social", authorName: "Bob", text: "hey @acme", parentExternalId: "300" });
    expect(items.find((i) => i.kind === "mention")).toMatchObject({ externalId: "601", authorHandle: "@cy@mastodon.social" });
    expect(items.find((i) => i.kind === "like")).toMatchObject({ externalId: "notification:n3", parentExternalId: "300", text: null });
    expect(items.find((i) => i.kind === "follow")).toMatchObject({ url: "https://mastodon.social/@dee", parentExternalId: null });
    expect(items[0]).toMatchObject({ externalId: "300", authorHandle: "@acme@mastodon.social", text: "own" });
    expect(items.every((i) => i.raw !== undefined)).toBe(true);
  });

  it("maps status counts to canonical metrics, skipping deleted statuses", async () => {
    fetchMock.mockResolvedValueOnce(json(status("300", { favourites_count: 5, reblogs_count: 2, replies_count: 1 }))).mockResolvedValueOnce(json({ error: "Record not found" }, 404));
    const rows = await connector().fetchMetrics(acct, ["300", "gone"]);
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ likes: 5, reposts: 2, replies: 1, engagements: 8 });
    expect(rows[0]).toMatchObject({ entityType: "post_variant", entityId: "300", source: "mastodon", observedAt: NOW.toISOString() });
  });

  it("reads followers_total from verify_credentials", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "109", username: "acme", acct: "acme", followers_count: 321 }));
    expect(await connector().fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "m1", metric: "followers_total", value: 321, observedAt: NOW.toISOString(), source: "mastodon" }]);
  });

  it("strips status HTML", () => {
    expect(mastodonHtmlToText("<p>a &amp; b<br>c</p><p>d</p>")).toBe("a & b\nc\n\nd");
  });
});

describe("mastodon errors", () => {
  it("maps 429 with reset, 401 to auth, 403 on write to rejected, 422 to rejected, 5xx and fetch failure to network", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "Too many requests" }, 429, { "x-ratelimit-reset": "2026-11-02T00:05:00.000Z" }));
    const e = (await connector().publish(acct, input).catch((x: unknown) => x)) as ConnectorError;
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(e.message).toContain("2026-11-02T00:05:00.000Z");
    fetchMock.mockResolvedValueOnce(json({ error: "The access token is invalid" }, 401));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "auth", retryable: false });
    fetchMock.mockResolvedValueOnce(json({ error: "This action is not allowed" }, 403));
    await expect(connector().moderate(acct, { externalId: "1", action: "delete" })).rejects.toMatchObject({ kind: "rejected" });
    fetchMock.mockResolvedValueOnce(json({ error: "Validation failed: Text character limit of 500 exceeded" }, 422));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("character limit") });
    fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(connector().publish(acct, input)).rejects.toMatchObject({ kind: "network", retryable: true });
    await expect(connector().publish({ ...acct, auth: null }, input)).rejects.toMatchObject({ kind: "auth" });
  });
});
