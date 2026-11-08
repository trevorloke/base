import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { KitConnector, createKitConnectors, kitStatsToMetrics, kitSubject } from "../src/kit.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const KEY = "kit_0123456789abcdef0123456789abcdef";
const acct: AccountRef = { id: "k1", workspaceId: "w", network: "kit", externalId: "12345", handle: "Acme Letters", auth: { apiKey: KEY }, config: { accountId: "12345" } };
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
const connector = () => new KitConnector({ now: () => NOW });

describe("kit connect", () => {
  it("verifies the key with GET /v4/account", async () => {
    route(() => json({ user: { email: "owner@acme.test" }, account: { id: 12345, name: "Acme Letters", plan_type: "creator", primary_email_address: "news@acme.test" } }));
    const accounts = await connector().connectWithInputs({ network: "kit", inputs: { apiKey: ` ${KEY} ` } });
    expect(calls[0]?.url.toString()).toBe("https://api.kit.com/v4/account");
    expect(calls[0]?.headers["x-kit-api-key"]).toBe(KEY);
    expect(accounts).toEqual([{ network: "kit", identity: { externalId: "12345", handle: "Acme Letters", displayName: "Acme Letters" }, auth: { apiKey: KEY }, config: { accountId: "12345", plan: "creator" } }]);
  });

  it("maps a rejected key to auth without echoing it", async () => {
    route(() => json({ errors: ["The access token is invalid"] }, 401));
    const err = (await connector().connectWithInputs({ network: "kit", inputs: { apiKey: KEY } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).toContain("The access token is invalid");
    expect(err.message).not.toContain(KEY);
    await expect(connector().connectWithInputs({ network: "kit", inputs: { apiKey: "" } })).rejects.toMatchObject({ kind: "auth" });
  });

  it("declares inputs, capabilities and its factory", () => {
    const [c] = createKitConnectors({});
    expect(c?.name).toBe("kit");
    expect(c?.connectMethod).toBe("api_key");
    expect(c?.credentialInputs?.[0]).toMatchObject({ key: "apiKey", secret: true });
    expect(c?.capabilities("kit")).toMatchObject({ publish: true, fetchActivity: false, fetchMetrics: true, accountMetrics: true, reply: false });
  });
});

describe("kit publish", () => {
  const input: PublishInput = { variantId: "v", text: "Hello <friends> & fans\n\nRead [more](https://acme.test/more)", media: [{ kind: "image", url: "https://cdn.air.test/h.jpg", alt: "Header" }], thread: [], idempotencyKey: "k1", options: { title: "This week" } };

  it("creates a public broadcast sent now and returns its public url", async () => {
    route(() => json({ broadcast: { id: 987, subject: "This week", public: true, public_url: "https://acme.kit.com/posts/this-week", send_at: NOW.toISOString() } }, 201));
    const c = connector();
    const res = await c.publish(acct, input);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v4/broadcasts");
    expect(bodyJson(calls[0])).toEqual({
      subject: "This week",
      content: '<p>Hello &lt;friends&gt; &amp; fans</p>\n<p>Read <a href="https://acme.test/more">more</a></p>\n<figure><img src="https://cdn.air.test/h.jpg" alt="Header"></figure>',
      public: true,
      published_at: NOW.toISOString(),
      send_at: NOW.toISOString(),
      thumbnail_url: "https://cdn.air.test/h.jpg",
      thumbnail_alt: "Header",
    });
    expect(res).toMatchObject({ externalId: "987", url: "https://acme.kit.com/posts/this-week" });
    await c.publish(acct, input);
    expect(calls).toHaveLength(1);
  });

  it("keeps non-public variants email-only and falls back to the first line as subject", async () => {
    route(() => json({ broadcast: { id: 5, public: false, public_url: null } }, 201));
    const res = await connector().publish(acct, { ...input, idempotencyKey: "k2", media: [], options: { visibility: "unlisted" } });
    const b = bodyJson(calls[0]);
    expect(b).toMatchObject({ subject: "Hello <friends> & fans", public: false, send_at: NOW.toISOString() });
    expect(b.published_at).toBeUndefined();
    expect(b.thumbnail_url).toBeUndefined();
    expect(res.url).toBeNull();
  });

  it("validates subject and media", async () => {
    const c = connector();
    expect(c.validate(acct, { ...input, text: "  ", options: {}, media: [{ kind: "video", url: "https://v.test/a.mp4" }] }).map((i) => i.code)).toEqual(["empty", "unsupported_media"]);
    expect(c.validate(acct, input)).toEqual([]);
    expect(kitSubject({ ...input, options: { title: "  " } })).toBe("Hello <friends> & fans");
    await expect(c.publish(acct, { ...input, text: "", options: {}, idempotencyKey: "k3" })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("maps 429, 422 and 5xx", async () => {
    route(() => json({ errors: ["Rate limit exceeded"] }, 429, { "retry-after": "60" }));
    await expect(connector().publish(acct, { ...input, idempotencyKey: "e1" })).rejects.toMatchObject({ kind: "rate_limit", retryable: true, message: expect.stringContaining("retry after 60s") });
    route(() => json({ errors: ["Subject can't be blank"] }, 422));
    await expect(connector().publish(acct, { ...input, idempotencyKey: "e2" })).rejects.toMatchObject({ kind: "rejected", retryable: false, message: expect.stringContaining("Subject can't be blank") });
    route(() => new Response("", { status: 500 }));
    await expect(connector().publish(acct, { ...input, idempotencyKey: "e3" })).rejects.toMatchObject({ kind: "network", retryable: true });
  });
});

describe("kit metrics", () => {
  it("maps broadcast stats and skips broadcasts without stats", async () => {
    route((c) => {
      if (c.url.pathname === "/v4/broadcasts/987/stats") return json({ broadcast: { id: 987, stats: { recipients: 1000, open_rate: 42.5, emails_opened: 425, click_rate: 3.2, total_clicks: 51, unsubscribes: 2, status: "completed" } } });
      if (c.url.pathname === "/v4/subscribers") return json({ subscribers: [{ id: 1 }], pagination: { has_next_page: true, total_count: 8812 } });
      return json({ errors: ["Not Found"] }, 404);
    });
    const metrics = await connector().fetchMetrics(acct, ["987", "404"]);
    expect(metrics.map((m) => [m.entityId, m.metric, m.value])).toEqual([
      ["987", "reach", 1000],
      ["987", "impressions", 425],
      ["987", "clicks", 51],
      ["987", "link_clicks", 32],
    ]);
    const account = await connector().fetchAccountMetrics(acct);
    expect(calls.at(-1)?.url.searchParams.get("include_total_count")).toBe("true");
    expect(account).toEqual([{ entityType: "social_account", entityId: "k1", metric: "followers_total", value: 8812, observedAt: NOW.toISOString(), source: "kit" }]);
    expect(await connector().fetchActivity()).toEqual([]);
  });

  it("derives opens from the open rate when the count is missing", () => {
    expect(kitStatsToMetrics("b", { recipients: 200, open_rate: 50 }, "t").map((m) => [m.metric, m.value])).toEqual([
      ["reach", 200],
      ["impressions", 100],
    ]);
  });
});
