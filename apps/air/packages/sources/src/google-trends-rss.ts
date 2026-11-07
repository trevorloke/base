import { decodeXml, fetchOf, getText } from "./http.ts";
import { HOUR_MS, type FetchLike, type SourceAdapter, type TrendingItem, type TrendingRequest } from "./types.ts";

/**
 * Google Trends "Trending now" RSS: free, public, per country, refreshed through the day.
 * Discovery only: it says what is spiking, not a time series for arbitrary keywords.
 * Feed shape: <item><title>term</title><ht:approx_traffic>20,000+</ht:approx_traffic><pubDate>...</pubDate>
 * <ht:news_item><ht:news_item_title>...</ht:news_item_title><ht:news_item_url>...</ht:news_item_url></ht:news_item></item>
 */
export class GoogleTrendsRssSource implements SourceAdapter {
  readonly name = "google_trends_rss" as const;
  readonly configured = true;
  readonly granularityMs = HOUR_MS;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: { fetch?: FetchLike; baseUrl?: string } = {}) {
    this.fetchFn = fetchOf(opts.fetch);
    this.baseUrl = opts.baseUrl ?? "https://trends.google.com/trending/rss";
  }

  async trending(req: TrendingRequest): Promise<TrendingItem[]> {
    const geo = (req.region ?? "US").toUpperCase();
    const xml = await getText(this.fetchFn, this.name, `${this.baseUrl}?geo=${encodeURIComponent(geo)}`);
    return parseTrendsRss(xml, geo, req.now);
  }
}

export function parseTrendsRss(xml: string, region: string, now: Date): TrendingItem[] {
  const items: TrendingItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1] ?? "";
    const tag = (name: string) => {
      const t = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
      return t?.[1] !== undefined ? decodeXml(t[1]) : null;
    };
    const term = tag("title");
    if (!term) continue;
    const traffic = tag("ht:approx_traffic");
    const value = traffic ? Number(traffic.replace(/[^\d]/g, "")) || null : null;
    const pub = tag("pubDate");
    const observed = pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub) : now;
    const headlines = [...body.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map((h) => decodeXml(h[1] ?? "")).filter(Boolean);
    const firstUrl = body.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/)?.[1];
    items.push({
      term,
      value,
      url: firstUrl ? decodeXml(firstUrl) : null,
      observedAt: observed.toISOString(),
      region,
      ...(headlines.length ? { context: headlines.slice(0, 3) } : {}),
    });
  }
  return items;
}
