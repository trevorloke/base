import type {
  AcceptInviteInput,
  Account,
  AccountMetrics,
  Activity,
  AdaptInput,
  AdaptResult,
  Alert,
  Brief,
  ConnectCredentialsInput,
  ConnectStartInput,
  Connector,
  Conversion,
  CreateLinkInput,
  CreatePostInput,
  DecideInput,
  Discovery,
  FeedEvent,
  FeedQuery,
  InviteCreated,
  InviteInfo,
  LanguageSettings,
  LanguageSettingsPatch,
  LanguagesInfo,
  LiftByStage,
  LinkList,
  LinkReport,
  LinkSettingsPatch,
  LinkSettingsResponse,
  LiveStatus,
  MediaAsset,
  Me,
  Member,
  ModerateAction,
  OAuthStart,
  Policy,
  PolicyCheckInput,
  PolicyDecision,
  PostDetail,
  PostFull,
  PostSummary,
  RadarEntry,
  ReplyInput,
  Role,
  Session,
  SignupInput,
  Stream,
  Summary,
  TopicDetail,
  TrackedLink,
  TrendSource,
  Workspace,
} from "./types";
import { ApiError, setKeyMode } from "./lib/errors";

export { ApiError, isApiError, errorText, reasonOf, sentence } from "./lib/errors";

// "" by default: same origin, so the Vite dev/preview proxy forwards /v1 and /api to :4000.
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** When true, every call is answered from src/dev/fixtures.ts and no network request is made. */
export const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === "1";

export const API_KEY_STORAGE = "starsign.apiKey";

// Kept in memory too, so a private window (no storage) still works for this page load.
let memoryKey: string | null = null;

export function getApiKey(): string | null {
  try {
    const k = localStorage.getItem(API_KEY_STORAGE);
    const v = k && k.trim() ? k.trim() : memoryKey;
    setKeyMode(v !== null);
    return v;
  } catch {
    setKeyMode(memoryKey !== null);
    return memoryKey;
  }
}

export function setApiKey(key: string | null): void {
  memoryKey = key && key.trim() ? key.trim() : null;
  setKeyMode(memoryKey !== null);
  try {
    if (memoryKey) localStorage.setItem(API_KEY_STORAGE, memoryKey);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // storage unavailable (private window); the key then lives only for this page load
  }
}

/**
 * Every request carries the session cookie (`credentials: "include"`); writes add the CSRF header the
 * server requires for cookie-authenticated changes. A pasted API key, when there is one, goes as a bearer.
 */
function authHeaders(method: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (method !== "GET" && method !== "HEAD") headers["x-starsign-csrf"] = "1";
  return headers;
}

function toApiError(status: number, statusText: string, text: string): ApiError {
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  return new ApiError(status, err?.code ?? `http_${status}`, err?.message ?? (statusText || "Request failed"), err?.details);
}

// A cookie session that lapses answers 401 (and the server clears the cookie). Whoever listens (the App)
// sends the person to Sign in. Auth endpoints and API-key mode handle their own 401s.
let unauthorizedListener: (() => void) | null = null;
export function onUnauthorized(fn: (() => void) | null): void {
  unauthorizedListener = fn;
}
const AUTH_PATHS = /^\/v1\/(auth\/|invites\/[^/]+$)/;

// Fixtures are a separate chunk; the production bundle never loads it unless VITE_USE_FIXTURES=1.
type Fixtures = typeof import("./dev/fixtures");
let fixturesPromise: Promise<Fixtures> | null = null;
function fixtures(): Promise<Fixtures> {
  fixturesPromise ??= import("./dev/fixtures");
  return fixturesPromise;
}

type Param = string | number | boolean | string[] | undefined | null;

function qs(params: Record<string, Param>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(","));
    } else {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders(method) };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Couldn't reach Starsign.");
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && !getApiKey() && !AUTH_PATHS.test(path)) unauthorizedListener?.();
    throw toApiError(res.status, res.statusText, text);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

export interface UploadHandle {
  done: Promise<MediaAsset>;
  abort: () => void;
}

interface MediaLimits {
  maxUploadBytes: number;
  direct: boolean;
  types: string[];
}
let limitsPromise: Promise<MediaLimits | null> | null = null;
function mediaLimits(): Promise<MediaLimits | null> {
  limitsPromise ??= request<MediaLimits>("GET", "/v1/media/limits").catch(() => {
    limitsPromise = null; // try again next time
    return null;
  });
  return limitsPromise;
}

interface DirectUpload {
  uploadId: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * Uploads one file. With S3 storage the file goes straight to the bucket (presign, PUT, complete), so big videos
 * never pass through the API; otherwise it is POSTed to /v1/media. XMLHttpRequest rather than fetch, because only
 * XHR reports upload progress. `onProgress` gets 0..1.
 */
function uploadLive(file: File, alt: string | undefined, onProgress: (p: number) => void): UploadHandle {
  let current: XMLHttpRequest | null = null;
  let aborted = false;
  const done = (async () => {
    const limits = await mediaLimits();
    if (aborted) throw new ApiError(0, "aborted", "Upload cancelled.");
    if (limits?.direct && limits.types.includes(file.type)) {
      const ticket = await request<DirectUpload>("POST", "/v1/media/uploads", { mime: file.type, bytes: file.size, filename: file.name });
      if (aborted) throw new ApiError(0, "aborted", "Upload cancelled.");
      await putToBucket(file, ticket, (p) => onProgress(p * 0.97), (x) => (current = x));
      const asset = await request<MediaAsset>("POST", "/v1/media/uploads/complete", { uploadId: ticket.uploadId, ...(alt && alt.trim() ? { alt: alt.trim() } : {}) });
      onProgress(1);
      return asset;
    }
    return multipart(file, alt, onProgress, (x) => (current = x));
  })();
  return {
    done,
    abort: () => {
      aborted = true;
      current?.abort();
    },
  };
}

/** The presigned PUT: no cookies, no API headers, only the headers the URL was signed with. */
function putToBucket(file: File, t: DirectUpload, onProgress: (p: number) => void, track: (x: XMLHttpRequest) => void): Promise<void> {
  const xhr = new XMLHttpRequest();
  track(xhr);
  return new Promise<void>((resolve, reject) => {
    xhr.open("PUT", t.url);
    for (const [k, v] of Object.entries(t.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, "storage", `The media storage refused the file (HTTP ${xhr.status}).`));
    // A CORS refusal looks like a network error from here; the bucket's CORS policy is the usual cause.
    xhr.onerror = () => reject(new ApiError(0, "network", "Couldn't reach the media storage. Check the bucket's CORS settings allow uploads from this site."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled."));
    xhr.send(file);
  });
}

/** POST /v1/media as multipart. */
function multipart(file: File, alt: string | undefined, onProgress: (p: number) => void, track: (x: XMLHttpRequest) => void): Promise<MediaAsset> {
  const xhr = new XMLHttpRequest();
  track(xhr);
  return new Promise<MediaAsset>((resolve, reject) => {
    xhr.open("POST", `${BASE}/v1/media`);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(authHeaders("POST"))) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          onProgress(1);
          resolve(JSON.parse(xhr.responseText) as MediaAsset);
        } catch {
          reject(new ApiError(xhr.status, "invalid", "The upload finished but the answer was unreadable."));
        }
      } else {
        if (xhr.status === 401 && !getApiKey()) unauthorizedListener?.();
        reject(toApiError(xhr.status, xhr.statusText, xhr.responseText));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Couldn't reach Starsign."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled."));
    const form = new FormData();
    form.append("file", file, file.name);
    if (alt && alt.trim()) form.append("alt", alt.trim());
    xhr.send(form);
  });
}

const get = <T,>(path: string) => request<T>("GET", path);
const post = <T,>(path: string, body?: unknown) => request<T>("POST", path, body);
const patch = <T,>(path: string, body?: unknown) => request<T>("PATCH", path, body);
const del = <T,>(path: string) => request<T>("DELETE", path);
const enc = encodeURIComponent;

/** Route a call to the live API or, in fixture mode, to the fixture implementation. */
function pick<T>(live: () => Promise<T>, mock: (f: Fixtures) => Promise<T>): Promise<T> {
  return USE_FIXTURES ? fixtures().then(mock) : live();
}

export const api = {
  me: () => pick(() => get<Me>("/v1/me"), (f) => f.fixtureApi.me()),
  policy: () => pick(() => get<Policy>("/v1/policy"), (f) => f.fixtureApi.policy()),
  accounts: () => pick(() => get<Account[]>("/v1/accounts"), (f) => f.fixtureApi.accounts()),
  streams: () => pick(() => get<Stream[]>("/v1/streams"), (f) => f.fixtureApi.streams()),

  queue: () => pick(() => get<PostSummary[]>("/v1/posts/queue"), (f) => f.fixtureApi.queue()),
  post: (id: string) => pick(() => get<PostFull>(`/v1/posts/${enc(id)}`), (f) => f.fixtureApi.post(id)),
  decide: (id: string, input: DecideInput) =>
    pick(
      () => post<PostDetail>(`/v1/posts/${enc(id)}/decide`, input),
      (f) => f.fixtureApi.decide(id, input),
    ),

  radar: () => pick(() => get<RadarEntry[]>("/v1/trends/radar"), (f) => f.fixtureApi.radar()),
  topic: (id: string) => pick(() => get<TopicDetail>(`/v1/trends/topics/${enc(id)}`), (f) => f.fixtureApi.topic(id)),

  feed: (q: FeedQuery = {}) =>
    pick(
      () =>
        get<Activity[]>(
          `/v1/feed${qs({
            stream: q.stream,
            networks: q.networks,
            kinds: q.kinds,
            account: q.account,
            since: q.since,
            before: q.before,
            limit: q.limit,
            q: q.q,
            languages: q.languages,
            conversation: q.conversation,
          })}`,
        ),
      (f) => f.fixtureApi.feed(q),
    ),

  summary: (from: string, to: string) =>
    pick(() => get<Summary>(`/v1/metrics/summary${qs({ from, to })}`), (f) => f.fixtureApi.summary(from, to)),
  liftByStage: (from: string, to: string) =>
    pick(() => get<LiftByStage[]>(`/v1/metrics/lift-by-stage${qs({ from, to })}`), (f) => f.fixtureApi.liftByStage(from, to)),

  alerts: () => pick(() => get<Alert[]>("/v1/alerts?unacknowledged=1&limit=50"), (f) => f.fixtureApi.alerts()),
  ackAlert: (id: string) => pick(() => post<void>(`/v1/alerts/${enc(id)}/ack`), (f) => f.fixtureApi.ackAlert(id)),
  latestBrief: () => pick(() => get<Brief | null>("/v1/briefs/latest"), (f) => f.fixtureApi.latestBrief()),

  // --- Compose, calendar, connect (v1.1) ---
  connectors: () => pick(() => get<Connector[]>("/v1/connectors"), (f) => f.fixtureApi.connectors()),
  deleteAccount: (id: string) => pick(() => del<void>(`/v1/accounts/${enc(id)}`), (f) => f.fixtureApi.deleteAccount(id)),

  adapt: (input: AdaptInput) => pick(() => post<AdaptResult>("/v1/compose/adapt", input), (f) => f.fixtureApi.adapt(input)),
  policyCheck: (input: PolicyCheckInput) => pick(() => post<PolicyDecision>("/v1/policy/check", input), (f) => f.fixtureApi.policyCheck(input)),
  createPost: (input: CreatePostInput) => pick(() => post<PostDetail>("/v1/posts", input), (f) => f.fixtureApi.createPost(input)),

  calendar: (from: string, to: string) => pick(() => get<PostSummary[]>(`/v1/calendar${qs({ from, to })}`), (f) => f.fixtureApi.calendar(from, to)),
  sources: () => pick(() => get<TrendSource[]>("/v1/sources"), (f) => f.fixtureApi.sources()),
  discoveries: (limit = 50) => pick(() => get<Discovery[]>(`/v1/trends/discoveries${qs({ limit })}`), (f) => f.fixtureApi.discoveries(limit)),

  // --- People, sign-in, teams (v1.2) ---
  session: () => pick(() => get<Session>("/v1/auth/session"), (f) => f.fixtureApi.session()),
  login: (email: string, password: string) => pick(() => post<Session>("/v1/auth/login", { email, password }), (f) => f.fixtureApi.login(email, password)),
  signup: (input: SignupInput) => pick(() => post<Session>("/v1/auth/signup", input), (f) => f.fixtureApi.signup(input)),
  logout: () => pick(() => post<void>("/v1/auth/logout"), (f) => f.fixtureApi.logout()),
  switchWorkspace: (workspaceId: string) => pick(() => post<Session>("/v1/auth/switch", { workspaceId }), (f) => f.fixtureApi.switchWorkspace(workspaceId)),
  forgot: (email: string) => pick(() => post<void>("/v1/auth/forgot", { email }), (f) => f.fixtureApi.forgot(email)),
  reset: (token: string, password: string) => pick(() => post<void>("/v1/auth/reset", { token, password }), (f) => f.fixtureApi.reset(token, password)),
  createWorkspace: (name: string) => pick(() => post<Workspace>("/v1/workspaces", { name }), (f) => f.fixtureApi.createWorkspace(name)),
  members: () => pick(() => get<Member[]>("/v1/members"), (f) => f.fixtureApi.members()),
  setMemberRole: (id: string, role: Role) => pick(() => patch<Member>(`/v1/members/${enc(id)}`, { role }), (f) => f.fixtureApi.setMemberRole(id, role)),
  removeMember: (id: string) => pick(() => del<void>(`/v1/members/${enc(id)}`), (f) => f.fixtureApi.removeMember(id)),
  invite: (email: string, role: Role) => pick(() => post<InviteCreated>("/v1/invites", { email, role }), (f) => f.fixtureApi.invite(email, role)),
  inviteInfo: (token: string) => pick(() => get<InviteInfo>(`/v1/invites/${enc(token)}`), (f) => f.fixtureApi.inviteInfo(token)),
  acceptInvite: (input: AcceptInviteInput) => pick(() => post<Session>("/v1/auth/accept-invite", input), (f) => f.fixtureApi.acceptInvite(input)),

  // --- Integrations (v1.2) ---
  /** OAuth connectors: the caller sends the browser to `authorizeUrl`. 503 when the server isn't set up for it. */
  connectStart: (connector: string, input: ConnectStartInput) =>
    pick(() => post<OAuthStart>(`/v1/accounts/connect/${enc(connector)}/start`, input), (f) => f.fixtureApi.connectStart(connector, input)),
  /** Typed-credential connectors (app password, bot token, webhook URL): returns every account connected. */
  connectCredentials: (connector: string, input: ConnectCredentialsInput) =>
    pick(() => post<Account[]>(`/v1/accounts/connect/${enc(connector)}/credentials`, input), (f) => f.fixtureApi.connectCredentials(connector, input)),
  accountMetrics: (id: string, metric = "followers_total") =>
    pick(() => get<AccountMetrics>(`/v1/accounts/${enc(id)}/metrics${qs({ metric })}`), (f) => f.fixtureApi.accountMetrics(id, metric)),

  media: () => pick(() => get<MediaAsset[]>("/v1/media"), (f) => f.fixtureApi.media()),
  deleteMedia: (id: string) => pick(() => del<void>(`/v1/media/${enc(id)}`), (f) => f.fixtureApi.deleteMedia(id)),
  /** Upload one file with progress. Fixture mode simulates the progress and keeps the file in this tab. */
  uploadMedia: (file: File, onProgress: (p: number) => void, alt?: string): UploadHandle => {
    if (!USE_FIXTURES) return uploadLive(file, alt, onProgress);
    let abort = () => {};
    const done = fixtures().then((f) => {
      const h = f.fixtureUpload(file, onProgress, alt);
      abort = h.abort;
      return h.done;
    });
    return { done, abort: () => abort() };
  },

  reply: (activityId: string, input: ReplyInput) =>
    pick(() => post<PostDetail>(`/v1/feed/${enc(activityId)}/reply`, input), (f) => f.fixtureApi.reply(activityId, input)),
  moderate: (activityId: string, action: ModerateAction) =>
    pick(() => post<{ ok: boolean; action: ModerateAction }>(`/v1/feed/${enc(activityId)}/moderate`, { action }), (f) => f.fixtureApi.moderate(activityId, action)),

  // --- Links and conversions (v1.3) ---
  /** Clicks, people and conversions; `from`/`to` default to the last 30 days on the server. */
  linkReport: (from?: string, to?: string) =>
    pick(() => get<LinkReport>(`/v1/links/report${qs({ from, to })}`), (f) => f.fixtureApi.linkReport(from, to)),
  links: (limit = 100) => pick(() => get<LinkList>(`/v1/links${qs({ limit })}`), (f) => f.fixtureApi.links(limit)),
  /** 403 for viewers; 503 `unavailable` when the server has no short-link base. */
  createLink: (input: CreateLinkInput) => pick(() => post<TrackedLink>("/v1/links", input), (f) => f.fixtureApi.createLink(input)),
  /** Turns a link off (owner/approver). It 404s from then on. */
  disableLink: (id: string) => pick(() => del<void>(`/v1/links/${enc(id)}`), (f) => f.fixtureApi.disableLink(id)),
  linkSettings: () => pick(() => get<LinkSettingsResponse>("/v1/links/settings"), (f) => f.fixtureApi.linkSettings()),
  /** Owner only. */
  updateLinkSettings: (input: LinkSettingsPatch) =>
    pick(() => patch<LinkSettingsResponse>("/v1/links/settings", input), (f) => f.fixtureApi.updateLinkSettings(input)),
  conversions: (limit = 100) => pick(() => get<Conversion[]>(`/v1/conversions${qs({ limit })}`), (f) => f.fixtureApi.conversions(limit)),

  // --- Languages ---
  /** The team's language settings, the languages seen in the last 30 days, and whether translation is on here. */
  languages: () => pick(() => get<LanguagesInfo>("/v1/languages"), (f) => f.fixtureApi.languages()),
  /** Owner only; others get 403. */
  updateLanguageSettings: (input: LanguageSettingsPatch) =>
    pick(() => patch<LanguageSettings>("/v1/languages/settings", input), (f) => f.fixtureApi.updateLanguageSettings(input)),
  /** Translates one feed item now and returns the updated row. 503 `unavailable` without a model or past the spend cap. */
  translate: (activityId: string) => pick(() => post<Activity>(`/v1/feed/${enc(activityId)}/translate`), (f) => f.fixtureApi.translate(activityId)),
  /** Fills the stream's `query.translations` for these languages (replacing what was there for them). 503 as above. */
  expandStream: (streamId: string, languages: string[]) =>
    pick(() => post<Stream>(`/v1/streams/${enc(streamId)}/expand`, { languages }), (f) => f.fixtureApi.expandStream(streamId, languages)),
};

export interface StreamHandlers {
  onEvent: (e: FeedEvent) => void;
  onStatus: (s: LiveStatus) => void;
}

const SSE_EVENTS = ["activity", "post", "alert", "forecast"] as const;

/**
 * Opens the live stream (GET /v1/feed/stream, SSE). EventSource cannot send headers, so a single-use
 * stream token goes in the URL instead (never the key). Returns a function that closes it.
 */
export function openFeedStream(h: StreamHandlers): () => void {
  if (USE_FIXTURES) {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void fixtures().then((f) => {
      if (cancelled) return;
      stop = f.openFixtureStream(h);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  let es: EventSource | null = null;
  let closed = false;
  let retry: number | null = null;
  let backoff = 1_000;

  const connect = async () => {
    if (closed) return;
    h.onStatus("connecting");
    // The API key never travels in a URL: mint a 60-second single-use stream token first.
    let token: string | null = null;
    try {
      const res = await fetch(`${BASE}/v1/feed/stream-token`, { method: "POST", headers: authHeaders("POST"), credentials: "include" });
      if (res.ok) token = ((await res.json()) as { token: string }).token;
    } catch {
      token = null;
    }
    if (closed) return;
    if (!token) {
      retry = window.setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 30_000);
      return;
    }
    const url = `${BASE}/v1/feed/stream?token=${enc(token)}`;
    const source = new EventSource(url, { withCredentials: true });
    es = source;
    source.onopen = () => {
      backoff = 1_000;
      h.onStatus("live");
    };
    for (const type of SSE_EVENTS) {
      source.addEventListener(type, (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent<string>).data) as never;
          h.onEvent({ type, data } as FeedEvent);
        } catch {
          // malformed frame: ignore, the next one will be fine
        }
      });
    }
    source.onerror = () => {
      h.onStatus("connecting");
      // EventSource reconnects on its own unless the connection was refused outright.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        if (es === source) es = null;
        if (!closed) {
          retry = window.setTimeout(() => void connect(), backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
  };

  void connect();
  return () => {
    closed = true;
    if (retry !== null) window.clearTimeout(retry);
    es?.close();
    es = null;
    h.onStatus("off");
  };
}
