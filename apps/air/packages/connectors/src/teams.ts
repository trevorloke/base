import { createHash } from "node:crypto";
import type { ActivityInput, MetricInput, Network } from "@base-air/schema";
import { z } from "zod";
import { asNetworkError, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Microsoft Teams channels through a Workflows webhook (Power Automate), the replacement for the retired Office 365
 * connectors / "Incoming Webhook". A team member creates a workflow from the template "Send webhook alerts to a
 * channel" (trigger "When a Teams webhook request is received", action "Post card in a chat or channel") and pastes
 * the HTTP URL. The URL is signed (`sig=` query parameter), so the POST needs no other credentials.
 *
 * Posts are one Adaptive Card per message (text, optional image, optional link button) in the documented envelope
 * `{ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content }] }`.
 * The workflow answers 202 Accepted with no message id: base air cannot edit, delete, read or measure what it posted.
 * Reading channels needs Microsoft Graph with tenant admin consent (and Microsoft's protected-API approval for
 * message reads): a later step.
 */

/** Workflows accept Adaptive Cards up to 1.4 (1.5 cards did not render in reports); payloads up to ~28 KB. */
const CARD_VERSION = "1.4";
const LIMITS = { payloadBytes: 28_000, media: 1 } as const;

// TODO(verify): Microsoft documents no host list. Seen in the wild: prod-NN.<region>.logic.azure.com (older flows) and
// <env>.<nn>.environment.api.powerplatform.com (flows created since mid-2025).
const HOST = /^(?:[a-z0-9-]+\.)+logic\.azure\.com$|^(?:[a-z0-9-]+\.)+environment\.api\.powerplatform\.com$/i;
const WORKFLOW_PATH = /\/workflows\/([A-Za-z0-9-]{8,})\/triggers\/[^/]+\/paths\/invoke\/?$/;

export const TeamsAuth = z.object({ webhookUrl: z.string().url() });
export type TeamsAuth = z.infer<typeof TeamsAuth>;

export interface ParsedTeamsWebhook {
  workflowId: string;
  host: string;
  url: string;
  sig: string;
}

/** A Workflows webhook URL (https, Power Automate / Logic Apps host, …/workflows/<id>/triggers/…/paths/invoke, signed) → parts, or null. */
export function parseTeamsWebhookUrl(raw: string): ParsedTeamsWebhook | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.port && u.port !== "443")) return null;
  if (!HOST.test(u.hostname)) return null;
  const m = u.pathname.match(WORKFLOW_PATH);
  const sig = u.searchParams.get("sig");
  if (!m?.[1] || !sig) return null;
  u.port = "";
  return { workflowId: m[1], host: u.hostname, url: u.toString(), sig };
}

/** The legacy Office 365 connector URLs (retired). Recognized only to give a helpful error. */
export function isLegacyTeamsWebhook(raw: string): boolean {
  return /^https:\/\/[^/]*\.webhook\.office\.com\/webhookb2\//i.test(raw.trim()) || /^https:\/\/outlook\.office\.com\/webhook\//i.test(raw.trim());
}

/** The message envelope with one Adaptive Card: a wrapped TextBlock (Teams renders its markdown subset), an image, a link button. */
export function teamsCardMessage(p: { text: string; title?: string; link?: string; imageUrl?: string; imageAlt?: string }): Record<string, unknown> {
  const body: Record<string, unknown>[] = [];
  if (p.title) body.push({ type: "TextBlock", text: p.title, weight: "Bolder", size: "Medium", wrap: true });
  if (p.text) body.push({ type: "TextBlock", text: p.text, wrap: true });
  if (p.imageUrl) body.push({ type: "Image", url: p.imageUrl, altText: p.imageAlt ?? "", size: "Stretch" });
  const content: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: CARD_VERSION,
    body,
    msteams: { width: "Full" },
  };
  if (p.link) content.actions = [{ type: "Action.OpenUrl", title: "Open link", url: p.link }];
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content }] };
}

interface TeamsFailure {
  status: number;
  code?: string;
  retryAfter?: number;
}

/** HTTP → ConnectorError without the URL (its `sig` is the credential). */
export function mapTeamsError(status: number, headers: Headers, body: unknown, what: string): ConnectorError {
  const b = (body && typeof body === "object" ? body : {}) as { error?: { code?: string; message?: string } };
  const code = b.error?.code;
  const msg = `teams ${what}: HTTP ${status}${code ? ` ${code}` : ""}${b.error?.message ? ` ${b.error.message.slice(0, 300)}` : typeof body === "string" && body.length < 300 ? ` ${body}` : ""}`;
  const cause: TeamsFailure = { status, ...(code ? { code } : {}) };
  if (status === 429) {
    const after = Number(headers.get("retry-after") ?? NaN);
    return new ConnectorError(`${msg} (rate limited${Number.isFinite(after) ? `; retry after ${after}s` : ""})`, "rate_limit", true, { ...cause, ...(Number.isFinite(after) ? { retryAfter: after } : {}) });
  }
  // TODO(verify): a turned-off or deleted flow answers 404 WorkflowNotFound / 409 WorkflowDisabled (Logic Apps codes); a bad sig 401.
  if (status === 401 || status === 403 || status === 404) return new ConnectorError(`${msg} (the workflow was deleted, turned off, or its URL changed; reconnect with the current URL)`, "auth", false, cause);
  if (status === 409 && /disabled/i.test(code ?? "")) return new ConnectorError(`${msg} (the workflow is turned off in Power Automate)`, "auth", false, cause);
  if (status >= 500) return new ConnectorError(msg, "network", true, cause);
  if (status >= 400) return new ConnectorError(msg, "rejected", false, cause);
  return new ConnectorError(msg, "unknown", false, cause);
}

export interface TeamsConnectorOptions {
  fetch?: FetchLike;
}

export class TeamsConnector implements Connector {
  readonly name = "teams";
  readonly networks: readonly Network[] = ["teams"];
  readonly connectMethod = "webhook_url" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [{ key: "webhookUrl", label: "Workflow webhook URL (Teams → Workflows → \"Send webhook alerts to a channel\")", placeholder: "https://….environment.api.powerplatform.com/powerautomate/automations/direct/workflows/…/triggers/manual/paths/invoke?…&sig=…", secret: true }] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly idempotency = new IdempotencyCache<PublishResult>();

  constructor(opts: TeamsConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
  }

  capabilities(): ConnectorCapabilities {
    // The workflow only posts: no message id comes back, so no inbox, replies, deletes or metrics.
    return { publish: true, fetchActivity: false, fetchMetrics: false, meteredReads: false, reply: false, moderate: false, accountMetrics: false, webhooks: false, video: false, kinds: ["post", "link"] };
  }

  /** Checks the URL only: a workflow has no read endpoint, and connecting must not post into the channel. */
  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const raw = p.inputs.webhookUrl ?? "";
    if (isLegacyTeamsWebhook(raw)) throw new ConnectorError("teams: that is a retired Office 365 connector URL; create a workflow (Teams → Workflows → \"Send webhook alerts to a channel\") and paste its URL", "auth", false);
    const hook = parseTeamsWebhookUrl(raw);
    if (!hook) throw new ConnectorError("teams: paste the workflow's HTTP URL (it contains /workflows/<id>/triggers/manual/paths/invoke and sig=…)", "auth", false);
    return [{ network: "teams", identity: identityOf(hook), auth: { webhookUrl: hook.url }, config: { workflowId: hook.workflowId, host: hook.host } }];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const hook = parseTeamsWebhookUrl(typeof auth.webhookUrl === "string" ? auth.webhookUrl : "");
    if (!hook) throw new ConnectorError("teams: webhookUrl is required", "auth", false);
    return identityOf(hook);
  }

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.text.trim() && input.media.length === 0 && !input.options?.link) issues.push({ code: "empty", message: "teams messages need text, an image or a link" });
    if (input.thread.length > 0) issues.push({ code: "thread_unsupported", message: "teams workflow posts are single messages" });
    if (input.media.length > LIMITS.media) issues.push({ code: "too_many_media", message: "the teams connector posts one image per message" });
    const m = input.media[0];
    if (m) {
      if (m.kind !== "image" && m.kind !== "gif") issues.push({ code: "unsupported_media", message: "teams adaptive cards show images only (link videos instead)" });
      if (!/^https:\/\//i.test(m.url)) issues.push({ code: "unsupported_media", message: "teams loads card images itself: the image URL must be public HTTPS" });
    }
    if (Buffer.byteLength(JSON.stringify(this.message(input)), "utf8") > LIMITS.payloadBytes) issues.push({ code: "too_long", message: `teams cards are at most about ${LIMITS.payloadBytes / 1000} KB`, segment: 0 });
    return issues;
  }

  private message(input: PublishInput): Record<string, unknown> {
    const opts = input.options ?? {};
    const img = input.media[0];
    return teamsCardMessage({ text: input.text, ...(opts.title ? { title: opts.title } : {}), ...(opts.link ? { link: opts.link } : {}), ...(img ? { imageUrl: img.url, imageAlt: img.alt ?? "" } : {}) });
  }

  /**
   * POST the card. The workflow answers 202 with no body: externalId is the run id (x-ms-workflow-run-id) when the
   * response carries one, else derived from the idempotency key. A 202 means the flow accepted the request, not that
   * the card reached the channel (the flow's run history in Power Automate shows failures).
   */
  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`teams publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const hook = parseAuth(account);
      let res: Response;
      try {
        res = await resolveFetch(this.fetchImpl)(hook.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(this.message(input)) });
      } catch (err) {
        const scrub = (s: string) => s.replace(/([?&]sig=)[^&\s"']+/g, "$1<sig>").replaceAll(hook.sig, "<sig>").replaceAll(encodeURIComponent(hook.sig), "<sig>");
        throw asNetworkError(new Error(scrub(err instanceof Error ? err.message : String(err))), "teams post");
      }
      const body = await readJson(res);
      if (!res.ok) throw mapTeamsError(res.status, res.headers, body, "post");
      // TODO(verify): x-ms-workflow-run-id is the Logic Apps run header; Power Platform direct URLs may not send it.
      const runId = res.headers.get("x-ms-workflow-run-id");
      const externalId = `${hook.workflowId}:${runId ?? `k-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 20)}`}`;
      return { externalId, url: null, raw: { status: res.status, runId, body } };
    });
  }

  async fetchActivity(): Promise<ActivityInput[]> {
    return [];
  }

  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }
}

function identityOf(hook: ParsedTeamsWebhook): AccountIdentity {
  return { externalId: hook.workflowId, handle: `Teams workflow ${hook.workflowId.slice(0, 8)}`, displayName: null };
}

function parseAuth(account: AccountRef): ParsedTeamsWebhook {
  const hook = parseTeamsWebhookUrl(typeof account.auth?.webhookUrl === "string" ? account.auth.webhookUrl : "");
  if (!hook) throw new ConnectorError(`teams account ${account.handle}: auth blob needs a workflow webhookUrl`, "auth", false);
  return hook;
}

export function createTeamsConnectors(_env: NodeJS.ProcessEnv): Connector[] {
  return [new TeamsConnector()];
}
