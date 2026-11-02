import { adaptForNetwork } from "./adaptForNetwork.ts";
import { classifyTopic } from "./classifyTopic.ts";
import { clusterSignals } from "./clusterSignals.ts";
import { draftForTrend } from "./draftForTrend.ts";
import { scoreRelevance } from "./scoreRelevance.ts";
import type { PromptSpec } from "./types.ts";
import { writeBrief } from "./writeBrief.ts";

export * from "./types.ts";
export * from "./context.ts";
export * from "./shared.ts";
export * from "./adaptForNetwork.ts";
export * from "./draftForTrend.ts";
export * from "./clusterSignals.ts";
export * from "./writeBrief.ts";
export * from "./classifyTopic.ts";
export * from "./scoreRelevance.ts";

/** Every prompt the gateway knows, for evals and the fake gateway. */
export const ALL_PROMPTS: readonly PromptSpec[] = [adaptForNetwork, draftForTrend, clusterSignals, writeBrief, classifyTopic, scoreRelevance];
