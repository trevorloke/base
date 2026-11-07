import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { ThreadsConnector, createThreadsConnectors, parseThreadsWebhook } from "../src/threads.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");

interface Req {
  method: string;
  url: URL;
  path: string;
  body: string;
  form: () => Record<string, string>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function router(routes: [string, RegExp, (req: Req) => unknown][]) {
  const calls: Req[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1\.0/, "");
    const body = String(init?.body ?? "");
    const req: Req = { method, url, path, body, form: () => Object.fromEntries(new URLSearchParams(body)) };
    calls.push(req);
    for (const [m, re, respond] of routes) {
      if (m === method && re.test(path)) {
        const r = respond(req);
        return r instanceof Response ? r : json(r);
      }
    }
    throw new Error(`unrouted ${method} ${url}`);
  });
  return { fetch: fn as unknown as typeof fetch, calls, find: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)) };
}

const make = (f: typeof fetch, extra: ConstructorParameters<typeof ThreadsConnector>[0] = {}) =>
  new ThreadsConnector({ clientId: "th-app", clientSecret: "th-secret", webhookVerifyToken: "tvt", fetch: f, now: () => NOW, sleep: async () => {}, ...extra });

const acct: AccountRef = { id: "acc-th", workspaceId: "w", network: "threads", externalId: "TU1", handle: "acme", auth: { accessToken: "TT", userId: "TU1" }, config: {} };
const base = (o: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v", text: "hello threads", media: [], thread: [], idempotencyKey: `k-${Math.random()}`, ...o });
const quota = (usage = 1) => ({ data: [{ quota_usage: usage, config: { quota_total: 250, quota_duration: 86400 } }] });

async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return e as ConnectorError;
  }
  throw new Error("expected rejection");
}

/** Routes for the happy publish path: containers numbered C1.., published ids P1.. */
function publishRoutes(status: (id: string) => string = () => "FINISHED") {
  let c = 0;
  let p = 0;
  return router([
    ["GET", /\/TU1\/threads_publishing_limit$/, () => quota()],
    ["POST", /\/TU1\/threads$/, () => ({ id: `C${++c}` })],
    ["GET", /^\/C\d+$/, (q) => ({ status: status(q.path.slice(1)) })],
    ["POST", /\/TU1\/threads_publish$/, () => ({ id: `P${++p}` })],
    ["GET", /^\/P\d+$/, (q) => ({ permalink: `https://www.threads.com/@acme/post/${q.path.slice(1)}` })],
  ]);
}

describe("threads connect", () => {
  it("is configured with client id + secret and builds the authorize URL with Threads scopes", () => {
    expect(createThreadsConnectors({})[0]!.connectConfigured).toBe(false);
    const [c] = createThreadsConnectors({ THREADS_CLIENT_ID: "th-app", THREADS_CLIENT_SECRET: "s" });
    expect(c!.connectConfigured).toBe(true);
    expect(c!.name).toBe("threads");
    expect(c!.networks).toEqual(["threads"]);
    const u = new URL(c!.oauthAuthorizeUrl!({ state: "s", codeChallenge: "c", redirectUri: "https://app/oauth/threads/callback" }));
    expect(u.searchParams.get("scope")).toBe("threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies,threads_manage_insights,threads_delete");
    expect(u.searchParams.get("client_id")).toBe("th-app");
  });

  it("exchanges the code, upgrades to a long-lived token and describes the profile", async () => {
    const r = router([
      ["POST", /\/oauth\/access_token$/, () => ({ access_token: "SHORT", user_id: 1234 })],
      ["GET", /^\/access_token$/, (q) => (q.url.searchParams.get("grant_type") === "th_exchange_token" && q.url.searchParams.get("access_token") === "SHORT" ? { access_token: "LONG", token_type: "bearer", expires_in: 5_184_000 } : json({ error: { code: 190 } }, 400))],
      ["GET", /^\/me$/, (q) => (q.url.searchParams.get("access_token") === "LONG" ? { id: "TU1", username: "acme", name: "Acme" } : json({ error: { code: 190 } }, 400))],
    ]);
    const [a] = await make(r.fetch).oauthConnect({ code: "CODE", codeVerifier: "", redirectUri: "https://app/cb" });
    expect(a!.identity).toEqual({ externalId: "TU1", handle: "acme", displayName: "Acme" });
    // Real expiry 60 days out; refresh due 7 days earlier so core renews in time.
    expect(a!.auth).toEqual({ accessToken: "LONG", userId: "TU1", tokenExpiresAt: "2027-01-02T12:00:00.000Z", expiresAt: "2026-12-26T12:00:00.000Z" });
    expect(r.calls[0]!.form()).toMatchObject({ grant_type: "authorization_code", code: "CODE", client_id: "th-app", client_secret: "th-secret" });
    expect(r.calls[1]!.url.searchParams.get("client_secret")).toBe("th-secret");
  });

  it("refreshes the long-lived token with th_refresh_token", async () => {
    const r = router([["GET", /^\/refresh_access_token$/, (q) => (q.url.searchParams.get("grant_type") === "th_refresh_token" ? { access_token: "LONG2", expires_in: 5_184_000 } : {})]]);
    const out = await make(r.fetch).refreshAuth(acct);
    expect(out?.auth).toMatchObject({ accessToken: "LONG2", userId: "TU1", tokenExpiresAt: "2027-01-02T12:00:00.000Z" });
    const dead = router([["GET", /refresh_access_token$/, () => json({ error: { code: 190, message: "Session has expired" } }, 400)]]);
    expect(await rejection(make(dead.fetch).refreshAuth(acct))).toMatchObject({ kind: "auth" });
  });
});

describe("threads publish", () => {
  it("publishes a text post with a link attachment", async () => {
    const r = publishRoutes();
    const res = await make(r.fetch).publish(acct, base({ options: { kind: "link", link: "https://acme.example/" } }));
    expect(res).toMatchObject({ externalId: "P1", url: "https://www.threads.com/@acme/post/P1" });
    expect(r.find("POST", /\/TU1\/threads$/)[0]!.form()).toEqual({ text: "hello threads", media_type: "TEXT", link_attachment: "https://acme.example/" });
    expect(r.find("POST", /threads_publish$/)[0]!.form()).toEqual({ creation_id: "C1" });
    expect(r.calls[0]!.url.searchParams.get("access_token")).toBe("TT");
  });

  it("publishes image and video posts, polling video containers until FINISHED", async () => {
    let polls = 0;
    const r = publishRoutes((id) => (id === "C2" && ++polls < 3 ? "IN_PROGRESS" : "FINISHED"));
    const c = make(r.fetch);
    await c.publish(acct, base({ media: [{ kind: "image", url: "https://cdn.example/a.png", mime: "image/png", alt: "logo" }] }));
    await c.publish(acct, base({ media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] }));
    const forms = r.find("POST", /\/TU1\/threads$/).map((x) => x.form());
    expect(forms[0]).toEqual({ text: "hello threads", media_type: "IMAGE", image_url: "https://cdn.example/a.png", alt_text: "logo" });
    expect(forms[1]).toEqual({ text: "hello threads", media_type: "VIDEO", video_url: "https://cdn.example/v.mp4" });
    expect(polls).toBe(3);
  });

  it("publishes a mixed carousel from item containers", async () => {
    const r = publishRoutes();
    await make(r.fetch).publish(acct, base({ media: [{ kind: "image", url: "https://cdn.example/1.jpg" }, { kind: "video", url: "https://cdn.example/2.mp4" }], options: { kind: "carousel" } }));
    const forms = r.find("POST", /\/TU1\/threads$/).map((x) => x.form());
    expect(forms[0]).toEqual({ media_type: "IMAGE", image_url: "https://cdn.example/1.jpg", is_carousel_item: "true" });
    expect(forms[1]).toEqual({ media_type: "VIDEO", video_url: "https://cdn.example/2.mp4", is_carousel_item: "true" });
    expect(forms[2]).toEqual({ text: "hello threads", media_type: "CAROUSEL", children: "C1,C2" });
  });

  it("chains thread segments with reply_to_id and resumes a failed thread without re-posting", async () => {
    let publishes = 0;
    let c = 0;
    const r = router([
      ["GET", /threads_publishing_limit$/, () => quota()],
      ["POST", /\/TU1\/threads$/, () => ({ id: `C${++c}` })],
      ["GET", /^\/C\d+$/, () => ({ status: "FINISHED" })],
      ["POST", /threads_publish$/, () => (++publishes === 2 ? json({ error: { code: 2, message: "Service unavailable" } }, 503) : { id: `P${publishes}` })],
      ["GET", /^\/P\d+$/, () => ({ permalink: "https://www.threads.com/@acme/post/x" })],
    ]);
    const conn = make(r.fetch);
    const input = base({ thread: ["second", "third"], replyToExternalId: "PARENT" });
    const e = await rejection(conn.publish(acct, input));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    expect(e.partial).toEqual({ externalId: "P1", url: null, threadExternalIds: ["P1"] });
    const res = await conn.publish(acct, input);
    expect(res.threadExternalIds).toEqual(["P1", "P3", "P4"]);
    const forms = r.find("POST", /\/TU1\/threads$/).map((x) => x.form());
    expect(forms[0]).toMatchObject({ text: "hello threads", reply_to_id: "PARENT" });
    expect(forms[1]).toMatchObject({ text: "second", reply_to_id: "P1" });
    // The second segment's container survived the failed publish and is reused.
    expect(forms).toHaveLength(3);
    expect(forms[2]).toMatchObject({ text: "third", reply_to_id: "P3" });
    expect(r.find("POST", /threads_publish$/).map((x) => x.form().creation_id)).toEqual(["C1", "C2", "C2", "C3"]);
  });

  it("errors retryably while processing, rejects ERROR containers, and respects the publishing limit", async () => {
    const slow = publishRoutes(() => "IN_PROGRESS");
    expect(await rejection(make(slow.fetch, { maxPolls: 2 }).publish(acct, base({ media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] })))).toMatchObject({ kind: "network", retryable: true });
    const bad = publishRoutes(() => "ERROR");
    expect(await rejection(make(bad.fetch).publish(acct, base()))).toMatchObject({ kind: "rejected", retryable: false });
    const full = router([["GET", /threads_publishing_limit$/, () => quota(250)]]);
    expect(await rejection(make(full.fetch).publish(acct, base()))).toMatchObject({ kind: "rate_limit", retryable: true });
  });

  it("validates Threads rules", () => {
    const c = make(router([]).fetch);
    const codes = (i: PublishInput) => c.validate(acct, i).map((x) => x.code);
    expect(codes(base({ media: [{ kind: "gif", url: "https://cdn.example/a.gif" }] }))).toContain("unsupported_media");
    expect(codes(base({ media: [{ kind: "image", url: "https://cdn.example/a.webp", mime: "image/webp" }] }))).toContain("unsupported_media");
    expect(codes(base({ media: [{ kind: "image", url: "https://cdn.example/a.jpg" }], options: { kind: "carousel" } }))).toContain("media_required");
    expect(codes(base({ media: Array.from({ length: 21 }, () => ({ kind: "image" as const, url: "https://cdn.example/a.jpg" })) }))).toContain("too_many_media");
    expect(codes(base({ media: [{ kind: "image", url: "https://cdn.example/a.jpg" }], options: { link: "https://x.example/" } }))).toContain("unsupported_media");
    expect(codes(base({ options: { kind: "reel" } }))).toContain("unsupported_media");
    expect(codes(base({ thread: ["a", "b"] }))).toEqual([]);
  });
});

describe("threads inbox, reply, moderate", () => {
  it("reads replies in the conversations of recent posts", async () => {
    const r = router([
      ["GET", /\/TU1\/threads$/, () => ({ data: [{ id: "P1", text: "ours", timestamp: "2026-11-03T08:00:00+0000", username: "acme", permalink: "https://t/P1" }, { id: "RP", media_type: "REPOST_FACADE", timestamp: "2026-11-01T08:00:00+0000" }] })],
      [
        "GET",
        /\/P1\/conversation$/,
        () => ({
          data: [
            { id: "R1", text: "hi", username: "fan", timestamp: "2026-11-03T09:00:00+0000", replied_to: { id: "P1" }, root_post: { id: "P1" } },
            { id: "R2", text: "me too", username: "fan2", timestamp: "2026-11-03T09:10:00+0000", replied_to: { id: "R1" } },
            { id: "R3", text: "thanks", username: "acme", timestamp: "2026-11-03T09:20:00+0000", replied_to: { id: "R1" } },
            { id: "R0", text: "old", username: "fan", timestamp: "2026-11-01T09:00:00+0000", replied_to: { id: "P1" } },
          ],
        }),
      ],
    ]);
    const items = await make(r.fetch).fetchActivity(acct, new Date("2026-11-02T00:00:00Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.parentExternalId, i.authorHandle])).toEqual([
      ["own_post", "P1", null, "acme"],
      ["reply", "R1", "P1", "fan"],
      ["reply", "R2", "R1", "fan2"],
    ]);
    expect(r.find("GET", /conversation$/)).toHaveLength(1); // repost facades are skipped
  });

  it("replies via a TEXT container with reply_to_id", async () => {
    const r = publishRoutes();
    const res = await make(r.fetch).reply(acct, { parentExternalId: "R1", text: "thank you", idempotencyKey: "rk" });
    expect(res.externalId).toBe("P1");
    expect(r.find("POST", /\/TU1\/threads$/)[0]!.form()).toEqual({ text: "thank you", reply_to_id: "R1", media_type: "TEXT" });
  });

  it("hides/unhides replies with manage_reply and deletes own posts", async () => {
    const r = router([
      ["POST", /\/R1\/manage_reply$/, () => ({ success: true })],
      ["DELETE", /\/P1$/, () => ({ success: true })],
    ]);
    const c = make(r.fetch);
    await c.moderate(acct, { externalId: "R1", action: "hide" });
    await c.moderate(acct, { externalId: "R1", action: "unhide" });
    await c.moderate(acct, { externalId: "P1", action: "delete" });
    expect(r.calls.map((x) => `${x.method} ${x.path} ${x.body}`)).toEqual(["POST /R1/manage_reply hide=true", "POST /R1/manage_reply hide=false", "DELETE /P1 "]);
    expect(await rejection(c.moderate(acct, { externalId: "R1", action: "like" }))).toMatchObject({ kind: "rejected" });
  });
});

describe("threads metrics", () => {
  it("maps post insights", async () => {
    const r = router([["GET", /\/P1\/insights$/, () => ({ data: ["views", "likes", "replies", "reposts", "quotes", "shares"].map((name, i) => ({ name, period: "lifetime", values: [{ value: [500, 20, 5, 3, 1, 2][i] }] })) })]]);
    const rows = await make(r.fetch).fetchMetrics(acct, ["P1"]);
    expect(Object.fromEntries(rows.map((x) => [x.metric, x.value]))).toEqual({ impressions: 500, likes: 20, replies: 5, reposts: 3, quotes: 1, shares: 2, engagements: 29 });
    expect(rows[0]).toMatchObject({ entityType: "post_variant", entityId: "P1", source: "threads" });
  });

  it("maps account insights incl. followers_count, skipping metrics the API refuses", async () => {
    const r = router([
      [
        "GET",
        /\/TU1\/threads_insights$/,
        (q) => {
          const m = q.url.searchParams.get("metric")!;
          if (m.includes("clicks")) return json({ error: { code: 100, message: "invalid metric" } }, 400);
          if (m === "views") return { data: [{ name: "views", period: "day", values: [{ value: 40 }, { value: 60 }] }] };
          if (m === "followers_count") return { data: [{ name: "followers_count", period: "day", total_value: { value: 1500 } }] };
          return { data: [{ name: m, period: "day", total_value: { value: 2 } }] };
        },
      ],
    ]);
    const rows = await make(r.fetch).fetchAccountMetrics(acct);
    expect(Object.fromEntries(rows.map((x) => [x.metric, x.value]))).toEqual({ followers_total: 1500, impressions: 100, engagements: 8 });
    expect(rows[0]).toMatchObject({ entityType: "social_account", entityId: "acc-th" });
    expect(r.calls[0]!.url.searchParams.get("since")).toBe(String(NOW.getTime() / 1000 - 86400));
  });
});

describe("threads webhooks", () => {
  const c = make(router([]).fetch);
  it("handshakes and verifies with the Threads app secret", () => {
    expect(c.webhook.challenge!({ "hub.mode": "subscribe", "hub.verify_token": "tvt", "hub.challenge": "abc" })).toBe("abc");
    expect(c.webhook.challenge!({ "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "abc" })).toBeNull();
    const raw = '{"values":[]}';
    expect(c.webhook.verify({ "x-hub-signature-256": `sha256=${createHmac("sha256", "th-secret").update(raw).digest("hex")}` }, raw)).toBe(true);
    expect(c.webhook.verify({ "x-hub-signature-256": `sha256=${createHmac("sha256", "other").update(raw).digest("hex")}` }, raw)).toBe(false);
  });

  it("parses replies and mentions routed by the subscribed user", () => {
    const batches = parseThreadsWebhook(
      {
        app_id: "1",
        topic: "moderate",
        target_id: "TU1",
        time: 1762171200,
        values: [
          { field: "replies", value: { id: "R9", username: "fan", text: "hey", permalink: "https://t/R9", replied_to: { id: "P1" }, root_post: { id: "P1", owner_id: "TU1" }, timestamp: "2026-11-03T10:00:00+0000" } },
          { field: "mentions", value: { id: "M9", username: "friend", text: "@acme look" } },
          { field: "publish", value: { id: "X" } },
        ],
      },
      NOW,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.accountExternalId).toBe("TU1");
    expect(batches[0]!.items.map((i) => [i.kind, i.externalId, i.parentExternalId, i.occurredAt])).toEqual([
      ["reply", "R9", "P1", "2026-11-03T10:00:00.000Z"],
      ["mention", "M9", null, "2025-11-03T12:00:00.000Z"],
    ]);
    // Without target_id, replies route by the root post owner.
    expect(parseThreadsWebhook({ values: { field: "replies", value: { id: "R1", root_post: { id: "P", owner_id: "TU7" } } } }, NOW)[0]!.accountExternalId).toBe("TU7");
    expect(parseThreadsWebhook({}, NOW)).toEqual([]);
  });
});
