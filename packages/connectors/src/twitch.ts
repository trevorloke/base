import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActivityInput, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { OAuth2Client, clientFromEnv, type OAuth2Token } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, ModerationInput, PublishInput, PublishResult, ValidationIssue, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Twitch adapter for creators and brands with a channel: watch chat, answer it, delete messages, count followers.
 *
 * One account = the broadcaster who logged in (GET /helix/users). Chat is real-time only, so the inbox is EventSub
 * over the **webhook** transport: on connect (when STARSIGN_PUBLIC_URL and TWITCH_EVENTSUB_SECRET are set) the
 * connector subscribes `channel.chat.message` and `channel.follow` (v2) for the broadcaster with an app access token
 * (client credentials), pointing at `${STARSIGN_PUBLIC_URL}/webhooks/twitch`. Deliveries are verified with
 * HMAC-SHA256 over message id + timestamp + raw body. `fetchActivity` returns [] (nothing to poll).
 *
 * Publishing sends a chat message as the broadcaster (POST /helix/chat/messages, 500 characters, no media).
 */

/**
 * Minimal user scopes:
 * - user:read:chat, user:bot, channel:bot: read the broadcaster's chat through EventSub webhooks (webhook
 *   subscriptions use an app token, which needs user:bot from the chatting user and channel:bot from the broadcaster;
 *   here both are the broadcaster).
 * - user:write:chat: send chat messages and replies.
 * - moderator:manage:chat_messages: delete chat messages.
 * - moderator:read:followers: the channel.follow subscription and the follower list (the total needs no scope).
 */
export const TWITCH_OAUTH_SCOPES = ["user:read:chat", "user:write:chat", "user:bot", "channel:bot", "moderator:manage:chat_messages", "moderator:read:followers"];

const HELIX = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
/** Twitch: reject deliveries older than 10 minutes (replay protection). */
const MAX_AGE_MS = 10 * 60 * 1000;
const CHAT_LIMIT = 500;

export const TwitchAuth = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
  scope: z.string().optional(),
  userId: z.string().min(1),
  login: z.string().optional(),
});
export type TwitchAuth = z.infer<typeof TwitchAuth>;

export interface TwitchConnectorOptions {
  clientId?: string;
  clientSecret?: string;
  /** EventSub webhook secret (10–100 ASCII characters). */
  eventsubSecret?: string;
  /** Public base URL; the callback is `${publicUrl}/webhooks/twitch` (must be HTTPS on port 443). */
  publicUrl?: string;
  helixUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

interface TwitchUser {
  id: string;
  login: string;
  display_name?: string;
  broadcaster_type?: string;
}

export interface TwitchFailure {
  status: number;
  body: unknown;
}

/** Fields of the channel.chat.message event we read. */
export interface TwitchChatMessageEvent {
  broadcaster_user_id: string;
  broadcaster_user_login?: string;
  broadcaster_user_name?: string;
  chatter_user_id: string;
  chatter_user_login?: string;
  chatter_user_name?: string;
  message_id: string;
  message?: { text?: string; fragments?: { type?: string; text?: string; mention?: { user_id?: string; user_login?: string } | null }[] };
  message_type?: string;
  reply?: { parent_message_id?: string; parent_user_id?: string; parent_user_login?: string; parent_message_body?: string; thread_message_id?: string } | null;
}

interface TwitchFollowEvent {
  user_id: string;
  user_login?: string;
  user_name?: string;
  broadcaster_user_id: string;
  broadcaster_user_login?: string;
  followed_at?: string;
}

interface EventSubBody {
  challenge?: string;
  subscription?: { id?: string; type?: string; version?: string; status?: string; condition?: Record<string, string> };
  event?: unknown;
}

export function mapTwitchError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const b = (body ?? {}) as { error?: string; message?: string };
  const detail = [b.error, b.message].filter(Boolean).join(": ") || (typeof body === "string" ? body.slice(0, 200) : "");
  const msg = `twitch ${what}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: TwitchFailure = { status, body };
  if (status === 429) {
    const reset = Number(headers.get("ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : "";
    return new ConnectorError(`${msg}; rate limited${when}`, "rate_limit", true, cause);
  }
  if (status === 401) return new ConnectorError(`${msg} (token expired or revoked; reconnect Twitch)`, "auth", false, cause);
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, cause);
}

function parseAuth(account: AccountRef): TwitchAuth {
  const p = TwitchAuth.safeParse({ userId: account.externalId, ...(account.auth ?? {}) });
  if (!p.success) throw new ConnectorError(`twitch account ${account.handle}: auth blob needs accessToken`, "auth", false, p.error);
  return p.data;
}

/** "<broadcaster id>:<message id>" → parts; a bare message id belongs to the account's channel. */
function splitMessageRef(externalId: string, broadcasterId: string): { broadcasterId: string; messageId: string } {
  const i = externalId.indexOf(":");
  return i > 0 ? { broadcasterId: externalId.slice(0, i), messageId: externalId.slice(i + 1) } : { broadcasterId, messageId: externalId };
}

/** Twitch's EventSub signature: "sha256=" + hex HMAC-SHA256(secret, id + timestamp + body). */
export function twitchSignature(secret: string, messageId: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(messageId + timestamp + rawBody).digest("hex")}`;
}

/** channel.chat.message → activity, or null for the broadcaster's own messages. */
export function twitchChatToActivity(e: TwitchChatMessageEvent, occurredAt: string): ActivityInput | null {
  if (!e.message_id || !e.broadcaster_user_id || e.chatter_user_id === e.broadcaster_user_id) return null;
  const b = e.broadcaster_user_id;
  const repliesToBroadcaster = !!e.reply?.parent_message_id && e.reply.parent_user_id === b;
  const mentions = (e.message?.fragments ?? []).some((f) => f.type === "mention" && f.mention?.user_id === b);
  return {
    network: "twitch",
    kind: repliesToBroadcaster ? "reply" : mentions ? "mention" : "message",
    externalId: `${b}:${e.message_id}`,
    authorHandle: e.chatter_user_login ?? null,
    authorName: e.chatter_user_name ?? null,
    text: e.message?.text ?? null,
    // Chat messages have no permalink; point at the channel.
    url: e.broadcaster_user_login ? `https://www.twitch.tv/${e.broadcaster_user_login}` : null,
    parentExternalId: e.reply?.parent_message_id ? `${b}:${e.reply.parent_message_id}` : null,
    occurredAt,
    raw: e,
    conversation: { id: b, name: e.broadcaster_user_login ?? e.broadcaster_user_name ?? null, type: "channel" },
  };
}

function followToActivity(e: TwitchFollowEvent, fallbackAt: string): ActivityInput {
  return {
    network: "twitch",
    kind: "follow",
    externalId: `${e.broadcaster_user_id}:follow:${e.user_id}`,
    authorHandle: e.user_login ?? null,
    authorName: e.user_name ?? null,
    text: null,
    url: e.user_login ? `https://www.twitch.tv/${e.user_login}` : null,
    parentExternalId: null,
    occurredAt: e.followed_at && Number.isFinite(Date.parse(e.followed_at)) ? new Date(e.followed_at).toISOString() : fallbackAt,
    raw: e,
    conversation: { id: e.broadcaster_user_id, name: e.broadcaster_user_login ?? null, type: "channel" },
  };
}

/**
 * EventSub webhook handler (app-wide secret). Twitch's callback verification is a signed POST whose body carries
 * `challenge`; `respond` answers it with that challenge as text/plain.
 */
export class TwitchWebhookHandler implements WebhookHandler {
  constructor(
    private readonly secret: string | undefined,
    private readonly now: () => Date,
  ) {}

  /** Callback verification: echo the challenge from the signed body. */
  respond(body: unknown): { body: string; contentType: string } | null {
    const c = (body as { challenge?: unknown } | null)?.challenge;
    return typeof c === "string" ? { body: c, contentType: "text/plain" } : null;
  }

  /** Twitch never sends a GET handshake. */
  challenge(): string | null {
    return null;
  }

  verify(headers: Record<string, string>, rawBody: string): boolean {
    if (!this.secret) return false;
    const h = (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? Object.entries(headers).find(([n]) => n.toLowerCase() === k)?.[1];
    const id = h("twitch-eventsub-message-id");
    const ts = h("twitch-eventsub-message-timestamp");
    const sig = h("twitch-eventsub-message-signature");
    if (!id || !ts || !sig) return false;
    const at = Date.parse(ts);
    if (!Number.isFinite(at) || Math.abs(this.now().getTime() - at) > MAX_AGE_MS) return false;
    const want = Buffer.from(twitchSignature(this.secret, id, ts, rawBody));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  parse(body: unknown): WebhookBatch[] {
    const b = (body ?? {}) as EventSubBody;
    if (typeof b.challenge === "string") return []; // answered by respond()
    // Revocations (no event) are ignored: the account shows no new chat until it is reconnected.
    if (!b.event || typeof b.event !== "object" || !b.subscription?.type) return [];
    const at = this.now().toISOString();
    if (b.subscription.type === "channel.chat.message") {
      const e = b.event as TwitchChatMessageEvent;
      const item = twitchChatToActivity(e, at);
      return item ? [{ network: "twitch", accountExternalId: e.broadcaster_user_id, items: [item] }] : [];
    }
    if (b.subscription.type === "channel.follow") {
      const e = b.event as TwitchFollowEvent;
      if (!e.user_id || !e.broadcaster_user_id) return [];
      return [{ network: "twitch", accountExternalId: e.broadcaster_user_id, items: [followToActivity(e, at)] }];
    }
    return [];
  }
}

export class TwitchConnector implements Connector {
  readonly name = "twitch";
  readonly networks: readonly Network[] = ["twitch"];
  readonly connectMethod = "oauth" as const;
  readonly webhook: TwitchWebhookHandler;

  readonly oauth: OAuth2Client;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly eventsubSecret: string | undefined;
  private readonly publicUrl: string | undefined;
  private readonly helix: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sent = new IdempotencyCache<PublishResult>();
  private appToken: { token: string; expiresAt: number } | null = null;

  constructor(opts: TwitchConnectorOptions = {}) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.eventsubSecret = opts.eventsubSecret;
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.helix = (opts.helixUrl ?? HELIX).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.webhook = new TwitchWebhookHandler(opts.eventsubSecret, this.now);
    this.oauth = new OAuth2Client(
      {
        name: "twitch",
        authorizeUrl: "https://id.twitch.tv/oauth2/authorize",
        tokenUrl: TOKEN_URL,
        scopes: TWITCH_OAUTH_SCOPES,
        pkce: false,
        clientAuth: "body",
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
        ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      },
      opts.fetch,
      this.now,
    );
  }

  get connectConfigured(): boolean {
    return this.oauth.configured;
  }

  /** Whether connect can create EventSub subscriptions (public HTTPS URL + secret + client secret). */
  get eventsubConfigured(): boolean {
    return !!this.publicUrl && !!this.eventsubSecret && !!this.clientId && !!this.clientSecret;
  }

  capabilities(): ConnectorCapabilities {
    return {
      publish: true,
      // Activity arrives only through EventSub webhooks; there is nothing to poll.
      fetchActivity: false,
      fetchMetrics: false,
      meteredReads: false,
      reply: true,
      moderate: true,
      accountMetrics: true,
      webhooks: true,
      video: false,
      kinds: ["post"],
    };
  }

  // ---- connect ---------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl({ state: p.state, redirectUri: p.redirectUri });
  }

  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = await this.oauth.exchange({ code: p.code, redirectUri: p.redirectUri });
    const me = await this.user(token.accessToken);
    const eventsub = await this.subscribe(me.id);
    return [
      {
        network: "twitch",
        identity: identityOf(me),
        auth: authFromToken(token, me),
        config: { broadcasterId: me.id, login: me.login, broadcasterType: me.broadcaster_type ?? "", eventsub },
      },
    ];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const token = typeof auth.accessToken === "string" ? auth.accessToken : null;
    if (!token) throw new ConnectorError("twitch: accessToken is required", "auth", false);
    return identityOf(await this.user(token));
  }

  /** User tokens last about 4 hours; refresh tokens do not expire for confidential clients (they may rotate). */
  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const auth = parseAuth(account);
    if (!auth.refreshToken) return null;
    const t = await this.oauth.refresh(auth.refreshToken);
    return { auth: authFromToken(t, { id: auth.userId, login: auth.login ?? account.handle }) };
  }

  private async user(token: string): Promise<TwitchUser> {
    const r = await this.request<{ data?: TwitchUser[] }>(token, "GET", "/users", { what: "users" });
    const me = r.data?.[0];
    if (!me?.id) throw new ConnectorError("twitch users: response had no user", "unknown", false, r);
    return me;
  }

  /**
   * Create the channel.chat.message and channel.follow webhook subscriptions for a broadcaster. Never fails the
   * connection: the outcome is kept in the account config so the room can explain what is missing.
   */
  async subscribe(broadcasterId: string): Promise<{ status: "subscribed" | "not_configured" | "failed"; detail?: string; callback?: string }> {
    if (!this.eventsubConfigured) {
      return { status: "not_configured", detail: "set STARSIGN_PUBLIC_URL (HTTPS) and TWITCH_EVENTSUB_SECRET, then reconnect, to receive chat and follows" };
    }
    const callback = `${this.publicUrl}/webhooks/twitch`;
    // TODO(verify): reading chat as the broadcaster (user_id = broadcaster_user_id) satisfies the user:bot +
    // channel:bot requirement for app-token webhook subscriptions without a separate bot account.
    const subs = [
      { type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId } },
      { type: "channel.follow", version: "2", condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
    ];
    try {
      const app = await this.appAccessToken();
      for (const s of subs) {
        try {
          await this.request(app, "POST", "/eventsub/subscriptions", { json: { ...s, transport: { method: "webhook", callback, secret: this.eventsubSecret } }, what: `subscribe ${s.type}` });
        } catch (err) {
          // 409: the subscription already exists (a reconnect), which is what we want.
          if (!(err instanceof ConnectorError && (err.cause as TwitchFailure | undefined)?.status === 409)) throw err;
        }
      }
      return { status: "subscribed", callback };
    } catch (err) {
      return { status: "failed", detail: (err as Error).message, callback };
    }
  }

  /** App access token (client credentials), cached until shortly before it expires. */
  private async appAccessToken(): Promise<string> {
    if (this.appToken && this.appToken.expiresAt > this.now().getTime() + 60_000) return this.appToken.token;
    if (!this.clientId || !this.clientSecret) throw new ConnectorError("twitch: client id/secret are needed for an app access token", "auth", false);
    const form = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials" });
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() });
    } catch (err) {
      throw asNetworkError(err, "twitch app token");
    }
    const data = (await readJson(res)) as { access_token?: string; expires_in?: number } | undefined;
    if (!res.ok || !data?.access_token) throw mapTwitchError(res.status, res.headers, data, "app token");
    this.appToken = { token: data.access_token, expiresAt: this.now().getTime() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }

  // ---- validate & publish ---------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.text.trim()) issues.push({ code: "empty", message: "a Twitch chat message needs text" });
    if ([...input.text].length > CHAT_LIMIT) issues.push({ code: "too_long", message: `Twitch chat messages are limited to ${CHAT_LIMIT} characters (got ${[...input.text].length})` });
    if (input.media.length > 0) issues.push({ code: "unsupported_media", message: "Twitch chat messages carry no media" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "Twitch chat has no threads" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.sent.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`twitch publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const auth = parseAuth(account);
      const parent = input.replyToExternalId ? splitMessageRef(input.replyToExternalId, auth.userId) : null;
      return this.sendChat(account, auth, input.text, parent?.messageId);
    });
  }

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.sent.run(input.idempotencyKey, async () => {
      if (!input.text.trim() || [...input.text].length > CHAT_LIMIT) throw new ConnectorError(`twitch reply: text must be 1–${CHAT_LIMIT} characters`, "rejected", false);
      const auth = parseAuth(account);
      const { broadcasterId, messageId } = splitMessageRef(input.parentExternalId, auth.userId);
      if (broadcasterId !== auth.userId) throw new ConnectorError("twitch reply: the message is not in this account's channel", "rejected", false);
      return this.sendChat(account, auth, input.text, messageId);
    });
  }

  private async sendChat(account: AccountRef, auth: TwitchAuth, text: string, replyTo: string | undefined): Promise<PublishResult> {
    const r = await this.request<{ data?: { message_id?: string; is_sent?: boolean; drop_reason?: { code?: string; message?: string } | null }[] }>(auth.accessToken, "POST", "/chat/messages", {
      json: { broadcaster_id: auth.userId, sender_id: auth.userId, message: text, ...(replyTo ? { reply_parent_message_id: replyTo } : {}) },
      what: "send chat message",
    });
    const d = r.data?.[0];
    if (!d?.is_sent || !d.message_id) {
      const why = d?.drop_reason ? `${d.drop_reason.code ?? ""} ${d.drop_reason.message ?? ""}`.trim() : "not sent";
      throw new ConnectorError(`twitch send chat message: dropped (${why})`, "rejected", false, r);
    }
    const login = auth.login ?? account.handle;
    return { externalId: `${auth.userId}:${d.message_id}`, url: `https://www.twitch.tv/${login}`, raw: r };
  }

  // ---- inbox ----------------------------------------------------------------------------

  /** Webhook-only: chat and follows arrive through EventSub. */
  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  /** delete a chat message (DELETE /helix/moderation/chat). Twitch has no hide or like for chat. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    if (input.action !== "delete") throw new ConnectorError(`twitch cannot ${input.action} chat messages`, "rejected", false);
    const auth = parseAuth(account);
    const { broadcasterId, messageId } = splitMessageRef(input.externalId, auth.userId);
    const q = new URLSearchParams({ broadcaster_id: broadcasterId, moderator_id: auth.userId, message_id: messageId });
    await this.request(auth.accessToken, "DELETE", `/moderation/chat?${q}`, { what: "delete chat message" });
  }

  // ---- metrics --------------------------------------------------------------------------

  /** Chat messages have no metrics. */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  /** followers_total from GET /helix/channels/followers (total is returned with any user token). */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const r = await this.request<{ total?: number }>(auth.accessToken, "GET", `/channels/followers?${new URLSearchParams({ broadcaster_id: auth.userId, first: "1" })}`, { what: "channel followers" });
    if (typeof r.total !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: r.total, observedAt: this.now().toISOString(), source: "twitch" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async request<T>(token: string, method: string, path: string, opts: { json?: unknown; what: string }): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "client-id": this.clientId ?? "", accept: "application/json" };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.helix}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
      throw asNetworkError(err, `twitch ${opts.what}`);
    }
    const data = await readJson(res);
    if (!res.ok) throw mapTwitchError(res.status, res.headers, data, opts.what);
    return (data ?? {}) as T;
  }
}

function identityOf(me: TwitchUser): AccountIdentity {
  return { externalId: me.id, handle: me.login, displayName: me.display_name ?? me.login };
}

function authFromToken(t: OAuth2Token, me: { id: string; login?: string }): TwitchAuth {
  // Twitch returns scope as an array, which OAuth2Client does not copy.
  const scope = t.scope ?? (Array.isArray(t.raw.scope) ? (t.raw.scope as unknown[]).join(" ") : undefined);
  return {
    accessToken: t.accessToken,
    ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
    ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(scope ? { scope } : {}),
    userId: me.id,
    ...(me.login ? { login: me.login } : {}),
  };
}

/** Registry entry for Twitch: TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET, TWITCH_EVENTSUB_SECRET, STARSIGN_PUBLIC_URL. */
export function createTwitchConnectors(env: NodeJS.ProcessEnv): Connector[] {
  const { clientId, clientSecret } = clientFromEnv(env, "TWITCH");
  return [
    new TwitchConnector({
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(env.TWITCH_EVENTSUB_SECRET ? { eventsubSecret: env.TWITCH_EVENTSUB_SECRET } : {}),
      ...(env.STARSIGN_PUBLIC_URL ? { publicUrl: env.STARSIGN_PUBLIC_URL } : {}),
    }),
  ];
}
