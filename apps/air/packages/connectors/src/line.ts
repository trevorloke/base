import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ActivityInput, ActivityKind, MetricInput, Network } from "@base-air/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * LINE Official Accounts through the official LINE Messaging API (https://api.line.me). One account = one
 * Messaging API channel (= one bot user). A person pastes the channel's long-lived channel access token and
 * channel secret; there is no OAuth for bots.
 *
 * Inbox is webhook-only: LINE pushes events to `${BASE_AIR_PUBLIC_URL}/webhooks/line`, each delivery signed with
 * that channel's own secret (x-line-signature = base64 HMAC-SHA256 of the raw body) and naming the bot in
 * `destination`. So the handler uses `route` + `verifyAccount` (per-account secret), never `verify`.
 *
 * External ids are "<conversation id>:<message id>" where the conversation id is the group id (C...), room id
 * (R...) or, for 1:1 chats, the user id (U...). `reply` pushes to the conversation before the colon.
 *
 * Shapes follow LINE's official OpenAPI definitions (github.com/line/line-openapi: messaging-api.yml, webhook.yml,
 * insight.yml), read November 2026.
 */

export const LineAuth = z.object({
  channelAccessToken: z.string().min(20, "not a channel access token"),
  channelSecret: z.string().min(16, "not a channel secret"),
});
export type LineAuth = z.infer<typeof LineAuth>;

export interface LineConnectorOptions {
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** BASE_AIR_PUBLIC_URL: used at connect to tell whether the channel's webhook URL points at Base Air. */
  publicUrl?: string;
  /** Upper bound of name lookups per resolveNames call. */
  maxNameLookups?: number;
}

// ---- webhook shapes (webhook.yml) -------------------------------------------------------

export interface LineSource {
  type: "user" | "group" | "room" | string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineMessageContent {
  id: string;
  type: "text" | "image" | "video" | "audio" | "file" | "location" | "sticker" | string;
  text?: string;
  quoteToken?: string;
  quotedMessageId?: string;
  markAsReadToken?: string;
  mention?: { mentionees: { type: string; index: number; length: number; userId?: string; isSelf?: boolean }[] };
  imageSet?: { id: string; index?: number; total?: number };
  duration?: number;
  fileName?: string;
  fileSize?: number;
  title?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  packageId?: string;
  stickerId?: string;
  keywords?: string[];
}

export interface LineEvent {
  type: string;
  timestamp: number;
  mode?: "active" | "standby" | string;
  webhookEventId?: string;
  deliveryContext?: { isRedelivery: boolean };
  source?: LineSource;
  replyToken?: string;
  message?: LineMessageContent;
  follow?: { isUnblocked: boolean };
  joined?: { members: LineSource[] };
}

export interface LineCallback {
  destination: string;
  events: LineEvent[];
}

/** Text, plus a single image message. LINE images: JPEG/PNG over HTTPS (TLS 1.2+), URL ≤ 2000 chars, original ≤ 10 MB, preview ≤ 1 MB. */
const LIMITS = { text: 5000, urlLength: 2000, imageBytes: 10_000_000, previewBytes: 1_000_000 } as const;
// TODO(verify): 10 MB / 1 MB / 2000 chars come from LINE's image-message reference as quoted by secondary sources;
// the official reference page was not reachable from the sandbox.

const CACHE_MAX = 5000;

// ---- pure helpers -----------------------------------------------------------------------

/** base64(HMAC-SHA256(channel secret, raw body)) compared in constant time with x-line-signature. */
export function lineSignatureValid(channelSecret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature || !channelSecret) return false;
  const want = createHmac("sha256", channelSecret).update(rawBody, "utf8").digest();
  let got: Buffer;
  try {
    got = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A stable UUID (RFC 4122 layout, version 5 bits) for X-Line-Retry-Key, derived from Base Air's idempotency key. */
export function lineRetryKey(idempotencyKey: string): string {
  // The "starsign" namespace predates the rename to Base Air and must stay: retries re-derive this key.
  const h = createHash("sha1").update(`starsign:line:${idempotencyKey}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** "yyyyMMdd" of the day before `now` in Asia/Tokyo (UTC+9, no DST), as the insight API expects. */
export function tokyoDate(now: Date, daysBack = 1): string {
  const d = new Date(now.getTime() + 9 * 3600_000 - daysBack * 86_400_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function clock(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  return ` ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function size(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes >= 1_000_000) return ` (${(bytes / 1_000_000).toFixed(1)} MB)`;
  if (bytes >= 1000) return ` (${Math.round(bytes / 1000)} KB)`;
  return ` (${bytes} B)`;
}

/** Text of a message, or a short summary for non-text messages (the content itself is not downloaded). */
export function lineMessageText(m: LineMessageContent): string {
  switch (m.type) {
    case "text":
      return m.text ?? "";
    case "sticker": {
      const kw = (m.keywords ?? []).slice(0, 3);
      return `[Sticker${kw.length ? `: ${kw.join(", ")}` : ""}]${m.text ? ` ${m.text}` : ""}`;
    }
    case "image":
      return m.imageSet?.total && m.imageSet.total > 1 ? `[Image ${m.imageSet.index ?? "?"}/${m.imageSet.total}]` : "[Image]";
    case "video":
      return `[Video${clock(m.duration)}]`;
    case "audio":
      return `[Audio${clock(m.duration)}]`;
    case "file":
      return `[File: ${m.fileName ?? "file"}${size(m.fileSize)}]`;
    case "location": {
      const place = [m.title, m.address].filter(Boolean).join(", ");
      return `[Location: ${place || `${m.latitude ?? "?"}, ${m.longitude ?? "?"}`}]`;
    }
    default:
      return `[${m.type}]`;
  }
}

/** Where an event happened: group/room → "group" conversation, user → "direct". */
export function lineConversation(source: LineSource | undefined): { id: string; type: "group" | "direct" } | null {
  if (!source) return null;
  if (source.type === "group" && source.groupId) return { id: source.groupId, type: "group" };
  if (source.type === "room" && source.roomId) return { id: source.roomId, type: "group" };
  if (source.type === "user" && source.userId) return { id: source.userId, type: "direct" };
  return null;
}

/** Lookups `parse` reads synchronously. All optional: without them names stay null and kinds skip "reply". */
export interface LineParseContext {
  groupName?(destination: string, conversationId: string): string | undefined;
  userName?(destination: string, userId: string): string | undefined;
  /** True when "<conversation>:<message id>" is a message this bot sent (so quoting it is a "reply"). */
  isOwnMessage?(externalId: string): boolean;
}

/**
 * One webhook event → activities. Message events become message / dm / mention / reply; join, memberJoined and
 * follow become "follow"; unsend, leave, postback, messageEdited and the rest are ignored.
 */
export function lineEventToActivities(destination: string, e: LineEvent, ctx: LineParseContext = {}): ActivityInput[] {
  const conv = lineConversation(e.source);
  if (!conv) return [];
  const occurredAt = new Date(Number.isFinite(e.timestamp) ? e.timestamp : 0).toISOString();
  const convName = conv.type === "group" ? (ctx.groupName?.(destination, conv.id) ?? null) : null;
  const nameOf = (userId: string | undefined) => (userId ? (ctx.userName?.(destination, userId) ?? null) : null);
  const conversation = (author: string | null) => ({ id: conv.id, name: conv.type === "direct" ? author : convName, type: conv.type });
  const eventKey = e.webhookEventId ?? String(e.timestamp);

  if (e.type === "message" && e.message) {
    const m = e.message;
    const userId = e.source?.userId;
    const authorName = nameOf(userId);
    const parentExternalId = m.quotedMessageId ? `${conv.id}:${m.quotedMessageId}` : null;
    let kind: ActivityKind = conv.type === "direct" ? "dm" : "message";
    if (parentExternalId && ctx.isOwnMessage?.(parentExternalId)) kind = "reply";
    if (m.mention?.mentionees.some((x) => x.isSelf === true)) kind = "mention";
    return [{ network: "line", kind, externalId: `${conv.id}:${m.id}`, authorHandle: userId ?? null, authorName, text: lineMessageText(m), url: null, parentExternalId, occurredAt, raw: e, conversation: conversation(authorName) }];
  }
  if (e.type === "join") {
    return [{ network: "line", kind: "follow", externalId: `${conv.id}:join:${eventKey}`, authorHandle: null, authorName: null, text: conv.type === "group" ? "[The account was added to this chat]" : "[Joined]", url: null, parentExternalId: null, occurredAt, raw: e, conversation: conversation(null) }];
  }
  if (e.type === "memberJoined") {
    return (e.joined?.members ?? [])
      .filter((u) => u.userId)
      .map((u) => {
        const authorName = nameOf(u.userId);
        return { network: "line" as const, kind: "follow" as const, externalId: `${conv.id}:memberJoined:${eventKey}:${u.userId}`, authorHandle: u.userId ?? null, authorName, text: "[Joined the chat]", url: null, parentExternalId: null, occurredAt, raw: e, conversation: conversation(null) };
      });
  }
  if (e.type === "follow") {
    const authorName = nameOf(e.source?.userId);
    return [{ network: "line", kind: "follow", externalId: `${conv.id}:follow:${eventKey}`, authorHandle: e.source?.userId ?? null, authorName, text: e.follow?.isUnblocked ? "[Unblocked the account]" : "[Added the account as a friend]", url: null, parentExternalId: null, occurredAt, raw: e, conversation: conversation(authorName) }];
  }
  return [];
}

// ---- errors -----------------------------------------------------------------------------

interface LineFailure {
  status: number;
  message?: string;
  details?: { message?: string; property?: string }[];
  requestId?: string;
}

/** Messaging API error → ConnectorError. Never includes the token (it only travels in the Authorization header). */
export function mapLineError(status: number, body: unknown, op: string, headers?: Headers): ConnectorError {
  const b = (body && typeof body === "object" ? body : {}) as { message?: string; details?: { message?: string; property?: string }[] };
  const message = b.message ?? (typeof body === "string" && body.length < 300 ? body : `HTTP ${status}`);
  const details = (b.details ?? []).map((d) => [d.property, d.message].filter(Boolean).join(": ")).filter(Boolean);
  const requestId = headers?.get("x-line-request-id") ?? undefined;
  const cause: LineFailure = { status, message, ...(b.details ? { details: b.details } : {}), ...(requestId ? { requestId } : {}) };
  const msg = `line ${op}: ${message}${details.length ? ` (${details.join("; ")})` : ""}`;
  if (status === 401) return new ConnectorError(`${msg} (channel access token rejected; reissue it in the LINE Developers console)`, "auth", false, cause);
  if (status === 429) {
    // The free/plan message quota and the rate limit share 429. Only the rate limit clears by waiting.
    // TODO(verify): exact wording "You have reached your monthly limit." (seen via search results, not fetched).
    if (/monthly limit/i.test(message)) return new ConnectorError(`line ${op}: the LINE Official Account has used its monthly message allowance; upgrade the plan or wait until next month`, "rejected", false, cause);
    const retryAfter = headers?.get("retry-after");
    return new ConnectorError(`${msg} (rate limited${retryAfter ? `; retry after ${retryAfter}s` : ""})`, "rate_limit", true, cause);
  }
  // 403 here means "this channel may not use this endpoint" (plan or feature), not a bad token.
  if (status === 403) return new ConnectorError(`${msg} (this channel is not allowed to use this API)`, "rejected", false, cause);
  if (status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (status >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

// ---- connector --------------------------------------------------------------------------

export interface LineAccountConfig {
  botUserId: string;
  basicId: string;
  premiumId: string | null;
  displayName: string | null;
  pictureUrl: string | null;
  chatMode: string | null;
  /** Webhook URL set on the channel at connect time, whether "Use webhook" is on, and whether it points at Base Air. */
  webhookEndpoint: string | null;
  webhookActive: boolean | null;
  webhookPointsHere: boolean | null;
  /** When set, publish pushes to this group/room id instead of broadcasting to all friends. */
  defaultGroupId?: string;
}

interface SendResponse {
  sentMessages?: { id: string; quoteToken?: string }[];
}

interface Raw {
  status: number;
  body: unknown;
  headers: Headers;
}

/** A Map that drops its oldest entries past a cap (insertion order). */
class Bounded<K, V> extends Map<K, V> {
  constructor(private readonly cap = CACHE_MAX) {
    super();
  }
  override set(k: K, v: V): this {
    if (!this.has(k) && this.size >= this.cap) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(k, v);
  }
}

export class LineConnector implements Connector {
  readonly name = "line";
  readonly networks: readonly Network[] = ["line"];
  readonly connectMethod = "bot_token" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "channelAccessToken", label: "Channel access token (long-lived, Messaging API tab)", placeholder: "eyJhbGciOi... or a long base64 string", secret: true },
    { key: "channelSecret", label: "Channel secret (Basic settings tab)", placeholder: "32 hex characters", secret: true },
  ] as const;
  media?: MediaFetcher;
  readonly webhook: WebhookHandler;

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly publicUrl: string | undefined;
  private readonly maxNameLookups: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** "<destination>|<group or room id>" → group name. */
  private readonly groupNames = new Bounded<string, string>();
  /** "<destination>|<user id>" → display name. */
  private readonly userNames = new Bounded<string, string>();
  /** destination → lookups parse wanted but could not do ("g|<groupId>", "u|<conversation id>|<userId>"). */
  private readonly pendingNames = new Map<string, Set<string>>();
  /** "<conversation>:<message id>" → quote token from the webhook (so reply can quote the message). */
  private readonly quoteTokens = new Bounded<string, string>();
  /** "<conversation>:<message id>" of messages this process pushed (quoting one of them is a "reply"). */
  private readonly ownMessages = new Bounded<string, true>();

  constructor(opts: LineConnectorOptions = {}) {
    this.apiBase = (opts.apiBase ?? "https://api.line.me").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.maxNameLookups = opts.maxNameLookups ?? 20;
    this.webhook = {
      // Never used: every LINE channel signs with its own secret, so route + verifyAccount take over.
      verify: () => false,
      route: (rawBody) => {
        if (!rawBody) return null;
        try {
          const d = (JSON.parse(rawBody) as { destination?: unknown }).destination;
          return typeof d === "string" && d ? { network: "line", accountExternalId: d } : null;
        } catch {
          return null;
        }
      },
      verifyAccount: (account, headers, rawBody) => this.verifyAccountSignature(account, headers, rawBody),
      parse: (body) => this.parseCallback(body),
    };
  }

  capabilities(): ConnectorCapabilities {
    // Webhook-only inbox; no per-message metrics through the Messaging API; no moderation of users' messages.
    return { publish: true, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: true, moderate: false, accountMetrics: true, webhooks: true, video: false, kinds: ["post"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const parsed = LineAuth.safeParse({ channelAccessToken: (p.inputs.channelAccessToken ?? "").trim(), channelSecret: (p.inputs.channelSecret ?? "").trim() });
    if (!parsed.success) throw new ConnectorError("line: paste both the channel access token and the channel secret from the LINE Developers console", "auth", false);
    const auth = parsed.data;
    const info = await this.botInfo(auth.channelAccessToken);
    let webhookEndpoint: string | null = null;
    let webhookActive: boolean | null = null;
    try {
      const w = await this.json<{ endpoint?: string; active?: boolean }>(auth.channelAccessToken, "GET", "/v2/bot/channel/webhook/endpoint", "webhook endpoint");
      webhookEndpoint = w.endpoint ?? null;
      webhookActive = typeof w.active === "boolean" ? w.active : null;
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === "auth") throw err;
      // Informational only: a channel without a webhook URL answers 404.
    }
    const want = this.publicUrl ? `${this.publicUrl}/webhooks/line` : null;
    const config: LineAccountConfig = {
      botUserId: info.userId,
      basicId: info.basicId,
      premiumId: info.premiumId ?? null,
      displayName: info.displayName ?? null,
      pictureUrl: info.pictureUrl ?? null,
      chatMode: info.chatMode ?? null,
      webhookEndpoint,
      webhookActive,
      webhookPointsHere: want && webhookEndpoint ? webhookEndpoint.replace(/\/+$/, "") === want : null,
    };
    const identity: AccountIdentity = { externalId: info.userId, handle: info.basicId, displayName: info.displayName ?? null };
    return [{ network: "line", identity, auth: { channelAccessToken: auth.channelAccessToken, channelSecret: auth.channelSecret }, config: { ...config } }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.channelAccessToken === "string" ? auth.channelAccessToken : "";
    if (!token) throw new ConnectorError("line: channelAccessToken is required", "auth", false);
    const info = await this.botInfo(token);
    return { externalId: info.userId, handle: info.basicId, displayName: info.displayName ?? null };
  }

  private botInfo(token: string) {
    return this.json<{ userId: string; basicId: string; premiumId?: string; displayName?: string; pictureUrl?: string; chatMode?: string; markAsReadMode?: string }>(token, "GET", "/v2/bot/info", "bot info");
  }

  // ---- webhooks -------------------------------------------------------------------------

  private verifyAccountSignature(account: AccountRef, headers: Record<string, string>, rawBody: string): boolean {
    const secret = typeof account.auth?.channelSecret === "string" ? account.auth.channelSecret : "";
    const sig = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-line-signature")?.[1];
    return lineSignatureValid(secret, rawBody, sig);
  }

  private parseCallback(body: unknown): WebhookBatch[] {
    const b = body as Partial<LineCallback> | null;
    if (!b || typeof b !== "object" || typeof b.destination !== "string" || !Array.isArray(b.events)) return [];
    const destination = b.destination;
    const items: ActivityInput[] = [];
    for (const e of b.events) {
      if (!e || typeof e !== "object") continue;
      const out = lineEventToActivities(destination, e, {
        groupName: (d, id) => this.groupNames.get(`${d}|${id}`),
        userName: (d, id) => this.userNames.get(`${d}|${id}`),
        isOwnMessage: (id) => this.ownMessages.has(id),
      });
      for (const item of out) {
        items.push(item);
        this.remember(destination, e, item);
      }
    }
    // An empty events array is LINE's "Verify" button; it still verified, there is just nothing to ingest.
    return items.length ? [{ network: "line", accountExternalId: destination, items }] : [];
  }

  /** Network-free bookkeeping: quote tokens for reply, and names to look up later in resolveNames. */
  private remember(destination: string, e: LineEvent, item: ActivityInput): void {
    if (e.type === "message" && e.message?.quoteToken) this.quoteTokens.set(item.externalId, e.message.quoteToken);
    const conv = item.conversation;
    if (!conv) return;
    const pending = this.pendingNames.get(destination) ?? new Set<string>();
    if (conv.type === "group" && e.source?.type === "group" && !this.groupNames.has(`${destination}|${conv.id}`)) pending.add(`g|${conv.id}`);
    if (item.authorHandle && !this.userNames.has(`${destination}|${item.authorHandle}`)) pending.add(`u|${conv.id}|${item.authorHandle}`);
    if (pending.size > 500) pending.clear(); // never let an unattended backlog grow
    if (pending.size) this.pendingNames.set(destination, pending);
  }

  /**
   * Look up the group names and display names that webhook items arrived without, and cache them so later
   * deliveries carry them. `parse` must stay synchronous and network-free, so names are null on the first message
   * from a person or group and filled from then on, once this has run for the account. Bounded per call; lookup
   * failures (user not a friend, bot no longer in the group) just leave the name null.
   */
  async resolveNames(account: AccountRef): Promise<number> {
    const pending = this.pendingNames.get(account.externalId);
    if (!pending?.size) return 0;
    const token = parseAuth(account).channelAccessToken;
    const d = account.externalId;
    let resolved = 0;
    for (const key of [...pending].slice(0, this.maxNameLookups)) {
      pending.delete(key);
      const [kind, convId, userId] = key.split("|");
      if (!convId) continue;
      try {
        if (kind === "g") {
          const g = await this.json<{ groupName?: string }>(token, "GET", `/v2/bot/group/${encodeURIComponent(convId)}/summary`, "group summary");
          if (g.groupName) this.groupNames.set(`${d}|${convId}`, g.groupName);
          resolved++;
        } else if (kind === "u" && userId) {
          const path = convId.startsWith("C") ? `/v2/bot/group/${encodeURIComponent(convId)}/member/${encodeURIComponent(userId)}` : convId.startsWith("R") ? `/v2/bot/room/${encodeURIComponent(convId)}/member/${encodeURIComponent(userId)}` : `/v2/bot/profile/${encodeURIComponent(userId)}`;
          const u = await this.json<{ displayName?: string }>(token, "GET", path, "profile");
          if (u.displayName) this.userNames.set(`${d}|${userId}`, u.displayName);
          resolved++;
        }
      } catch (err) {
        if (err instanceof ConnectorError && (err.kind === "auth" || err.kind === "rate_limit")) break;
      }
    }
    return resolved;
  }

  /** Cached names, for callers that want them without a network call. */
  cachedName(accountExternalId: string, id: string): string | null {
    return this.groupNames.get(`${accountExternalId}|${id}`) ?? this.userNames.get(`${accountExternalId}|${id}`) ?? null;
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const text = this.textOf(input);
    if (!text.trim() && input.media.length === 0) issues.push({ code: "empty", message: "line messages need text or an image" });
    if ([...text].length > LIMITS.text) issues.push({ code: "too_long", message: `line text messages are at most ${LIMITS.text} characters` });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "line has no threads; send one message" });
    if (input.media.length > 1) issues.push({ code: "too_many_media", message: "the line connector sends text plus one image" });
    const m = input.media[0];
    if (m) {
      if (m.kind !== "image") issues.push({ code: "unsupported_media", message: "line: only JPEG or PNG images are supported by this connector" });
      else if (m.mime && !/^image\/(jpeg|jpg|png)$/i.test(m.mime)) issues.push({ code: "unsupported_media", message: `line images must be JPEG or PNG (got ${m.mime})` });
      if (!/^https:\/\//i.test(m.url)) issues.push({ code: "unsupported_media", message: "line fetches images itself: the image URL must be public HTTPS" });
      if (m.url.length > LIMITS.urlLength) issues.push({ code: "unsupported_media", message: `line image URLs are at most ${LIMITS.urlLength} characters` });
      if (m.bytes !== undefined && m.bytes > LIMITS.imageBytes) issues.push({ code: "unsupported_media", message: "line images are at most 10 MB" });
      const thumb = input.options?.thumbnailUrl;
      if (thumb && !/^https:\/\//i.test(thumb)) issues.push({ code: "unsupported_media", message: "line preview images must be public HTTPS URLs" });
      if (!thumb && m.bytes !== undefined && m.bytes > LIMITS.previewBytes) issues.push({ code: "unsupported_media", message: "line preview images are at most 1 MB: set a smaller thumbnail (options.thumbnailUrl) for this image" });
    }
    return issues;
  }

  /**
   * Broadcast to every friend of the account, or push to `config.defaultGroupId` when set. Both count against the
   * monthly message allowance (broadcast: once per friend). X-Line-Retry-Key makes retries safe server-side for 24h.
   * TODO(verify): retry-key lifetime of 24 hours (Japanese retry guide, via search) and per-member counting of group pushes.
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    if (input.replyToExternalId) return this.reply(account, { parentExternalId: input.replyToExternalId, text: input.text, idempotencyKey: input.idempotencyKey });
    return this.idempotency.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`line publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const token = parseAuth(account).channelAccessToken;
      const messages: Record<string, unknown>[] = [];
      const text = this.textOf(input);
      if (text.trim()) messages.push({ type: "text", text });
      const img = input.media[0];
      if (img) messages.push({ type: "image", originalContentUrl: img.url, previewImageUrl: input.options?.thumbnailUrl ?? img.url });
      const retryKey = lineRetryKey(input.idempotencyKey);
      const group = defaultGroupOf(account);
      if (group) {
        const r = await this.send(token, "/v2/bot/message/push", { to: group, messages }, retryKey, "push");
        return this.sentResult(group, r, retryKey);
      }
      const r = await this.send(token, "/v2/bot/message/broadcast", { messages }, retryKey, "broadcast");
      // Broadcast returns {} and no message ids; the request id is what LINE's insight API keys broadcasts by.
      const requestId = r.headers.get(r.status === 409 ? "x-line-accepted-request-id" : "x-line-request-id") ?? retryKey;
      return { externalId: `broadcast:${requestId}`, url: null, raw: { requestId, retryKey, ...(r.status === 409 ? { alreadyAccepted: true } : {}) } };
    });
  }

  private textOf(input: PublishInput): string {
    const link = input.options?.link;
    return link && !input.text.includes(link) ? `${input.text}${input.text ? "\n\n" : ""}${link}` : input.text;
  }

  // ---- engage ---------------------------------------------------------------------------

  /**
   * Push a text message into the parent's conversation, quoting the parent when its quote token was seen in a
   * webhook. Reply tokens (free, but valid for about a minute and single-use) are not used: push works any time,
   * at the cost of one message from the monthly allowance.
   */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(`reply:${input.idempotencyKey}`, async () => {
      const i = input.parentExternalId.indexOf(":");
      const to = i > 0 ? input.parentExternalId.slice(0, i) : "";
      if (!/^[CRU][0-9a-f]{32}$/i.test(to)) throw new ConnectorError(`line reply: "${input.parentExternalId}" does not name a LINE chat (expected "<group, room or user id>:<message id>")`, "rejected", false);
      if (!input.text.trim()) throw new ConnectorError("line reply: text is empty", "rejected", false);
      if ([...input.text].length > LIMITS.text) throw new ConnectorError(`line reply: text messages are at most ${LIMITS.text} characters`, "rejected", false);
      const quoteToken = this.quoteTokens.get(input.parentExternalId);
      const retryKey = lineRetryKey(input.idempotencyKey);
      const token = parseAuth(account).channelAccessToken;
      const r = await this.send(token, "/v2/bot/message/push", { to, messages: [{ type: "text", text: input.text, ...(quoteToken ? { quoteToken } : {}) }] }, retryKey, "push");
      return this.sentResult(to, r, retryKey);
    });
  }

  /** LINE gives bots no way to hide or delete users' messages. */
  async moderate(_account: AccountRef, input: ModerationInput): Promise<void> {
    throw new ConnectorError(`line moderate: ${input.action} is not available through the Messaging API`, "rejected", false);
  }

  private sentResult(to: string, r: Raw, retryKey: string): PublishResult {
    const sent = (r.body as SendResponse | undefined)?.sentMessages ?? [];
    for (const s of sent) {
      this.ownMessages.set(`${to}:${s.id}`, true);
      if (s.quoteToken) this.quoteTokens.set(`${to}:${s.id}`, s.quoteToken);
    }
    const first = sent[0];
    const requestId = r.headers.get(r.status === 409 ? "x-line-accepted-request-id" : "x-line-request-id");
    const externalId = first ? `${to}:${first.id}` : `${to}:req-${requestId ?? retryKey}`;
    return { externalId, url: null, ...(sent.length > 1 ? { threadExternalIds: sent.slice(1).map((s) => `${to}:${s.id}`) } : {}), raw: { sentMessages: sent, requestId, retryKey, ...(r.status === 409 ? { alreadyAccepted: true } : {}) } };
  }

  // ---- listen / measure -----------------------------------------------------------------

  /** Webhook-only: LINE has no API to read chat history. Uses the call to warm the name cache. */
  async fetchActivity(account: AccountRef): Promise<ActivityInput[]> {
    await this.resolveNames(account).catch(() => 0);
    return [];
  }

  /** The Messaging API has no per-message metrics for push; broadcast statistics need ≥ 20 recipients (not wired). */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  /**
   * followers_total from the insight API for yesterday (Asia/Tokyo). LINE aggregates once a day: an "unready"
   * day falls back one more day; "out_of_service" or still unready returns nothing. `followers` counts first-time
   * friend adds and does not drop when people block the account (blocks are reported separately).
   */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const token = parseAuth(account).channelAccessToken;
    const now = this.now();
    for (const back of [1, 2]) {
      const r = await this.json<{ status?: string; followers?: number; targetedReaches?: number; blocks?: number }>(token, "GET", `/v2/bot/insight/followers?date=${tokyoDate(now, back)}`, "followers insight");
      if (r.status === "ready" && typeof r.followers === "number") {
        return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: r.followers, observedAt: now.toISOString(), source: "line" }];
      }
      if (r.status !== "unready") break;
    }
    return [];
  }

  /**
   * Message allowance this month: the target limit (null when none is set) and how many were sent. Not a metric;
   * shown to the person so they can see how much push/broadcast budget is left.
   */
  async fetchMessageQuota(account: AccountRef): Promise<{ type: "none" | "limited"; limit: number | null; used: number }> {
    const token = parseAuth(account).channelAccessToken;
    const q = await this.json<{ type?: string; value?: number }>(token, "GET", "/v2/bot/message/quota", "message quota");
    const c = await this.json<{ totalUsage?: number }>(token, "GET", "/v2/bot/message/quota/consumption", "quota consumption");
    return { type: q.type === "limited" ? "limited" : "none", limit: q.type === "limited" && typeof q.value === "number" ? q.value : null, used: c.totalUsage ?? 0 };
  }

  // ---- transport ------------------------------------------------------------------------

  /** POST a send request with X-Line-Retry-Key. 409 means LINE already accepted this key: treat as sent. */
  private async send(token: string, path: string, body: unknown, retryKey: string, op: string): Promise<Raw> {
    const r = await this.raw(token, "POST", path, op, body, { "x-line-retry-key": retryKey });
    if (r.status === 409) return r;
    if (r.status < 200 || r.status >= 300) throw mapLineError(r.status, r.body, op, r.headers);
    return r;
  }

  private async json<T>(token: string, method: string, path: string, op: string, body?: unknown): Promise<T> {
    const r = await this.raw(token, method, path, op, body);
    if (r.status < 200 || r.status >= 300) throw mapLineError(r.status, r.body, op, r.headers);
    return (r.body ?? {}) as T;
  }

  private async raw(token: string, method: string, path: string, op: string, body?: unknown, extra: Record<string, string> = {}): Promise<Raw> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.apiBase}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (err) {
      throw asNetworkError(err instanceof Error ? new Error(err.message.replaceAll(token, "<token>")) : err, `line ${op}`);
    }
    return { status: res.status, body: await readJson(res), headers: res.headers };
  }
}

function parseAuth(account: AccountRef): LineAuth {
  const parsed = LineAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`line account ${account.handle}: auth blob needs channelAccessToken and channelSecret`, "auth", false);
  return parsed.data;
}

/** The group/room id publish pushes to instead of broadcasting, when the account config names one. */
function defaultGroupOf(account: AccountRef): string | null {
  const g = (account.config as Partial<LineAccountConfig>).defaultGroupId;
  return typeof g === "string" && g.trim() ? g.trim() : null;
}

export function createLineConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new LineConnector({ ...(env.LINE_API_BASE ? { apiBase: env.LINE_API_BASE } : {}), ...(env.BASE_AIR_PUBLIC_URL ? { publicUrl: env.BASE_AIR_PUBLIC_URL } : {}) })];
}
