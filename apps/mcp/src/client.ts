/**
 * Thin typed wrapper over the Meridian HTTP API (docs/API.md).
 * Everything the MCP tools do goes through here, so auth, policy and the ledger stay in the API.
 */
import type {
  Account,
  Alert,
  AlertsQuery,
  ApiErrorBody,
  BrandContext,
  Brief,
  CreatePostBody,
  DateRange,
  FeedQuery,
  LedgerQuery,
  ListPostsQuery,
  Me,
  MetricsSummary,
  LiftByStage,
  PolicyCheckInput,
  PostDetail,
  PostSummary,
  PostWithHistory,
  RadarEntry,
  TopicDetail,
} from "./types.ts";
import type { Activity, LedgerEvent, Policy, PolicyDecision } from "./types.ts";

export const DEFAULT_API_URL = "http://localhost:4000";
export const USER_AGENT = "meridian-mcp/0.1.0";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | readonly string[] | undefined | null;
export type Query = Record<string, QueryValue>;

/** An error from the API: `{ error: { code, message, details } }`, or a transport failure (status 0). */
export class MeridianApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly method: string;
  readonly path: string;

  constructor(args: { status: number; code: string; message: string; details?: unknown; method: string; path: string }) {
    super(args.message);
    this.name = "MeridianApiError";
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
    this.method = args.method;
    this.path = args.path;
  }

  /** Readable, single-block explanation for a tool result. */
  toText(): string {
    const head =
      this.status > 0
        ? `Meridian API error ${this.status} (${this.code}) on ${this.method} ${this.path}: ${this.message}`
        : `Meridian API unreachable (${this.code}) on ${this.method} ${this.path}: ${this.message}`;
    if (this.details === undefined || this.details === null) return head;
    return `${head}\nDetails: ${JSON.stringify(this.details, null, 2)}`;
  }
}

const CODE_FOR_STATUS: Record<number, string> = {
  400: "invalid",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "policy_blocked",
  503: "unavailable",
};

function isApiErrorBody(x: unknown): x is ApiErrorBody {
  if (typeof x !== "object" || x === null || !("error" in x)) return false;
  const e = (x as { error: unknown }).error;
  return typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string";
}

function toIso(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}

/** Builds `base + path + ?query`; arrays are comma-joined, undefined/null/empty values are dropped. */
export function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${baseUrl.replace(/\/+$/, "")}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        url.searchParams.set(key, value.join(","));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export interface MeridianClientOptions {
  /** API base URL. Default: `MERIDIAN_API_URL` or http://localhost:4000. */
  baseUrl?: string;
  /** Workspace API key (`mer_...`). When absent no Authorization header is sent (the API's dev mode may still accept it). */
  apiKey?: string;
  /** Injectable fetch, for tests. Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export class MeridianClient {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MeridianClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    const key = opts.apiKey?.trim();
    this.apiKey = key ? key : undefined;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  /** Reads `MERIDIAN_API_URL` and `MERIDIAN_API_KEY`. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MeridianClient {
    return new MeridianClient({ baseUrl: env.MERIDIAN_API_URL || DEFAULT_API_URL, apiKey: env.MERIDIAN_API_KEY });
  }

  /** Same API and fetch, a different workspace key (one HTTP server, many workspaces). */
  withApiKey(apiKey: string): MeridianClient {
    return new MeridianClient({ baseUrl: this.baseUrl, apiKey, fetch: this.fetchImpl });
  }

  // ---- identity -----------------------------------------------------------------------------

  health(): Promise<{ ok: boolean; version: string; db: string }> {
    return this.request("GET", "/api/health");
  }

  me(): Promise<Me> {
    return this.request("GET", "/v1/me");
  }

  // ---- brand context, policy ----------------------------------------------------------------

  getContext(): Promise<BrandContext> {
    return this.request("GET", "/v1/context");
  }

  getPolicy(): Promise<Policy> {
    return this.request("GET", "/v1/policy");
  }

  /** Dry run of red lines + autonomy. Nothing is stored. */
  checkPolicy(input: PolicyCheckInput): Promise<PolicyDecision> {
    return this.request("POST", "/v1/policy/check", { body: input });
  }

  listAccounts(): Promise<Account[]> {
    return this.request("GET", "/v1/accounts");
  }

  // ---- trends -------------------------------------------------------------------------------

  getRadar(): Promise<RadarEntry[]> {
    return this.request("GET", "/v1/trends/radar");
  }

  getTopic(topicId: string): Promise<TopicDetail> {
    return this.request("GET", `/v1/trends/topics/${encodeURIComponent(topicId)}`);
  }

  // ---- live feed ----------------------------------------------------------------------------

  searchFeed(q: FeedQuery = {}): Promise<Activity[]> {
    return this.request("GET", "/v1/feed", {
      query: {
        q: q.q,
        networks: q.networks,
        kinds: q.kinds,
        stream: q.stream,
        account: q.account,
        since: q.since,
        before: q.before,
        limit: q.limit,
      },
    });
  }

  // ---- posts --------------------------------------------------------------------------------

  /** Pending approval, oldest first. */
  getQueue(): Promise<PostSummary[]> {
    return this.request("GET", "/v1/posts/queue");
  }

  listPosts(q: ListPostsQuery = {}): Promise<PostSummary[]> {
    return this.request("GET", "/v1/posts", { query: { status: q.status, limit: q.limit } });
  }

  getPost(postId: string): Promise<PostWithHistory> {
    return this.request("GET", `/v1/posts/${encodeURIComponent(postId)}`);
  }

  /** The gate decides the status; a red-line block is still a 201 with `post.status === "blocked"`. */
  createPost(input: CreatePostBody): Promise<PostDetail> {
    return this.request("POST", "/v1/posts", { body: input });
  }

  schedulePost(postId: string, at: string): Promise<PostDetail> {
    return this.request("POST", `/v1/posts/${encodeURIComponent(postId)}/schedule`, { body: { at } });
  }

  cancelPost(postId: string): Promise<PostDetail> {
    return this.request("POST", `/v1/posts/${encodeURIComponent(postId)}/cancel`);
  }

  // ---- measurement --------------------------------------------------------------------------

  getMetricsSummary(range: DateRange): Promise<MetricsSummary> {
    return this.request("GET", "/v1/metrics/summary", { query: { from: toIso(range.from), to: toIso(range.to) } });
  }

  getLiftByStage(range: DateRange): Promise<LiftByStage[]> {
    return this.request("GET", "/v1/metrics/lift-by-stage", { query: { from: toIso(range.from), to: toIso(range.to) } });
  }

  // ---- operators' output, ledger ------------------------------------------------------------

  getLatestBrief(): Promise<Brief | null> {
    return this.request("GET", "/v1/briefs/latest");
  }

  listAlerts(q: AlertsQuery = {}): Promise<Alert[]> {
    return this.request("GET", "/v1/alerts", {
      query: { unacknowledged: q.unacknowledgedOnly === false ? undefined : 1, limit: q.limit },
    });
  }

  getLedger(q: LedgerQuery = {}): Promise<LedgerEvent[]> {
    return this.request("GET", "/v1/ledger", {
      query: { types: q.types, subjectType: q.subjectType, subjectId: q.subjectId, afterSeq: q.afterSeq, limit: q.limit },
    });
  }

  // ---- plumbing -----------------------------------------------------------------------------

  async request<T>(method: HttpMethod, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = buildUrl(this.baseUrl, path, opts.query);
    const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const doFetch = this.fetchImpl;
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      const cause = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
      throw new MeridianApiError({
        status: 0,
        code: "unavailable",
        message: `Could not reach the Meridian API at ${this.baseUrl} (${cause}). Is it running? Check MERIDIAN_API_URL.`,
        method,
        path,
      });
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        if (res.ok) {
          throw new MeridianApiError({
            status: res.status,
            code: "invalid_response",
            message: `Expected JSON from ${method} ${path} but got: ${text.slice(0, 200)}`,
            method,
            path,
          });
        }
        data = undefined;
      }
    }

    if (!res.ok) {
      const body = isApiErrorBody(data) ? data.error : null;
      const fallback = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${!body && text ? `: ${text.slice(0, 200)}` : ""}`;
      throw new MeridianApiError({
        status: res.status,
        code: body?.code ?? CODE_FOR_STATUS[res.status] ?? "http_error",
        message: body?.message ?? fallback,
        details: body?.details,
        method,
        path,
      });
    }
    return data as T;
  }
}
