import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_URL, MeridianApiError, MeridianClient, buildUrl } from "../src/client.ts";
import { blockedDecision, brief, failingFetch, fakeApi } from "./helpers.ts";

const BASE = "http://api.test:4000";
const make = (api: ReturnType<typeof fakeApi>) => new MeridianClient({ baseUrl: BASE, apiKey: "mer_abc", fetch: api.fetch });

describe("buildUrl", () => {
  it("joins base and path, comma-joins arrays and drops empty values", () => {
    const url = new URL(buildUrl("http://x.test/", "/v1/feed", { q: "snow day", networks: ["x", "bluesky"], kinds: [], since: undefined, before: null, limit: 10, flag: true }));
    expect(url.origin + url.pathname).toBe("http://x.test/v1/feed");
    expect(url.searchParams.get("q")).toBe("snow day");
    expect(url.searchParams.get("networks")).toBe("x,bluesky");
    expect(url.searchParams.has("kinds")).toBe(false);
    expect(url.searchParams.has("since")).toBe(false);
    expect(url.searchParams.has("before")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("flag")).toBe("true");
  });
});

describe("MeridianClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bearer key, accept and user-agent headers, and JSON bodies on POST", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/policy/check", body: blockedDecision }]);
    const decision = await make(api).checkPolicy({ variants: [{ network: "x", text: "Results guaranteed" }] });
    expect(decision).toEqual(blockedDecision);
    const call = api.last();
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer mer_abc");
    expect(call.headers.accept).toBe("application/json");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["user-agent"]).toMatch(/^meridian-mcp\//);
    expect(call.body).toEqual({ variants: [{ network: "x", text: "Results guaranteed" }] });
  });

  it("omits the Authorization header when there is no key (the API's dev mode decides)", async () => {
    const api = fakeApi([{ path: "/v1/me", body: { workspace: {}, actor: { type: "human", id: "dev" }, role: "owner" } }]);
    await new MeridianClient({ baseUrl: BASE, fetch: api.fetch }).me();
    expect(api.last().headers.authorization).toBeUndefined();
    await new MeridianClient({ baseUrl: BASE, apiKey: "   ", fetch: api.fetch }).me();
    expect(api.last().headers.authorization).toBeUndefined();
  });

  it("maps every endpoint to the documented method, path and query", async () => {
    const api = fakeApi([
      { path: "/api/health", body: { ok: true, version: "0.1.0", db: "pglite" } },
      { path: "/v1/me", body: {} },
      { path: "/v1/context", body: {} },
      { path: "/v1/policy", body: {} },
      { path: "/v1/accounts", body: [] },
      { path: "/v1/trends/radar", body: [] },
      { path: /^\/v1\/trends\/topics\//, body: {} },
      { path: "/v1/feed", body: [] },
      { path: "/v1/posts/queue", body: [] },
      { path: "/v1/posts", body: [] },
      { method: "POST", path: "/v1/posts", status: 201, body: {} },
      { path: /^\/v1\/posts\/[^/]+$/, body: {} },
      { method: "POST", path: /\/schedule$/, body: {} },
      { method: "POST", path: /\/cancel$/, body: {} },
      { path: "/v1/metrics/summary", body: {} },
      { path: "/v1/metrics/lift-by-stage", body: [] },
      { path: "/v1/briefs/latest", body: brief },
      { path: "/v1/alerts", body: [] },
      { path: "/v1/ledger", body: [] },
    ]);
    const c = make(api);
    const from = new Date("2026-10-26T17:00:00.000Z");
    const to = new Date("2026-11-02T17:00:00.000Z");

    const expectations: [() => Promise<unknown>, string, string, Record<string, string | null>][] = [
      [() => c.health(), "GET", "/api/health", {}],
      [() => c.me(), "GET", "/v1/me", {}],
      [() => c.getContext(), "GET", "/v1/context", {}],
      [() => c.getPolicy(), "GET", "/v1/policy", {}],
      [() => c.listAccounts(), "GET", "/v1/accounts", {}],
      [() => c.getRadar(), "GET", "/v1/trends/radar", {}],
      [() => c.getTopic("top 1/x"), "GET", "/v1/trends/topics/top%201%2Fx", {}],
      [() => c.searchFeed({ q: "snow", networks: ["x"], kinds: ["mention", "reply"], stream: "str_1", since: "2026-11-02T11:00:00.000Z", limit: 5 }), "GET", "/v1/feed", { q: "snow", networks: "x", kinds: "mention,reply", stream: "str_1", since: "2026-11-02T11:00:00.000Z", limit: "5" }],
      [() => c.getQueue(), "GET", "/v1/posts/queue", {}],
      [() => c.listPosts({ status: ["scheduled", "published"], limit: 50 }), "GET", "/v1/posts", { status: "scheduled,published", limit: "50" }],
      [() => c.listPosts(), "GET", "/v1/posts", { status: null, limit: null }],
      [() => c.getPost("pst_1"), "GET", "/v1/posts/pst_1", {}],
      [() => c.createPost({ body: "hi", variants: [{ socialAccountId: "acc_x", text: "hi" }] }), "POST", "/v1/posts", {}],
      [() => c.schedulePost("pst_1", "2026-11-03T16:00:00.000Z"), "POST", "/v1/posts/pst_1/schedule", {}],
      [() => c.cancelPost("pst_1"), "POST", "/v1/posts/pst_1/cancel", {}],
      [() => c.getMetricsSummary({ from, to }), "GET", "/v1/metrics/summary", { from: from.toISOString(), to: to.toISOString() }],
      [() => c.getLiftByStage({ from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" }), "GET", "/v1/metrics/lift-by-stage", { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" }],
      [() => c.getLatestBrief(), "GET", "/v1/briefs/latest", {}],
      [() => c.listAlerts(), "GET", "/v1/alerts", { unacknowledged: "1", limit: null }],
      [() => c.listAlerts({ unacknowledgedOnly: false, limit: 10 }), "GET", "/v1/alerts", { unacknowledged: null, limit: "10" }],
      [() => c.getLedger({ types: ["post.created", "policy.blocked"], subjectType: "post", subjectId: "pst_1", limit: 100 }), "GET", "/v1/ledger", { types: "post.created,policy.blocked", subjectType: "post", subjectId: "pst_1", limit: "100" }],
    ];

    for (const [call, method, path, query] of expectations) {
      await call();
      const req = api.last();
      expect(`${req.method} ${req.url.pathname}`).toBe(`${method} ${path}`);
      for (const [k, v] of Object.entries(query)) expect(req.url.searchParams.get(k), `${path}?${k}`).toBe(v);
    }
    expect(api.calls).toHaveLength(expectations.length);
  });

  it("sends the schedule body and the raw create body", async () => {
    const api = fakeApi([
      { method: "POST", path: "/v1/posts", status: 201, body: {} },
      { method: "POST", path: "/v1/posts/pst_1/schedule", body: {} },
    ]);
    const c = make(api);
    const input = { body: "hi", variants: [{ socialAccountId: "acc_x", text: "hi" }], scheduledAt: "2026-11-03T16:00:00.000Z" };
    await c.createPost(input);
    expect(api.last().body).toEqual(input);
    await c.schedulePost("pst_1", "2026-11-03T16:00:00.000Z");
    expect(api.last().body).toEqual({ at: "2026-11-03T16:00:00.000Z" });
  });

  it("surfaces API errors with status, code, message and details", async () => {
    const api = fakeApi([{ method: "POST", path: "/v1/posts", status: 403, body: { error: { code: "forbidden", message: "autonomy for dm is suggest: the actor may not create", details: { autonomy: "suggest" } } } }]);
    const err = await make(api)
      .createPost({ body: "x", variants: [{ socialAccountId: "a", text: "x" }], actionClass: "dm" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeridianApiError);
    const e = err as MeridianApiError;
    expect(e).toMatchObject({ status: 403, code: "forbidden", message: "autonomy for dm is suggest: the actor may not create", details: { autonomy: "suggest" }, method: "POST", path: "/v1/posts" });
    expect(e.toText()).toContain("403 (forbidden)");
    expect(e.toText()).toContain('"autonomy": "suggest"');
  });

  it("falls back to a status-derived code when the error body is not the API's shape", async () => {
    const api = fakeApi([
      { path: "/v1/me", status: 502, raw: "Bad Gateway" },
      { path: "/v1/policy", status: 404, raw: "" },
      { path: "/v1/context", status: 401, body: { message: "nope" } },
    ]);
    const c = make(api);
    await expect(c.me()).rejects.toMatchObject({ status: 502, code: "http_error", message: "HTTP 502: Bad Gateway" });
    await expect(c.getPolicy()).rejects.toMatchObject({ status: 404, code: "not_found", message: "HTTP 404" });
    await expect(c.getContext()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("wraps transport failures as an unreachable-API error", async () => {
    const c = new MeridianClient({ baseUrl: BASE, apiKey: "mer_abc", fetch: failingFetch() });
    const err = (await c.getRadar().catch((e: unknown) => e)) as MeridianApiError;
    expect(err).toBeInstanceOf(MeridianApiError);
    expect(err).toMatchObject({ status: 0, code: "unavailable" });
    expect(err.message).toContain(BASE);
    expect(err.message).toContain("ECONNREFUSED");
    expect(err.toText()).toContain("unreachable");
  });

  it("rejects non-JSON success bodies and returns null / undefined for null and 204 responses", async () => {
    const api = fakeApi([
      { path: "/v1/briefs/latest", body: null },
      { path: "/v1/trends/radar", raw: "<html>oops</html>" },
      { method: "POST", path: "/v1/posts/pst_1/cancel", status: 204 },
    ]);
    const c = make(api);
    expect(await c.getLatestBrief()).toBeNull();
    await expect(c.getRadar()).rejects.toMatchObject({ code: "invalid_response" });
    expect(await c.cancelPost("pst_1")).toBeUndefined();
  });

  it("reads the environment and strips trailing slashes", () => {
    const fromEnv = MeridianClient.fromEnv({ MERIDIAN_API_URL: "https://meridian.example/api/", MERIDIAN_API_KEY: "mer_env" });
    expect(fromEnv.baseUrl).toBe("https://meridian.example/api");
    expect(fromEnv.apiKey).toBe("mer_env");
    const defaults = MeridianClient.fromEnv({});
    expect(defaults.baseUrl).toBe(DEFAULT_API_URL);
    expect(defaults.apiKey).toBeUndefined();
    const other = fromEnv.withApiKey("mer_other");
    expect(other.baseUrl).toBe(fromEnv.baseUrl);
    expect(other.apiKey).toBe("mer_other");
  });

  it("uses the global fetch when none is injected", async () => {
    const api = fakeApi([{ path: "/api/health", body: { ok: true, version: "0.1.0", db: "pglite" } }]);
    vi.stubGlobal("fetch", api.fetch);
    const c = new MeridianClient({ baseUrl: BASE });
    expect(await c.health()).toEqual({ ok: true, version: "0.1.0", db: "pglite" });
    expect(api.calls).toHaveLength(1);
  });
});
