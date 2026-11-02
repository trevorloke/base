import type { z } from "zod";

/** Effort is the one depth control on claude-opus-5-5 (thinking is always on). "medium" is routine drafting; "high" is the brief. */
export type Effort = "low" | "medium" | "high";

/** Non-streaming default per the Claude API skill: keeps responses under SDK HTTP timeouts. */
export const DEFAULT_MAX_TOKENS = 16_000;
/** Streaming default per the skill: timeouts are not a concern, so long outputs get room. */
export const STREAMING_MAX_TOKENS = 64_000;

/**
 * A versioned prompt. `system` is grounded in the brand context carried in `vars` (stable per workspace, hence
 * cacheable); `user` carries the task data. `schema` is both the structured-output format sent to the API and the
 * validator applied to what comes back. Bump `version` whenever the wording changes: the tag lands in every ledger row.
 */
export interface PromptSpec<TVars extends Record<string, unknown> = Record<string, unknown>, TOut = unknown> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  system(vars: TVars): string;
  user(vars: TVars): string;
  readonly schema: z.ZodType<TOut>;
  /** Default effort when the caller does not pass one. */
  readonly effort: Effort;
  /** Stream the response (long outputs such as the weekly brief). */
  readonly stream: boolean;
  readonly maxTokens: number;
}

export interface PromptDefinition<TVars extends Record<string, unknown>, TOut> {
  name: string;
  version: string;
  description: string;
  system: (vars: TVars) => string;
  user: (vars: TVars) => string;
  schema: z.ZodType<TOut>;
  effort?: Effort;
  stream?: boolean;
  maxTokens?: number;
}

export function definePrompt<TVars extends Record<string, unknown>, TOut>(def: PromptDefinition<TVars, TOut>): PromptSpec<TVars, TOut> {
  const stream = def.stream ?? false;
  return {
    name: def.name,
    version: def.version,
    description: def.description,
    system: def.system,
    user: def.user,
    schema: def.schema,
    effort: def.effort ?? "medium",
    stream,
    maxTokens: def.maxTokens ?? (stream ? STREAMING_MAX_TOKENS : DEFAULT_MAX_TOKENS),
  };
}

/** "name@version": what the ledger, the disclosure record and the run row carry. */
export function promptVersionTag(prompt: PromptSpec): string {
  return `${prompt.name}@${prompt.version}`;
}
