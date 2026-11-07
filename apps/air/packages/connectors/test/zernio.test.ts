import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Network } from "@starsign/schema";
import { ConnectorError, ZernioConnector, type AccountRef, type PublishInput } from "../src/index.ts";

const NOW = new Date("2026-11-02T00:00:00.000Z");

const acct: AccountRef = { id: "z1", workspaceId: "w", network: "linkedin", externalId: "acc_1", handle: "acme", auth: null, config: {} };
const input: PublishInput = { variantId: "v1", text: "hello linkedin", media: [], thread: [], idempotencyKey: "k1" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: String(url), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string>, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
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

const connector = (opts: Partial<ConstructorParameters<typeof ZernioConnector>[0]> = {}) => new ZernioConnector({ apiKey: "key", now: () => NOW, ...opts });

describe("zernio publish", () => {
  it("creates a post for the account's platform with the idempotency header and maps the response", async () => {
    fetchMock.mockResolvedValueOnce(json({ post: { id: "p1", platforms: [{ platform: "linkedin", platformPostId: "li_9", url: "https://www.linkedin.com/feed/update/9" }] } }, 201));
    const res = await connector().publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png" }] });

    const c = call(0);
    expect(c.url).toBe("https://api.zernio.com/v1/posts");
    expect(c.method).toBe("POST");
    expect(c.headers.authorization).toBe("Bearer key");
    expect(c.headers["idempotency-key"]).toBe("k1");
    expect(c.json()).toEqual({
      content: "hello linkedin",
      platforms: [{ accountId: "acc_1", platform: "linkedin" }],
      mediaItems: [{ url: "https://cdn.example/a.png", type: "image" }],
    });
    // Zernio's own post id is the external id (analytics are keyed by it); the network URL rides along.
    expect(res).toMatchObject({ externalId: "p1", url: "https://www.linkedin.com/feed/update/9" });
  });

  it("re-publishing the same idempotency key returns the cached result without a second request", async () => {
    fetchMock.mockResolvedValue(json({ post: { id: "p1", platforms: [] } }));
    const c = connector();
    const first = await c.publish(acct, input);
    expect(await c.publish(acct, input)).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.url).toBeNull();
  });

  it("serves every network, honors a custom base url and refuses threads and replies it cannot express", async () => {
    const c = connector({ baseUrl: "https://eu.zernio.example/" });
    expect([...c.networks]).toEqual(Network.options);
    expect(c.validate(acct, { ...input, thread: ["more"] })).toMatchObject([{ code: "thread_unsupported" }]);
    expect(c.validate(acct, input)).toEqual([]);
    await expect(c.publish(acct, { ...input, replyToExternalId: "p0" })).rejects.toMatchObject({ kind: "rejected", retryable: false });

    fetchMock.mockResolvedValueOnce(json({ post: { id: "p2", platforms: [] } }));
    await c.publish(acct, input);
    expect(call(0).url).toBe("https://eu.zernio.example/v1/posts");
    expect(() => new ZernioConnector({ apiKey: "" })).toThrow();
  });
});

describe("zernio error mapping", () => {
  it("maps 429 to a retryable rate limit, 401 to auth, 403 on create to rejected and 5xx to network", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "slow down" }, 429, { "retry-after": "30" }));
    const rl = await rejection(connector().publish(acct, input));
    expect(rl).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(rl.message).toContain("retry after 30s");

    fetchMock.mockResolvedValueOnce(json({ error: { message: "invalid api key" } }, 401));
    const auth = await rejection(connector().publish(acct, { ...input, idempotencyKey: "k2" }));
    expect(auth).toMatchObject({ kind: "auth", retryable: false });
    expect(auth.message).toContain("invalid api key");

    fetchMock.mockResolvedValueOnce(json({ message: "plan limit reached" }, 403));
    await expect(connector().publish(acct, { ...input, idempotencyKey: "k3" })).rejects.toMatchObject({ kind: "rejected", retryable: false });

    fetchMock.mockResolvedValueOnce(json({ message: "forbidden" }, 403));
    await expect(connector().fetchMetrics(acct, ["p1"])).rejects.toMatchObject({ kind: "auth", retryable: false });

    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    await expect(connector().fetchActivity(acct, null)).rejects.toMatchObject({ kind: "network", retryable: true });

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(connector().fetchActivity(acct, null)).rejects.toMatchObject({ kind: "network", retryable: true });
  });
});

describe("zernio fetchActivity", () => {
  it("reads mentions for the account since a time and maps kinds, falling back to mention", async () => {
    fetchMock.mockResolvedValueOnce(json({
      mentions: [
        { id: "m1", type: "comment", author: { handle: "bob", name: "Bob" }, text: "nice", url: "https://www.linkedin.com/c/1", parentPostId: "p1", createdAt: "2026-11-01T12:00:00.000Z" },
        { id: "m2", type: "something-new", authorHandle: "carol", content: "hey", createdAt: "2026-11-01T13:00:00.000Z" },
        { id: "old", type: "comment", createdAt: "2026-10-01T00:00:00.000Z" },
        { nope: true },
      ],
    }));
    const since = new Date("2026-11-01T00:00:00.000Z");
    const items = await connector().fetchActivity(acct, since);

    const u = new URL(call(0).url);
    expect(u.pathname).toBe("/v1/accounts/acc_1/mentions");
    expect(u.searchParams.get("since")).toBe(since.toISOString());
    expect(call(0).headers.authorization).toBe("Bearer key");

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ network: "linkedin", kind: "comment", externalId: "m1", authorHandle: "bob", authorName: "Bob", text: "nice", url: "https://www.linkedin.com/c/1", parentExternalId: "p1", occurredAt: "2026-11-01T12:00:00.000Z" });
    expect(items[1]).toMatchObject({ kind: "mention", externalId: "m2", authorHandle: "carol", text: "hey", url: null, parentExternalId: null });
    expect(items[0]?.raw).toMatchObject({ id: "m1" });
  });
});

describe("zernio fetchMetrics", () => {
  it("maps analytics to canonical metrics, deriving engagements when absent", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ analytics: { impressions: 100, likes: 5, comments: 2, shares: 1, saves: 3, linkClicks: 9, unknownThing: 42 } }))
      .mockResolvedValueOnce(json({ likes: 1, engagements: 50 }));
    const rows = await connector().fetchMetrics(acct, ["p1", "p2"]);

    expect(new URL(call(0).url).pathname).toBe("/v1/posts/p1/analytics");
    expect(new URL(call(1).url).pathname).toBe("/v1/posts/p2/analytics");
    const p1 = Object.fromEntries(rows.filter((r) => r.entityId === "p1").map((r) => [r.metric, r.value]));
    expect(p1).toEqual({ impressions: 100, likes: 5, replies: 2, shares: 1, saves: 3, link_clicks: 9, engagements: 11 });
    const p2 = Object.fromEntries(rows.filter((r) => r.entityId === "p2").map((r) => [r.metric, r.value]));
    expect(p2).toEqual({ likes: 1, engagements: 50 });
    expect(rows[0]).toMatchObject({ entityType: "post_variant", source: "zernio", observedAt: NOW.toISOString() });
  });
});
