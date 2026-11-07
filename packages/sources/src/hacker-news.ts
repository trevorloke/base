import { bucketCounts, fetchOf, getJson } from "./http.ts";
import { HOUR_MS, type FetchLike, type SampleRequest, type SamplePoint, type SourceAdapter, type TrendingItem, type TrendingRequest } from "./types.ts";

interface AlgoliaSearch {
  hits?: { created_at_i?: number; title?: string | null; url?: string | null; points?: number | null; objectID: string }[];
  nbPages?: number;
}

/**
 * Hacker News via the Algolia HN Search API: free, no key, real time. Technology and startup attention.
 * Sample: stories and comments mentioning the keywords per hour. Trending: the current front page.
 */
export class HackerNewsSource implements SourceAdapter {
  readonly name = "hacker_news" as const;
  readonly configured = true;
  readonly granularityMs = HOUR_MS;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly maxPages: number;

  constructor(opts: { fetch?: FetchLike; baseUrl?: string; maxPages?: number } = {}) {
    this.fetchFn = fetchOf(opts.fetch);
    this.baseUrl = opts.baseUrl ?? "https://hn.algolia.com/api/v1";
    this.maxPages = opts.maxPages ?? 5;
  }

  async sample(req: SampleRequest): Promise<SamplePoint[]> {
    if (req.keywords.length === 0) return [];
    const from = Math.max(req.since.getTime(), req.now.getTime() - 7 * 24 * HOUR_MS);
    const times: number[] = [];
    const query = req.keywords.slice(0, 5).map((k) => `"${k.replace(/"/g, "")}"`).join(" OR ");
    for (let page = 0; page < this.maxPages; page++) {
      const params = new URLSearchParams({
        query,
        tags: "(story,comment)",
        numericFilters: `created_at_i>${Math.floor(from / 1000)}`,
        hitsPerPage: "1000",
        page: String(page),
      });
      const body = await getJson<AlgoliaSearch>(this.fetchFn, this.name, `${this.baseUrl}/search_by_date?${params}`);
      for (const h of body.hits ?? []) if (h.created_at_i) times.push(h.created_at_i * 1000);
      if (page + 1 >= (body.nbPages ?? 1)) break;
    }
    return bucketCounts(times, from, req.now.getTime(), HOUR_MS).map((b) => ({ observedAt: new Date(b.t).toISOString(), value: b.n }));
  }

  async trending(req: TrendingRequest): Promise<TrendingItem[]> {
    const body = await getJson<AlgoliaSearch>(this.fetchFn, this.name, `${this.baseUrl}/search?tags=front_page&hitsPerPage=30`);
    return (body.hits ?? [])
      .filter((h) => h.title)
      .map((h) => ({
        term: h.title!,
        value: h.points ?? null,
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        observedAt: req.now.toISOString(),
        region: "global",
      }));
  }
}
