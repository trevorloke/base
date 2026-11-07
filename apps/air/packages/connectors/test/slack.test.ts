import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { SlackConnector, createSlackConnectors, mapSlackError, parseSlackMessageId, slackEnvelopeToActivities, slackPermalink, slackRouteTeam, slackSignatureValid, toMrkdwn, type SlackEventEnvelope } from "../src/slack.ts";

// A made-up bot token in the right shape, assembled at runtime so secret scanners do not mistake it for a real one.
const TOKEN = ["xoxb", "1111111111", "2222222222", "abcdefghijklmnopqrstuvwx"].join("-");
const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const OTHER_SECRET = "00000000000000000000000000000000";
const TEAM = "T0ACME123";
const BOT = "U0BOT0001";
const NOW = new Date("2026-11-06T10:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

const acct: AccountRef = {
  id: "acc1",
  workspaceId: "w",
  network: "slack",
  externalId: TEAM,
  handle: "Acme",
  auth: { botToken: TOKEN, signingSecret: SECRET },
  config: {
    teamId: TEAM,
    teamName: "Acme",
    teamUrl: "https://acme.slack.com/",
    botUserId: BOT,
    botId: "B0BOT",
    channels: [
      { id: "C0GENERAL", name: "general", isPrivate: false },
      { id: "G0PRIVATE", name: "launch", isPrivate: true },
    ],
    watchChannelIds: [],
    defaultChannelId: "C0GENERAL",
    eventsRequestUrl: null,
  },
};
const input: PublishInput = { variantId: "v1", text: "Launch day **today** — see [the notes](https://acme.example/notes) <3", media: [], thread: [], idempotencyKey: "k1" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return { url: String(url), method: init?.method, headers, body: init?.body, form: () => Object.fromEntries(new URLSearchParams(String(init?.body))) };
}
const calls = () => fetchMock.mock.calls.map((c) => String(c[0]).replace("https://slack.com/api/", ""));
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const sleep = vi.fn(async () => {});
const connector = (opts: ConstructorParameters<typeof SlackConnector>[0] = {}) => new SlackConnector({ now: () => NOW, sleep, ...opts });

async function rejects(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    return err as ConnectorError;
  }
  throw new Error("expected a rejection");
}

function sign(raw: string, secret = SECRET, ts = NOW_S) {
  return { "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}` };
}

const envelope = (event: Record<string, unknown>): SlackEventEnvelope => ({
  type: "event_callback",
  token: "legacy",
  team_id: TEAM,
  api_app_id: "A0APP",
  event_id: "Ev0001",
  event_time: NOW_S,
  authorizations: [{ team_id: TEAM, user_id: BOT, is_bot: true }],
  event: { type: "message", channel: "C0GENERAL", channel_type: "channel", user: "U0ALICE", text: "hello", ts: "1793959200.000100", event_ts: "1793959200.000100", ...event } as SlackEventEnvelope["event"],
});

describe("slack connect", () => {
  it("checks the token, lists channels the bot is in (paged) and returns one account per workspace", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      const u = String(url);
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      if (u.endsWith("/auth.test")) return json({ ok: true, url: "https://acme.slack.com/", team: "Acme", user: "starsign", team_id: TEAM, user_id: BOT, bot_id: "B0BOT" });
      if (u.endsWith("/conversations.list") && !form.cursor)
        return json({ ok: true, channels: [{ id: "C0GENERAL", name: "general", is_member: true }, { id: "C0RANDOM", name: "random", is_member: false }], response_metadata: { next_cursor: "dGVhbTpD" } });
      if (u.endsWith("/conversations.list")) return json({ ok: true, channels: [{ id: "G0PRIVATE", name: "launch", is_private: true, is_member: true }], response_metadata: { next_cursor: "" } });
      throw new Error(`unexpected ${u}`);
    });
    const c = connector({ publicUrl: "https://app.example/" });
    const accounts = await c.connectWithInputs({ network: "slack", inputs: { botToken: ` ${TOKEN} `, signingSecret: SECRET, channelIds: "G0PRIVATE, C0GENERAL" } });
    expect(call(0)).toMatchObject({ url: "https://slack.com/api/auth.test", method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(call(1).form()).toMatchObject({ types: "public_channel,private_channel", exclude_archived: "true", limit: "200" });
    expect(call(2).form()).toMatchObject({ cursor: "dGVhbTpD" });
    expect(accounts).toEqual([
      {
        network: "slack",
        identity: { externalId: TEAM, handle: "Acme", displayName: "Acme" },
        auth: { botToken: TOKEN, signingSecret: SECRET },
        config: {
          teamId: TEAM,
          teamName: "Acme",
          teamUrl: "https://acme.slack.com/",
          botUserId: BOT,
          botId: "B0BOT",
          channels: [
            { id: "C0GENERAL", name: "general", isPrivate: false },
            { id: "G0PRIVATE", name: "launch", isPrivate: true },
          ],
          watchChannelIds: ["G0PRIVATE", "C0GENERAL"],
          defaultChannelId: "G0PRIVATE",
          eventsRequestUrl: `https://app.example/webhooks/slack?team=${TEAM}`,
        },
      },
    ]);
    expect(c.credentialInputs.map((i) => [i.key, "secret" in i && i.secret, "optional" in i && i.optional])).toEqual([
      ["botToken", true, false],
      ["signingSecret", true, true],
      ["channelIds", false, true],
    ]);
    expect(c.capabilities()).toMatchObject({ publish: true, fetchActivity: true, reply: true, moderate: true, accountMetrics: true, webhooks: true });
  });

  it("refuses non-bot tokens, bad tokens and channels the bot is not in", async () => {
    const c = connector();
    expect(await rejects(c.connectWithInputs({ network: "slack", inputs: { botToken: "xoxp-user-token-123456" } }))).toMatchObject({ kind: "auth" });
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "invalid_auth" }));
    expect(await rejects(c.connectWithInputs({ network: "slack", inputs: { botToken: TOKEN } }))).toMatchObject({ kind: "auth", retryable: false });
    fetchMock.mockResolvedValueOnce(json({ ok: true, team: "Acme", team_id: TEAM, user_id: BOT, bot_id: "B0BOT" })).mockResolvedValueOnce(json({ ok: true, channels: [{ id: "C0GENERAL", name: "general", is_member: true }] }));
    const e = await rejects(c.connectWithInputs({ network: "slack", inputs: { botToken: TOKEN, channelIds: "C0NOTIN" } }));
    expect(e).toMatchObject({ kind: "rejected" });
    expect(e.message).toContain("/invite");
  });

  it("defaults to the first public channel and works without a signing secret (polling only)", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, team: "Acme", team_id: TEAM, user_id: BOT, bot_id: "B0BOT" })).mockResolvedValueOnce(json({ ok: true, channels: [{ id: "G0PRIVATE", name: "launch", is_private: true, is_member: true }, { id: "C0GENERAL", name: "general", is_member: true }] }));
    const [a] = await connector().connectWithInputs({ network: "slack", inputs: { botToken: TOKEN } });
    expect(a!.auth).toEqual({ botToken: TOKEN });
    expect(a!.config).toMatchObject({ defaultChannelId: "C0GENERAL", watchChannelIds: [] });
  });
});

describe("slack webhook signature", () => {
  const raw = JSON.stringify(envelope({}));
  it("accepts the v0 signature from the account's signing secret", () => {
    expect(slackSignatureValid(SECRET, sign(raw), raw, NOW.getTime())).toBe(true);
    expect(connector().webhook.verifyAccount!(acct, sign(raw), raw, {})).toBe(true);
  });
  it("rejects another secret, a tampered body, a missing header and stale or future timestamps", () => {
    const c = connector();
    expect(c.webhook.verifyAccount!(acct, sign(raw, OTHER_SECRET), raw, {})).toBe(false);
    expect(c.webhook.verifyAccount!(acct, sign(raw), raw.replace("hello", "hellO"), {})).toBe(false);
    expect(c.webhook.verifyAccount!(acct, { "x-slack-request-timestamp": String(NOW_S) }, raw, {})).toBe(false);
    expect(c.webhook.verifyAccount!(acct, sign(raw, SECRET, NOW_S - 301), raw, {})).toBe(false);
    expect(c.webhook.verifyAccount!(acct, sign(raw, SECRET, NOW_S + 301), raw, {})).toBe(false);
    expect(c.webhook.verifyAccount!({ ...acct, auth: { botToken: TOKEN } }, sign(raw), raw, {})).toBe(false); // no signing secret stored
    expect(c.webhook.verify({}, raw)).toBe(false);
  });
  it("routes by ?team= first, then the body's team_id", () => {
    expect(slackRouteTeam(raw, {})).toBe(TEAM);
    expect(slackRouteTeam(JSON.stringify({ type: "url_verification", challenge: "x" }), {})).toBeNull();
    expect(connector().webhook.route!(JSON.stringify({ type: "url_verification", challenge: "x" }), { team: TEAM }, {})).toEqual({ network: "slack", accountExternalId: TEAM });
    expect(slackRouteTeam("not json", {})).toBeNull();
  });
});

describe("slack url_verification", () => {
  it("echoes the challenge through respond, and leaves events to the default reply", () => {
    const c = connector();
    const raw = JSON.stringify({ token: "legacy", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P", type: "url_verification" });
    // the same steps core runs: route (from ?team=) → verifyAccount → parse → respond
    expect(c.webhook.route!(raw, { team: TEAM }, sign(raw))).toEqual({ network: "slack", accountExternalId: TEAM });
    expect(c.webhook.verifyAccount!(acct, sign(raw), raw, { team: TEAM })).toBe(true);
    expect(c.webhook.parse(JSON.parse(raw))).toEqual([]);
    expect(c.webhook.respond!(JSON.parse(raw), {})).toEqual({ body: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P", contentType: "text/plain" });
    expect(c.webhook.respond!(envelope({}), {})).toBeNull();
    expect(c.webhook.ack).toBeUndefined();
  });
});

describe("slack event mapping", () => {
  it("maps channel messages, mentions, DMs, thread replies to the bot and skips bots and system subtypes", () => {
    const c = connector();
    c.webhook.verifyAccount!(acct, sign("{}"), "{}", {}); // teaches parse the channel names
    const batch = c.webhook.parse(envelope({}));
    expect(batch).toEqual([
      {
        network: "slack",
        accountExternalId: TEAM,
        items: [
          {
            network: "slack",
            kind: "message",
            externalId: "C0GENERAL:1793959200.000100",
            authorHandle: "U0ALICE",
            authorName: null,
            text: "hello",
            url: "https://acme.slack.com/archives/C0GENERAL/p1793959200000100",
            parentExternalId: null,
            occurredAt: "2026-11-06T10:00:00.000Z",
            raw: envelope({}),
            conversation: { id: "C0GENERAL", name: "#general", type: "channel" },
          },
        ],
      },
    ]);
    const ctx = { botUserId: null };
    expect(slackEnvelopeToActivities(envelope({ text: `<@${BOT}> when is launch?` }), ctx)[0]).toMatchObject({ kind: "mention" }); // bot id from authorizations
    expect(slackEnvelopeToActivities(envelope({ type: "app_mention", channel_type: undefined, text: `<@${BOT}> hi` }), ctx)[0]).toMatchObject({ kind: "mention" });
    expect(slackEnvelopeToActivities(envelope({ channel: "D0DM", channel_type: "im", text: `<@${BOT}> help` }), ctx)[0]).toMatchObject({ kind: "dm", conversation: { id: "D0DM", type: "direct" } });
    expect(slackEnvelopeToActivities(envelope({ channel: "G0MPIM", channel_type: "mpim" }), ctx)[0]).toMatchObject({ kind: "message", conversation: { type: "group" } });
    expect(slackEnvelopeToActivities(envelope({ thread_ts: "1793950000.000001", parent_user_id: BOT }), ctx)[0]).toMatchObject({ kind: "reply", parentExternalId: "C0GENERAL:1793950000.000001", url: null }); // no workspace URL known → no permalink
    expect(slackEnvelopeToActivities(envelope({ thread_ts: "1793950000.000001", parent_user_id: "U0BOB" }), ctx)[0]).toMatchObject({ kind: "message", parentExternalId: "C0GENERAL:1793950000.000001" });
    expect(slackEnvelopeToActivities(envelope({ subtype: "thread_broadcast", thread_ts: "1793950000.000001" }), ctx)).toHaveLength(1);
    expect(slackEnvelopeToActivities(envelope({ subtype: "file_share", text: "", files: [{ name: "plan.pdf" }] }), ctx)[0]).toMatchObject({ text: "[file: plan.pdf]" });
    expect(slackEnvelopeToActivities(envelope({ subtype: "channel_join" }), ctx)).toEqual([]);
    expect(slackEnvelopeToActivities(envelope({ subtype: "message_changed" }), ctx)).toEqual([]);
    expect(slackEnvelopeToActivities(envelope({ subtype: "bot_message", bot_id: "B0OTHER", user: undefined }), ctx)).toEqual([]);
    expect(slackEnvelopeToActivities(envelope({ bot_id: "B0OTHER" }), ctx)).toEqual([]);
    expect(slackEnvelopeToActivities(envelope({ user: BOT }), ctx)).toEqual([]); // our own message
    expect(slackEnvelopeToActivities(envelope({ text: "a &lt;b&gt; &amp; c" }), ctx)[0]!.text).toBe("a <b> & c");
    expect(slackEnvelopeToActivities({ type: "app_rate_limited" }, ctx)).toEqual([]);
  });

  it("builds permalinks and mrkdwn", () => {
    expect(slackPermalink("https://acme.slack.com/", "C1", "1.000200", "0.5")).toBe("https://acme.slack.com/archives/C1/p1000200?thread_ts=0.5&cid=C1");
    expect(toMrkdwn("**big** & [x](https://a.example/p?q=1) <tag> ~~old~~")).toBe("*big* &amp; <https://a.example/p?q=1|x> &lt;tag&gt; ~old~");
    expect(parseSlackMessageId("C0GENERAL:1793959200.000100")).toEqual({ channel: "C0GENERAL", ts: "1793959200.000100" });
    expect(() => parseSlackMessageId("nope")).toThrow();
  });
});

describe("slack polling", () => {
  const msg = (ts: string, extra: Record<string, unknown> = {}) => ({ type: "message", user: "U0ALICE", text: `m${ts}`, ts, ...extra });

  it("reads history with oldest + cursor pages, skips channels the bot left, names authors, and continues from the cursor", async () => {
    const histories: Record<string, string>[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      const u = String(url);
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      if (u.endsWith("/conversations.history")) {
        histories.push(form);
        if (form.channel === "G0PRIVATE") return json({ ok: false, error: "not_in_channel" });
        if (!form.cursor && form.oldest === "1793959000.000000") return json({ ok: true, messages: [msg("1793959300.000300"), msg("1793959200.000200", { bot_id: "B0X", subtype: "bot_message" })], has_more: true, response_metadata: { next_cursor: "bmV4dA==" } });
        if (form.cursor === "bmV4dA==") return json({ ok: true, messages: [msg("1793959100.000100")], has_more: false, response_metadata: { next_cursor: "" } });
        return json({ ok: true, messages: [], has_more: false });
      }
      if (u.endsWith("/users.info")) return json({ ok: true, user: { name: "alice", profile: { display_name: "Alice" } } });
      throw new Error(`unexpected ${u}`);
    });
    const c = connector();
    const items = await c.fetchActivity(acct, new Date(1793959000 * 1000));
    expect(histories[0]).toMatchObject({ channel: "C0GENERAL", limit: "200", oldest: "1793959000.000000", inclusive: "false" });
    expect(histories[1]).toMatchObject({ channel: "C0GENERAL", cursor: "bmV4dA==" });
    expect(items.map((i) => [i.externalId, i.kind, i.authorName, i.conversation?.name])).toEqual([
      ["C0GENERAL:1793959100.000100", "message", "Alice", "#general"],
      ["C0GENERAL:1793959300.000300", "message", "Alice", "#general"],
    ]);
    expect(calls().filter((x) => x === "users.info")).toHaveLength(1);
    // second poll starts after the newest ts seen
    histories.length = 0;
    await c.fetchActivity(acct, new Date(1793959000 * 1000));
    expect(histories[0]).toMatchObject({ channel: "C0GENERAL", oldest: "1793959300.000300" });
  });

  it("waits once on a short Retry-After, and returns what it has when a long 429 hits later", async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url, init) => {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      n++;
      if (n === 1) return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "2" });
      if (form.channel === "C0GENERAL") return json({ ok: true, messages: [msg("1793959300.000300")], has_more: false });
      return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "60" });
    });
    const c = connector({ maxNameLookups: 0 });
    const items = await c.fetchActivity(acct, new Date(1793959000 * 1000));
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(items).toHaveLength(1);
    // nothing read yet → the rate limit surfaces with its retry time
    fetchMock.mockImplementation(async () => json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "30" }));
    const e = await rejects(connector({ maxNameLookups: 0 }).fetchActivity(acct, null));
    expect(e).toMatchObject({ kind: "rate_limit", retryable: true });
    expect((e.cause as { retryAfter: number }).retryAfter).toBe(30);
  });
});

describe("slack reply, publish, upload, reactions", () => {
  it("replies in the parent's thread and remembers its own messages", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, channel: "C0GENERAL", ts: "1793959400.000400" }));
    const c = connector();
    const r = await c.reply(acct, { parentExternalId: "C0GENERAL:1793959200.000100", text: "Thanks **Alice**", idempotencyKey: "r1" });
    expect(call(0).form()).toMatchObject({ channel: "C0GENERAL", thread_ts: "1793959200.000100", text: "Thanks *Alice*" });
    expect(r).toMatchObject({ externalId: "C0GENERAL:1793959400.000400" });
    await c.reply(acct, { parentExternalId: "C0GENERAL:1793959200.000100", text: "Thanks **Alice**", idempotencyKey: "r1" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // idempotent
    // a reply to a reply goes to the thread root
    const parse = c.webhook.parse(envelope({ ts: "1793959500.000500", thread_ts: "1793959400.000400", parent_user_id: BOT }));
    expect(parse[0]!.items[0]).toMatchObject({ kind: "reply" });
    await c.reply(acct, { parentExternalId: "C0GENERAL:1793959500.000500", text: "ok", idempotencyKey: "r2" });
    expect(call(1).form()).toMatchObject({ thread_ts: "1793959400.000400" });
    expect(await rejects(c.reply(acct, { parentExternalId: "garbage", text: "x", idempotencyKey: "r3" }))).toMatchObject({ kind: "rejected" });
  });

  it("publishes mrkdwn text with unfurls to the default channel", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, channel: "C0GENERAL", ts: "1793959600.000600", message: {} }));
    const r = await connector().publish(acct, { ...input, options: { link: "https://acme.example/launch" } });
    expect(call(0).url).toBe("https://slack.com/api/chat.postMessage");
    expect(call(0).headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(call(0).form()).toMatchObject({ channel: "C0GENERAL", mrkdwn: "true", unfurl_links: "true", text: "Launch day *today* — see <https://acme.example/notes|the notes> &lt;3\nhttps://acme.example/launch" });
    expect(r).toMatchObject({ externalId: "C0GENERAL:1793959600.000600", url: "https://acme.slack.com/archives/C0GENERAL/p1793959600000600" });
  });

  it("uploads files with getUploadURLExternal → POST bytes → completeUploadExternal and finds the message ts", async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/files.getUploadURLExternal")) return json({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F0FILE1" });
      if (u === "https://files.slack.com/upload/v1/abc") return new Response("OK - 3", { status: 200 });
      if (u.endsWith("/files.completeUploadExternal")) return json({ ok: true, files: [{ id: "F0FILE1" }] });
      if (u.endsWith("/files.info")) return json({ ok: true, file: { id: "F0FILE1", shares: { public: { C0GENERAL: [{ ts: "1793959700.000700" }] } } } });
      throw new Error(`unexpected ${u}`);
    });
    const c = connector();
    c.media = { fetch: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }) };
    const r = await c.publish(acct, { ...input, text: "Look", media: [{ kind: "image", url: "https://cdn.example/a/photo.png", alt: "Team photo" }] });
    expect(call(0).form()).toEqual({ filename: "photo.png", length: "3", alt_txt: "Team photo" });
    expect(call(1)).toMatchObject({ url: "https://files.slack.com/upload/v1/abc", method: "POST", headers: { "content-type": "image/png" } });
    expect(call(1).headers.authorization).toBeUndefined();
    expect(call(2).form()).toEqual({ files: JSON.stringify([{ id: "F0FILE1", title: "Team photo" }]), channel_id: "C0GENERAL", initial_comment: "Look" });
    expect(sleep).toHaveBeenCalled();
    expect(r).toMatchObject({ externalId: "C0GENERAL:1793959700.000700" });
  });

  it("falls back to a file external id when the share ts never shows up", async () => {
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/files.getUploadURLExternal")) return json({ ok: true, upload_url: "https://files.slack.com/upload/v1/x", file_id: "F0FILE2" });
      if (u.startsWith("https://files.slack.com/")) return new Response("OK", { status: 200 });
      if (u.endsWith("/files.completeUploadExternal")) return json({ ok: true, files: [{ id: "F0FILE2" }] });
      return json({ ok: true, file: { id: "F0FILE2" } });
    });
    const c = connector({ fileSharePolls: 1 });
    c.media = { fetch: async () => ({ bytes: new Uint8Array([1]), mime: "video/mp4" }) };
    const r = await c.publish(acct, { ...input, idempotencyKey: "k-file2", media: [{ kind: "video", url: "https://cdn.example/clip.mp4" }] });
    expect(r.externalId).toBe("C0GENERAL:file:F0FILE2");
  });

  it("likes, unlikes and deletes; already_reacted / no_reaction are fine; deleting others' messages is refused", async () => {
    const c = connector();
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await c.moderate(acct, { externalId: "C0GENERAL:1793959200.000100", action: "like" });
    expect(call(0)).toMatchObject({ url: "https://slack.com/api/reactions.add" });
    expect(call(0).form()).toEqual({ channel: "C0GENERAL", timestamp: "1793959200.000100", name: "thumbsup" });
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "already_reacted" }));
    await c.moderate(acct, { externalId: "C0GENERAL:1793959200.000100", action: "like" });
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "no_reaction" }));
    await c.moderate(acct, { externalId: "C0GENERAL:1793959200.000100", action: "unlike" });
    expect(call(2).url).toBe("https://slack.com/api/reactions.remove");
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await c.moderate(acct, { externalId: "C0GENERAL:1793959600.000600", action: "delete" });
    expect(call(3)).toMatchObject({ url: "https://slack.com/api/chat.delete" });
    expect(call(3).form()).toEqual({ channel: "C0GENERAL", ts: "1793959600.000600" });
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "cant_delete_message" }));
    expect(await rejects(c.moderate(acct, { externalId: "C0GENERAL:1793959200.000100", action: "delete" }))).toMatchObject({ kind: "rejected" });
    expect(await rejects(c.moderate(acct, { externalId: "C0GENERAL:1793959200.000100", action: "hide" }))).toMatchObject({ kind: "rejected" });
  });
});

describe("slack metrics and errors", () => {
  it("followers_total is the default channel's member count; post metrics come from reactions.get", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, channel: { id: "C0GENERAL", num_members: 412 } }));
    expect(await connector().fetchAccountMetrics(acct)).toEqual([{ entityType: "social_account", entityId: "acc1", metric: "followers_total", value: 412, observedAt: NOW.toISOString(), source: "slack" }]);
    expect(call(0).form()).toEqual({ channel: "C0GENERAL", include_num_members: "true" });
    fetchMock.mockResolvedValueOnce(json({ ok: true, type: "message", message: { ts: "1.2", reactions: [{ name: "tada", count: 3 }, { name: "thumbsup", count: 2 }], reply_count: 4 } }));
    const m = await connector().fetchMetrics(acct, ["C0GENERAL:1793959600.000600", "C0GENERAL:file:F1"]);
    expect(m.map((x) => [x.metric, x.value])).toEqual([
      ["likes", 5],
      ["replies", 4],
    ]);
  });

  it("maps Slack errors to ConnectorError kinds without leaking the token", async () => {
    const h = new Headers();
    expect(mapSlackError(200, h, { ok: false, error: "missing_scope", needed: "reactions:write" }, "x")).toMatchObject({ kind: "auth", retryable: false });
    expect(mapSlackError(200, h, { ok: false, error: "token_revoked" }, "x")).toMatchObject({ kind: "auth" });
    expect(mapSlackError(200, h, { ok: false, error: "channel_not_found" }, "x")).toMatchObject({ kind: "rejected" });
    expect(mapSlackError(200, h, { ok: false, error: "internal_error" }, "x")).toMatchObject({ kind: "network", retryable: true });
    expect(mapSlackError(503, h, undefined, "x")).toMatchObject({ kind: "network", retryable: true });
    expect(mapSlackError(429, new Headers({ "retry-after": "7" }), { ok: false, error: "ratelimited" }, "x")).toMatchObject({ kind: "rate_limit", retryable: true, cause: { retryAfter: 7 } });
    fetchMock.mockRejectedValueOnce(new TypeError(`connect failed for ${TOKEN}`));
    const e = await rejects(connector().fetchAccountMetrics(acct));
    expect(e).toMatchObject({ kind: "network", retryable: true });
    expect(e.message).not.toContain(TOKEN);
  });

  it("validates and builds from env", () => {
    const c = connector();
    expect(c.validate(acct, { ...input, text: "x".repeat(40_001) }).map((i) => i.code)).toContain("too_long");
    expect(c.validate(acct, { ...input, text: " ", media: [] }).map((i) => i.code)).toEqual(["empty"]);
    expect(c.validate(acct, { ...input, thread: ["two"] }).map((i) => i.code)).toEqual(["thread_unsupported"]);
    expect(createSlackConnectors({}).map((x) => [x.name, x.networks])).toEqual([["slack", ["slack"]]]);
  });
});
