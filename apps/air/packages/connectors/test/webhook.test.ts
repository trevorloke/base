import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, PublishInput } from "../src/index.ts";
import { ConnectorError } from "../src/types.ts";
import { MAX_INBOUND_ITEMS, WebhookConnector, assertPublicHttpUrl, createWebhookConnectors, inboundToActivities, isPrivateAddress, signWebhookPayload, verifyWebhookRequest } from "../src/webhook.ts";

const NOW = new Date("2026-11-06T12:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);
const SECRET = "s3cret-s3cret-s3cret-0123456789";
const OUT = "https://hooks.zapier.com/hooks/catch/123/abcdef/";
const publicLookup = async () => [{ address: "54.1.2.3" }];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function call(i: number) {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`fetch call ${i} was not made`);
  const [url, init] = c;
  return { url: String(url), init: init!, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body), json: () => JSON.parse(String(init?.body)) as Record<string, unknown> };
}
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function connector(extra: Partial<ConstructorParameters<typeof WebhookConnector>[0]> = {}) {
  return new WebhookConnector({ now: () => NOW, lookup: publicLookup, publicUrl: "https://air.example.com/", newAccountId: () => "wh_TESTACCOUNT01", ...extra });
}
const account = (auth: Record<string, unknown>, externalId = "wh_TESTACCOUNT01"): AccountRef => ({ id: `acc-${externalId}`, workspaceId: "w", network: "webhook", externalId, handle: "Zapier", auth, config: {} });
const input: PublishInput = {
  variantId: "v1",
  text: "Launch day",
  media: [{ kind: "image", url: "https://cdn.air.example.com/a.jpg", mime: "image/jpeg", alt: "A rocket" }],
  thread: ["second"],
  options: { link: "https://acme.example.com" },
  idempotencyKey: "idem-1",
};

describe("webhook connect", () => {
  it("validates the outbound URL, pings it signed, and returns the inbound URL in config", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "success", id: "zap-req-1" }));
    const c = connector();
    const [acc] = await c.connectWithInputs({ network: "webhook", inputs: { name: "Zapier → Slack", outboundUrl: OUT, secret: SECRET } });
    expect(acc).toMatchObject({
      network: "webhook",
      identity: { externalId: "wh_TESTACCOUNT01", handle: "Zapier → Slack", displayName: "Zapier → Slack" },
      auth: { accountId: "wh_TESTACCOUNT01", name: "Zapier → Slack", outboundUrl: OUT, secret: SECRET },
      config: { inboundEnabled: true, inboundUrl: "https://air.example.com/webhooks/webhook?account=wh_TESTACCOUNT01", outboundHost: "hooks.zapier.com" },
    });
    expect(JSON.stringify(acc!.config)).not.toContain(SECRET);
    expect(JSON.stringify(acc!.config)).not.toContain("abcdef");
    const ping = call(0);
    expect(ping.url).toBe(OUT);
    expect(ping.json()).toMatchObject({ event: "ping", network: "webhook", account: { id: "wh_TESTACCOUNT01" } });
    expect(ping.headers["x-base-air-signature"]).toBe(signWebhookPayload(SECRET, TS, ping.body));
    expect(ping.init.redirect).toBe("manual");
    expect(c.connectMethod).toBe("webhook_url");
    expect(c.capabilities()).toMatchObject({ publish: true, fetchActivity: false, webhooks: true });
  });

  it("accepts inbound-only endpoints without any network call", async () => {
    const [acc] = await connector().connectWithInputs({ network: "webhook", inputs: { secret: SECRET } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acc!.auth).toEqual({ accountId: "wh_TESTACCOUNT01", name: "Inbound webhook", secret: SECRET });
    expect(await connector().describeAccount(acc!.auth)).toEqual({ externalId: "wh_TESTACCOUNT01", handle: "Inbound webhook", displayName: "Inbound webhook" });
  });

  it("refuses empty inputs, short secrets, http, private hosts and a failing ping", async () => {
    const c = connector();
    await expect(c.connectWithInputs({ network: "webhook", inputs: {} })).rejects.toMatchObject({ kind: "rejected" });
    await expect(c.connectWithInputs({ network: "webhook", inputs: { secret: "short" } })).rejects.toMatchObject({ kind: "rejected" });
    await expect(c.connectWithInputs({ network: "webhook", inputs: { outboundUrl: "http://hooks.example.com/x" } })).rejects.toThrow(/https/);
    await expect(c.connectWithInputs({ network: "webhook", inputs: { outboundUrl: "https://127.0.0.1/x" } })).rejects.toThrow(/private/);
    await expect(c.connectWithInputs({ network: "webhook", inputs: { outboundUrl: "https://localhost/x" } })).rejects.toThrow(/private/);
    const rebinding = connector({ lookup: async () => [{ address: "10.0.0.5" }] });
    await expect(rebinding.connectWithInputs({ network: "webhook", inputs: { outboundUrl: "https://evil.example.com/x" } })).rejects.toThrow(/resolves to a private/);
    fetchMock.mockResolvedValueOnce(json({ error: "not found" }, 404));
    await expect(c.connectWithInputs({ network: "webhook", inputs: { outboundUrl: OUT } })).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows http and private hosts when BASE_AIR_ALLOW_PRIVATE_URLS=1", async () => {
    const [c] = createWebhookConnectors({ BASE_AIR_ALLOW_PRIVATE_URLS: "1" }) as [WebhookConnector];
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    const [acc] = await c.connectWithInputs({ network: "webhook", inputs: { outboundUrl: "http://n8n:5678/webhook/abc" } });
    expect(acc!.auth.outboundUrl).toBe("http://n8n:5678/webhook/abc");
  });
});

describe("webhook publish", () => {
  it("POSTs the documented body, signed over timestamp.body, and uses the response id and url", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "row-42", url: "https://sheets.example.com/row/42" }));
    const c = connector();
    const r = await c.publish(account({ accountId: "wh_TESTACCOUNT01", name: "Zapier", outboundUrl: OUT, secret: SECRET }), input);
    expect(r).toMatchObject({ externalId: "row-42", url: "https://sheets.example.com/row/42" });
    const req = call(0);
    expect(req.init.method).toBe("POST");
    expect(req.json()).toEqual({
      event: "post.published",
      id: "idem-1",
      text: "Launch day",
      thread: ["second"],
      media: [{ url: "https://cdn.air.example.com/a.jpg", kind: "image", mime: "image/jpeg", alt: "A rocket" }],
      options: { link: "https://acme.example.com" },
      replyTo: null,
      account: { id: "wh_TESTACCOUNT01", name: "Zapier" },
      network: "webhook",
      sentAt: NOW.toISOString(),
    });
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-base-air-timestamp"]).toBe(String(TS));
    const expected = "sha256=" + createHmac("sha256", SECRET).update(`${TS}.${req.body}`).digest("hex");
    expect(req.headers["x-base-air-signature"]).toBe(expected);
    // Receivers set up before the rename still find the headers they check.
    expect(req.headers["x-starsign-signature"]).toBe(expected);
    expect(req.headers["x-starsign-timestamp"]).toBe(String(TS));
    // Same signature as a receiver computes with the exported verifier.
    expect(verifyWebhookRequest(SECRET, req.headers, req.body, NOW)).toBe(true);
  });

  it("falls back to the idempotency key, sends unsigned without a secret, and is idempotent", async () => {
    fetchMock.mockResolvedValue(new Response("OK", { status: 202 }));
    const c = connector();
    const acc = account({ accountId: "wh_TESTACCOUNT01", outboundUrl: OUT });
    const r1 = await c.publish(acc, input);
    const r2 = await c.publish(acc, input);
    expect(r1).toEqual(r2);
    expect(r1).toMatchObject({ externalId: "idem-1", url: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).headers["x-base-air-signature"]).toBeUndefined();
  });

  it("sends URL credentials as Basic auth and never puts them in the URL", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await connector().publish(account({ accountId: "wh_TESTACCOUNT01", outboundUrl: "https://user:p%40ss@n8n.example.com/webhook/x" }), input);
    expect(call(0).url).toBe("https://n8n.example.com/webhook/x");
    expect(call(0).headers.authorization).toBe(`Basic ${Buffer.from("user:p@ss").toString("base64")}`);
  });

  it("maps errors: 5xx/408/429 retryable, 401/404 auth, 400 rejected, redirects refused, network retryable", async () => {
    const acc = account({ accountId: "wh_TESTACCOUNT01", outboundUrl: OUT, secret: SECRET });
    const cases: [Response | Error, Partial<ConnectorError>][] = [
      [json({ error: "boom" }, 503), { kind: "network", retryable: true }],
      [new Response("", { status: 408 }), { kind: "network", retryable: true }],
      [json({}, 429, { "retry-after": "30" }), { kind: "rate_limit", retryable: true }],
      [new Response("", { status: 401 }), { kind: "auth", retryable: false }],
      [new Response("", { status: 410 }), { kind: "auth", retryable: false }],
      [json({ error: "bad" }, 400), { kind: "rejected", retryable: false }],
      [new Response("", { status: 302, headers: { location: "https://elsewhere.example.com" } }), { kind: "rejected", retryable: false }],
      [new TypeError("fetch failed"), { kind: "network", retryable: true }],
    ];
    for (const [i, [res, want]] of cases.entries()) {
      if (res instanceof Error) fetchMock.mockRejectedValueOnce(res);
      else fetchMock.mockResolvedValueOnce(res);
      const err = (await connector().publish(acc, { ...input, idempotencyKey: `k${i}` }).catch((e: unknown) => e)) as ConnectorError;
      expect(err).toBeInstanceOf(ConnectorError);
      expect(err).toMatchObject(want);
      expect(err.message).not.toContain("abcdef");
    }
    const rl = (await (fetchMock.mockResolvedValueOnce(json({}, 429, { "retry-after": "30" })), connector().publish(acc, { ...input, idempotencyKey: "rl" })).catch((e: unknown) => e)) as ConnectorError;
    expect(rl.cause).toMatchObject({ status: 429, retryAfter: 30 });
  });

  it("refuses to publish from an inbound-only endpoint", async () => {
    await expect(connector().publish(account({ accountId: "wh_TESTACCOUNT01", secret: SECRET }), input)).rejects.toMatchObject({ kind: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("webhook inbound", () => {
  const c = connector();
  const accA = account({ accountId: "wh_TESTACCOUNT01", secret: SECRET });
  const accB = account({ accountId: "wh_OTHERACCOUNT1", secret: "another-secret-for-B-1234" }, "wh_OTHERACCOUNT1");
  const raw = JSON.stringify({ items: [{ id: "t-1", kind: "message", text: "Where is my order?", author: { handle: "jane", name: "Jane" }, conversation: { id: "support", name: "Support", type: "channel" } }] });
  const signed = (secret: string, ts: number | string = TS, body = raw) => ({ "x-base-air-timestamp": String(ts), "x-base-air-signature": signWebhookPayload(secret, ts, body) });

  it("routes by ?account=", () => {
    expect(c.webhook.route!(raw, { account: "wh_TESTACCOUNT01" }, {})).toEqual({ network: "webhook", accountExternalId: "wh_TESTACCOUNT01" });
    expect(c.webhook.route!(raw, {}, {})).toBeNull();
    expect(c.webhook.route!(raw, { account: "../etc" }, {})).toBeNull();
  });

  it("verifies good signatures, refuses bad, stale, future, missing and other accounts' secrets", () => {
    const v = (acc: AccountRef, h: Record<string, string>, body = raw) => c.webhook.verifyAccount!(acc, h, body, { account: acc.externalId });
    expect(v(accA, signed(SECRET))).toBe(true);
    expect(v(accA, { "X-Base-Air-Timestamp": String(TS), "X-Base-Air-Signature": signWebhookPayload(SECRET, TS, raw) })).toBe(true); // header case
    expect(v(accA, signed(SECRET, TS - 299))).toBe(true);
    expect(v(accA, signed(SECRET, TS - 301))).toBe(false); // stale
    expect(v(accA, signed(SECRET, TS + 301))).toBe(false); // future
    expect(v(accA, signed(SECRET, `${TS}000`))).toBe(true); // milliseconds
    expect(v(accA, { "x-base-air-signature": signWebhookPayload(SECRET, TS, raw) })).toBe(false); // no timestamp
    expect(v(accA, { ...signed(SECRET), "x-base-air-timestamp": String(TS + 1) })).toBe(false); // timestamp is signed
    expect(v(accA, signed(SECRET), raw.replace("order", "parcel"))).toBe(false); // body tampered
    expect(v(accA, signed("another-secret-for-B-1234"))).toBe(false); // B's secret cannot speak for A
    expect(v(accB, signed(SECRET))).toBe(false);
    expect(v(accA, { "x-base-air-timestamp": String(TS), "x-base-air-signature": "sha256=deadbeef" })).toBe(false);
    expect(v(accA, {})).toBe(false);
    expect(v(account({ accountId: "wh_TESTACCOUNT01" }), signed(""))).toBe(false); // no secret = inbound disabled
  });

  it("still accepts senders that sign with the pre-rename X-Starsign-* headers", () => {
    const v = (h: Record<string, string>) => c.webhook.verifyAccount!(accA, h, raw, { account: accA.externalId });
    expect(v({ "x-starsign-timestamp": String(TS), "x-starsign-signature": signWebhookPayload(SECRET, TS, raw) })).toBe(true);
    expect(v({ "x-starsign-timestamp": String(TS), "x-starsign-signature": "sha256=deadbeef" })).toBe(false);
    expect(v({ "x-starsign-timestamp": String(TS - 301), "x-starsign-signature": signWebhookPayload(SECRET, TS - 301, raw) })).toBe(false);
  });

  it("accepts a bearer secret for systems that cannot sign", () => {
    expect(verifyWebhookRequest(SECRET, { authorization: `Bearer ${SECRET}` }, raw)).toBe(true);
    expect(verifyWebhookRequest(SECRET, { authorization: `Bearer ${SECRET}x` }, raw)).toBe(false);
    expect(verifyWebhookRequest(SECRET, { authorization: `Basic ${SECRET}` }, raw)).toBe(false);
    expect(verifyWebhookRequest("", { authorization: "Bearer " }, raw)).toBe(false);
  });

  it("decodes for the verified account and parses a batch", () => {
    const body = c.webhook.decodeAccount!(accA, raw, { account: "wh_TESTACCOUNT01" });
    const batches = c.webhook.parse(body);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ network: "webhook", accountExternalId: "wh_TESTACCOUNT01" });
    expect(batches[0]!.items[0]).toEqual({
      network: "webhook",
      kind: "message",
      externalId: "wh_TESTACCOUNT01:t-1",
      authorHandle: "jane",
      authorName: "Jane",
      text: "Where is my order?",
      url: null,
      parentExternalId: null,
      occurredAt: NOW.toISOString(),
      raw: JSON.parse(raw).items[0],
      conversation: { id: "support", name: "Support", type: "channel" },
    });
    expect(c.webhook.parse({ items: [] })).toEqual([]); // not an envelope: nothing to route
  });

  it("parses a single item with defaults, numbers, dates, lang and parent", () => {
    const { items } = inboundToActivities({ id: 7, text: "Great product!", author: "@reviewer", url: "https://reviews.example.com/7", occurredAt: 1762430400, lang: "EN_us", parentId: 3 }, { externalId: "wh_A1234567", network: "webhook" }, NOW);
    expect(items[0]).toMatchObject({ kind: "mention", externalId: "wh_A1234567:7", authorHandle: "@reviewer", authorName: null, url: "https://reviews.example.com/7", occurredAt: "2025-11-06T12:00:00.000Z", lang: "en-us", parentExternalId: "wh_A1234567:3" });
    const iso = inboundToActivities({ id: "x", text: "hi", occurredAt: "2026-11-01T10:00:00+02:00", kind: "DM", url: "javascript:alert(1)", lang: "not a lang" }, { externalId: "wh_A1234567", network: "webhook" }, NOW).items[0]!;
    expect(iso).toMatchObject({ kind: "dm", occurredAt: "2026-11-01T08:00:00.000Z", url: null });
    expect(iso.lang).toBeUndefined();
  });

  it("drops invalid items and caps the batch", () => {
    const target = { externalId: "wh_A1234567", network: "webhook" as const };
    const r = inboundToActivities({ items: [{ id: "ok", text: "fine" }, { text: "no id" }, { id: "x", text: "   " }, { id: "y", text: "bad kind", kind: "shout" }, { id: "z", text: "bad conv", conversation: { id: "c", type: "room" } }, "string", null] }, target, NOW);
    expect(r.items.map((i) => i.externalId)).toEqual(["wh_A1234567:ok"]);
    expect(r.dropped).toBe(6);
    const many = Array.from({ length: MAX_INBOUND_ITEMS + 20 }, (_, i) => ({ id: i, text: `item ${i}` }));
    const capped = inboundToActivities(many, target, NOW);
    expect(capped.items).toHaveLength(MAX_INBOUND_ITEMS);
    expect(capped.dropped).toBe(20);
    expect(inboundToActivities({ items: [{ id: "long", text: "x".repeat(20_000) }] }, target, NOW).items[0]!.text).toHaveLength(10_000);
  });
});

describe("webhook url safety", () => {
  it("classifies private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "54.1.2.3", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("refuses metadata endpoints and decimal IP tricks", async () => {
    const policy = { allowHttp: true, allowPrivate: false, lookup: publicLookup };
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data", policy, "t")).rejects.toThrow(/private/);
    await expect(assertPublicHttpUrl("http://2130706433/", policy, "t")).rejects.toThrow(/private/);
    await expect(assertPublicHttpUrl("ftp://example.com/", policy, "t")).rejects.toThrow(/https/);
    await expect(assertPublicHttpUrl("https://example.com/feed", policy, "t")).resolves.toBeInstanceOf(URL);
  });
});
