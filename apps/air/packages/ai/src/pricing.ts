/**
 * Model pricing in USD per million tokens, from the Claude API skill's price table (cached 2026-10-06).
 * First-party Claude API rates only. Cache writes are 1.25x input (5-minute TTL); cache reads use the published
 * figure where the skill lists one, otherwise 0.1x input.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
  // Models the server-side refusal fallback ("default") may serve a declined request on. The rescue is billed at the
  // serving model's own rates, so the gateway prices by the model that answered, not the one it asked for.
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
};

export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Exact id first; otherwise the longest known id that prefixes `model` at a "-" boundary (served ids may carry suffixes). */
export function priceFor(model: string): ModelPrice | null {
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  let best: string | null = null;
  for (const id of Object.keys(MODEL_PRICES)) {
    if (model.startsWith(`${id}-`) && (best === null || id.length > best.length)) best = id;
  }
  return best ? (MODEL_PRICES[best] ?? null) : null;
}

export function knownModels(): string[] {
  return Object.keys(MODEL_PRICES);
}

const warnedUnknown = new Set<string>();

/** Cost of one call in USD. Unknown models cost 0 (never guessed) and are flagged once per process. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  if (!p) {
    if (!warnedUnknown.has(model)) {
      warnedUnknown.add(model);
      console.warn(`[starsign/ai] no price known for model "${model}"; its cost is recorded as $0. Add it to MODEL_PRICES.`);
    }
    return 0;
  }
  const perTok = 1 / 1_000_000;
  return (
    usage.inputTokens * p.inputPerMTok * perTok +
    usage.outputTokens * p.outputPerMTok * perTok +
    (usage.cacheReadTokens ?? 0) * p.cacheReadPerMTok * perTok +
    (usage.cacheWriteTokens ?? 0) * p.cacheWritePerMTok * perTok
  );
}
