import { createHmac } from "node:crypto";
import type { ActivityInput, Media, MetricInput, Network, VariantOptions } from "@base-air/schema";
import { z } from "zod";
import { htmlToText, httpFailure, normalizeSiteUrl, siteKey, textToHtml, uploadFileName } from "./html.ts";
import { asNetworkError, downloadMedia, isoSeconds, readJson, resolveFetch, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { AccountIdentity, AccountRef, ConnectedAccount, Connector, ConnectorCapabilities, MediaFetcher, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Ghost through the Admin API, authenticated with a custom integration's Admin API key ("<24 hex id>:<64 hex secret>").
 * Every request carries a fresh 5-minute HS256 JWT (kid = key id, aud = "/admin/") signed with the hex-decoded secret,
 * exactly as @tryghost/admin-api does, plus `Accept-Version: v6.0`.
 *
 * Newsletters: when the account config has a `newsletter` slug (entered at connect), a post is also emailed to that
 * newsletter when the variant's tags include `#newsletter` (stripped before sending), or on every publish when the
 * config has `emailEveryPost: true`. `emailSegment` in config overrides the recipient filter ("all", "status:free",
 * "status:-free"); by default paid-only posts go to paying members and everything else to all.
 */

export const GhostAuth = z.object({
  apiUrl: z.string().url(),
  adminApiKey: z.string().regex(/^[0-9a-f]{24}:[0-9a-f]{64}$/i, "not a Ghost Admin API key"),
});
export type GhostAuth = z.infer<typeof GhostAuth>;

export interface GhostConnectorOptions {
  fetch?: FetchLike;
  now?: () => Date;
  /** Accept-Version header (default v6.0, as the official SDK sends). */
  acceptVersion?: string;
  /** Comment pages (100 each) read per poll. */
  maxCommentPages?: number;
}

/** The tag that asks for an email send; Ghost treats "#…" tags as internal, so it would never show publicly anyway. */
export const GHOST_NEWSLETTER_TAG = "#newsletter";

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

/** A short-lived Admin API token: HS256, header kid = key id, payload { iat, exp: iat + 300, aud: "/admin/" }. */
export function ghostToken(adminApiKey: string, now: Date, audience = "/admin/"): string {
  const [id, secret] = adminApiKey.split(":");
  if (!id || !secret) throw new ConnectorError("ghost: Admin API key must look like <id>:<secret>", "auth", false);
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 5 * 60, aud: audience }));
  const signature = createHmac("sha256", Buffer.from(secret, "hex")).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** base air visibility → Ghost post visibility: public (default), unlisted → members only, private/direct → paid members only. */
export function ghostVisibility(o: VariantOptions): "public" | "members" | "paid" {
  if (o.visibility === "unlisted") return "members";
  if (o.visibility === "private" || o.visibility === "direct") return "paid";
  return "public";
}

interface GhostConfig {
  siteUrl: string | null;
  newsletter: string | null;
  emailSegment: string | null;
  emailEveryPost: boolean;
}

function configOf(account: AccountRef): GhostConfig {
  const c = account.config;
  return {
    siteUrl: typeof c.siteUrl === "string" ? c.siteUrl : null,
    newsletter: typeof c.newsletter === "string" && c.newsletter ? c.newsletter : null,
    emailSegment: typeof c.emailSegment === "string" && c.emailSegment ? c.emailSegment : null,
    emailEveryPost: c.emailEveryPost === true,
  };
}

function isNewsletterTag(t: string): boolean {
  return t.trim().toLowerCase() === GHOST_NEWSLETTER_TAG;
}

function ghostError(prefix: string, status: number, body: unknown, headers: Headers, now: Date): ConnectorError {
  const e = ((body as { errors?: { message?: string; type?: string; context?: string | null }[] } | undefined)?.errors ?? [])[0];
  const detail = e ? [e.type, e.message].filter(Boolean).join(": ") + (e.context ? ` (${e.context})` : "") : typeof body === "string" ? body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return httpFailure(prefix, status, detail, headers, body, { now });
}

/** Fields of an Admin API comment we read. TODO(verify): the shape of /ghost/api/admin/comments/ (not in the public docs). */
export interface GhostComment {
  id: string;
  post_id?: string;
  parent_id?: string | null;
  html?: string | null;
  status?: string;
  created_at: string;
  member?: { id?: string; uuid?: string; name?: string | null } | null;
  post?: { id?: string; url?: string; title?: string } | null;
}

export class GhostConnector implements Connector {
  readonly name = "ghost";
  readonly networks: readonly Network[] = ["ghost"];
  readonly connectMethod = "api_key" as const;
  readonly connectConfigured = true;
  readonly credentialInputs = [
    { key: "apiUrl", label: "API URL (Ghost Admin → Settings → Integrations → your custom integration)", placeholder: "https://blog.example.com" },
    { key: "adminApiKey", label: "Admin API key", placeholder: "6489…:a1b2…", secret: true },
    { key: "newsletter", label: "Newsletter slug to email posts tagged #newsletter (optional)", placeholder: "default-newsletter", optional: true },
  ] as const;
  media?: MediaFetcher;

  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly acceptVersion: string;
  private readonly maxCommentPages: number;
  private readonly idempotency = new IdempotencyCache<PublishResult>();
  private readonly uploads = new Map<string, Promise<{ url: string; alt: string | null }[]>>();
  /** Accounts whose Ghost does not expose admin comments to integrations (404/403/501), so polling stops asking. */
  private readonly noComments = new Set<string>();

  constructor(opts: GhostConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.acceptVersion = opts.acceptVersion ?? "v6.0";
    this.maxCommentPages = opts.maxCommentPages ?? 5;
  }

  capabilities(): ConnectorCapabilities {
    // Comments are read best-effort from an Admin API endpoint Ghost does not document; replies are member-only in Ghost.
    return { publish: true, fetchActivity: true, fetchMetrics: true, meteredReads: false, reply: false, moderate: true, accountMetrics: true, webhooks: false, video: false, kinds: ["post", "link"] };
  }

  // ---- connect --------------------------------------------------------------------------

  async connectWithInputs(p: { network: Network; inputs: Record<string, string> }): Promise<ConnectedAccount[]> {
    const apiUrl = normalizeSiteUrl((p.inputs.apiUrl ?? "").trim().replace(/\/ghost\/?(#.*)?$/i, ""));
    if (!apiUrl) throw new ConnectorError("ghost: enter the API URL shown on the integration screen", "rejected", false);
    const parsed = GhostAuth.safeParse({ apiUrl, adminApiKey: (p.inputs.adminApiKey ?? "").trim() });
    if (!parsed.success) throw new ConnectorError("ghost: that does not look like an Admin API key (<24 hex>:<64 hex>); copy the Admin API key, not the Content API key", "auth", false);
    const auth = parsed.data;
    const site = await this.verify(auth);
    const newsletter = (p.inputs.newsletter ?? "").trim() || null;
    if (newsletter) {
      const res = await this.request<{ newsletters?: { slug: string; status?: string; name?: string }[] }>(auth, "GET", "/newsletters/", { query: { filter: `slug:${newsletter}`, limit: 1 } }, "newsletters");
      const found = res.newsletters?.[0];
      if (!found) throw new ConnectorError(`ghost: no newsletter with slug "${newsletter}" on this site`, "rejected", false);
      if (found.status && found.status !== "active") throw new ConnectorError(`ghost: newsletter "${newsletter}" is ${found.status}`, "rejected", false);
    }
    const siteUrl = site.url ? (normalizeSiteUrl(site.url) ?? apiUrl) : apiUrl;
    const key = siteKey(siteUrl);
    return [{ network: "ghost", identity: { externalId: key, handle: key, displayName: site.title ?? null }, auth: { ...auth }, config: { siteUrl, siteTitle: site.title ?? null, newsletter } }];
  }

  async describeAccount(raw: Record<string, unknown>): Promise<AccountIdentity> {
    const parsed = GhostAuth.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("ghost: apiUrl and adminApiKey are required", "auth", false, parsed.error);
    const site = await this.verify(parsed.data);
    const key = siteKey(site.url ? (normalizeSiteUrl(site.url) ?? parsed.data.apiUrl) : parsed.data.apiUrl);
    return { externalId: key, handle: key, displayName: site.title ?? null };
  }

  /**
   * GET /site/ for the title and canonical URL, then an authenticated read (/posts/?limit=1) to prove the key works.
   * TODO(verify): /ghost/api/admin/site/ answers without authentication, which is why the second call is needed.
   */
  private async verify(auth: GhostAuth): Promise<{ title?: string; url?: string }> {
    const site = (await this.request<{ site?: { title?: string; url?: string } }>(auth, "GET", "/site/", {}, "site")).site ?? {};
    await this.request(auth, "GET", "/posts/", { query: { limit: 1, fields: "id" } }, "verify key");
    return site;
  }

  // ---- publish --------------------------------------------------------------------------

  validate(account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!input.options?.title?.trim()) issues.push({ code: "empty", message: "ghost posts need a title (options.title)" });
    for (const m of input.media) {
      if (m.kind === "video" || m.kind === "document") issues.push({ code: "unsupported_media", message: `ghost: ${m.kind} attachments are not supported yet; link to them in the text` });
    }
    if (input.options?.poll) issues.push({ code: "unsupported_media", message: "ghost has no native polls" });
    if ((input.options?.tags ?? []).some(isNewsletterTag) && !configOf(account).newsletter) {
      issues.push({ code: "empty", message: "ghost: #newsletter needs a newsletter slug on the account (reconnect with one)" });
    }
    return issues;
  }

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const cfg = configOf(account);
      const o = input.options ?? {};
      const title = o.title?.trim();
      if (!title) throw new ConnectorError("ghost publish: a title is required (options.title)", "rejected", false);
      if (input.media.some((m) => m.kind === "video" || m.kind === "document")) throw new ConnectorError("ghost publish: video and document attachments are not supported", "rejected", false);

      const tagNames = o.tags ?? [];
      const wantsEmail = tagNames.some(isNewsletterTag) || cfg.emailEveryPost;
      if (tagNames.some(isNewsletterTag) && !cfg.newsletter) throw new ConnectorError("ghost publish: #newsletter needs a newsletter slug on the account", "rejected", false);
      const seen = new Set<string>();
      const tags = tagNames
        .map((t) => t.trim())
        .filter((t) => t && !isNewsletterTag(t) && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
        .map((name) => ({ name }));

      const uploads = await this.uploadsFor(auth, input);
      const featureFromUpload = !o.thumbnailUrl && uploads.length > 0;
      const feature = o.thumbnailUrl ? { url: o.thumbnailUrl, alt: null } : uploads[0];
      const inline = featureFromUpload ? uploads.slice(1) : uploads;
      const html = textToHtml(input.text, { link: o.link, images: inline.map((u) => ({ src: u.url, alt: u.alt })) });

      const visibility = ghostVisibility(o);
      const query: Record<string, string> = { source: "html" };
      if (wantsEmail && cfg.newsletter) {
        query.newsletter = cfg.newsletter;
        query.email_segment = cfg.emailSegment ?? (visibility === "paid" ? "status:-free" : "all");
      }
      const post = {
        title,
        html,
        status: "published",
        visibility,
        ...(tags.length > 0 ? { tags } : {}),
        ...(feature ? { feature_image: feature.url, ...(feature.alt ? { feature_image_alt: feature.alt } : {}) } : {}),
      };
      const res = await this.request<{ posts?: { id: string; url?: string; status?: string; email?: unknown }[] }>(auth, "POST", "/posts/", { query, json: { posts: [post] } }, "create post");
      const created = res.posts?.[0];
      if (!created?.id) throw new ConnectorError("ghost publish: Ghost returned no post", "unknown", false, res);
      this.uploads.delete(input.idempotencyKey);
      return { externalId: created.id, url: created.url ?? null, raw: created };
    });
  }

  private uploadsFor(auth: GhostAuth, input: PublishInput): Promise<{ url: string; alt: string | null }[]> {
    let pending = this.uploads.get(input.idempotencyKey);
    if (!pending) {
      pending = (async () => {
        const out: { url: string; alt: string | null }[] = [];
        let i = 0;
        for (const m of input.media) if (m.kind === "image" || m.kind === "gif") out.push({ url: await this.uploadImage(auth, m, i++), alt: m.alt ?? null });
        return out;
      })();
      this.uploads.set(input.idempotencyKey, pending);
      pending.catch(() => this.uploads.delete(input.idempotencyKey));
    }
    return pending;
  }

  /** POST /images/upload/ as multipart: file (with a filename), purpose=image, ref. Returns the hosted URL. */
  private async uploadImage(auth: GhostAuth, m: Media, i: number): Promise<string> {
    const { bytes, mime } = this.media ? await this.media.fetch(m) : await downloadMedia(resolveFetch(this.fetchImpl), m);
    const filename = uploadFileName(m.url, mime, `base-air-${i + 1}`);
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: mime }), filename);
    form.set("purpose", "image");
    form.set("ref", filename);
    const res = await this.request<{ images?: { url?: string }[] }>(auth, "POST", "/images/upload/", { form }, "upload image");
    const url = res.images?.[0]?.url;
    if (!url) throw new ConnectorError("ghost image upload: no URL returned", "unknown", false, res);
    return url;
  }

  // ---- inbox ----------------------------------------------------------------------------

  /**
   * Member comments through /comments/ (the endpoint Ghost Admin's comment moderation uses). When this Ghost does not
   * expose it to integrations (404, 403 or 501) the account is remembered and [] is returned from then on.
   * TODO(verify): endpoint path, filter syntax, include=member,post and that integration tokens may read it.
   */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    if (this.noComments.has(account.id)) return [];
    const auth = parseAuth(account);
    const out: ActivityInput[] = [];
    try {
      for (let page = 1; page <= this.maxCommentPages; page++) {
        const res = await this.request<{ comments?: GhostComment[]; meta?: { pagination?: { next?: number | null } } }>(
          auth,
          "GET",
          "/comments/",
          { query: { limit: 100, page, order: "created_at asc", include: "member,post", ...(since ? { filter: `created_at:>'${isoSeconds(since)}'` } : {}) } },
          "list comments",
        );
        for (const c of res.comments ?? []) out.push(commentToActivity(c, configOf(account).siteUrl));
        if (!res.meta?.pagination?.next) break;
      }
    } catch (err) {
      const status = err instanceof ConnectorError ? (err.cause as { status?: number } | undefined)?.status : undefined;
      if (status === 404 || status === 403 || status === 501) {
        this.noComments.add(account.id);
        return [];
      }
      throw err;
    }
    return out;
  }

  /** hide/unhide a member comment (status hidden/published). TODO(verify): PUT /comments/:id/ accepts { comments: [{ status }] } from integrations. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    if (input.action !== "hide" && input.action !== "unhide") throw new ConnectorError(`ghost moderate: ${input.action} is not supported (Ghost staff can only hide or show member comments)`, "rejected", false);
    if (!/^[0-9a-f]{24}$/i.test(input.externalId)) throw new ConnectorError(`ghost moderate: "${input.externalId}" is not a comment id`, "rejected", false);
    await this.request(parseAuth(account), "PUT", `/comments/${input.externalId}/`, { json: { comments: [{ id: input.externalId, status: input.action === "hide" ? "hidden" : "published" }] } }, input.action);
  }

  // ---- metrics --------------------------------------------------------------------------

  /**
   * Newsletter numbers for emailed posts: reach = delivered (else sent), impressions = opened, link_clicks = member link
   * clicks. Posts that were not emailed have no rows. TODO(verify): include=email,count.clicks field names.
   */
  async fetchMetrics(account: AccountRef, externalIds: string[]): Promise<MetricInput[]> {
    const auth = parseAuth(account);
    const observedAt = this.now().toISOString();
    const out: MetricInput[] = [];
    for (const id of externalIds) {
      let post: { id: string; email?: { email_count?: number; delivered_count?: number; opened_count?: number } | null; count?: { clicks?: number } } | undefined;
      try {
        post = (await this.request<{ posts?: NonNullable<typeof post>[] }>(auth, "GET", `/posts/${id}/`, { query: { include: "email,count.clicks" } }, "post metrics")).posts?.[0];
      } catch (err) {
        if (err instanceof ConnectorError && err.kind === "rejected") continue; // deleted or unknown post
        throw err;
      }
      if (!post) continue;
      const row = (metric: MetricInput["metric"], value: number): MetricInput => ({ entityType: "post_variant", entityId: id, metric, value, observedAt, source: "ghost" });
      const email = post.email;
      const reach = email?.delivered_count ?? email?.email_count;
      if (typeof reach === "number") out.push(row("reach", reach));
      if (typeof email?.opened_count === "number") out.push(row("impressions", email.opened_count));
      if (typeof post.count?.clicks === "number") out.push(row("link_clicks", post.count.clicks));
    }
    return out;
  }

  /** followers_total = all members (meta.pagination.total of /members/?limit=1). */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const res = await this.request<{ meta?: { pagination?: { total?: number } } }>(parseAuth(account), "GET", "/members/", { query: { limit: 1, fields: "id" } }, "members");
    const total = res.meta?.pagination?.total;
    if (typeof total !== "number") return [];
    return [{ entityType: "social_account", entityId: account.id, metric: "followers_total", value: total, observedAt: this.now().toISOString(), source: "ghost" }];
  }

  // ---- transport ------------------------------------------------------------------------

  private async request<T>(auth: GhostAuth, method: string, path: string, opts: { query?: Record<string, string | number>; json?: unknown; form?: FormData }, what: string): Promise<T> {
    const qs = new URLSearchParams(Object.entries(opts.query ?? {}).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const url = `${auth.apiUrl}/ghost/api/admin${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { authorization: `Ghost ${ghostToken(auth.adminApiKey, this.now())}`, "accept-version": this.acceptVersion, accept: "application/json" };
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = { method, headers, ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : opts.form ? { body: opts.form } : {}) };
    let res: Response;
    try {
      res = await resolveFetch(this.fetchImpl)(url, init);
    } catch (err) {
      throw asNetworkError(err, `ghost ${what}`);
    }
    const body = await readJson(res);
    if (!res.ok) throw ghostError(`ghost ${what}`, res.status, body, res.headers, this.now());
    return body as T;
  }
}

function commentToActivity(c: GhostComment, siteUrl: string | null): ActivityInput {
  const postId = c.post_id ?? c.post?.id ?? null;
  return {
    network: "ghost",
    kind: "comment",
    externalId: c.id,
    // Members are identified by email in Ghost; the email is never copied into base air.
    authorHandle: null,
    authorName: c.member?.name ?? null,
    text: c.html ? htmlToText(c.html) : null,
    url: c.post?.url ?? siteUrl,
    parentExternalId: postId,
    occurredAt: new Date(c.created_at).toISOString(),
    raw: c,
  };
}

function parseAuth(account: AccountRef): GhostAuth {
  const parsed = GhostAuth.safeParse(account.auth ?? {});
  if (!parsed.success) throw new ConnectorError(`ghost account ${account.handle}: auth blob needs apiUrl and adminApiKey`, "auth", false, parsed.error);
  return parsed.data;
}

export function createGhostConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new GhostConnector({ ...(env.GHOST_ACCEPT_VERSION ? { acceptVersion: env.GHOST_ACCEPT_VERSION } : {}) })];
}
