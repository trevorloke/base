import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlueskySearchSource,
  GoogleTrendsApiSource,
  GoogleTrendsRssSource,
  HackerNewsSource,
  SourceError,
  WikipediaPageviewsSource,
  YouTubeTrendingSource,
  bucketCounts,
  createDefaultSources,
  parseTrendsRss,
  type FetchLike,
} from "../src/index.ts";

const NOW = new Date("2026-11-02T12:30:00Z");
const H = 3_600_000;

function fakeFetch(routes: [RegExp, (url: string) => { status?: number; body: unknown }][]): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    for (const [re, h] of routes) {
      if (re.test(url)) {
        const r = h(url);
        const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
        return new Response(text, { status: r.status ?? 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("bucketCounts", () => {
  it("excludes the current partial bucket and fills gaps with zeros", () => {
    const from = Date.parse("2026-11-02T09:00:00Z");
    const to = NOW.getTime();
    const t = (s: string) => Date.parse(s);
    const b = bucketCounts([t("2026-11-02T09:10:00Z"), t("2026-11-02T09:50:00Z"), t("2026-11-02T11:05:00Z"), t("2026-11-02T12:10:00Z")], from, to, H);
    expect(b.map((x) => x.n)).toEqual([2, 0, 1]);
  });
});

describe("Google Trends RSS", () => {
  const xml = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
    <item><title>first snow</title><ht:approx_traffic>20,000+</ht:approx_traffic><pubDate>Mon, 2 Nov 2026 11:00:00 -0800</pubDate>
      <ht:news_item><ht:news_item_title><![CDATA[Snow hits the &amp; North Shore]]></ht:news_item_title><ht:news_item_url>https://news.example/snow</ht:news_item_url></ht:news_item>
    </item>
    <item><title>world series</title><ht:approx_traffic>500K+</ht:approx_traffic></item>
  </channel></rss>`;
  it("parses terms, traffic, time and headlines", () => {
    const items = parseTrendsRss(xml, "CA", NOW);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ term: "first snow", value: 20000, url: "https://news.example/snow", region: "CA", context: ["Snow hits the & North Shore"] });
    expect(items[0]!.observedAt).toBe("2026-11-02T19:00:00.000Z");
    expect(items[1]).toMatchObject({ term: "world series", value: 500, observedAt: NOW.toISOString() });
  });
  it("fetches the region's feed", async () => {
    const f = fakeFetch([[/trending\/rss\?geo=CA/, () => ({ body: xml })]]);
    const items = await new GoogleTrendsRssSource({ fetch: f }).trending({ now: NOW, region: "ca" });
    expect(items).toHaveLength(2);
  });
});

describe("Google Trends API (alpha)", () => {
  it("is unconfigured without a key and returns nothing", async () => {
    const s = new GoogleTrendsApiSource();
    expect(s.configured).toBe(false);
    expect(await s.sample({ keywords: ["x"], since: new Date(0), now: NOW })).toEqual([]);
  });
  it("sums multi-term values and drops points at or before since", async () => {
    const f = fakeFetch([[/timelines/, () => ({ body: { timeline: [{ time: "2026-10-30T00:00:00Z", value: [10, 5] }, { time: "2026-10-31T00:00:00Z", value: [20, 5] }, { date: "bad", value: 1 }] } })]]);
    const pts = await new GoogleTrendsApiSource({ apiKey: "k", fetch: f }).sample({ keywords: ["a", "b"], since: new Date("2026-10-30T00:00:00Z"), now: NOW });
    expect(pts).toEqual([{ observedAt: "2026-10-31T00:00:00.000Z", value: 25, region: "US" }]);
    expect(f.calls[0]).toMatch(/terms=a%2Cb/);
  });
});

describe("Wikipedia pageviews", () => {
  it("maps keywords to articles, sums views per day, skips missing pages", async () => {
    const f = fakeFetch([
      [/per-article\/en\.wikipedia\/all-access\/user\/First_snow\//, () => ({ body: { items: [{ timestamp: "2026103000", views: 100 }, { timestamp: "2026103100", views: 300 }] } })],
      [/per-article\/en\.wikipedia\/all-access\/user\/Snowfall\//, () => ({ body: { items: [{ timestamp: "2026103100", views: 50 }] } })],
    ]);
    const pts = await new WikipediaPageviewsSource({ fetch: f }).sample({ keywords: ["first snow", "snowfall", "nonexistent thing"], since: new Date("2026-10-20T00:00:00Z"), now: NOW });
    expect(pts).toEqual([
      { observedAt: "2026-10-30T00:00:00.000Z", value: 100 },
      { observedAt: "2026-10-31T00:00:00.000Z", value: 350 },
    ]);
  });
  it("prefers explicit wiki: keywords", async () => {
    const f = fakeFetch([[/per-article/, () => ({ body: { items: [] } })]]);
    await new WikipediaPageviewsSource({ fetch: f }).sample({ keywords: ["snow", "wiki:North_Shore_Mountains"], since: new Date("2026-10-20T00:00:00Z"), now: NOW });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatch(/North_Shore_Mountains/);
  });
  it("lists yesterday's top articles without non-content pages", async () => {
    const f = fakeFetch([[/top\/en\.wikipedia\/all-access\/2026\/11\/01/, () => ({ body: { items: [{ articles: [{ article: "Main_Page", views: 9e6, rank: 1 }, { article: "Special:Search", views: 1e6, rank: 2 }, { article: "World_Series", views: 4e5, rank: 3 }] }] } })]]);
    const items = await new WikipediaPageviewsSource({ fetch: f }).trending({ now: NOW });
    expect(items.map((i) => i.term)).toEqual(["World Series"]);
  });
});

describe("Hacker News", () => {
  it("counts mentions per complete hour and pages until done", async () => {
    let page = 0;
    const f = fakeFetch([
      [
        /search_by_date/,
        () => {
          page++;
          const at = (s: string) => Math.floor(Date.parse(s) / 1000);
          return page === 1
            ? { body: { nbPages: 2, hits: [{ objectID: "1", created_at_i: at("2026-11-02T10:15:00Z") }, { objectID: "2", created_at_i: at("2026-11-02T11:40:00Z") }] } }
            : { body: { nbPages: 2, hits: [{ objectID: "3", created_at_i: at("2026-11-02T11:05:00Z") }, { objectID: "4", created_at_i: at("2026-11-02T12:20:00Z") }] } };
        },
      ],
    ]);
    const pts = await new HackerNewsSource({ fetch: f }).sample({ keywords: ["rust"], since: new Date("2026-11-02T10:00:00Z"), now: NOW });
    expect(pts).toEqual([
      { observedAt: "2026-11-02T10:00:00.000Z", value: 1 },
      { observedAt: "2026-11-02T11:00:00.000Z", value: 2 },
    ]);
    expect(f.calls).toHaveLength(2);
  });
  it("maps the front page to trending items", async () => {
    const f = fakeFetch([[/tags=front_page/, () => ({ body: { hits: [{ objectID: "9", title: "Show HN: a thing", url: null, points: 120 }] } })]]);
    const items = await new HackerNewsSource({ fetch: f }).trending({ now: NOW });
    expect(items[0]).toMatchObject({ term: "Show HN: a thing", value: 120, url: "https://news.ycombinator.com/item?id=9" });
  });
});

describe("Bluesky search", () => {
  it("counts posts per hour across keywords and stops paging past the window", async () => {
    const f = fakeFetch([
      [/q=snow/, () => ({ body: { posts: [{ record: { createdAt: "2026-11-02T11:10:00Z" } }, { record: { createdAt: "2026-11-02T10:50:00Z" } }], cursor: undefined } })],
      [/q=spikes/, () => ({ body: { posts: [{ indexedAt: "2026-11-02T11:59:00Z" }] } })],
    ]);
    const pts = await new BlueskySearchSource({ fetch: f }).sample({ keywords: ["snow", "spikes"], since: new Date("2026-11-02T10:00:00Z"), now: NOW });
    expect(pts).toEqual([
      { observedAt: "2026-11-02T10:00:00.000Z", value: 1 },
      { observedAt: "2026-11-02T11:00:00.000Z", value: 2 },
    ]);
  });
  it("explains a 403 as needing a token", async () => {
    const f = fakeFetch([[/searchPosts/, () => ({ status: 403, body: { error: "Forbidden" } })]]);
    await expect(new BlueskySearchSource({ fetch: f }).sample({ keywords: ["x"], since: new Date("2026-11-02T10:00:00Z"), now: NOW })).rejects.toThrow(/BASE_AIR_BLUESKY_SEARCH_TOKEN/);
  });
});

describe("YouTube trending", () => {
  it("needs a key; maps the chart", async () => {
    expect(new YouTubeTrendingSource().configured).toBe(false);
    const f = fakeFetch([[/chart=mostPopular/, () => ({ body: { items: [{ id: "abc", snippet: { title: "Winter hiking gear", tags: ["hiking"] }, statistics: { viewCount: "12345" } }] } })]]);
    const items = await new YouTubeTrendingSource({ apiKey: "k", fetch: f }).trending({ now: NOW, region: "CA" });
    expect(items[0]).toMatchObject({ term: "Winter hiking gear", value: 12345, url: "https://www.youtube.com/watch?v=abc", region: "CA", context: ["hiking"] });
  });
});

describe("errors and factory", () => {
  it("marks 429 and 5xx retryable, 4xx not", async () => {
    const f429 = fakeFetch([[/front_page/, () => ({ status: 429, body: "slow down" })]]);
    await expect(new HackerNewsSource({ fetch: f429 }).trending({ now: NOW })).rejects.toMatchObject({ retryable: true, status: 429 });
    const f400 = fakeFetch([[/front_page/, () => ({ status: 400, body: "bad" })]]);
    const err = await new HackerNewsSource({ fetch: f400 }).trending({ now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.retryable).toBe(false);
  });
  it("lists every source, configured by env, and can be limited", () => {
    const all = createDefaultSources({});
    expect(all.map((s) => s.name)).toEqual(["google_trends", "google_trends_rss", "wikipedia_pageviews", "hacker_news", "bluesky_search", "youtube_trending"]);
    expect(all.filter((s) => s.configured).map((s) => s.name)).toEqual(["google_trends_rss", "wikipedia_pageviews", "hacker_news", "bluesky_search"]);
    expect(createDefaultSources({ YOUTUBE_API_KEY: "k", BASE_AIR_SOURCES: "youtube_trending,hacker_news" }).map((s) => [s.name, s.configured])).toEqual([
      ["hacker_news", true],
      ["youtube_trending", true],
    ]);
  });
});
