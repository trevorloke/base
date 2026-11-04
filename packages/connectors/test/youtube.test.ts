import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { YouTubeConnector, YouTubeQuota, createYouTubeConnectors, pacificDay, probeMp4, type YouTubeConnectorOptions } from "../src/youtube.ts";
import { mapGoogleError } from "../src/google-oauth.ts";

const NOW = new Date("2026-11-03T18:00:00.000Z"); // 10:00 Pacific
const KIB = 1024;

const acct: AccountRef = {
  id: "acc-yt",
  workspaceId: "w",
  network: "youtube",
  externalId: "UCchan",
  handle: "acme",
  auth: { accessToken: "tok", refreshToken: "ref", expiresAt: "2026-11-03T19:00:00.000Z", channelId: "UCchan" },
  config: { channelId: "UCchan" },
};

const VIDEO = { kind: "video" as const, url: "https://media.example/v.mp4", mime: "video/mp4" };

function input(over: Partial<PublishInput> = {}, options: PublishInput["options"] = {}): PublishInput {
  return { variantId: "v1", text: "Launch video description", media: [VIDEO], thread: [], idempotencyKey: "k1", options: { title: "Launch day", ...options }, ...over };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[];

function route(handler: Handler) {
  fetchMock.mockImplementation(async (u, init = {}) => {
    const url = new URL(String(u));
    calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    return handler(url, init);
  });
}

const callsTo = (pathPart: string, method?: string) => calls.filter((c) => c.url.pathname.includes(pathPart) && (!method || c.method === method));

async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return e as ConnectorError;
  }
  throw new Error("expected the promise to reject");
}

const sleeps: number[] = [];
function connector(opts: YouTubeConnectorOptions = {}, bytes: Uint8Array = new Uint8Array(600 * KIB)) {
  const c = new YouTubeConnector({ clientId: "cid", clientSecret: "secret", now: () => NOW, sleep: async (ms) => void sleeps.push(ms), chunkSize: 256 * KIB, processingIntervalMs: 1, ...opts });
  c.media = { fetch: async (m) => (m.kind === "image" ? { bytes: new Uint8Array(1000), mime: "image/jpeg" } : { bytes, mime: "video/mp4" }) };
  return c;
}

/** Minimal MP4: ftyp + moov(mvhd duration, trak/tkhd width x height, optional 90° rotation). */
function mp4(seconds: number, width: number, height: number, rotate90 = false): Uint8Array {
  const box = (type: string, body: number[]) => {
    const size = 8 + body.length;
    return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...Buffer.from(type), ...body];
  };
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const mvhd = box("mvhd", [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1000), ...u32(seconds * 1000), ...new Array(80).fill(0)]);
  const one = 0x00010000;
  const minusOne = 0xffff0000;
  const matrix = rotate90 ? [0, one, 0, minusOne, 0, 0, 0, 0, 0x40000000] : [one, 0, 0, 0, one, 0, 0, 0, 0x40000000];
  const tkhd = box("tkhd", [0, 0, 0, 3, ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0, ...matrix.flatMap(u32), ...u32(width * 65536), ...u32(height * 65536)]);
  return Uint8Array.from([...box("ftyp", [...Buffer.from("isom"), 0, 0, 0, 0]), ...box("moov", [...mvhd, ...box("trak", tkhd)]), ...new Array(1000).fill(0)]);
}

const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION";

/** Happy-path YouTube: initiate → chunks (308s) → 201, thumbnail ok, processing done on the 2nd poll. */
function happyRoutes(over: { processing?: string[]; privacy?: string; chunk?: (c: Call, n: number) => Response | null } = {}): Handler {
  let chunkCount = 0;
  let polls = 0;
  return (url, init) => {
    const method = init.method ?? "GET";
    if (url.pathname === "/upload/youtube/v3/videos" && method === "POST") return empty(200, { location: UPLOAD_URL });
    if (url.toString() === UPLOAD_URL && method === "PUT") {
      const range = (init.headers as Record<string, string>)["content-range"]!;
      const custom = over.chunk?.(calls.at(-1)!, chunkCount++);
      if (custom) return custom;
      const m = range.match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (!m) return empty(308, { range: "bytes=0-524287" });
      if (Number(m[2]) + 1 >= Number(m[3])) return json({ id: "dQw4w9WgXcQ", status: { privacyStatus: "public", uploadStatus: "uploaded" } }, 201);
      return empty(308, { range: `bytes=0-${m[2]}` });
    }
    if (url.pathname === "/upload/youtube/v3/thumbnails/set") return json({ items: [{}] });
    if (url.pathname === "/youtube/v3/videos" && method === "GET") {
      const seq = over.processing ?? ["processing", "succeeded"];
      const status = seq[Math.min(polls++, seq.length - 1)];
      return json({ items: [{ id: "dQw4w9WgXcQ", status: { uploadStatus: status === "succeeded" ? "processed" : "uploaded", privacyStatus: over.privacy ?? "public" }, processingDetails: { processingStatus: status } }] });
    }
    throw new Error(`unrouted ${method} ${url}`);
  };
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  calls = [];
  sleeps.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("youtube connect", () => {
  it("builds a Google authorize URL with offline access, consent prompt, PKCE and the four scopes", () => {
    const u = new URL(connector().oauthAuthorizeUrl({ state: "st", codeChallenge: "cc", redirectUri: "https://app/oauth/youtube/callback" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("code_challenge")).toBe("cc");
    expect(u.searchParams.get("scope")!.split(" ")).toEqual([
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ]);
  });

  it("is not configured without GOOGLE_CLIENT_ID/SECRET", () => {
    expect(createYouTubeConnectors({})[0]!.connectConfigured).toBe(false);
    const [c] = createYouTubeConnectors({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" });
    expect(c!.connectConfigured).toBe(true);
    expect(c!.name).toBe("youtube");
    expect(c!.networks).toEqual(["youtube"]);
  });

  it("exchanges the code and returns every channel the login manages", async () => {
    route((url) => {
      if (url.toString() === "https://oauth2.googleapis.com/token") return json({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "s" });
      if (url.pathname === "/youtube/v3/channels") {
        expect(url.searchParams.get("mine")).toBe("true");
        return json({ items: [
          { id: "UC1", snippet: { title: "Acme", customUrl: "@acme" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } },
          { id: "UC2", snippet: { title: "Acme Brand" } },
        ] });
      }
      throw new Error(`unrouted ${url}`);
    });
    const accts = await connector().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "https://app/cb" });
    expect(accts.map((a) => a.identity)).toEqual([
      { externalId: "UC1", handle: "acme", displayName: "Acme" },
      { externalId: "UC2", handle: "Acme Brand", displayName: "Acme Brand" },
    ]);
    expect(accts[0]!.auth).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: "2026-11-03T18:59:59.000Z", scope: "s", channelId: "UC1" });
    expect(accts[0]!.config).toEqual({ channelId: "UC1", uploadsPlaylistId: "UU1" });
    const token = new URLSearchParams(String(calls[0]!.body));
    expect(Object.fromEntries(token)).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v", client_id: "cid", client_secret: "secret" });
    expect(calls[1]!.headers.authorization).toBe("Bearer at");
  });

  it("describes an account from its auth blob", async () => {
    route((url) => {
      expect(url.searchParams.get("id")).toBe("UCchan");
      return json({ items: [{ id: "UCchan", snippet: { title: "Acme", customUrl: "@acme" } }] });
    });
    expect(await connector().describeAccount({ accessToken: "tok", channelId: "UCchan" })).toEqual({ externalId: "UCchan", handle: "acme", displayName: "Acme" });
  });

  it("refreshes the access token and keeps the refresh token and channel", async () => {
    route(() => json({ access_token: "new", expires_in: 3600 }));
    const r = await connector().refreshAuth(acct);
    expect(r!.auth).toEqual({ accessToken: "new", refreshToken: "ref", expiresAt: "2026-11-03T19:00:00.000Z", channelId: "UCchan" });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.body)))).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref" });
    expect(await connector().refreshAuth({ ...acct, auth: { accessToken: "x", channelId: "UCchan" } })).toBeNull();
  });

  it("maps a revoked refresh token to an auth error", async () => {
    route(() => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    const e = await rejection(connector().refreshAuth(acct));
    expect(e.kind).toBe("auth");
    expect(e.message).toMatch(/revoked/);
  });
});

describe("youtube validate", () => {
  const c = connector();
  it("requires a title, one video, and YouTube privacy values", () => {
    expect(c.validate(acct, input({}, { title: "" })).map((i) => i.code)).toContain("empty");
    expect(c.validate(acct, input({}, { title: "x".repeat(101) })).map((i) => i.code)).toContain("too_long");
    expect(c.validate(acct, input({ media: [] })).map((i) => i.code)).toContain("media_required");
    expect(c.validate(acct, input({ media: [{ kind: "image", url: "https://m/i.png" }] }))[0]!.message).toMatch(/exactly one video/);
    expect(c.validate(acct, input({}, { privacy: "friends" }))[0]!.message).toMatch(/public, unlisted or private/);
    expect(c.validate(acct, input({}, { title: "<b>bold</b>" }))[0]!.message).toMatch(/< and >/);
    expect(c.validate(acct, input())).toEqual([]);
  });

  it("checks Shorts duration and aspect from media metadata", () => {
    const short = (m: Partial<typeof VIDEO & { width: number; height: number; durationSeconds: number }>) => c.validate(acct, input({ media: [{ ...VIDEO, ...m }] }, { kind: "short" }));
    expect(short({ width: 1080, height: 1920, durationSeconds: 59 })).toEqual([]);
    expect(short({ width: 1080, height: 1080, durationSeconds: 180 })).toEqual([]);
    expect(short({ width: 1080, height: 1920, durationSeconds: 181 })[0]!.message).toMatch(/at most 180 s/);
    expect(short({ width: 1920, height: 1080, durationSeconds: 30 })[0]!.message).toMatch(/vertical or square/);
  });
});

describe("mp4 probe", () => {
  it("reads duration and dimensions, applying a 90° rotation", () => {
    expect(probeMp4(mp4(42, 1080, 1920))).toEqual({ durationSeconds: 42, width: 1080, height: 1920 });
    expect(probeMp4(mp4(10, 1920, 1080, true))).toEqual({ durationSeconds: 10, width: 1080, height: 1920 });
    expect(probeMp4(new Uint8Array(20))).toEqual({});
  });
});

describe("youtube publish (resumable upload)", () => {
  it("opens a session, uploads in chunks, resumes on 308 and after a 503, sets the thumbnail and waits for processing", async () => {
    route(happyRoutes({ chunk: (_c, n) => (n === 1 ? empty(503) : null) }));
    const c = connector();
    const res = await c.publish(acct, input({}, { privacy: "unlisted", tags: ["launch", "acme"], thumbnailUrl: "https://media.example/thumb.jpg" }));

    expect(res.externalId).toBe("dQw4w9WgXcQ");
    expect(res.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(res.raw).toMatchObject({ processing: "succeeded", thumbnail: { ok: true } });

    const init = callsTo("/upload/youtube/v3/videos", "POST")[0]!;
    expect(init.url.searchParams.get("uploadType")).toBe("resumable");
    expect(init.url.searchParams.get("part")).toBe("snippet,status");
    expect(init.url.searchParams.get("notifySubscribers")).toBe("true");
    expect(init.headers["x-upload-content-length"]).toBe(String(600 * KIB));
    expect(init.headers["x-upload-content-type"]).toBe("video/mp4");
    expect(JSON.parse(String(init.body))).toEqual({
      snippet: { title: "Launch day", description: "Launch video description", tags: ["launch", "acme"], categoryId: "22" },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, embeddable: true },
    });

    const puts = calls.filter((x) => x.url.toString() === UPLOAD_URL).map((x) => x.headers["content-range"]);
    expect(puts).toEqual([
      "bytes 0-262143/614400",
      "bytes 262144-524287/614400", // 503
      "bytes */614400", // status query after the 503 → 308 Range bytes=0-524287
      "bytes 524288-614399/614400",
    ]);
    expect(sleeps[0]).toBe(1000);
    const thumb = callsTo("/thumbnails/set")[0]!;
    expect(thumb.url.searchParams.get("videoId")).toBe("dQw4w9WgXcQ");
    expect(thumb.headers["content-type"]).toBe("image/jpeg");
    expect(callsTo("/youtube/v3/videos", "GET")).toHaveLength(2);
    expect(c.quota.usage()).toMatchObject({ uploads: 1, units: 50 + 2 });
  });

  it("does not upload twice for the same idempotency key", async () => {
    route(happyRoutes());
    const c = connector();
    const [a, b] = await Promise.all([c.publish(acct, input()), c.publish(acct, input())]);
    expect(a).toEqual(b);
    expect(callsTo("/upload/youtube/v3/videos", "POST")).toHaveLength(1);
  });

  it("publishes a Short after probing a vertical file and returns the shorts URL", async () => {
    route(happyRoutes({ processing: ["succeeded"] }));
    const c = connector({}, mp4(45, 1080, 1920));
    const res = await c.publish(acct, input({}, { kind: "short" }));
    expect(res.url).toBe("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  });

  it("refuses a Short whose file is landscape even when metadata was missing", async () => {
    route(happyRoutes());
    const e = await rejection(connector({}, mp4(45, 1920, 1080)).publish(acct, input({}, { kind: "short" })));
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/vertical or square/);
    expect(calls).toHaveLength(0);
  });

  it("returns success with processing still running after the bounded wait", async () => {
    route(happyRoutes({ processing: ["processing"] }));
    const res = await connector({ processingPolls: 3 }).publish(acct, input());
    expect(res.raw).toMatchObject({ processing: "processing" });
    expect(callsTo("/youtube/v3/videos", "GET")).toHaveLength(3);
  });

  it("flags videos YouTube locked private (unverified API project)", async () => {
    route(happyRoutes({ processing: ["succeeded"], privacy: "private" }));
    const res = await connector().publish(acct, input());
    expect((res.raw as { warning: string }).warning).toMatch(/compliance audit/);
  });

  it("fails a rejected video with the video id as partial, and a retry polls again without re-uploading", async () => {
    let rejected = true;
    const base = happyRoutes({ processing: ["succeeded"] });
    route((url, init) => {
      if (url.pathname === "/youtube/v3/videos" && (init.method ?? "GET") === "GET" && rejected) {
        return json({ items: [{ id: "dQw4w9WgXcQ", status: { uploadStatus: "uploaded" }, processingDetails: { processingStatus: "processing" } }] }, 503);
      }
      return base(url, init);
    });
    const c = connector();
    const e = await rejection(c.publish(acct, input({ idempotencyKey: "k-retry" })));
    expect(e.kind).toBe("network");
    expect(e.retryable).toBe(true);
    expect(e.partial).toEqual({ externalId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", threadExternalIds: [] });
    rejected = false;
    const ok = await c.publish(acct, input({ idempotencyKey: "k-retry" }));
    expect(ok.externalId).toBe("dQw4w9WgXcQ");
    expect(callsTo("/upload/youtube/v3/videos", "POST")).toHaveLength(1);
  });

  it("maps processing rejection to a rejected error", async () => {
    const base = happyRoutes();
    route((url, init) => {
      if (url.pathname === "/youtube/v3/videos" && (init.method ?? "GET") === "GET") return json({ items: [{ id: "dQw4w9WgXcQ", status: { uploadStatus: "rejected", rejectionReason: "duplicate" } }] });
      return base(url, init);
    });
    const e = await rejection(connector().publish(acct, input()));
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/duplicate/);
    expect(e.partial?.externalId).toBe("dQw4w9WgXcQ");
  });

  it("gives up after repeated 5xx with a retryable error and resumes the same session on retry", async () => {
    let fail = true;
    const base = happyRoutes({ processing: ["succeeded"] });
    route((url, init) => {
      if (url.toString() === UPLOAD_URL && fail) {
        const range = (init.headers as Record<string, string>)["content-range"];
        return range === "bytes */614400" ? empty(308, { range: "bytes=0-262143" }) : range === "bytes 0-262143/614400" ? empty(308, { range: "bytes=0-262143" }) : empty(500);
      }
      return base(url, init);
    });
    const c = connector({ maxChunkRetries: 2 });
    const e = await rejection(c.publish(acct, input({ idempotencyKey: "k-5xx" })));
    expect(e.kind).toBe("network");
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/resumes the same session/);
    fail = false;
    calls = [];
    await c.publish(acct, input({ idempotencyKey: "k-5xx" }));
    expect(callsTo("/upload/youtube/v3/videos", "POST")).toHaveLength(0); // resumed, not re-initiated
    expect(calls[0]!.headers["content-range"]).toBe("bytes */614400");
  });

  it("restarts the upload when the session expired", async () => {
    route((url) => (url.toString() === UPLOAD_URL ? empty(404) : empty(200, { location: UPLOAD_URL })));
    const e = await rejection(connector().publish(acct, input()));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    expect(e.message).toMatch(/session expired/);
  });

  it("reports a refused thumbnail without failing the publish", async () => {
    const base = happyRoutes({ processing: ["succeeded"] });
    route((url, init) => (url.pathname.endsWith("/thumbnails/set") ? json({ error: { code: 403, message: "The authenticated user doesn't have permissions to upload and set custom video thumbnails.", errors: [{ reason: "forbidden" }] } }, 403) : base(url, init)));
    const res = await connector().publish(acct, input({}, { thumbnailUrl: "https://media.example/t.jpg" }));
    expect((res.raw as { thumbnail: { ok: boolean; error: string } }).thumbnail).toMatchObject({ ok: false, error: expect.stringMatching(/custom video thumbnails/) });
  });

  it("surfaces Google's quotaExceeded as rate_limit and fails fast afterwards", async () => {
    route(() => json({ error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }] } }, 403));
    const c = connector({ quota: { dailyUploads: null } });
    const e = await rejection(c.publish(acct, input()));
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(e.message).toMatch(/exceeded your quota/);
    expect(e.message).toMatch(/midnight Pacific/);
    const n = calls.length;
    const again = await rejection(c.publish(acct, input({ idempotencyKey: "k2" })));
    expect(again.kind).toBe("rate_limit");
    expect(calls.length).toBe(n); // refused locally
  });

  it("enforces the daily upload bucket locally", async () => {
    route(happyRoutes({ processing: ["succeeded"] }));
    const c = connector({ quota: { dailyUploads: 1 } });
    await c.publish(acct, input());
    const e = await rejection(c.publish(acct, input({ idempotencyKey: "k2" })));
    expect(e.kind).toBe("rate_limit");
    expect(e.message).toMatch(/1 video uploads for today are used/);
  });

  it("validates before uploading", async () => {
    const e = await rejection(connector().publish(acct, input({}, { title: "" })));
    expect(e.kind).toBe("rejected");
    expect(calls).toHaveLength(0);
  });
});

describe("youtube quota", () => {
  it("charges the legacy upload cost to the default pool and rolls over at midnight Pacific", () => {
    let now = new Date("2026-11-04T07:30:00Z"); // 23:30 Pacific on Nov 3
    const q = new YouTubeQuota({ dailyUploads: null, dailyUnits: 2000 }, () => now);
    q.chargeUpload();
    expect(q.usage()).toMatchObject({ day: "2026-11-03", units: 1600 });
    expect(() => q.chargeUpload()).toThrow(/resets at midnight Pacific \(in about 0h30m\)/);
    now = new Date("2026-11-04T08:01:00Z");
    expect(q.usage()).toMatchObject({ day: "2026-11-04", units: 0 });
    expect(pacificDay(new Date("2026-07-01T06:59:00Z"))).toBe("2026-06-30");
  });
});

describe("youtube comments", () => {
  it("replies to a video with a new comment thread (first comment)", async () => {
    route(() => json({ id: "UgThread1", snippet: { videoId: "dQw4w9WgXcQ" } }));
    const res = await connector().reply(acct, { parentExternalId: "dQw4w9WgXcQ", text: "Links below!", idempotencyKey: "v1:first-comment" });
    expect(res).toMatchObject({ externalId: "UgThread1", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&lc=UgThread1" });
    expect(calls[0]!.url.pathname).toBe("/youtube/v3/commentThreads");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ snippet: { videoId: "dQw4w9WgXcQ", topLevelComment: { snippet: { textOriginal: "Links below!" } } } });
  });

  it("replies to a comment (and to a reply, on its thread) with comments.insert", async () => {
    route(() => json({ id: "UgThread1.reply2", snippet: { parentId: "UgThread1" } }));
    const c = connector();
    await c.reply(acct, { parentExternalId: "UgThread1.reply1", text: "Thanks!", idempotencyKey: "r1" });
    expect(calls[0]!.url.pathname).toBe("/youtube/v3/comments");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ snippet: { parentId: "UgThread1", textOriginal: "Thanks!" } });
    await c.reply(acct, { parentExternalId: "UgThread1.reply1", text: "Thanks!", idempotencyKey: "r1" });
    expect(calls).toHaveLength(1);
  });

  it("moderates: hide holds for review, unhide publishes, delete falls back to reject, likes are refused", async () => {
    route((url, init) => {
      if (url.pathname === "/youtube/v3/comments" && init.method === "DELETE") return json({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, 403);
      return empty(204);
    });
    const c = connector();
    await c.moderate(acct, { externalId: "Ug1", action: "hide" });
    await c.moderate(acct, { externalId: "Ug1", action: "unhide" });
    await c.moderate(acct, { externalId: "Ug1", action: "delete" });
    const statuses = callsTo("/setModerationStatus").map((x) => x.url.searchParams.get("moderationStatus"));
    expect(statuses).toEqual(["heldForReview", "published", "rejected"]);
    expect(callsTo("/youtube/v3/comments", "DELETE")[0]!.url.searchParams.get("id")).toBe("Ug1");
    expect((await rejection(c.moderate(acct, { externalId: "Ug1", action: "like" }))).kind).toBe("rejected");
  });

  it("maps comment threads and replies to activity, skipping the channel's own comments and old items", async () => {
    route((url) => {
      const status = url.searchParams.get("moderationStatus");
      expect(url.searchParams.get("allThreadsRelatedToChannelId")).toBe("UCchan");
      if (status === "heldForReview") {
        return json({ items: [{ id: "UgHeld", snippet: { videoId: "vid00000001", topLevelComment: { id: "UgHeld", snippet: { textOriginal: "spam?", authorDisplayName: "@bot", publishedAt: "2026-11-02T10:00:00Z", moderationStatus: "heldForReview" } } } }] });
      }
      return json({
        items: [
          {
            id: "UgT1",
            snippet: { videoId: "vid00000001", topLevelComment: { id: "UgT1", snippet: { textOriginal: "Great video", authorDisplayName: "@fan", authorChannelId: { value: "UCfan" }, publishedAt: "2026-11-02T09:00:00Z" } } },
            replies: { comments: [
              { id: "UgT1.r1", snippet: { textOriginal: "Thanks!", authorChannelId: { value: "UCchan" }, publishedAt: "2026-11-02T09:30:00Z" } },
              { id: "UgT1.r2", snippet: { textOriginal: "Agreed", authorDisplayName: "Pat", authorChannelId: { value: "UCpat" }, publishedAt: "2026-11-02T11:00:00Z" } },
            ] },
          },
          { id: "UgOld", snippet: { videoId: "vid00000001", topLevelComment: { id: "UgOld", snippet: { textOriginal: "old", authorDisplayName: "@old", publishedAt: "2026-10-01T00:00:00Z" } } } },
        ],
        nextPageToken: "more",
      });
    });
    const items = await connector().fetchActivity(acct, new Date("2026-11-01T00:00:00Z"));
    expect(items.map((i) => [i.kind, i.externalId, i.parentExternalId])).toEqual([
      ["comment", "UgT1", "vid00000001"],
      ["comment", "UgHeld", "vid00000001"],
      ["reply", "UgT1.r2", "UgT1"],
    ]);
    expect(items[0]).toMatchObject({ network: "youtube", authorHandle: "fan", authorName: "@fan", text: "Great video", url: "https://www.youtube.com/watch?v=vid00000001&lc=UgT1", occurredAt: "2026-11-02T09:00:00Z" });
    expect((items[1]!.raw as { moderationStatus: string }).moderationStatus).toBe("heldForReview");
    expect(items[2]!.authorHandle).toBeNull();
    // stopped paging once threads were older than `since`
    expect(callsTo("/commentThreads").filter((x) => x.url.searchParams.get("moderationStatus") === "published")).toHaveLength(1);
  });
});

describe("youtube metrics", () => {
  it("combines videos.list statistics with Analytics API totals", async () => {
    route((url) => {
      if (url.pathname === "/youtube/v3/videos") {
        expect(url.searchParams.get("id")).toBe("dQw4w9WgXcQ,abcdefghijk");
        return json({ items: [
          { id: "dQw4w9WgXcQ", snippet: { publishedAt: "2026-10-01T12:00:00Z" }, statistics: { viewCount: "1000", likeCount: "50", commentCount: "7" } },
          { id: "abcdefghijk", snippet: { publishedAt: "2026-10-20T12:00:00Z" }, statistics: { viewCount: "10" } },
        ] });
      }
      if (url.host === "youtubeanalytics.googleapis.com") {
        expect(url.searchParams.get("ids")).toBe("channel==MINE");
        expect(url.searchParams.get("startDate")).toBe("2026-10-01");
        expect(url.searchParams.get("endDate")).toBe("2026-11-03");
        expect(url.searchParams.get("dimensions")).toBe("video");
        expect(url.searchParams.get("filters")).toBe("video==dQw4w9WgXcQ,abcdefghijk");
        return json({
          columnHeaders: [{ name: "video" }, { name: "views" }, { name: "estimatedMinutesWatched" }, { name: "likes" }, { name: "comments" }, { name: "shares" }, { name: "subscribersGained" }],
          rows: [["dQw4w9WgXcQ", 990, 120.5, 49, 7, 3, 2]],
        });
      }
      throw new Error(`unrouted ${url}`);
    });
    const rows = await connector().fetchMetrics(acct, ["dQw4w9WgXcQ", "abcdefghijk", "not-a-video-id-at-all"]);
    const of = (id: string) => Object.fromEntries(rows.filter((r) => r.entityId === id).map((r) => [r.metric, r.value]));
    expect(of("dQw4w9WgXcQ")).toEqual({ video_views: 1000, likes: 50, replies: 7, watch_time_seconds: 7230, shares: 3, follows: 2, engagements: 60 });
    expect(of("abcdefghijk")).toEqual({ video_views: 10 });
    expect(rows.every((r) => r.entityType === "post_variant" && r.source === "youtube" && r.observedAt === NOW.toISOString())).toBe(true);
  });

  it("keeps Data API numbers when Analytics refuses (scope not granted)", async () => {
    route((url) => {
      if (url.host === "youtubeanalytics.googleapis.com") return json({ error: { code: 403, status: "PERMISSION_DENIED", message: "Forbidden" } }, 403);
      return json({ items: [{ id: "dQw4w9WgXcQ", statistics: { viewCount: "5", likeCount: "1", commentCount: "0" } }] });
    });
    const rows = await connector().fetchMetrics(acct, ["dQw4w9WgXcQ"]);
    expect(rows.map((r) => r.metric)).toEqual(["video_views", "likes", "replies", "engagements"]);
  });

  it("reports subscribers as followers_total", async () => {
    route(() => json({ items: [{ id: "UCchan", statistics: { subscriberCount: "12345", viewCount: "999999", hiddenSubscriberCount: false } }] }));
    const rows = await connector().fetchAccountMetrics(acct);
    expect(rows.map((r) => [r.entityType, r.entityId, r.metric, r.value])).toEqual([
      ["social_account", "acc-yt", "followers_total", 12345],
      ["social_account", "acc-yt", "video_views", 999999],
    ]);
  });
});

describe("google error mapping", () => {
  const h = new Headers({ "retry-after": "30" });
  it("maps statuses and reasons to ConnectorError kinds", () => {
    expect(mapGoogleError(401, new Headers(), { error: { code: 401, status: "UNAUTHENTICATED" } }, { what: "t" })).toMatchObject({ kind: "auth", retryable: false });
    expect(mapGoogleError(403, new Headers(), { error: { errors: [{ reason: "insufficientPermissions" }] } }, { what: "t", creating: true })).toMatchObject({ kind: "auth" });
    expect(mapGoogleError(403, new Headers(), { error: { errors: [{ reason: "commentsDisabled" }] } }, { what: "t" })).toMatchObject({ kind: "rejected" });
    expect(mapGoogleError(403, new Headers(), { error: { errors: [{ reason: "rateLimitExceeded" }] } }, { what: "t" })).toMatchObject({ kind: "rate_limit", retryable: true });
    const r = mapGoogleError(429, h, { error: { status: "RESOURCE_EXHAUSTED" } }, { what: "t", rateHint: "hint" });
    expect(r).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(r.message).toMatch(/retry after 30s; hint/);
    expect(mapGoogleError(400, new Headers(), { error: { errors: [{ reason: "invalidTitle" }] } }, { what: "t" })).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapGoogleError(503, new Headers(), "<html>", { what: "t" })).toMatchObject({ kind: "network", retryable: true });
  });

  it("maps a 401 from the API and transport failures", async () => {
    route(() => json({ error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } }, 401));
    expect((await rejection(connector().fetchAccountMetrics(acct))).kind).toBe("auth");
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await rejection(connector().fetchAccountMetrics(acct))).toMatchObject({ kind: "network", retryable: true });
  });

  it("refuses an account without credentials", async () => {
    expect((await rejection(connector().fetchActivity({ ...acct, auth: null }, null))).kind).toBe("auth");
  });
});
