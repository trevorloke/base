import { bucketCounts, fetchOf, getJson } from "./http.ts";
import { HOUR_MS, SourceError, type FetchLike, type SampleRequest, type SamplePoint, type SourceAdapter } from "./types.ts";

interface SearchPosts {
  posts?: { indexedAt?: string; record?: { createdAt?: string } }[];
  cursor?: string;
}

/**
 * Bluesky post search (app.bsky.feed.searchPosts): open network, real time. Counts posts mentioning the
 * keywords per hour. Works against the public AppView; if it requires auth, pass an access token
 * (BASE_AIR_BLUESKY_SEARCH_TOKEN) or point baseUrl at a PDS-proxied endpoint.
 */
export class BlueskySearchSource implements SourceAdapter {
  readonly name = "bluesky_search" as const;
  readonly configured = true;
  readonly granularityMs = HOUR_MS;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly maxPages: number;

  constructor(opts: { fetch?: FetchLike; baseUrl?: string; token?: string; maxPages?: number } = {}) {
    this.fetchFn = fetchOf(opts.fetch);
    this.baseUrl = opts.baseUrl ?? "https://public.api.bsky.app/xrpc";
    this.token = opts.token;
    this.maxPages = opts.maxPages ?? 5;
  }

  async sample(req: SampleRequest): Promise<SamplePoint[]> {
    if (req.keywords.length === 0) return [];
    const from = Math.max(req.since.getTime(), req.now.getTime() - 48 * HOUR_MS);
    const times: number[] = [];
    const headers: Record<string, string> = this.token ? { authorization: `Bearer ${this.token}` } : {};
    // One query per keyword (search has no OR); counts are summed. Dedupe by post would need uris; overlap is rare and small.
    for (const keyword of req.keywords.slice(0, 3)) {
      let cursor: string | undefined;
      for (let page = 0; page < this.maxPages; page++) {
        const params = new URLSearchParams({ q: keyword, sort: "latest", limit: "100", since: new Date(from).toISOString(), until: req.now.toISOString() });
        if (cursor) params.set("cursor", cursor);
        let body: SearchPosts;
        try {
          body = await getJson<SearchPosts>(this.fetchFn, this.name, `${this.baseUrl}/app.bsky.feed.searchPosts?${params}`, headers);
        } catch (e) {
          if (e instanceof SourceError && (e.status === 401 || e.status === 403)) {
            throw new SourceError(`${this.name}: search requires authentication; set BASE_AIR_BLUESKY_SEARCH_TOKEN`, this.name, false, e.status);
          }
          throw e;
        }
        let oldest = Infinity;
        for (const p of body.posts ?? []) {
          const t = Date.parse(p.record?.createdAt ?? p.indexedAt ?? "");
          if (Number.isFinite(t)) {
            times.push(t);
            oldest = Math.min(oldest, t);
          }
        }
        if (!body.cursor || !(body.posts?.length) || oldest <= from) break;
        cursor = body.cursor;
      }
    }
    return bucketCounts(times, from, req.now.getTime(), HOUR_MS).map((b) => ({ observedAt: new Date(b.t).toISOString(), value: b.n }));
  }
}
