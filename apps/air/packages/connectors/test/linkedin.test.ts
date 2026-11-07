import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { LINKEDIN_DEFAULT_VERSION, LinkedInConnector, createLinkedInConnectors, escapeLittleText, mapLinkedInError, parseCommentUrn, parseLinkedInWebhook } from "../src/linkedin.ts";

const NOW = new Date("2026-11-02T00:00:00.000Z");
const AUTH = { accessToken: "tok", refreshToken: "ref", expiresAt: "2026-12-01T00:00:00.000Z", refreshExpiresAt: "2027-06-01T00:00:00.000Z", personUrn: "urn:li:person:abc" };

const org: AccountRef = { id: "acc-org", workspaceId: "w", network: "linkedin", externalId: "urn:li:organization:42", handle: "acme", auth: AUTH, config: { authorUrn: "urn:li:organization:42", kind: "organization" } };
const member: AccountRef = { id: "acc-me", workspaceId: "w", network: "linkedin", externalId: "urn:li:person:abc", handle: "ada@example.com", auth: AUTH, config: { authorUrn: "urn:li:person:abc", kind: "member" } };
const input: PublishInput = { variantId: "v1", text: "Hello LinkedIn", media: [], thread: [], idempotencyKey: "k1" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let routes: [string, RegExp | string, Handler][];

/** Route by "METHOD url-prefix-or-regex"; the first match wins and may be consumed with `once`. */
function on(method: string, match: RegExp | string, handler: Handler | Response | unknown) {
  const h: Handler = typeof handler === "function" ? (handler as Handler) : handler instanceof Response ? () => handler.clone() : () => json(handler);
  routes.push([method, match, h]);
}

function calls(method?: string, match?: string | RegExp) {
  return fetchMock.mock.calls
    .map(([u, init]) => ({ url: String(u), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body }))
    .filter((c) => (!method || c.method === method) && (!match || (typeof match === "string" ? c.url.startsWith(match) : match.test(c.url))));
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
    const hit = routes.find(([m, match]) => m === method && (typeof match === "string" ? url.startsWith(match) : match.test(url)));
    if (!hit) throw new Error(`unexpected ${method} ${url}`);
    return hit[2](url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const API = "https://api.linkedin.com";
const connector = (opts: ConstructorParameters<typeof LinkedInConnector>[0] = {}) =>
  new LinkedInConnector({ clientId: "cid", clientSecret: "secret", now: () => NOW, sleep: async () => {}, ...opts });

describe("linkedin connect", () => {
  it("builds the authorize URL with member + organization scopes and reports configuration", () => {
    const c = connector();
    const url = new URL(c.oauthAuthorizeUrl({ state: "s1", codeChallenge: "ch", redirectUri: "https://app.example/oauth/linkedin/callback" }));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("scope")).toBe("openid profile email w_member_social w_organization_social r_organization_social rw_organization_admin r_organization_admin");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(c.connectConfigured).toBe(true);
    expect(new LinkedInConnector({}).connectConfigured).toBe(false);
    expect(new LinkedInConnector({ clientId: "cid" }).connectConfigured).toBe(false);
  });

  it("connects the member and every administered organization with one login", async () => {
    on("POST", "https://www.linkedin.com/oauth/v2/accessToken", { access_token: "tok", expires_in: 5184000, refresh_token: "ref", refresh_token_expires_in: 31536000, scope: "openid,profile" });
    on("GET", `${API}/v2/userinfo`, { sub: "abc", name: "Ada Lovelace", email: "ada@example.com" });
    on("GET", `${API}/rest/organizationAcls`, { elements: [{ organization: "urn:li:organization:42", role: "ADMINISTRATOR", state: "APPROVED" }, { organization: "urn:li:organization:7" }], paging: { total: 2 } });
    on("GET", `${API}/rest/organizations/42`, { localizedName: "Acme", vanityName: "acme" });
    on("GET", `${API}/rest/organizations/7`, { localizedName: "Beta", vanityName: "beta-co" });

    const accounts = await connector().oauthConnect({ code: "code1", codeVerifier: "v", redirectUri: "https://app.example/oauth/linkedin/callback" });

    expect(accounts.map((a) => a.identity)).toEqual([
      { externalId: "urn:li:person:abc", handle: "ada@example.com", displayName: "Ada Lovelace" },
      { externalId: "urn:li:organization:42", handle: "acme", displayName: "Acme" },
      { externalId: "urn:li:organization:7", handle: "beta-co", displayName: "Beta" },
    ]);
    expect(accounts.map((a) => a.config)).toEqual([
      { authorUrn: "urn:li:person:abc", kind: "member" },
      { authorUrn: "urn:li:organization:42", kind: "organization", organizationId: "42" },
      { authorUrn: "urn:li:organization:7", kind: "organization", organizationId: "7" },
    ]);
    expect(accounts[1]!.auth).toEqual({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: "2027-01-01T00:00:00.000Z",
      refreshExpiresAt: "2027-11-02T00:00:00.000Z",
      scope: "openid,profile",
      personUrn: "urn:li:person:abc",
    });
    const token = calls("POST", "https://www.linkedin.com")[0]!;
    const form = new URLSearchParams(String(token.body));
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("client_secret")).toBe("secret");
    expect(form.get("code")).toBe("code1");
    const acl = calls("GET", `${API}/rest/organizationAcls`)[0]!;
    expect(acl.url).toContain("q=roleAssignee&role=ADMINISTRATOR&state=APPROVED");
    expect(acl.headers["linkedin-version"]).toBe(LINKEDIN_DEFAULT_VERSION);
    expect(acl.headers["x-restli-protocol-version"]).toBe("2.0.0");
  });

  it("connects only the member when the app has no organization access", async () => {
    on("POST", "https://www.linkedin.com/oauth/v2/accessToken", { access_token: "tok", expires_in: 5184000 });
    on("GET", `${API}/v2/userinfo`, { sub: "abc", given_name: "Ada", family_name: "L" });
    on("GET", `${API}/rest/organizationAcls`, json({ status: 403, message: "Not enough permissions" }, 403));
    const accounts = await connector().oauthConnect({ code: "c", codeVerifier: "v", redirectUri: "https://r" });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.identity).toEqual({ externalId: "urn:li:person:abc", handle: "Ada L", displayName: "Ada L" });
    expect(accounts[0]!.auth).not.toHaveProperty("refreshToken");
  });

  it("describes the member behind an auth blob", async () => {
    on("GET", `${API}/v2/userinfo`, { sub: "abc", name: "Ada", email: "ada@example.com" });
    expect(await connector().describeAccount({ accessToken: "tok" })).toEqual({ externalId: "urn:li:person:abc", handle: "ada@example.com", displayName: "Ada" });
    expect(calls()[0]!.headers.authorization).toBe("Bearer tok");
  });
});

describe("linkedin refresh", () => {
  it("returns null without a programmatic refresh token (60-day tokens)", async () => {
    expect(await connector().refreshAuth({ ...org, auth: { accessToken: "tok", personUrn: "urn:li:person:abc" } })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the refresh token itself has expired", async () => {
    expect(await connector().refreshAuth({ ...org, auth: { ...AUTH, refreshExpiresAt: "2026-01-01T00:00:00.000Z" } })).toBeNull();
  });

  it("refreshes and keeps the original refresh-token expiry", async () => {
    on("POST", "https://www.linkedin.com/oauth/v2/accessToken", { access_token: "tok2", expires_in: 5184000, refresh_token: "ref" });
    const r = await connector().refreshAuth(org);
    expect(r?.auth).toEqual({ accessToken: "tok2", refreshToken: "ref", expiresAt: "2027-01-01T00:00:00.000Z", refreshExpiresAt: AUTH.refreshExpiresAt, personUrn: AUTH.personUrn });
    const form = new URLSearchParams(String(calls()[0]!.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("ref");
  });

  it("maps a dead refresh token to an auth error", async () => {
    on("POST", "https://www.linkedin.com/oauth/v2/accessToken", json({ error: "invalid_request", error_description: "token revoked" }, 400));
    const e = await rejection(connector().refreshAuth(org));
    expect(e.kind).toBe("auth");
  });
});

describe("linkedin publish", () => {
  const created = (urn = "urn:li:share:900") => json(undefined, 201, { "x-restli-id": urn });

  it("posts text as the organization, escaping little-format characters, once per idempotency key", async () => {
    on("POST", `${API}/rest/posts`, () => created());
    const c = connector();
    const res = await c.publish(org, { ...input, text: "Big news (finally) @team #launch" });
    expect(res).toEqual({ externalId: "urn:li:share:900", url: "https://www.linkedin.com/feed/update/urn:li:share:900/", raw: { id: "urn:li:share:900", media: [] } });
    const body = jsonBody(calls("POST", `${API}/rest/posts`)[0]!);
    expect(body).toEqual({
      author: "urn:li:organization:42",
      commentary: "Big news \\(finally\\) \\@team #launch",
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
    await c.publish(org, { ...input, text: "Big news (finally) @team #launch" });
    expect(calls("POST", `${API}/rest/posts`)).toHaveLength(1);
  });

  it("publishes a link as an article card", async () => {
    on("POST", `${API}/rest/posts`, () => created());
    await connector().publish(member, { ...input, options: { link: "https://acme.example/post", title: "Read this" } });
    const body = jsonBody(calls("POST", `${API}/rest/posts`)[0]!);
    expect(body.author).toBe("urn:li:person:abc");
    expect(body.content).toEqual({ article: { source: "https://acme.example/post", title: "Read this" } });
  });

  it("uploads a single image (initializeUpload + PUT), waits for AVAILABLE and attaches it", async () => {
    on("GET", "https://cdn.example/a.png", () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    on("POST", `${API}/rest/images?action=initializeUpload`, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/img1", image: "urn:li:image:I1" } });
    on("PUT", "https://www.linkedin.com/dms-uploads/img1", () => new Response(null, { status: 201 }));
    let polls = 0;
    on("GET", `${API}/rest/images/`, () => json({ status: polls++ === 0 ? "PROCESSING" : "AVAILABLE" }));
    on("POST", `${API}/rest/posts`, () => created());

    await connector().publish(org, { ...input, media: [{ kind: "image", url: "https://cdn.example/a.png", alt: "Logo" }] });

    expect(jsonBody(calls("POST", `${API}/rest/images`)[0]!)).toEqual({ initializeUploadRequest: { owner: "urn:li:organization:42" } });
    const put = calls("PUT")[0]!;
    expect(put.headers.authorization).toBe("Bearer tok");
    expect(put.body).toBeInstanceOf(Blob);
    expect(calls("GET", `${API}/rest/images/`)[0]!.url).toBe(`${API}/rest/images/urn%3Ali%3Aimage%3AI1`);
    expect(polls).toBe(2);
    expect(jsonBody(calls("POST", `${API}/rest/posts`)[0]!).content).toEqual({ media: { id: "urn:li:image:I1", altText: "Logo" } });
  });

  it("uses the media fetcher when core provides one, and builds a multi-image post", async () => {
    let n = 0;
    on("POST", `${API}/rest/images?action=initializeUpload`, () => {
      n++;
      return json({ value: { uploadUrl: `https://up.example/${n}`, image: `urn:li:image:I${n}` } });
    });
    on("PUT", "https://up.example/", () => new Response(null, { status: 201 }));
    on("GET", `${API}/rest/images/`, { status: "AVAILABLE" });
    on("POST", `${API}/rest/posts`, () => created("urn:li:share:901"));
    const c = connector();
    const seen: string[] = [];
    c.media = { fetch: async (m) => (seen.push(m.url), { bytes: new Uint8Array([9]), mime: "image/jpeg" }) };

    await c.publish(org, { ...input, media: [{ kind: "image", url: "https://cdn.example/1.jpg", alt: "one" }, { kind: "image", url: "https://cdn.example/2.jpg" }] });

    expect(seen).toEqual(["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"]);
    expect(jsonBody(calls("POST", `${API}/rest/posts`)[0]!).content).toEqual({ multiImage: { images: [{ id: "urn:li:image:I1", altText: "one" }, { id: "urn:li:image:I2" }] } });
  });

  it("uploads video in parts, finalizes with the ETags, polls processing, then posts", async () => {
    const bytes = new Uint8Array(10).map((_, i) => i);
    on("GET", "https://cdn.example/v.mp4", () => new Response(bytes, { headers: { "content-type": "video/mp4" } }));
    on("POST", `${API}/rest/videos?action=initializeUpload`, {
      value: {
        video: "urn:li:video:V1",
        uploadToken: "",
        uploadInstructions: [
          { uploadUrl: "https://up.example/p1", firstByte: 0, lastByte: 5 },
          { uploadUrl: "https://up.example/p2", firstByte: 6, lastByte: 9 },
        ],
      },
    });
    on("PUT", "https://up.example/p1", () => new Response(null, { status: 200, headers: { etag: "etag-1" } }));
    on("PUT", "https://up.example/p2", () => new Response(null, { status: 200, headers: { etag: "etag-2" } }));
    on("POST", `${API}/rest/videos?action=finalizeUpload`, () => new Response(null, { status: 200 }));
    const statuses = ["WAITING_UPLOAD", "PROCESSING", "AVAILABLE"];
    on("GET", `${API}/rest/videos/`, () => json({ status: statuses.shift() }));
    on("POST", `${API}/rest/posts`, () => created("urn:li:ugcPost:77"));

    const res = await connector().publish(org, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4", durationSeconds: 30 }], options: { title: "Demo" } });

    expect(res.externalId).toBe("urn:li:ugcPost:77");
    expect(jsonBody(calls("POST", `${API}/rest/videos?action=initializeUpload`)[0]!)).toEqual({
      initializeUploadRequest: { owner: "urn:li:organization:42", fileSizeBytes: 10, uploadCaptions: false, uploadThumbnail: false },
    });
    const parts = calls("PUT");
    expect(parts.map((p) => p.url)).toEqual(["https://up.example/p1", "https://up.example/p2"]);
    expect(await (parts[0]!.body as Blob).arrayBuffer()).toEqual(bytes.slice(0, 6).buffer);
    expect(await (parts[1]!.body as Blob).arrayBuffer()).toEqual(bytes.slice(6).buffer);
    expect(jsonBody(calls("POST", `${API}/rest/videos?action=finalizeUpload`)[0]!)).toEqual({ finalizeUploadRequest: { video: "urn:li:video:V1", uploadToken: "", uploadedPartIds: ["etag-1", "etag-2"] } });
    expect(calls("GET", `${API}/rest/videos/`)).toHaveLength(3);
    expect(jsonBody(calls("POST", `${API}/rest/posts`)[0]!).content).toEqual({ media: { id: "urn:li:video:V1", title: "Demo" } });
  });

  it("gives a retryable error while video is still processing and resumes without re-uploading", async () => {
    on("GET", "https://cdn.example/v.mp4", () => new Response(new Uint8Array(4), { headers: { "content-type": "video/mp4" } }));
    on("POST", `${API}/rest/videos?action=initializeUpload`, { value: { video: "urn:li:video:V2", uploadToken: "t", uploadInstructions: [{ uploadUrl: "https://up.example/p", firstByte: 0, lastByte: 3 }] } });
    on("PUT", "https://up.example/p", () => new Response(null, { headers: { etag: "e" } }));
    on("POST", `${API}/rest/videos?action=finalizeUpload`, () => new Response(null, { status: 200 }));
    let ready = false;
    on("GET", `${API}/rest/videos/`, () => json({ status: ready ? "AVAILABLE" : "PROCESSING" }));
    on("POST", `${API}/rest/posts`, () => created("urn:li:ugcPost:78"));
    const c = connector({ maxPolls: 3 });
    const vid = { ...input, idempotencyKey: "kv", media: [{ kind: "video" as const, url: "https://cdn.example/v.mp4" }] };

    const e = await rejection(c.publish(org, vid));
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/still processing/);
    expect(calls("POST", `${API}/rest/posts`)).toHaveLength(0);

    ready = true;
    const res = await c.publish(org, vid);
    expect(res.externalId).toBe("urn:li:ugcPost:78");
    expect(calls("POST", `${API}/rest/videos?action=initializeUpload`)).toHaveLength(1);
  });

  it("fails without retry when video processing fails", async () => {
    on("GET", "https://cdn.example/v.mp4", () => new Response(new Uint8Array(4)));
    on("POST", `${API}/rest/videos?action=initializeUpload`, { value: { video: "urn:li:video:V3", uploadInstructions: [{ uploadUrl: "https://up.example/p", firstByte: 0, lastByte: 3 }] } });
    on("PUT", "https://up.example/p", () => new Response(null, { headers: { etag: "e" } }));
    on("POST", `${API}/rest/videos?action=finalizeUpload`, () => new Response(null));
    on("GET", `${API}/rest/videos/`, { status: "PROCESSING_FAILED", processingFailureReason: "bad codec" });
    const e = await rejection(connector().publish(org, { ...input, media: [{ kind: "video", url: "https://cdn.example/v.mp4" }] }));
    expect(e.kind).toBe("rejected");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("bad codec");
  });

  it("publishes a PDF document (carousel) with a title", async () => {
    on("GET", "https://cdn.example/deck.pdf", () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }));
    on("POST", `${API}/rest/documents?action=initializeUpload`, { value: { uploadUrl: "https://up.example/doc", document: "urn:li:document:D1" } });
    on("PUT", "https://up.example/doc", () => new Response(null, { status: 201 }));
    on("GET", `${API}/rest/documents/`, { status: "AVAILABLE" });
    on("POST", `${API}/rest/posts`, () => created());
    await connector().publish(org, { ...input, media: [{ kind: "document", url: "https://cdn.example/deck.pdf", mime: "application/pdf" }], options: { title: "Q3 deck" } });
    expect(calls("PUT")[0]!.headers["content-type"]).toBe("application/pdf");
    expect(jsonBody(calls("POST", `${API}/rest/posts`)[0]!).content).toEqual({ media: { id: "urn:li:document:D1", title: "Q3 deck" } });
  });

  it("publishes a poll", async () => {
    on("POST", `${API}/rest/posts`, () => created());
    await connector().publish(org, { ...input, options: { title: "Which one?", poll: { options: ["A", "B"], durationMinutes: 4000 } } });
    expect(jsonBody(calls("POST", `${API}/rest/posts`)[0]!).content).toEqual({ poll: { question: "Which one?", options: [{ text: "A" }, { text: "B" }], settings: { duration: "THREE_DAYS" } } });
  });

  it("appends a link to the text when it cannot be a card", async () => {
    on("POST", `${API}/rest/images?action=initializeUpload`, () => json({ value: { uploadUrl: "https://up.example/x", image: "urn:li:image:X" } }));
    on("PUT", "https://up.example/", () => new Response(null));
    on("GET", `${API}/rest/images/`, { status: "AVAILABLE" });
    on("POST", `${API}/rest/posts`, () => created());
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([1]), mime: "image/png" }) };
    await c.publish(org, { ...input, media: [{ kind: "image", url: "https://cdn.example/1.png" }, { kind: "image", url: "https://cdn.example/2.png" }], options: { link: "https://acme.example" } });
    expect(jsonBody(calls("POST", `${API}/rest/posts`)[0]!).commentary).toBe("Hello LinkedIn\n\nhttps://acme.example");
  });
});

describe("linkedin validate", () => {
  const c = connector();
  it("flags mixed media, multiple videos, bad documents and invalid polls", () => {
    const issues = c.validate(org, {
      ...input,
      media: [
        { kind: "video", url: "https://x.example/1.mp4", durationSeconds: 2 },
        { kind: "video", url: "https://x.example/2.mp4" },
        { kind: "document", url: "https://x.example/a.zip", mime: "application/zip" },
      ],
      options: { poll: { options: ["a", "b", "c", "d", "e"], durationMinutes: 60 } },
    });
    const msgs = issues.map((i) => i.message).join(" | ");
    expect(msgs).toMatch(/one video/);
    expect(msgs).toMatch(/cannot mix/);
    expect(msgs).toMatch(/3 seconds to 30 minutes/);
    expect(msgs).toMatch(/PDF/);
    expect(msgs).toMatch(/polls cannot carry media/);
    expect(msgs).toMatch(/need a question/);
    expect(msgs).toMatch(/2 to 4 options/);
    expect(c.validate(org, input)).toEqual([]);
  });

  it("escapes little-format characters", () => {
    expect(escapeLittleText("a_b*c [x](y) {z} <w> ~ | \\ @me #tag")).toBe("a\\_b\\*c \\[x\\]\\(y\\) \\{z\\} \\<w\\> \\~ \\| \\\\ \\@me #tag");
  });
});

describe("linkedin reply and moderate", () => {
  it("comments on a post as the organization (first comment path)", async () => {
    on("POST", `${API}/rest/socialActions/`, () => json({ id: "555", commentUrn: "urn:li:comment:(urn:li:share:900,555)" }, 201, { "x-restli-id": "555" }));
    const c = connector();
    const r = await c.reply(org, { parentExternalId: "urn:li:share:900", text: "Link: https://acme.example", idempotencyKey: "v1:first-comment" });
    expect(r.externalId).toBe("urn:li:comment:(urn:li:share:900,555)");
    const call = calls("POST")[0]!;
    expect(call.url).toBe(`${API}/rest/socialActions/urn%3Ali%3Ashare%3A900/comments`);
    expect(jsonBody(call)).toEqual({ actor: "urn:li:organization:42", object: "urn:li:share:900", message: { text: "Link: https://acme.example" } });
    await c.reply(org, { parentExternalId: "urn:li:share:900", text: "again", idempotencyKey: "v1:first-comment" });
    expect(calls("POST")).toHaveLength(1);
  });

  it("replies to a comment as a nested comment", async () => {
    on("POST", `${API}/rest/socialActions/`, () => json({}, 201, { "x-restli-id": "777" }));
    const parent = "urn:li:comment:(urn:li:activity:123,456)";
    const r = await connector().reply(org, { parentExternalId: parent, text: "Thanks!", idempotencyKey: "r1" });
    expect(r.externalId).toBe("urn:li:comment:(urn:li:activity:123,777)");
    const call = calls("POST")[0]!;
    expect(call.url).toBe(`${API}/rest/socialActions/${encodeURIComponent(parent)}/comments`);
    expect(jsonBody(call)).toEqual({ actor: "urn:li:organization:42", object: "urn:li:activity:123", message: { text: "Thanks!" }, parentComment: parent });
  });

  it("likes, unlikes and deletes; refuses hide", async () => {
    on("POST", `${API}/rest/reactions`, () => json({}, 201));
    on("DELETE", `${API}/rest/`, () => new Response(null, { status: 204 }));
    const c = connector();
    const comment = "urn:li:comment:(urn:li:activity:123,456)";
    await c.moderate(org, { externalId: comment, action: "like" });
    await c.moderate(org, { externalId: comment, action: "unlike" });
    await c.moderate(org, { externalId: comment, action: "delete" });
    await c.moderate(org, { externalId: "urn:li:share:900", action: "delete" });
    const [like, unlike, del, delPost] = calls();
    expect(like!.url).toBe(`${API}/rest/reactions?actor=urn%3Ali%3Aorganization%3A42`);
    expect(jsonBody(like!)).toEqual({ root: comment, reactionType: "LIKE" });
    expect(unlike!.url).toBe(`${API}/rest/reactions/(actor:urn%3Ali%3Aorganization%3A42,entity:${encodeURIComponent(comment)})`);
    expect(del!.url).toBe(`${API}/rest/socialActions/urn%3Ali%3Aactivity%3A123/comments/456?actor=urn%3Ali%3Aorganization%3A42`);
    expect(del!.headers["x-restli-method"]).toBe("DELETE");
    expect(delPost!.url).toBe(`${API}/rest/posts/urn%3Ali%3Ashare%3A900`);
    const e = await rejection(c.moderate(org, { externalId: comment, action: "hide" }));
    expect(e.kind).toBe("rejected");
  });

  it("parses comment URNs", () => {
    expect(parseCommentUrn("urn:li:comment:(urn:li:ugcPost:1,2)")).toEqual({ object: "urn:li:ugcPost:1", id: "2" });
    expect(parseCommentUrn("urn:li:share:1")).toBeNull();
  });
});

describe("linkedin activity", () => {
  it("maps organization posts and their comments, skipping the page's own comments and old items", async () => {
    on("GET", `${API}/rest/posts?author=`, {
      elements: [
        { id: "urn:li:share:2", commentary: "New post", publishedAt: Date.parse("2026-11-01T10:00:00Z") },
        { id: "urn:li:share:1", commentary: "Old post", publishedAt: Date.parse("2026-10-01T10:00:00Z") },
      ],
    });
    on("GET", `${API}/rest/socialActions/urn%3Ali%3Ashare%3A2/comments`, {
      elements: [
        { id: "11", commentUrn: "urn:li:comment:(urn:li:activity:2,11)", actor: "urn:li:person:p1", object: "urn:li:activity:2", message: { text: "Great!" }, created: { time: Date.parse("2026-11-01T11:00:00Z") } },
        { id: "12", actor: "urn:li:organization:42", object: "urn:li:activity:2", message: { text: "Thanks" }, created: { time: Date.parse("2026-11-01T12:00:00Z") } },
      ],
    });
    on("GET", `${API}/rest/socialActions/urn%3Ali%3Ashare%3A1/comments`, {
      elements: [{ id: "9", actor: "urn:li:person:p2", object: "urn:li:activity:1", parentComment: "urn:li:comment:(urn:li:activity:1,8)", message: { text: "late reply" }, created: { time: Date.parse("2026-11-01T13:00:00Z") } }],
    });

    const items = await connector().fetchActivity(org, new Date("2026-10-15T00:00:00Z"));

    expect(calls("GET", `${API}/rest/posts`)[0]!.url).toBe(`${API}/rest/posts?author=urn%3Ali%3Aorganization%3A42&q=author&count=10&sortBy=LAST_MODIFIED`);
    expect(items.map((i) => [i.kind, i.externalId, i.text, i.parentExternalId])).toEqual([
      ["own_post", "urn:li:share:2", "New post", null],
      ["comment", "urn:li:comment:(urn:li:activity:2,11)", "Great!", "urn:li:share:2"],
      ["reply", "urn:li:comment:(urn:li:activity:1,9)", "late reply", "urn:li:comment:(urn:li:activity:1,8)"],
    ]);
    expect(items[1]).toMatchObject({ network: "linkedin", authorHandle: "urn:li:person:p1", occurredAt: "2026-11-01T11:00:00.000Z" });
    expect(items[1]!.raw).toBeDefined();
  });

  it("returns nothing for member accounts (r_member_social is closed)", async () => {
    expect(await connector().fetchActivity(member, null)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("linkedin metrics", () => {
  it("maps organization share statistics to canonical metrics", async () => {
    on("GET", `${API}/rest/organizationalEntityShareStatistics`, {
      elements: [
        { share: "urn:li:share:1", totalShareStatistics: { impressionCount: 1000, uniqueImpressionsCount: 800, clickCount: 30, likeCount: 20, commentCount: 5, shareCount: 2, engagement: 0.057 } },
        { ugcPost: "urn:li:ugcPost:2", totalShareStatistics: { impressionCount: 50 } },
      ],
    });
    const rows = await connector().fetchMetrics(org, ["urn:li:share:1", "urn:li:ugcPost:2"]);
    expect(calls()[0]!.url).toBe(
      `${API}/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A42&shares=List(urn%3Ali%3Ashare%3A1)&ugcPosts=List(urn%3Ali%3AugcPost%3A2)`,
    );
    const m = Object.fromEntries(rows.filter((r) => r.entityId === "urn:li:share:1").map((r) => [r.metric, r.value]));
    expect(m).toEqual({ impressions: 1000, reach: 800, likes: 20, replies: 5, reposts: 2, clicks: 30, engagement_rate: 0.057, engagements: 57 });
    expect(rows[0]).toMatchObject({ entityType: "post_variant", source: "linkedin", observedAt: NOW.toISOString() });
  });

  it("reads member post analytics and stops quietly without the permission", async () => {
    const counts: Record<string, number> = { IMPRESSION: 500, MEMBERS_REACHED: 400, REACTION: 10, COMMENT: 3, RESHARE: 1 };
    on("GET", `${API}/rest/memberCreatorPostAnalytics`, (url: string) => json({ elements: [{ count: counts[new URL(url).searchParams.get("queryType")!] }] }));
    const rows = await connector().fetchMetrics(member, ["urn:li:share:5"]);
    expect(calls()[0]!.url).toContain("q=entity&entity=(share:urn%3Ali%3Ashare%3A5)&queryType=IMPRESSION&aggregation=TOTAL");
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ impressions: 500, reach: 400, likes: 10, replies: 3, reposts: 1, engagements: 14 });

    routes = [];
    on("GET", `${API}/rest/memberCreatorPostAnalytics`, json({ message: "Not enough permissions" }, 403));
    expect(await connector().fetchMetrics(member, ["urn:li:share:5"])).toEqual([]);
  });

  it("reads followers for pages and members", async () => {
    on("GET", `${API}/rest/networkSizes/`, { firstDegreeSize: 1234 });
    on("GET", `${API}/rest/memberFollowersCount`, { elements: [{ memberFollowersCount: 321 }] });
    const c = connector();
    expect(await c.fetchAccountMetrics(org)).toEqual([{ entityType: "social_account", entityId: "acc-org", metric: "followers_total", value: 1234, observedAt: NOW.toISOString(), source: "linkedin" }]);
    expect(calls()[0]!.url).toBe(`${API}/rest/networkSizes/urn%3Ali%3Aorganization%3A42?edgeType=COMPANY_FOLLOWED_BY_MEMBER`);
    expect((await c.fetchAccountMetrics(member))[0]!.value).toBe(321);
  });
});

describe("linkedin webhooks", () => {
  const c = connector();
  it("answers the challenge with an HMAC of the code", () => {
    const out = c.webhook.challenge!({ challengeCode: "abc123" });
    expect(JSON.parse(out!)).toEqual({ challengeCode: "abc123", challengeResponse: createHmac("sha256", "secret").update("abc123").digest("hex") });
    expect(c.webhook.challenge!({})).toBeNull();
  });

  it("verifies X-LI-Signature over hmacsha256= + body and rejects tampering", () => {
    const raw = JSON.stringify({ type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS", notifications: [] });
    const sig = createHmac("sha256", "secret").update(`hmacsha256=${raw}`).digest("hex");
    expect(c.webhook.verify({ "x-li-signature": sig }, raw)).toBe(true);
    expect(c.webhook.verify({ "x-li-signature": sig }, `${raw} `)).toBe(false);
    expect(c.webhook.verify({ "x-li-signature": "00" }, raw)).toBe(false);
    expect(c.webhook.verify({}, raw)).toBe(false);
    expect(new LinkedInConnector({}).webhook.verify({ "x-li-signature": sig }, raw)).toBe(false);
  });

  it("parses organization social action notifications into per-org batches", () => {
    const batches = parseLinkedInWebhook({
      type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
      notifications: [
        { action: "COMMENT", organizationalEntity: "urn:li:organization:42", sourcePost: "urn:li:share:1", generatedActivity: "urn:li:comment:(urn:li:activity:1,9)", actor: "urn:li:person:p", lastModifiedAt: Date.parse("2026-11-01T00:00:00Z"), decoratedGeneratedActivity: { comment: { text: "hi" } } },
        { action: "SHARE_MENTION", organizationalEntity: "urn:li:organization:42", generatedActivity: "urn:li:share:77", actor: "urn:li:person:q", lastModifiedAt: 0 },
        { action: "LIKE", organizationalEntity: "urn:li:organization:7", sourcePost: "urn:li:share:3", notificationId: 5, lastModifiedAt: 0 },
        { action: "UNKNOWN", organizationalEntity: "urn:li:organization:7" },
      ],
    });
    expect(batches.map((b) => [b.accountExternalId, b.items.map((i) => i.kind)])).toEqual([
      ["urn:li:organization:42", ["comment", "mention"]],
      ["urn:li:organization:7", ["like"]],
    ]);
    expect(batches[0]!.items[0]).toMatchObject({ externalId: "urn:li:comment:(urn:li:activity:1,9)", text: "hi", parentExternalId: "urn:li:share:1", occurredAt: "2026-11-01T00:00:00.000Z" });
    expect(batches[1]!.items[0]!.externalId).toBe("notification:5");
  });
});

describe("linkedin errors", () => {
  it("maps statuses to ConnectorError kinds", () => {
    const h = new Headers();
    expect(mapLinkedInError(401, h, { message: "expired" }, "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapLinkedInError(403, h, {}, "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapLinkedInError(422, h, { message: "duplicate" }, "x")).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapLinkedInError(426, h, {}, "x").message).toMatch(/LINKEDIN_API_VERSION/);
    expect(mapLinkedInError(500, h, {}, "x")).toMatchObject({ kind: "network", retryable: true });
    const rl = mapLinkedInError(429, new Headers({ "retry-after": "60" }), {}, "x");
    expect(rl).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(rl.message).toContain("retry after 60s");
    expect(mapLinkedInError(429, h, {}, "x").message).toMatch(/daily quota resets at/);
  });

  it("surfaces 429 and transport failures from publish as retryable", async () => {
    on("POST", `${API}/rest/posts`, json({ status: 429, message: "Resource level throttle limit" }, 429));
    const e = await rejection(connector().publish(org, { ...input, idempotencyKey: "rl" }));
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true });
    expect((e.cause as { status: number }).status).toBe(429);

    routes = [];
    on("POST", `${API}/rest/posts`, () => {
      throw new TypeError("fetch failed");
    });
    const n = await rejection(connector().publish(org, { ...input, idempotencyKey: "net" }));
    expect(n).toMatchObject({ kind: "network", retryable: true });
  });

  it("rejects accounts without usable auth", async () => {
    const e = await rejection(connector().publish({ ...org, auth: null }, input));
    expect(e.kind).toBe("auth");
  });
});

describe("linkedin factory", () => {
  it("reads env and validates the API version", () => {
    const [c] = createLinkedInConnectors({ LINKEDIN_CLIENT_ID: "a", LINKEDIN_CLIENT_SECRET: "b", LINKEDIN_API_VERSION: "202609" }) as LinkedInConnector[];
    expect(c!.name).toBe("linkedin");
    expect(c!.networks).toEqual(["linkedin"]);
    expect(c!.connectConfigured).toBe(true);
    expect(c!.apiVersion).toBe("202609");
    const [d] = createLinkedInConnectors({ LINKEDIN_API_VERSION: "2026-09", LINKEDIN_SCOPES: "openid profile w_member_social" }) as LinkedInConnector[];
    expect(d!.connectConfigured).toBe(false);
    expect(d!.apiVersion).toBe(LINKEDIN_DEFAULT_VERSION);
    expect(d!.oauth.config.scopes).toEqual(["openid", "profile", "w_member_social"]);
    expect(d!.capabilities()).toMatchObject({ reply: true, moderate: true, accountMetrics: true, webhooks: true, video: true });
  });
});
