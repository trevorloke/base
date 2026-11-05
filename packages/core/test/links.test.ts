import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "@starsign/db/test";
import { linkClicks, postOutcomes, rowsOf, type DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector, type AccountRef, type PublishInput } from "@starsign/connectors";
import { InMemoryScheduler, SecretBox, Starsign, classifyAgent, findUrls, newSlug, trimUrl, withUtm, type Principal } from "../src/index.ts";

/** The mock, remembering exactly what each publish sent. */
class Recorder extends MockConnector {
  sent: PublishInput[] = [];
  override async publish(account: AccountRef, input: PublishInput) {
    this.sent.push(input);
    return super.publish(account, input);
  }
}

const BASE = "https://go.acme.test";
const HUMAN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
let h: DbHandle;
let m: Starsign;
let rec: Recorder;
let owner: Principal;
let acctX: string;
let acctMasto: string;
let acctIg: string;
let clock = Date.parse("2026-11-02T17:00:00Z");
const now = () => new Date(clock);

async function publish(accountId: string, text: string, extra: Record<string, unknown> = {}) {
  const r = await m.posts.create(owner, { body: text, variants: [{ socialAccountId: accountId, text, ...extra }], scheduledAt: now().toISOString() });
  await m.publishing.publishPost(r.post.id);
  return { post: r.post, variant: r.variants[0]!, sent: rec.sent.at(-1)! };
}
const slugOf = (url: string) => url.slice(BASE.length + 1);

beforeAll(async () => {
  h = await createTestDb();
  rec = new Recorder();
  rec.now = now;
  m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(rec), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), now, linkBaseUrl: BASE });
  const ws = await m.workspaces.create({ slug: "acme", name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
  owner = { workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" };
  await m.policy.update(owner, { autonomy: { new_post: "autopost", reply: "autopost", dm: "suggest", repost: "draft", campaign: "suggest" }, redLines: [] });
  acctX = (await m.accounts.connect(owner, { network: "x", externalId: "1", handle: "acme", connector: "mock" })).id;
  acctMasto = (await m.accounts.connect(owner, { network: "mastodon", externalId: "2", handle: "acme@m.social", connector: "mock" })).id;
  acctIg = (await m.accounts.connect(owner, { network: "instagram", externalId: "3", handle: "acme.ig", connector: "mock" })).id;
});
afterAll(() => h.close());

describe("url helpers", () => {
  it("finds URLs without swallowing sentence punctuation or unbalanced brackets", () => {
    expect(findUrls("See https://acme.example/a?b=1. And (https://x.test/y) too!").map((f) => f.url)).toEqual(["https://acme.example/a?b=1", "https://x.test/y"]);
    expect(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(trimUrl("https://a.test/x),")).toBe("https://a.test/x");
  });
  it("adds UTM tags without overwriting the author's", () => {
    const u = new URL(withUtm("https://a.test/p?utm_source=newsletter", { utm_source: "x", utm_medium: "social" }));
    expect(u.searchParams.get("utm_source")).toBe("newsletter");
    expect(u.searchParams.get("utm_medium")).toBe("social");
  });
  it("tells link-preview crawlers from people", () => {
    expect(classifyAgent("facebookexternalhit/1.1").isBot).toBe(true);
    expect(classifyAgent("Twitterbot/1.0").isBot).toBe(true);
    expect(classifyAgent("Mozilla/5.0 (compatible; LinkedInBot/1.0)").isBot).toBe(true);
    expect(classifyAgent("")).toEqual({ isBot: true, device: "bot" });
    expect(classifyAgent(HUMAN_UA)).toEqual({ isBot: false, device: "mobile" });
    expect(classifyAgent("Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/400.0]")).toEqual({ isBot: false, device: "mobile" }); // Facebook's in-app browser is a person
  });
  it("makes 7-character base62 slugs", () => {
    const s = new Set(Array.from({ length: 500 }, () => newSlug()));
    expect(s.size).toBe(500);
    for (const x of s) expect(x).toMatch(/^[0-9A-Za-z]{7}$/);
  });
});

describe("publishing through tracked links", () => {
  it("sends short links, keeps the approved text, tags the destination, and reuses links on retry", async () => {
    const { variant, sent, post } = await publish(acctMasto, "New trail guide: https://acme.example/guide?ref=a. Also https://acme.example/shop", { thread: ["More at https://acme.example/more"] });
    const urls = findUrls(sent.text).map((f) => f.url);
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(u).toMatch(new RegExp(`^${BASE}/[0-9A-Za-z]{7}$`));
    expect(sent.text).toMatch(/^New trail guide: https:\/\/go\.acme\.test\/\w{7}\. Also https:\/\/go\.acme\.test\/\w{7}$/);
    expect(sent.thread[0]).toMatch(/^More at https:\/\/go\.acme\.test\/\w{7}$/);
    const detail = await m.posts.get(owner.workspaceId, post.id);
    expect(detail.variants[0]!.text).toContain("https://acme.example/guide?ref=a"); // the stored text is what was approved

    const links = await m.links.list(owner.workspaceId);
    const guide = links.find((l) => l.destination === "https://acme.example/guide?ref=a")!;
    const target = new URL(guide.target);
    expect(Object.fromEntries(target.searchParams)).toEqual({ ref: "a", utm_source: "mastodon", utm_medium: "social", utm_campaign: `post-${post.id.slice(-8)}`, utm_content: guide.slug });
    expect(guide).toMatchObject({ variantId: variant.id, network: "mastodon", placement: "text" });

    // A retry of the same variant mints nothing new.
    const before = (await m.links.list(owner.workspaceId)).length;
    const again = await m.links.wrapVariant(owner.workspaceId, { ...(await getVariant(variant.id)) }, "mastodon");
    expect(again.text).toBe(sent.text);
    expect((await m.links.list(owner.workspaceId)).length).toBe(before);
  });

  it("respects opt-outs, non-clickable captions, and length limits", async () => {
    const off = await publish(acctMasto, "Untracked https://acme.example/raw", { options: { trackLinks: false } });
    expect(off.sent.text).toBe("Untracked https://acme.example/raw");
    const ig = await publish(acctIg, "Link in bio https://acme.example/ig", { media: [{ kind: "image", url: "https://cdn.test/a.png" }] });
    expect(ig.sent.text).toBe("Link in bio https://acme.example/ig");
    // 495 characters as written; the short link is longer than a.co/x and would take it past 500.
    const text = `${"a".repeat(480)} https://a.co/x`;
    const tight = await publish(acctMasto, text);
    expect(tight.sent.text).toBe(text); // wrapping would pass 500 characters, so the original stays
  });

  it("wraps the destination link and first comment, with the variant's campaign", async () => {
    const { sent } = await publish(acctMasto, "Read this", { options: { link: "https://acme.example/post", firstComment: "Details: https://acme.example/details", campaign: "fall-launch" } });
    expect(sent.options?.link).toMatch(new RegExp(`^${BASE}/`));
    expect(sent.options?.firstComment).toMatch(/^Details: https:\/\/go\.acme\.test\/\w{7}$/);
    const link = (await m.links.list(owner.workspaceId)).find((l) => l.placement === "link")!;
    expect(new URL(link.target).searchParams.get("utm_campaign")).toBe("fall-launch");
  });

  it("does nothing when the workspace turns tracking off", async () => {
    await m.links.updateSettings(owner, { enabled: false });
    const { sent } = await publish(acctMasto, "Off https://acme.example/off");
    expect(sent.text).toBe("Off https://acme.example/off");
    await m.links.updateSettings(owner, { enabled: true });
  });
});

async function getVariant(id: string) {
  const { postVariants } = await import("@starsign/db");
  const [v] = await m.ctx.db.select().from(postVariants).where(eq(postVariants.id, id)).limit(1);
  return v!;
}

describe("clicks, conversions and the outcome ledger", () => {
  it("counts people (once per day each), not preview bots, and hands the site a click id", async () => {
    const { variant, sent } = await publish(acctX, "Fresh drop https://shop.acme.example/drop");
    const slug = slugOf(findUrls(sent.text)[0]!.url);

    const bot = await m.links.click(slug, { ip: "1.1.1.1", userAgent: "Twitterbot/1.0" });
    expect(new URL(bot!).searchParams.has("ssclid")).toBe(false);
    const first = new URL((await m.links.click(slug, { ip: "2.2.2.2", userAgent: HUMAN_UA, referrer: "https://t.co/abc", country: "ca" }))!);
    expect(first.origin + first.pathname).toBe("https://shop.acme.example/drop");
    expect(first.searchParams.get("utm_source")).toBe("x");
    const clickId = first.searchParams.get("ssclid")!;
    expect(clickId).toMatch(/^clk_[0-9a-f]{32}$/);
    await m.links.click(slug, { ip: "2.2.2.2", userAgent: HUMAN_UA }); // same person again
    await m.links.click(slug, { ip: "3.3.3.3", userAgent: HUMAN_UA });
    expect(await m.links.click("nope123", { ip: "4.4.4.4", userAgent: HUMAN_UA })).toBeNull();

    const [row] = await m.ctx.db.select().from(linkClicks).where(eq(linkClicks.id, clickId));
    expect(row).toMatchObject({ referrerHost: "t.co", country: "CA", device: "mobile", isBot: false, network: "x" });
    expect(JSON.stringify(row)).not.toContain("2.2.2.2"); // no raw IP at rest

    let stats = (await m.links.statsByVariant([variant.id])).get(variant.id)!;
    expect(stats).toMatchObject({ clicks: 3, uniqueVisitors: 2, previews: 1, conversions: 0 });

    // Server-to-server, idempotent by external id.
    const c1 = await m.links.recordConversion(owner, { clickId, name: "purchase", value: 49, currency: "usd", externalId: "order-1" });
    expect(c1).toMatchObject({ duplicate: false, conversion: { variantId: variant.id, network: "x", currency: "USD", source: "api" } });
    expect((await m.links.recordConversion(owner, { clickId, name: "purchase", value: 49, externalId: "order-1" })).duplicate).toBe(true);
    // From the browser: once per click and name; unknown clicks are ignored.
    expect(await m.links.recordBrowserConversion({ clickId, name: "signup" })).toBe(true);
    expect(await m.links.recordBrowserConversion({ clickId, name: "signup" })).toBe(false);
    expect(await m.links.recordBrowserConversion({ clickId: "clk_0000", name: "signup" })).toBe(false);
    // Another workspace's click id is not attributable here.
    await expect(m.links.recordConversion({ ...owner, workspaceId: "ws_other" }, { clickId })).rejects.toMatchObject({ code: "not_found" });
    await expect(m.links.recordConversion({ ...owner, role: "viewer" }, { name: "x" })).rejects.toMatchObject({ code: "forbidden" });

    stats = (await m.links.statsByVariant([variant.id])).get(variant.id)!;
    expect(stats).toMatchObject({ conversions: 2, conversionValue: 49 });

    // The outcome snapshot carries owned numbers next to the network's.
    clock += 2 * 3_600_000;
    await m.metrics.captureDueOutcomes(now());
    const [o] = await m.ctx.db.select().from(postOutcomes).where(eq(postOutcomes.variantId, variant.id)).orderBy(postOutcomes.dueAt).limit(1);
    expect(o!.status).toBe("captured");
    expect(o!.metrics).toMatchObject({ tracked_clicks: 2, conversions: 2, conversion_value: 49 });
    expect(o!.metrics!.impressions).toBeGreaterThan(0);

    // Rollup writes cumulative series under the network post id.
    expect(await m.links.rollup(new Date(clock - 6 * 3_600_000))).toBeGreaterThan(0);
    expect(await m.metrics.latest("post_variant", (await getVariant(variant.id)).externalId!)).toMatchObject({ tracked_clicks: 2, conversions: 2 });

    const report = await m.links.report(owner.workspaceId, new Date(clock - 86_400_000), now());
    expect(report.totals).toMatchObject({ clicks: 3, uniqueVisitors: 2, previews: 1, conversions: 2, attributedConversions: 2, conversionValue: 49 });
    expect(report.byNetwork[0]).toMatchObject({ network: "x", clicks: 3, conversions: 2 });
    expect(report.topLinks[0]).toMatchObject({ slug, destination: "https://shop.acme.example/drop" });
  });

  it("keeps clicks append-only and stops a disabled link at once", async () => {
    await expect(m.ctx.db.execute(sql`UPDATE link_clicks SET is_bot = true`)).rejects.toBeTruthy();
    const manual = await m.links.create(owner, { url: "https://acme.example/bio", campaign: "bio" });
    expect(manual.shortUrl).toBe(`${BASE}/${manual.slug}`);
    expect(new URL(manual.target).searchParams.get("utm_campaign")).toBe("bio");
    expect(await m.links.click(manual.slug, { userAgent: HUMAN_UA })).toBeTruthy();
    await m.links.disable(owner, manual.id);
    expect(await m.links.click(manual.slug, { userAgent: HUMAN_UA })).toBeNull();
    const n = rowsOf<{ n: string }>(await m.ctx.db.execute(sql`SELECT count(*) AS n FROM link_clicks WHERE link_id = ${manual.id}`));
    expect(Number(n[0]!.n)).toBe(1);
  });

  it("comes out of the workspace export", async () => {
    const dump = await m.exports.workspace(owner);
    expect(dump.trackedLinks.length).toBeGreaterThan(3);
    expect(dump.linkClicks.length).toBeGreaterThan(3);
    expect(dump.conversions.length).toBe(2);
  });
});
