import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, PublishInput } from "../src/types.ts";
import { ConnectorError } from "../src/types.ts";
import { WhatsAppConnector, createWhatsAppConnectors, mapWhatsAppError, parseWhatsAppMessageId, parseWhatsAppWebhook, whatsappMessageId } from "../src/whatsapp.ts";

const TOKEN = "EAAGsystemusertokenSECRET123";
const SECRET = "app-secret-xyz";
const NOW = new Date("2026-11-06T12:00:00.000Z");
const PNID = "106540352242922";
const WABA = "102290129340398";
const BIZ = "15550001111";

const acct = (config: Record<string, unknown> = {}): AccountRef => ({
  id: "a1",
  workspaceId: "w",
  network: "whatsapp",
  externalId: PNID,
  handle: "+1 555-000-1111",
  auth: { accessToken: TOKEN, phoneNumberId: PNID, wabaId: WABA },
  config: { phoneNumberId: PNID, wabaId: WABA, ...config },
});
const input = (over: Partial<PublishInput> = {}): PublishInput => ({ variantId: "v1", text: "Hello group", media: [], thread: [], idempotencyKey: "k1", ...over });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const graphError = (code: number, message = "err", status = 400, details?: string) => json({ error: { message, type: "OAuthException", code, ...(details ? { error_data: { details } } : {}), fbtrace_id: "x" } }, status);

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  const u = new URL(String(url));
  return { url: u, method: init?.method, headers: init?.headers as Record<string, string>, json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const connector = (opts: ConstructorParameters<typeof WhatsAppConnector>[0] = {}) => new WhatsAppConnector({ appSecret: SECRET, verifyToken: "verify-me", now: () => NOW, ...opts });

async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    return err as ConnectorError;
  }
  throw new Error("expected a rejection");
}

// ---- payload fixtures --------------------------------------------------------------------------

const envelope = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: BIZ, phone_number_id: PNID }, ...value } }] }],
});
const contact = (wa_id: string, name: string) => ({ profile: { name }, wa_id });

describe("whatsapp connect", () => {
  it("checks the phone number, subscribes the app to the WABA and returns one account", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: PNID, display_phone_number: "+1 555-000-1111", verified_name: "Acme Support", quality_rating: "GREEN" }));
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    const c = connector();
    const accounts = await c.connectWithInputs({ network: "whatsapp", inputs: { phoneNumberId: ` ${PNID} `, wabaId: WABA, accessToken: ` ${TOKEN} ` } });
    expect(call(0).url.pathname).toBe(`/v26.0/${PNID}`);
    expect(call(0).url.searchParams.get("fields")).toBe("display_phone_number,verified_name,quality_rating");
    expect(call(0).headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call(0).url.toString()).not.toContain(TOKEN);
    expect(call(1).method).toBe("POST");
    expect(call(1).url.pathname).toBe(`/v26.0/${WABA}/subscribed_apps`);
    expect(accounts).toEqual([
      {
        network: "whatsapp",
        identity: { externalId: PNID, handle: "+1 555-000-1111", displayName: "Acme Support" },
        auth: { accessToken: TOKEN, phoneNumberId: PNID, wabaId: WABA },
        config: { phoneNumberId: PNID, wabaId: WABA, displayPhoneNumber: "+1 555-000-1111", verifiedName: "Acme Support", qualityRating: "GREEN", webhooksSubscribed: true },
      },
    ]);
  });

  it("maps a bad token to an auth error without echoing it", async () => {
    fetchMock.mockResolvedValueOnce(graphError(190, `Invalid OAuth access token - Cannot parse access token ${TOKEN}`, 401));
    const err = await rejection(connector().connectWithInputs({ network: "whatsapp", inputs: { phoneNumberId: PNID, wabaId: WABA, accessToken: TOKEN } }));
    expect(err.kind).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("<token>");
  });

  it("reports a failed WABA subscription clearly", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: PNID, display_phone_number: "+1 555-000-1111", verified_name: "Acme" }));
    fetchMock.mockResolvedValueOnce(graphError(200, "Permissions error"));
    const err = await rejection(connector().connectWithInputs({ network: "whatsapp", inputs: { phoneNumberId: PNID, wabaId: WABA, accessToken: TOKEN } }));
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/subscribing this app to WhatsApp Business Account 102290129340398 failed/);
    expect(err.message).toMatch(/whatsapp_business_management/);
  });

  it("rejects a phone number typed instead of the phone number ID", async () => {
    const err = await rejection(connector().connectWithInputs({ network: "whatsapp", inputs: { phoneNumberId: "+1 555 000 1111", wabaId: WABA, accessToken: TOKEN } }));
    expect(err.kind).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("describes an account from its auth blob and declares honest capabilities", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: PNID, display_phone_number: "+1 555-000-1111", verified_name: "Acme Support" }));
    const c = connector({ graphVersion: "25.0" });
    expect(await c.describeAccount({ accessToken: TOKEN, phoneNumberId: PNID })).toEqual({ externalId: PNID, handle: "+1 555-000-1111", displayName: "Acme Support" });
    expect(call(0).url.pathname).toBe(`/v25.0/${PNID}`);
    expect(c.capabilities()).toMatchObject({ publish: true, fetchActivity: false, fetchMetrics: false, webhooks: true, reply: true, moderate: true, accountMetrics: false });
    expect(await c.fetchActivity()).toEqual([]);
    expect(await c.fetchAccountMetrics()).toEqual([]);
  });

  it("reads env: app secret fallback, verify token, graph version", () => {
    const [c] = createWhatsAppConnectors({ META_APP_SECRET: "m", WHATSAPP_VERIFY_TOKEN: "vt", WHATSAPP_GRAPH_VERSION: "v24.0" }) as [WhatsAppConnector];
    expect(c.name).toBe("whatsapp");
    expect(c.networks).toEqual(["whatsapp"]);
    expect(c.connectMethod).toBe("api_key");
    expect(c.connectConfigured).toBe(true);
    expect(c.version).toBe("v24.0");
    expect(c.credentialInputs.map((i) => i.key)).toEqual(["phoneNumberId", "wabaId", "accessToken", "defaultGroupId"]);
    expect(c.credentialInputs.find((i) => i.key === "defaultGroupId")?.optional).toBe(true);
    expect(c.credentialInputs.find((i) => i.key === "accessToken")?.secret).toBe(true);
    const [bare] = createWhatsAppConnectors({}) as [WhatsAppConnector];
    expect(bare.connectConfigured).toBe(false);
    expect(bare.webhook.verify({ "x-hub-signature-256": "sha256=00" }, "{}")).toBe(false);
  });
});

describe("whatsapp webhook", () => {
  it("answers the hub.challenge handshake only with the right verify token", () => {
    const c = connector();
    expect(c.webhook.challenge?.({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "1158201444" })).toBe("1158201444");
    expect(c.webhook.challenge?.({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" })).toBeNull();
    expect(c.webhook.challenge?.({})).toBeNull();
  });

  it("verifies X-Hub-Signature-256 over the raw body", () => {
    const c = connector();
    const raw = JSON.stringify(envelope({ messages: [] }));
    const good = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
    expect(c.webhook.verify({ "x-hub-signature-256": good }, raw)).toBe(true);
    expect(c.webhook.verify({ "X-Hub-Signature-256": good }, raw)).toBe(true);
    expect(c.webhook.verify({ "x-hub-signature-256": good }, `${raw} `)).toBe(false);
    expect(c.webhook.verify({ "x-hub-signature-256": `sha256=${createHmac("sha256", "other").update(raw).digest("hex")}` }, raw)).toBe(false);
    expect(c.webhook.verify({}, raw)).toBe(false);
  });

  it("parses a 1:1 text message as a dm with the contact's name", () => {
    const body = envelope({ contacts: [contact("16505551234", "Ana Ruiz")], messages: [{ from: "16505551234", id: "wamid.AAA", timestamp: "1793966400", type: "text", text: { body: "Is the shop open today?" } }] });
    const [batch] = connector().webhook.parse(body);
    expect(batch?.network).toBe("whatsapp");
    expect(batch?.accountExternalId).toBe(PNID);
    expect(batch?.items).toEqual([
      expect.objectContaining({
        network: "whatsapp",
        kind: "dm",
        externalId: "16505551234:wamid.AAA",
        authorHandle: "16505551234",
        authorName: "Ana Ruiz",
        text: "Is the shop open today?",
        url: null,
        parentExternalId: null,
        occurredAt: "2026-11-06T12:00:00.000Z",
        conversation: { id: "16505551234", type: "direct" },
      }),
    ]);
  });

  it("never uses a phone number as the author name", () => {
    const body = envelope({ contacts: [contact("16505551234", "+1 650 555 1234")], messages: [{ from: "16505551234", id: "wamid.P", timestamp: "1793966400", type: "text", text: { body: "hi" } }] });
    const item = parseWhatsAppWebhook(body, NOW)[0]?.items[0];
    expect(item?.authorName).toBeNull();
    expect(item?.authorHandle).toBe("16505551234");
  });

  it("parses a group message with the group as conversation and the sender's name from contacts", () => {
    const body = envelope({
      contacts: [contact("16505551234", "Ana Ruiz"), contact("447700900123", "Ben Ode")],
      messages: [{ from: "447700900123", group_id: "Y2FwaV9ncm91cDoxNTU1", id: "wamid.G1", timestamp: "1793966400", type: "text", text: { body: "Who is coming Friday?" } }],
    });
    const item = parseWhatsAppWebhook(body, NOW)[0]?.items[0];
    expect(item).toMatchObject({
      kind: "message",
      externalId: "group:Y2FwaV9ncm91cDoxNTU1:wamid.G1",
      authorHandle: "447700900123",
      authorName: "Ben Ode",
      conversation: { id: "Y2FwaV9ncm91cDoxNTU1", name: null, type: "group" },
    });
  });

  it("marks group replies to the business and @mentions of the business number", () => {
    const body = envelope({
      contacts: [contact("447700900123", "Ben Ode")],
      messages: [
        { from: "447700900123", group_id: "G", id: "wamid.R", timestamp: "1793966400", type: "text", text: { body: "Thanks!" }, context: { from: BIZ, id: "wamid.OURS" } },
        { from: "447700900123", group_id: "G", id: "wamid.M", timestamp: "1793966400", type: "text", text: { body: `@${BIZ} can you help?` } },
        { from: BIZ, group_id: "G", id: "wamid.ECHO", timestamp: "1793966400", type: "text", text: { body: "our own" } },
      ],
    });
    const items = parseWhatsAppWebhook(body, NOW)[0]?.items ?? [];
    expect(items.map((i) => [i.kind, i.parentExternalId])).toEqual([
      ["reply", "group:G:wamid.OURS"],
      ["mention", null],
    ]);
  });

  it("maps media captions, interactive replies, reply context and reactions", () => {
    const from = "16505551234";
    const body = envelope({
      contacts: [contact(from, "Ana Ruiz")],
      messages: [
        { from, id: "wamid.IMG", timestamp: "1793966400", type: "image", image: { caption: "Broken box on arrival", id: "media1", mime_type: "image/jpeg" } },
        { from, id: "wamid.VID", timestamp: "1793966400", type: "video", video: { caption: "see video", id: "m2" } },
        { from, id: "wamid.DOC", timestamp: "1793966400", type: "document", document: { caption: "invoice", filename: "inv.pdf", id: "m3" } },
        { from, id: "wamid.BTN", timestamp: "1793966400", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes, please" } } },
        { from, id: "wamid.LST", timestamp: "1793966400", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "s", title: "Small", description: "S size" } } },
        { from, id: "wamid.CTX", timestamp: "1793966400", type: "text", text: { body: "replying" }, context: { from: BIZ, id: "wamid.PARENT" } },
        { from, id: "wamid.RX", timestamp: "1793966400", type: "reaction", reaction: { message_id: "wamid.PARENT", emoji: "❤️" } },
        { from, id: "wamid.RX0", timestamp: "1793966400", type: "reaction", reaction: { message_id: "wamid.PARENT", emoji: "" } },
        { from, id: "wamid.SYS", timestamp: "1793966400", type: "system" },
        { from, id: "wamid.UNS", timestamp: "1793966400", type: "unsupported" },
      ],
    });
    const items = parseWhatsAppWebhook(body, NOW)[0]?.items ?? [];
    expect(items.map((i) => [i.kind, i.text, i.parentExternalId])).toEqual([
      ["dm", "Broken box on arrival", null],
      ["dm", "see video", null],
      ["dm", "invoice", null],
      ["dm", "Yes, please", null],
      ["dm", "Small", null],
      ["dm", "replying", `${from}:wamid.PARENT`],
      ["like", "❤️", `${from}:wamid.PARENT`],
    ]);
    expect(items.every((i) => i.authorName === "Ana Ruiz")).toBe(true);
  });

  it("ignores status updates and other fields", () => {
    const statuses = envelope({ statuses: [{ id: "wamid.S", status: "delivered", timestamp: "1793966400", recipient_id: "16505551234" }] });
    expect(parseWhatsAppWebhook(statuses, NOW)).toEqual([]);
    expect(parseWhatsAppWebhook({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "message_template_status_update", value: {} }] }] }, NOW)).toEqual([]);
    expect(parseWhatsAppWebhook({ object: "page", entry: [] }, NOW)).toEqual([]);
  });

  it("falls back to the BSUID when the phone number is withheld", () => {
    const body = envelope({ contacts: [{ user_id: "US.13491208655302741918", profile: { name: "Cam", username: "cam.l" } }], messages: [{ from_user_id: "US.13491208655302741918", id: "wamid.U", timestamp: "1793966400", type: "text", text: { body: "hey" } }] });
    const item = parseWhatsAppWebhook(body, NOW)[0]?.items[0];
    expect(item).toMatchObject({ kind: "dm", authorHandle: "US.13491208655302741918", authorName: "Cam", conversation: { id: "US.13491208655302741918", type: "direct" } });
  });
});

describe("whatsapp reply", () => {
  it("sends a text with context to the wa_id", async () => {
    fetchMock.mockResolvedValueOnce(json({ messaging_product: "whatsapp", contacts: [{ input: "16505551234", wa_id: "16505551234" }], messages: [{ id: "wamid.OUT" }] }));
    const res = await connector().reply(acct(), { parentExternalId: "16505551234:wamid.IN", text: "Yes, until 6pm.", idempotencyKey: "r1" });
    expect(call(0).method).toBe("POST");
    expect(call(0).url.pathname).toBe(`/v26.0/${PNID}/messages`);
    expect(call(0).json()).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "16505551234", type: "text", text: { body: "Yes, until 6pm.", preview_url: false }, context: { message_id: "wamid.IN" } });
    expect(res.externalId).toBe("16505551234:wamid.OUT");
  });

  it("replies into a group with recipient_type group", async () => {
    fetchMock.mockResolvedValueOnce(json({ messages: [{ id: "wamid.GOUT" }] }));
    const res = await connector().reply(acct(), { parentExternalId: "group:G1:wamid.IN", text: "On it", idempotencyKey: "r2" });
    expect(call(0).json()).toMatchObject({ recipient_type: "group", to: "G1", context: { message_id: "wamid.IN" } });
    expect(res.externalId).toBe("group:G1:wamid.GOUT");
  });

  it("answers a bare wamid it saw by webhook in this process", async () => {
    const c = connector();
    c.webhook.parse(envelope({ contacts: [contact("16505551234", "Ana")], messages: [{ from: "16505551234", id: "wamid.SEEN", timestamp: "1793966400", type: "text", text: { body: "hi" } }] }));
    fetchMock.mockResolvedValueOnce(json({ messages: [{ id: "wamid.OUT2" }] }));
    await c.reply(acct(), { parentExternalId: "wamid.SEEN", text: "hello", idempotencyKey: "r3" });
    expect(call(0).json()).toMatchObject({ to: "16505551234" });
    const err = await rejection(connector().reply(acct(), { parentExternalId: "wamid.UNKNOWN", text: "x", idempotencyKey: "r4" }));
    expect(err.kind).toBe("rejected");
  });

  it("maps the 24-hour window error to a plain rejected error", async () => {
    fetchMock.mockResolvedValueOnce(graphError(131047, "Re-engagement message", 400, "Message failed to send because more than 24 hours have passed since the customer last replied to this number."));
    const err = await rejection(connector().reply(acct(), { parentExternalId: "16505551234:wamid.OLD", text: "late", idempotencyKey: "r5" }));
    expect(err.kind).toBe("rejected");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/outside the 24-hour window; WhatsApp only allows an approved template now/);
  });
});

describe("whatsapp publish", () => {
  it("validates that posts need a default group", () => {
    const c = connector();
    expect(c.validate(acct(), input())).toEqual([{ code: "empty", message: "WhatsApp posts go to a group; set one up first" }]);
    expect(c.validate(acct({ defaultGroupId: "G1" }), input())).toEqual([]);
    expect(c.validate(acct({ defaultGroupId: "G1" }), input({ thread: ["more"], media: [{ kind: "gif", url: "https://cdn.example/a.gif" }] })).map((i) => i.code)).toEqual(["thread_unsupported", "unsupported_media"]);
  });

  it("refuses to publish without a group", async () => {
    const err = await rejection(connector().publish(acct(), input()));
    expect(err.kind).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends text to the default group, once per idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(json({ messages: [{ id: "wamid.POST" }] }));
    const c = connector();
    const a = acct({ defaultGroupId: "G1" });
    const res = await c.publish(a, input({ options: { link: "https://acme.example/sale" } }));
    const again = await c.publish(a, input({ options: { link: "https://acme.example/sale" } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).json()).toEqual({ messaging_product: "whatsapp", recipient_type: "group", to: "G1", type: "text", text: { body: "Hello group\n\nhttps://acme.example/sale", preview_url: true } });
    expect(res).toEqual(again);
    expect(res.externalId).toBe("group:G1:wamid.POST");
    expect(res.url).toBeNull();
  });

  it("sends one image by link with the text as caption", async () => {
    fetchMock.mockResolvedValueOnce(json({ messages: [{ id: "wamid.IMG" }] }));
    await connector().publish(acct({ defaultGroupId: "G1" }), input({ media: [{ kind: "image", url: "https://cdn.example/p.jpg" }] }));
    expect(call(0).json()).toEqual({ messaging_product: "whatsapp", recipient_type: "group", to: "G1", type: "image", image: { link: "https://cdn.example/p.jpg", caption: "Hello group" } });
  });

  it("sends a document with its filename and splits a caption that is too long", async () => {
    fetchMock.mockResolvedValueOnce(json({ messages: [{ id: "wamid.D" }] }));
    fetchMock.mockResolvedValueOnce(json({ messages: [{ id: "wamid.T" }] }));
    const long = "x".repeat(1500);
    const res = await connector().publish(acct({ defaultGroupId: "G1" }), input({ text: long, media: [{ kind: "document", url: "https://cdn.example/menu.pdf?v=2" }] }));
    expect(call(0).json()).toMatchObject({ type: "document", document: { link: "https://cdn.example/menu.pdf?v=2", filename: "menu.pdf" } });
    expect((call(0).json().document as Record<string, unknown>).caption).toBeUndefined();
    expect(call(1).json()).toMatchObject({ type: "text", text: { body: long } });
    expect(res.externalId).toBe("group:G1:wamid.D");
  });
});

describe("whatsapp moderate", () => {
  it("likes with a 👍 reaction and removes it with an empty emoji", async () => {
    fetchMock.mockImplementation(async () => json({ messages: [{ id: "wamid.RX" }] }));
    const c = connector();
    await c.moderate(acct(), { externalId: "16505551234:wamid.IN", action: "like" });
    await c.moderate(acct(), { externalId: "group:G1:wamid.IN", action: "unlike" });
    expect(call(0).json()).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "16505551234", type: "reaction", reaction: { message_id: "wamid.IN", emoji: "👍" } });
    expect(call(1).json()).toMatchObject({ recipient_type: "group", to: "G1", reaction: { message_id: "wamid.IN", emoji: "" } });
  });

  it("rejects hide and delete", async () => {
    const err = await rejection(connector().moderate(acct(), { externalId: "16505551234:wamid.IN", action: "hide" }));
    expect(err.kind).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("whatsapp errors", () => {
  it.each([4, 80007, 130429, 131056])("code %i is a retryable rate limit", async (code) => {
    fetchMock.mockResolvedValueOnce(graphError(code, "Rate limit hit"));
    const err = await rejection(connector().reply(acct(), { parentExternalId: "16505551234:wamid.IN", text: "x", idempotencyKey: `rl${code}` }));
    expect(err.kind).toBe("rate_limit");
    expect(err.retryable).toBe(true);
  });

  it("maps 131026, 5xx and network failures", async () => {
    expect(mapWhatsAppError("send", 400, new Headers(), { error: { code: 131026, message: "Message Undeliverable" } })).toMatchObject({ kind: "rejected", retryable: false });
    expect(mapWhatsAppError("send", 503, new Headers(), "Service Unavailable")).toMatchObject({ kind: "network", retryable: true });
    expect(mapWhatsAppError("send", 400, new Headers(), { error: { code: 131000, message: "Something went wrong" } })).toMatchObject({ kind: "network", retryable: true });
    expect(mapWhatsAppError("send", 400, new Headers(), { error: { code: 190, message: "expired" } })).toMatchObject({ kind: "auth", retryable: false });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const err = await rejection(connector().reply(acct(), { parentExternalId: "16505551234:wamid.IN", text: "x", idempotencyKey: "net" }));
    expect(err).toMatchObject({ kind: "network", retryable: true });
  });

  it("round-trips message ids", () => {
    expect(parseWhatsAppMessageId(whatsappMessageId({ id: "G:1", type: "group" }, "wamid.X"))).toEqual({ conversation: { id: "G:1", type: "group" }, wamid: "wamid.X" });
    expect(parseWhatsAppMessageId("wamid.X")).toEqual({ conversation: null, wamid: "wamid.X" });
  });
});
