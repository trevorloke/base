import { createHash } from "node:crypto";
import type { ActivityInput, MetricInput, Network } from "@starsign/schema";
import { asNetworkError, resolveFetch, type FetchLike } from "./http.ts";
import { discoverFeedLink, parseFeed, primaryLanguage, type ParsedFeed, type ParsedFeedItem } from "./feed-parse.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, PublishResult } from "./types.ts";
import { ConnectorError } from "./types.ts";
import { assertPublicHttpUrl, type LookupFn, type UrlPolicy } from "./webhook.ts";

/**
 * RSS/Atom monitoring: listening only. One account = one feed (blog, news site, podcast, forum, changelog, Google
 * Alerts, a subreddit's .rss, a YouTube channel feed...). Each poll fetches the feed with a conditional GET and turns
 * new items into "mention" activities, so they show in the live feed and the tracker scans them like any other
 * content about the world.
 *
 * Fetching is defensive: http(s) only at every redirect hop, no private/loopback destinations (unless
 * STARSIGN_ALLOW_PRIVATE_URLS=1), a 5 MB response cap and a timeout. The parser never expands DTD entities.
 */

const ACCEPT = "application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, text/html;q=0.3, */*;q=0.1";
const TEXT_CAP = 4000;

export interface RssConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  /** STARSIGN_ALLOW_PRIVATE_URLS=1: allow feeds on private/loopback hosts (an intranet feed next to a self-hosted Starsign). */
  allowPrivate?: boolean;
  lookup?: LookupFn;
  /** Per request, including the body. */
  timeoutMs?: number;
  /** Largest response read, in bytes. */
  maxBytes?: number;
  /** Items returned on the first poll (no `since`). */
  firstRunItems?: number;
  /** Hard cap on items returned by one poll. */
  maxItemsPerPoll?: number;
  maxRedirects?: number;
  /** STARSIGN_PUBLIC_URL, named in the User-Agent so feed owners can see who polls. */
  publicUrl?: string;
}

interface Validators {
  etag?: string;
  lastModified?: string;
}

type Fetched = { notModified: true } | { notModified: false; text: string; finalUrl: string; contentType: string; validators: Validators };

/** Map a feed server's HTTP error. 401/403 usually means the feed needs a login or blocks automated readers. */
export function mapFeedError(status: number, headers: Headers, host: string): ConnectorError {
  const msg = `rss ${host}: HTTP ${status}`;
  const cause: { status: number; retryAfter?: number } = { status };
  if (status === 429) {
    const ra = headers.get("retry-after");
    const after = ra && /^\d+$/.test(ra) ? Number(ra) : NaN;
    if (Number.isFinite(after)) cause.retryAfter = after;
    return new ConnectorError(`${msg} (rate limited${Number.isFinite(after) ? `; retry after ${after}s` : ""})`, "rate_limit", true, cause);
  }
  if (status === 401 || status === 403) return new ConnectorError(`${msg} (the feed needs a login or refuses automated readers)`, "auth", false, cause);
  if (status === 404 || status === 410) return new ConnectorError(`${msg} (the feed is gone; check its URL)`, "rejected", false, cause);
  if (status === 408 || status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (status >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

/** Pick the text encoding from Content-Type, else the XML declaration, else UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 512));
  const fromProlog = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head.replace(/^﻿|^ï»¿/, ""))?.[1];
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromProlog, meta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // unknown label: try the next source
    }
  }
  return new TextDecoder().decode(bytes);
}

/** Read a body up to `max` bytes; larger responses are refused (and the stream cancelled). */
async function readCapped(res: Response, max: number, host: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new ConnectorError(`rss ${host}: the feed is ${(declared / 1048576).toFixed(1)} MB; the limit is ${(max / 1048576).toFixed(0)} MB`, "rejected", false);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ConnectorError(`rss ${host}: the feed is larger than ${(max / 1048576).toFixed(0)} MB`, "rejected", false);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function withoutHash(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.toString();
}

/** True for ids that are globally unique by construction (URLs, tag: and urn: URIs). */
function isGlobalId(id: string): boolean {
  return /^(https?:\/\/|tag:|urn:)/i.test(id);
}

/** A feed item → activity. Exported for tests and for anything else that reads feeds (the tracker). */
export function feedItemToActivity(item: ParsedFeedItem, feed: { url: string; title: string; language: string | null }, now: Date): ActivityInput | null {
  const title = item.title.trim();
  let summary = item.summary.trim();
  if (summary === title) summary = "";
  const text = [title, summary].filter(Boolean).join("\n\n").slice(0, TEXT_CAP);
  if (!text) return null;
  const host = new URL(feed.url).hostname.replace(/^www\./, "");
  const key = item.id ?? item.link ?? createHash("sha256").update(`${title}\n${item.published ?? ""}\n${summary.slice(0, 500)}`).digest("hex").slice(0, 32);
  // Plain guids ("1234") repeat across feeds, so they are namespaced by the feed; URL/tag/urn ids are kept as is
  // so one article syndicated in two feeds stays one item.
  const externalId = (isGlobalId(key) ? key : `${feed.url}|${key}`).slice(0, 1000);
  const t = item.published ? Date.parse(item.published) : NaN;
  // Future-dated items (time-zone mistakes, scheduled posts) are pinned to now so `since` filtering still works.
  const occurredAt = Number.isFinite(t) && t <= now.getTime() + 5 * 60_000 ? new Date(t).toISOString() : now.toISOString();
  const lang = primaryLanguage(item.lang) ?? primaryLanguage(feed.language);
  return {
    network: "rss",
    kind: "mention",
    externalId,
    authorHandle: host,
    authorName: item.author ?? (feed.title || host),
    text,
    url: item.link,
    parentExternalId: null,
    occurredAt,
    raw: { feed: { url: feed.url, title: feed.title }, item },
    conversation: { id: feed.url, name: feed.title || host, type: "channel" },
    ...(lang ? { lang } : {}),
  };
}

export class RssConnector implements Connector {
  readonly name = "rss";
  readonly networks: readonly Network[] = ["rss"];
  readonly connectMethod = "webhook_url" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "feedUrl", label: "Feed URL (RSS or Atom; a site URL works if it links its feed)", placeholder: "https://example.com/feed.xml" },
    { key: "name", label: "Name (optional; defaults to the feed's title)", placeholder: "Industry news", optional: true },
  ] as const;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly policy: UrlPolicy;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly firstRunItems: number;
  private readonly maxItemsPerPoll: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;
  /** ETag / Last-Modified per (account, feed): per account so one workspace's 304 never hides items from another. */
  private readonly validators = new Map<string, Validators>();
  /** External ids of undated items already returned, per account (they would otherwise pass every `since`). */
  private readonly seenUndated = new Map<string, Set<string>>();

  constructor(opts: RssConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.policy = { allowHttp: true, allowPrivate: opts.allowPrivate ?? false, ...(opts.lookup ? { lookup: opts.lookup } : {}) };
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.firstRunItems = opts.firstRunItems ?? 50;
    this.maxItemsPerPoll = opts.maxItemsPerPoll ?? 200;
    this.maxRedirects = opts.maxRedirects ?? 5;
    this.userAgent = `Starsign-RSS/1${opts.publicUrl ? ` (+${opts.publicUrl.replace(/\/+$/, "")})` : ""}`;
  }

  capabilities(): ConnectorCapabilities {
    return { publish: false, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: false, moderate: false, accountMetrics: false, webhooks: false, video: false, kinds: [] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const raw = (p.inputs.feedUrl ?? "").trim();
    if (!raw) throw new ConnectorError("rss: paste the feed URL", "rejected", false);
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const { feedUrl, feed } = await this.load(withScheme);
    const host = new URL(feedUrl).hostname.replace(/^www\./, "");
    const name = (p.inputs.name ?? "").trim().slice(0, 100);
    const handle = name || feed.title || host;
    return [
      {
        network: "rss",
        identity: { externalId: feedUrl, handle, displayName: feed.title || null },
        auth: { feedUrl },
        config: { feedUrl, title: feed.title || null, siteUrl: feed.link, host, format: feed.format, language: primaryLanguage(feed.language), name: name || null },
      },
    ];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const url = typeof auth.feedUrl === "string" ? auth.feedUrl : "";
    if (!url) throw new ConnectorError("rss: auth blob needs a feedUrl", "auth", false);
    const { feedUrl, feed } = await this.load(url);
    return { externalId: feedUrl, handle: feed.title || new URL(feedUrl).hostname, displayName: feed.title || null };
  }

  /** Fetch and parse a feed; when the URL is an HTML page that advertises a feed, follow that once. */
  private async load(url: string): Promise<{ feedUrl: string; feed: ParsedFeed }> {
    const first = await this.get(url, undefined);
    if (first.notModified) throw new ConnectorError("rss: unexpected 304 without a conditional request", "unknown", false);
    const parsed = parseFeed(first.text, first.finalUrl);
    if (parsed) return { feedUrl: withoutHash(url), feed: parsed };
    const discovered = discoverFeedLink(first.text, first.finalUrl);
    if (discovered) {
      const second = await this.get(discovered, undefined);
      const feed = second.notModified ? null : parseFeed(second.text, second.finalUrl);
      if (feed) return { feedUrl: withoutHash(discovered), feed };
    }
    throw new ConnectorError(`rss: ${new URL(url).hostname} did not return an RSS or Atom feed (and the page links none)`, "rejected", false);
  }

  /** GET with manual redirects (each hop re-checked), conditional headers, a timeout and a size cap. */
  private async get(url: string, cond: Validators | undefined): Promise<Fetched> {
    let current = url;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const u = await assertPublicHttpUrl(current, this.policy, "rss feed");
      const headers: Record<string, string> = { accept: ACCEPT, "user-agent": this.userAgent };
      if (cond?.etag) headers["if-none-match"] = cond.etag;
      if (cond?.lastModified) headers["if-modified-since"] = cond.lastModified;
      let res: Response;
      try {
        res = await resolveFetch(this.fetchImpl)(u.toString(), { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        const e = err instanceof Error && err.name === "TimeoutError" ? new Error(`timed out after ${this.timeoutMs} ms`) : err;
        throw asNetworkError(e, `rss ${u.host}`);
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!loc) throw new ConnectorError(`rss ${u.host}: HTTP ${res.status} without a Location`, "rejected", false);
        let next: URL;
        try {
          next = new URL(loc, u);
        } catch {
          throw new ConnectorError(`rss ${u.host}: redirect to an unreadable location`, "rejected", false);
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") throw new ConnectorError(`rss ${u.host}: refused a redirect to ${next.protocol} (only http and https are followed)`, "rejected", false);
        current = next.toString();
        continue;
      }
      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined);
        return { notModified: true };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw mapFeedError(res.status, res.headers, u.host);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(res, this.maxBytes, u.host);
      } catch (err) {
        if (err instanceof ConnectorError) throw err;
        const e = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? new Error(`timed out after ${this.timeoutMs} ms`) : err;
        throw asNetworkError(e, `rss ${u.host}`);
      }
      const contentType = res.headers.get("content-type") ?? "";
      const validators: Validators = {};
      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      if (etag) validators.etag = etag;
      if (lastModified) validators.lastModified = lastModified;
      return { notModified: false, text: decodeBody(bytes, contentType), finalUrl: u.toString(), contentType, validators };
    }
    throw new ConnectorError(`rss: more than ${this.maxRedirects} redirects`, "rejected", false);
  }

  // ---- listen ---------------------------------------------------------------------------

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const feedUrl = typeof account.auth?.feedUrl === "string" ? account.auth.feedUrl : typeof account.config.feedUrl === "string" ? account.config.feedUrl : account.externalId;
    const key = `${account.id}|${feedUrl}`;
    const res = await this.get(feedUrl, this.validators.get(key));
    if (res.notModified) return [];
    const feed = parseFeed(res.text, res.finalUrl);
    if (!feed) throw new ConnectorError(`rss ${new URL(feedUrl).hostname}: the response is no longer an RSS or Atom feed`, "rejected", false);
    // Remember validators only once the body parsed, so a broken response is fetched in full next time.
    if (res.validators.etag || res.validators.lastModified) this.validators.set(key, res.validators);
    else this.validators.delete(key);

    const now = this.now();
    const meta = { url: feedUrl, title: feed.title, language: feed.language };
    let seen = this.seenUndated.get(account.id);
    if (!seen) {
      seen = new Set();
      this.seenUndated.set(account.id, seen);
    }
    const out: ActivityInput[] = [];
    const ids = new Set<string>();
    for (const item of feed.items) {
      const a = feedItemToActivity(item, meta, now);
      if (!a || ids.has(a.externalId)) continue;
      ids.add(a.externalId);
      if (item.published) {
        if (since && Date.parse(a.occurredAt) <= since.getTime()) continue;
      } else {
        // Undated: new to this process only. The first poll of a process takes them (core dedupes on externalId).
        if (seen.has(a.externalId)) continue;
        seen.add(a.externalId);
      }
      out.push(a);
    }
    if (seen.size > 5000) this.seenUndated.set(account.id, new Set([...seen].slice(-2000)));
    out.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    return out.slice(0, since ? this.maxItemsPerPoll : this.firstRunItems);
  }

  async publish(): Promise<PublishResult> {
    throw new ConnectorError("rss feeds are listen-only; there is nothing to publish to", "rejected", false);
  }

  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }
}

export function createRssConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new RssConnector({ allowPrivate: env.STARSIGN_ALLOW_PRIVATE_URLS === "1", ...(env.STARSIGN_PUBLIC_URL ? { publicUrl: env.STARSIGN_PUBLIC_URL } : {}) })];
}
