import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { conversions, linkClicks, metrics, postVariants, rowsOf, trackedLinks, workspaces } from "@starsign/db";
import { NETWORK_LIMITS, type Network, type VariantOptions } from "@starsign/schema";
import { textLength } from "@starsign/connectors";
import { newId } from "@starsign/ledger";
import { SYSTEM, type CoreContext, type Principal } from "../context.ts";
import { CoreError } from "../errors.ts";

/**
 * Owned measurement. Every link Starsign publishes can go through a short link it controls: the redirect adds UTM
 * tags (so the customer's web analytics attribute the visit to the right network and post) and a click id, ssclid,
 * that the customer's site hands back with a conversion. Clicks and conversions are first-party rows here, so the
 * outcome ledger records what a post caused, not only what a network chose to report about it.
 */

export const LinkSettings = z.object({
  /** Wrap links in published posts. A variant can opt out with options.trackLinks = false. */
  enabled: z.boolean().default(true),
  /** Add utm_source / utm_medium / utm_campaign / utm_content to the destination (existing tags are kept). */
  utm: z.boolean().default(true),
  /** Append ssclid=<click id> to the destination so the site can report conversions against the click. */
  clickIds: z.boolean().default(true),
  /** utm_campaign when a variant does not set one. Default: "post-<id>". */
  defaultCampaign: z.string().max(100).optional(),
  /** utm_medium. Default "social". */
  medium: z.string().max(50).default("social"),
});
export type LinkSettings = z.infer<typeof LinkSettings>;

export interface LinkOptions {
  /** Base for short links, e.g. https://go.example.com or https://app.example.com/l. Null: link wrapping is off. */
  baseUrl?: string | null;
}

export function linkBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.STARSIGN_LINK_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const pub = env.STARSIGN_PUBLIC_URL?.trim();
  // A localhost base would publish links nobody can open.
  if (!pub || /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(pub)) return null;
  return `${pub.replace(/\/+$/, "")}/l`;
}

// Networks whose captions do not make links clickable: wrapping would only make the text longer.
const NON_CLICKABLE_TEXT: ReadonlySet<Network> = new Set<Network>(["instagram", "tiktok"]);

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Trailing punctuation belongs to the sentence, not the URL; a closing bracket only if it is unbalanced. */
export function trimUrl(raw: string): string {
  let u = raw;
  for (;;) {
    const last = u.at(-1);
    if (!last) break;
    if (".,;:!?'\"*".includes(last)) {
      u = u.slice(0, -1);
      continue;
    }
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const open = pairs[last];
    if (open && u.split(last).length > u.split(open).length) {
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return u;
}

export function findUrls(text: string): { url: string; index: number }[] {
  const out: { url: string; index: number }[] = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const url = trimUrl(m[0]);
    try {
      new URL(url);
      out.push({ url, index: m.index ?? 0 });
    } catch {
      // not a URL after all
    }
  }
  return out;
}

/** Adds the tags the author did not already set. */
export function withUtm(destination: string, utm: Record<string, string>): string {
  const u = new URL(destination);
  for (const [k, v] of Object.entries(utm)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 7 base62 characters: 3.5 trillion slugs, unguessable enough that links cannot be enumerated. */
export function newSlug(length = 7): string {
  let s = "";
  while (s.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) s += ALPHABET[b % 62]; // 248 = 62 * 4: rejection keeps the distribution uniform
      if (s.length === length) break;
    }
  }
  return s;
}

const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebot|embedly|preview|whatsapp|skypeuripreview|bitlybot|vkshare|quora link|outbrain|nuzzel|redditbot|applebot|google-inspectiontool|headless|lighthouse|curl\/|wget|python-requests|python-urllib|go-http-client|axios|node-fetch|okhttp|httpclient|java\//i;
export function classifyAgent(userAgent: string | null | undefined): { isBot: boolean; device: "bot" | "mobile" | "desktop" | "unknown" } {
  const ua = userAgent?.trim() ?? "";
  if (!ua || BOT_UA.test(ua)) return { isBot: true, device: "bot" };
  if (/mobile|iphone|ipad|android|ipod/i.test(ua)) return { isBot: false, device: "mobile" };
  if (/windows|macintosh|x11|linux|cros/i.test(ua)) return { isBot: false, device: "desktop" };
  return { isBot: false, device: "unknown" };
}

export interface ClickMeta {
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  country?: string | null;
}

export interface LinkStats {
  links: number;
  clicks: number;
  uniqueVisitors: number;
  previews: number;
  conversions: number;
  conversionValue: number;
}

export const ConversionInput = z.object({
  clickId: z.string().max(64).optional(),
  slug: z.string().max(32).optional(),
  name: z.string().min(1).max(80).default("conversion"),
  value: z.number().finite().min(0).max(1e9).optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()).optional(),
  externalId: z.string().min(1).max(200).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type ConversionInput = z.input<typeof ConversionInput>;

/** Browser-reported conversions only count within this window after the click. */
const BROWSER_WINDOW_MS = 30 * 86_400_000;

type LinkRow = typeof trackedLinks.$inferSelect;
type VariantRow = typeof postVariants.$inferSelect;

export interface WrapResult {
  text: string;
  thread: string[];
  options: VariantOptions;
  slugs: string[];
}

export class LinkService {
  readonly baseUrl: string | null;
  private readonly settingsCache = new Map<string, { at: number; value: LinkSettings }>();

  constructor(
    private readonly ctx: CoreContext,
    opts: LinkOptions = {},
  ) {
    this.baseUrl = opts.baseUrl === undefined ? linkBaseFromEnv() : opts.baseUrl ? opts.baseUrl.replace(/\/+$/, "") : null;
  }

  shortUrl(slug: string): string {
    if (!this.baseUrl) throw new CoreError("unavailable", "link tracking needs STARSIGN_LINK_BASE_URL or a public STARSIGN_PUBLIC_URL");
    return `${this.baseUrl}/${slug}`;
  }

  // ------------------------------------------------------------ settings

  async settings(workspaceId: string): Promise<LinkSettings> {
    const hit = this.settingsCache.get(workspaceId);
    if (hit && this.ctx.now().getTime() - hit.at < 30_000) return hit.value;
    const [ws] = await this.ctx.db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!ws) throw new CoreError("not_found", "workspace");
    const value = LinkSettings.parse((ws.settings as { links?: unknown }).links ?? {});
    this.settingsCache.set(workspaceId, { at: this.ctx.now().getTime(), value });
    return value;
  }

  async updateSettings(p: Principal, patch: unknown): Promise<LinkSettings & { baseUrl: string | null }> {
    const current = await this.settings(p.workspaceId);
    const next = LinkSettings.parse({ ...current, ...LinkSettings.partial().parse(patch) });
    await this.ctx.db
      .update(workspaces)
      .set({ settings: sql`jsonb_set(${workspaces.settings}, '{links}', ${JSON.stringify(next)}::jsonb, true)` })
      .where(eq(workspaces.id, p.workspaceId));
    this.settingsCache.delete(p.workspaceId);
    return { ...next, baseUrl: this.baseUrl };
  }

  // ------------------------------------------------------------ minting

  private async mint(values: Omit<typeof trackedLinks.$inferInsert, "id" | "slug">): Promise<LinkRow> {
    for (let attempt = 0; ; attempt++) {
      const slug = newSlug();
      const rows = await this.ctx.db
        .insert(trackedLinks)
        .values({ ...values, id: newId("lnk"), slug })
        .onConflictDoNothing()
        .returning();
      if (rows[0]) return rows[0];
      // Conflict: either the slug collided (retry) or this variant already has this link (reuse it).
      if (values.variantId) {
        const existing = await this.forVariant(values.variantId, values.placement ?? "text", values.destination);
        if (existing) return existing;
      }
      if (attempt >= 4) throw new CoreError("conflict", "could not allocate a short link");
    }
  }

  private async forVariant(variantId: string, placement: string, destination: string): Promise<LinkRow | undefined> {
    const [row] = await this.ctx.db
      .select()
      .from(trackedLinks)
      .where(and(eq(trackedLinks.variantId, variantId), eq(trackedLinks.placement, placement as LinkRow["placement"]), eq(trackedLinks.destination, destination)))
      .limit(1);
    return row;
  }

  private utmFor(settings: LinkSettings, network: string | null, campaign: string, slug: string): Record<string, string> {
    if (!settings.utm) return {};
    return { utm_source: network ?? "starsign", utm_medium: settings.medium, utm_campaign: campaign, utm_content: slug };
  }

  /** A link made by hand (bio links, a campaign landing page). */
  async create(p: Principal, input: { url: string; network?: Network; campaign?: string }): Promise<LinkRow & { shortUrl: string }> {
    if (p.actor.type === "human" && p.role === "viewer") throw new CoreError("forbidden", "viewers cannot create links");
    if (!this.baseUrl) this.shortUrl(""); // throws the configuration error
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new CoreError("invalid", "url must be an absolute http(s) URL");
    }
    if (!/^https?:$/.test(url.protocol)) throw new CoreError("invalid", "url must be http or https");
    const settings = await this.settings(p.workspaceId);
    const campaign = input.campaign ?? settings.defaultCampaign ?? "starsign";
    const row = await this.mint({
      workspaceId: p.workspaceId,
      destination: url.toString(),
      target: url.toString(),
      network: input.network ?? null,
      placement: "manual",
      createdBy: p.actor,
    });
    const utm = this.utmFor(settings, input.network ?? null, campaign, row.slug);
    const [updated] = await this.ctx.db.update(trackedLinks).set({ target: withUtm(row.destination, utm), utm }).where(eq(trackedLinks.id, row.id)).returning();
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "link.created", subjectType: "tracked_link", subjectId: row.id, actor: p.actor, data: { slug: row.slug, destination: row.destination, placement: "manual" } });
    return { ...updated!, shortUrl: this.shortUrl(row.slug) };
  }

  async disable(p: Principal, id: string): Promise<void> {
    if (p.actor.type === "human" && !["owner", "approver"].includes(p.role ?? "")) throw new CoreError("forbidden", "requires owner or approver");
    const rows = await this.ctx.db
      .update(trackedLinks)
      .set({ disabledAt: this.ctx.now() })
      .where(and(eq(trackedLinks.id, id), eq(trackedLinks.workspaceId, p.workspaceId), isNull(trackedLinks.disabledAt)))
      .returning({ id: trackedLinks.id, slug: trackedLinks.slug });
    if (!rows[0]) throw new CoreError("not_found", "link");
    await this.ctx.events.append({ workspaceId: p.workspaceId, type: "link.disabled", subjectType: "tracked_link", subjectId: id, actor: p.actor, data: { slug: rows[0].slug } });
  }

  async list(workspaceId: string, limit = 100) {
    const rows = await this.ctx.db.select().from(trackedLinks).where(eq(trackedLinks.workspaceId, workspaceId)).orderBy(desc(trackedLinks.createdAt)).limit(Math.min(500, limit));
    const stats = await this.statsByLink(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, shortUrl: this.baseUrl ? this.shortUrl(r.slug) : null, stats: stats.get(r.id) ?? emptyStats(1) }));
  }

  /**
   * Rewrites a variant's links to short links just before it is published. The stored variant keeps the text as
   * written and approved; only what goes to the network changes. Idempotent across retries (same links come back),
   * and a segment that would go over the network's length limit keeps its original links.
   */
  async wrapVariant(workspaceId: string, v: VariantRow, network: Network): Promise<WrapResult> {
    const options = (v.options ?? {}) as VariantOptions;
    const unchanged: WrapResult = { text: v.text, thread: v.thread, options, slugs: [] };
    if (!this.baseUrl || v.replyToExternalId || options.trackLinks === false) return unchanged;
    const settings = await this.settings(workspaceId);
    if (!settings.enabled) return unchanged;
    const campaign = options.campaign ?? settings.defaultCampaign ?? `post-${v.postId.slice(-8)}`;
    const slugs: string[] = [];

    const linkFor = async (destination: string, placement: LinkRow["placement"]): Promise<string> => {
      let row = await this.forVariant(v.id, placement, destination);
      if (!row) {
        row = await this.mint({ workspaceId, destination, target: destination, postId: v.postId, variantId: v.id, network, placement, createdBy: SYSTEM });
        await this.ctx.events.append({ workspaceId, type: "link.created", subjectType: "tracked_link", subjectId: row.id, actor: SYSTEM, data: { slug: row.slug, destination, variantId: v.id, network, placement } });
      }
      // Tagged after minting because utm_content carries the slug. A retry finishes a row a crash left untagged.
      if (settings.utm && Object.keys(row.utm).length === 0) {
        const utm = this.utmFor(settings, network, campaign, row.slug);
        [row] = await this.ctx.db.update(trackedLinks).set({ target: withUtm(destination, utm), utm }).where(eq(trackedLinks.id, row.id)).returning();
      }
      slugs.push(row!.slug);
      return this.shortUrl(row!.slug);
    };

    const own = this.baseUrl;
    const wrapText = async (text: string, placement: LinkRow["placement"]): Promise<string> => {
      const found = findUrls(text).filter((f) => !f.url.startsWith(own));
      if (found.length === 0) return text;
      let out = "";
      let cursor = 0;
      for (const f of found) {
        out += text.slice(cursor, f.index) + (await linkFor(f.url, placement));
        cursor = f.index + f.url.length;
      }
      out += text.slice(cursor);
      // Never let tracking push a post over the limit.
      const max = NETWORK_LIMITS[network].maxText;
      if (textLength(network, out) > max && textLength(network, text) <= max) return text;
      return out;
    };

    const clickable = !NON_CLICKABLE_TEXT.has(network);
    const text = clickable ? await wrapText(v.text, "text") : v.text;
    const thread: string[] = [];
    for (const seg of v.thread) thread.push(clickable ? await wrapText(seg, "thread") : seg);
    const nextOptions: VariantOptions = { ...options };
    if (options.link && !options.link.startsWith(own)) nextOptions.link = await linkFor(options.link, "link");
    if (options.firstComment && clickable) nextOptions.firstComment = await wrapText(options.firstComment, "first_comment");
    return { text, thread, options: nextOptions, slugs };
  }

  // ------------------------------------------------------------ clicks

  private visitorHash(meta: ClickMeta, at: Date): string {
    const day = at.toISOString().slice(0, 10);
    const salt = this.ctx.secrets.derive(`link-visitor:${day}`);
    return createHash("sha256").update(salt).update(meta.ip ?? "").update("\u0000").update(meta.userAgent ?? "").digest("hex").slice(0, 32);
  }

  /** Records a click and returns where to send the visitor, or null for an unknown or disabled link. */
  async click(slug: string, meta: ClickMeta): Promise<string | null> {
    if (!/^[0-9A-Za-z]{4,32}$/.test(slug)) return null;
    const [link] = await this.ctx.db.select().from(trackedLinks).where(eq(trackedLinks.slug, slug)).limit(1);
    if (!link || link.disabledAt) return null;
    const at = this.ctx.now();
    const agent = classifyAgent(meta.userAgent);
    const id = newId("clk");
    let referrerHost: string | null = null;
    try {
      referrerHost = meta.referrer ? new URL(meta.referrer).hostname.slice(0, 200) : null;
    } catch {
      referrerHost = null;
    }
    const country = meta.country && /^[A-Za-z]{2}$/.test(meta.country) ? meta.country.toUpperCase() : null;
    await this.ctx.db.insert(linkClicks).values({
      id,
      linkId: link.id,
      workspaceId: link.workspaceId,
      variantId: link.variantId,
      network: link.network,
      occurredAt: at,
      visitorHash: this.visitorHash(meta, at),
      isBot: agent.isBot,
      device: agent.device,
      referrerHost,
      country,
    });
    if (agent.isBot) return link.target; // previews follow through to the real page's tags, without a click id
    const settings = await this.settings(link.workspaceId);
    return settings.clickIds ? withUtm(link.target, { ssclid: id }) : link.target;
  }

  // ------------------------------------------------------------ conversions

  /** Server-to-server report (an API key from the customer's backend, or a signed-in editor). */
  async recordConversion(p: Principal, raw: unknown) {
    if (p.actor.type === "human" && (!p.role || p.role === "viewer")) throw new CoreError("forbidden", "viewers cannot record conversions");
    const input = ConversionInput.parse(raw);
    const attribution = await this.attribute(p.workspaceId, input);
    if (input.externalId) {
      const [dupe] = await this.ctx.db.select().from(conversions).where(and(eq(conversions.workspaceId, p.workspaceId), eq(conversions.externalId, input.externalId))).limit(1);
      if (dupe) return { conversion: dupe, duplicate: true };
    }
    const row = await this.insertConversion(p.workspaceId, input, attribution, "api", p.actor);
    if (!row) {
      const [dupe] = await this.ctx.db.select().from(conversions).where(and(eq(conversions.workspaceId, p.workspaceId), eq(conversions.externalId, input.externalId ?? ""))).limit(1);
      return { conversion: dupe ?? null, duplicate: true };
    }
    return { conversion: row, duplicate: false };
  }

  /**
   * Reported from a visitor's browser (the s.js snippet). Unauthenticated, so it is held to what the click id
   * alone proves: the click must exist and be recent, and each conversion name counts once per click.
   */
  async recordBrowserConversion(raw: unknown): Promise<boolean> {
    const input = ConversionInput.pick({ clickId: true, name: true, value: true, currency: true }).parse(raw);
    if (!input.clickId) return false;
    const [click] = await this.ctx.db.select().from(linkClicks).where(eq(linkClicks.id, input.clickId)).limit(1);
    if (!click || click.isBot) return false;
    if (this.ctx.now().getTime() - click.occurredAt.getTime() > BROWSER_WINDOW_MS) return false;
    const row = await this.insertConversion(
      click.workspaceId,
      { ...input, name: input.name ?? "conversion" },
      { clickId: click.id, linkId: click.linkId, variantId: click.variantId, network: click.network },
      "browser",
      { type: "system", id: "browser" },
    );
    return Boolean(row);
  }

  private async attribute(workspaceId: string, input: { clickId?: string | undefined; slug?: string | undefined }) {
    if (input.clickId) {
      const [click] = await this.ctx.db.select().from(linkClicks).where(and(eq(linkClicks.id, input.clickId), eq(linkClicks.workspaceId, workspaceId))).limit(1);
      if (!click) throw new CoreError("not_found", "click id is not from this workspace");
      return { clickId: click.id, linkId: click.linkId, variantId: click.variantId, network: click.network };
    }
    if (input.slug) {
      const [link] = await this.ctx.db.select().from(trackedLinks).where(and(eq(trackedLinks.slug, input.slug), eq(trackedLinks.workspaceId, workspaceId))).limit(1);
      if (!link) throw new CoreError("not_found", "link");
      return { clickId: null, linkId: link.id, variantId: link.variantId, network: link.network };
    }
    return { clickId: null, linkId: null, variantId: null, network: null };
  }

  private async insertConversion(
    workspaceId: string,
    input: { name: string; value?: number | undefined; currency?: string | undefined; externalId?: string | undefined; occurredAt?: string | undefined },
    a: { clickId: string | null; linkId: string | null; variantId: string | null; network: string | null },
    source: "api" | "browser",
    actor: Principal["actor"],
  ) {
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : this.ctx.now();
    const [row] = await this.ctx.db
      .insert(conversions)
      .values({
        id: newId("cnv"),
        workspaceId,
        clickId: a.clickId,
        linkId: a.linkId,
        variantId: a.variantId,
        network: a.network,
        name: input.name,
        value: input.value ?? null,
        currency: input.currency ?? null,
        externalId: input.externalId ?? null,
        source,
        occurredAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    await this.ctx.events.append({
      workspaceId,
      type: "conversion.recorded",
      subjectType: a.variantId ? "post_variant" : "workspace",
      subjectId: a.variantId ?? workspaceId,
      actor,
      data: { conversionId: row.id, name: row.name, value: row.value, currency: row.currency, clickId: a.clickId, network: a.network, source },
    });
    return row;
  }

  async listConversions(workspaceId: string, limit = 100) {
    return this.ctx.db.select().from(conversions).where(eq(conversions.workspaceId, workspaceId)).orderBy(desc(conversions.occurredAt)).limit(Math.min(500, limit));
  }

  // ------------------------------------------------------------ stats

  /** Owned outcome numbers per variant, counting only what happened up to `until`. */
  async statsByVariant(variantIds: string[], until?: Date): Promise<Map<string, LinkStats>> {
    const out = new Map<string, LinkStats>();
    if (variantIds.length === 0) return out;
    const cutoff = until ?? this.ctx.now();
    const linkRows = rowsOf<{ variant_id: string; n: string | number }>(
      await this.ctx.db.execute(sql`SELECT variant_id, count(*) AS n FROM tracked_links WHERE variant_id IN ${sqlList(variantIds)} GROUP BY variant_id`),
    );
    for (const r of linkRows) out.set(r.variant_id, { ...emptyStats(Number(r.n)) });
    if (out.size === 0) return out;
    const clickRows = rowsOf<{ variant_id: string; clicks: string | number; uniq: string | number; previews: string | number }>(
      await this.ctx.db.execute(sql`
        SELECT variant_id,
               count(*) FILTER (WHERE NOT is_bot) AS clicks,
               count(DISTINCT link_id || ':' || visitor_hash) FILTER (WHERE NOT is_bot) AS uniq,
               count(*) FILTER (WHERE is_bot) AS previews
        FROM link_clicks WHERE variant_id IN ${sqlList([...out.keys()])} AND occurred_at <= ${cutoff}
        GROUP BY variant_id`),
    );
    for (const r of clickRows) {
      const s = out.get(r.variant_id);
      if (s) Object.assign(s, { clicks: Number(r.clicks), uniqueVisitors: Number(r.uniq), previews: Number(r.previews) });
    }
    const convRows = rowsOf<{ variant_id: string; n: string | number; v: string | number | null }>(
      await this.ctx.db.execute(sql`SELECT variant_id, count(*) AS n, COALESCE(sum(value), 0) AS v FROM conversions WHERE variant_id IN ${sqlList([...out.keys()])} AND occurred_at <= ${cutoff} GROUP BY variant_id`),
    );
    for (const r of convRows) {
      const s = out.get(r.variant_id);
      if (s) Object.assign(s, { conversions: Number(r.n), conversionValue: Number(r.v ?? 0) });
    }
    return out;
  }

  private async statsByLink(linkIds: string[]): Promise<Map<string, LinkStats>> {
    const out = new Map<string, LinkStats>();
    if (linkIds.length === 0) return out;
    for (const id of linkIds) out.set(id, emptyStats(1));
    const clickRows = rowsOf<{ link_id: string; clicks: string | number; uniq: string | number; previews: string | number }>(
      await this.ctx.db.execute(sql`
        SELECT link_id, count(*) FILTER (WHERE NOT is_bot) AS clicks, count(DISTINCT visitor_hash) FILTER (WHERE NOT is_bot) AS uniq, count(*) FILTER (WHERE is_bot) AS previews
        FROM link_clicks WHERE link_id IN ${sqlList(linkIds)} GROUP BY link_id`),
    );
    for (const r of clickRows) Object.assign(out.get(r.link_id)!, { clicks: Number(r.clicks), uniqueVisitors: Number(r.uniq), previews: Number(r.previews) });
    const convRows = rowsOf<{ link_id: string; n: string | number; v: string | number | null }>(
      await this.ctx.db.execute(sql`SELECT link_id, count(*) AS n, COALESCE(sum(value), 0) AS v FROM conversions WHERE link_id IN ${sqlList(linkIds)} GROUP BY link_id`),
    );
    for (const r of convRows) Object.assign(out.get(r.link_id)!, { conversions: Number(r.n), conversionValue: Number(r.v ?? 0) });
    return out;
  }

  /** The owned-outcome view: what posts drove, by network, by day, and the links that did the most. */
  async report(workspaceId: string, from: Date, to: Date, timezone = "UTC") {
    const totals = rowsOf<{ clicks: string | number; uniq: string | number; previews: string | number }>(
      await this.ctx.db.execute(sql`
        SELECT count(*) FILTER (WHERE NOT is_bot) AS clicks, count(DISTINCT link_id || ':' || visitor_hash) FILTER (WHERE NOT is_bot) AS uniq, count(*) FILTER (WHERE is_bot) AS previews
        FROM link_clicks WHERE workspace_id = ${workspaceId} AND occurred_at >= ${from} AND occurred_at <= ${to}`),
    )[0];
    const conv = rowsOf<{ n: string | number; v: string | number | null; attributed: string | number }>(
      await this.ctx.db.execute(sql`
        SELECT count(*) AS n, COALESCE(sum(value), 0) AS v, count(*) FILTER (WHERE variant_id IS NOT NULL) AS attributed
        FROM conversions WHERE workspace_id = ${workspaceId} AND occurred_at >= ${from} AND occurred_at <= ${to}`),
    )[0];
    const currencies = rowsOf<{ currency: string | null; v: string | number }>(
      await this.ctx.db.execute(sql`SELECT currency, COALESCE(sum(value), 0) AS v FROM conversions WHERE workspace_id = ${workspaceId} AND occurred_at >= ${from} AND occurred_at <= ${to} AND value IS NOT NULL GROUP BY currency`),
    ).map((r) => ({ currency: r.currency, value: Number(r.v) }));
    const byNetwork = rowsOf<{ network: string | null; clicks: string | number; uniq: string | number }>(
      await this.ctx.db.execute(sql`
        SELECT network, count(*) AS clicks, count(DISTINCT link_id || ':' || visitor_hash) AS uniq
        FROM link_clicks WHERE workspace_id = ${workspaceId} AND NOT is_bot AND occurred_at >= ${from} AND occurred_at <= ${to}
        GROUP BY network ORDER BY clicks DESC`),
    );
    const convByNetwork = new Map(
      rowsOf<{ network: string | null; n: string | number; v: string | number }>(
        await this.ctx.db.execute(sql`SELECT network, count(*) AS n, COALESCE(sum(value), 0) AS v FROM conversions WHERE workspace_id = ${workspaceId} AND occurred_at >= ${from} AND occurred_at <= ${to} GROUP BY network`),
      ).map((r) => [r.network ?? "", { conversions: Number(r.n), value: Number(r.v) }]),
    );
    const byDay = rowsOf<{ day: string; clicks: string | number }>(
      await this.ctx.db.execute(sql`
        SELECT to_char(occurred_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day, count(*) AS clicks
        FROM link_clicks WHERE workspace_id = ${workspaceId} AND NOT is_bot AND occurred_at >= ${from} AND occurred_at <= ${to}
        GROUP BY day ORDER BY day`),
    ).map((r) => ({ day: r.day, clicks: Number(r.clicks) }));
    const top = rowsOf<{ link_id: string; clicks: string | number }>(
      await this.ctx.db.execute(sql`
        SELECT link_id, count(*) AS clicks FROM link_clicks
        WHERE workspace_id = ${workspaceId} AND NOT is_bot AND occurred_at >= ${from} AND occurred_at <= ${to}
        GROUP BY link_id ORDER BY clicks DESC LIMIT 10`),
    );
    const topLinks = top.length ? await this.ctx.db.select().from(trackedLinks).where(inArray(trackedLinks.id, top.map((t) => t.link_id))) : [];
    const topStats = await this.statsByLink(topLinks.map((l) => l.id));
    const linkById = new Map(topLinks.map((l) => [l.id, l]));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      configured: Boolean(this.baseUrl),
      totals: {
        clicks: Number(totals?.clicks ?? 0),
        uniqueVisitors: Number(totals?.uniq ?? 0),
        previews: Number(totals?.previews ?? 0),
        conversions: Number(conv?.n ?? 0),
        attributedConversions: Number(conv?.attributed ?? 0),
        conversionValue: Number(conv?.v ?? 0),
        valueByCurrency: currencies,
      },
      byNetwork: byNetwork.map((r) => ({ network: r.network, clicks: Number(r.clicks), uniqueVisitors: Number(r.uniq), ...(convByNetwork.get(r.network ?? "") ?? { conversions: 0, value: 0 }) })),
      byDay,
      topLinks: top.flatMap((t) => {
        const l = linkById.get(t.link_id);
        if (!l) return [];
        return [{ id: l.id, slug: l.slug, shortUrl: this.baseUrl ? this.shortUrl(l.slug) : null, destination: l.destination, network: l.network, postId: l.postId, variantId: l.variantId, placement: l.placement, ...(topStats.get(l.id) ?? emptyStats(1)), clicksInRange: Number(t.clicks) }];
      }),
    };
  }

  /**
   * Writes cumulative owned metrics for variants that saw clicks or conversions since `since`, so the metrics
   * series and dashboards show them next to network numbers (entity id: the network's post id, as connectors do).
   */
  async rollup(since: Date, now = this.ctx.now()): Promise<number> {
    const active = rowsOf<{ variant_id: string }>(
      await this.ctx.db.execute(sql`
        SELECT DISTINCT variant_id FROM link_clicks WHERE variant_id IS NOT NULL AND occurred_at > ${since}
        UNION SELECT DISTINCT variant_id FROM conversions WHERE variant_id IS NOT NULL AND created_at > ${since}`),
    ).map((r) => r.variant_id);
    if (active.length === 0) return 0;
    const variants = await this.ctx.db.select({ id: postVariants.id, externalId: postVariants.externalId }).from(postVariants).where(inArray(postVariants.id, active));
    const stats = await this.statsByVariant(active, now);
    const rows: (typeof metrics.$inferInsert)[] = [];
    for (const v of variants) {
      const s = stats.get(v.id);
      if (!s || !v.externalId) continue;
      rows.push(
        { entityType: "post_variant", entityId: v.externalId, metric: "tracked_clicks", value: s.uniqueVisitors, observedAt: now, source: "starsign" },
        { entityType: "post_variant", entityId: v.externalId, metric: "conversions", value: s.conversions, observedAt: now, source: "starsign" },
        { entityType: "post_variant", entityId: v.externalId, metric: "conversion_value", value: s.conversionValue, observedAt: now, source: "starsign" },
      );
    }
    if (rows.length) await this.ctx.db.insert(metrics).values(rows);
    return rows.length;
  }

  /** Outcome-ledger metrics for one variant: only present when the variant had tracked links. */
  static outcomeMetrics(s: LinkStats | undefined): Record<string, number> {
    if (!s) return {};
    return { tracked_clicks: s.uniqueVisitors, conversions: s.conversions, conversion_value: s.conversionValue };
  }
}

function emptyStats(links: number): LinkStats {
  return { links, clicks: 0, uniqueVisitors: 0, previews: 0, conversions: 0, conversionValue: 0 };
}

/** `(a, b, c)` with each value bound as a parameter. */
function sqlList(values: string[]) {
  return sql`(${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

