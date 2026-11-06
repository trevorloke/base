import type { ActivityInput, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { asNetworkError, classifyHttpStatus, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, PublishResult, WebhookBatch, WebhookHandler } from "./types.ts";
import { ConnectorError } from "./types.ts";
import { decodeAesKey, field, parseWeChatXml, signatureMatches, wechatDecrypt, wechatSignature, type WeChatXml } from "./wechat-crypto.ts";

/**
 * WeChat Official Account (公众号 / 服务号) through the official platform API at api.weixin.qq.com.
 *
 * One Starsign account = one Official Account. The owner pastes AppID, AppSecret, the original ID (gh_…), the server
 * Token and, for safe mode, the EncodingAESKey, and points the account's server URL at
 * `${STARSIGN_PUBLIC_URL}/webhooks/wechat?account=<gh_id>`. Messages people send to the account arrive by webhook
 * (XML, plaintext or AES-encrypted), signed with that account's own Token, so the webhook handler uses the per-account
 * hooks (route / verifyAccount / decodeAccount / challengeAccount).
 *
 * External ids are "<openid>:<MsgId>" so a reply can find the person (customer service messages go to an openid).
 *
 * Personal chats and WeChat groups are NOT reachable through any official API; see docs/integrations/wechat.md.
 */

const API_BASE = "https://api.weixin.qq.com";
/** Replay window for signed deliveries (seconds, either direction). */
const MAX_SKEW_SECONDS = 300;
/** Renew a cached access token this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Inputs that mean "no EncodingAESKey": empty (the field is optional), or a placeholder people type anyway. */
const NO_AES_KEY = /^(-|none|no|plain|plaintext|明文)?$/i;

export const WeChatAuth = z.object({
  appId: z.string().regex(/^wx[0-9a-zA-Z]{16}$/, "AppID looks like wx followed by 16 letters or digits"),
  appSecret: z.string().regex(/^[0-9a-zA-Z]{16,64}$/, "AppSecret is 32 letters or digits"),
  originalId: z.string().regex(/^gh_[0-9a-zA-Z]{6,32}$/, "the original ID looks like gh_ followed by letters and digits"),
  // Server configuration rule: 3-32 English letters or digits.
  token: z.string().regex(/^[A-Za-z0-9]{3,32}$/, "the server Token is 3-32 English letters or digits"),
  encodingAesKey: z.string().regex(/^[A-Za-z0-9]{43}$/, "the EncodingAESKey is 43 letters and digits").optional(),
});
export type WeChatAuth = z.infer<typeof WeChatAuth>;

export interface WeChatConnectorOptions {
  /** Override for api.weixin.qq.com (e.g. api2.weixin.qq.com, or a regional sh./sz./hk. host). */
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** STARSIGN_PUBLIC_URL, used to tell the owner which server URL to configure. */
  publicUrl?: string;
}

interface WeChatFailure {
  errcode: number;
  errmsg: string;
}

/** Strip anything secret from text before it lands in an error. */
function scrub(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.replaceAll(s, "<redacted>");
  return out.replace(/access_token=[^&\s"]+/g, "access_token=<redacted>");
}

/**
 * errcode → ConnectorError. WeChat answers HTTP 200 with { errcode, errmsg } for almost everything.
 * Source for the codes: the global return code page and each API's page on developers.weixin.qq.com.
 */
export function mapWeChatError(errcode: number, errmsg: string, context: string): ConnectorError {
  const cause: WeChatFailure = { errcode, errmsg };
  const msg = `wechat ${context}: ${errmsg || "error"} (errcode ${errcode})`;
  switch (errcode) {
    case -1:
      return new ConnectorError(`${msg}: WeChat is busy, try again shortly`, "network", true, cause);
    case 40164:
      return new ConnectorError(
        `${msg}: this server's outbound IP is not on the Official Account's API IP whitelist. Add the IP shown above in the WeChat Developer Platform (API IP 白名单 / IP whitelist) for this AppID, wait a few minutes, then try again`,
        "rejected",
        false,
        cause,
      );
    // TODO(verify): 89501/89503 are returned for calls from a new IP when no whitelist is set and an admin must confirm.
    case 89501:
    case 89503:
      return new ConnectorError(`${msg}: an administrator must approve calls from this server's IP in WeChat, or add the IP to the API IP whitelist`, "rejected", false, cause);
    case 40001:
    case 40014:
    case 42001:
      return new ConnectorError(`${msg}: the access token was not accepted`, "auth", false, cause);
    case 40013:
    case 40125:
    case 41002:
    case 41004:
    case 40243:
      return new ConnectorError(`${msg}: the AppID or AppSecret was not accepted (reset or unfreeze the AppSecret in the WeChat Developer Platform if needed)`, "auth", false, cause);
    case 45009:
    case 45011:
      return new ConnectorError(`${msg}: WeChat API quota reached, try again later`, "rate_limit", true, cause);
    case 45015:
      return new ConnectorError(
        `${msg}: WeChat only allows replies within 48 hours of the person's last message (or they unfollowed the account). Wait for them to write again`,
        "rejected",
        false,
        cause,
      );
    // TODO(verify): 45047 is the customer-service per-user downlink cap.
    case 45047:
      return new ConnectorError(`${msg}: too many messages sent to this person without a reply from them`, "rejected", false, cause);
    case 43004:
      return new ConnectorError(`${msg}: the person no longer follows the Official Account`, "rejected", false, cause);
    case 48001:
      return new ConnectorError(`${msg}: this Official Account is not authorized for this API (customer service messages need a verified service account)`, "rejected", false, cause);
    case 40003:
      return new ConnectorError(`${msg}: unknown openid for this Official Account`, "rejected", false, cause);
    default:
      return new ConnectorError(msg, "rejected", false, cause);
  }
}

const isTokenError = (e: unknown) => e instanceof ConnectorError && [40001, 40014, 42001].includes((e.cause as WeChatFailure | undefined)?.errcode ?? 0);
const isPermissionError = (e: unknown) => e instanceof ConnectorError && [48001, 50001, 50002].includes((e.cause as WeChatFailure | undefined)?.errcode ?? 0);

// ---- message mapping ----------------------------------------------------------------------

/** One inbound message → the account (ToUserName) and the activity, or null for messages Starsign ignores. */
export function wechatMessageToActivity(m: WeChatXml): { accountExternalId: string; item: ActivityInput } | null {
  const to = field(m, "ToUserName");
  const openid = field(m, "FromUserName");
  const type = field(m, "MsgType");
  const created = Number(field(m, "CreateTime"));
  if (!to || !openid || !type) return null;
  const occurredAt = new Date((Number.isFinite(created) && created > 0 ? created : 0) * 1000).toISOString();
  const msgId = field(m, "MsgId");
  const base = {
    network: "wechat" as const,
    authorHandle: openid,
    authorName: null,
    parentExternalId: null,
    occurredAt,
    raw: m,
    conversation: { id: openid, type: "direct" as const },
  };
  if (type === "event") {
    const event = (field(m, "Event") ?? "").toLowerCase();
    if (event !== "subscribe") return null; // unsubscribe, menu clicks, scans, template receipts: ignored
    const scene = field(m, "EventKey")?.replace(/^qrscene_/, "");
    return {
      accountExternalId: to,
      item: { ...base, kind: "follow", externalId: `${openid}:subscribe:${field(m, "CreateTime") ?? "0"}`, text: scene ? `followed (QR scene ${scene})` : null, url: null },
    };
  }
  let text: string | null;
  let url: string | null = null;
  switch (type) {
    case "text":
      text = field(m, "Content") ?? "";
      break;
    case "image":
      url = field(m, "PicUrl") ?? null;
      text = url ? `[image] ${url}` : "[image]";
      break;
    case "voice": {
      // TODO(verify): Recognition is only present when speech recognition is enabled and is being phased out.
      const said = field(m, "Recognition")?.trim();
      text = said ? `[voice] ${said}` : "[voice message]";
      break;
    }
    case "video":
    case "shortvideo":
      text = "[video]";
      break;
    case "location": {
      const label = field(m, "Label");
      const x = field(m, "Location_X");
      const y = field(m, "Location_Y");
      text = `[location]${label ? ` ${label}` : ""}${x && y ? ` (${x}, ${y})` : ""}`;
      break;
    }
    case "link": {
      url = field(m, "Url") ?? null;
      text = ["[link]", field(m, "Title"), field(m, "Description"), url].filter(Boolean).join(" ");
      break;
    }
    default:
      text = `[${type}]`;
  }
  return {
    accountExternalId: to,
    item: { ...base, kind: "dm", externalId: `${openid}:${msgId ?? field(m, "CreateTime") ?? "0"}`, text, url },
  };
}

/** The openid inside an external id "<openid>:<msgid>" (or a bare openid). */
export function openidOf(externalId: string): string {
  const i = externalId.indexOf(":");
  const openid = i >= 0 ? externalId.slice(0, i) : externalId;
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(openid)) throw new ConnectorError(`wechat: "${externalId}" does not name a WeChat user`, "rejected", false);
  return openid;
}

// ---- connector ----------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class WeChatConnector implements Connector {
  readonly name = "wechat";
  readonly networks: readonly Network[] = ["wechat"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "appId", label: "AppID", placeholder: "wx1234567890abcdef" },
    { key: "appSecret", label: "AppSecret", placeholder: "32 letters and digits", secret: true },
    { key: "originalId", label: "Original ID (原始ID)", placeholder: "gh_0123456789ab" },
    { key: "token", label: "Server Token (服务器配置 Token)", placeholder: "the Token you entered in the server configuration", secret: true },
    { key: "encodingAesKey", label: "EncodingAESKey (only for safe mode)", placeholder: "43 characters; leave empty for plaintext mode", secret: true, optional: true },
  ] as const;
  readonly webhook: WebhookHandler;

  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly publicUrl: string | undefined;
  /** Access tokens per AppID, process-local. Tokens live ~2 hours. */
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inflightTokens = new Map<string, Promise<string>>();
  private readonly idempotency = new IdempotencyCache<PublishResult>();

  constructor(opts: WeChatConnectorOptions = {}) {
    this.apiBase = (opts.apiBase ?? API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.publicUrl = opts.publicUrl?.replace(/\/+$/, "");
    this.webhook = {
      verify: () => false, // never used: each account has its own Token, so route + verifyAccount take over
      route: (raw, query) => this.route(raw, query),
      challengeAccount: (account, query) => this.challengeAccount(account, query),
      verifyAccount: (account, _headers, raw, query) => this.verifyAccount(account, raw, query),
      decodeAccount: (account, raw, query) => this.decodeAccount(account, raw, query),
      parse: (body) => this.parse(body),
      // WeChat shows "该公众号暂时无法提供服务" for any reply that is neither XML nor "success"/"".
      ack: { body: "success", contentType: "text/plain" },
    };
  }

  capabilities(): ConnectorCapabilities {
    return { publish: false, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: true, moderate: false, accountMetrics: true, webhooks: true, video: false, kinds: [] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const aes = (p.inputs.encodingAesKey ?? "").trim();
    const parsed = WeChatAuth.safeParse({
      appId: (p.inputs.appId ?? "").trim(),
      appSecret: (p.inputs.appSecret ?? "").trim(),
      originalId: (p.inputs.originalId ?? "").trim(),
      token: (p.inputs.token ?? "").trim(),
      ...(NO_AES_KEY.test(aes) ? {} : { encodingAesKey: aes }),
    });
    if (!parsed.success) {
      // Name the field, never echo the value.
      const issue = parsed.error.issues[0];
      throw new ConnectorError(`wechat: ${issue?.message ?? "the credentials are not in the expected format"}`, "rejected", false);
    }
    const auth = parsed.data;
    if (auth.encodingAesKey) {
      try {
        decodeAesKey(auth.encodingAesKey);
      } catch {
        throw new ConnectorError("wechat: the EncodingAESKey is not valid (43 letters and digits from the server configuration)", "rejected", false);
      }
    }
    // Proves AppID + AppSecret and that this server's IP may call the API.
    await this.accessToken(auth);
    // TODO(verify): self-developed Official Accounts have no API that returns their own nickname; only third-party
    // platforms (api_get_authorizer_info) do. The handle is therefore the original ID.
    const identity: AccountIdentity = { externalId: auth.originalId, handle: auth.originalId, displayName: null };
    const config: Record<string, unknown> = {
      appId: auth.appId,
      mode: auth.encodingAesKey ? "safe" : "plaintext",
      ...(this.publicUrl ? { webhookUrl: `${this.publicUrl}/webhooks/wechat?account=${encodeURIComponent(auth.originalId)}` } : {}),
    };
    return [{ network: "wechat", identity, auth: { ...auth }, config }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = WeChatAuth.safeParse(auth);
    if (!parsed.success) throw new ConnectorError("wechat: auth needs appId, appSecret, originalId and token", "auth", false);
    await this.accessToken(parsed.data);
    return { externalId: parsed.data.originalId, handle: parsed.data.originalId, displayName: null };
  }

  // ---- publish (not yet) ----------------------------------------------------------------

  async publish(): Promise<PublishResult> {
    throw new ConnectorError(
      "wechat: publishing to an Official Account (drafts + freepublish articles, or mass messages) is not supported yet; Starsign reads and answers messages sent to the account",
      "rejected",
      false,
    );
  }

  // ---- engage ---------------------------------------------------------------------------

  /** Customer service text message to the person (only within 48 hours of their last message). */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const openid = openidOf(input.parentExternalId);
      if (!input.text.trim()) throw new ConnectorError("wechat reply: the message is empty", "rejected", false);
      const raw = await this.call(auth, "message/custom/send", "POST", { touser: openid, msgtype: "text", text: { content: input.text } });
      // The API returns no message id; this id is Starsign's own, unique per reply.
      return { externalId: `${openid}:reply:${input.idempotencyKey}`, url: null, raw };
    });
  }

  // ---- listen ---------------------------------------------------------------------------

  /** Webhook-only: WeChat has no API to read messages back. */
  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  /** followers_total from user/get (field `total`), when the account is allowed to call it. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    try {
      const body = (await this.call(auth, "user/get", "GET")) as { total?: number };
      if (typeof body.total !== "number") return [];
      return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: body.total, observedAt: this.now().toISOString(), source: "wechat" }];
    } catch (e) {
      if (isPermissionError(e)) return [];
      throw e;
    }
  }

  // ---- webhooks -------------------------------------------------------------------------

  private route(raw: string, query: Record<string, string>): { network: Network; accountExternalId: string } | null {
    const fromQuery = query.account?.trim();
    if (fromQuery && /^gh_[0-9a-zA-Z]{1,64}$/.test(fromQuery)) return { network: "wechat", accountExternalId: fromQuery };
    if (!raw) return null;
    try {
      const to = field(parseWeChatXml(raw), "ToUserName");
      return to ? { network: "wechat", accountExternalId: to } : null;
    } catch {
      return null;
    }
  }

  private fresh(query: Record<string, string>): boolean {
    const ts = Number(query.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return Math.abs(this.now().getTime() / 1000 - ts) <= MAX_SKEW_SECONDS;
  }

  /** Server URL check: signature = sha1(sorted [token, timestamp, nonce]) → echo echostr. */
  private challengeAccount(account: AccountRef, query: Record<string, string>): string | null {
    const auth = WeChatAuth.safeParse(account.auth ?? {});
    if (!auth.success) return null;
    const { signature, timestamp, nonce, echostr } = query;
    if (!timestamp || nonce === undefined || echostr === undefined || !this.fresh(query)) return null;
    // TODO(verify): in safe mode the URL check also sends msg_signature + an encrypted echostr only for third-party
    // platforms / WeCom; Official Accounts send the plain echostr with `signature` in every mode.
    return signatureMatches(wechatSignature([auth.data.token, timestamp, nonce]), signature) ? echostr : null;
  }

  private verifyAccount(account: AccountRef, raw: string, query: Record<string, string>): boolean {
    const parsed = WeChatAuth.safeParse(account.auth ?? {});
    if (!parsed.success) return false;
    const { token } = parsed.data;
    const { timestamp, nonce } = query;
    if (!timestamp || nonce === undefined || !this.fresh(query)) return false;
    let encrypt: string | undefined;
    try {
      encrypt = field(parseWeChatXml(raw), "Encrypt");
    } catch {
      return false;
    }
    if (encrypt !== undefined || query.encrypt_type === "aes") {
      // Safe/compatible mode: msg_signature over the Encrypt field (the docs say not to use `signature` here).
      if (encrypt === undefined) return false;
      return signatureMatches(wechatSignature([token, timestamp, nonce, encrypt]), query.msg_signature);
    }
    return signatureMatches(wechatSignature([token, timestamp, nonce]), query.signature);
  }

  private decodeAccount(account: AccountRef, raw: string, _query: Record<string, string>): WeChatXml {
    const outer = parseWeChatXml(raw);
    const encrypt = field(outer, "Encrypt");
    if (encrypt === undefined) return outer;
    const auth = parseAuth(account);
    if (!auth.encodingAesKey) throw new ConnectorError("wechat: this delivery is encrypted but the account has no EncodingAESKey; reconnect it with the key", "auth", false);
    // Throws when the AppID at the end does not match: the message was not encrypted for this account.
    return parseWeChatXml(wechatDecrypt(encrypt, auth.encodingAesKey, auth.appId));
  }

  private parse(body: unknown): WebhookBatch[] {
    if (!body || typeof body !== "object") return [];
    const r = wechatMessageToActivity(body as WeChatXml);
    return r ? [{ network: "wechat", accountExternalId: r.accountExternalId, items: [r.item] }] : [];
  }

  // ---- transport ------------------------------------------------------------------------

  /** A valid access token for this AppID, from the cache or stable_token. */
  async accessToken(auth: WeChatAuth, opts: { forceRefresh?: boolean; reject?: string } = {}): Promise<string> {
    const cached = this.tokens.get(auth.appId);
    if (!opts.forceRefresh && cached && cached.token !== opts.reject && cached.expiresAt - TOKEN_MARGIN_MS > this.now().getTime()) return cached.token;
    const key = `${auth.appId}:${opts.forceRefresh ? "force" : "normal"}`;
    const inflight = this.inflightTokens.get(key);
    if (inflight) return inflight;
    const p = this.fetchToken(auth, opts.forceRefresh === true).finally(() => this.inflightTokens.delete(key));
    this.inflightTokens.set(key, p);
    return p;
  }

  private async fetchToken(auth: WeChatAuth, forceRefresh: boolean): Promise<string> {
    const body = await this.request(`${this.apiBase}/cgi-bin/stable_token`, "POST", { grant_type: "client_credential", appid: auth.appId, secret: auth.appSecret, ...(forceRefresh ? { force_refresh: true } : {}) }, "stable_token", auth);
    const b = body as { access_token?: string; expires_in?: number };
    if (!b.access_token) throw new ConnectorError("wechat stable_token: no access token in the response", "unknown", false);
    this.tokens.set(auth.appId, { token: b.access_token, expiresAt: this.now().getTime() + (b.expires_in ?? 7200) * 1000 });
    return b.access_token;
  }

  /** Call /cgi-bin/<path> with the account's access token, refreshing it once on 40001/42001/40014. */
  private async call(auth: WeChatAuth, path: string, method: "GET" | "POST", payload?: unknown): Promise<unknown> {
    const token = await this.accessToken(auth);
    try {
      return await this.request(`${this.apiBase}/cgi-bin/${path}?access_token=${encodeURIComponent(token)}`, method, payload, path, auth, token);
    } catch (e) {
      if (!isTokenError(e)) throw e;
      this.tokens.delete(auth.appId);
      // stable_token in normal mode returns the token WeChat considers current; if that is the one just rejected,
      // force a new one (force_refresh is limited to ~20 a day, so only then).
      let next = await this.accessToken(auth, { reject: token });
      if (next === token) next = await this.accessToken(auth, { forceRefresh: true });
      return this.request(`${this.apiBase}/cgi-bin/${path}?access_token=${encodeURIComponent(next)}`, method, payload, path, auth, next);
    }
  }

  private async request(url: string, method: "GET" | "POST", payload: unknown, context: string, auth: WeChatAuth, token?: string): Promise<unknown> {
    const secrets = [auth.appSecret, auth.token, auth.encodingAesKey, token];
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url, method === "POST" ? { method, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload ?? {}) } : { method });
    } catch (err) {
      // The URL carries the access token and the body the secret; report only the API name.
      throw asNetworkError(new Error(scrub(err instanceof Error ? err.message : String(err), secrets)), `wechat ${context}`);
    }
    const body = await readJson(res);
    const b = (body && typeof body === "object" ? body : {}) as { errcode?: number; errmsg?: string };
    if (typeof b.errcode === "number" && b.errcode !== 0) throw mapWeChatError(b.errcode, scrub(String(b.errmsg ?? ""), secrets), context);
    if (!res.ok) {
      const { kind, retryable } = classifyHttpStatus(res.status);
      throw new ConnectorError(`wechat ${context}: HTTP ${res.status}`, kind, retryable);
    }
    return body ?? {};
  }
}

function parseAuth(account: AccountRef): WeChatAuth {
  const parsed = WeChatAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`wechat account ${account.handle}: auth needs appId, appSecret, originalId and token`, "auth", false);
  return parsed.data;
}

export function createWeChatConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new WeChatConnector({ ...(env.STARSIGN_PUBLIC_URL ? { publicUrl: env.STARSIGN_PUBLIC_URL } : {}), ...(env.WECHAT_API_BASE ? { apiBase: env.WECHAT_API_BASE } : {}) })];
}
