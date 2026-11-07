import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActivityInput, ActivityKind, Media, MetricInput, Network } from "@base-air/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import { META_DEFAULT_GRAPH_VERSION, graphTime, hubChallenge, mapGraphError, type GraphErrorBody, type GraphFailure } from "./meta.ts";
import type {
  AccountIdentity,
  AccountRef,
  ConnectedAccount,
  Connector,
  ConnectorCapabilities,
  MediaFetcher,
  ModerationInput,
  PublishInput,
  PublishResult,
  ValidationIssue,
  WebhookBatch,
  WebhookHandler,
} from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * WhatsApp through Meta's official WhatsApp Business Platform (Cloud API). Nothing else: no WhatsApp Web automation,
 * no unofficial libraries.
 *
 * One account = one business phone number on a WhatsApp Business Account (WABA). The person pastes the phone number
 * ID, the WABA ID and a System User access token. Messages arrive only by webhook (the Cloud API has no endpoint to
 * read message history), through one Meta app per deployment whose app secret signs every delivery.
 *
 * Activity external ids carry the conversation so `reply` and `moderate` can address the message again after a
 * restart: "<wa_id or BSUID>:<wamid>" for 1:1 chats and "group:<group id>:<wamid>" for groups (Groups API). The wamid
 * alone does not say whom to send the answer to. A bare wamid is accepted when this process saw the message.
 */

export const WhatsAppAuth = z.object({
  accessToken: z.string().min(1),
  phoneNumberId: z.string().regex(/^\d+$/),
  wabaId: z.string().regex(/^\d+$/).optional(),
});
export type WhatsAppAuth = z.infer<typeof WhatsAppAuth>;

export interface WhatsAppConnectorOptions {
  /** App secret of the deployment's Meta app (signs webhook deliveries with X-Hub-Signature-256). */
  appSecret?: string;
  /** Token Meta echoes during the webhook subscription handshake. */
  verifyToken?: string;
  graphVersion?: string;
  graphBaseUrl?: string;
  /** Subscribe the app to the WABA's webhooks at connect (POST /{waba-id}/subscribed_apps). Default true. */
  subscribeApp?: boolean;
  /** Send appsecret_proof with Graph calls (needed when the app has "Require App Secret" on). Default false. */
  appSecretProof?: boolean;
  fetch?: FetchLike;
  now?: () => Date;
}

/** Cloud API limits. TODO(verify): caption limit 1024 and text body 4096 against the current messages reference. */
const LIMITS = { text: 4096, caption: 1024 } as const;

/** Customer-service-window errors: 131047 (re-engagement message) and 470 (its legacy On-Premises code). */
const WINDOW_CODES = new Set([131047, 470]);
/** Throughput and pair limits: app (4), WABA (80007), Cloud API throughput (130429), business/consumer pair (131056), spam rate (131048). */
const WA_RATE_CODES = new Set([4, 80007, 130429, 131056, 131048]);
/** Temporary platform failures: generic (131000), service unavailable (131016), API unknown/service (1, 2). */
const WA_TRANSIENT_CODES = new Set([1, 2, 131000, 131016]);
/** Access denied (131005), account locked (131031), parameter or permission on the WABA (200-299 handled by mapGraphError). */
const WA_AUTH_CODES = new Set([131005, 131031]);

interface WhatsAppErrorBody extends GraphErrorBody {
  error?: NonNullable<GraphErrorBody["error"]> & { error_data?: { details?: string } };
}

/** Graph/Cloud API error → ConnectorError, WhatsApp codes first, then the shared Graph mapping. Never includes the token. */
export function mapWhatsAppError(what: string, status: number, headers: Headers, body: unknown): ConnectorError {
  const e = (body && typeof body === "object" ? (body as WhatsAppErrorBody).error : undefined) ?? {};
  const code = typeof e.code === "number" ? e.code : undefined;
  const subcode = typeof e.error_subcode === "number" ? e.error_subcode : undefined;
  const details = [e.message, e.error_data?.details].filter((x): x is string => typeof x === "string" && x.length > 0).join(" — ");
  const tag = code !== undefined ? ` (code ${code})` : "";
  const cause: GraphFailure = { status, ...(code !== undefined ? { code } : {}), ...(subcode !== undefined ? { subcode } : {}), body };
  const base = `whatsapp ${what}`;
  if (code !== undefined && WINDOW_CODES.has(code)) {
    return new ConnectorError(`${base}: outside the 24-hour window; WhatsApp only allows an approved template now${tag}`, "rejected", false, cause);
  }
  if (status === 429 || (code !== undefined && WA_RATE_CODES.has(code))) {
    return new ConnectorError(`${base}: rate limited by WhatsApp${details ? ` — ${details}` : ""}${tag}`, "rate_limit", true, cause);
  }
  if (code === 131026) {
    return new ConnectorError(`${base}: message undeliverable (the recipient cannot receive it: not on WhatsApp, old app version, or has not accepted the latest terms)${tag}`, "rejected", false, cause);
  }
  if (code !== undefined && WA_AUTH_CODES.has(code)) {
    return new ConnectorError(`${base}: ${details || "access denied"} (token or permission rejected)${tag}`, "auth", false, cause);
  }
  if (code !== undefined && WA_TRANSIENT_CODES.has(code)) return new ConnectorError(`${base}: ${details || "temporary WhatsApp failure"}${tag}`, "network", true, cause);
  return mapGraphError("whatsapp", what, status, headers, body);
}

// ---- webhook payload ----------------------------------------------------------------------------

interface WaContact {
  wa_id?: string;
  /** Business-scoped user id (BSUID), present since the 2026 usernames rollout. */
  user_id?: string;
  profile?: { name?: string; username?: string };
}

export interface WaMessage {
  id?: string;
  from?: string;
  /** BSUID of the sender when the phone number is withheld (usernames). TODO(verify): exact field name in Cloud API payloads. */
  from_user_id?: string;
  timestamp?: string;
  type?: string;
  /** Set on messages in a group created through the Groups API. */
  group_id?: string;
  /** TODO(verify): Meta's samples show no group name on messages; read defensively in case one is added. */
  group_subject?: string;
  group_name?: string;
  text?: { body?: string };
  image?: { caption?: string; id?: string; mime_type?: string };
  video?: { caption?: string; id?: string; mime_type?: string };
  document?: { caption?: string; filename?: string; id?: string; mime_type?: string };
  audio?: { id?: string };
  sticker?: { id?: string };
  reaction?: { message_id?: string; emoji?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string; description?: string } };
  button?: { text?: string; payload?: string };
  location?: { name?: string; address?: string };
  context?: { from?: string; id?: string; forwarded?: boolean };
}

interface WaValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WaContact[];
  messages?: WaMessage[];
  statuses?: unknown[];
}

const PHONE_LIKE = /^\+?[\d\s().-]{6,}$/;
const digits = (s: string | undefined) => (s ?? "").replace(/\D/g, "");

/** externalId for a message in a conversation. */
export function whatsappMessageId(conv: { id: string; type: "group" | "direct" }, wamid: string): string {
  return conv.type === "group" ? `group:${conv.id}:${wamid}` : `${conv.id}:${wamid}`;
}

/** Inverse of whatsappMessageId. A bare wamid has no conversation. */
export function parseWhatsAppMessageId(id: string): { conversation: { id: string; type: "group" | "direct" } | null; wamid: string } {
  const isGroup = id.startsWith("group:");
  const rest = isGroup ? id.slice("group:".length) : id;
  const i = rest.lastIndexOf(":");
  if (i <= 0) return { conversation: null, wamid: rest };
  return { conversation: { id: rest.slice(0, i), type: isGroup ? "group" : "direct" }, wamid: rest.slice(i + 1) };
}

function textOf(m: WaMessage): string | null {
  switch (m.type) {
    case "text":
      return m.text?.body ?? null;
    case "image":
      return m.image?.caption ?? null;
    case "video":
      return m.video?.caption ?? null;
    case "document":
      return m.document?.caption ?? null;
    case "interactive": {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return r?.title ?? null;
    }
    case "button":
      return m.button?.text ?? null;
    case "location":
      return [m.location?.name, m.location?.address].filter(Boolean).join(", ") || null;
    case "reaction":
      return m.reaction?.emoji ?? null;
    default:
      return null;
  }
}

/** One `messages` change value → activities. Statuses, system and unsupported messages are not activities. */
export function whatsappValueToActivities(value: WaValue, now: Date): ActivityInput[] {
  const businessNumber = digits(value.metadata?.display_phone_number);
  const contacts = value.contacts ?? [];
  const out: ActivityInput[] = [];
  for (const m of value.messages ?? []) {
    if (!m.id || m.type === "system" || m.type === "unsupported" || m.type === "errors") continue;
    const sender = m.from ?? m.from_user_id;
    if (!sender) continue;
    if (businessNumber && digits(m.from) === businessNumber) continue; // our own message echoed back in a group
    const contact = contacts.find((c) => (m.from && c.wa_id === m.from) || (m.from_user_id && c.user_id === m.from_user_id)) ?? (contacts.length === 1 && !m.group_id ? contacts[0] : undefined);
    const rawName = contact?.profile?.name?.trim();
    // Profile names can be a phone number; never surface a number as a name.
    const authorName = rawName && !PHONE_LIKE.test(rawName) ? rawName : null;
    const authorHandle = m.from ?? contact?.wa_id ?? m.from_user_id ?? contact?.user_id ?? null;
    const isGroup = typeof m.group_id === "string" && m.group_id.length > 0;
    const conversation = isGroup
      ? { id: m.group_id!, name: m.group_subject ?? m.group_name ?? null, type: "group" as const }
      : { id: sender, type: "direct" as const };
    const convRef = { id: conversation.id, type: conversation.type };
    const text = textOf(m);

    let kind: ActivityKind = isGroup ? "message" : "dm";
    let parentWamid = m.context?.id ?? null;
    if (m.type === "reaction") {
      // Reactions become "like" on the message they react to; an empty emoji is a removed reaction.
      if (!m.reaction?.emoji || !m.reaction.message_id) continue;
      kind = "like";
      parentWamid = m.reaction.message_id;
    } else if (isGroup && m.context?.id && businessNumber && digits(m.context.from) === businessNumber) {
      kind = "reply";
    } else if (isGroup && businessNumber && (text ?? "").includes(`@${businessNumber}`)) {
      kind = "mention";
    }
    out.push({
      network: "whatsapp",
      kind,
      externalId: whatsappMessageId(convRef, m.id),
      authorHandle,
      authorName,
      text,
      url: null,
      parentExternalId: parentWamid ? whatsappMessageId(convRef, parentWamid) : null,
      occurredAt: graphTime(m.timestamp, now),
      conversation,
      raw: { message: m, contact: contact ?? null, metadata: value.metadata ?? null },
    });
  }
  return out;
}

/** Cloud API webhook body → batches routed by phone number id. Only `messages` changes are read. */
export function parseWhatsAppWebhook(body: unknown, now: Date): WebhookBatch[] {
  const b = (body ?? {}) as { object?: string; entry?: { id?: string; changes?: { field?: string; value?: WaValue }[] }[] };
  if (b.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return [];
  const byAccount = new Map<string, ActivityInput[]>();
  for (const entry of b.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const items = whatsappValueToActivities(change.value, now);
      if (items.length === 0) continue;
      byAccount.set(phoneNumberId, [...(byAccount.get(phoneNumberId) ?? []), ...items]);
    }
  }
  return [...byAccount.entries()].map(([accountExternalId, items]) => ({ network: "whatsapp" as const, accountExternalId, items }));
}

// ---- connector ----------------------------------------------------------------------------------

interface PhoneNumberInfo {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

interface SendResponse {
  messages?: { id?: string }[];
}

type Recipient = { id: string; type: "group" | "direct" };

export class WhatsAppConnector implements Connector {
  readonly name = "whatsapp";
  readonly networks: readonly Network[] = ["whatsapp"];
  readonly connectMethod = "api_key" as const;
  readonly credentialInputs = [
    { key: "phoneNumberId", label: "Phone number ID (WhatsApp Manager > API setup)", placeholder: "106540352242922" },
    { key: "wabaId", label: "WhatsApp Business Account ID", placeholder: "102290129340398" },
    { key: "accessToken", label: "System User access token (permanent)", placeholder: "EAAG...", secret: true },
    { key: "defaultGroupId", label: "Group to post to (optional; a group your business created)", placeholder: "group id from the Groups API", optional: true },
  ] as const;
  media?: MediaFetcher;

  private readonly appSecret: string | undefined;
  private readonly verifyToken: string | undefined;
  readonly version: string;
  private readonly graphBase: string;
  private readonly subscribeApp: boolean;
  private readonly appSecretProof: boolean;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** wamid → conversation, learned from webhooks, so a bare wamid can still be answered within this process. */
  private readonly seen = new Map<string, Recipient>();

  constructor(opts: WhatsAppConnectorOptions = {}) {
    this.appSecret = opts.appSecret;
    this.verifyToken = opts.verifyToken;
    this.version = (opts.graphVersion ?? META_DEFAULT_GRAPH_VERSION).replace(/^(?!v)/, "v");
    this.graphBase = (opts.graphBaseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.subscribeApp = opts.subscribeApp ?? true;
    this.appSecretProof = opts.appSecretProof ?? false;
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Without the app secret, webhook deliveries cannot be verified and no message would ever arrive. */
  get connectConfigured(): boolean {
    return !!this.appSecret;
  }

  capabilities(): ConnectorCapabilities {
    // Messages arrive only by webhook (no history endpoint). "publish" means: send to the account's default group.
    return { publish: true, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: true, moderate: true, accountMetrics: false, webhooks: true, video: true, kinds: ["post"] };
  }

  // ---- connect ----------------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const phoneNumberId = (p.inputs.phoneNumberId ?? "").trim();
    const wabaId = (p.inputs.wabaId ?? "").trim();
    const accessToken = (p.inputs.accessToken ?? "").trim();
    if (!/^\d+$/.test(phoneNumberId)) throw new ConnectorError("whatsapp: the phone number ID is the numeric ID from WhatsApp Manager > API setup, not the phone number itself", "rejected", false);
    if (!/^\d+$/.test(wabaId)) throw new ConnectorError("whatsapp: the WhatsApp Business Account ID must be numeric", "rejected", false);
    if (!accessToken) throw new ConnectorError("whatsapp: an access token is required", "auth", false);
    const auth: WhatsAppAuth = { accessToken, phoneNumberId, wabaId };
    const info = await this.phoneNumber(auth);
    let webhooksSubscribed = false;
    if (this.subscribeApp) {
      try {
        await this.graph<{ success?: boolean }>("POST", `/${wabaId}/subscribed_apps`, accessToken, { what: "subscribe app to WABA" });
        webhooksSubscribed = true;
      } catch (err) {
        const e = err instanceof ConnectorError ? err : asNetworkError(err, "whatsapp subscribe app to WABA");
        throw new ConnectorError(
          `whatsapp: the phone number is valid, but subscribing this app to WhatsApp Business Account ${wabaId} failed, so no messages would arrive. Check the WABA ID and that the token has whatsapp_business_management. (${e.message})`,
          e.kind,
          e.retryable,
          e.cause,
        );
      }
    }
    return [
      {
        network: "whatsapp",
        identity: this.identity(phoneNumberId, info),
        auth: { ...auth },
        config: {
          phoneNumberId,
          wabaId,
          displayPhoneNumber: info.display_phone_number ?? null,
          ...(p.inputs.defaultGroupId?.trim() ? { defaultGroupId: p.inputs.defaultGroupId.trim() } : {}),
          verifiedName: info.verified_name ?? null,
          qualityRating: info.quality_rating ?? null,
          webhooksSubscribed,
        },
      },
    ];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = WhatsAppAuth.safeParse(auth);
    if (!parsed.success) throw new ConnectorError("whatsapp: auth needs accessToken and phoneNumberId", "auth", false, parsed.error);
    return this.identity(parsed.data.phoneNumberId, await this.phoneNumber(parsed.data));
  }

  private phoneNumber(auth: WhatsAppAuth): Promise<PhoneNumberInfo> {
    return this.graph<PhoneNumberInfo>("GET", `/${auth.phoneNumberId}`, auth.accessToken, { query: { fields: "display_phone_number,verified_name,quality_rating" }, what: "read phone number" });
  }

  private identity(phoneNumberId: string, info: PhoneNumberInfo): AccountIdentity {
    return { externalId: phoneNumberId, handle: info.display_phone_number ?? phoneNumberId, displayName: info.verified_name ?? null };
  }

  // ---- publish (to a group) ---------------------------------------------------------------------

  validate(account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.replyToExternalId && !defaultGroupOf(account)) issues.push({ code: "empty", message: "WhatsApp posts go to a group; set one up first" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "whatsapp has no threads; send one message" });
    if (input.media.length > 1) issues.push({ code: "too_many_media", message: "whatsapp sends one image, video or document per message" });
    if (input.media.some((m) => m.kind === "gif")) issues.push({ code: "unsupported_media", message: "whatsapp does not send GIF files; convert it to a short MP4 video" });
    if (input.options?.poll) issues.push({ code: "unsupported_media", message: "whatsapp polls are not available through the Cloud API" });
    if (!input.text.trim() && input.media.length === 0) issues.push({ code: "empty", message: "whatsapp messages need text or media" });
    if ([...input.text].length > LIMITS.text) issues.push({ code: "too_long", message: `whatsapp text messages are at most ${LIMITS.text} characters` });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      let to: Recipient;
      let replyTo: string | undefined;
      if (input.replyToExternalId) {
        const target = this.resolve(input.replyToExternalId);
        to = target.conversation;
        replyTo = target.wamid;
      } else {
        const group = defaultGroupOf(account);
        if (!group) throw new ConnectorError("whatsapp: WhatsApp posts go to a group; set one up first", "rejected", false);
        to = { id: group, type: "group" };
      }
      const text = withLink(input.text, input.options?.link);
      const media = input.media[0];
      const sent: string[] = [];
      if (media) {
        const captionFits = [...text].length <= LIMITS.caption;
        sent.push(await this.send(auth, to, mediaPayload(media, captionFits ? text : ""), replyTo));
        if (!captionFits && text) sent.push(await this.send(auth, to, textPayload(text), undefined));
      } else {
        sent.push(await this.send(auth, to, textPayload(text), replyTo));
      }
      const root = sent[0]!;
      return { externalId: whatsappMessageId(to, root), url: null, raw: { messages: sent, to: to.id, recipientType: to.type } };
    });
  }

  // ---- engage -----------------------------------------------------------------------------------

  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const target = this.resolve(input.parentExternalId);
      const wamid = await this.send(auth, target.conversation, textPayload(input.text), target.wamid, "reply");
      return { externalId: whatsappMessageId(target.conversation, wamid), url: null, raw: { message: wamid } };
    });
  }

  /** like/unlike = a 👍 reaction message (an empty emoji removes it). WhatsApp has no hide or delete for others' messages. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    if (input.action !== "like" && input.action !== "unlike") {
      throw new ConnectorError(`whatsapp moderate: ${input.action} is not possible; WhatsApp lets a business react to messages, not hide or delete them`, "rejected", false);
    }
    const auth = parseAuth(account);
    const target = this.resolve(input.externalId);
    await this.send(auth, target.conversation, { type: "reaction", reaction: { message_id: target.wamid, emoji: input.action === "like" ? "👍" : "" } }, undefined, "reaction");
  }

  // ---- listen / measure -------------------------------------------------------------------------

  /** The Cloud API has no endpoint to read messages: everything arrives through the webhook. */
  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  /** No per-message metrics exist (delivered/read statuses are per recipient, not reach). */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  /** No follower count or reach for a business number. Conversation analytics are billing data, not audience metrics. */
  async fetchAccountMetrics(): Promise<MetricInput[]> {
    return [];
  }

  // ---- webhooks ---------------------------------------------------------------------------------

  readonly webhook: WebhookHandler = {
    challenge: (query) => hubChallenge(query, this.verifyToken),
    verify: (headers, rawBody) => this.verifySignature(headers, rawBody),
    parse: (body) => {
      const batches = parseWhatsAppWebhook(body, this.now());
      for (const b of batches) for (const item of b.items) this.learn(item.externalId);
      return batches;
    },
  };

  private verifySignature(headers: Record<string, string>, rawBody: string): boolean {
    if (!this.appSecret) return false;
    const sig = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-hub-signature-256")?.[1] ?? "";
    const want = `sha256=${createHmac("sha256", this.appSecret).update(rawBody, "utf8").digest("hex")}`;
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private learn(externalId: string): void {
    const p = parseWhatsAppMessageId(externalId);
    if (!p.conversation) return;
    this.seen.set(p.wamid, p.conversation);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value!);
  }

  private resolve(externalId: string): { conversation: Recipient; wamid: string } {
    const p = parseWhatsAppMessageId(externalId);
    const conversation = p.conversation ?? this.seen.get(p.wamid);
    if (!conversation || !p.wamid) throw new ConnectorError(`whatsapp: cannot tell which chat "${externalId}" belongs to; expected "<wa_id>:<wamid>" or "group:<group id>:<wamid>"`, "rejected", false);
    return { conversation, wamid: p.wamid };
  }

  // ---- transport --------------------------------------------------------------------------------

  /** POST /{phone-number-id}/messages; returns the new wamid. */
  private async send(auth: WhatsAppAuth, to: Recipient, payload: Record<string, unknown>, contextId: string | undefined, what = "send message"): Promise<string> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: to.type === "group" ? "group" : "individual",
      ...recipientField(to),
      ...payload,
      ...(contextId ? { context: { message_id: contextId } } : {}),
    };
    const res = await this.graph<SendResponse>("POST", `/${auth.phoneNumberId}/messages`, auth.accessToken, { json: body, what });
    const id = res?.messages?.[0]?.id;
    if (!id) throw new ConnectorError(`whatsapp ${what}: the response carried no message id`, "unknown", false, res);
    return id;
  }

  private async graph<T>(method: "GET" | "POST", path: string, token: string, opts: { query?: Record<string, string>; json?: Record<string, unknown>; what: string }): Promise<T> {
    const url = new URL(`${this.graphBase}/${this.version}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    if (this.appSecretProof && this.appSecret) url.searchParams.set("appsecret_proof", createHmac("sha256", this.appSecret).update(token).digest("hex"));
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
    if (opts.json) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method, headers, ...(opts.json ? { body: JSON.stringify(opts.json) } : {}) });
    } catch (err) {
      throw scrub(asNetworkError(err, `whatsapp ${opts.what}`), token);
    }
    const data = await readJson(res);
    if (!res.ok || (data && typeof data === "object" && "error" in data)) throw scrub(mapWhatsAppError(opts.what, res.ok ? 400 : res.status, res.headers, data), token);
    return data as T;
  }
}

/** Phone numbers go in `to`; a business-scoped user id (BSUID, usernames) in `recipient`. Groups use the group id in `to`. */
function recipientField(to: Recipient): Record<string, string> {
  if (to.type === "group") return { to: to.id };
  // TODO(verify): BSUID recipients use `recipient` instead of `to` (seen in BSP docs, not yet confirmed on Meta's reference).
  return /^\+?\d+$/.test(to.id) ? { to: to.id } : { recipient: to.id };
}

function textPayload(text: string): Record<string, unknown> {
  return { type: "text", text: { body: text, preview_url: /https?:\/\//i.test(text) } };
}

function mediaPayload(m: Media, caption: string): Record<string, unknown> {
  // TODO(verify): media in groups. Meta lists media as supported by the Groups API; one BSP reports text only in practice.
  const type = m.kind === "video" ? "video" : m.kind === "document" ? "document" : "image";
  const obj: Record<string, unknown> = { link: m.url, ...(caption ? { caption } : {}) };
  if (type === "document") {
    const name = m.url.split("?")[0]?.split("/").pop();
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) obj.filename = name;
  }
  return { type, [type]: obj };
}

function withLink(text: string, link: string | undefined): string {
  if (!link || text.includes(link)) return text;
  return text ? `${text}\n\n${link}` : link;
}

function defaultGroupOf(account: AccountRef): string | null {
  const g = account.config?.defaultGroupId;
  return typeof g === "string" && g.trim() ? g.trim() : null;
}

function parseAuth(account: AccountRef): WhatsAppAuth {
  const parsed = WhatsAppAuth.safeParse({ phoneNumberId: account.externalId, ...(account.auth ?? {}) });
  if (!parsed.success) throw new ConnectorError(`whatsapp account ${account.handle}: auth needs accessToken and phoneNumberId; reconnect it`, "auth", false, parsed.error);
  return parsed.data;
}

/** Belt and braces: a token must never reach logs or the UI through an error message. */
function scrub(err: ConnectorError, token: string): ConnectorError {
  if (!token || !err.message.includes(token)) return err;
  return new ConnectorError(err.message.replaceAll(token, "<token>"), err.kind, err.retryable, err.cause);
}

export function createWhatsAppConnectors(env: NodeJS.ProcessEnv): Connector[] {
  // The Meta app secret: WhatsApp-specific first, then META_APP_SECRET, then META_CLIENT_SECRET (what meta.ts uses) when
  // WhatsApp is a product on the same Meta app as Facebook/Instagram.
  const appSecret = env.WHATSAPP_APP_SECRET || env.META_APP_SECRET || env.META_CLIENT_SECRET;
  return [
    new WhatsAppConnector({
      ...(appSecret ? { appSecret } : {}),
      ...(env.WHATSAPP_VERIFY_TOKEN ? { verifyToken: env.WHATSAPP_VERIFY_TOKEN } : {}),
      ...(env.WHATSAPP_GRAPH_VERSION ? { graphVersion: env.WHATSAPP_GRAPH_VERSION } : {}),
      ...(env.WHATSAPP_APPSECRET_PROOF === "true" ? { appSecretProof: true } : {}),
    }),
  ];
}
