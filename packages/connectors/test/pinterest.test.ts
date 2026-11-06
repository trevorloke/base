import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { PINTEREST_OAUTH_SCOPES, PinterestConnector, createPinterestConnectors, listBoards, mapPinterestError } from "../src/pinterest.ts";

const NOW = new Date("2026-11-02T00:00:00.000Z");
const API = "https://api.pinterest.com/v5";
const acct: AccountRef = {
  id: "acc-p",
  workspaceId: "w",
  network: "pinterest",
  externalId: "user-1",
  handle: "acmepins",
  auth: { accessToken: "tok", refreshToken: "ref", expiresAt: "2026-12-01T00:00:00.000Z", refreshExpiresAt: "2026-12-30T00:00:00.000Z", username: "acmepins" },
  config: {},
};
const input: PublishInput = { variantId: "v1", text: "Fall recipes", media: [{ kind: "image", url: "https://cdn.example/a.jpg", alt: "Pie" }], thread: [], idempotencyKey: "k1", options: { boardId: "b1", title: "Apple pie", link: "https://acme.example/pie" } };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let routes: [string, string, Handler][];
function on(method: string, prefix: string, handler: Handler | unknown) {
  const h: Handler = typeof handler === "function" ? (handler as Handler) : handler instanceof Response ? () => handler.clone() : () => json(handler);
  routes.push([method, prefix, h]);
}
function calls(method?: string, prefix?: string) {
  return fetchMock.mock.calls
    .map(([u, init]) => ({ url: String(u), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body }))
    .filter((c) => (!method || c.method === method) && (!prefix || c.url.startsWith(prefix)));
}
const jsonBody = (c: { body: unknown }) => JSON.parse(String(c.body)) as Record<string, any>;

async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return e as ConnectorError;
  }
  throw new Error("expected rejection");
}

beforeEach(() => {
  routes = [];
  fetchMock = vi.fn<typeof fetch>(async (u, init) => {
    const url = String(u);
    const method = init?.method ?? "GET";
    const hit = routes.find(([m, p]) => m === method && url.startsWith(p));
    if (!hit) throw new Error(`unexpected ${method} ${url}`);
    return hit[2](url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = (opts: ConstructorParameters<typeof PinterestConnector>[0] = {}) => new PinterestConnector({ clientId: "pid", clientSecret: "psecret", now: () => NOW, sleep: async () => {}, ...opts });

describe("pinterest connect", () => {
  it("builds the authorize URL with comma-separated scopes", () => {
    const url = new URL(connector().oauthAuthorizeUrl({ state: "s", codeChallenge: "c", redirectUri: "https://app.example/oauth/pinterest/callback" }));
    expect(url.origin + url.pathname).toBe("https://www.pinterest.com/oauth/");
    expect(url.searchParams.get("scope")).toBe(PINTEREST_OAUTH_SCOPES.join(","));
    expect(url.searchParams.get("scope")).not.toContain("ads:read");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(new PinterestConnector({}).connectConfigured).toBe(false);
  });

  it("exchanges the code with Basic auth and returns the account", async () => {
    on("POST", `${API}/oauth/token`, { access_token: "tok", refresh_token: "ref", expires_in: 2592000, refresh_token_expires_in: 5184000, scope: "boards:read,pins:write" });
    on("GET", `${API}/user_account`, { id: "user-1", username: "acmepins", business_name: "Acme Pins", account_type: "BUSINESS", follower_count: 10 });
    const accounts = await connector().oauthConnect({ code: "c1", codeVerifier: "v", redirectUri: "https://app.example/oauth/pinterest/callback" });
    expect(accounts).toEqual([
      {
        network: "pinterest",
        identity: { externalId: "user-1", handle: "acmepins", displayName: "Acme Pins" },
        auth: { accessToken: "tok", refreshToken: "ref", expiresAt: "2026-12-02T00:00:00.000Z", refreshExpiresAt: "2027-01-01T00:00:00.000Z", scope: "boards:read,pins:write", username: "acmepins" },
      },
    ]);
    const token = calls("POST")[0]!;
    expect(token.headers.authorization).toBe(`Basic ${Buffer.from("pid:psecret").toString("base64")}`);
    const form = new URLSearchParams(String(token.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBeNull();
    expect(calls("GET")[0]!.headers.authorization).toBe("Bearer tok");
  });

  it("describes an account from its auth blob", async () => {
    on("GET", `${API}/user_account`, { username: "solo" });
    expect(await connector().describeAccount({ accessToken: "tok" })).toEqual({ externalId: "solo", handle: "solo", displayName: "solo" });
  });

  it("refreshes tokens and keeps the rotated refresh token", async () => {
    on("POST", `${API}/oauth/token`, { access_token: "tok2", refresh_token: "ref2", expires_in: 2592000, refresh_token_expires_in: 5184000 });
    const r = await connector().refreshAuth(acct);
    expect(r?.auth).toEqual({ accessToken: "tok2", refreshToken: "ref2", expiresAt: "2026-12-02T00:00:00.000Z", refreshExpiresAt: "2027-01-01T00:00:00.000Z", username: "acmepins" });
    expect(new URLSearchParams(String(calls()[0]!.body)).get("refresh_token")).toBe("ref");
    expect(await connector().refreshAuth({ ...acct, auth: { accessToken: "t" } })).toBeNull();
  });
});

describe("pinterest boards", () => {
  it("lists boards across pages", async () => {
    let page = 0;
    on("GET", `${API}/boards`, () =>
      json(page++ === 0 ? { items: [{ id: "b1", name: "Recipes", privacy: "PUBLIC" }], bookmark: "bm" } : { items: [{ id: "b2", name: "Secret", description: "x", privacy: "SECRET" }], bookmark: null }),
    );
    const boards = await listBoards(acct, { fetch: fetchMock });
    expect(boards).toEqual([
      { id: "b1", name: "Recipes", description: null, privacy: "PUBLIC" },
      { id: "b2", name: "Secret", description: "x", privacy: "SECRET" },
    ]);
    expect(calls()[1]!.url).toBe(`${API}/boards?page_size=100&bookmark=bm`);
  });
});

describe("pinterest validate", () => {
  const c = connector();
  it("requires a board and media; checks carousel size, title and video length", () => {
    const issues = c.validate(acct, { ...input, media: [], options: { title: "x".repeat(101) } });
    expect(issues.map((i) => i.code)).toEqual(["empty", "media_required", "too_long"]);
    expect(issues[0]!.message).toMatch(/boardId/);
    const more = c.validate(acct, {
      ...input,
      media: [{ kind: "video", url: "https://v.example/1.mp4", durationSeconds: 2 }, { kind: "document", url: "https://d.example/a.pdf" }],
    });
    expect(more.map((i) => i.message).join(" | ")).toMatch(/documents.*exactly one video.*4 seconds/);
    expect(c.validate(acct, { ...input, media: Array.from({ length: 6 }, (_, i) => ({ kind: "image" as const, url: `https://i.example/${i}.jpg` })) })[0]!.code).toBe("too_many_media");
    expect(c.validate(acct, input)).toEqual([]);
  });

  it("refuses to publish without a board, before touching the network", async () => {
    const e = await rejection(c.publish(acct, { ...input, options: {} }));
    expect(e.kind).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pinterest publish", () => {
  it("creates an image Pin by URL with title, description, link, alt text and board, once per key", async () => {
    on("POST", `${API}/pins`, { id: "pin-1", board_id: "b1" });
    const c = connector();
    const res = await c.publish(acct, input);
    expect(res).toMatchObject({ externalId: "pin-1", url: "https://www.pinterest.com/pin/pin-1/" });
    expect(jsonBody(calls("POST")[0]!)).toEqual({
      board_id: "b1",
      title: "Apple pie",
      description: "Fall recipes",
      link: "https://acme.example/pie",
      alt_text: "Pie",
      media_source: { source_type: "image_url", url: "https://cdn.example/a.jpg" },
    });
    await c.publish(acct, input);
    expect(calls("POST")).toHaveLength(1);
  });

  it("creates a carousel Pin from multiple image URLs", async () => {
    on("POST", `${API}/pins`, { id: "pin-2" });
    await connector().publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/1.jpg", alt: "one" }, { kind: "image", url: "https://cdn.example/2.jpg" }] });
    expect(jsonBody(calls("POST")[0]!).media_source).toEqual({
      source_type: "multiple_image_urls",
      items: [
        { url: "https://cdn.example/1.jpg", title: "Apple pie", description: "one", link: "https://acme.example/pie" },
        { url: "https://cdn.example/2.jpg", title: "Apple pie", link: "https://acme.example/pie" },
      ],
    });
  });

  it("registers a video upload, posts the file to the upload URL, polls, then creates the Pin", async () => {
    on("POST", `${API}/media`, { media_id: "m1", media_type: "video", upload_url: "https://pinterest-media-upload.s3.amazonaws.com/", upload_parameters: { key: "uploads/m1", policy: "p", "x-amz-signature": "s" } });
    on("POST", "https://pinterest-media-upload.s3.amazonaws.com/", () => new Response(null, { status: 204 }));
    const statuses = ["registered", "processing", "succeeded"];
    on("GET", `${API}/media/m1`, () => json({ media_id: "m1", status: statuses.shift() }));
    on("POST", `${API}/pins`, { id: "pin-v" });
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), mime: "video/mp4" }) };

    const res = await c.publish(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4", durationSeconds: 20 }], options: { boardId: "b1", thumbnailUrl: "https://cdn.example/cover.jpg" } });

    expect(res.externalId).toBe("pin-v");
    expect(jsonBody(calls("POST", `${API}/media`)[0]!)).toEqual({ media_type: "video" });
    const upload = calls("POST", "https://pinterest-media-upload")[0]!;
    const form = upload.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "x-amz-signature", "file"]);
    expect(form.get("key")).toBe("uploads/m1");
    expect(upload.headers.authorization).toBeUndefined();
    expect(calls("GET", `${API}/media/m1`)).toHaveLength(3);
    expect(jsonBody(calls("POST", `${API}/pins`)[0]!).media_source).toEqual({ source_type: "video_id", media_id: "m1", cover_image_url: "https://cdn.example/cover.jpg" });
  });

  it("returns a retryable error while video processes and resumes polling on retry", async () => {
    on("POST", `${API}/media`, { media_id: "m2", upload_url: "https://up.example/", upload_parameters: {} });
    on("POST", "https://up.example/", () => new Response(null, { status: 204 }));
    on("GET", "https://cdn.example/v.mp4", () => new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } }));
    let ready = false;
    on("GET", `${API}/media/m2`, () => json({ status: ready ? "succeeded" : "processing" }));
    on("POST", `${API}/pins`, { id: "pin-v2" });
    const c = connector({ maxPolls: 2 });
    const vid = { ...input, idempotencyKey: "kv", media: [{ kind: "video" as const, url: "https://cdn.example/v.mp4" }] };
    const e = await rejection(c.publish(acct, vid));
    expect(e).toMatchObject({ retryable: true });
    expect(e.message).toMatch(/still processing/);
    ready = true;
    expect((await c.publish(acct, vid)).externalId).toBe("pin-v2");
    expect(calls("POST", `${API}/media`)).toHaveLength(1);
    expect(jsonBody(calls("POST", `${API}/pins`)[0]!).media_source).toEqual({ source_type: "video_id", media_id: "m2", cover_image_key_frame_time: 0 });
  });

  it("fails without retry when video processing fails", async () => {
    on("POST", `${API}/media`, { media_id: "m3", upload_url: "https://up.example/", upload_parameters: {} });
    on("POST", "https://up.example/", () => new Response(null, { status: 204 }));
    on("GET", `${API}/media/m3`, { status: "failed" });
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([1]), mime: "video/mp4" }) };
    const e = await rejection(c.publish(acct, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] }));
    expect(e).toMatchObject({ kind: "rejected", retryable: false });
  });

  it("explains Trial access refusals", async () => {
    on("POST", `${API}/pins`, json({ code: 29, message: "Apps with Trial access may not create Pins in production." }, 403));
    const e = await rejection(connector().publish(acct, input));
    expect(e).toMatchObject({ kind: "rejected", retryable: false });
    expect(e.message).toMatch(/Standard access/);
  });

  it("can target the sandbox API", async () => {
    on("POST", "https://api-sandbox.pinterest.com/v5/pins", { id: "sb-1" });
    const [c] = createPinterestConnectors({ PINTEREST_API_BASE_URL: "https://api-sandbox.pinterest.com/v5" });
    expect((await c!.publish(acct, input)).externalId).toBe("sb-1");
  });
});

describe("pinterest activity", () => {
  it("reports own Pins since a date and stops paging at older ones", async () => {
    on("GET", `${API}/pins`, {
      items: [
        { id: "p2", title: "New", description: "desc", created_at: "2026-11-01T10:00:00" },
        { id: "p1", title: "Old", created_at: "2026-09-01T10:00:00" },
      ],
      bookmark: "more",
    });
    const items = await connector().fetchActivity(acct, new Date("2026-10-01T00:00:00Z"));
    expect(items).toEqual([
      { network: "pinterest", kind: "own_post", externalId: "p2", authorHandle: "acmepins", authorName: null, text: "New\ndesc", url: "https://www.pinterest.com/pin/p2/", parentExternalId: null, occurredAt: "2026-11-01T10:00:00.000Z", raw: expect.anything() },
    ]);
    expect(calls()).toHaveLength(1);
  });

  it("declares no reply, moderation or webhooks (no comments in API v5)", () => {
    const c = connector();
    expect(c.capabilities()).toMatchObject({ publish: true, reply: false, moderate: false, webhooks: false, accountMetrics: true, video: true });
    expect((c as { reply?: unknown }).reply).toBeUndefined();
    expect((c as { moderate?: unknown }).moderate).toBeUndefined();
  });
});

describe("pinterest metrics", () => {
  it("maps pin analytics over the last 90 days", async () => {
    on("GET", `${API}/pins/pin-1/analytics`, {
      all: { summary_metrics: { IMPRESSION: 900, SAVE: 40, PIN_CLICK: 30, OUTBOUND_CLICK: 12, VIDEO_MRC_VIEW: 100, VIDEO_V50_WATCH_TIME: 5000, TOTAL_REACTIONS: 3, TOTAL_COMMENTS: 1 } },
    });
    const rows = await connector().fetchMetrics(acct, ["pin-1"]);
    const q = new URL(calls()[0]!.url).searchParams;
    expect(q.get("start_date")).toBe("2026-08-05");
    expect(q.get("end_date")).toBe("2026-11-02");
    expect(q.get("metric_types")).toContain("IMPRESSION");
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({
      impressions: 900,
      saves: 40,
      clicks: 30,
      link_clicks: 12,
      video_views: 100,
      watch_time_seconds: 5,
      likes: 3,
      replies: 1,
      engagements: 86,
    });
    expect(rows[0]).toMatchObject({ entityType: "post_variant", entityId: "pin-1", source: "pinterest" });
  });

  it("falls back to base metrics when video metric types are refused", async () => {
    let n = 0;
    on("GET", `${API}/pins/pin-2/analytics`, () => (n++ === 0 ? json({ code: 1, message: "Invalid metric type" }, 400) : json({ all: { summary_metrics: { IMPRESSION: 5 } } })));
    const rows = await connector().fetchMetrics(acct, ["pin-2"]);
    expect(new URL(calls()[1]!.url).searchParams.get("metric_types")).toBe("IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK");
    expect(rows.find((r) => r.metric === "impressions")?.value).toBe(5);
  });

  it("reads followers and trailing account analytics", async () => {
    on("GET", `${API}/user_account/analytics`, { all: { summary_metrics: { IMPRESSION: 10000, ENGAGEMENT: 400, SAVE: 100, PIN_CLICK: 200, OUTBOUND_CLICK: 50 } } });
    on("GET", `${API}/user_account`, { id: "user-1", username: "acmepins", follower_count: 777 });
    const rows = await connector().fetchAccountMetrics(acct);
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ followers_total: 777, impressions: 10000, engagements: 400, saves: 100, clicks: 200, link_clicks: 50 });
    expect(rows.every((r) => r.entityType === "social_account" && r.entityId === "acc-p")).toBe(true);
  });

  it("still returns followers when account analytics are unavailable", async () => {
    on("GET", `${API}/user_account/analytics`, json({ code: 403, message: "not a business account" }, 403));
    on("GET", `${API}/user_account`, { username: "acmepins", follower_count: 3 });
    expect((await connector().fetchAccountMetrics(acct)).map((r) => r.metric)).toEqual(["followers_total"]);
  });
});

describe("pinterest errors", () => {
  it("maps statuses", () => {
    const h = new Headers();
    expect(mapPinterestError(401, h, {}, { what: "x" })).toMatchObject({ kind: "auth", retryable: false });
    expect(mapPinterestError(403, h, {}, { what: "x" })).toMatchObject({ kind: "auth" });
    expect(mapPinterestError(403, h, {}, { what: "x", creating: true })).toMatchObject({ kind: "rejected" });
    expect(mapPinterestError(400, h, { code: 1, message: "bad" }, { what: "x" })).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapPinterestError(503, h, {}, { what: "x" })).toMatchObject({ kind: "network", retryable: true });
    const rl = mapPinterestError(429, new Headers({ "retry-after": "30" }), {}, { what: "x" });
    expect(rl).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(rl.message).toContain("retry after 30s");
  });

  it("surfaces transport failures as retryable network errors", async () => {
    on("POST", `${API}/pins`, () => {
      throw new TypeError("socket hang up");
    });
    expect(await rejection(connector().publish(acct, input))).toMatchObject({ kind: "network", retryable: true });
  });
});

describe("pinterest factory", () => {
  it("reads env", () => {
    const [c] = createPinterestConnectors({ PINTEREST_CLIENT_ID: "a", PINTEREST_CLIENT_SECRET: "b" });
    expect(c!.name).toBe("pinterest");
    expect(c!.networks).toEqual(["pinterest"]);
    expect(c!.connectConfigured).toBe(true);
    expect(createPinterestConnectors({})[0]!.connectConfigured).toBe(false);
  });
});
