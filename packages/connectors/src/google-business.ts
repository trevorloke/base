import type { ActivityInput, MetricInput, Network } from "@starsign/schema";
import { z } from "zod";
import { GoogleAuth, googleClientFromEnv, googleOAuthClient, googleRequest, googleTokenToAuth, refreshGoogleAuth, type GoogleRequestOptions } from "./google-oauth.ts";
import { isAfter, type FetchLike } from "./http.ts";
import { IdempotencyCache } from "./idempotency.ts";
import type { OAuth2Client } from "./oauth.ts";
import type { AccountIdentity, AccountRef, AuthRefresh, ConnectedAccount, Connector, ConnectorCapabilities, ModerationInput, PublishInput, PublishResult, ValidationIssue } from "./types.ts";
import { ConnectorError } from "./types.ts";

/**
 * Native Google Business Profile adapter.
 *  - Account Management API v1: the accounts a login can manage.
 *  - Business Information API v1: the locations of each account (externalId = "locations/{id}").
 *  - My Business API v4 (still the home of these resources): localPosts and reviews (+ reply).
 *  - Business Profile Performance API v1: daily location metrics (impressions by surface, calls, website clicks, directions).
 */

export const GOOGLE_BUSINESS_OAUTH_SCOPES = ["https://www.googleapis.com/auth/business.manage"];

export const GoogleBusinessAuth = GoogleAuth.extend({
  /** "accounts/{accountId}": the account the location was found under (v4 paths need it). */
  accountName: z.string().regex(/^accounts\/[^/]+$/),
  /** "locations/{locationId}". */
  locationName: z.string().regex(/^locations\/[^/]+$/),
});
export type GoogleBusinessAuth = z.infer<typeof GoogleBusinessAuth>;

/**
 * EVENT and OFFER details. VariantOptions has no fields for these yet, so the connector reads them from
 * `options.googleBusiness` when present (core's VariantOptions schema currently strips unknown keys; see the doc).
 */
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HM = z.string().regex(/^\d{2}:\d{2}$/);
export const GoogleBusinessPostOptions = z.object({
  topicType: z.enum(["STANDARD", "EVENT", "OFFER"]).optional(),
  event: z.object({ title: z.string().min(1).max(58).optional(), startDate: YMD, endDate: YMD, startTime: HM.optional(), endTime: HM.optional() }).optional(),
  offer: z.object({ couponCode: z.string().max(58).optional(), redeemOnlineUrl: z.string().url().optional(), termsConditions: z.string().max(5000).optional() }).optional(),
});
export type GoogleBusinessPostOptions = z.infer<typeof GoogleBusinessPostOptions>;

/** Daily metrics requested from the Performance API. */
export const GBP_DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_ORDERS",
] as const;
export type GbpDailyMetric = (typeof GBP_DAILY_METRICS)[number];

export interface GooglePerformance {
  range: { startDate: string; endDate: string };
  totals: Record<GbpDailyMetric, number>;
  impressionsBySurface: { desktopMaps: number; desktopSearch: number; mobileMaps: number; mobileSearch: number };
  impressions: number;
  calls: number;
  websiteClicks: number;
  directionRequests: number;
}

const RATE_HINT =
  "Business Profile APIs allow 300 requests/minute per project once access is approved; a project without approved API access has a quota of 0 and every call returns 429 (request access through the GBP API contact form)";

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

interface GbpLocation {
  name: string;
  title?: string;
  languageCode?: string;
  websiteUri?: string;
  storefrontAddress?: { locality?: string; addressLines?: string[]; regionCode?: string };
  metadata?: { placeId?: string; mapsUri?: string; newReviewUri?: string; hasVoiceOfMerchant?: boolean };
}

interface GbpReview {
  name: string;
  reviewId?: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

interface GbpLocalPost {
  name?: string;
  state?: "LOCAL_POST_STATE_UNSPECIFIED" | "REJECTED" | "LIVE" | "PROCESSING" | (string & {});
  searchUrl?: string;
  topicType?: string;
}

export interface GoogleBusinessConnectorOptions {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Polls while a new local post is PROCESSING, and the wait between them. Default 3 × 2 s. */
  processingPolls?: number;
  processingIntervalMs?: number;
  /** Review pages (50 each) walked per fetch. Default 4. */
  maxReviewPages?: number;
  /** Days summed for fetchAccountMetrics (ending yesterday; Performance data lags). Default 28. */
  metricsWindowDays?: number;
  accountManagementBase?: string;
  businessInformationBase?: string;
  v4Base?: string;
  performanceBase?: string;
}

const LOCATION_READ_MASK = "name,title,languageCode,websiteUri,storefrontAddress,metadata";

export class GoogleBusinessConnector implements Connector {
  readonly name = "google_business";
  readonly networks: readonly Network[] = ["google_business"];
  readonly connectMethod = "oauth" as const;

  private readonly oauth: OAuth2Client;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly processingPolls: number;
  private readonly processingIntervalMs: number;
  private readonly maxReviewPages: number;
  private readonly metricsWindowDays: number;
  private readonly accountBase: string;
  private readonly infoBase: string;
  private readonly v4Base: string;
  private readonly perfBase: string;
  private readonly idempotency = new IdempotencyCache<PublishResult>();

  constructor(opts: GoogleBusinessConnectorOptions = {}) {
    this.fetchImpl = opts.fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.oauth = googleOAuthClient("google_business", GOOGLE_BUSINESS_OAUTH_SCOPES, { clientId: opts.clientId, clientSecret: opts.clientSecret, fetch: opts.fetch, now: this.now });
    this.processingPolls = opts.processingPolls ?? 3;
    this.processingIntervalMs = opts.processingIntervalMs ?? 2000;
    this.maxReviewPages = opts.maxReviewPages ?? 4;
    this.metricsWindowDays = opts.metricsWindowDays ?? 28;
    const trim = (s: string) => s.replace(/\/+$/, "");
    this.accountBase = trim(opts.accountManagementBase ?? "https://mybusinessaccountmanagement.googleapis.com/v1");
    this.infoBase = trim(opts.businessInformationBase ?? "https://mybusinessbusinessinformation.googleapis.com/v1");
    this.v4Base = trim(opts.v4Base ?? "https://mybusiness.googleapis.com/v4");
    this.perfBase = trim(opts.performanceBase ?? "https://businessprofileperformance.googleapis.com/v1");
  }

  get connectConfigured(): boolean {
    return !!this.oauth.config.clientId && !!this.oauth.config.clientSecret;
  }

  capabilities(): ConnectorCapabilities {
    // Per-post insights were retired with the v4 reportInsights methods, so fetchMetrics declares false.
    return { publish: true, fetchActivity: true, fetchMetrics: false, meteredReads: false, reply: true, moderate: true, accountMetrics: true, webhooks: false, video: false, kinds: ["post"] };
  }

  // ---- connect -----------------------------------------------------------------------------

  oauthAuthorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    return this.oauth.authorizeUrl(p);
  }

  /** Every location of every account the login manages, one ConnectedAccount each (deduplicated by location). */
  async oauthConnect(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<ConnectedAccount[]> {
    const token = googleTokenToAuth(await this.oauth.exchange(p));
    const accounts: { name: string; accountName?: string; type?: string }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.call<{ accounts?: { name: string; accountName?: string; type?: string }[]; nextPageToken?: string }>(token.accessToken, `${this.accountBase}/accounts`, {
        query: { pageSize: "20", ...(pageToken ? { pageToken } : {}) },
        ctx: { what: "google_business accounts.list" },
      });
      accounts.push(...(res.accounts ?? []));
      pageToken = res.nextPageToken;
    } while (pageToken);

    const found = new Map<string, ConnectedAccount>();
    let firstError: unknown;
    for (const acct of accounts) {
      let locations: GbpLocation[];
      try {
        locations = await this.listLocations(token.accessToken, acct.name);
      } catch (err) {
        // One account the person cannot read (e.g. an organization they were removed from) must not hide the others.
        if (err instanceof ConnectorError && (err.kind === "auth" || err.kind === "rejected")) {
          firstError ??= err;
          continue;
        }
        throw err;
      }
      for (const loc of locations) {
        if (found.has(loc.name)) continue;
        found.set(loc.name, {
          network: "google_business",
          identity: locationIdentity(loc),
          auth: { ...token, accountName: acct.name, locationName: loc.name } satisfies GoogleBusinessAuth,
          config: {
            accountName: acct.name,
            locationName: loc.name,
            ...(loc.languageCode ? { languageCode: loc.languageCode } : {}),
            ...(loc.metadata?.placeId ? { placeId: loc.metadata.placeId } : {}),
            ...(loc.metadata?.mapsUri ? { mapsUri: loc.metadata.mapsUri } : {}),
            ...(loc.metadata?.hasVoiceOfMerchant !== undefined ? { hasVoiceOfMerchant: loc.metadata.hasVoiceOfMerchant } : {}),
          },
        });
      }
    }
    if (found.size === 0 && firstError) throw firstError;
    return [...found.values()];
  }

  async describeAccount(auth: Record<string, unknown>): Promise<AccountIdentity> {
    const a = GoogleAuth.extend({ locationName: z.string().min(1) }).safeParse(auth);
    if (!a.success) throw new ConnectorError("google_business: auth blob needs accessToken and locationName", "auth", false, a.error);
    const loc = await this.call<GbpLocation>(a.data.accessToken, `${this.infoBase}/${a.data.locationName}`, { query: { readMask: LOCATION_READ_MASK }, ctx: { what: "google_business locations.get" } });
    return locationIdentity(loc);
  }

  async refreshAuth(account: AccountRef): Promise<AuthRefresh | null> {
    const next = await refreshGoogleAuth(this.oauth, parseAuth(account));
    return next ? { auth: next } : null;
  }

  private async listLocations(accessToken: string, accountName: string): Promise<GbpLocation[]> {
    const out: GbpLocation[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.call<{ locations?: GbpLocation[]; nextPageToken?: string }>(accessToken, `${this.infoBase}/${accountName}/locations`, {
        query: { readMask: LOCATION_READ_MASK, pageSize: "100", ...(pageToken ? { pageToken } : {}) },
        ctx: { what: "google_business locations.list" },
      });
      out.push(...(res.locations ?? []));
      pageToken = res.nextPageToken;
    } while (pageToken);
    return out;
  }

  // ---- validate ----------------------------------------------------------------------------

  validate(_account: AccountRef, input: PublishInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const o = input.options ?? {};
    const ext = parsePostOptions(input);
    if (ext.error) issues.push({ code: "empty", message: `google_business options.googleBusiness is invalid: ${ext.error}` });
    const topic = topicTypeOf(ext.value);
    if (topic === "STANDARD" && !input.text.trim()) issues.push({ code: "empty", message: "a Google Business \"What's new\" post needs text" });
    if ((topic === "EVENT" || topic === "OFFER") && !ext.value.event) issues.push({ code: "empty", message: `a Google Business ${topic.toLowerCase()} post needs a start and end date (options.googleBusiness.event)` });
    if ((topic === "EVENT" || topic === "OFFER") && !(ext.value.event?.title ?? o.title)) issues.push({ code: "empty", message: `a Google Business ${topic.toLowerCase()} post needs a title (options.title)` });
    if (o.callToAction && o.callToAction !== "CALL" && !o.link) issues.push({ code: "empty", message: `call to action ${o.callToAction} needs a destination (options.link)` });
    for (const m of input.media) {
      if (m.kind !== "image") issues.push({ code: "unsupported_media", message: "google_business posts take one photo (JPG or PNG); video and other media are not supported by this connector" });
      else {
        // TODO(verify): photo limits (JPG/PNG, 10 KB-5 MB, at least 250x250) from long-standing GBP guidance.
        if (m.mime && !/^image\/(jpe?g|png)$/.test(m.mime)) issues.push({ code: "unsupported_media", message: `google_business photos must be JPG or PNG (got ${m.mime})` });
        if (m.bytes !== undefined && (m.bytes < 10 * 1024 || m.bytes > 5 * 1024 * 1024)) issues.push({ code: "unsupported_media", message: "google_business photos must be between 10 KB and 5 MB" });
        if (m.width !== undefined && m.height !== undefined && (m.width < 250 || m.height < 250)) issues.push({ code: "unsupported_media", message: "google_business photos must be at least 250x250 pixels" });
      }
    }
    return issues;
  }

  // ---- publish -----------------------------------------------------------------------------

  async publish(account: AccountRef, input: PublishInput): Promise<PublishResult> {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const auth = parseAuth(account);
      const issues = this.validate(account, input);
      if (issues.length) throw new ConnectorError(`google_business publish: ${issues.map((i) => i.message).join("; ")}`, "rejected", false);
      const body = buildLocalPost(input, languageOf(account));
      // TODO(verify): v4 localPosts/reviews remain current (no sunset found as of Nov 2026).
      let post = await this.call<GbpLocalPost>(auth.accessToken, `${this.v4Base}/${v4Location(auth)}/localPosts`, { method: "POST", json: body, ctx: { what: "google_business localPosts.create", creating: true } });
      if (!post.name) throw new ConnectorError("google_business localPosts.create: response had no post name", "unknown", false, post);
      for (let i = 0; i < this.processingPolls && post.state === "PROCESSING"; i++) {
        await this.sleep(this.processingIntervalMs);
        post = { ...post, ...(await this.call<GbpLocalPost>(auth.accessToken, `${this.v4Base}/${post.name}`, { ctx: { what: "google_business localPosts.get" } })) };
      }
      if (post.state === "REJECTED") throw new ConnectorError(`google_business: Google rejected local post ${post.name} (content policy)`, "rejected", false, post);
      // PROCESSING after the bounded wait is still a created post; raw.state says so.
      return { externalId: post.name!, url: post.searchUrl ?? null, raw: post };
    });
  }

  // ---- reviews -----------------------------------------------------------------------------

  /** Reviews as inbox items (kind "comment", rating 1-5 in raw.rating), newest update first. */
  async fetchActivity(account: AccountRef, since: Date | null): Promise<ActivityInput[]> {
    const auth = parseAuth(account);
    const out: ActivityInput[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < this.maxReviewPages; page++) {
      const res = await this.call<{ reviews?: GbpReview[]; nextPageToken?: string; averageRating?: number; totalReviewCount?: number }>(auth.accessToken, `${this.v4Base}/${v4Location(auth)}/reviews`, {
        query: { pageSize: "50", orderBy: "updateTime desc", ...(pageToken ? { pageToken } : {}) },
        ctx: { what: "google_business reviews.list" },
      });
      const reviews = res.reviews ?? [];
      let older = false;
      for (const r of reviews) {
        const updated = r.updateTime ?? r.createTime ?? "";
        if (!isAfter(updated, since)) {
          older = true;
          continue;
        }
        out.push(this.reviewToActivity(account, auth, r));
      }
      pageToken = res.nextPageToken;
      if (!pageToken || older || reviews.length === 0) break;
    }
    return out.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  }

  private reviewToActivity(account: AccountRef, auth: GoogleBusinessAuth, r: GbpReview): ActivityInput {
    const anonymous = r.reviewer?.isAnonymous === true;
    const mapsUri = typeof account.config?.mapsUri === "string" ? account.config.mapsUri : null;
    return {
      network: "google_business",
      kind: "comment",
      externalId: r.name,
      authorHandle: null,
      authorName: anonymous ? null : (r.reviewer?.displayName ?? null),
      text: r.comment ?? null, // rating-only reviews have no text
      url: mapsUri,
      parentExternalId: auth.locationName,
      occurredAt: r.createTime ?? r.updateTime ?? this.now().toISOString(),
      raw: { ...r, rating: r.starRating ? (STAR[r.starRating] ?? null) : null },
    };
  }

  /** Reply to a review (PUT .../reviews/{id}/reply; replaces an existing reply). Local posts cannot be replied to. */
  async reply(account: AccountRef, input: { parentExternalId: string; text: string; idempotencyKey: string }): Promise<PublishResult> {
    const auth = parseAuth(account);
    const review = reviewName(input.parentExternalId);
    if (!review) throw new ConnectorError(`google_business: only reviews can be replied to (got ${input.parentExternalId})`, "rejected", false);
    if (Buffer.byteLength(input.text, "utf8") > 4096) throw new ConnectorError("google_business: review replies are limited to 4096 bytes", "rejected", false);
    const res = await this.call<{ comment?: string; updateTime?: string }>(auth.accessToken, `${this.v4Base}/${review}/reply`, { method: "PUT", json: { comment: input.text }, ctx: { what: "google_business reviews.updateReply", creating: true } });
    return { externalId: `${review}/reply`, url: null, raw: res };
  }

  /** delete removes the business's reply to a review. Google offers no API to hide or delete reviews themselves. */
  async moderate(account: AccountRef, input: ModerationInput): Promise<void> {
    const auth = parseAuth(account);
    const review = reviewName(input.externalId);
    if (input.action !== "delete" || !review) {
      throw new ConnectorError(`google_business: "${input.action}" is not available; the API can only delete the business's own reply to a review`, "rejected", false);
    }
    await this.call(auth.accessToken, `${this.v4Base}/${review}/reply`, { method: "DELETE", ctx: { what: "google_business reviews.deleteReply", creating: true } });
  }

  // ---- metrics -----------------------------------------------------------------------------

  /** Per-post insights are not offered by the current APIs (v4 reportInsights was retired). */
  async fetchMetrics(): Promise<MetricInput[]> {
    return [];
  }

  /** Location performance over a date range (inclusive, YYYY-MM-DD), with the per-surface breakdown. */
  async fetchPerformance(account: AccountRef, range: { startDate: string; endDate: string }): Promise<GooglePerformance> {
    const auth = parseAuth(account);
    // TODO(verify): repeated dailyMetrics + dailyRange.startDate.year-style params; a location may 400 on food/booking metrics.
    const [sy, sm, sd] = range.startDate.split("-");
    const [ey, em, ed] = range.endDate.split("-");
    const res = await this.call<{
      multiDailyMetricTimeSeries?: { dailyMetricTimeSeries?: { dailyMetric?: string; timeSeries?: { datedValues?: { value?: string }[] } }[] }[];
    }>(auth.accessToken, `${this.perfBase}/${auth.locationName}:fetchMultiDailyMetricsTimeSeries`, {
      query: {
        dailyMetrics: [...GBP_DAILY_METRICS],
        "dailyRange.startDate.year": String(Number(sy)),
        "dailyRange.startDate.month": String(Number(sm)),
        "dailyRange.startDate.day": String(Number(sd)),
        "dailyRange.endDate.year": String(Number(ey)),
        "dailyRange.endDate.month": String(Number(em)),
        "dailyRange.endDate.day": String(Number(ed)),
      },
      ctx: { what: "google_business performance.fetchMultiDailyMetricsTimeSeries" },
    });
    const totals = Object.fromEntries(GBP_DAILY_METRICS.map((m) => [m, 0])) as Record<GbpDailyMetric, number>;
    for (const group of res.multiDailyMetricTimeSeries ?? []) {
      for (const series of group.dailyMetricTimeSeries ?? []) {
        const metric = series.dailyMetric as GbpDailyMetric | undefined;
        if (!metric || !(metric in totals)) continue;
        // Values are int64 strings; days with zero omit `value`.
        for (const dv of series.timeSeries?.datedValues ?? []) totals[metric] += Number(dv.value ?? 0) || 0;
      }
    }
    const impressionsBySurface = {
      desktopMaps: totals.BUSINESS_IMPRESSIONS_DESKTOP_MAPS,
      desktopSearch: totals.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH,
      mobileMaps: totals.BUSINESS_IMPRESSIONS_MOBILE_MAPS,
      mobileSearch: totals.BUSINESS_IMPRESSIONS_MOBILE_SEARCH,
    };
    return {
      range,
      totals,
      impressionsBySurface,
      impressions: impressionsBySurface.desktopMaps + impressionsBySurface.desktopSearch + impressionsBySurface.mobileMaps + impressionsBySurface.mobileSearch,
      calls: totals.CALL_CLICKS,
      websiteClicks: totals.WEBSITE_CLICKS,
      directionRequests: totals.BUSINESS_DIRECTION_REQUESTS,
    };
  }

  /**
   * Trailing-window location totals mapped to canonical names: impressions (all four surfaces), link_clicks (website),
   * clicks (calls + website + direction requests), engagements (clicks + conversations + bookings + food orders).
   */
  async fetchAccountMetrics(account: AccountRef): Promise<MetricInput[]> {
    const end = new Date(this.now().getTime() - 24 * 3600_000);
    const start = new Date(end.getTime() - (this.metricsWindowDays - 1) * 24 * 3600_000);
    const p = await this.fetchPerformance(account, { startDate: ymd(start), endDate: ymd(end) });
    const observedAt = this.now().toISOString();
    const clicks = p.calls + p.websiteClicks + p.directionRequests;
    const row = (metric: MetricInput["metric"], value: number): MetricInput => ({ entityType: "social_account", entityId: account.id, metric, value, observedAt, source: "google_business" });
    return [
      row("impressions", p.impressions),
      row("link_clicks", p.websiteClicks),
      row("clicks", clicks),
      row("engagements", clicks + p.totals.BUSINESS_CONVERSATIONS + p.totals.BUSINESS_BOOKINGS + p.totals.BUSINESS_FOOD_ORDERS),
    ];
  }

  // ---- transport ---------------------------------------------------------------------------

  private call<T>(accessToken: string, url: string, opts: GoogleRequestOptions): Promise<T> {
    return googleRequest<T>(this.fetchImpl, accessToken, url, { ...opts, ctx: { rateHint: RATE_HINT, ...opts.ctx } });
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parsePostOptions(input: PublishInput): { value: GoogleBusinessPostOptions; error?: string } {
  const raw = (input.options as Record<string, unknown> | undefined)?.googleBusiness;
  if (raw === undefined) return { value: {} };
  const parsed = GoogleBusinessPostOptions.safeParse(raw);
  return parsed.success ? { value: parsed.data } : { value: {}, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") };
}

function topicTypeOf(o: GoogleBusinessPostOptions): "STANDARD" | "EVENT" | "OFFER" {
  return o.topicType ?? (o.offer ? "OFFER" : o.event ? "EVENT" : "STANDARD");
}

function languageOf(account: AccountRef): string {
  return typeof account.config?.languageCode === "string" ? account.config.languageCode : "en-US";
}

const toDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { year: y, month: m, day: d };
};
const toTime = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { hours: h, minutes: m, seconds: 0, nanos: 0 };
};

/** PublishInput → v4 LocalPost body. */
export function buildLocalPost(input: PublishInput, languageCode: string): Record<string, unknown> {
  const o = input.options ?? {};
  const ext = parsePostOptions(input).value;
  const topicType = topicTypeOf(ext);
  const body: Record<string, unknown> = { languageCode, topicType };
  if (input.text.trim()) body.summary = input.text;
  // TODO(verify): Google documents CTA buttons for STANDARD and EVENT posts; OFFER posts show "View offer" instead.
  const action = o.callToAction ?? (o.link ? "LEARN_MORE" : undefined);
  if (action && topicType !== "OFFER") body.callToAction = action === "CALL" ? { actionType: "CALL" } : { actionType: action, url: o.link };
  const photo = input.media.find((m) => m.kind === "image");
  if (photo) body.media = [{ mediaFormat: "PHOTO", sourceUrl: photo.url }];
  if ((topicType === "EVENT" || topicType === "OFFER") && ext.event) {
    const e = ext.event;
    body.event = {
      title: e.title ?? o.title ?? "",
      schedule: {
        startDate: toDate(e.startDate),
        endDate: toDate(e.endDate),
        ...(e.startTime ? { startTime: toTime(e.startTime) } : {}),
        ...(e.endTime ? { endTime: toTime(e.endTime) } : {}),
      },
    };
  }
  if (topicType === "OFFER" && ext.offer) body.offer = { ...ext.offer };
  return body;
}

function v4Location(auth: GoogleBusinessAuth): string {
  return `${auth.accountName}/${auth.locationName}`;
}

/** "accounts/a/locations/l/reviews/r" from a review or review-reply id; null for anything else. */
function reviewName(id: string): string | null {
  const m = id.match(/^(accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+)(\/reply)?$/);
  return m ? m[1]! : null;
}

function locationIdentity(loc: GbpLocation): AccountIdentity {
  const title = loc.title ?? loc.name;
  const locality = loc.storefrontAddress?.locality;
  return { externalId: loc.name, handle: title, displayName: locality ? `${title} (${locality})` : title };
}

function parseAuth(account: AccountRef): GoogleBusinessAuth {
  const raw = { ...(account.config ?? {}), ...(account.auth ?? {}) } as Record<string, unknown>;
  if (typeof raw.locationName !== "string") raw.locationName = account.externalId;
  const parsed = GoogleBusinessAuth.safeParse(raw);
  if (!parsed.success) throw new ConnectorError(`google_business account ${account.handle}: auth blob needs accessToken, accountName and locationName`, "auth", false, parsed.error);
  return parsed.data;
}

/** Factory: one Google Business Profile connector on the shared Google OAuth client. */
export function createGoogleBusinessConnectors(env: NodeJS.ProcessEnv): Connector[] {
  return [new GoogleBusinessConnector({ ...googleClientFromEnv(env) })];
}
