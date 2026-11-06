import type { ActivityInput, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { firstLine, httpFailure, safeUrl, textToHtml } from "./html.ts";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Kit (formerly ConvertKit) API v4 with a v4 API key in the `X-Kit-Api-Key` header. One account = one Kit account.
 *
 * Publishing a Starsign post creates a broadcast with `send_at` = now, so Kit sends it right away (Starsign already
 * scheduled it). `public: true` also publishes it to the creator's web newsletter feed; that is the default, and
 * options.visibility "unlisted"/"private"/"direct" keeps it email-only.
 *
 * Kit OAuth (for apps listed in the Kit App Store) is a later step; see docs/integrations/kit.md.
 */

export const KitAuth = z.object({ apiKey: z.string().min(10, "not a Kit API key") });
export type KitAuth = z.infer<typeof KitAuth>;

export interface KitConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  apiBase?: string;
}

/** Fields of a v4 broadcast we read. */
export interface KitBroadcast {
  id: number | string;
  subject?: string;
  public?: boolean;
  public_url?: string | null;
  send_at?: string | null;
  published_at?: string | null;
}

/** Fields of GET /v4/broadcasts/{id}/stats → broadcast.stats. TODO(verify): emails_opened and total_clicks on this endpoint. */
export interface KitBroadcastStats {
  recipients?: number;
  open_rate?: number;
  emails_opened?: number;
  click_rate?: number;
  total_clicks?: number;
  unsubscribes?: number;
  status?: string;
}

// TODO(verify): API-key rate limit (about 120 requests per rolling 60 s) and whether 429s carry Retry-After.
function kitError(prefix: string, status: number, body: unknown, headers: Headers, now: Date): ConnectorError {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  const detail = Array.isArray(errors) ? errors.filter((e) => typeof e === "string").join("; ") : typeof body === "string" ? body.slice(0, 200) : "";
  return httpFailure(prefix, status, detail, headers, body, { now });
}

export function kitSubject(input: PublishInput): string {
  return (input.options?.title?.trim() || firstLine(input.text)).trim();
}

/**
 * Canonical metrics from broadcast stats: reach = recipients, impressions = emails opened, clicks = total clicks,
 * link_clicks = unique clickers (recipients × click_rate). Rates are read as percentages (0–100). When a count is
 * missing it is derived from its rate. TODO(verify): rate units.
 */
export function kitStatsToMetrics(entityId: string, s: KitBroadcastStats, observedAt: string): MetricInput[] {
  const out: MetricInput[] = [];
  const row = (metric: MetricInput["metric"], value: number | undefined) => {
    if (typeof value === "number" && Number.isFinite(value)) out.push({ entityType: "post_variant", entityId, metric, value, observedAt, source: "kit" });
  };
  const recipients = s.recipients;
  const fromRate = (rate: number | undefined) => (typeof recipients === "number" && typeof rate === "number" ? Math.round((recipients * rate) / 100) : undefined);
  row("reach", recipients);
  row("impressions", s.emails_opened ?? fromRate(s.open_rate));
  row("clicks", s.total_clicks);
  row("link_clicks", fromRate(s.click_rate));
  return out;
}

export class KitConnector implements Connector {
  readonly name = "kit";
  readonly networks: readonly Network[] = ["kit"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [{ key: "apiKey", label: "Kit v4 API key (Settings → Developer → API keys)", placeholder: "kit_…", secret: true }] as const;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly apiBase: string;
  private readonly idempotency = new IdempotencyCache<PublishResult>();

  constructor(opts: KitConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.apiBase = (opts.apiBase ?? "https://api.kit.com/v4").replace(/\/+$/, "");
  }

  capabilities(): ConnectorCapabilities {
    return { publish: true, fetchActivity: false, fetchMetrics: true, meteredReads: false, reply: false, moderate: false, accountMetrics: true, webhooks: false, video: false, kinds: ["post", "link"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const parsed = KitAuth.safeParse({ apiKey: (p.inputs.apiKey ?? "").trim() });
    if (!parsed.success) throw new ConnectorError("kit: enter a v4 API key (v3 API secrets do not work with v4)", "auth", false);
    const { identity, account } = await this.verify(parsed.data);
    return [{ network: "kit", identity, auth: { ...parsed.data }, config: { accountId: identity.externalId, plan: account.plan_type ?? null } }];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = KitAuth.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("kit: apiKey is required", "auth", false, parsed.error);
    return (await this.verify(parsed.data)).identity;
  }

  /** GET /v4/account → { user: { email }, account: { id, name, plan_type, primary_email_address } }. */
  private async verify(auth: KitAuth): Promise<{ identity: AccountIdentity; account: { id?: number | string; name?: string; plan_type?: string; primary_email_address?: string } }> {
    const res = await this.request<{ account?: { id?: number | string; name?: string; plan_type?: string; primary_email_address?: string } }>(auth, "GET", "/account", {}, "account");
    const account = res.account ?? {};
    if (account.id === undefined) throw new ConnectorError("kit: /account returned no account id", "unknown", false, res);
    const id = String(account.id);
    return { identity: { externalId: id, handle: account.name || account.primary_email_address || `kit-${id}`, displayName: account.name ?? null }, account };
  }

  // ---- publish --------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!kitSubject(input)) issues.push({ code: "empty", message: "kit broadcasts need a subject (options.title or a first line of text)" });
    for (const m of input.media) if (m.kind === "video" || m.kind === "document") issues.push({ code: "unsupported_media", message: `kit: emails cannot carry ${m.kind} attachments; link to them in the text` });
    if (input.options?.poll) issues.push({ code: "unsupported_media", message: "kit has no polls" });
    return issues;
  }

  /**
   * POST /v4/broadcasts { subject, content, public, published_at, send_at: now, thumbnail_url/alt }. No
   * subscriber_filter: Kit sends to all subscribers. TODO(verify): that omitting subscriber_filter means everyone and
   * that a send_at of "now" sends immediately rather than being refused as in the past.
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const o = input.options ?? {};
      const subject = kitSubject(input);
      if (!subject) throw new ConnectorError("kit publish: a subject is required", "rejected", false);
      const images = input.media.filter((m) => m.kind === "image" || m.kind === "gif");
      const content = textToHtml(input.text, { link: o.link, images: images.map((m) => ({ src: m.url, alt: m.alt })) });
      const isPublic = (o.visibility ?? "public") === "public";
      const now = this.now().toISOString();
      const thumb = o.thumbnailUrl ?? images[0]?.url;
      const body = {
        subject,
        content,
        public: isPublic,
        ...(isPublic ? { published_at: now } : {}),
        send_at: now,
        ...(thumb && safeUrl(thumb) ? { thumbnail_url: thumb, thumbnail_alt: o.thumbnailUrl ? subject : (images[0]?.alt ?? subject) } : {}),
      };
      const res = await this.request<{ broadcast?: KitBroadcast }>(auth, "POST", "/broadcasts", { json: body }, "create broadcast");
      const b = res.broadcast;
      if (b?.id === undefined) throw new ConnectorError("kit publish: Kit returned no broadcast", "unknown", false, res);
      return { externalId: String(b.id), url: b.public_url ?? null, raw: b };
    });
  }

  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  // ---- metrics --------------------------------------------------------------------------

  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      let stats: KitBroadcastStats | undefined;
      try {
        stats = (await this.request<{ broadcast?: { stats?: KitBroadcastStats } }>(auth, "GET", `/broadcasts/${encodeURIComponent(id)}/stats`, {}, "broadcast stats")).broadcast?.stats;
      } catch (err) {
        // 404 (deleted) and 400 (outside Kit's 60-month stats window) mean "no numbers", not a failed poll.
        if (err instanceof ConnectorError && err.kind === "rejected") continue;
        throw err;
      }
      if (stats) out.push(...kitStatsToMetrics(id, stats, observedAt));
    }
    return out;
  }

  /** followers_total = active subscribers. TODO(verify): include_total_count=true returns pagination.total_count. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const res = await this.request<{ pagination?: { total_count?: number } }>(parseAuth(account), "GET", "/subscribers", { query: { per_page: 1, include_total_count: "true", status: "active" } }, "subscribers");
    const total = res.pagination?.total_count;
    if (typeof total !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: total, observedAt: this.now().toISOString(), source: "kit" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async request<T>(auth: KitAuth, method: string, path: string, opts: { query?: Record<string, string | number>; json?: unknown }, what: string): Promise<T> {
    const qs = new URLSearchParams(Object.entries(opts.query ?? {}).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const headers: Record<string, string> = { "x-kit-api-key": auth.apiKey, accept: "application/json" };
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${this.apiBase}${path}${qs ? `?${qs}` : ""}`, { method, headers, ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}) });
    } catch (err) {
      throw asNetworkError(err, `kit ${what}`);
    }
    const body = await readJson(res);
    if (!res.ok) throw kitError(`kit ${what}`, res.status, body, res.headers, this.now());
    return body as T;
  }
}

function parseAuth(account: AccountRef): KitAuth {
  const parsed = KitAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`kit account ${account.handle}: auth blob needs apiKey`, "auth", false, parsed.error);
  return parsed.data;
}

export function createKitConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new KitConnector({ ...(env.KIT_API_BASE ? { apiBase: env.KIT_API_BASE } : {}) })];
}
