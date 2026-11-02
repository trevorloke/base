import type {
  Account,
  Activity,
  Alert,
  Brief,
  DecideInput,
  FeedEvent,
  FeedQuery,
  LiftByStage,
  LiveStatus,
  Me,
  Policy,
  PostDetail,
  PostFull,
  PostSummary,
  RadarEntry,
  Stream,
  Summary,
  TopicDetail,
} from "./types";
import { ApiError } from "./lib/errors";

export { ApiError, isApiError, errorText } from "./lib/errors";

// "" by default: same origin, so the Vite dev/preview proxy forwards /v1 and /api to :4000.
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/** When true, every call is answered from src/dev/fixtures.ts and no network request is made. */
export const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === "1";

export const API_KEY_STORAGE = "starsign.apiKey";

export function getApiKey(): string | null {
  try {
    const k = localStorage.getItem(API_KEY_STORAGE);
    return k && k.trim() ? k.trim() : null;
  } catch {
    return null;
  }
}

export function setApiKey(key: string | null): void {
  try {
    if (key && key.trim()) localStorage.setItem(API_KEY_STORAGE, key.trim());
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    // storage unavailable (private window); the key then lives only for this page load
  }
}

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
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Couldn't reach Starsign.");
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? (res.statusText || "Request failed"), err?.details);
  }
  return json as T;
}

const get = <T,>(path: string) => request<T>("GET", path);
const post = <T,>(path: string, body?: unknown) => request<T>("POST", path, body);
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
};

export interface StreamHandlers {
  onEvent: (e: FeedEvent) => void;
  onStatus: (s: LiveStatus) => void;
}

const SSE_EVENTS = ["activity", "post", "alert", "forecast"] as const;

/**
 * Opens the live stream (GET /v1/feed/stream, SSE). EventSource cannot send headers, so the key
 * goes in `?key=` — the API accepts that for this route only. Returns a function that closes it.
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
      const key = getApiKey();
      const res = await fetch(`${BASE}/v1/feed/stream-token`, { method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {} });
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
    const source = new EventSource(url);
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
