import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, type AccountRef, type PublishInput } from "../src/index.ts";
import { MisskeyConnector, createMisskeyConnectors, mapMisskeyError, misskeyNotificationToActivity, misskeyVisibility, normalizeServerHost } from "../src/misskey.ts";

const NOW = new Date("2026-11-06T00:00:00.000Z");
const acct: AccountRef = {
  id: "mk1",
  workspaceId: "w",
  network: "misskey",
  externalId: "9abc@misskey.io",
  handle: "@acme@misskey.io",
  auth: { token: "tok", host: "misskey.io", userId: "9abc" },
  config: { host: "misskey.io", maxNoteTextLength: 3000 },
};
const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v1", text: "hello misskey", media: [], thread: [], idempotencyKey: `k-${Math.random()}`, ...over });

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: new URL(String(url)), method: init?.method, body: init?.body, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const connector = () => new MisskeyConnector({ now: () => NOW });
const user = { id: "9abc", username: "acme", host: null, name: "Acme", followersCount: 42 };
const created = (id: string) => json({ createdNote: { id, createdAt: NOW.toISOString(), user } });

describe("misskey connect", () => {
  it("verifies the token with /api/i, reads maxNoteTextLength from /api/meta", async () => {
    fetchMock.mockResolvedValueOnce(json(user)).mockResolvedValueOnce(json({ maxNoteTextLength: 5000, name: "Misskey.io", version: "2025.10.0" }));
    const c = connector();
    const accounts = await c.connectWithInputs({ network: "misskey", inputs: { host: "https://Misskey.io/@acme", token: " tok " } });
    expect(call(0).url.href).toBe("https://misskey.io/api/i");
    expect(call(0).method).toBe("POST");
    expect(call(0).json()).toEqual({ i: "tok" });
    expect(call(1).url.pathname).toBe("/api/meta");
    expect(call(1).json()).toEqual({ detail: false });
    expect(accounts).toEqual([
      {
        network: "misskey",
        identity: { externalId: "9abc@misskey.io", handle: "@acme@misskey.io", displayName: "Acme" },
        auth: { token: "tok", host: "misskey.io", userId: "9abc" },
        config: { host: "misskey.io", maxNoteTextLength: 5000, serverName: "Misskey.io", serverVersion: "2025.10.0" },
      },
    ]);
    expect(c.connectConfigured).toBe(true);
    expect(c.credentialInputs.find((i) => i.key === "token")?.secret).toBe(true);
  });

  it("maps a bad token to auth and refuses private hosts", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: "Authentication failed.", code: "AUTHENTICATION_FAILED", id: "x" } }, 401));
    await expect(connector().connectWithInputs({ network: "misskey", inputs: { host: "misskey.io", token: "bad" } })).rejects.toMatchObject({ kind: "auth" });
    await expect(connector().connectWithInputs({ network: "misskey", inputs: { host: "misskey.io", token: "" } })).rejects.toMatchObject({ kind: "auth" });
    expect(() => normalizeServerHost("10.0.0.1", "misskey")).toThrow(/not a public server/);
    expect(normalizeServerHost("@me@sharkey.example", "misskey")).toBe("sharkey.example");
  });

  it("describeAccount reads /api/i; refreshAuth is null", async () => {
    fetchMock.mockResolvedValueOnce(json(user));
    expect(await connector().describeAccount({ host: "misskey.io", token: "tok" })).toEqual({ externalId: "9abc@misskey.io", handle: "@acme@misskey.io", displayName: "Acme" });
    expect(await connector().refreshAuth()).toBeNull();
  });
});

describe("misskey publish", () => {
  it("posts a note with visibility, cw and a poll", async () => {
    fetchMock.mockResolvedValueOnce(created("n1"));
    const res = await connector().publish(acct, input({ options: { visibility: "unlisted", contentWarning: "spoiler", poll: { options: ["yes", "no"], durationMinutes: 60 } } }));
    expect(call(0).url.href).toBe("https://misskey.io/api/notes/create");
    expect(call(0).json()).toEqual({ i: "tok", text: "hello misskey", visibility: "home", cw: "spoiler", poll: { choices: ["yes", "no"], multiple: false, expiredAfter: 3_600_000 } });
    expect(res).toMatchObject({ externalId: "n1", url: "https://misskey.io/notes/n1" });
  });

  it("uploads media to the drive (multipart, token in the form) and attaches fileIds", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "f1", url: "https://s3/f1" })).mockResolvedValueOnce(json({ id: "f2" })).mockResolvedValueOnce(created("n2"));
    const c = connector();
    c.media = { fetch: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" })) };
    await c.publish(acct, input({ media: [{ kind: "image", url: "https://cdn/a.png", alt: "alt a" }, { kind: "video", url: "https://cdn/b.mp4" }], options: { nsfw: true } }));
    expect(call(0).url.pathname).toBe("/api/drive/files/create");
    const form = call(0).body as FormData;
    expect(form.get("i")).toBe("tok");
    expect(form.get("comment")).toBe("alt a");
    expect(form.get("isSensitive")).toBe("true");
    expect((form.get("file") as File).type).toBe("image/png");
    expect(call(2).json()).toMatchObject({ fileIds: ["f1", "f2"], visibility: "public" });
  });

  it("chains a thread with replyId and resumes after a failure with partial", async () => {
    fetchMock
      .mockResolvedValueOnce(created("t1"))
      .mockResolvedValueOnce(json({ error: { code: "INTERNAL_ERROR", message: "oops" } }, 500))
      .mockResolvedValueOnce(created("t2"))
      .mockResolvedValueOnce(created("t3"));
    const c = connector();
    const inp = input({ text: "1", thread: ["2", "3"], idempotencyKey: "th" });
    const err = (await c.publish(acct, inp).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "network", retryable: true, partial: { externalId: "t1", threadExternalIds: ["t1"] } });
    const res = await c.publish(acct, inp);
    expect(call(2).json()).toMatchObject({ text: "2", replyId: "t1" });
    expect(call(3).json()).toMatchObject({ text: "3", replyId: "t2" });
    expect(res.threadExternalIds).toEqual(["t1", "t2", "t3"]);
    await c.publish(acct, inp);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("validates against the server's maxNoteTextLength and poll limits", () => {
    const c = connector();
    const small: AccountRef = { ...acct, config: { ...acct.config, maxNoteTextLength: 10 } };
    expect(c.validate(small, input({ text: "x".repeat(11) }))[0]).toMatchObject({ code: "too_long", segment: 0 });
    expect(c.validate(acct, input({ options: { poll: { options: ["a", "x".repeat(51)], durationMinutes: 10 } } }))[0]?.code).toBe("too_long");
    expect(c.validate(acct, input({ text: "", options: { poll: { options: ["a", "b"], durationMinutes: 10 } } }))).toEqual([]);
    expect(c.validate(acct, input({ text: " " }))[0]?.code).toBe("empty");
    expect(misskeyVisibility("private")).toBe("followers");
    expect(misskeyVisibility("direct")).toBe("specified");
    expect(misskeyVisibility(undefined)).toBe("public");
  });
});

describe("misskey listen", () => {
  const other = { id: "u2", username: "bob", host: "sharkey.example", name: "Bob" };
  const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, createdAt: "2026-11-05T10:00:00.000Z", user: other, userId: "u2", ...extra });
  const nt = (id: string, extra: Record<string, unknown> = {}) => ({ id, createdAt: "2026-11-05T10:00:00.000Z", user: other, text: "hi @acme", ...extra });

  it("maps mention, reply, quote, renote, reaction and follow notifications and stops at since", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        n("a6", "follow"),
        n("a5", "reaction", { reaction: "🎉", note: nt("own1", { user }) }),
        n("a4", "renote", { note: nt("rn1", { renoteId: "own1", renote: nt("own1", { user }) }) }),
        n("a3", "quote", { note: nt("q1", { renoteId: "own1", cw: "cw!" }) }),
        n("a2", "reply", { note: nt("r1", { replyId: "own1" }) }),
        n("a1", "mention", { note: nt("m1") }),
        { ...n("a0", "mention", { note: nt("m0") }), createdAt: "2026-11-01T00:00:00.000Z" },
      ]),
    );
    const items = await connector().fetchActivity(acct, new Date("2026-11-02T00:00:00.000Z"));
    expect(call(0).url.pathname).toBe("/api/i/notifications");
    expect(call(0).json()).toEqual({ i: "tok", limit: 100, includeTypes: ["mention", "reply", "quote", "renote", "reaction", "follow"], markAsRead: false });
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(items).toHaveLength(6);
    expect(byKind.mention).toMatchObject({ externalId: "m1", authorHandle: "@bob@sharkey.example", authorName: "Bob", text: "hi @acme", url: "https://misskey.io/notes/m1", parentExternalId: null });
    expect(byKind.reply).toMatchObject({ externalId: "r1", parentExternalId: "own1" });
    expect(byKind.quote).toMatchObject({ externalId: "q1", parentExternalId: "own1", text: "CW: cw!\n\nhi @acme" });
    expect(byKind.repost).toMatchObject({ externalId: "notification:a4@misskey.io", parentExternalId: "own1", url: "https://misskey.io/notes/own1" });
    expect(byKind.like).toMatchObject({ externalId: "notification:a5@misskey.io", text: "🎉", parentExternalId: "own1" });
    expect(byKind.follow).toMatchObject({ externalId: "notification:a6@misskey.io", url: "https://misskey.io/@bob@sharkey.example", parentExternalId: null });
  });

  it("pages with untilId while every item is newer than since", async () => {
    const page = Array.from({ length: 100 }, (_, i) => n(`p${100 - i}`, "mention", { note: nt(`m${100 - i}`) }));
    fetchMock.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json([n("p0", "mention", { note: nt("m0") })]));
    const items = await connector().fetchActivity(acct, null);
    expect(items).toHaveLength(101);
    expect(call(1).json()).toMatchObject({ untilId: "p1" });
    expect(misskeyNotificationToActivity("misskey.io", n("x", "pollEnded"))).toBeNull();
  });
});

describe("misskey engage and measure", () => {
  it("replies with the parent's visibility", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "p1", createdAt: NOW.toISOString(), user, visibility: "followers" })).mockResolvedValueOnce(created("r9"));
    const res = await connector().reply(acct, { parentExternalId: "p1", text: "thanks", idempotencyKey: "r" });
    expect(call(0).json()).toEqual({ i: "tok", noteId: "p1" });
    expect(call(1).json()).toEqual({ i: "tok", text: "thanks", replyId: "p1", visibility: "followers" });
    expect(res).toMatchObject({ externalId: "r9", url: "https://misskey.io/notes/r9" });
  });

  it("likes with a reaction, unlikes, deletes, and treats already-in-state errors as success", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ error: { code: "ALREADY_REACTED", message: "already" } }, 400))
      .mockResolvedValueOnce(json({ error: { code: "NOT_REACTED", message: "not" } }, 400));
    const c = connector();
    await c.moderate(acct, { externalId: "n1", action: "like" });
    await c.moderate(acct, { externalId: "n1", action: "unlike" });
    await c.moderate(acct, { externalId: "n1", action: "delete" });
    await c.moderate(acct, { externalId: "n1", action: "like" });
    await c.moderate(acct, { externalId: "n1", action: "unlike" });
    expect(call(0).url.pathname).toBe("/api/notes/reactions/create");
    expect(call(0).json()).toEqual({ i: "tok", noteId: "n1", reaction: "👍" });
    expect(call(1).url.pathname).toBe("/api/notes/reactions/delete");
    expect(call(2).url.pathname).toBe("/api/notes/delete");
    await expect(c.moderate(acct, { externalId: "n1", action: "hide" })).rejects.toMatchObject({ kind: "rejected" });
    expect(createMisskeyConnectors({ MISSKEY_LIKE_REACTION: "❤" })[0]?.name).toBe("misskey");
  });

  it("maps notes/show counts to metrics and skips deleted notes; followers from /api/i", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ id: "n1", createdAt: NOW.toISOString(), user, reactions: { "👍": 3, "❤": 2 }, renoteCount: 4, repliesCount: 1 }))
      .mockResolvedValueOnce(json({ error: { code: "NO_SUCH_NOTE", message: "No such note." } }, 400))
      .mockResolvedValueOnce(json(user));
    const c = connector();
    const rows = await c.fetchMetrics(acct, ["n1", "gone"]);
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ likes: 5, reposts: 4, replies: 1, engagements: 10 });
    expect(rows.every((r) => r.entityId === "n1" && r.source === "misskey" && r.observedAt === NOW.toISOString())).toBe(true);
    expect(await c.fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "mk1", metric: "followers_total", value: 42, observedAt: NOW.toISOString(), source: "misskey" }]);
  });

  it("maps errors: 429 rate limit with Retry-After, 403 permission, 400 rejected, network failures", async () => {
    const h = (o: Record<string, string> = {}) => new Headers(o);
    expect(mapMisskeyError(429, h({ "retry-after": "12" }), { error: { code: "RATE_LIMIT_EXCEEDED" } }, "/api/notes/create")).toMatchObject({ kind: "rate_limit", retryable: true, message: expect.stringMatching(/retry after 12s/) });
    expect(mapMisskeyError(403, h(), { error: { code: "PERMISSION_DENIED" } }, "x").kind).toBe("auth");
    expect(mapMisskeyError(400, h(), { error: { code: "INVALID_PARAM" } }, "x")).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapMisskeyError(502, h(), "bad gateway", "x")).toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(connector().publish(acct, input())).rejects.toMatchObject({ kind: "network", retryable: true });
  });
});
