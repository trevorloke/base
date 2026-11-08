import type { ActivityInput, MetricInput, MetricName, Network } from "@base-air/schema";
import { z } from "zod";
import { asNetworkError, isAfter, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { defaultSleep, graphTime, hubChallenge, insightValue, mapGraphError, verifyHubSignature, type InsightRow } from "./meta.ts";
import { OAuth2Client, clientFromEnv } from "./oauth.ts";
import type {
  AccountIdentity,
  AccountRef,
  AuthRefresh,
  ConnectedAccount,
  Connector,
  ConnectorCapabilities,
  ModerationInput,
  PublishInput,
  PublishResult,
  ValidationIssue,
  WebhookBatch,
  WebhookHandler,
} from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Threads over the Threads API (graph.threads.net, its own OAuth app use case, separate from the Facebook Graph API).
 *
 * Tokens: code → short-lived (1 h) → long-lived (60 days) via th_exchange_token; refreshed with th_refresh_token
 * once at least 24 h old. Core refreshes when `expiresAt` is within 5 minutes, so `expiresAt` holds the time a refresh
 * becomes due (7 days before the real expiry, kept in `tokenExpiresAt`); any use in that last week renews the token.
 */

export const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_read_replies", "threads_manage_insights", "threads_delete"];

const REFRESH_LEAD_MS = 7 * 24 * 3_600_000;

export const ThreadsAuth = z.object({
  accessToken: z.string().min(1),
  userId: z.string().min(1),
  /** When core should refresh (7 days before tokenExpiresAt). */
  expiresAt: z.string().optional(),
  /** When the long-lived token actually expires. */
  tokenExpiresAt: z.string().optional(),
});
export type ThreadsAuth = z.infer<typeof ThreadsAuth>;

export interface ThreadsConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  webhookVerifyToken?: string;
  /** API host. Meta documents graph.threads.net and graph.threads.com as equivalent. */
  baseUrl?: string;
  apiVersion?: string;
  /** TODO(verify): Meta's current docs show threads.com for the authorization window; older guides use threads.net. */
  authorizeUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Own posts whose conversations are read per fetchActivity (default 10). */
  maxActivityPosts?: number;
}

interface ThreadsPost {
  id: string;
  text?: string;
  timestamp?: string;
  permalink?: string;
  username?: string;
  media_type?: string;
  is_reply?: boolean;
  replied_to?: { id?: string };
  root_post?: { id?: string };
  hide_status?: string;
}

interface Progress {
  posted: string[];
  container?: string;
  children?: string[];
}

const POST_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"];
// TODO(verify): `clicks` and `followers_count` on /threads_insights (followers_count confirmed by third-party examples only).
const USER_METRICS = ["views", "likes", "replies", "reposts", "quotes", "clicks", "followers_count"];

export class ThreadsConnector implements Connector {
  readonly name = "threads";
  readonly networks: readonly Network[] = ["threads"];
  readonly connectMethod = "oauth" as const;

  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly verifyToken: string | undefined;
  private readonly base: string;
  private readonly version: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly maxActivityPosts: number;
  private readonly oauth: OAuth2Client;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly progress = new Map<string, Progress>();
  private readonly invalidMetrics = new Set<string>();

  constructor(opts: ThreadsConnectorOptions = {}) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.verifyToken = opts.webhookVerifyToken;
    this.base = (opts.baseUrl ?? "https://graph.threads.net").replace(/\/+$/, "");
    this.version = opts.apiVersion ?? "v1.0";
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.maxPolls = opts.maxPolls ?? 20;
    this.maxActivityPosts = opts.maxActivityPosts ?? 10;
    this.oauth = new OAuth2Client(
      {
        name: "threads",
        authorizeUrl: opts.authorizeUrl ?? "https://threads.com/oauth/authorize",
        tokenUrl: `${this.base}/oauth/access_token`,
        scopes: THREADS_SCOPES,
        scopeSeparator: ",",
        pkce: false,
        clientAuth: "body",
        ...(this.clientId ? { clientId: this.clientId } : {}),
        ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
      },
      (i, init) => resolveFetch(this.fetchImpl)(i, init),
      this.now,
    );
  }

  get connectConfigured(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: true, video: true, kinds: ["post", "carousel", "link", "video"] };
  }

  // ---- connect -------------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    this.requireApp("oauth");
    const short = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const long = await this.token("/access_token", { grant_type: "th_exchange_token", client_secret: this.clientSecret!, access_token: short.accessToken }, "long-lived token exchange");
    const me = await this.describeAccount({ accessToken: long.accessToken, userId: String(short.raw.user_id ?? "me") });
    const auth: ThreadsAuth = { accessToken: long.accessToken, userId: me.externalId, ...long.expiry };
    return [{ network: "threads", identity: me, auth }];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof raw.accessToken === "string" ? raw.accessToken : null;
    if (!token) throw new ConnectorError("threads: accessToken is required", "auth", false);
    const me = await this.api<{ id: string; username?: string; name?: string }>("GET", "/me", token, { query: { fields: "id,username,name" }, what: "me" });
    return { externalId: me.id, handle: me.username ?? me.id, displayName: me.name ?? null };
  }

  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    const next = await this.token("/refresh_access_token", { grant_type: "th_refresh_token", access_token: auth.accessToken }, "token refresh");
    return { auth: { accessToken: next.accessToken, userId: auth.userId, ...next.expiry } satisfies ThreadsAuth };
  }

  private async token(path: string, query: Record<string, string>, what: string): Promise<{ accessToken: string; expiry: { expiresAt?: string; tokenExpiresAt?: string } }> {
    const res = await this.api<{ access_token?: string; expires_in?: number }>("GET", path, null, { query, what, unversioned: true });
    if (!res.access_token) throw new ConnectorError(`threads ${what}: no access_token in response`, "auth", false, res);
    const expiry: { expiresAt?: string; tokenExpiresAt?: string } = {};
    if (typeof res.expires_in === "number") {
      const exp = this.now().getTime() + res.expires_in * 1000;
      expiry.tokenExpiresAt = new Date(exp).toISOString();
      expiry.expiresAt = new Date(Math.max(this.now().getTime() + 24 * 3_600_000, exp - REFRESH_LEAD_MS)).toISOString();
    }
    return { accessToken: res.access_token, expiry };
  }

  // ---- validate & publish --------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    return validateThreads(input);
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    const auth = parseAuth(account);
    return this.idempotency.run(input.idempotencyKey, () => this.publishSegments(account, auth, input));
  }

  private async publishSegments(account: AccountRef, auth: ThreadsAuth, input: PublishInput): Promise<PublishResult> {
    const issues = validateThreads(input);
    if (issues.length) throw new ConnectorError(`threads: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
    const key = input.idempotencyKey;
    const state: Progress = this.progress.get(key) ?? { posted: [] };
    this.progress.set(key, state);
    const segments = [input.text, ...input.thread];
    try {
      if (state.posted.length === 0) await this.checkPublishingLimit(auth);
      for (let i = state.posted.length; i < segments.length; i++) {
        const replyTo = state.posted[state.posted.length - 1] ?? input.replyToExternalId ?? undefined;
        if (!state.container) state.container = await this.createContainer(auth, i === 0 ? input : null, segments[i] ?? "", replyTo, state);
        await this.waitForContainer(auth, state.container, () => {
          state.container = undefined;
          state.children = undefined;
        });
        const pub = await this.api<{ id: string }>("POST", `/${auth.userId}/threads_publish`, auth.accessToken, { form: { creation_id: state.container }, what: "threads_publish", creating: true });
        state.posted.push(pub.id);
        state.container = undefined;
        state.children = undefined;
      }
    } catch (err) {
      const root = state.posted[0];
      if (root) {
        const ce = err instanceof ConnectorError ? err : new ConnectorError(err instanceof Error ? err.message : String(err), "unknown", true, err);
        ce.partial = { externalId: root, url: null, threadExternalIds: [...state.posted] };
        throw ce;
      }
      throw err;
    }
    const root = state.posted[0]!;
    this.progress.delete(key);
    const permalink = await this.api<{ permalink?: string }>("GET", `/${root}`, auth.accessToken, { query: { fields: "permalink" }, what: "permalink" }).then((r) => r.permalink ?? null, () => null);
    return { externalId: root, url: permalink, ...(input.thread.length > 0 ? { threadExternalIds: [...state.posted] } : {}), raw: { ids: state.posted } };
  }

  /** One container for a segment: TEXT (optionally with link_attachment), IMAGE, VIDEO or CAROUSEL (children first). */
  private async createContainer(auth: ThreadsAuth, root: PublishInput | null, text: string, replyTo: string | undefined, state: Progress): Promise<string> {
    const form: Record<string, string> = { text };
    if (replyTo) form.reply_to_id = replyTo;
    const media = root?.media ?? [];
    if (media.length === 0) {
      form.media_type = "TEXT";
      if (root?.options?.link) form.link_attachment = root.options.link;
    } else if (media.length === 1) {
      const m = media[0]!;
      form.media_type = m.kind === "video" ? "VIDEO" : "IMAGE";
      form[m.kind === "video" ? "video_url" : "image_url"] = m.url;
      if (m.alt) form.alt_text = m.alt; // TODO(verify): alt_text param name for Threads media containers
    } else {
      if (!state.children) {
        const children: string[] = [];
        for (const m of media) {
          const c = await this.api<{ id: string }>("POST", `/${auth.userId}/threads`, auth.accessToken, {
            form: { media_type: m.kind === "video" ? "VIDEO" : "IMAGE", [m.kind === "video" ? "video_url" : "image_url"]: m.url, is_carousel_item: "true", ...(m.alt ? { alt_text: m.alt } : {}) },
            what: "carousel item",
            creating: true,
          });
          children.push(c.id);
        }
        state.children = children;
      }
      for (const c of state.children) await this.waitForContainer(auth, c, () => (state.children = undefined));
      form.media_type = "CAROUSEL";
      form.children = state.children.join(",");
    }
    const c = await this.api<{ id: string }>("POST", `/${auth.userId}/threads`, auth.accessToken, { form, what: "container", creating: true });
    return c.id;
  }

  private async waitForContainer(auth: ThreadsAuth, id: string, discard: () => void): Promise<void> {
    for (let i = 0; i < this.maxPolls; i++) {
      const s = await this.api<{ status?: string; error_message?: string }>("GET", `/${id}`, auth.accessToken, { query: { fields: "status,error_message" }, what: "container status" });
      if (s.status === "FINISHED" || s.status === "PUBLISHED" || s.status === undefined) return;
      if (s.status === "ERROR") {
        discard();
        throw new ConnectorError(`threads container ${id} failed: ${s.error_message ?? "ERROR"}`, "rejected", false, s);
      }
      if (s.status === "EXPIRED") {
        discard();
        throw new ConnectorError(`threads container ${id} expired; retry to create a new one`, "network", true, s);
      }
      if (i < this.maxPolls - 1) await this.sleep(this.pollIntervalMs);
    }
    throw new ConnectorError(`threads container ${id} is still processing after ${this.maxPolls} checks; retry later to publish it`, "network", true, { containerId: id });
  }

  /** 250 posts / 24 h (carousels count once); advisory, threads_publish enforces it anyway. */
  private async checkPublishingLimit(auth: ThreadsAuth): Promise<void> {
    let res: { data?: { quota_usage?: number; config?: { quota_total?: number } }[] };
    try {
      res = await this.api("GET", `/${auth.userId}/threads_publishing_limit`, auth.accessToken, { query: { fields: "quota_usage,config" }, what: "threads_publishing_limit" });
    } catch (err) {
      if (err instanceof ConnectorError && (err.kind === "auth" || err.kind === "rate_limit")) throw err;
      return;
    }
    const row = res.data?.[0];
    const total = row?.config?.quota_total;
    if (row && typeof total === "number" && typeof row.quota_usage === "number" && row.quota_usage >= total) {
      throw new ConnectorError(`threads: publishing limit reached (${row.quota_usage}/${total} in 24h)`, "rate_limit", true, res);
    }
  }

  // ---- inbox ---------------------------------------------------------------------------------

  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const now = this.now();
    const out: ActivityInput[] = [];
    const posts = await this.api<{ data?: ThreadsPost[] }>("GET", `/${auth.userId}/threads`, auth.accessToken, {
      query: { fields: "id,text,timestamp,permalink,username,media_type", limit: this.maxActivityPosts },
      what: "threads",
    });
    for (const p of posts.data ?? []) {
      const at = graphTime(p.timestamp, now);
      if (isAfter(at, since)) out.push({ network: "threads", kind: "own_post", externalId: p.id, authorHandle: p.username ?? account.handle, authorName: null, text: p.text ?? null, url: p.permalink ?? null, parentExternalId: null, occurredAt: at, raw: p });
      if (p.media_type === "REPOST_FACADE") continue;
      const convo = await this.api<{ data?: ThreadsPost[] }>("GET", `/${p.id}/conversation`, auth.accessToken, {
        query: { fields: "id,text,timestamp,permalink,username,is_reply,replied_to,root_post,hide_status", reverse: "false" },
        what: "conversation",
      });
      for (const r of convo.data ?? []) {
        if (r.username && r.username === account.handle) continue;
        const rat = graphTime(r.timestamp, now);
        if (!isAfter(rat, since)) continue;
        out.push({ network: "threads", kind: "reply", externalId: r.id, authorHandle: r.username ?? null, authorName: null, text: r.text ?? null, url: r.permalink ?? null, parentExternalId: r.replied_to?.id ?? p.id, occurredAt: rat, raw: r });
      }
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.publish(account, { variantId: `reply:${input.idempotencyKey}`, text: input.text, media: [], thread: [], replyToExternalId: input.parentExternalId, idempotencyKey: `reply:${input.idempotencyKey}` });
  }

  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    if (input.action === "hide" || input.action === "unhide") {
      await this.api("POST", `/${input.externalId}/manage_reply`, auth.accessToken, { form: { hide: String(input.action === "hide") }, what: `${input.action} reply` });
      return;
    }
    if (input.action === "delete") {
      // Deletes only the account's own posts/replies (threads_delete); other people's replies can only be hidden.
      await this.api("DELETE", `/${input.externalId}`, auth.accessToken, { what: "delete" });
      return;
    }
    throw new ConnectorError("threads: the API cannot like posts", "rejected", false);
  }

  // ---- metrics -------------------------------------------------------------------------------

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      const ins = await this.tolerantInsights(`/${id}/insights`, auth.accessToken, POST_METRICS, "post", {});
      const add = (metric: MetricName, v: number | undefined) => {
        if (typeof v === "number") out.push({ entityType: "post_variant", entityId: id, metric, value: v, observedAt, source: "threads" });
      };
      add("impressions", ins.get("views"));
      add("likes", ins.get("likes"));
      add("replies", ins.get("replies"));
      add("reposts", ins.get("reposts"));
      add("quotes", ins.get("quotes"));
      add("shares", ins.get("shares"));
      const parts = ["likes", "replies", "reposts", "quotes"].map((k) => ins.get(k));
      if (parts.some((p) => p !== undefined)) add("engagements", parts.reduce<number>((s, p) => s + (p ?? 0), 0));
    }
    return out;
  }

  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const until = Math.floor(this.now().getTime() / 1000);
    const ins = await this.tolerantInsights(`/${auth.userId}/threads_insights`, auth.accessToken, USER_METRICS, "user", { since: String(until - 86400), until: String(until) });
    const out: MetricInput[] = [];
    const add = (metric: MetricName, v: number | undefined) => {
      if (typeof v === "number") out.push({ entityType: "social_account", entityId: account.id, metric, value: v, observedAt, source: "threads" });
    };
    add("followers_total", ins.get("followers_count"));
    add("impressions", ins.get("views"));
    add("link_clicks", ins.get("clicks"));
    const parts = ["likes", "replies", "reposts", "quotes"].map((k) => ins.get(k));
    if (parts.some((p) => p !== undefined)) add("engagements", parts.reduce<number>((s, p) => s + (p ?? 0), 0));
    return out;
  }

  /** Same metric-churn fallback as the Meta connector; time-series rows are summed, total_value rows taken as is. */
  private async tolerantInsights(path: string, token: string, metrics: string[], kind: string, extra: Record<string, string>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const collect = (res: { data?: InsightRow[] }) => {
      for (const row of res.data ?? []) {
        if (row.total_value) {
          const v = insightValue(row);
          if (typeof v === "number") out.set(row.name, v);
        } else if (row.values?.length) {
          // clicks come back as [{ link_url, value }] in total_value; values[] is a daily series.
          out.set(row.name, row.values.reduce((s, x) => s + (typeof x.value === "number" ? x.value : 0), 0));
        }
      }
    };
    const wanted = metrics.filter((m) => !this.invalidMetrics.has(`${kind}:${m}`));
    if (wanted.length === 0) return out;
    try {
      collect(await this.api<{ data?: InsightRow[] }>("GET", path, token, { query: { metric: wanted.join(","), ...extra }, what: "insights" }));
      return out;
    } catch (err) {
      if (!(err instanceof ConnectorError) || err.kind !== "rejected") throw err;
    }
    for (const m of wanted) {
      try {
        collect(await this.api<{ data?: InsightRow[] }>("GET", path, token, { query: { metric: m, ...extra }, what: `insights ${m}` }));
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.kind !== "rejected") throw err;
        this.invalidMetrics.add(`${kind}:${m}`);
      }
    }
    return out;
  }

  // ---- webhooks ------------------------------------------------------------------------------

  readonly webhook: WebhookHandler = {
    challenge: (query) => hubChallenge(query, this.verifyToken),
    verify: (headers, rawBody) => verifyHubSignature(this.clientSecret, headers, rawBody),
    parse: (body) => parseThreadsWebhook(body, this.now()),
  };

  // ---- transport -----------------------------------------------------------------------------

  private requireApp(what: string): void {
    if (!this.clientId || !this.clientSecret) throw new ConnectorError(`threads ${what}: THREADS_CLIENT_ID and THREADS_CLIENT_SECRET must be configured`, "auth", false);
  }

  private async api<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    token: string | null,
    opts: { query?: Record<string, string | number | undefined>; form?: Record<string, string>; what?: string; creating?: boolean; unversioned?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.base}${opts.unversioned ? "" : `/${this.version}`}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    // Threads documents the token as the access_token parameter.
    if (token) url.searchParams.set("access_token", token);
    const headers: Record<string, string> = { accept: "application/json" };
    let body: string | undefined;
    if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    }
    const what = opts.what ?? `${method} ${path}`;
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw asNetworkError(err, `threads ${what}`);
    }
    const data = await readJson(res);
    if (!res.ok || (data && typeof data === "object" && "error" in data)) throw mapGraphError("threads", what, res.ok ? 400 : res.status, res.headers, data);
    return data as T;
  }
}

function validateThreads(input: PublishInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kind = input.options?.kind ?? "post";
  const media = input.media;
  if (!["post", "carousel", "link", "video"].includes(kind)) issues.push({ code: "unsupported_media", message: `threads connector does not publish kind "${kind}"` });
  for (const m of media) {
    if (m.kind === "document" || m.kind === "gif") issues.push({ code: "unsupported_media", message: `threads does not accept ${m.kind} uploads` });
    if (m.kind === "image" && m.mime && !/^image\/(jpe?g|png)$/i.test(m.mime)) issues.push({ code: "unsupported_media", message: `threads images must be JPEG or PNG (got ${m.mime})` });
  }
  if (media.length > 20) issues.push({ code: "too_many_media", message: "a threads carousel takes at most 20 items" });
  if (kind === "carousel" && media.length < 2) issues.push({ code: "media_required", message: "a threads carousel needs 2-20 items" });
  if (kind === "video" && (media.length !== 1 || media[0]?.kind !== "video")) issues.push({ code: "media_required", message: "a threads video post needs exactly one video" });
  if (input.options?.link && media.length > 0) issues.push({ code: "unsupported_media", message: "threads link previews (link_attachment) only work on text-only posts; put the link in the text instead" });
  return issues;
}

interface ThreadsWebhookValue {
  id?: string;
  username?: string;
  text?: string;
  permalink?: string;
  timestamp?: string;
  replied_to?: { id?: string };
  root_post?: { id?: string; owner_id?: string; username?: string };
}

/**
 * Threads webhook deliveries: { app_id, topic, target_id, time, values: [{ field: "replies"|"mentions", value: {...} }] }.
 * TODO(verify): routing by target_id (the subscribed Threads user) with root_post.owner_id as fallback, and the
 * exact envelope; Meta's sample payloads were not reachable from this sandbox.
 */
export function parseThreadsWebhook(body: unknown, now: Date): WebhookBatch[] {
  const b = (body ?? {}) as { target_id?: unknown; time?: unknown; values?: unknown; entry?: unknown };
  const deliveries: { target?: string; time?: unknown; field?: string; value: ThreadsWebhookValue }[] = [];
  const asList = (v: unknown) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);
  for (const v of asList(b.values) as { field?: string; value?: ThreadsWebhookValue }[]) {
    deliveries.push({ ...(b.target_id !== undefined ? { target: String(b.target_id) } : {}), time: b.time, ...(v.field ? { field: v.field } : {}), value: v.value ?? {} });
  }
  // Graph-style envelope fallback: entry[].changes[].
  for (const e of asList(b.entry) as { id?: unknown; time?: unknown; changes?: { field?: string; value?: ThreadsWebhookValue }[] }[]) {
    for (const c of e.changes ?? []) deliveries.push({ ...(e.id !== undefined ? { target: String(e.id) } : {}), time: e.time, ...(c.field ? { field: c.field } : {}), value: c.value ?? {} });
  }
  const byAccount = new Map<string, ActivityInput[]>();
  for (const d of deliveries) {
    const v = d.value;
    if (!v.id || (d.field !== "replies" && d.field !== "mentions")) continue;
    const account = d.target ?? v.root_post?.owner_id;
    if (!account) continue;
    const item: ActivityInput = {
      network: "threads",
      kind: d.field === "mentions" ? "mention" : "reply",
      externalId: v.id,
      authorHandle: v.username ?? null,
      authorName: null,
      text: v.text ?? null,
      url: v.permalink ?? null,
      parentExternalId: v.replied_to?.id ?? v.root_post?.id ?? null,
      occurredAt: v.timestamp ? graphTime(v.timestamp, now) : graphTime(d.time, now),
      raw: { field: d.field, value: v },
    };
    const list = byAccount.get(account) ?? [];
    list.push(item);
    byAccount.set(account, list);
  }
  return [...byAccount].map(([accountExternalId, items]) => ({ network: "threads" as const, accountExternalId, items }));
}

function parseAuth(account: AccountRef): ThreadsAuth {
  const parsed = ThreadsAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`threads account ${account.handle}: auth blob needs accessToken and userId`, "auth", false, parsed.error);
  return parsed.data;
}

export function createThreadsConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "THREADS");
  return [
    new ThreadsConnector({
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(env.THREADS_WEBHOOK_VERIFY_TOKEN ? { webhookVerifyToken: env.THREADS_WEBHOOK_VERIFY_TOKEN } : {}),
      ...(env.THREADS_API_BASE_URL ? { baseUrl: env.THREADS_API_BASE_URL } : {}),
    }),
  ];
}
