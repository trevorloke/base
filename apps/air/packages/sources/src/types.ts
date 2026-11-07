import type { TrendSource } from "@starsign/schema";

/** One observation of how much attention a set of keywords is getting. */
export interface SamplePoint {
  observedAt: string;
  value: number;
  region?: string;
}

/** A term some platform says is trending right now. Discovery input, before it becomes a topic. */
export interface TrendingItem {
  term: string;
  /** Platform-reported size (approx traffic, views, points), when it gives one. */
  value: number | null;
  url: string | null;
  observedAt: string;
  region: string;
  /** Extra context the platform attached (news headlines, categories). */
  context?: string[];
}

export interface SampleRequest {
  keywords: string[];
  /** Only return observations after this instant. */
  since: Date;
  now: Date;
  region?: string;
}

export interface TrendingRequest {
  now: Date;
  region?: string;
}

/**
 * A trend source. `sample` answers "how much attention are these keywords getting over time";
 * `trending` answers "what is rising right now". A source may do either or both.
 */
export interface SourceAdapter {
  readonly name: TrendSource;
  /** False when the source needs credentials this deployment does not have. Unconfigured sources are skipped. */
  readonly configured: boolean;
  /** Minimum interval between samples worth taking (the source's own granularity). */
  readonly granularityMs: number;
  sample?(req: SampleRequest): Promise<SamplePoint[]>;
  trending?(req: TrendingRequest): Promise<TrendingItem[]>;
}

export class SourceError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
