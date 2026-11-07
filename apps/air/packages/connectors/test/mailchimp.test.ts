import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRef, ConnectorError, PublishInput } from "../src/index.ts";
import { MailchimpConnector, createMailchimpConnectors, mailchimpDataCenter, mailchimpHtml, mailchimpSubject } from "../src/mailchimp.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
// A made-up key in the right shape, assembled at runtime so secret scanners do not mistake it for a real one.
const KEY = ["0123456789abcdef".repeat(2), "us6"].join("-");
const BASIC = `Basic ${Buffer.from(`starsign:${KEY}`).toString("base64")}`;
const BASE = "https://us6.api.mailchimp.com/3.0";
const acct = (config: Record<string, unknown> = {}): AccountRef => ({
  id: "m1",
  workspaceId: "w",
  network: "mailchimp",
  externalId: "abc123",
  handle: "Acme Newsletter",
  auth: { apiKey: KEY },
  config: { dc: "us6", listId: "abc123", listName: "Acme Newsletter", fromName: "Acme", replyTo: "news@acme.test", ...config },
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const list = { id: "abc123", name: "Acme Newsletter", stats: { member_count: 2500 }, campaign_defaults: { from_name: "Acme", from_email: "news@acme.test", subject: "", language: "en" } };

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };
let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
function route(handler: (c: Call) => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (input, init) => {
    const c: Call = { method: init?.method ?? "GET", url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body };
    calls.push(c);
    return handler(c);
  });
}
const bodyJson = (c: Call | undefined) => JSON.parse(String(c?.body)) as Record<string, unknown>;
const path = (c: Call | undefined) => `${c?.method} ${c?.url.pathname.replace("/3.0", "")}`;
beforeEach(() => {
  calls = [];
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const connector = () => new MailchimpConnector({ now: () => NOW });

describe("mailchimp connect", () => {
  it("pings, picks the first audience and keeps its campaign defaults", async () => {
    route((c) => {
      if (c.url.pathname === "/3.0/ping") return json({ health_status: "Everything's Chimpy!" });
      if (c.url.pathname === "/3.0/lists") return json({ lists: [list], total_items: 3 });
      return json({}, 404);
    });
    const accounts = await connector().connectWithInputs({ network: "mailchimp", inputs: { apiKey: ` ${KEY} `, audienceId: "", fromName: "", replyTo: "" } });
    expect(calls[0]?.url.toString()).toBe(`${BASE}/ping`);
    expect(calls[0]?.headers.authorization).toBe(BASIC);
    expect(calls[1]?.url.searchParams.get("count")).toBe("1");
    expect(accounts).toEqual([{ network: "mailchimp", identity: { externalId: "abc123", handle: "Acme Newsletter", displayName: "Acme Newsletter" }, auth: { apiKey: KEY }, config: { dc: "us6", listId: "abc123", listName: "Acme Newsletter", fromName: "Acme", replyTo: "news@acme.test" } }]);
  });

  it("uses a given audience id and sender overrides", async () => {
    route((c) => (c.url.pathname === "/3.0/ping" ? json({}) : json({ ...list, id: "zzz999", campaign_defaults: {} })));
    const [a] = await connector().connectWithInputs({ network: "mailchimp", inputs: { apiKey: KEY, audienceId: "zzz999", fromName: "Acme Team", replyTo: "hi@acme.test" } });
    expect(calls[1]?.url.pathname).toBe("/3.0/lists/zzz999");
    expect(a?.config).toMatchObject({ listId: "zzz999", fromName: "Acme Team", replyTo: "hi@acme.test" });
  });

  it("refuses malformed and rejected keys and accounts without audiences", async () => {
    await expect(connector().connectWithInputs({ network: "mailchimp", inputs: { apiKey: "nope" } })).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
    route(() => json({ type: "https://mailchimp.com/developer/marketing/docs/errors/", title: "API Key Invalid", status: 401, detail: "Your API key may be invalid, or you've attempted to access the wrong datacenter." }, 401));
    const err = (await connector().connectWithInputs({ network: "mailchimp", inputs: { apiKey: KEY } }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "auth", retryable: false });
    expect(err.message).toContain("API Key Invalid");
    expect(err.message).not.toContain(KEY);
    route((c) => (c.url.pathname === "/3.0/ping" ? json({}) : json({ lists: [] })));
    await expect(connector().connectWithInputs({ network: "mailchimp", inputs: { apiKey: KEY } })).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/no audience/) });
  });

  it("declares inputs, capabilities and its factory", () => {
    const [c] = createMailchimpConnectors({});
    expect(c?.name).toBe("mailchimp");
    expect(c?.credentialInputs?.filter((i) => "optional" in i && i.optional).map((i) => i.key)).toEqual(["audienceId", "fromName", "replyTo"]);
    expect(c?.capabilities("mailchimp")).toMatchObject({ publish: true, fetchActivity: false, fetchMetrics: true, accountMetrics: true });
    expect(mailchimpDataCenter(KEY)).toBe("us6");
  });
});

describe("mailchimp publish", () => {
  const input: PublishInput = { variantId: "v", text: "Big <news> inside\n\nMore & more", media: [{ kind: "image", url: "https://cdn.starsign.test/hero.jpg", alt: "Hero" }], thread: [], idempotencyKey: "k1", options: { title: "November update", link: "https://acme.test/nov" } };

  it("creates the campaign, sets content, checks and sends, in that order", async () => {
    route((c) => {
      const p = path(c);
      if (p === "POST /campaigns") return json({ id: "c42", web_id: 1, archive_url: "https://eepurl.com/x", long_archive_url: "https://us6.campaign-archive.com/?u=1&id=c42" });
      if (p === "PUT /campaigns/c42/content") return json({ html: "..." });
      if (p === "GET /campaigns/c42/send-checklist") return json({ is_ready: true, items: [] });
      if (p === "POST /campaigns/c42/actions/send") return new Response(null, { status: 204 });
      return json({}, 404);
    });
    const c = connector();
    const res = await c.publish(acct(), input);
    expect(calls.map(path)).toEqual(["POST /campaigns", "PUT /campaigns/c42/content", "GET /campaigns/c42/send-checklist", "POST /campaigns/c42/actions/send"]);
    expect(bodyJson(calls[0])).toEqual({ type: "regular", recipients: { list_id: "abc123" }, settings: { subject_line: "November update", title: "November update", from_name: "Acme", reply_to: "news@acme.test" } });
    const html = String(bodyJson(calls[1]).html);
    expect(html).toContain("<p>Big &lt;news&gt; inside</p>");
    expect(html).toContain("<p>More &amp; more</p>");
    expect(html).toContain('<a href="https://acme.test/nov">');
    expect(html).toContain('<img src="https://cdn.starsign.test/hero.jpg" alt="Hero"');
    expect(html).toContain('href="*|UNSUB|*"');
    expect(html).toContain("*|LIST:ADDRESSLINE|*");
    expect(res).toEqual({ externalId: "c42", url: "https://us6.campaign-archive.com/?u=1&id=c42", raw: { campaignId: "c42" } });
    const n = calls.length;
    await c.publish(acct(), input);
    expect(calls.length).toBe(n);
  });

  it("resumes the same campaign after a failed send instead of creating another", async () => {
    let sendAttempts = 0;
    route((c) => {
      const p = path(c);
      if (p === "POST /campaigns") return json({ id: "c7" });
      if (p === "POST /campaigns/c7/actions/send") return ++sendAttempts === 1 ? new Response("oops", { status: 503 }) : new Response(null, { status: 204 });
      if (p === "GET /campaigns/c7/send-checklist") return json({ is_ready: true });
      return json({});
    });
    const c = connector();
    await expect(c.publish(acct(), { ...input, idempotencyKey: "k2" })).rejects.toMatchObject({ kind: "network", retryable: true });
    calls = [];
    await expect(c.publish(acct(), { ...input, idempotencyKey: "k2" })).resolves.toMatchObject({ externalId: "c7" });
    expect(calls.map(path)).toEqual(["GET /campaigns/c7/send-checklist", "POST /campaigns/c7/actions/send"]);
  });

  it("reads the audience defaults when the account has no sender, and reports checklist errors", async () => {
    route((c) => {
      const p = path(c);
      if (p === "GET /lists/abc123") return json(list);
      if (p === "POST /campaigns") return json({ id: "c9" });
      if (p === "GET /campaigns/c9/send-checklist") return json({ is_ready: false, items: [{ type: "error", heading: "Default merge tags", details: "Missing address" }, { type: "success", heading: "Subject" }] });
      return json({});
    });
    const err = (await connector().publish(acct({ fromName: null, replyTo: null }), { ...input, idempotencyKey: "k3", options: {} }).catch((e: unknown) => e)) as ConnectorError;
    expect(path(calls[0])).toBe("GET /lists/abc123");
    expect(bodyJson(calls[1]).settings).toMatchObject({ subject_line: "Big <news> inside", from_name: "Acme", reply_to: "news@acme.test" });
    expect(err).toMatchObject({ kind: "rejected", retryable: false });
    expect(err.message).toContain("Default merge tags: Missing address");
    expect(calls.some((x) => path(x).endsWith("/actions/send"))).toBe(false);
  });

  it("validates subject, sender defaults and media", () => {
    const c = connector();
    expect(c.validate(acct(), input)).toEqual([]);
    const issues = c.validate(acct({ replyTo: null }), { ...input, text: "", options: {}, media: [{ kind: "video", url: "https://v.test/a.mp4" }] });
    expect(issues.map((i) => i.code)).toEqual(["empty", "empty", "unsupported_media"]);
    expect(c.validate(acct(), { ...input, options: { title: "x".repeat(151) } })[0]?.code).toBe("too_long");
    expect(mailchimpSubject({ ...input, options: {}, text: "**Hello** there\nbody" })).toBe("Hello there");
    expect(mailchimpHtml({ ...input, text: "Bye *|UNSUB|*" }, "S")).not.toContain("Update preferences");
  });

  it("maps 429 to a retryable rate limit and 400 to rejected with field errors", async () => {
    route(() => json({ title: "Too Many Requests", status: 429, detail: "You have exceeded the limit of 10 simultaneous connections." }, 429, { "retry-after": "5" }));
    await expect(connector().publish(acct(), { ...input, idempotencyKey: "r1" })).rejects.toMatchObject({ kind: "rate_limit", retryable: true, message: expect.stringContaining("retry after 5s") });
    route(() => json({ title: "Invalid Resource", status: 400, detail: "Your request doesn't appear to be valid JSON", errors: [{ field: "settings.reply_to", message: "This value should be a valid email." }] }, 400));
    const err = (await connector().publish(acct(), { ...input, idempotencyKey: "r2" }).catch((e: unknown) => e)) as ConnectorError;
    expect(err).toMatchObject({ kind: "rejected", retryable: false });
    expect(err.message).toContain("settings.reply_to: This value should be a valid email.");
  });
});

describe("mailchimp metrics", () => {
  it("maps campaign reports to canonical metrics and skips campaigns without a report", async () => {
    route((c) => {
      if (c.url.pathname === "/3.0/reports/c42") return json({ id: "c42", emails_sent: 2400, opens: { opens_total: 1500, unique_opens: 1100, open_rate: 0.46 }, clicks: { clicks_total: 320, unique_clicks: 250, unique_subscriber_clicks: 210, click_rate: 0.0875 }, forwards: { forwards_count: 4 } });
      if (c.url.pathname === "/3.0/lists/abc123") return json({ id: "abc123", stats: { member_count: 2512 } });
      return json({ title: "Resource Not Found", status: 404 }, 404);
    });
    const metrics = await connector().fetchMetrics(acct(), ["c42", "missing"]);
    expect(metrics.map((m) => [m.entityId, m.metric, m.value])).toEqual([
      ["c42", "reach", 2400],
      ["c42", "impressions", 1500],
      ["c42", "clicks", 320],
      ["c42", "link_clicks", 210],
      ["c42", "shares", 4],
    ]);
    expect(metrics[0]).toMatchObject({ entityType: "post_variant", source: "mailchimp", observedAt: NOW.toISOString() });
    expect(await connector().fetchAccountMetrics(acct())).toEqual([{ entityType: "social_account", entityId: "m1", metric: "followers_total", value: 2512, observedAt: NOW.toISOString(), source: "mailchimp" }]);
    expect(await connector().fetchActivity()).toEqual([]);
  });
});
