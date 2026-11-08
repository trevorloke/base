import type { ActivityInput, MetricInput, Network } from "@base-air/schema";
import { z } from "zod";
import { escapeHtml, firstLine, httpFailure, safeUrl, textToHtml } from "./html.ts";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Mailchimp Marketing API v3 with an API key ("<32 hex>-<data center>", e.g. "…-us6"; the data center picks the host
 * https://<dc>.api.mailchimp.com/3.0). One account = one audience (list).
 *
 * Publishing a Base Air post sends a regular campaign to the whole audience: create the campaign, set its HTML content,
 * check Mailchimp's send checklist, then send. Base Air already schedules, so the campaign is sent immediately.
 * Images are referenced by their public Base Air media URLs.
 *
 * Mailchimp OAuth (for agencies connecting clients' accounts) is a later step; see docs/integrations/mailchimp.md.
 */

export const MailchimpAuth = z.object({ apiKey: z.string().regex(/^[0-9a-f]{32}-[a-z]+\d+$/i, "not a Mailchimp API key") });
export type MailchimpAuth = z.infer<typeof MailchimpAuth>;

export interface MailchimpConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  /** Override the API host (tests, proxies). Default https://<dc>.api.mailchimp.com/3.0. */
  apiBase?: string;
}

/** Mailchimp's subject line limit. TODO(verify): 150 characters is the documented maximum. */
export const MAILCHIMP_SUBJECT_MAX = 150;

export function mailchimpDataCenter(apiKey: string): string {
  return apiKey.split("-").pop() ?? "";
}

interface MailchimpList {
  id: string;
  name: string;
  stats?: { member_count?: number };
  campaign_defaults?: { from_name?: string; from_email?: string; subject?: string; language?: string };
}

interface CampaignProgress {
  campaignId?: string;
  urls?: { archive: string | null };
  contentSet?: boolean;
}

function mailchimpError(prefix: string, status: number, body: unknown, headers: Headers, now: Date): ConnectorError {
  const b = (typeof body === "object" && body !== null ? body : {}) as { title?: string; detail?: string; errors?: { field?: string; message?: string }[] };
  const fields = (b.errors ?? []).map((e) => [e.field, e.message].filter(Boolean).join(": ")).filter(Boolean);
  const detail = [b.title, b.detail].filter(Boolean).join(": ") + (fields.length ? ` (${fields.join("; ")})` : "");
  return httpFailure(prefix, status, detail || (typeof body === "string" ? body.slice(0, 200) : ""), headers, body, { now });
}

/** The campaign's subject line: options.title, else the post's first line. */
export function mailchimpSubject(input: PublishInput): string {
  return (input.options?.title?.trim() || firstLine(input.text)).trim();
}

/**
 * A complete email document. Mailchimp requires an unsubscribe link and the audience's postal address in every
 * campaign, so a footer with *|UNSUB|* and *|LIST:ADDRESSLINE|* is added unless the body already carries *|UNSUB|*.
 * TODO(verify): whether Mailchimp would append its own compliance footer to custom HTML without *|UNSUB|*.
 */
export function mailchimpHtml(input: PublishInput, subject: string): string {
  const images = input.media.filter((m) => m.kind === "image" || m.kind === "gif");
  const body = textToHtml(input.text, { link: input.options?.link });
  const imgs = images
    .map((m) => {
      const u = safeUrl(m.url);
      return u ? `<p><img src="${escapeHtml(u)}" alt="${escapeHtml(m.alt ?? "")}" style="max-width:100%;height:auto;display:block"></p>` : "";
    })
    .filter(Boolean)
    .join("\n");
  const footer = input.text.includes("*|UNSUB|*")
    ? ""
    : `<hr style="border:none;border-top:1px solid #ddd;margin:32px 0 16px"><p style="font-size:12px;color:#666">*|LIST:ADDRESSLINE|*<br><a href="*|UNSUB|*">Unsubscribe</a> · <a href="*|UPDATE_PROFILE|*">Update preferences</a></p>`;
  return [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>`,
    `<body style="margin:0;padding:24px;background:#ffffff"><div style="max-width:640px;margin:0 auto;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222">`,
    body,
    imgs,
    footer,
    "</div></body></html>",
  ]
    .filter(Boolean)
    .join("\n");
}

export class MailchimpConnector implements Connector {
  readonly name = "mailchimp";
  readonly networks: readonly Network[] = ["mailchimp"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "apiKey", label: "API key (Profile → Extras → API keys)", placeholder: "0123…cdef-us6", secret: true },
    { key: "audienceId", label: "Audience ID (optional; default: your first audience)", placeholder: "a1b2c3d4e5", optional: true },
    { key: "fromName", label: "From name (optional; default: the audience's)", optional: true },
    { key: "replyTo", label: "Reply-to email (optional; default: the audience's)", placeholder: "news@example.com", optional: true },
  ] as const;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly apiBase: string | undefined;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  /** Steps already done for an idempotency key, so a retry continues the same campaign instead of creating another. */
  private readonly progress = new Map<string, CampaignProgress>();

  constructor(opts: MailchimpConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.apiBase = opts.apiBase?.replace(/\/+$/, "");
  }

  capabilities(): ConnectorCapabilities {
    // Email has no inbox here: replies go to the reply-to mailbox, not through the API.
    return { publish: true, fetchActivity: false, fetchMetrics: true, meteredReads: false, reply: false, moderate: false, accountMetrics: true, webhooks: false, video: false, kinds: ["post", "link"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const parsed = MailchimpAuth.safeParse({ apiKey: (p.inputs.apiKey ?? "").trim() });
    if (!parsed.success) throw new ConnectorError("mailchimp: that does not look like an API key (32 hex characters, a dash and the data center, e.g. -us6)", "auth", false);
    const auth = parsed.data;
    const list = await this.verify(auth, (p.inputs.audienceId ?? "").trim() || null);
    const fromName = (p.inputs.fromName ?? "").trim() || list.campaign_defaults?.from_name || null;
    const replyTo = (p.inputs.replyTo ?? "").trim() || list.campaign_defaults?.from_email || null;
    if (replyTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyTo)) throw new ConnectorError(`mailchimp: "${replyTo}" is not an email address`, "rejected", false);
    return [
      {
        network: "mailchimp",
        identity: { externalId: list.id, handle: list.name, displayName: list.name },
        auth: { ...auth },
        config: { dc: mailchimpDataCenter(auth.apiKey), listId: list.id, listName: list.name, fromName, replyTo },
      },
    ];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = MailchimpAuth.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("mailchimp: apiKey is required", "auth", false, parsed.error);
    const listId = typeof raw.listId === "string" ? raw.listId : null;
    const list = await this.verify(parsed.data, listId);
    return { externalId: list.id, handle: list.name, displayName: list.name };
  }

  /** GET /ping, then the chosen audience (or the oldest one). */
  private async verify(auth: MailchimpAuth, audienceId: string | null): Promise<MailchimpList> {
    await this.request(auth, "GET", "/ping", {}, "ping");
    if (audienceId) return this.request<MailchimpList>(auth, "GET", `/lists/${encodeURIComponent(audienceId)}`, { query: { fields: "id,name,stats.member_count,campaign_defaults" } }, "audience");
    const res = await this.request<{ lists?: MailchimpList[] }>(auth, "GET", "/lists", { query: { count: 1, sort_field: "date_created", sort_dir: "ASC", fields: "lists.id,lists.name,lists.stats.member_count,lists.campaign_defaults" } }, "audiences");
    const list = res.lists?.[0];
    if (!list) throw new ConnectorError("mailchimp: this account has no audience; create one in Mailchimp first", "rejected", false);
    return list;
  }

  // ---- publish --------------------------------------------------------------------------

  validate(account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const subject = mailchimpSubject(input);
    if (!subject) issues.push({ code: "empty", message: "mailchimp campaigns need a subject line (options.title or a first line of text)" });
    else if ([...subject].length > MAILCHIMP_SUBJECT_MAX) issues.push({ code: "too_long", message: `mailchimp subject line is ${[...subject].length} > ${MAILCHIMP_SUBJECT_MAX} characters` });
    const c = account.config;
    if (typeof c.fromName !== "string" || !c.fromName || typeof c.replyTo !== "string" || !c.replyTo) {
      issues.push({ code: "empty", message: "mailchimp: the audience has no default From name and reply-to email; set them in Mailchimp (Audience → Settings → Audience name and defaults) and reconnect" });
    }
    for (const m of input.media) if (m.kind === "video" || m.kind === "document") issues.push({ code: "unsupported_media", message: `mailchimp: emails cannot carry ${m.kind} attachments; link to them in the text` });
    if (input.options?.poll) issues.push({ code: "unsupported_media", message: "mailchimp has no polls" });
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const key = input.idempotencyKey;
      const subject = mailchimpSubject(input);
      if (!subject) throw new ConnectorError("mailchimp publish: a subject line is required", "rejected", false);
      const listId = typeof account.config.listId === "string" ? account.config.listId : account.externalId;
      const p: CampaignProgress = this.progress.get(key) ?? {};
      this.progress.set(key, p);

      if (!p.campaignId) {
        const { fromName, replyTo } = await this.senderFor(auth, account, listId);
        const campaign = await this.request<{ id: string; archive_url?: string; long_archive_url?: string }>(
          auth,
          "POST",
          "/campaigns",
          { json: { type: "regular", recipients: { list_id: listId }, settings: { subject_line: subject, title: subject.slice(0, 100), from_name: fromName, reply_to: replyTo } } },
          "create campaign",
        );
        p.campaignId = campaign.id;
        p.urls = { archive: campaign.long_archive_url ?? campaign.archive_url ?? null };
      }
      const id = p.campaignId;
      if (!p.contentSet) {
        await this.request(auth, "PUT", `/campaigns/${id}/content`, { json: { html: mailchimpHtml(input, subject) } }, "set content");
        p.contentSet = true;
      }
      const checklist = await this.request<{ is_ready?: boolean; items?: { type?: string; heading?: string; details?: string }[] }>(auth, "GET", `/campaigns/${id}/send-checklist`, {}, "send checklist");
      if (checklist.is_ready === false) {
        const problems = (checklist.items ?? []).filter((i) => i.type === "error").map((i) => [i.heading, i.details].filter(Boolean).join(": "));
        throw new ConnectorError(`mailchimp publish: campaign ${id} is not ready to send: ${problems.join("; ") || "see Mailchimp"}`, "rejected", false, checklist);
      }
      await this.request(auth, "POST", `/campaigns/${id}/actions/send`, {}, "send");
      this.progress.delete(key);
      return { externalId: id, url: p.urls?.archive ?? null, raw: { campaignId: id } };
    });
  }

  /** From name and reply-to: the account config (set at connect), else the audience's campaign defaults now. */
  private async senderFor(auth: MailchimpAuth, account: AccountRef, listId: string): Promise<{ fromName: string; replyTo: string }> {
    let fromName = typeof account.config.fromName === "string" ? account.config.fromName : "";
    let replyTo = typeof account.config.replyTo === "string" ? account.config.replyTo : "";
    if (!fromName || !replyTo) {
      const list = await this.request<MailchimpList>(auth, "GET", `/lists/${encodeURIComponent(listId)}`, { query: { fields: "id,name,campaign_defaults" } }, "audience defaults");
      fromName ||= list.campaign_defaults?.from_name ?? "";
      replyTo ||= list.campaign_defaults?.from_email ?? "";
    }
    if (!fromName || !replyTo) throw new ConnectorError("mailchimp publish: the audience has no default From name and reply-to email", "rejected", false);
    return { fromName, replyTo };
  }

  // ---- inbox and metrics ----------------------------------------------------------------

  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  /**
   * GET /reports/{campaign_id}: reach = emails_sent, impressions = opens.opens_total, clicks = clicks.clicks_total,
   * link_clicks = clicks.unique_subscriber_clicks, shares = forwards.forwards_count. Campaigns without a report yet
   * (still sending, deleted) are skipped.
   */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      let r: { emails_sent?: number; opens?: { opens_total?: number; unique_opens?: number }; clicks?: { clicks_total?: number; unique_subscriber_clicks?: number }; forwards?: { forwards_count?: number } };
      try {
        r = await this.request(auth, "GET", `/reports/${encodeURIComponent(id)}`, { query: { fields: "id,emails_sent,opens,clicks,forwards" } }, "report");
      } catch (err) {
        if (err instanceof ConnectorError && err.kind === "rejected") continue;
        throw err;
      }
      const row = (metric: MetricInput["metric"], value: number | undefined) => {
        if (typeof value === "number") out.push({ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "mailchimp" });
      };
      row("reach", r.emails_sent);
      row("impressions", r.opens?.opens_total);
      row("clicks", r.clicks?.clicks_total);
      row("link_clicks", r.clicks?.unique_subscriber_clicks);
      row("shares", r.forwards?.forwards_count);
    }
    return out;
  }

  /** followers_total = the audience's subscribed member count. */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const listId = typeof account.config.listId === "string" ? account.config.listId : account.externalId;
    const list = await this.request<MailchimpList>(parseAuth(account), "GET", `/lists/${encodeURIComponent(listId)}`, { query: { fields: "id,stats.member_count" } }, "audience stats");
    const n = list.stats?.member_count;
    if (typeof n !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: n, observedAt: this.now().toISOString(), source: "mailchimp" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async request<T>(auth: MailchimpAuth, method: string, path: string, opts: { query?: Record<string, string | number>; json?: unknown }, what: string): Promise<T> {
    const base = this.apiBase ?? `https://${mailchimpDataCenter(auth.apiKey)}.api.mailchimp.com/3.0`;
    const qs = new URLSearchParams(Object.entries(opts.query ?? {}).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`base-air:${auth.apiKey}`).toString("base64")}`, accept: "application/json" };
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(`${base}${path}${qs ? `?${qs}` : ""}`, { method, headers, ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}) });
    } catch (err) {
      throw asNetworkError(err, `mailchimp ${what}`);
    }
    const body = await readJson(res);
    if (!res.ok) throw mailchimpError(`mailchimp ${what}`, res.status, body, res.headers, this.now());
    return body as T;
  }
}

function parseAuth(account: AccountRef): MailchimpAuth {
  const parsed = MailchimpAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`mailchimp account ${account.handle}: auth blob needs apiKey`, "auth", false, parsed.error);
  return parsed.data;
}

export function createMailchimpConnectors(_env: NodeJS.ProcessEnv): Connector[] {
  return [new MailchimpConnector()];
}
