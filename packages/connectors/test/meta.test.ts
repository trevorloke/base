import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { META_DEFAULT_GRAPH_VERSION, MetaConnector, createMetaConnectors, mapGraphError, parseMetaWebhook } from "../src/meta.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const V = META_DEFAULT_GRAPH_VERSION;

interface Req {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  json: () => Record<string, unknown>;
}
type Responder = (req: Req) => unknown;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Fake fetch routing "METHOD /path" regexes to responders; unrouted calls fail loudly. */
function router(routes: [string, RegExp, Responder][]) {
  const calls: Req[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(`/${V}`, "");
    const req: Req = { method, url, path, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
    calls.push(req);
    for (const [m, re, respond] of routes) {
      if (m === method && re.test(`${url.host}${path}`)) {
        const r = respond(req);
        return r instanceof Response ? r : json(r);
      }
    }
    throw new Error(`unrouted ${method} ${url}`);
  });
  return { fetch: fn as unknown as typeof fetch, calls, find: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)) };
}

const make = (fetchImpl: typeof fetch, extra: ConstructorParameters<typeof MetaConnector>[0] = {}) =>
  new MetaConnector({ clientId: "app1", clientSecret: "secret", webhookVerifyToken: "vt", fetch: fetchImpl, now: () => NOW, sleep: async () => {}, ...extra });

const pageAuth = { pageAccessToken: "PT", pageId: "P1", userAccessToken: "ULL", userId: "U1", userTokenExpiresAt: "2027-01-01T00:00:00.000Z" };
const fb: AccountRef = { id: "acc-fb", workspaceId: "w", network: "facebook", externalId: "P1", handle: "acme", auth: pageAuth, config: { pageId: "P1" } };
const ig: AccountRef = { id: "acc-ig", workspaceId: "w", network: "instagram", externalId: "IG1", handle: "acme.ig", auth: { ...pageAuth, igUserId: "IG1" }, config: { pageId: "P1" } };
const base = (o: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v", text: "hello", media: [], thread: [], idempotencyKey: `k-${Math.random()}`, ...o });
const img = (url = "https://cdn.example/a.jpg") => ({ kind: "image" as const, url, mime: "image/jpeg" });
const vid = (url = "https://cdn.example/v.mp4", extra: Record<string, unknown> = {}) => ({ kind: "video" as const, url, mime: "video/mp4", durationSeconds: 20, ...extra });

async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return e as ConnectorError;
  }
  throw new Error("expected rejection");
}

describe("meta connect", () => {
  it("is configured only with app id and secret, and builds a Login for Business authorize URL", () => {
    expect(createMetaConnectors({})[0]!.connectConfigured).toBe(false);
    const [c] = createMetaConnectors({ META_CLIENT_ID: "app1", META_CLIENT_SECRET: "s", META_LOGIN_CONFIG_ID: "cfg9", META_GRAPH_VERSION: "v25.0" });
    expect(c!.connectConfigured).toBe(true);
    expect(c!.name).toBe("meta");
    expect(c!.networks).toEqual(["facebook", "instagram"]);
    const u = new URL(c!.oauthAuthorizeUrl!({ state: "st", codeChallenge: "ch", redirectUri: "https://app/oauth/meta/callback" }));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth");
    expect(u.searchParams.get("client_id")).toBe("app1");
    expect(u.searchParams.get("config_id")).toBe("cfg9");
    expect(u.searchParams.get("scope")).toContain("pages_manage_posts,pages_read_engagement");
    expect(u.searchParams.get("scope")).toContain("instagram_content_publish");
  });

  it("exchanges for a long-lived token and returns every Page and linked Instagram account", async () => {
    const r = router([
      ["POST", /\/oauth\/access_token$/, () => ({ access_token: "SHORT", token_type: "bearer", expires_in: 3600 })],
      ["GET", /\/oauth\/access_token$/, (q) => (q.url.searchParams.get("fb_exchange_token") === "SHORT" ? { access_token: "LONG", expires_in: 5_184_000 } : { error: { code: 190 } })],
      ["GET", /\/me$/, () => ({ id: "U1", name: "Ann" })],
      ["POST", /\/P1\/subscribed_apps$/, () => ({ success: true })],
      ["POST", /\/P2\/subscribed_apps$/, () => json({ error: { code: 200, message: "needs pages_manage_metadata" } }, 403)],
      [
        "GET",
        /\/me\/accounts$/,
        (q) =>
          q.url.searchParams.get("after") === "c2"
            ? { data: [{ id: "P3", name: "No token page", tasks: ["ANALYZE"] }] }
            : {
                data: [
                  { id: "P1", name: "Acme", username: "acme", access_token: "PT1", tasks: ["CREATE_CONTENT"], instagram_business_account: { id: "IG1", username: "acme.ig", name: "Acme IG" } },
                  { id: "P2", name: "Beta", access_token: "PT2" },
                ],
                paging: { next: `https://graph.facebook.com/${V}/me/accounts?after=c2` },
              },
      ],
    ]);
    const accounts = await make(r.fetch).oauthConnect({ code: "CODE", codeVerifier: "x", redirectUri: "https://app/cb" });
    expect(accounts.map((a) => [a.network, a.identity.externalId, a.identity.handle])).toEqual([
      ["facebook", "P1", "acme"],
      ["instagram", "IG1", "acme.ig"],
      ["facebook", "P2", "P2"],
    ]);
    expect(accounts[0]!.auth).toEqual({ pageAccessToken: "PT1", pageId: "P1", userAccessToken: "LONG", userId: "U1", userTokenExpiresAt: "2027-01-02T12:00:00.000Z" });
    expect(accounts[0]!.auth).not.toHaveProperty("expiresAt"); // Page tokens do not expire; core must not refresh on a timer
    expect(accounts[1]!.auth).toMatchObject({ igUserId: "IG1", pageAccessToken: "PT1" });
    expect(accounts[1]!.config).toEqual({ pageId: "P1" });
    expect(accounts[0]!.config).toMatchObject({ pageId: "P1", igUserId: "IG1", webhooksSubscribed: true });
    expect(accounts[2]!.config).toMatchObject({ webhooksSubscribed: false });
    expect(r.find("POST", /\/P1\/subscribed_apps$/)[0]!.json()).toEqual({ subscribed_fields: "feed,mention" });
    expect(r.find("POST", /\/P1\/subscribed_apps$/)[0]!.headers.authorization).toBe("Bearer PT1");
    const exchange = r.calls[0]!;
    expect(String(exchange.body)).toContain("code=CODE");
    expect(String(exchange.body)).toContain("client_secret=secret");
    // Graph calls carry the token as a bearer header plus appsecret_proof.
    const me = r.find("GET", /^\/me$/)[0]!;
    expect(me.headers.authorization).toBe("Bearer LONG");
    expect(me.url.searchParams.get("appsecret_proof")).toBe(createHmac("sha256", "secret").update("LONG").digest("hex"));
  });

  it("fails clearly when the login granted no Pages", async () => {
    const r = router([
      ["POST", /\/oauth\/access_token$/, () => ({ access_token: "S" })],
      ["GET", /\/oauth\/access_token$/, () => ({ access_token: "L" })],
      ["GET", /\/me$/, () => ({ id: "U1" })],
      ["GET", /\/me\/accounts$/, () => ({ data: [] })],
    ]);
    expect(await rejection(make(r.fetch).oauthConnect({ code: "c", codeVerifier: "", redirectUri: "r" }))).toMatchObject({ kind: "auth" });
  });

  it("describes Page and Instagram accounts from their auth blobs", async () => {
    const r = router([
      ["GET", /\/IG1$/, () => ({ id: "IG1", username: "acme.ig", name: "Acme" })],
      ["GET", /\/P1$/, () => ({ id: "P1", username: "acme", name: "Acme Page" })],
    ]);
    const c = make(r.fetch);
    expect(await c.describeAccount({ ...pageAuth, igUserId: "IG1" })).toEqual({ externalId: "IG1", handle: "acme.ig", displayName: "Acme" });
    expect(await c.describeAccount(pageAuth)).toEqual({ externalId: "P1", handle: "acme", displayName: "Acme Page" });
    await expect(c.describeAccount({})).rejects.toMatchObject({ kind: "auth" });
  });

  it("refreshAuth re-extends the user token and re-derives the Page token; null without a user token", async () => {
    const r = router([
      ["GET", /\/oauth\/access_token$/, () => ({ access_token: "ULL2", expires_in: 86400 })],
      ["GET", /\/P1$/, (q) => (q.headers.authorization === "Bearer ULL2" ? { access_token: "PT-NEW", id: "P1" } : { error: { code: 190 } })],
    ]);
    const c = make(r.fetch);
    const out = await c.refreshAuth(fb);
    expect(out?.auth).toMatchObject({ pageAccessToken: "PT-NEW", userAccessToken: "ULL2", userTokenExpiresAt: "2026-11-04T12:00:00.000Z", pageId: "P1" });
    expect(await c.refreshAuth({ ...fb, auth: { pageAccessToken: "PT", pageId: "P1" } })).toBeNull();
    const dead = router([["GET", /\/oauth\/access_token$/, () => json({ error: { code: 190, message: "expired" } }, 400)]]);
    expect(await make(dead.fetch).refreshAuth(fb)).toBeNull();
  });
});

describe("facebook publish", () => {
  it("publishes text and link posts to the Page feed", async () => {
    const r = router([["POST", /\/P1\/feed$/, () => ({ id: "P1_100" })]]);
    const c = make(r.fetch);
    expect(await c.publish(fb, base())).toMatchObject({ externalId: "P1_100", url: "https://www.facebook.com/P1_100" });
    await c.publish(fb, base({ options: { kind: "link", link: "https://acme.example/x" } }));
    expect(r.calls[0]!.json()).toEqual({ message: "hello" });
    expect(r.calls[0]!.headers.authorization).toBe("Bearer PT");
    expect(r.calls[1]!.json()).toEqual({ message: "hello", link: "https://acme.example/x" });
  });

  it("publishes one photo, and several photos as unpublished uploads attached to one feed post", async () => {
    let n = 0;
    const r = router([
      ["POST", /\/P1\/photos$/, () => ({ id: `ph${++n}`, ...(n === 1 ? { post_id: "P1_200" } : {}) })],
      ["POST", /\/P1\/feed$/, () => ({ id: "P1_300" })],
    ]);
    const c = make(r.fetch);
    expect((await c.publish(fb, base({ media: [img()] }))).externalId).toBe("P1_200");
    expect(r.calls[0]!.json()).toEqual({ url: "https://cdn.example/a.jpg", caption: "hello" });
    const multi = await c.publish(fb, base({ media: [img("https://cdn.example/1.jpg"), { ...img("https://cdn.example/2.jpg"), alt: "two" }] }));
    expect(multi.externalId).toBe("P1_300");
    expect(r.calls[1]!.json()).toEqual({ url: "https://cdn.example/1.jpg", published: false });
    expect(r.calls[2]!.json()).toMatchObject({ published: false, alt_text_custom: "two" });
    expect(r.calls[3]!.json()).toEqual({ message: "hello", attached_media: [{ media_fbid: "ph2" }, { media_fbid: "ph3" }] });
  });

  it("publishes video by file_url, and large video through the resumable upload API", async () => {
    const r = router([
      ["POST", /\/P1\/videos$/, () => ({ id: "VID1" })],
      ["POST", /\/app1\/uploads$/, () => ({ id: "upload:SESSION" })],
      ["POST", /\/upload:SESSION$/, () => ({ h: "HANDLE" })],
    ]);
    const c = make(r.fetch, { resumableThresholdBytes: 10 });
    c.media = { fetch: async () => ({ bytes: new Uint8Array(32), mime: "video/mp4" }) };
    const small = await c.publish(fb, base({ media: [vid()], options: { title: "T" } }));
    expect(small).toMatchObject({ externalId: "VID1", url: "https://www.facebook.com/P1/videos/VID1" });
    expect(r.calls[0]!.json()).toEqual({ description: "hello", title: "T", file_url: "https://cdn.example/v.mp4" });
    await c.publish(fb, base({ media: [vid("https://cdn.example/big.mp4", { bytes: 32 })] }));
    const session = r.find("POST", /\/app1\/uploads$/)[0]!;
    expect(session.url.searchParams.get("file_length")).toBe("32");
    expect(session.headers.authorization).toBe("Bearer ULL"); // sessions belong to the user token
    const upload = r.find("POST", /upload:SESSION$/)[0]!;
    expect(upload.headers).toMatchObject({ authorization: "OAuth ULL", file_offset: "0" });
    expect(r.find("POST", /\/P1\/videos$/)[1]!.json()).toMatchObject({ fbuploader_video_file_chunk: "HANDLE" });
  });

  it("publishes reels through start → rupload by URL → finish, and photo/video stories", async () => {
    let statusCalls = 0;
    const r = router([
      ["POST", /\/P1\/video_reels$/, (q) => (q.json().upload_phase === "start" ? { video_id: "R1", upload_url: "https://rupload.facebook.com/video-upload/v26.0/R1" } : { success: true })],
      ["POST", /rupload\.facebook\.com\/video-upload/, () => ({ success: true })],
      ["GET", /\/R1$/, () => ({ status: { video_status: ++statusCalls < 2 ? "processing" : "ready" } })],
      ["POST", /\/P1\/photos$/, () => ({ id: "PH9" })],
      ["POST", /\/P1\/photo_stories$/, () => ({ success: true, post_id: "STORY1" })],
      ["POST", /\/P1\/video_stories$/, (q) => (q.json().upload_phase === "start" ? { video_id: "VS1" } : { success: true, post_id: "STORY2" })],
      ["POST", /rupload\.facebook\.com/, () => ({ success: true })],
      ["GET", /\/VS1$/, () => ({ status: { video_status: "ready" } })],
    ]);
    const c = make(r.fetch);
    const reel = await c.publish(fb, base({ media: [vid()], options: { kind: "reel" } }));
    expect(reel).toMatchObject({ externalId: "R1", url: "https://www.facebook.com/reel/R1" });
    const up = r.calls.find((x) => x.url.host === "rupload.facebook.com")!;
    expect(up.headers).toMatchObject({ authorization: "OAuth PT", file_url: "https://cdn.example/v.mp4" });
    expect(r.find("POST", /video_reels$/)[1]!.json()).toEqual({ upload_phase: "finish", video_id: "R1", video_state: "PUBLISHED", description: "hello" });
    expect(statusCalls).toBe(2);

    expect((await c.publish(fb, base({ media: [img()], options: { kind: "story" } }))).externalId).toBe("STORY1");
    expect(r.find("POST", /photo_stories$/)[0]!.json()).toEqual({ photo_id: "PH9" });
    expect((await c.publish(fb, base({ media: [vid()], options: { kind: "story" } }))).externalId).toBe("STORY2");
    expect(r.calls.some((x) => x.url.href === `https://rupload.facebook.com/video-upload/${V}/VS1`)).toBe(true);
  });

  it("surfaces a reel processing error as rejected", async () => {
    const r = router([
      ["POST", /\/P1\/video_reels$/, (q) => (q.json().upload_phase === "start" ? { video_id: "R2" } : { success: true })],
      ["POST", /rupload/, () => ({ success: true })],
      ["GET", /\/R2$/, () => ({ status: { video_status: "error", processing_phase: { status: "error", error: { message: "bad codec" } } } })],
    ]);
    const e = await rejection(make(r.fetch).publish(fb, base({ media: [vid()], options: { kind: "reel" } })));
    expect(e.kind).toBe("rejected");
    expect(e.message).toContain("bad codec");
  });

  it("leaves firstComment to core (posted via reply) and dedupes retries by idempotency key", async () => {
    let posts = 0;
    const r = router([["POST", /\/P1\/feed$/, () => (++posts === 1 ? json({ error: { code: 2, message: "Service temporarily unavailable", is_transient: true } }, 500) : { id: "P1_500" })]]);
    const c = make(r.fetch);
    const input = base({ options: { firstComment: "link in bio" } });
    expect(await rejection(c.publish(fb, input))).toMatchObject({ kind: "network", retryable: true });
    expect((await c.publish(fb, input)).externalId).toBe("P1_500");
    expect((await c.publish(fb, input)).externalId).toBe("P1_500"); // cached
    expect(r.calls).toHaveLength(2);
    expect(r.calls.some((x) => x.path.endsWith("/comments"))).toBe(false);
  });
});

describe("instagram publish", () => {
  const quota = (usage = 3) => ({ data: [{ quota_usage: usage, config: { quota_total: 100, quota_duration: 86400 } }] });

  it("publishes a single image: quota check, container, status poll, media_publish, permalink; first comment via reply", async () => {
    let polls = 0;
    const r = router([
      ["GET", /\/IG1\/content_publishing_limit$/, () => quota()],
      ["POST", /\/IG1\/media$/, () => ({ id: "CONT1" })],
      ["GET", /\/CONT1$/, () => ({ status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" })],
      ["POST", /\/IG1\/media_publish$/, () => ({ id: "M1" })],
      ["GET", /\/M1$/, () => ({ permalink: "https://www.instagram.com/p/abc/" })],
      ["POST", /\/M1\/comments$/, () => ({ id: "C1" })],
    ]);
    const conn = make(r.fetch);
    const res = await conn.publish(ig, base({ media: [{ ...img(), alt: "a cat" }], options: { firstComment: "#tags" } }));
    expect(res).toMatchObject({ externalId: "M1", url: "https://www.instagram.com/p/abc/" });
    expect(r.find("POST", /\/IG1\/media$/)[0]!.json()).toEqual({ image_url: "https://cdn.example/a.jpg", caption: "hello", alt_text: "a cat" });
    expect(polls).toBe(3);
    expect(r.find("POST", /media_publish$/)[0]!.json()).toEqual({ creation_id: "CONT1" });
    expect(r.find("POST", /\/M1\/comments$/)).toHaveLength(0); // core posts it through reply()
    const c2 = await conn.reply(ig, { parentExternalId: "M1", text: "#tags", idempotencyKey: "fc" });
    expect(c2.externalId).toBe("C1");
    expect(r.find("POST", /\/M1\/comments$/)[0]!.json()).toEqual({ message: "#tags" }); // known media: straight to /comments
  });

  it("publishes a mixed carousel: child containers (video children polled), then the CAROUSEL container", async () => {
    let n = 0;
    const r = router([
      ["GET", /content_publishing_limit$/, () => quota()],
      ["POST", /\/IG1\/media$/, (q) => ({ id: q.json().media_type === "CAROUSEL" ? "CAR" : `CH${++n}` })],
      ["GET", /\/(CH\d|CAR)$/, () => ({ status_code: "FINISHED" })],
      ["POST", /media_publish$/, () => ({ id: "M2" })],
      ["GET", /\/M2$/, () => ({ permalink: "https://www.instagram.com/p/car/" })],
    ]);
    const res = await make(r.fetch).publish(ig, base({ media: [img(), vid()], options: { kind: "carousel" } }));
    expect(res.externalId).toBe("M2");
    const creates = r.find("POST", /\/IG1\/media$/).map((c) => c.json());
    expect(creates[0]).toEqual({ image_url: "https://cdn.example/a.jpg", is_carousel_item: true });
    expect(creates[1]).toEqual({ media_type: "VIDEO", video_url: "https://cdn.example/v.mp4", is_carousel_item: true });
    expect(creates[2]).toEqual({ media_type: "CAROUSEL", children: "CH1,CH2", caption: "hello" });
  });

  it("publishes reels (single videos) and stories", async () => {
    const r = router([
      ["GET", /content_publishing_limit$/, () => quota()],
      ["POST", /\/IG1\/media$/, () => ({ id: "C" })],
      ["GET", /\/C$/, () => ({ status_code: "FINISHED" })],
      ["POST", /media_publish$/, () => ({ id: "M3" })],
      ["GET", /\/M3$/, () => ({ permalink: "https://www.instagram.com/reel/x/" })],
    ]);
    const c = make(r.fetch);
    await c.publish(ig, base({ media: [vid()], options: { kind: "reel", thumbnailUrl: "https://cdn.example/cover.jpg" } }));
    await c.publish(ig, base({ media: [vid()] }));
    await c.publish(ig, base({ text: "", media: [img()], options: { kind: "story" } }));
    await c.publish(ig, base({ text: "", media: [vid()], options: { kind: "story" } }));
    const bodies = r.find("POST", /\/IG1\/media$/).map((x) => x.json());
    expect(bodies[0]).toEqual({ media_type: "REELS", video_url: "https://cdn.example/v.mp4", caption: "hello", share_to_feed: true, cover_url: "https://cdn.example/cover.jpg" });
    expect(bodies[1]).toMatchObject({ media_type: "REELS" });
    expect(bodies[2]).toEqual({ media_type: "STORIES", image_url: "https://cdn.example/a.jpg" });
    expect(bodies[3]).toEqual({ media_type: "STORIES", video_url: "https://cdn.example/v.mp4" });
  });

  it("refuses with a retryable rate_limit when the 24h publishing quota is spent", async () => {
    const r = router([["GET", /content_publishing_limit$/, () => quota(100)]]);
    const e = await rejection(make(r.fetch).publish(ig, base({ media: [img()] })));
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(r.calls).toHaveLength(1);
  });

  it("gives a retryable error while the container is still processing and reuses it on retry", async () => {
    let ready = false;
    const r = router([
      ["GET", /content_publishing_limit$/, () => quota()],
      ["POST", /\/IG1\/media$/, () => ({ id: "SLOW" })],
      ["GET", /\/SLOW$/, () => ({ status_code: ready ? "FINISHED" : "IN_PROGRESS" })],
      ["POST", /media_publish$/, () => ({ id: "M4" })],
      ["GET", /\/M4$/, () => ({})],
    ]);
    const c = make(r.fetch, { maxPolls: 3 });
    const input = base({ media: [vid()], options: { kind: "reel" } });
    const e = await rejection(c.publish(ig, input));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    expect(e.message).toMatch(/still processing/);
    expect(r.find("GET", /\/SLOW$/)).toHaveLength(3);
    ready = true;
    expect(await c.publish(ig, input)).toMatchObject({ externalId: "M4", url: null });
    expect(r.find("POST", /\/IG1\/media$/)).toHaveLength(1);
  });

  it("maps a container ERROR to rejected and makes a new container on the next attempt", async () => {
    let n = 0;
    const r = router([
      ["GET", /content_publishing_limit$/, () => quota()],
      ["POST", /\/IG1\/media$/, () => ({ id: `E${++n}` })],
      ["GET", /\/E1$/, () => ({ status_code: "ERROR", status: "Error: unsupported aspect ratio" })],
      ["GET", /\/E2$/, () => ({ status_code: "FINISHED" })],
      ["POST", /media_publish$/, () => ({ id: "M5" })],
      ["GET", /\/M5$/, () => ({})],
    ]);
    const c = make(r.fetch);
    const input = base({ media: [img()] });
    expect(await rejection(c.publish(ig, input))).toMatchObject({ kind: "rejected", retryable: false });
    expect((await c.publish(ig, input)).externalId).toBe("M5");
  });

  it("maps the media_publish limit error (code 9 / 2207042) to rate_limit", async () => {
    const r = router([
      ["GET", /content_publishing_limit$/, () => json({ error: { code: 100 } }, 400)],
      ["POST", /\/IG1\/media$/, () => ({ id: "X" })],
      ["GET", /\/X$/, () => ({ status_code: "FINISHED" })],
      ["POST", /media_publish$/, () => json({ error: { code: 9, error_subcode: 2207042, message: "limit" } }, 400)],
    ]);
    expect(await rejection(make(r.fetch).publish(ig, base({ media: [img()] })))).toMatchObject({ kind: "rate_limit", retryable: true });
  });
});

describe("validate", () => {
  const c = make(router([]).fetch);
  it("checks instagram media rules", () => {
    const codes = (i: PublishInput) => c.validate(ig, i).map((x) => x.code);
    expect(codes(base())).toContain("media_required");
    expect(codes(base({ media: [img()], thread: ["more"] }))).toContain("thread_unsupported");
    expect(codes(base({ media: [{ kind: "gif", url: "https://cdn.example/a.gif" }] }))).toContain("unsupported_media");
    expect(codes(base({ media: [{ ...img(), mime: "image/png" }] }))).toContain("unsupported_media");
    expect(codes(base({ media: [{ ...img(), width: 1080, height: 1920 }] }))).toContain("unsupported_media");
    expect(codes(base({ media: [img()], options: { kind: "carousel" } }))).toContain("media_required");
    expect(codes(base({ media: [img(), img()], options: { kind: "story" } }))).toContain("too_many_media");
    expect(codes(base({ media: [vid("https://cdn.example/v.mp4", { durationSeconds: 120 })], options: { kind: "story" } }))).toContain("unsupported_media");
    expect(codes(base({ text: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" "), media: [img()] }))).toContain("too_long");
    expect(codes(base({ media: [img(), vid()] }))).toEqual([]);
  });
  it("checks facebook kind rules", () => {
    const codes = (i: PublishInput) => c.validate(fb, i).map((x) => x.code);
    expect(codes(base({ media: [img()], options: { kind: "reel" } }))).toContain("media_required");
    expect(codes(base({ media: [vid("https://cdn.example/v.mp4", { durationSeconds: 200 })], options: { kind: "reel" } }))).toContain("unsupported_media");
    expect(codes(base({ media: [img(), vid()] }))).toContain("unsupported_media");
    expect(codes(base({ options: { kind: "story" } }))).toContain("media_required");
    expect(codes(base({ media: [img(), img()] }))).toEqual([]);
  });
  it("rejects invalid input at publish time without calling the network", async () => {
    const r = router([]);
    expect(await rejection(make(r.fetch).publish(ig, base()))).toMatchObject({ kind: "rejected" });
    expect(r.calls).toHaveLength(0);
  });
});

describe("inbox", () => {
  it("reads facebook comments on recent posts and posts tagging the Page", async () => {
    const r = router([
      [
        "GET",
        /\/P1\/published_posts$/,
        () => ({
          data: [
            {
              id: "P1_1",
              message: "our post",
              created_time: "2026-11-01T10:00:00+0000",
              permalink_url: "https://www.facebook.com/P1_1",
              comments: {
                data: [
                  { id: "P1_1_c2", message: "new comment", from: { id: "F1", name: "Fan" }, created_time: "2026-11-03T09:00:00+0000", permalink_url: "https://fb/c2" },
                  { id: "P1_1_c3", message: "a reply", from: { id: "F2", name: "Other" }, created_time: "2026-11-03T09:30:00+0000", parent: { id: "P1_1_c2" } },
                  { id: "P1_1_c4", message: "page reply", from: { id: "P1", name: "Acme" }, created_time: "2026-11-03T09:40:00+0000" },
                  { id: "P1_1_c1", message: "old", from: { id: "F1" }, created_time: "2026-10-01T09:00:00+0000" },
                ],
              },
            },
          ],
        }),
      ],
      ["GET", /\/P1\/tagged$/, () => ({ data: [{ id: "X_9", message: "love @acme", from: { id: "F3", name: "Tagger" }, created_time: "2026-11-03T08:00:00+0000" }] })],
    ]);
    const items = await make(r.fetch).fetchActivity(fb, new Date("2026-11-02T00:00:00Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.parentExternalId])).toEqual([
      ["mention", "X_9", null],
      ["comment", "P1_1_c2", "P1_1"],
      ["comment", "P1_1_c3", "P1_1_c2"],
    ]);
    expect(items[1]).toMatchObject({ network: "facebook", authorName: "Fan", text: "new comment", url: "https://fb/c2", occurredAt: "2026-11-03T09:00:00.000Z" });
    expect(items[1]!.raw).toBeTruthy();
    const all = await make(r.fetch).fetchActivity(fb, null);
    expect(all.some((i) => i.kind === "own_post" && i.externalId === "P1_1")).toBe(true);
  });

  it("reads instagram comments, replies and tags", async () => {
    const r = router([
      [
        "GET",
        /\/IG1\/media$/,
        () => ({
          data: [
            {
              id: "M1",
              caption: "post",
              timestamp: "2026-11-02T10:00:00+0000",
              permalink: "https://www.instagram.com/p/m1/",
              comments: {
                data: [
                  {
                    id: "C1",
                    text: "nice",
                    username: "fan",
                    from: { id: "F1", username: "fan" },
                    timestamp: "2026-11-03T10:00:00+0000",
                    replies: { data: [{ id: "C2", text: "thanks", username: "acme.ig", from: { id: "IG1" }, timestamp: "2026-11-03T10:05:00+0000" }, { id: "C3", text: "+1", username: "fan2", timestamp: "2026-11-03T10:06:00+0000" }] },
                  },
                ],
              },
            },
          ],
        }),
      ],
      ["GET", /\/IG1\/tags$/, () => ({ data: [{ id: "T1", caption: "with @acme.ig", username: "friend", timestamp: "2026-11-03T07:00:00+0000", permalink: "https://www.instagram.com/p/t1/" }] })],
    ]);
    const items = await make(r.fetch).fetchActivity(ig, new Date("2026-11-03T00:00:00Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.parentExternalId, i.authorHandle])).toEqual([
      ["mention", "T1", null, "friend"],
      ["comment", "C1", "M1", "fan"],
      ["reply", "C3", "C1", "fan2"],
    ]);
    expect(r.calls[0]!.url.searchParams.get("fields")).toContain("replies.limit(50)");
  });
});

describe("reply and moderate", () => {
  it("replies on facebook via /comments and on instagram via /replies, falling back to /comments for media", async () => {
    const r = router([
      ["POST", /\/P1_1_c2\/comments$/, () => ({ id: "P1_1_c9" })],
      ["POST", /\/C1\/replies$/, () => ({ id: "C10" })],
      ["POST", /\/M1\/replies$/, () => json({ error: { code: 100, message: "Unsupported post request" } }, 400)],
      ["POST", /\/M1\/comments$/, () => ({ id: "C11" })],
    ]);
    const c = make(r.fetch);
    expect((await c.reply(fb, { parentExternalId: "P1_1_c2", text: "thanks!", idempotencyKey: "r1" })).externalId).toBe("P1_1_c9");
    expect(r.calls[0]!.json()).toEqual({ message: "thanks!" });
    expect((await c.reply(ig, { parentExternalId: "C1", text: "ty", idempotencyKey: "r2" })).externalId).toBe("C10");
    expect((await c.reply(ig, { parentExternalId: "M1", text: "hi", idempotencyKey: "r3" })).externalId).toBe("C11");
    await c.reply(fb, { parentExternalId: "P1_1_c2", text: "thanks!", idempotencyKey: "r1" });
    expect(r.find("POST", /P1_1_c2/)).toHaveLength(1);
  });

  it("hides, unhides, deletes and likes facebook comments; hides and deletes instagram comments", async () => {
    const r = router([
      ["POST", /\/c1$/, () => ({ success: true })],
      ["DELETE", /\/c1$/, () => ({ success: true })],
      ["POST", /\/c1\/likes$/, () => ({ success: true })],
      ["DELETE", /\/c1\/likes$/, () => ({ success: true })],
    ]);
    const c = make(r.fetch);
    await c.moderate(fb, { externalId: "c1", action: "hide" });
    await c.moderate(fb, { externalId: "c1", action: "unhide" });
    await c.moderate(fb, { externalId: "c1", action: "like" });
    await c.moderate(fb, { externalId: "c1", action: "unlike" });
    await c.moderate(fb, { externalId: "c1", action: "delete" });
    await c.moderate(ig, { externalId: "c1", action: "hide" });
    await c.moderate(ig, { externalId: "c1", action: "delete" });
    expect(r.calls.map((x) => `${x.method} ${x.path} ${x.body ?? ""}`)).toEqual([
      'POST /c1 {"is_hidden":true}',
      'POST /c1 {"is_hidden":false}',
      "POST /c1/likes ",
      "DELETE /c1/likes ",
      "DELETE /c1 ",
      'POST /c1 {"hide":true}',
      "DELETE /c1 ",
    ]);
    expect(await rejection(c.moderate(ig, { externalId: "c1", action: "like" }))).toMatchObject({ kind: "rejected" });
  });
});

describe("metrics", () => {
  it("maps facebook post insights, falling back per metric when a metric name is retired", async () => {
    const r = router([
      ["GET", /\/P1_1$/, () => ({ shares: { count: 4 }, reactions: { summary: { total_count: 10 } }, comments: { summary: { total_count: 3 } } })],
      [
        "GET",
        /\/P1_1\/insights$/,
        (q) => {
          const m = q.url.searchParams.get("metric")!;
          if (m.includes(",") || m === "post_video_views") return json({ error: { code: 100, message: "(#100) The value must be a valid insights metric" } }, 400);
          const values: Record<string, unknown> = { post_media_view: 900, post_total_media_view_unique: 700, post_clicks: 50, post_clicks_by_type: { "link clicks": 20, "photo view": 5 }, post_video_view_time: 12_500 };
          return { data: [{ name: m, period: "lifetime", values: [{ value: values[m] }] }] };
        },
      ],
    ]);
    const c = make(r.fetch);
    const rows = await c.fetchMetrics(fb, ["P1_1"]);
    const m = Object.fromEntries(rows.map((x) => [x.metric, x.value]));
    expect(m).toEqual({ likes: 10, replies: 3, shares: 4, impressions: 900, reach: 700, clicks: 50, link_clicks: 20, watch_time_seconds: 13, engagements: 17 });
    expect(rows.every((x) => x.entityType === "post_variant" && x.entityId === "P1_1" && x.source === "facebook")).toBe(true);
    // The retired metric is remembered: the next fetch does not ask for it again.
    const before = r.calls.length;
    await c.fetchMetrics(fb, ["P1_1"]);
    const again = r.calls.slice(before).map((x) => x.url.searchParams.get("metric")).filter(Boolean);
    expect(again.join(",")).not.toContain("post_video_views");
  });

  it("maps instagram reel insights (views, not impressions/plays) and feed insights", async () => {
    const r = router([
      ["GET", /\/R1$/, () => ({ id: "R1", media_type: "VIDEO", media_product_type: "REELS", like_count: 5, comments_count: 2 })],
      [
        "GET",
        /\/R1\/insights$/,
        (q) => ({
          data: q.url.searchParams
            .get("metric")!
            .split(",")
            .map((name) => ({ name, period: "lifetime", values: [{ value: { views: 1000, reach: 800, likes: 50, comments: 7, shares: 3, saved: 9, total_interactions: 69, ig_reels_video_view_total_time: 45_000 }[name] ?? 0 }] })),
        }),
      ],
    ]);
    const rows = await make(r.fetch).fetchMetrics(ig, ["R1"]);
    const m = Object.fromEntries(rows.map((x) => [x.metric, x.value]));
    expect(m).toEqual({ impressions: 1000, video_views: 1000, reach: 800, likes: 50, replies: 7, shares: 3, saves: 9, engagements: 69, watch_time_seconds: 45 });
    const asked = r.find("GET", /\/R1\/insights$/)[0]!.url.searchParams.get("metric")!;
    expect(asked).not.toMatch(/impressions|plays/);
  });

  it("reads followers and reach for Pages and Instagram accounts", async () => {
    const r = router([
      ["GET", /\/P1$/, () => ({ followers_count: 5000, fan_count: 4800 })],
      ["GET", /\/P1\/insights$/, () => ({ data: [{ name: "page_media_view", period: "day", values: [{ value: 10 }, { value: 120 }] }, { name: "page_total_media_view_unique", period: "day", values: [{ value: 90 }] }] })],
      ["GET", /\/IG1$/, () => ({ followers_count: 321, media_count: 40 })],
      ["GET", /\/IG1\/insights$/, (q) => (q.url.searchParams.get("metric_type") === "total_value" ? { data: [{ name: "reach", period: "day", total_value: { value: 77 } }, { name: "views", total_value: { value: 300 } }] } : json({ error: { code: 100 } }, 400))],
    ]);
    const c = make(r.fetch);
    const page = Object.fromEntries((await c.fetchAccountMetrics(fb)).map((x) => [x.metric, x.value]));
    expect(page).toEqual({ followers_total: 5000, impressions: 120, reach: 90 });
    const igRows = await c.fetchAccountMetrics(ig);
    expect(Object.fromEntries(igRows.map((x) => [x.metric, x.value]))).toEqual({ followers_total: 321, reach: 77, impressions: 300 });
    expect(igRows[0]).toMatchObject({ entityType: "social_account", entityId: "acc-ig", source: "instagram" });
  });
});

describe("webhooks", () => {
  const c = make(router([]).fetch);
  it("answers the hub.challenge handshake only with the right verify token", () => {
    expect(c.webhook.challenge!({ "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "1158201444" })).toBe("1158201444");
    expect(c.webhook.challenge!({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" })).toBeNull();
    expect(c.webhook.challenge!({ "hub.mode": "unsubscribe", "hub.verify_token": "vt", "hub.challenge": "1" })).toBeNull();
    expect(new MetaConnector({}).webhook.challenge!({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" })).toBeNull();
  });

  it("verifies X-Hub-Signature-256 with the app secret", () => {
    const raw = JSON.stringify({ object: "page", entry: [] });
    const sig = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
    expect(c.webhook.verify({ "x-hub-signature-256": sig }, raw)).toBe(true);
    expect(c.webhook.verify({ "x-hub-signature-256": sig }, `${raw} `)).toBe(false);
    expect(c.webhook.verify({ "x-hub-signature-256": "sha256=00" }, raw)).toBe(false);
    expect(c.webhook.verify({}, raw)).toBe(false);
    expect(new MetaConnector({}).webhook.verify({ "x-hub-signature-256": sig }, raw)).toBe(false);
  });

  it("parses Page feed comments and mentions, routed by Page id", () => {
    const batches = c.webhook.parse({
      object: "page",
      entry: [
        {
          id: "P1",
          time: 1762171200,
          changes: [
            { field: "feed", value: { item: "comment", verb: "add", comment_id: "P1_1_c5", post_id: "P1_1", parent_id: "P1_1", message: "hello page", from: { id: "F1", name: "Fan" }, created_time: 1762171100 } },
            { field: "feed", value: { item: "comment", verb: "remove", comment_id: "P1_1_c6", post_id: "P1_1" } },
            { field: "feed", value: { item: "comment", verb: "add", comment_id: "P1_1_c7", post_id: "P1_1", from: { id: "P1", name: "Acme" } } },
            { field: "feed", value: { item: "reaction", verb: "add", post_id: "P1_1" } },
            { field: "mention", value: { item: "post", verb: "add", post_id: "Z_1", sender_name: "Zed", message: "hey @Acme" } },
          ],
        },
        { id: "P2", time: 1762171200, changes: [{ field: "feed", value: { item: "status", verb: "add", post_id: "P2_9", message: "visitor post", from: { id: "F9", name: "Visitor" } } }] },
      ],
    });
    expect(batches.map((b) => [b.network, b.accountExternalId, b.items.map((i) => [i.kind, i.externalId, i.parentExternalId])])).toEqual([
      ["facebook", "P1", [["comment", "P1_1_c5", "P1_1"], ["mention", "Z_1", null]]],
      ["facebook", "P2", [["mention", "P2_9", null]]],
    ]);
    expect(batches[0]!.items[0]).toMatchObject({ authorName: "Fan", text: "hello page", occurredAt: "2025-11-03T11:58:20.000Z" });
  });

  it("parses Instagram comments and mentions, routed by IG user id", () => {
    const batches = parseMetaWebhook(
      {
        object: "instagram",
        entry: [
          {
            id: "IG1",
            time: 1762171200,
            changes: [
              { field: "comments", value: { id: "C7", text: "great", from: { id: "F1", username: "fan" }, media: { id: "M1", media_product_type: "FEED" } } },
              { field: "comments", value: { id: "C8", text: "ty", from: { id: "IG1", username: "acme.ig" }, media: { id: "M1" } } },
              { field: "comments", value: { id: "C9", text: "re", from: { id: "F2", username: "fan2" }, media: { id: "M1" }, parent_id: "C7" } },
              { field: "mentions", value: { media_id: "M77", comment_id: "C77" } },
              { field: "mentions", value: { media_id: "M78" } },
            ],
          },
        ],
      },
      NOW,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.network).toBe("instagram");
    expect(batches[0]!.accountExternalId).toBe("IG1");
    expect(batches[0]!.items.map((i) => [i.kind, i.externalId, i.parentExternalId, i.authorHandle])).toEqual([
      ["comment", "C7", "M1", "fan"],
      ["reply", "C9", "C7", "fan2"],
      ["mention", "C77", "M77", null],
      ["mention", "M78", null, null],
    ]);
    expect(parseMetaWebhook({ object: "user", entry: [] }, NOW)).toEqual([]);
    expect(parseMetaWebhook(null, NOW)).toEqual([]);
  });
});

describe("error mapping", () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  it("classifies Graph error codes", () => {
    expect(mapGraphError("meta", "x", 400, h(), { error: { code: 190, message: "Error validating access token" } })).toMatchObject({ kind: "auth", retryable: false });
    expect(mapGraphError("meta", "x", 403, h(), { error: { code: 200, message: "Permissions error" } })).toMatchObject({ kind: "auth" });
    expect(mapGraphError("meta", "x", 400, h(), { error: { code: 10 } })).toMatchObject({ kind: "auth" });
    const rl = mapGraphError("meta", "x", 400, h({ "x-business-use-case-usage": JSON.stringify({ P1: [{ type: "pages", call_count: 100, estimated_time_to_regain_access: 5 }] }) }), { error: { code: 32, message: "Page request limit reached" } });
    expect(rl).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(rl.message).toContain("retry after ~300s");
    expect(mapGraphError("meta", "x", 400, h(), { error: { code: 4 } })).toMatchObject({ kind: "rate_limit" });
    expect(mapGraphError("meta", "x", 429, h(), {})).toMatchObject({ kind: "rate_limit" });
    expect(mapGraphError("meta", "x", 400, h(), { error: { code: 1, message: "unknown" } })).toMatchObject({ kind: "network", retryable: true });
    expect(mapGraphError("meta", "x", 400, h(), { error: { code: 100, is_transient: true } })).toMatchObject({ kind: "network", retryable: true });
    expect(mapGraphError("meta", "x", 503, h(), "<html>")).toMatchObject({ kind: "network", retryable: true });
    expect(mapGraphError("meta", "x", 400, h(), { error: { code: 100, message: "Invalid parameter" } })).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapGraphError("meta", "x", 400, h(), { error: { code: 506, message: "Duplicate status message" } })).toMatchObject({ kind: "rejected" });
  });

  it("turns transport failures into retryable network errors", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await rejection(make(f).publish(fb, base()))).toMatchObject({ kind: "network", retryable: true });
  });

  it("rejects accounts without a usable auth blob", async () => {
    expect(await rejection(make(router([]).fetch).publish({ ...fb, auth: null }, base()))).toMatchObject({ kind: "auth" });
  });
});
