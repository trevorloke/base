import { createHash } from "node:crypto";
import type { ActivityInput, MetricInput, Network } from "@base-air/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Google Chat spaces through incoming webhooks. A space member adds a webhook (space name → Apps & integrations →
 * Webhooks) and pastes its URL. The URL carries its own key and token, so there is no OAuth and no app review; it can
 * only post into that one space. Reading a space needs a Chat app (Chat API + Google Workspace admin approval for
 * the app's scopes): a later step.
 *
 * Threads: every post names a `threadKey` derived from base air's idempotency key with
 * messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD, so thread segments and later replies to a post land in its
 * thread (or start one).
 */

const WEBHOOK_URL = /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([A-Za-z0-9_-]{6,})\/messages\?(.+)$/;

/** Chat messages: 32,000 bytes including text and cards (spaces.messages.create). Webhooks take no file uploads. */
const LIMITS = { messageBytes: 32_000, cardTitle: 200 } as const;

export const GoogleChatAuth = z.object({ webhookUrl: z.string().regex(WEBHOOK_URL, "not a Google Chat webhook URL") });
export type GoogleChatAuth = z.infer<typeof GoogleChatAuth>;

export interface ParsedChatWebhook {
  spaceId: string;
  key: string;
  token: string;
  /** Canonical URL: only key and token kept (other query parameters dropped). */
  url: string;
}

/** https://chat.googleapis.com/v1/spaces/<space>/messages?key=…&token=… → parts, or null. */
export function parseGoogleChatWebhookUrl(raw: string): ParsedChatWebhook | null {
  const m = raw.trim().match(WEBHOOK_URL);
  if (!m?.[1] || !m[2]) return null;
  const q = new URLSearchParams(m[2]);
  const key = q.get("key");
  const token = q.get("token");
  if (!key || !token) return null;
  const url = `https://chat.googleapis.com/v1/spaces/${m[1]}/messages?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
  return { spaceId: m[1], key, token, url };
}

/** Markdown-lite → Chat text formatting: **bold** → *bold*, ~~strike~~ → ~strike~, [text](url) → <url|text>. */
export function toChatText(text: string): string {
  // TODO(verify): Google Chat has started rendering some Markdown natively; the classic *bold* / <url|text> syntax still works.
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<${u}|${t.replace(/\|/g, "¦")}>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~");
}

/** A stable thread key for a post (also what later replies use). */
export function chatThreadKey(idempotencyKey: string): string {
  // The "starsign" namespace predates the rename to base air and must stay: replies to existing posts re-derive this key.
  return `starsign-${createHash("sha256").update(`starsign:gchat:${idempotencyKey}`).digest("hex").slice(0, 24)}`;
}

/** A cardsV2 link card: header (title, host), optional image, and an "Open" button. */
export function linkCard(link: string, title?: string, imageUrl?: string): Record<string, unknown> {
  let host = link;
  try {
    host = new URL(link).host;
  } catch {
    // keep the raw link
  }
  const widgets: Record<string, unknown>[] = [];
  if (imageUrl) widgets.push({ image: { imageUrl, altText: title ?? host } });
  widgets.push({ buttonList: { buttons: [{ text: "Open", onClick: { openLink: { url: link } } }] } });
  return {
    cardId: "base-air-link",
    card: { header: { title: (title ?? host).slice(0, LIMITS.cardTitle), subtitle: host }, sections: [{ widgets }] },
  };
}

interface ChatFailure {
  status: number;
  reason?: string;
  retryAfter?: number;
}

/** HTTP → ConnectorError, never quoting the URL (it carries the webhook key and token). */
export function mapGoogleChatError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const b = (body && typeof body === "object" ? body : {}) as { error?: { code?: number; message?: string; status?: string } };
  const reason = b.error?.status;
  const msg = `google chat ${what}: HTTP ${status}${reason ? ` ${reason}` : ""}${b.error?.message ? ` ${b.error.message.slice(0, 300)}` : ""}`;
  const cause: ChatFailure = { status, ...(reason ? { reason } : {}) };
  if (status === 429) {
    const after = Number(headers.get("retry-after") ?? NaN);
    return new ConnectorError(`${msg} (rate limited; Chat allows about one message per second per space)`, "rate_limit", true, { ...cause, ...(Number.isFinite(after) ? { retryAfter: after } : {}) });
  }
  // 401/403: the key or token was revoked; 404: the webhook or space is gone. Either way the person must reconnect.
  if (status === 401 || status === 403 || status === 404) return new ConnectorError(`${msg} (the webhook was removed or its URL changed; add it again)`, "auth", false, cause);
  if (status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (status >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

interface ChatMessage {
  name?: string;
  createTime?: string;
  thread?: { name?: string; threadKey?: string };
  space?: { name?: string; displayName?: string };
}

export interface GoogleChatConnectorOptions {
  fetch?: FetchLike;
}

export class GoogleChatConnector implements Connector {
  readonly name = "google_chat";
  readonly networks: readonly Network[] = ["google_chat"];
  readonly connectMethod = "webhook_url" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [{ key: "webhookUrl", label: "Space webhook URL (space → Apps & integrations → Webhooks)", placeholder: "https://chat.googleapis.com/v1/spaces/AAAA…/messages?key=…&token=…", secret: true }] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** message name → its thread key, so a reply to a post lands in that post's thread. */
  private readonly threads = new Map<string, string>();

  constructor(opts: GoogleChatConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
  }

  capabilities(): ConnectorCapabilities {
    // A webhook only writes: no inbox, no replies to people, no deletes, no metrics.
    return { publish: true, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: false, moderate: false, accountMetrics: false, webhooks: false, video: false, kinds: ["post", "link"] };
  }

  /** Checks the URL's shape only: a webhook has no read endpoint, and connecting must not post into the space. */
  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const hook = parseGoogleChatWebhookUrl(p.inputs.webhookUrl ?? "");
    if (!hook) throw new ConnectorError("google chat: paste the space's webhook URL, like https://chat.googleapis.com/v1/spaces/<space>/messages?key=…&token=…", "auth", false);
    return [{ network: "google_chat", identity: identityOf(hook), auth: { webhookUrl: hook.url }, config: { spaceName: `spaces/${hook.spaceId}` } }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const hook = parseGoogleChatWebhookUrl(typeof auth.webhookUrl === "string" ? auth.webhookUrl : "");
    if (!hook) throw new ConnectorError("google chat: webhookUrl is required", "auth", false);
    return identityOf(hook);
  }

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (input.media.length > 0) issues.push({ code: "unsupported_media", message: "google chat webhooks cannot upload files; share a link instead (options.thumbnailUrl shows an image on the link card)" });
    if (!input.text.trim() && !input.options?.link) issues.push({ code: "empty", message: "google chat messages need text or a link" });
    [input.text, ...input.thread].forEach((t, segment) => {
      if (Buffer.byteLength(t, "utf8") > LIMITS.messageBytes - 2000) issues.push({ code: "too_long", message: `google chat messages are at most ${LIMITS.messageBytes} bytes including cards`, segment });
    });
    return issues;
  }

  /**
   * Root message (text, plus a link card when options.link is set), then each thread segment as a reply in the same
   * thread. A publish with replyToExternalId posts into that message's thread.
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`google chat publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const hook = parseAuth(account);
      const opts = input.options ?? {};
      let threadKey = chatThreadKey(input.idempotencyKey);
      let threadName: string | undefined;
      if (input.replyToExternalId) {
        const known = this.threads.get(input.replyToExternalId);
        if (known) threadKey = known;
        else if (/^spaces\/[^/]+\/threads\/[^/]+$/.test(input.replyToExternalId)) threadName = input.replyToExternalId;
        else throw new ConnectorError(`google chat: cannot find the thread of ${input.replyToExternalId} (only posts made since the last restart, or a spaces/…/threads/… name, can be answered)`, "rejected", false);
      }
      const root: Record<string, unknown> = { text: toChatText(input.text) };
      if (opts.link) root.cardsV2 = [linkCard(opts.link, opts.title, opts.thumbnailUrl)];
      const first = await this.post(hook, root, threadName ? { name: threadName } : { threadKey });
      const ids: string[] = [];
      for (const seg of input.thread) {
        const m = await this.post(hook, { text: toChatText(seg) }, first.thread?.name ? { name: first.thread.name } : { threadKey });
        if (m.name) ids.push(m.name);
      }
      if (!first.name) throw new ConnectorError("google chat publish: the response carried no message name", "unknown", false, first);
      if (!threadName) this.threads.set(first.name, threadKey);
      return { externalId: first.name, url: null, ...(ids.length ? { threadExternalIds: ids } : {}), raw: first };
    });
  }

  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  private async post(hook: ParsedChatWebhook, message: Record<string, unknown>, thread: { threadKey?: string; name?: string }): Promise<ChatMessage> {
    const url = `${hook.url}&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url, { method: "POST", headers: { "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ ...message, thread }) });
    } catch (err) {
      // Raw or URL-encoded, the key and token never reach logs.
      const scrub = (s: string) =>
        s
          .replace(/([?&](?:key|token)=)[^&\s"']+/g, "$1<redacted>")
          .replaceAll(hook.token, "<token>")
          .replaceAll(encodeURIComponent(hook.token), "<token>")
          .replaceAll(hook.key, "<key>");
      throw asNetworkError(new Error(scrub(err instanceof Error ? err.message : String(err))), "google chat post");
    }
    const body = await readJson(res);
    if (!res.ok) throw mapGoogleChatError(res.status, res.headers, body, "post");
    return (body ?? {}) as ChatMessage;
  }
}

function identityOf(hook: ParsedChatWebhook): AccountIdentity {
  return { externalId: `spaces/${hook.spaceId}`, handle: `Google Chat space ${hook.spaceId}`, displayName: null };
}

function parseAuth(account: AccountRef): ParsedChatWebhook {
  const hook = parseGoogleChatWebhookUrl(typeof account.auth?.webhookUrl === "string" ? account.auth.webhookUrl : "");
  if (!hook) throw new ConnectorError(`google chat account ${account.handle}: auth blob needs a webhookUrl`, "auth", false);
  return hook;
}

export function createGoogleChatConnectors(_env: NodeJS.ProcessEnv): Connector[] {
  return [new GoogleChatConnector()];
}
