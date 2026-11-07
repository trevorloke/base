import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { MatrixConnector, createMatrixConnectors, mapMatrixError, markdownLiteToHtml, matrixEventToActivity, matrixSyncFilter, matrixTxnId, mentionsUser, parseMatrixExternalId, stripReplyFallback, type MatrixEvent, type MatrixSyncResponse } from "../src/matrix.ts";

const HS = "https://matrix.example.org";
const TOKEN = "syt_c3RhcnNpZ24_abcdefghijklmnop_0a1b2c";
const ME = "@baseair:example.org";
const ROOM = "!community:example.org";
const SECRET_ROOM = "!secret:example.org";
const DM = "!dm:example.org";
const NOW = new Date("2026-11-06T10:00:00.000Z");

const acct: AccountRef = {
  id: "acc1",
  workspaceId: "w",
  network: "matrix",
  externalId: ME,
  handle: ME,
  auth: { homeserver: HS, accessToken: TOKEN, userId: ME, deviceId: "DEV1" },
  config: {
    homeserver: HS,
    userId: ME,
    displayName: "base air",
    rooms: [
      { id: ROOM, alias: "#community:example.org", name: "Community", encrypted: false },
      { id: SECRET_ROOM, alias: null, name: null, encrypted: true },
      { id: DM, alias: null, name: null, encrypted: false },
    ],
    defaultRoomId: ROOM,
  },
};
const input: PublishInput = { variantId: "v1", text: "Release **2.0** is out: [notes](https://acme.example/notes)", media: [], thread: [], idempotencyKey: "k1" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return { url: String(url), method: init?.method, headers, body: init?.body, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const sleep = vi.fn(async () => {});
const connector = () => new MatrixConnector({ now: () => NOW, sleep });

async function rejects(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    return err as ConnectorError;
  }
  throw new Error("expected a rejection");
}

const ev = (id: string, content: Record<string, unknown>, extra: Partial<MatrixEvent> = {}): MatrixEvent => ({ type: "m.room.message", event_id: id, sender: "@alice:example.org", origin_server_ts: NOW.getTime() - 60_000, content: { msgtype: "m.text", ...content }, ...extra });

describe("matrix connect", () => {
  it("logs in with user + password (password not stored), resolves aliases, joins invited rooms and flags encrypted ones", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u === "https://example.org/.well-known/matrix/client") return json({ "m.homeserver": { base_url: "https://matrix.example.org/" } });
      if (u === `${HS}/_matrix/client/v3/login`) return json({ access_token: TOKEN, user_id: ME, device_id: "DEV1" });
      if (u.endsWith("/account/whoami")) return json({ user_id: ME, device_id: "DEV1" });
      if (u.includes("/profile/")) return json({ displayname: "base air" });
      if (u.endsWith("/joined_rooms")) return json({ joined_rooms: [SECRET_ROOM] });
      if (u.includes("/directory/room/")) return json({ room_id: ROOM, servers: ["example.org"] });
      if (u.includes("/join/")) return json({ room_id: ROOM });
      if (u.includes(`${encodeURIComponent(ROOM)}/state/m.room.name/`)) return json({ name: "Community" });
      if (u.includes(`${encodeURIComponent(SECRET_ROOM)}/state/m.room.encryption/`)) return json({ algorithm: "m.megolm.v1.aes-sha2" });
      if (u.includes("/state/")) return json({ errcode: "M_NOT_FOUND", error: "Event not found." }, 404);
      throw new Error(`unexpected ${u} ${init?.method}`);
    });
    const accounts = await connector().connectWithInputs({ network: "matrix", inputs: { homeserver: "example.org", user: "baseair", password: "hunter2-hunter2", rooms: "#community:example.org, !secret:example.org" } });
    const login = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/login"))!;
    expect(JSON.parse(String(login[1]?.body))).toEqual({ type: "m.login.password", identifier: { type: "m.id.user", user: "baseair" }, password: "hunter2-hunter2", initial_device_display_name: "base air" });
    const join = fetchMock.mock.calls.find((c) => String(c[0]).includes("/join/"))!;
    expect(String(join[0])).toBe(`${HS}/_matrix/client/v3/join/${encodeURIComponent("#community:example.org")}`);
    expect(accounts).toEqual([
      {
        network: "matrix",
        identity: { externalId: ME, handle: ME, displayName: "base air" },
        auth: { homeserver: HS, accessToken: TOKEN, userId: ME, deviceId: "DEV1" },
        config: {
          homeserver: HS,
          userId: ME,
          displayName: "base air",
          rooms: [
            { id: ROOM, alias: "#community:example.org", name: "Community", encrypted: false },
            { id: SECRET_ROOM, alias: null, name: null, encrypted: true },
          ],
          defaultRoomId: ROOM,
        },
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain("hunter2");
  });

  it("uses an access token, watches every joined room by default, and maps bad credentials to auth", async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes(".well-known")) return new Response("", { status: 404 });
      if (u.endsWith("/account/whoami")) return json({ user_id: ME });
      if (u.includes("/profile/")) return json({ errcode: "M_NOT_FOUND" }, 404);
      if (u.endsWith("/joined_rooms")) return json({ joined_rooms: [ROOM, DM] });
      return json({ errcode: "M_NOT_FOUND" }, 404);
    });
    const [a] = await connector().connectWithInputs({ network: "matrix", inputs: { homeserver: "https://matrix.example.org/", accessToken: TOKEN } });
    expect(a!.config).toMatchObject({ rooms: [{ id: ROOM }, { id: DM }], defaultRoomId: ROOM, displayName: null });
    expect(call(1).headers.authorization).toBe(`Bearer ${TOKEN}`);

    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) => (String(url).includes(".well-known") ? new Response("", { status: 404 }) : json({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token passed." }, 401)));
    expect(await rejects(connector().connectWithInputs({ network: "matrix", inputs: { homeserver: HS, accessToken: "bad-token-123" } }))).toMatchObject({ kind: "auth" });
    fetchMock.mockImplementation(async (url) => (String(url).includes(".well-known") ? new Response("", { status: 404 }) : json({ errcode: "M_FORBIDDEN", error: "Invalid username or password" }, 403)));
    expect(await rejects(connector().connectWithInputs({ network: "matrix", inputs: { homeserver: HS, user: "x", password: "y" } }))).toMatchObject({ kind: "auth" });
    expect(await rejects(connector().connectWithInputs({ network: "matrix", inputs: { homeserver: HS } }))).toMatchObject({ kind: "auth" });
    expect(await rejects(connector().connectWithInputs({ network: "matrix", inputs: { homeserver: "http://matrix.example.org", accessToken: TOKEN } }))).toMatchObject({ kind: "rejected" });
  });
});

describe("matrix event mapping", () => {
  const ctx = { userId: ME, displayName: "base air", roomName: () => "Community", memberName: () => "Alice" };
  it("maps a message to kind message in a group conversation", () => {
    expect(matrixEventToActivity(ROOM, ev("$e1", { body: "hello all" }), ctx)).toEqual({
      network: "matrix",
      kind: "message",
      externalId: `${ROOM}:$e1`,
      authorHandle: "@alice:example.org",
      authorName: "Alice",
      text: "hello all",
      url: `https://matrix.to/#/${encodeURIComponent(ROOM)}/${encodeURIComponent("$e1")}`,
      parentExternalId: null,
      occurredAt: "2026-11-06T09:59:00.000Z",
      raw: ev("$e1", { body: "hello all" }),
      conversation: { id: ROOM, name: "Community", type: "group" },
    });
  });
  it("detects mentions via m.mentions, else MXID or display name", () => {
    expect(mentionsUser(ev("$1", { body: "hey", "m.mentions": { user_ids: [ME] } }), ME)).toBe(true);
    expect(mentionsUser(ev("$1", { body: "base air is great", "m.mentions": {} }), ME, "base air")).toBe(false); // m.mentions present and empty wins
    expect(mentionsUser(ev("$1", { body: "ping @baseair:example.org" }), ME)).toBe(true);
    expect(mentionsUser(ev("$1", { body: "thanks base air!" }), ME, "base air")).toBe(true);
    expect(mentionsUser(ev("$1", { body: "base airlines" }), ME, "base air")).toBe(false);
    expect(matrixEventToActivity(ROOM, ev("$2", { body: "hey", "m.mentions": { user_ids: [ME] } }), ctx)).toMatchObject({ kind: "mention" });
  });
  it("maps replies (in_reply_to) to our messages as reply, strips legacy fallbacks, and skips noise", () => {
    const reply = ev("$3", { body: "> <@baseair:example.org> Release 2.0\n\nawesome", "m.relates_to": { "m.in_reply_to": { event_id: "$own" } }, "m.mentions": { user_ids: [ME] } });
    expect(matrixEventToActivity(ROOM, reply, ctx)).toMatchObject({ kind: "reply", parentExternalId: `${ROOM}:$own`, text: "awesome" });
    const replyToOther = ev("$4", { body: "agreed", "m.relates_to": { "m.in_reply_to": { event_id: "$bob" } }, "m.mentions": { user_ids: ["@bob:example.org"] } });
    expect(matrixEventToActivity(ROOM, replyToOther, ctx)).toMatchObject({ kind: "message", parentExternalId: `${ROOM}:$bob` });
    expect(matrixEventToActivity(ROOM, ev("$5", { body: "x" }, { sender: ME }), ctx)).toBeNull();
    expect(matrixEventToActivity(ROOM, ev("$6", { body: "* fixed", "m.relates_to": { rel_type: "m.replace", event_id: "$5" } }), ctx)).toBeNull();
    expect(matrixEventToActivity(ROOM, ev("$7", { msgtype: "m.notice", body: "build passed" }), ctx)).toBeNull();
    expect(matrixEventToActivity(ROOM, ev("$8", {}, { content: {} }), ctx)).toBeNull(); // redacted
    expect(matrixEventToActivity(ROOM, ev("$9", { msgtype: "m.image", body: "cat.png", url: "mxc://x/y" }), ctx)!.text).toBe("[Image: cat.png]");
    expect(matrixEventToActivity(DM, ev("$10", { body: "hi" }), { ...ctx, isDirect: () => true })).toMatchObject({ kind: "dm", conversation: { type: "direct" } });
    expect(stripReplyFallback("no quote")).toBe("no quote");
  });
  it("splits external ids at the event id", () => {
    expect(parseMatrixExternalId(`${ROOM}:$abc:example.org`)).toEqual({ roomId: ROOM, eventId: "$abc:example.org" });
    expect(parseMatrixExternalId(`${ROOM}:$Ab_cD`)).toEqual({ roomId: ROOM, eventId: "$Ab_cD" });
    expect(() => parseMatrixExternalId("garbage")).toThrow();
  });
});

describe("matrix sync", () => {
  const sync1: MatrixSyncResponse = {
    next_batch: "s72595_4483_1934",
    account_data: { events: [{ type: "m.direct", content: { "@bob:example.org": [DM] } }] },
    rooms: {
      join: {
        [ROOM]: {
          state: { events: [{ type: "m.room.member", event_id: "$m", sender: "@alice:example.org", state_key: "@alice:example.org", origin_server_ts: 1, content: { membership: "join", displayname: "Alice A." } }] },
          timeline: {
            events: [
              ev("$old", { body: "before since" }, { origin_server_ts: NOW.getTime() - 3_600_000 }),
              ev("$new", { body: "hi @baseair:example.org" }),
              { type: "m.room.name", event_id: "$n", sender: "@alice:example.org", state_key: "", origin_server_ts: 2, content: { name: "Community HQ" } },
            ],
          },
        },
        [SECRET_ROOM]: { timeline: { events: [{ type: "m.room.encrypted", event_id: "$enc1", sender: "@alice:example.org", origin_server_ts: NOW.getTime(), content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "AwgA…" } }, { type: "m.room.encrypted", event_id: "$enc2", sender: "@bob:example.org", origin_server_ts: NOW.getTime(), content: {} }] } },
        [DM]: { timeline: { events: [ev("$dm", { body: "can you help?" }, { sender: "@bob:example.org" })] } },
        "!unwatched:example.org": { timeline: { events: [ev("$x", { body: "ignored" })] } },
      },
    },
  };

  it("first sync uses the filter and since; later syncs pass next_batch; encrypted events are counted and skipped", async () => {
    fetchMock.mockResolvedValueOnce(json(sync1)).mockResolvedValueOnce(json({ next_batch: "s72596", rooms: { join: {} } }));
    const c = connector();
    const items = await c.fetchActivity(acct, new Date(NOW.getTime() - 600_000));
    const u = new URL(call(0).url);
    expect(u.pathname).toBe("/_matrix/client/v3/sync");
    expect(u.searchParams.get("since")).toBeNull();
    expect(u.searchParams.get("timeout")).toBe("0");
    expect(JSON.parse(u.searchParams.get("filter")!)).toEqual(matrixSyncFilter([ROOM, SECRET_ROOM, DM]));
    expect(items.map((i) => [i.externalId, i.kind, i.authorName, i.conversation])).toEqual([
      [`${ROOM}:$new`, "mention", "Alice A.", { id: ROOM, name: "Community HQ", type: "group" }],
      [`${DM}:$dm`, "dm", null, { id: DM, name: null, type: "direct" }],
    ]);
    expect(c.lastSync.get("acc1")).toEqual({ messages: 2, encryptedSkipped: 2, limitedRooms: [] });
    await c.fetchActivity(acct, null);
    expect(new URL(call(1).url).searchParams.get("since")).toBe("s72595_4483_1934");
  });

  it("maps sync errors and honors a short M_LIMIT_EXCEEDED once", async () => {
    fetchMock.mockResolvedValueOnce(json({ errcode: "M_LIMIT_EXCEEDED", error: "Too many requests", retry_after_ms: 1500 }, 429)).mockResolvedValueOnce(json({ next_batch: "s1" }));
    expect(await connector().fetchActivity(acct, null)).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(1500);
    fetchMock.mockImplementation(async () => json({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 60_000 }, 429));
    expect(await rejects(connector().fetchActivity(acct, null))).toMatchObject({ kind: "rate_limit", retryable: true, cause: { retryAfterMs: 60_000 } });
    fetchMock.mockImplementation(async () => json({ errcode: "M_UNKNOWN_TOKEN", error: "gone", soft_logout: true }, 401));
    expect(await rejects(connector().fetchActivity(acct, null))).toMatchObject({ kind: "auth" });
  });
});

describe("matrix reply, publish, moderate", () => {
  it("replies with m.in_reply_to, mentions the parent's sender, and uses a txnId from the idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(json({ next_batch: "s1", rooms: { join: { [ROOM]: { timeline: { events: [ev("$q", { body: "question?" })] } } } } }));
    fetchMock.mockImplementation(async () => json({ event_id: "$answer" }));
    const c = connector();
    await c.fetchActivity(acct, null);
    const r = await c.reply(acct, { parentExternalId: `${ROOM}:$q`, text: "Yes!", idempotencyKey: "r1" });
    expect(call(1)).toMatchObject({ method: "PUT", url: `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/send/m.room.message/${matrixTxnId("reply:r1")}` });
    expect(call(1).json()).toEqual({ msgtype: "m.text", body: "Yes!", "m.relates_to": { "m.in_reply_to": { event_id: "$q" } }, "m.mentions": { user_ids: ["@alice:example.org"] } });
    expect(r.externalId).toBe(`${ROOM}:$answer`);
    // same key: no second request (cache), and the txnId is stable so even a cross-restart retry is deduped by the homeserver
    await c.reply(acct, { parentExternalId: `${ROOM}:$q`, text: "Yes!", idempotencyKey: "r1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(matrixTxnId("reply:r1")).toBe(matrixTxnId("reply:r1"));
    expect(matrixTxnId("reply:r1")).not.toBe(matrixTxnId("reply:r2"));
    // a reply to our message is then a "reply"
    fetchMock.mockResolvedValueOnce(json({ next_batch: "s2", rooms: { join: { [ROOM]: { timeline: { events: [ev("$thx", { body: "thanks", "m.relates_to": { "m.in_reply_to": { event_id: "$answer" } } })] } } } } }));
    expect((await c.fetchActivity(acct, null))[0]).toMatchObject({ kind: "reply" });
  });

  it("publishes text with an HTML formatted body and an image uploaded to the media repo", async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/_matrix/media/v3/upload")) return json({ content_uri: "mxc://example.org/AbCdEf" });
      if (u.includes("/send/m.room.message/")) return json({ event_id: u.includes(matrixTxnId("k1:text")) ? "$text" : "$img" });
      throw new Error(`unexpected ${u}`);
    });
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([9, 9, 9, 9]), mime: "image/jpeg" }) };
    const r = await c.publish(acct, { ...input, media: [{ kind: "image", url: "https://cdn.example/p/launch.jpg", width: 1200, height: 800, alt: "Launch banner" }] });
    expect(call(0).json()).toEqual({ msgtype: "m.text", body: "Release 2.0 is out: notes (https://acme.example/notes)", format: "org.matrix.custom.html", formatted_body: 'Release <strong>2.0</strong> is out: <a href="https://acme.example/notes">notes</a>', "m.mentions": {} });
    expect(call(1)).toMatchObject({ method: "POST", url: `${HS}/_matrix/media/v3/upload?filename=launch.jpg`, headers: { "content-type": "image/jpeg", authorization: `Bearer ${TOKEN}` } });
    expect(call(2).json()).toEqual({ msgtype: "m.image", body: "Launch banner", filename: "launch.jpg", url: "mxc://example.org/AbCdEf", info: { mimetype: "image/jpeg", size: 4, w: 1200, h: 800 }, "m.mentions": {} });
    expect(r).toMatchObject({ externalId: `${ROOM}:$text`, threadExternalIds: [`${ROOM}:$img`] });
    expect(markdownLiteToHtml("plain text")).toBeNull();
  });

  it("likes with an m.annotation reaction, unlikes by redacting our reaction, deletes by redaction", async () => {
    const c = connector();
    fetchMock.mockResolvedValueOnce(json({ event_id: "$r" }));
    await c.moderate(acct, { externalId: `${ROOM}:$q`, action: "like" });
    expect(call(0)).toMatchObject({ method: "PUT" });
    expect(call(0).url).toContain(`/rooms/${encodeURIComponent(ROOM)}/send/m.reaction/`);
    expect(call(0).json()).toEqual({ "m.relates_to": { rel_type: "m.annotation", event_id: "$q", key: "👍" } });
    fetchMock
      .mockResolvedValueOnce(json({ chunk: [{ type: "m.reaction", event_id: "$r", sender: ME, origin_server_ts: 1, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$q", key: "👍" } } }, { type: "m.reaction", event_id: "$other", sender: "@bob:example.org", origin_server_ts: 1, content: { "m.relates_to": { key: "👍" } } }] }))
      .mockResolvedValueOnce(json({ event_id: "$redaction" }));
    await c.moderate(acct, { externalId: `${ROOM}:$q`, action: "unlike" });
    expect(call(1).url).toBe(`${HS}/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent("$q")}/m.annotation/m.reaction`);
    expect(call(2)).toMatchObject({ method: "PUT" });
    expect(call(2).url).toContain(`/redact/${encodeURIComponent("$r")}/`);
    fetchMock.mockResolvedValueOnce(json({ errcode: "M_FORBIDDEN", error: "You don't have permission" }, 403));
    expect(await rejects(c.moderate(acct, { externalId: `${ROOM}:$q`, action: "delete" }))).toMatchObject({ kind: "rejected" });
    expect(await rejects(c.moderate(acct, { externalId: `${ROOM}:$q`, action: "hide" }))).toMatchObject({ kind: "rejected" });
  });

  it("counts members for followers_total, validates, and maps errors", async () => {
    fetchMock.mockResolvedValueOnce(json({ joined: { [ME]: {}, "@alice:example.org": {}, "@bob:example.org": {} } }));
    expect(await connector().fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "acc1", metric: "followers_total", value: 3, observedAt: NOW.toISOString(), source: "matrix" }]);
    const c = connector();
    expect(c.validate(acct, { ...input, media: [{ kind: "image", url: "https://a/1.png" }, { kind: "image", url: "https://a/2.png" }] }).map((i) => i.code)).toEqual(["too_many_media"]);
    expect(c.validate(acct, { ...input, text: "x".repeat(30_001) }).map((i) => i.code)).toEqual(["too_long"]);
    expect(mapMatrixError(413, new Headers(), { errcode: "M_TOO_LARGE" }, "x")).toMatchObject({ kind: "rejected" });
    expect(mapMatrixError(502, new Headers(), undefined, "x")).toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${TOKEN}`));
    const e = await rejects(connector().fetchAccountMetrics(acct));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    expect(e.message).not.toContain(TOKEN);
    expect(createMatrixConnectors({}).map((x) => x.name)).toEqual(["matrix"]);
  });
});
