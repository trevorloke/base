import { AppBskyRichtextFacet, AtpAgent, AtUri, RichText } from "@atproto/api";
import type { AppBskyEmbedImages, AppBskyFeedDefs, AppBskyFeedPost, AppBskyNotificationListNotifications, BlobRef, Facet } from "@atproto/api";
import type { ActivityInput, ActivityKind, Media, MetricInput, MetricName, Network } from "@starsign/schema";
import { z } from "zod";
import { downloadMedia, isAfter, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountRef, Connector, ConnectorCapabilities, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/** Decrypted credential blob for a Bluesky account: an app password, never the main password. */
export const BlueskyAuth = z.object({
  identifier: z.string().min(1),
  appPassword: z.string().min(1),
  service: z.string().url().default("https://bsky.social"),
});
export type BlueskyAuth = z.infer<typeof BlueskyAuth>;

export type BlueskyPostRecord = Parameters<AtpAgent["post"]>[0];

/**
 * The slice of `AtpAgent` this adapter actually uses. Narrowing it lets tests inject a fake that
 * never logs in, and keeps the adapter honest about which XRPC calls it depends on.
 */
export interface BlueskyAgentLike {
  login(opts: { identifier: string; password: string }): Promise<unknown>;
  readonly session?: { did: string; handle: string } | undefined;
  resolveHandle(params: { handle: string }): Promise<{ data: { did: string } }>;
  uploadBlob(data: Uint8Array, opts?: { encoding?: string }): Promise<{ data: { blob: BlobRef } }>;
  post(record: BlueskyPostRecord): Promise<{ uri: string; cid: string }>;
  getPosts(params: { uris: string[] }): Promise<{ data: { posts: AppBskyFeedDefs.PostView[] } }>;
  getAuthorFeed(params: { actor: string; limit?: number; cursor?: string; filter?: string }): Promise<{ data: { feed: AppBskyFeedDefs.FeedViewPost[]; cursor?: string } }>;
  listNotifications(params: { limit?: number; cursor?: string }): Promise<{ data: { notifications: AppBskyNotificationListNotifications.Notification[]; cursor?: string } }>;
}

export interface BlueskyConnectorOptions {
  /** Builds the agent for a PDS/entryway URL. Tests inject a fake; production gets a real `AtpAgent`. */
  agentFactory?: (service: string) => BlueskyAgentLike;
  /** Used to download media before re-uploading it as a blob. Defaults to the global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  /** Upper bound on pages (100 items each) walked per feed when `since` is far back or null. */
  maxPages?: number;
}

interface Session {
  identifier: string;
  service: string;
  agent: BlueskyAgentLike;
  did: string;
  handle: string;
}

type StrongRef = { uri: string; cid: string };

const NOTIFICATION_KINDS: Record<string, ActivityKind> = {
  mention: "mention",
  reply: "reply",
  quote: "quote",
  repost: "repost",
  "repost-via-repost": "repost",
  like: "like",
  "like-via-repost": "like",
  follow: "follow",
};

/** XRPC error names that mean the session is dead or the account cannot act, whatever the HTTP status. */
const AUTH_ERROR_NAMES = new Set(["AuthenticationRequired", "ExpiredToken", "InvalidToken", "AuthMissing", "AuthFactorTokenRequired", "AccountTakedown", "AccountSuspended", "AccountDeactivated"]);

/** Web URL for a post. Returns null for a malformed at-uri rather than fabricating a link. */
export function blueskyPostUrl(handle: string, atUri: string): string | null {
  try {
    return `https://bsky.app/profile/${handle}/post/${new AtUri(atUri).rkey}`;
  } catch {
    return null;
  }
}

/**
 * Normalize whatever the AT Protocol client throws. XRPCError carries a numeric `status`
 * (HTTP code, or 1 for "no response"), so we duck-type on that instead of `instanceof` to stay
 * robust to duplicated package copies and to fakes in tests.
 */
export function mapBlueskyError(err: unknown, phase: "login" | "call" = "call"): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as { status?: unknown; error?: unknown; message?: unknown; headers?: Record<string, string | undefined> };
  const message = typeof e.message === "string" ? e.message : String(err);
  const name = typeof e.error === "string" ? e.error : "";
  const status = typeof e.status === "number" ? e.status : undefined;
  const wrap = (kind: ConnectorError["kind"], retryable: boolean, detail = message) => new ConnectorError(`bluesky ${phase}: ${detail}`, kind, retryable, err);

  // Not an XRPC error: fetch itself failed (DNS, reset, timeout) or something unexpected threw.
  if (status === undefined) return err instanceof TypeError ? wrap("network", true) : wrap("unknown", false);
  if (status === 429 || name === "RateLimitExceeded") {
    const reset = e.headers?.["ratelimit-reset"];
    return wrap("rate_limit", true, reset ? `${message} (ratelimit-reset=${reset})` : message);
  }
  if (status === 401 || status === 403 || AUTH_ERROR_NAMES.has(name)) return wrap("auth", false);
  // While logging in, every client error is a credential problem (bad app password, 2FA required).
  if (phase === "login" && status >= 400 && status < 500) return wrap("auth", false);
  if (status === 1 || status >= 500) return wrap("network", true);
  if (status >= 400) return wrap("rejected", false);
  return wrap("unknown", false);
}

/**
 * Native Bluesky adapter over the AT Protocol.
 *
 * Idempotency: Bluesky has no server-side idempotency key, so publish results are cached in memory
 * by idempotencyKey (see IdempotencyCache for the restart caveat), and a thread that fails part-way
 * resumes from the last segment that made it onto the network instead of re-posting the root.
 */
export class BlueskyConnector implements Connector {
  readonly connectMethod = "app_password" as const;

  /** Log in with the app password and read the account's DID and handle. Throws ConnectorError("auth") on bad credentials. */
  async describeAccount(rawAuth: Record<string, unknown>) {
    const parsed = BlueskyAuth.safeParse(rawAuth);
    if (!parsed.success) throw new ConnectorError("bluesky: identifier and appPassword are required", "auth", false, parsed.error);
    const agent = this.agentFactory(parsed.data.service);
    try {
      await agent.login({ identifier: parsed.data.identifier, password: parsed.data.appPassword });
    } catch (err) {
      throw mapBlueskyError(err, "login");
    }
    const session = agent.session;
    if (!session?.did) throw new ConnectorError("bluesky: login succeeded but no session was returned", "unknown", true);
    return { externalId: session.did, handle: session.handle, displayName: null };
  }

  readonly name = "bluesky";
  readonly networks: readonly Network[] = ["bluesky"];

  private readonly agentFactory: (service: string) => BlueskyAgentLike;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly maxPages: number;
  private readonly sessions = new Map<string, Session>();
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly progress = new Map<string, StrongRef[]>();

  constructor(opts: BlueskyConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.agentFactory = opts.agentFactory ?? ((service) => new AtpAgent({ service, ...(opts.fetch ? { fetch: opts.fetch } : {}) }));
    this.now = opts.now ?? (() => new Date());
    this.maxPages = opts.maxPages ?? 10;
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false };
  }

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const m of input.media) {
      if (m.kind === "video") issues.push({ code: "unsupported_media", message: "bluesky connector v0 does not support video upload yet; publish with images only or drop the media" });
      else if (m.kind === "document") issues.push({ code: "unsupported_media", message: "bluesky has no document attachments" });
    }
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, () => this.call(account, (s) => this.publishSegments(s, input)));
  }

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    return this.call(account, async (s) => {
      const items = [...(await this.notifications(s, since)), ...(await this.ownPosts(s, since))];
      return items.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    });
  }

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    if (externalIds.length === 0) return [];
    return this.call(account, async (s) => {
      const out: MetricInput[] = [];
      const observedAt = this.now().toISOString();
      // getPosts accepts at most 25 uris per call.
      for (let i = 0; i < externalIds.length; i += 25) {
        const res = await s.agent.getPosts({ uris: externalIds.slice(i, i + 25) });
        for (const p of res.data.posts) {
          const row = (metric: MetricName, value: number): MetricInput => ({ entityType: "post_variant", entityId: p.uri, metric, value, observedAt, source: "bluesky" });
          const likes = p.likeCount ?? 0;
          const reposts = p.repostCount ?? 0;
          const replies = p.replyCount ?? 0;
          const quotes = p.quoteCount ?? 0;
          out.push(row("likes", likes), row("reposts", reposts), row("replies", replies), row("quotes", quotes), row("engagements", likes + reposts + replies + quotes));
          if (typeof p.bookmarkCount === "number") out.push(row("saves", p.bookmarkCount));
        }
      }
      return out;
    });
  }

  // ---- publishing -------------------------------------------------------------------------

  private async publishSegments(s: Session, input: PublishInput): Promise<PublishResult> {
    const { agent } = s;
    const key = input.idempotencyKey;
    const segments = [input.text, ...input.thread];
    // Segments already on the network from an earlier, failed attempt are not posted again.
    const posted: StrongRef[] = this.progress.get(key) ?? [];
    const replyTo = input.replyToExternalId ? await this.replyRefs(agent, input.replyToExternalId) : undefined;
    // Media only rides on the root post, so there is nothing to upload when resuming past it.
    const embed = posted.length === 0 ? await this.uploadImages(agent, input.media) : undefined;

    try {
      for (let i = posted.length; i < segments.length; i++) {
        const rt = await this.richText(agent, segments[i] ?? "");
        const prev = posted[posted.length - 1];
        const root = replyTo?.root ?? posted[0];
        const reply: AppBskyFeedPost.ReplyRef | undefined = prev && root ? { root, parent: prev } : replyTo;
        const record: BlueskyPostRecord = {
          $type: "app.bsky.feed.post",
          text: rt.text,
          createdAt: this.now().toISOString(),
          ...(rt.facets ? { facets: rt.facets } : {}),
          ...(reply ? { reply } : {}),
          ...(i === 0 && embed ? { embed } : {}),
        };
        posted.push(await agent.post(record));
        this.progress.set(key, posted);
      }
    } catch (err) {
      // Part of the thread is live: tell core which posts exist so the variant is never an orphan on the network.
      const live = posted[0];
      if (live) {
        const ce = err instanceof ConnectorError ? err : mapBlueskyError(err, "call");
        ce.partial = { externalId: live.uri, url: blueskyPostUrl(s.handle, live.uri), threadExternalIds: posted.map((p) => p.uri) };
        throw ce;
      }
      throw err;
    }

    const rootPost = posted[0];
    if (!rootPost) throw new ConnectorError("bluesky publish: nothing to post", "rejected", false);
    this.progress.delete(key);
    return {
      externalId: rootPost.uri,
      url: blueskyPostUrl(s.handle, rootPost.uri),
      // Every post of the thread in order, root included, so metrics can follow each segment.
      ...(input.thread.length > 0 ? { threadExternalIds: posted.map((p) => p.uri) } : {}),
      raw: { posts: posted },
    };
  }

  /**
   * Facets make links clickable and mentions/hashtags real. `RichText.detectFacets()` wants a full
   * client for handle resolution; we resolve through our narrow agent surface instead so the fake in
   * tests stays small. A mention whose handle does not resolve is left as plain text rather than
   * shipping a facet the PDS would reject.
   */
  private async richText(agent: BlueskyAgentLike, text: string): Promise<{ text: string; facets: Facet[] | undefined }> {
    const rt = new RichText({ text });
    rt.detectFacetsWithoutResolution();
    const facets: Facet[] = [];
    for (const facet of rt.facets ?? []) {
      let keep = true;
      for (const feature of facet.features) {
        if (!AppBskyRichtextFacet.isMention(feature)) continue;
        const did = await agent
          .resolveHandle({ handle: feature.did })
          .then((r) => r.data.did)
          .catch(() => undefined);
        if (!did) {
          keep = false;
          break;
        }
        feature.did = did;
      }
      if (keep) facets.push(facet);
    }
    return { text: rt.text, facets: facets.length > 0 ? facets : undefined };
  }

  private async uploadImages(agent: BlueskyAgentLike, media: Media[]): Promise<BlueskyPostRecord["embed"] | undefined> {
    const images = media.filter((m) => m.kind === "image" || m.kind === "gif");
    if (images.length === 0) return undefined;
    const fetchImpl = resolveFetch(this.fetchImpl);
    const out: AppBskyEmbedImages.Image[] = [];
    for (const m of images) {
      const { bytes, mime } = await downloadMedia(fetchImpl, m);
      const res = await agent.uploadBlob(bytes, { encoding: mime });
      out.push({
        image: res.data.blob,
        alt: m.alt ?? "",
        ...(m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {}),
      });
    }
    return { $type: "app.bsky.embed.images", images: out };
  }

  /** A reply names both its direct parent and the thread root; if the parent is itself a reply, its record already knows the root. */
  private async replyRefs(agent: BlueskyAgentLike, parentUri: string): Promise<AppBskyFeedPost.ReplyRef> {
    const res = await agent.getPosts({ uris: [parentUri] });
    const parent = res.data.posts[0];
    if (!parent) throw new ConnectorError(`bluesky publish: reply target ${parentUri} not found`, "rejected", false);
    const parentRef: StrongRef = { uri: parent.uri, cid: parent.cid };
    const recordRoot = (parent.record as { reply?: { root?: { uri?: unknown; cid?: unknown } } }).reply?.root;
    const root: StrongRef = typeof recordRoot?.uri === "string" && typeof recordRoot.cid === "string" ? { uri: recordRoot.uri, cid: recordRoot.cid } : parentRef;
    return { root, parent: parentRef };
  }

  // ---- listening --------------------------------------------------------------------------

  private async notifications(s: Session, since: Date | null): Promise<ActivityInput[]> {
    const out: ActivityInput[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await s.agent.listNotifications({ limit: 100, cursor });
      const items = res.data.notifications;
      for (const n of items) {
        if (!isAfter(n.indexedAt, since)) continue;
        const kind = NOTIFICATION_KINDS[n.reason];
        if (!kind) continue; // verified, starterpack-joined, etc. are not attention events
        out.push(notificationToActivity(n, kind));
      }
      cursor = res.data.cursor;
      // Pages are newest-first: once a page's oldest item predates `since`, nothing further back qualifies.
      const oldest = items[items.length - 1];
      if (!cursor || !oldest || !isAfter(oldest.indexedAt, since)) break;
    }
    return out;
  }

  private async ownPosts(s: Session, since: Date | null): Promise<ActivityInput[]> {
    const out: ActivityInput[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const res = await s.agent.getAuthorFeed({ actor: s.did, limit: 100, cursor, filter: "posts_with_replies" });
      let sawOlder = false;
      for (const item of res.data.feed) {
        // The author feed interleaves the account's reposts of others; only records it wrote are own posts.
        if (item.reason || item.post.author.did !== s.did) continue;
        if (!isAfter(item.post.indexedAt, since)) {
          sawOlder = true;
          continue;
        }
        out.push(feedItemToActivity(item));
      }
      cursor = res.data.cursor;
      if (!cursor || res.data.feed.length === 0 || sawOlder) break;
    }
    return out;
  }

  // ---- sessions ---------------------------------------------------------------------------

  private async call<T>(account: AccountRef, fn: (s: Session) => Promise<T>): Promise<T> {
    const s = await this.agentFor(account);
    try {
      return await fn(s);
    } catch (err) {
      const mapped = mapBlueskyError(err, "call");
      // A dead session (revoked app password, failed refresh) must not be reused; the next call logs in again.
      if (mapped.kind === "auth") this.sessions.delete(account.id);
      throw mapped;
    }
  }

  /** One logged-in agent per account, re-created when credentials change or the session is gone. */
  private async agentFor(account: AccountRef): Promise<Session> {
    const auth = parseAuth(account);
    const cached = this.sessions.get(account.id);
    if (cached && cached.identifier === auth.identifier && cached.service === auth.service && cached.agent.session) return cached;
    this.sessions.delete(account.id);
    const agent = this.agentFactory(auth.service);
    try {
      await agent.login({ identifier: auth.identifier, password: auth.appPassword });
    } catch (err) {
      throw mapBlueskyError(err, "login");
    }
    const session: Session = {
      identifier: auth.identifier,
      service: auth.service,
      agent,
      did: agent.session?.did ?? account.externalId,
      handle: agent.session?.handle ?? account.handle,
    };
    this.sessions.set(account.id, session);
    return session;
  }
}

function parseAuth(account: AccountRef): BlueskyAuth {
  const parsed = BlueskyAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`bluesky account ${account.handle}: auth blob needs identifier and appPassword`, "auth", false, parsed.error);
  return parsed.data;
}

type PostRecordShape = { text?: unknown; reply?: { parent?: { uri?: unknown } } };

function parentUriOf(record: PostRecordShape): string | null {
  const uri = record.reply?.parent?.uri;
  return typeof uri === "string" ? uri : null;
}

function notificationToActivity(n: AppBskyNotificationListNotifications.Notification, kind: ActivityKind): ActivityInput {
  const record = n.record as PostRecordShape;
  const isPost = kind === "mention" || kind === "reply" || kind === "quote";
  return {
    network: "bluesky",
    kind,
    externalId: n.uri,
    authorHandle: n.author.handle,
    authorName: n.author.displayName ?? null,
    text: isPost && typeof record.text === "string" ? record.text : null,
    url: isPost ? blueskyPostUrl(n.author.handle, n.uri) : kind === "follow" ? `https://bsky.app/profile/${n.author.handle}` : null,
    // reasonSubject is the post of ours this is about (liked, reposted, replied to, quoted).
    parentExternalId: n.reasonSubject ?? parentUriOf(record),
    occurredAt: n.indexedAt,
    raw: n,
  };
}

function feedItemToActivity(item: AppBskyFeedDefs.FeedViewPost): ActivityInput {
  const { post } = item;
  const record = post.record as PostRecordShape;
  return {
    network: "bluesky",
    kind: "own_post",
    externalId: post.uri,
    authorHandle: post.author.handle,
    authorName: post.author.displayName ?? null,
    text: typeof record.text === "string" ? record.text : null,
    url: blueskyPostUrl(post.author.handle, post.uri),
    parentExternalId: parentUriOf(record),
    occurredAt: post.indexedAt,
    raw: item,
  };
}
