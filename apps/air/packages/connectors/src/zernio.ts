// TODO(verify against Zernio docs): https://docs.zernio.com, https://zernio.com/docs and
// https://getlate.dev/docs were all unreachable from the build environment (DNS blocked), so every
// request and response shape in this file is ASSUMED from the integration brief, not confirmed:
//   POST {baseUrl}/v1/posts            Authorization: Bearer <apiKey>, Idempotency-Key: <key>
//        { content, platforms: [{ accountId, platform }], mediaItems: [{ url, type }], scheduledFor? }
//        -> { post: { id, platforms: [{ platform, platformPostId, url }] } }
//   GET  {baseUrl}/v1/posts/{id}/analytics                -> metrics object
//   GET  {baseUrl}/v1/accounts/{id}/mentions?since=<iso>  -> inbound activity
// Responses are read defensively (several plausible field names each) so a near-miss in naming
// degrades to missing fields rather than a crash. Re-check against the real docs before production.
import { ActivityKind, Network, type ActivityInput, type MetricInput, type MetricName } from "@base-air/schema";
import { asNetworkError, classifyHttpStatus, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountRef, Connector, ConnectorCapabilities, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

export interface ZernioConnectorOptions {
  apiKey: string;
  /** ASSUMED default; override with the base URL from the Zernio dashboard. */
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

/** Attached as `cause` on every ConnectorError raised from an HTTP response. */
export interface ZernioHttpFailure {
  status: number;
  body: unknown;
}

/** ASSUMED analytics field names → base air's canonical metric names. */
const METRIC_ALIASES: Record<string, MetricName> = {
  impressions: "impressions",
  views: "impressions",
  reach: "reach",
  likes: "likes",
  reactions: "likes",
  comments: "replies",
  replies: "replies",
  reposts: "reposts",
  retweets: "reposts",
  shares: "shares",
  quotes: "quotes",
  saves: "saves",
  bookmarks: "saves",
  clicks: "clicks",
  linkClicks: "link_clicks",
  link_clicks: "link_clicks",
  videoViews: "video_views",
  video_views: "video_views",
  profileVisits: "profile_visits",
  profile_visits: "profile_visits",
  follows: "follows",
  followers: "followers_total",
  engagements: "engagements",
  engagement: "engagements",
};

/** Interaction metrics summed into `engagements` when the API does not report one itself. */
const ENGAGEMENT_PARTS: readonly MetricName[] = ["likes", "replies", "reposts", "shares", "quotes", "saves"];

export function mapZernioError(status: number, headers: Headers, body: unknown, ctx: { what: string; creating: boolean }): ConnectorError {
  const detail = zernioErrorDetail(body);
  const msg = `zernio ${ctx.what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: ZernioHttpFailure = { status, body };
  if (status === 429) {
    const retryAfter = headers.get("retry-after");
    return new ConnectorError(retryAfter ? `${msg}; retry after ${retryAfter}s` : msg, "rate_limit", true, cause);
  }
  // A 403 on create most plausibly means the target account or plan refused this post, not that our key is bad.
  if (status === 403 && ctx.creating) return new ConnectorError(msg, "rejected", false, cause);
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

/**
 * Zernio (formerly Late) unified posting API. One API key fronts every network base air knows, so
 * this adapter serves all of them; `account.externalId` is Zernio's id for the connected account.
 *
 * Ids: `externalId` is Zernio's post id, not the network's, because the analytics endpoint is keyed
 * by it; the network-side id and URL are kept in `raw` and `url`.
 */
export class ZernioConnector implements Connector {
  readonly connectMethod = "api_key" as const;
  readonly name = "zernio";
  readonly networks: readonly Network[] = Network.options;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly idempotency = new IdempotencyCache<PublishResult>();

  constructor(opts: ZernioConnectorOptions) {
    if (!opts.apiKey) throw new Error("ZernioConnector requires an apiKey");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.zernio.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false };
  }

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    // The assumed create-post body has no thread field; refusing up front beats silently posting only the root.
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "zernio adapter v0 posts a single item; thread segments are not supported until the API shape is verified" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    // Nothing in the assumed body expresses a reply target; dropping it would publish a top-level post instead.
    if (input.replyToExternalId) throw new ConnectorError("zernio publish: replies are not supported by this adapter yet", "rejected", false);
    // Zernio gets the Idempotency-Key header too; the local cache only saves a round trip on retry.
    return this.idempotency.run(input.idempotencyKey, async () => {
      const body: Record<string, unknown> = {
        content: input.text,
        platforms: [{ accountId: account.externalId, platform: account.network }],
      };
      if (input.media.length > 0) body.mediaItems = input.media.map((m) => ({ url: m.url, type: m.kind }));
      const res = await this.request("POST", "/v1/posts", { json: body, headers: { "idempotency-key": input.idempotencyKey }, creating: true });
      const post = objectAt(res, ["post", "data"]) ?? asObject(res);
      const id = str(post?.id);
      if (!id) throw new ConnectorError("zernio publish: response carried no post id", "unknown", false, res);
      const platforms = Array.isArray(post?.platforms) ? post.platforms.map(asObject).filter((p): p is Record<string, unknown> => p !== undefined) : [];
      const mine = platforms.find((p) => p.platform === account.network || p.accountId === account.externalId) ?? platforms[0];
      return { externalId: id, url: str(mine?.url) ?? null, raw: res };
    });
  }

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const res = await this.request("GET", `/v1/accounts/${encodeURIComponent(account.externalId)}/mentions`, { query: since ? { since: since.toISOString() } : {} });
    const items = arrayAt(res, ["mentions", "data", "items"]);
    const fallbackAt = this.now().toISOString();
    const out: ActivityInput[] = [];
    for (const raw of items) {
      const item = toActivity(raw, account, fallbackAt);
      // The server is asked for `since`, but filter again in case it ignores the parameter.
      if (item && (!since || Date.parse(item.occurredAt) > since.getTime())) out.push(item);
    }
    return out;
  }

  async fetchMetrics(_account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      const res = await this.request("GET", `/v1/posts/${encodeURIComponent(id)}/analytics`);
      out.push(...toMetrics(id, res, observedAt));
    }
    return out;
  }

  private async request(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; json?: unknown; headers?: Record<string, string>; creating?: boolean } = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, accept: "application/json", ...opts.headers };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method, headers, body });
    } catch (err) {
      throw asNetworkError(err, `zernio ${method} ${path}`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapZernioError(res.status, res.headers, data, { what: `${method} ${path}`, creating: opts.creating ?? false });
    return data;
  }
}

// ---- defensive readers for the assumed shapes ---------------------------------------------

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

/** First of `keys` that holds an object on `v`. */
function objectAt(v: unknown, keys: string[]): Record<string, unknown> | undefined {
  const o = asObject(v);
  if (!o) return undefined;
  for (const k of keys) {
    const inner = asObject(o[k]);
    if (inner) return inner;
  }
  return undefined;
}

/** First of `keys` that holds an array on `v`, or `v` itself when it is the array. */
function arrayAt(v: unknown, keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  const o = asObject(v);
  if (!o) return [];
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return [];
}

function zernioErrorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  const o = asObject(body);
  if (!o) return "";
  const err = asObject(o.error);
  return [o.message, o.error, err?.message, o.detail].filter((x): x is string => typeof x === "string").join(": ");
}

function toActivity(raw: unknown, account: AccountRef, fallbackAt: string): ActivityInput | null {
  const r = asObject(raw);
  if (!r) return null;
  const id = str(r.id) ?? str(r.platformPostId) ?? str(r.externalId);
  if (!id) return null;
  const author = asObject(r.author) ?? {};
  const type = str(r.type) ?? str(r.kind) ?? "mention";
  const kind = ActivityKind.safeParse(type);
  return {
    network: account.network,
    kind: kind.success ? kind.data : "mention",
    externalId: id,
    authorHandle: str(r.authorHandle) ?? str(author.handle) ?? str(author.username) ?? null,
    authorName: str(r.authorName) ?? str(author.name) ?? str(author.displayName) ?? null,
    text: str(r.text) ?? str(r.content) ?? null,
    url: str(r.url) ?? str(r.permalink) ?? null,
    parentExternalId: str(r.parentPostId) ?? str(r.postId) ?? str(r.parentId) ?? null,
    occurredAt: str(r.createdAt) ?? str(r.occurredAt) ?? str(r.timestamp) ?? fallbackAt,
    raw,
  };
}

function toMetrics(entityId: string, res: unknown, observedAt: string): MetricInput[] {
  const source = objectAt(res, ["analytics", "metrics", "data"]) ?? asObject(res) ?? {};
  const values = new Map<MetricName, number>();
  for (const [key, metric] of Object.entries(METRIC_ALIASES)) {
    const v = source[key];
    if (typeof v === "number" && !values.has(metric)) values.set(metric, v);
  }
  if (!values.has("engagements")) {
    const parts = ENGAGEMENT_PARTS.filter((m) => values.has(m));
    if (parts.length > 0) values.set("engagements", parts.reduce((sum, m) => sum + (values.get(m) ?? 0), 0));
  }
  return [...values].map(([metric, value]) => ({ entityType: "post_variant", entityId, metric, value, observedAt, source: "zernio" }));
}
