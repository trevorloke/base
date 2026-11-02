import { fetchOf, getJson } from "./http.ts";
import { HOUR_MS, type FetchLike, type SourceAdapter, type TrendingItem, type TrendingRequest } from "./types.ts";

interface VideosList {
  items?: { id: string; snippet?: { title?: string; tags?: string[]; channelTitle?: string }; statistics?: { viewCount?: string } }[];
}

/** YouTube Data API v3 "most popular" chart per region. Discovery only. Needs YOUTUBE_API_KEY (1 quota unit a call). */
export class YouTubeTrendingSource implements SourceAdapter {
  readonly name = "youtube_trending" as const;
  readonly configured: boolean;
  readonly granularityMs = HOUR_MS;
  private readonly fetchFn: FetchLike;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(opts: { apiKey?: string; fetch?: FetchLike; baseUrl?: string } = {}) {
    this.apiKey = opts.apiKey;
    this.configured = !!opts.apiKey;
    this.fetchFn = fetchOf(opts.fetch);
    this.baseUrl = opts.baseUrl ?? "https://www.googleapis.com/youtube/v3";
  }

  async trending(req: TrendingRequest): Promise<TrendingItem[]> {
    if (!this.apiKey) return [];
    const region = (req.region ?? "US").toUpperCase();
    const params = new URLSearchParams({ part: "snippet,statistics", chart: "mostPopular", regionCode: region, maxResults: "50", key: this.apiKey });
    const body = await getJson<VideosList>(this.fetchFn, this.name, `${this.baseUrl}/videos?${params}`);
    return (body.items ?? [])
      .filter((v) => v.snippet?.title)
      .map((v) => ({
        term: v.snippet!.title!,
        value: v.statistics?.viewCount ? Number(v.statistics.viewCount) : null,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        observedAt: req.now.toISOString(),
        region,
        ...(v.snippet?.tags?.length ? { context: v.snippet.tags.slice(0, 8) } : {}),
      }));
  }
}
