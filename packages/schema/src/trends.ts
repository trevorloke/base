import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { TrendStage } from "./content.ts";

export const TrendSource = z.enum([
  "google_trends",
  "google_trends_rss",
  "youtube_trending",
  "bluesky_firehose",
  "bluesky_search",
  "hacker_news",
  "wikipedia_pageviews",
  "reddit",
  "x",
  "tiktok_creative_center",
  "news",
  "own_feed",
  "ai_answers",
  "manual",
]);
export type TrendSource = z.infer<typeof TrendSource>;

export const TrendPointInput = z.object({
  topicId: Id,
  source: TrendSource,
  value: z.number(),
  observedAt: Timestamp,
  /** Optional region / segment key, e.g. "US", "CA-BC". */
  region: z.string().default("global"),
});
export type TrendPointInput = z.infer<typeof TrendPointInput>;

export const ForecastPoint = z.object({
  at: Timestamp,
  value: z.number(),
  lo: z.number(),
  hi: z.number(),
});

/** A forecast always carries a band. Narrow when sources agree and data is dense; wide when thin. */
export const TrendForecast = z.object({
  id: Id,
  topicId: Id,
  computedAt: Timestamp,
  stage: TrendStage,
  /** 0..1, how much to trust the stage + curve. */
  confidence: z.number().min(0).max(1),
  /** Normalized velocity (per hour, relative to level). */
  velocity: z.number(),
  acceleration: z.number(),
  /** Estimated hours until peak if rising; null otherwise. */
  hoursToPeak: z.number().nullable(),
  horizonHours: z.number().int().positive(),
  curve: z.array(ForecastPoint),
  modelVersion: z.string(),
  /** Which sources contributed and how well they agreed, 0..1. */
  sourceAgreement: z.number().min(0).max(1).nullable(),
  sources: z.array(TrendSource),
});
export type TrendForecast = z.infer<typeof TrendForecast>;

export const TrendTopic = z.object({
  id: Id,
  workspaceId: Id.nullable(),
  name: z.string(),
  keywords: z.array(z.string()),
  /** Relevance to the workspace's profile, 0..1, learned. Null for global topics not yet scored. */
  relevance: z.number().min(0).max(1).nullable(),
  createdAt: Timestamp,
});
export type TrendTopic = z.infer<typeof TrendTopic>;
