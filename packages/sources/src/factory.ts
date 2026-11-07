import { BlueskySearchSource } from "./bluesky-search.ts";
import { GoogleTrendsApiSource } from "./google-trends-api.ts";
import { GoogleTrendsRssSource } from "./google-trends-rss.ts";
import { HackerNewsSource } from "./hacker-news.ts";
import type { SourceAdapter } from "./types.ts";
import { WikipediaPageviewsSource } from "./wikipedia.ts";
import { YouTubeTrendingSource } from "./youtube.ts";

/**
 * Every source a deployment knows about, configured or not (unconfigured ones are listed so the room can say
 * what is missing). STARSIGN_SOURCES=a,b limits the set; STARSIGN_TRENDS_REGION sets the default country.
 */
export function createDefaultSources(env: NodeJS.ProcessEnv = process.env): SourceAdapter[] {
  const all: SourceAdapter[] = [
    new GoogleTrendsApiSource({ apiKey: env.GOOGLE_TRENDS_API_KEY, ...(env.GOOGLE_TRENDS_API_URL ? { baseUrl: env.GOOGLE_TRENDS_API_URL } : {}) }),
    new GoogleTrendsRssSource(),
    new WikipediaPageviewsSource({ ...(env.STARSIGN_WIKI_PROJECT ? { project: env.STARSIGN_WIKI_PROJECT } : {}) }),
    new HackerNewsSource(),
    new BlueskySearchSource({ ...(env.STARSIGN_BLUESKY_SEARCH_TOKEN ? { token: env.STARSIGN_BLUESKY_SEARCH_TOKEN } : {}) }),
    new YouTubeTrendingSource({ apiKey: env.YOUTUBE_API_KEY }),
  ];
  const only = env.STARSIGN_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean);
  return only?.length ? all.filter((s) => only.includes(s.name)) : all;
}
