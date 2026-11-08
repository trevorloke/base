import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError } from "../src/index.ts";
import { DISCORD_EPOCH_MS, DiscordBotConnector, channelPermissions, createDiscordBotConnectors, discordMessageToActivity, snowflakeFromDate, type DiscordApiMessage } from "../src/discord-bot.ts";

// A made-up token in the right shape, assembled at runtime so secret scanners do not mistake it for a real one.
const TOKEN = [Buffer.from("123456789012345678").toString("base64url"), "GhAbCd", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join(".");
const GUILD = "111111111111111111";
const BOT = "999999999999999999";
const GENERAL = "222222222222222222";
const NEWS = "333333333333333333";
const SECRET = "444444444444444444";
const FORUM = "555555555555555555";
const THREAD = "666666666666666666";
const API = "https://discord.com/api/v10";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

/** Route by "METHOD path" (path without the API prefix, query included). Unmatched → 404. */
function routes(table: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${String(url).replace(API, "")}`;
    const hit = table[key];
    return hit ? hit() : json({ message: `no route ${key}`, code: 0 }, 404);
  });
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const acct: AccountRef = {
  id: "acc1",
  workspaceId: "w",
  network: "discord",
  externalId: GUILD,
  handle: "Acme",
  auth: { botToken: TOKEN, guildId: GUILD },
  config: {
    guildId: GUILD,
    botId: BOT,
    botUsername: "baseair",
    channels: [
      { id: GENERAL, name: "general", type: 0 },
      { id: NEWS, name: "news", type: 5 },
      { id: FORUM, name: "help", type: 15 },
    ],
    defaultChannelId: GENERAL,
  },
};

function msg(id: string, over: Partial<DiscordApiMessage> = {}): DiscordApiMessage {
  return { id, channel_id: GENERAL, type: 0, content: `hello ${id}`, timestamp: "2026-11-05T10:00:00.000000+00:00", author: { id: "777", username: "ana", global_name: "Ana" }, mentions: [], attachments: [], embeds: [], ...over };
}

const guildBody = { id: GUILD, name: "Acme", owner_id: "1", approximate_member_count: 4242, roles: [{ id: GUILD, permissions: String((1 << 10) | (1 << 16)) }, { id: "r-bot", permissions: "0" }] };

describe("discord_bot connect", () => {
  const channels = [
    { id: NEWS, type: 5, name: "news", position: 2 },
    { id: GENERAL, type: 0, name: "general", position: 1 },
    { id: "v1", type: 2, name: "Voice", position: 3 },
    { id: "cat", type: 4, name: "Text Channels", position: 0 },
    { id: SECRET, type: 0, name: "mods", position: 4, permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: String(1 << 10) }] },
    { id: FORUM, type: 15, name: "help", position: 5 },
  ];
  const ok = {
    "GET /users/@me": () => json({ id: BOT, username: "baseair", bot: true }),
    [`GET /guilds/${GUILD}?with_counts=true`]: () => json(guildBody),
    "GET /applications/@me": () => json({ id: BOT, flags: 1 << 19 }),
    [`GET /guilds/${GUILD}/channels`]: () => json(channels),
    [`GET /guilds/${GUILD}/members/${BOT}`]: () => json({ roles: ["r-bot"] }),
    [`GET /channels/${GENERAL}/messages?limit=20`]: () => json([msg("10")]),
  };

  it("checks the token, reads the server, lists readable text/announcement/forum channels and returns one account", async () => {
    routes(ok);
    const c = createDiscordBotConnectors({})[0] as DiscordBotConnector;
    expect(c.name).toBe("discord_bot");
    expect(c.connectMethod).toBe("bot_token");
    expect(c.credentialInputs.find((i) => i.key === "botToken")?.secret).toBe(true);
    const accounts = await c.connectWithInputs({ network: "discord", inputs: { botToken: `Bot ${TOKEN}`, guildId: GUILD } });
    expect(accounts).toEqual([
      {
        network: "discord",
        identity: { externalId: GUILD, handle: "Acme", displayName: "Acme" },
        auth: { botToken: TOKEN, guildId: GUILD },
        config: {
          guildId: GUILD,
          botId: BOT,
          botUsername: "baseair",
          channels: [
            { id: GENERAL, name: "general", type: 0 },
            { id: NEWS, name: "news", type: 5 },
            { id: FORUM, name: "help", type: 15 },
          ],
          defaultChannelId: GENERAL,
        },
      },
    ]);
    expect(call(0).headers.authorization).toBe(`Bot ${TOKEN}`);
    expect(c.capabilities()).toMatchObject({ fetchActivity: true, reply: true, moderate: true, accountMetrics: true, webhooks: false });
  });

  it("accepts a default channel input and refuses one the bot cannot read", async () => {
    routes({ ...ok, [`GET /channels/${NEWS}/messages?limit=20`]: () => json([]) });
    const c = new DiscordBotConnector();
    const [a] = await c.connectWithInputs({ network: "discord", inputs: { botToken: TOKEN, guildId: GUILD, defaultChannelId: NEWS } });
    expect(a?.config?.defaultChannelId).toBe(NEWS);
    await expect(c.connectWithInputs({ network: "discord", inputs: { botToken: TOKEN, guildId: GUILD, defaultChannelId: SECRET } })).rejects.toMatchObject({ kind: "rejected" });
  });

  it("maps a bad token to auth without leaking it", async () => {
    const c = new DiscordBotConnector();
    await expect(c.connectWithInputs({ network: "discord", inputs: { botToken: "nope", guildId: GUILD } })).rejects.toMatchObject({ kind: "auth" });
    routes({ "GET /users/@me": () => json({ message: "401: Unauthorized", code: 0 }, 401) });
    const err = (await c.connectWithInputs({ network: "discord", inputs: { botToken: TOKEN, guildId: GUILD } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).toMatch(/token rejected/);
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(err.cause)).not.toContain(TOKEN);
  });

  it("says the bot is not in the server (rejected)", async () => {
    routes({ ...ok, [`GET /guilds/${GUILD}?with_counts=true`]: () => json({ message: "Missing Access", code: 50001 }, 403) });
    const err = (await new DiscordBotConnector().connectWithInputs({ network: "discord", inputs: { botToken: TOKEN, guildId: GUILD } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "rejected", retryable: false });
    expect(err.message).toMatch(/not in server/);
  });

  it("names the Message Content intent when the app flag is off or content comes back empty", async () => {
    routes({ ...ok, "GET /applications/@me": () => json({ id: BOT, flags: 0 }) });
    const c = new DiscordBotConnector();
    await expect(c.connectWithInputs({ network: "discord", inputs: { botToken: TOKEN, guildId: GUILD } })).rejects.toThrow(/Message Content/);
    routes({ ...ok, "GET /applications/@me": () => json({}, 500), [`GET /channels/${GENERAL}/messages?limit=20`]: () => json([msg("10", { content: "" }), msg("11", { content: "" })]) });
    const err = (await c.connectWithInputs({ network: "discord", inputs: { botToken: TOKEN, guildId: GUILD } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err.kind).toBe("rejected");
    expect(err.message).toMatch(/Message Content privileged intent/);
  });

  it("computes channel permissions from roles and overwrites", () => {
    const guild = { id: GUILD, name: "g", roles: [{ id: GUILD, permissions: "0" }, { id: "mod", permissions: String(1 << 10) }, { id: "admin", permissions: String(1 << 3) }] };
    const ch = { id: "c", type: 0, permission_overwrites: [{ id: "mod", type: 0, allow: String(1 << 16), deny: "0" }, { id: BOT, type: 1, allow: "0", deny: String(1 << 16) }] };
    expect(channelPermissions({ guild, botId: "x", memberRoles: ["mod"], channel: ch }) & (1n << 16n)).toBe(1n << 16n);
    expect(channelPermissions({ guild, botId: BOT, memberRoles: ["mod"], channel: ch }) & (1n << 16n)).toBe(0n);
    expect(channelPermissions({ guild, botId: BOT, memberRoles: ["admin"], channel: ch }) & (1n << 16n)).toBe(1n << 16n);
  });
});

describe("discord_bot listen", () => {
  const threadsEmpty = { [`GET /guilds/${GUILD}/threads/active`]: () => json({ threads: [] }) };

  it("derives the first `after` from since, pages forward and keeps a per-channel cursor", async () => {
    const since = new Date("2026-11-05T09:00:00Z");
    const sinceFlake = ((BigInt(since.getTime() - DISCORD_EPOCH_MS)) << 22n).toString();
    expect(snowflakeFromDate(since)).toBe(sinceFlake);
    const id = (n: number) => (BigInt(sinceFlake) + BigInt(n)).toString();
    const page1 = Array.from({ length: 100 }, (_, i) => msg(id(1000 + 99 - i))); // newest first
    const page2 = [msg(id(1101)), msg(id(1100))];
    routes({
      ...threadsEmpty,
      [`GET /channels/${GENERAL}/messages?after=${sinceFlake}&limit=100`]: () => json(page1),
      [`GET /channels/${GENERAL}/messages?after=${id(1099)}&limit=100`]: () => json(page2),
      [`GET /channels/${NEWS}/messages?after=${sinceFlake}&limit=100`]: () => json([]),
    });
    const c = new DiscordBotConnector({ maxThreads: 0 });
    const items = await c.fetchActivity(acct, since);
    expect(items).toHaveLength(102);
    expect(items.map((i) => i.externalId.split(":")[1])).toEqual([...Array.from({ length: 100 }, (_, i) => id(1000 + i)), id(1100), id(1101)]);
    expect(urls().some((u) => u.includes(FORUM))).toBe(false); // forum channels are read through threads only

    // Next poll: the in-memory cursor (newest id seen) wins over the older `since`.
    fetchMock.mockReset();
    routes({ [`GET /channels/${GENERAL}/messages?after=${id(1101)}&limit=100`]: () => json([msg(id(1102))]), [`GET /channels/${NEWS}/messages?after=${sinceFlake}&limit=100`]: () => json([]) });
    const next = await c.fetchActivity(acct, since);
    expect(next.map((i) => i.externalId)).toEqual([`${GENERAL}:${id(1102)}`]);
  });

  it("bounds pages per poll and reads only the newest page with no cursor and no since", async () => {
    const full = (start: number) => Array.from({ length: 100 }, (_, i) => msg(String(start + i)));
    routes({
      [`GET /channels/${GENERAL}/messages?limit=100`]: () => json(full(5000)),
      [`GET /channels/${GENERAL}/messages?after=5099&limit=100`]: () => json(full(5100)),
      [`GET /channels/${NEWS}/messages?limit=100`]: () => json([]),
    });
    const c = new DiscordBotConnector({ maxPages: 2, maxThreads: 0 });
    const items = await c.fetchActivity(acct, null);
    expect(items).toHaveLength(200);
    expect(urls().filter((u) => u.includes(GENERAL))).toHaveLength(2);
  });

  it("maps kinds, conversation, author, url, attachments; skips own and system messages", async () => {
    const own = msg("10", { author: { id: BOT, username: "baseair", bot: true } });
    const items = [
      msg("1"),
      msg("2", { mentions: [{ id: BOT }], content: `<@${BOT}> help?` }),
      msg("3", { content: `hey <@!${BOT}>` }),
      msg("4", { type: 19, content: "thanks!", message_reference: { message_id: "10", channel_id: GENERAL, guild_id: GUILD }, referenced_message: own, mentions: [{ id: BOT }] }),
      msg("5", { type: 19, content: "agree", message_reference: { message_id: "1", channel_id: GENERAL }, referenced_message: msg("1") }),
      msg("6", { content: "", attachments: [{ id: "a", filename: "cat.png" }] }),
      own,
      msg("7", { type: 7, content: "" }), // USER_JOIN
      msg("8", { type: 6, content: "" }), // CHANNEL_PINNED_MESSAGE
    ].map((m) => discordMessageToActivity(m, { guildId: GUILD, botId: BOT, conversationName: "#general" }));
    const [plain, mention, mention2, replyToBot, replyToOther, file, ...rest] = items;
    expect(rest).toEqual([null, null, null]);
    expect(plain).toMatchObject({
      network: "discord",
      kind: "message",
      externalId: `${GENERAL}:1`,
      authorHandle: "ana",
      authorName: "Ana",
      text: "hello 1",
      url: `https://discord.com/channels/${GUILD}/${GENERAL}/1`,
      parentExternalId: null,
      occurredAt: "2026-11-05T10:00:00.000Z",
      conversation: { id: GENERAL, name: "#general", type: "channel" },
    });
    expect(plain?.raw).toBeTruthy();
    expect(mention?.kind).toBe("mention");
    expect(mention2?.kind).toBe("mention");
    expect(replyToBot).toMatchObject({ kind: "reply", parentExternalId: `${GENERAL}:10` });
    expect(replyToOther).toMatchObject({ kind: "message", parentExternalId: `${GENERAL}:1` });
    expect(file?.text).toBe("[attachment: cat.png]");
  });

  it("skips a channel returning 403 Missing Access and keeps polling the others", async () => {
    routes({
      ...threadsEmpty,
      [`GET /channels/${GENERAL}/messages?limit=100`]: () => json({ message: "Missing Access", code: 50001 }, 403),
      [`GET /channels/${NEWS}/messages?limit=100`]: () => json([msg("20", { channel_id: NEWS })]),
    });
    const items = await new DiscordBotConnector().fetchActivity(acct, null);
    expect(items.map((i) => i.externalId)).toEqual([`${NEWS}:20`]);
    expect(items[0]?.conversation).toEqual({ id: NEWS, name: "#news", type: "channel" });
  });

  it("polls active threads of configured forum channels", async () => {
    routes({
      [`GET /guilds/${GUILD}/threads/active`]: () => json({ threads: [{ id: THREAD, type: 11, name: "How do I...", parent_id: FORUM, last_message_id: "30" }, { id: "x", type: 11, name: "elsewhere", parent_id: "other" }] }),
      [`GET /channels/${GENERAL}/messages?limit=100`]: () => json([]),
      [`GET /channels/${NEWS}/messages?limit=100`]: () => json([]),
      [`GET /channels/${THREAD}/messages?limit=100`]: () => json([msg("30", { channel_id: THREAD })]),
    });
    const items = await new DiscordBotConnector().fetchActivity(acct, null);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: `${THREAD}:30`, conversation: { id: THREAD, name: "#help › How do I...", type: "channel" } });
    expect(urls().some((u) => u.includes("/channels/x/"))).toBe(false);
  });

  it("waits once for a short retry_after, then gives up with rate_limit on a long one", async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    routes({
      ...threadsEmpty,
      [`GET /channels/${GENERAL}/messages?limit=100`]: () => (n++ === 0 ? json({ message: "You are being rate limited.", retry_after: 0.5, global: false }, 429) : json([msg("40")])),
      [`GET /channels/${NEWS}/messages?limit=100`]: () => json({ message: "You are being rate limited.", retry_after: 30, global: false }, 429),
    });
    const c = new DiscordBotConnector({ sleep });
    const items = await c.fetchActivity(acct, null);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(items.map((i) => i.externalId)).toEqual([`${GENERAL}:40`]); // partial results returned, NEWS waits for the next poll

    routes({ ...threadsEmpty, [`GET /channels/${GENERAL}/messages?after=40&limit=100`]: () => json({ message: "slow down", retry_after: 12.5 }, 429) });
    const err = (await c.fetchActivity(acct, null).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true });
    expect((err.cause as { retryAfter?: number }).retryAfter).toBe(12.5);
    expect(err.message).not.toContain(TOKEN);
  });

  it("maps 5xx to retryable network errors and scrubs the token from transport errors", async () => {
    routes({ ...threadsEmpty, [`GET /channels/${GENERAL}/messages?limit=100`]: () => json({ message: "oops" }, 502) });
    await expect(new DiscordBotConnector().fetchActivity(acct, null)).rejects.toMatchObject({ kind: "network", retryable: true });
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError(`connect failed for Bot ${TOKEN}`));
    const err = (await new DiscordBotConnector().fetchAccountMetrics(acct).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "network", retryable: true });
    expect(err.message).not.toContain(TOKEN);
    expect(String((err.cause as Error).message)).not.toContain(TOKEN);
  });
});

describe("discord_bot reply, publish, moderate, metrics", () => {
  it("replies with message_reference to the parent's channel", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "51", channel_id: NEWS }));
    const c = new DiscordBotConnector();
    const r = await c.reply(acct, { parentExternalId: `${NEWS}:50`, text: "Thanks!", idempotencyKey: "r1" });
    expect(call(0).url).toBe(`${API}/channels/${NEWS}/messages`);
    expect(call(0).method).toBe("POST");
    expect(call(0).json()).toMatchObject({ content: "Thanks!", message_reference: { message_id: "50", channel_id: NEWS, guild_id: GUILD, fail_if_not_exists: false }, allowed_mentions: { parse: [], replied_user: true } });
    expect(r).toMatchObject({ externalId: `${NEWS}:51`, url: `https://discord.com/channels/${GUILD}/${NEWS}/51` });
    // idempotent
    expect(await c.reply(acct, { parentExternalId: `${NEWS}:50`, text: "Thanks!", idempotencyKey: "r1" })).toEqual(r);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("publishes to the default channel with an attachment as multipart", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "60", channel_id: GENERAL }));
    const c = new DiscordBotConnector();
    const mediaFetch = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }));
    c.media = { fetch: mediaFetch };
    const r = await c.publish(acct, { variantId: "v", text: "Launch @everyone", media: [{ kind: "image", url: "https://cdn.example/a/launch.png", alt: "Rocket" }], thread: [], idempotencyKey: "p1" });
    expect(call(0).url).toBe(`${API}/channels/${GENERAL}/messages`);
    const form = call(0).body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get("payload_json")))).toEqual({ content: "Launch @everyone", allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: "launch.png", description: "Rocket" }] });
    expect((form.get("files[0]") as File).name).toBe("launch.png");
    expect(call(0).headers["content-type"]).toBeUndefined();
    expect(mediaFetch).toHaveBeenCalledTimes(1);
    expect(r.externalId).toBe(`${GENERAL}:60`);
    expect(c.validate(acct, { variantId: "v", text: "x".repeat(2001), media: [], thread: ["more"], idempotencyKey: "z" }).map((i) => i.code)).toEqual(["too_long", "thread_unsupported"]);
  });

  it("deletes, likes and unlikes; refuses hide; explains Manage Messages", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const c = new DiscordBotConnector();
    await c.moderate(acct, { externalId: `${GENERAL}:70`, action: "delete" });
    await c.moderate(acct, { externalId: `${GENERAL}:70`, action: "like" });
    await c.moderate(acct, { externalId: `${GENERAL}:70`, action: "unlike" });
    expect([call(0).method, call(0).url]).toEqual(["DELETE", `${API}/channels/${GENERAL}/messages/70`]);
    expect([call(1).method, call(1).url]).toEqual(["PUT", `${API}/channels/${GENERAL}/messages/70/reactions/%F0%9F%91%8D/@me`]);
    expect([call(2).method, call(2).url]).toEqual(["DELETE", `${API}/channels/${GENERAL}/messages/70/reactions/%F0%9F%91%8D/@me`]);
    await expect(c.moderate(acct, { externalId: `${GENERAL}:70`, action: "hide" })).rejects.toMatchObject({ kind: "rejected" });
    fetchMock.mockResolvedValueOnce(json({ message: "Missing Permissions", code: 50013 }, 403));
    await expect(c.moderate(acct, { externalId: `${GENERAL}:71`, action: "delete" })).rejects.toThrow(/Manage Messages/);
  });

  it("reports followers_total from approximate_member_count", async () => {
    fetchMock.mockResolvedValueOnce(json(guildBody));
    const c = new DiscordBotConnector({ now: () => new Date("2026-11-06T00:00:00Z") });
    expect(await c.fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "acc1", metric: "followers_total", value: 4242, observedAt: "2026-11-06T00:00:00.000Z", source: "discord" }]);
    expect(call(0).url).toBe(`${API}/guilds/${GUILD}?with_counts=true`);
  });
});
