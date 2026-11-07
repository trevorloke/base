// TODO(verify against the Google Trends API alpha docs once access is granted): request and response shapes
// below are ASSUMED from the public announcement (consistently scaled interest over time, 5-year window).
import { fetchOf, getJson } from "./http.ts";
import { DAY_MS, type FetchLike, type SampleRequest, type SamplePoint, type SourceAdapter } from "./types.ts";

interface AlphaTimelineResponse {
  timeline?: { time?: string; date?: string; value?: number | number[] }[];
}

/**
 * The official Google Trends API (alpha, invite-only). Gives interest over time for keywords with a stable
 * scale across requests, which is exactly what the forecaster wants. Configured only with GOOGLE_TRENDS_API_KEY.
 */
export class GoogleTrendsApiSource implements SourceAdapter {
  readonly name = "google_trends" as const;
  readonly configured: boolean;
  readonly granularityMs = DAY_MS;
  private readonly fetchFn: FetchLike;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(opts: { apiKey?: string; fetch?: FetchLike; baseUrl?: string } = {}) {
    this.apiKey = opts.apiKey;
    this.configured = !!opts.apiKey;
    this.fetchFn = fetchOf(opts.fetch);
    this.baseUrl = opts.baseUrl ?? "https://trends.googleapis.com/v1alpha";
  }

  async sample(req: SampleRequest): Promise<SamplePoint[]> {
    if (!this.apiKey || req.keywords.length === 0) return [];
    const params = new URLSearchParams({
      terms: req.keywords.slice(0, 5).join(","),
      startTime: req.since.toISOString(),
      endTime: req.now.toISOString(),
      geo: req.region ?? "US",
      key: this.apiKey,
    });
    const body = await getJson<AlphaTimelineResponse>(this.fetchFn, this.name, `${this.baseUrl}/timelines?${params}`);
    const out: SamplePoint[] = [];
    for (const row of body.timeline ?? []) {
      const at = row.time ?? row.date;
      if (!at || Number.isNaN(Date.parse(at))) continue;
      // Several terms come back as one value per term: the topic's attention is their sum.
      const v = Array.isArray(row.value) ? row.value.reduce((a, b) => a + b, 0) : row.value;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (Date.parse(at) <= req.since.getTime()) continue;
      out.push({ observedAt: new Date(at).toISOString(), value: v, region: req.region ?? "US" });
    }
    return out;
  }
}
