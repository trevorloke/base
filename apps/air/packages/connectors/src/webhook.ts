import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ActivityKind, type ActivityInput, type MetricInput, type Network } from "@base-air/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, PublishInput, PublishResult, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Custom webhook: the universal connector. One account = one endpoint the person names.
 *
 * - **Out**: every post published to this account is POSTed as JSON to the person's outbound URL (a Zapier/Make/n8n
 *   catch hook, an IFTTT applet, their own server). Any 2xx is success.
 * - **In**: anything POSTed to `${BASE_AIR_PUBLIC_URL}/webhooks/webhook?account=<externalId>` in the documented
 *   shape lands in the live feed and the tracker (form entries, reviews, tickets, other networks).
 *
 * Both directions use one signing secret that the person chooses (and pastes into the other system too):
 * `X-Base-Air-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">` with `X-Base-Air-Timestamp: <unix
 * seconds>`. The timestamp is inside the signed text so a captured delivery cannot be replayed later with a fresh
 * timestamp. Systems that cannot compute an HMAC (IFTTT, a no-code Zapier step) may send
 * `Authorization: Bearer <secret>` instead. Without a secret, inbound is disabled and outbound deliveries are unsigned.
 */

export const SIGNATURE_HEADER = "x-base-air-signature";
export const TIMESTAMP_HEADER = "x-base-air-timestamp";
/**
 * The names these headers had before Starsign became Base Air. Receivers and senders set up before the rename keep
 * working: outbound deliveries carry both pairs, inbound accepts either pair (the new one wins when both are sent).
 */
export const LEGACY_SIGNATURE_HEADER = "x-starsign-signature";
export const LEGACY_TIMESTAMP_HEADER = "x-starsign-timestamp";
/** Deliveries signed more than this far from now (either way) are refused. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Items read from one inbound delivery; the rest are dropped. */
export const MAX_INBOUND_ITEMS = 500;
const MAX_INBOUND_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 10_000;
const ACCOUNT_ID = /^wh_[A-Za-z0-9_-]{8,64}$/;
const MIN_SECRET = 16;

// ---------------------------------------------------------------- signatures

/** `sha256=<hex>` over `"<timestamp>.<rawBody>"`. Exported so tests, docs and other tools sign the same way. */
export function signWebhookPayload(secret: string, timestamp: number | string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

/** Equal-length, constant-time comparison of two strings (hashing first so lengths leak nothing). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Unix seconds from a header value; milliseconds are accepted too. */
function parseTimestamp(v: string | undefined): number | null {
  if (!v || !/^\d{9,14}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

/**
 * Check an inbound delivery against a secret: an HMAC signature with a fresh timestamp, or a bearer secret.
 * Returns false for an empty secret (inbound disabled).
 */
export function verifyWebhookRequest(secret: string, headers: Record<string, string>, rawBody: string, now: Date = new Date()): boolean {
  if (!secret) return false;
  const legacy = !header(headers, SIGNATURE_HEADER) && !!header(headers, LEGACY_SIGNATURE_HEADER);
  const sigName = legacy ? LEGACY_SIGNATURE_HEADER : SIGNATURE_HEADER;
  const tsName = legacy ? LEGACY_TIMESTAMP_HEADER : TIMESTAMP_HEADER;
  const sig = header(headers, sigName)?.trim();
  if (sig) {
    const ts = parseTimestamp(header(headers, tsName));
    if (ts === null || Math.abs(Math.floor(now.getTime() / 1000) - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;
    // The sender signs the timestamp exactly as it sends it. Several comma-separated signatures are accepted
    // (handy while rotating a secret on the sending side).
    const want = signWebhookPayload(secret, header(headers, tsName)!.trim(), rawBody);
    return sig.split(",").some((s) => safeEqual(s.trim().toLowerCase(), want));
  }
  const auth = header(headers, "authorization")?.trim();
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  return !!m?.[1] && safeEqual(m[1].trim(), secret);
}

// ---------------------------------------------------------------- destination safety

/** Loopback, private, link-local, CGNAT, unique-local and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(v);
  if (kind === 4) {
    const [a = 0, b = 0] = v.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (kind === 6) {
    if (v === "::" || v === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) return true; // IPv4-mapped in hex form: refuse rather than decode
    return /^(fc|fd|fe[89ab])/.test(v) || v.startsWith("ff");
  }
  return false;
}

function isPrivateHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(h)) return isPrivateAddress(h);
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa") || !h.includes(".");
}

export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export interface UrlPolicy {
  /** Plain http allowed (RSS: yes; webhooks: only with allowPrivate). */
  allowHttp: boolean;
  /** Private/loopback destinations allowed (self-hosted n8n on the same network). BASE_AIR_ALLOW_PRIVATE_URLS=1. */
  allowPrivate: boolean;
  lookup?: LookupFn;
}

/**
 * Refuse URLs that would make Base Air's server talk to itself or its private network (SSRF): non-http(s) schemes,
 * private hostnames and IP literals, and hostnames that resolve to private addresses. A host that re-resolves
 * between this check and the request (DNS rebinding) is not covered; see the docs.
 */
export async function assertPublicHttpUrl(raw: string, policy: UrlPolicy, what: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConnectorError(`${what}: "${raw.slice(0, 100)}" is not a URL`, "rejected", false);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowHttp)) throw new ConnectorError(`${what}: the URL must start with https://`, "rejected", false);
  if (policy.allowPrivate) return url;
  if (isPrivateHostname(url.hostname)) throw new ConnectorError(`${what}: ${url.hostname} is a private or local address; Base Air only sends to public hosts`, "rejected", false);
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    let addrs: { address: string }[];
    try {
      addrs = await (policy.lookup ?? defaultLookup)(url.hostname);
    } catch (err) {
      throw new ConnectorError(`${what}: could not resolve ${url.hostname}`, "network", true, err);
    }
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new ConnectorError(`${what}: ${url.hostname} resolves to a private address; Base Air only sends to public hosts`, "rejected", false);
  }
  return url;
}

// ---------------------------------------------------------------- errors

/** HTTP status from the receiving system → ConnectorError. Never includes the URL (catch-hook URLs are secrets). */
export function mapWebhookError(status: number, headers: Headers, body: unknown, host: string): ConnectorError {
  const detail = typeof body === "string" ? body.slice(0, 200) : body !== undefined ? JSON.stringify(body).slice(0, 200) : "";
  const msg = `webhook ${host}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  const cause: { status: number; retryAfter?: number } = { status };
  if (status >= 300 && status < 400) return new ConnectorError(`${msg} (Base Air does not follow redirects; use the final URL)`, "rejected", false, cause);
  if (status === 429) {
    const ra = headers.get("retry-after");
    const after = ra ? (/^\d+$/.test(ra) ? Number(ra) : Math.max(0, Math.round((Date.parse(ra) - Date.now()) / 1000))) : NaN;
    if (Number.isFinite(after)) cause.retryAfter = after;
    return new ConnectorError(`${msg}; retry after ${Number.isFinite(after) ? after : "?"}s`, "rate_limit", true, cause);
  }
  if (status === 401 || status === 403) return new ConnectorError(`${msg} (the receiving system refused the delivery; check its authentication)`, "auth", false, cause);
  if (status === 404 || status === 410) return new ConnectorError(`${msg} (the URL no longer accepts deliveries; was the Zap/scenario/workflow turned off or deleted?)`, "auth", false, cause);
  if (status === 408 || status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (status >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

// ---------------------------------------------------------------- inbound items

const idLike = z.union([z.string().trim().min(1).max(256), z.number().finite()]).transform(String);
const optStr = z.string().nullish();

/** The documented inbound item. Unknown fields are ignored (kept in `raw`). */
export const InboundItem = z.object({
  id: idLike,
  kind: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), ActivityKind).optional(),
  text: z.string().refine((s) => s.trim().length > 0, "text is empty"),
  author: z.union([z.string(), z.object({ handle: optStr, name: optStr })]).nullish(),
  url: optStr,
  occurredAt: z.union([z.string(), z.number()]).nullish(),
  conversation: z.object({ id: idLike, name: optStr, type: z.enum(["group", "channel", "direct"]).default("channel") }).nullish(),
  lang: optStr,
  parentId: idLike.nullish(),
});
export type InboundItem = z.infer<typeof InboundItem>;

function httpUrlOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function toIso(v: string | number | null | undefined, now: Date): string {
  if (v === null || v === undefined || v === "") return now.toISOString();
  const t = typeof v === "number" ? (v > 1e12 ? v : v * 1000) : /^\d{9,14}$/.test(v.trim()) ? (Number(v) > 1e12 ? Number(v) : Number(v) * 1000) : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : now.toISOString();
}

function langTag(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const parts = v.trim().replace(/_/g, "-").split("-");
  const tag = [parts[0]!.toLowerCase(), ...parts.slice(1)].join("-");
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : undefined;
}

/**
 * The inbound body → activities for one account. Accepts `{ items: [...] }`, a bare array, or a single item object.
 * Invalid items are dropped; at most MAX_INBOUND_ITEMS are read. External ids are namespaced by the account so two
 * endpoints sending "1" do not collide.
 */
export function inboundToActivities(body: unknown, account: { externalId: string; network: Network }, now: Date = new Date()): { items: ActivityInput[]; dropped: number } {
  const list: unknown[] = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : body && typeof body === "object" ? [body] : [];
  const items: ActivityInput[] = [];
  let dropped = Math.max(0, list.length - MAX_INBOUND_ITEMS);
  for (const raw of list.slice(0, MAX_INBOUND_ITEMS)) {
    const p = InboundItem.safeParse(raw);
    if (!p.success) {
      dropped++;
      continue;
    }
    const it = p.data;
    const author = typeof it.author === "string" ? { handle: it.author, name: null } : (it.author ?? {});
    const lang = langTag(it.lang);
    items.push({
      network: account.network,
      kind: it.kind ?? "mention",
      externalId: `${account.externalId}:${it.id}`,
      authorHandle: author.handle?.trim().slice(0, 200) || null,
      authorName: author.name?.trim().slice(0, 200) || null,
      text: it.text.slice(0, MAX_TEXT),
      url: httpUrlOrNull(it.url),
      parentExternalId: it.parentId ? `${account.externalId}:${it.parentId}` : null,
      occurredAt: toIso(it.occurredAt, now),
      raw,
      ...(it.conversation ? { conversation: { id: it.conversation.id, name: it.conversation.name ?? null, type: it.conversation.type } } : {}),
      ...(lang ? { lang } : {}),
    });
  }
  return { items, dropped };
}

/** What decodeAccount hands to parse: the body plus the account it was verified for. */
interface InboundEnvelope {
  baseAirWebhook: { accountExternalId: string; network: Network };
  payload: unknown;
}

function isEnvelope(b: unknown): b is InboundEnvelope {
  const e = b as Partial<InboundEnvelope> | null;
  return !!e && typeof e === "object" && !!e.baseAirWebhook && typeof e.baseAirWebhook.accountExternalId === "string";
}

// ---------------------------------------------------------------- connector

export const WebhookAuth = z.object({
  accountId: z.string().regex(ACCOUNT_ID),
  name: z.string().optional(),
  outboundUrl: z.string().url().optional(),
  secret: z.string().optional(),
});
export type WebhookAuth = z.infer<typeof WebhookAuth>;

export interface WebhookConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  /** BASE_AIR_PUBLIC_URL: used to show the inbound URL. */
  publicUrl?: string;
  /** BASE_AIR_ALLOW_PRIVATE_URLS=1: allow http:// and private/loopback outbound URLs (self-hosted n8n next door). */
  allowPrivate?: boolean;
  lookup?: LookupFn;
  /** Outbound request timeout. */
  timeoutMs?: number;
  /** Account id generator (tests). */
  newAccountId?: () => string;
}

export class WebhookConnector implements Connector {
  readonly name = "webhook";
  readonly networks: readonly Network[] = ["webhook"];
  readonly connectMethod = "webhook_url" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "name", label: "Name for this endpoint", placeholder: "Zapier: new posts to Slack", optional: true },
    { key: "outboundUrl", label: "Outbound URL (Base Air POSTs published posts here; https)", placeholder: "https://hooks.zapier.com/hooks/catch/123/abc/", optional: true, secret: true },
    { key: "secret", label: `Signing secret (${MIN_SECRET}+ characters; signs both directions; empty = no inbound)`, placeholder: "openssl rand -base64 32", optional: true, secret: true },
  ] as const;
  readonly webhook: WebhookHandler;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly publicUrl: string | undefined;
  private readonly allowPrivate: boolean;
  private readonly lookup: LookupFn | undefined;
  private readonly timeoutMs: number;
  private readonly newAccountId: () => string;
  private readonly idempotency = new IdempotencyCache<PublishResult>();

  constructor(opts: WebhookConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.allowPrivate = opts.allowPrivate ?? false;
    this.lookup = opts.lookup;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.newAccountId = opts.newAccountId ?? (() => `wh_${randomBytes(12).toString("base64url")}`);
    this.webhook = {
      // Never used: every endpoint has its own secret, so route + verifyAccount take over.
      verify: () => false,
      route: (_rawBody, query) => {
        const id = (query.account ?? "").trim();
        return ACCOUNT_ID.test(id) ? { network: "webhook", accountExternalId: id } : null;
      },
      verifyAccount: (account, headers, rawBody) => {
        if (rawBody.length > MAX_INBOUND_BYTES) return false;
        const secret = typeof account.auth?.secret === "string" ? account.auth.secret : "";
        return verifyWebhookRequest(secret, headers, rawBody, this.now());
      },
      decodeAccount: (account, rawBody): InboundEnvelope => ({ baseAirWebhook: { accountExternalId: account.externalId, network: account.network }, payload: JSON.parse(rawBody) as unknown }),
      decode: (rawBody, query): InboundEnvelope => ({ baseAirWebhook: { accountExternalId: query.account ?? "", network: "webhook" }, payload: JSON.parse(rawBody) as unknown }),
      parse: (body): WebhookBatch[] => {
        if (!isEnvelope(body) || !ACCOUNT_ID.test(body.baseAirWebhook.accountExternalId)) return [];
        const target = { externalId: body.baseAirWebhook.accountExternalId, network: body.baseAirWebhook.network };
        const { items } = inboundToActivities(body.payload, target, this.now());
        return [{ network: target.network, accountExternalId: target.externalId, items }];
      },
    };
  }

  capabilities(): ConnectorCapabilities {
    // Publishing needs an outbound URL on the account; inbound arrives by webhook only (nothing to poll, no metrics).
    return { publish: true, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: false, moderate: false, accountMetrics: false, webhooks: true, video: true, kinds: ["post", "reel", "story", "carousel", "video", "short", "pin", "link", "poll"] };
  }

  /** The URL other systems POST to for this account. */
  inboundUrl(accountId: string): string {
    return `${this.publicUrl ?? ""}/webhooks/webhook?account=${accountId}`;
  }

  private policy(): UrlPolicy {
    return { allowHttp: this.allowPrivate, allowPrivate: this.allowPrivate, ...(this.lookup ? { lookup: this.lookup } : {}) };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const outboundRaw = (p.inputs.outboundUrl ?? "").trim();
    const secret = (p.inputs.secret ?? "").trim();
    if (!outboundRaw && !secret) throw new ConnectorError("webhook: give an outbound URL (to send posts out), a signing secret (to receive items), or both", "rejected", false);
    if (secret && (secret.length < MIN_SECRET || secret.length > 512)) throw new ConnectorError(`webhook: the signing secret must be ${MIN_SECRET} to 512 characters (try: openssl rand -base64 32)`, "rejected", false);
    let outboundUrl: string | undefined;
    if (outboundRaw) outboundUrl = (await assertPublicHttpUrl(outboundRaw, this.policy(), "webhook outbound URL")).toString();
    const accountId = this.newAccountId();
    const name = (p.inputs.name ?? "").trim().slice(0, 100) || (outboundUrl ? `Webhook to ${new URL(outboundUrl).hostname}` : "Inbound webhook");
    const auth: WebhookAuth = { accountId, name, ...(outboundUrl ? { outboundUrl } : {}), ...(secret ? { secret } : {}) };
    // Send one sample delivery now: it proves the URL works and gives Zapier/Make/n8n the field layout to map.
    if (outboundUrl) {
      await this.deliver(auth, "ping", {
        id: `ping_${accountId}`,
        text: "Base Air connected this endpoint. Published posts will arrive in this shape.",
        thread: [],
        media: [],
        options: {},
        replyTo: null,
        account: { id: accountId, name },
      });
    }
    const inboundUrl = secret ? this.inboundUrl(accountId) : null;
    return [
      {
        network: "webhook",
        identity: { externalId: accountId, handle: name, displayName: name },
        auth: { ...auth },
        config: {
          name,
          outboundHost: outboundUrl ? new URL(outboundUrl).host : null,
          inboundEnabled: !!secret,
          inboundUrl,
          signing: secret
            ? `POST JSON to the inbound URL with headers ${TIMESTAMP_HEADER}: <unix seconds> and ${SIGNATURE_HEADER}: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" keyed with your signing secret>, or Authorization: Bearer <signing secret>. Outbound deliveries carry the same two headers.`
            : "No signing secret: inbound is off and outbound deliveries are unsigned.",
        },
      },
    ];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const a = WebhookAuth.safeParse(auth);
    if (!a.success) throw new ConnectorError("webhook: auth blob needs an accountId", "auth", false);
    const name = a.data.name ?? a.data.accountId;
    return { externalId: a.data.accountId, handle: name, displayName: name };
  }

  // ---- publish --------------------------------------------------------------------------

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = authOf(account);
      if (!auth.outboundUrl) throw new ConnectorError(`webhook ${account.handle}: this endpoint has no outbound URL, so it cannot publish (reconnect it with one)`, "rejected", false);
      const res = await this.deliver(auth, "post.published", {
        id: input.idempotencyKey,
        text: input.text,
        thread: input.thread,
        media: input.media.map((m) => ({ url: m.url, kind: m.kind, mime: m.mime ?? null, alt: m.alt ?? null })),
        options: input.options ?? {},
        replyTo: input.replyToExternalId ?? null,
        account: { id: auth.accountId, name: auth.name ?? account.handle },
      });
      const r = (res && typeof res === "object" ? res : {}) as { id?: unknown; url?: unknown };
      const externalId = typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 256) : typeof r.id === "number" && Number.isFinite(r.id) ? String(r.id) : input.idempotencyKey;
      return { externalId, url: httpUrlOrNull(typeof r.url === "string" ? r.url : null), raw: res };
    });
  }

  /** POST one signed delivery. Returns the parsed response body. */
  private async deliver(auth: WebhookAuth, event: string, fields: Record<string, unknown>): Promise<unknown> {
    const url = await assertPublicHttpUrl(auth.outboundUrl!, this.policy(), "webhook outbound URL");
    const host = url.host;
    const body = JSON.stringify({ event, ...fields, network: "webhook", sentAt: this.now().toISOString() });
    const ts = Math.floor(this.now().getTime() / 1000);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "Base-Air-Webhook/1",
      "x-base-air-event": event,
      "x-base-air-delivery": String(fields.id ?? ""),
      [TIMESTAMP_HEADER]: String(ts),
      [LEGACY_TIMESTAMP_HEADER]: String(ts),
    };
    if (auth.secret) headers[SIGNATURE_HEADER] = headers[LEGACY_SIGNATURE_HEADER] = signWebhookPayload(auth.secret, ts, body);
    // fetch refuses URLs with credentials; send them as Basic auth (n8n's Basic Auth webhook option).
    if (url.username || url.password) {
      headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
      url.username = "";
      url.password = "";
    }
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url.toString(), { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      // Messages from fetch can carry the URL; the path of a catch hook is its secret.
      const msg = err instanceof Error ? (err.name === "TimeoutError" ? `timed out after ${this.timeoutMs} ms` : err.message.split(url.pathname).join("/…")) : String(err);
      throw asNetworkError(new Error(msg), `webhook ${host}`);
    }
    const parsed = await readJson(res);
    if (res.status < 200 || res.status >= 300) throw mapWebhookError(res.status, res.headers, parsed, host);
    return parsed;
  }

  async fetchActivity(): Promise<ActivityInput[]> {
    return []; // inbound items arrive by webhook
  }

  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }
}

function authOf(account: AccountRef): WebhookAuth {
  const a = WebhookAuth.safeParse(account.auth ?? {});
  if (!a.success) throw new ConnectorError(`webhook account ${account.handle}: auth blob is missing its accountId`, "auth", false);
  return a.data;
}

export function createWebhookConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new WebhookConnector({ ...(env.BASE_AIR_PUBLIC_URL ? { publicUrl: env.BASE_AIR_PUBLIC_URL } : {}), allowPrivate: env.BASE_AIR_ALLOW_PRIVATE_URLS === "1" })];
}
