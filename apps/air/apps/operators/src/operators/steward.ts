import { createHash } from "node:crypto";
import { classifyTopic, runPrompt, type BrandContext, type Effort, type ModelGateway } from "@base-air/ai";
import type { RedLine } from "@base-air/schema";

type SemanticLine = Extract<RedLine, { kind: "forbidden_topic" }>;
const isSemantic = (rl: RedLine): rl is SemanticLine => rl.kind === "forbidden_topic" && rl.semantic;
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export interface StewardClassifier {
  /**
   * The synchronous hook core's gate calls for `forbidden_topic` red lines marked `semantic`.
   * Returns the cached likelihood (0..1) for this exact text/topic pair, or 0 on a cold cache while an async fill
   * is scheduled. Honest consequence: a semantic red line fires on the SECOND evaluation of a text (an approval
   * re-check, a schedule re-gate, the next watch run), not the first, unless the text was primed beforehand.
   */
  classify(text: string, keywords: string[], description: string): number;
  /** Fill the cache for these texts against every semantic red line, so the first gate evaluation is informed. */
  prime(texts: string[], redLines: RedLine[]): Promise<void>;
  /** Resolve once every scheduled fill has landed (tests, graceful shutdown). */
  settle(): Promise<void>;
  readonly size: number;
  readonly inflight: number;
}

export interface StewardOptions {
  effort?: Effort;
  /** Cache entries kept; oldest are evicted first. */
  maxEntries?: number;
  /** Brand context for the prompt, if the caller has one handy. */
  brand?: () => BrandContext | undefined;
  onError?: (err: Error) => void;
}

/**
 * Semantic topic classifier for the Steward: wraps the `classifyTopic` prompt behind a small cache so core's
 * synchronous `classifyTopic` dependency can be served without blocking. Keyword red lines are unaffected; they are
 * evaluated inline by the policy package. Only `semantic: true` topic lines consult this.
 */
export function stewardClassifier(gw: ModelGateway, opts: StewardOptions = {}): StewardClassifier {
  const maxEntries = opts.maxEntries ?? 5_000;
  const cache = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  const onError = opts.onError ?? ((e: Error) => console.error(`[steward] classify failed: ${e.message}`));

  const keyOf = (text: string, keywords: string[], description: string) =>
    createHash("sha256").update(text).update("\u0000").update(keywords.join("\u0001")).update("\u0000").update(description).digest("hex");

  const remember = (key: string, value: number) => {
    cache.set(key, value);
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  const fill = (key: string, text: string, keywords: string[], description: string): Promise<void> => {
    const running = pending.get(key);
    if (running) return running;
    const p = runPrompt(gw, classifyTopic, { text, keywords, description, brand: opts.brand?.() }, opts.effort)
      .then((res) => remember(key, clamp01(res.output.likelihood)))
      .catch((e: unknown) => onError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  };

  return {
    classify(text, keywords, description) {
      const key = keyOf(text, keywords, description);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      void fill(key, text, keywords, description);
      return 0;
    },
    async prime(texts, redLines) {
      const lines = redLines.filter(isSemantic);
      const jobs: Promise<void>[] = [];
      for (const text of texts) {
        for (const rl of lines) {
          const key = keyOf(text, rl.keywords, rl.description);
          if (!cache.has(key)) jobs.push(fill(key, text, rl.keywords, rl.description));
        }
      }
      await Promise.all(jobs);
    },
    async settle() {
      await Promise.all([...pending.values()]);
    },
    get size() {
      return cache.size;
    },
    get inflight() {
      return pending.size;
    },
  };
}

/** Just the function core wants: `new BaseAir({ ..., classifyTopic: makeClassifier(gw) })`. Same cold-cache caveat. */
export function makeClassifier(gw: ModelGateway, opts: StewardOptions = {}): (text: string, keywords: string[], description: string) => number {
  return stewardClassifier(gw, opts).classify;
}
