import { fetchOf, getJson } from "./http.ts";
import { DAY_MS, type FetchLike, type SampleRequest, type SamplePoint, type SourceAdapter, type TrendingItem, type TrendingRequest } from "./types.ts";

interface PerArticle {
  items?: { timestamp: string; views: number }[];
}
interface TopResponse {
  items?: { articles?: { article: string; views: number; rank: number }[] }[];
}

const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const NON_CONTENT = /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Category:|Template:|User:|-$)/;

/**
 * Wikimedia pageviews REST API: free, official, no key. A strong public-attention proxy.
 * Sample: daily views of the articles named by the topic's keywords (summed). Trending: yesterday's top articles.
 * Wikimedia asks clients to send a descriptive User-Agent, which http.ts does.
 */
export class WikipediaPageviewsSource implements SourceAdapter {
  readonly name = "wikipedia_pageviews" as const;
  readonly configured = true;
  readonly granularityMs = DAY_MS;
  private readonly fetchFn: FetchLike;
  private readonly project: string;
  private readonly baseUrl: string;

  constructor(opts: { fetch?: FetchLike; project?: string; baseUrl?: string } = {}) {
    this.fetchFn = fetchOf(opts.fetch);
    this.project = opts.project ?? "en.wikipedia";
    this.baseUrl = opts.baseUrl ?? "https://wikimedia.org/api/rest_v1/metrics/pageviews";
  }

  /** Keyword → article title guess: "first snow" → "First_snow". Topics can carry explicit "wiki:Title" keywords. */
  static articleFor(keyword: string): string {
    const explicit = keyword.match(/^wiki:(.+)$/i)?.[1];
    const raw = (explicit ?? keyword).trim().replace(/\s+/g, "_");
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  async sample(req: SampleRequest): Promise<SamplePoint[]> {
    const explicit = req.keywords.filter((k) => /^wiki:/i.test(k));
    const articles = [...new Set((explicit.length ? explicit : req.keywords.slice(0, 3)).map(WikipediaPageviewsSource.articleFor))];
    const start = yyyymmdd(new Date(Math.max(req.since.getTime(), req.now.getTime() - 60 * DAY_MS)));
    const end = yyyymmdd(new Date(req.now.getTime() - DAY_MS)); // today is incomplete
    const byDay = new Map<string, number>();
    for (const a of articles) {
      const url = `${this.baseUrl}/per-article/${this.project}/all-access/user/${encodeURIComponent(a)}/daily/${start}/${end}`;
      let body: PerArticle;
      try {
        body = await getJson<PerArticle>(this.fetchFn, this.name, url);
      } catch (e) {
        if ((e as { status?: number }).status === 404) continue; // no such article: that keyword is simply not a page
        throw e;
      }
      for (const it of body.items ?? []) byDay.set(it.timestamp, (byDay.get(it.timestamp) ?? 0) + it.views);
    }
    return [...byDay.entries()]
      .map(([ts, v]) => ({ at: new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T00:00:00Z`), v }))
      .filter((p) => p.at.getTime() > req.since.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((p) => ({ observedAt: p.at.toISOString(), value: p.v }));
  }

  async trending(req: TrendingRequest): Promise<TrendingItem[]> {
    const day = new Date(req.now.getTime() - DAY_MS);
    const [y, mo, d] = day.toISOString().slice(0, 10).split("-");
    const body = await getJson<TopResponse>(this.fetchFn, this.name, `${this.baseUrl}/top/${this.project}/all-access/${y}/${mo}/${d}`);
    return (body.items?.[0]?.articles ?? [])
      .filter((a) => !NON_CONTENT.test(a.article))
      .slice(0, 40)
      .map((a) => ({
        term: a.article.replace(/_/g, " "),
        value: a.views,
        url: `https://${this.project}.org/wiki/${encodeURIComponent(a.article)}`,
        observedAt: day.toISOString(),
        region: "global",
      }));
  }
}
