import type { z } from "zod";
import { estimateCostUsd } from "./pricing.ts";
import { promptVersionTag, type Effort, type PromptSpec } from "./prompts/types.ts";

export interface GatewayUsage {
  /** All prompt tokens the call consumed, cached or not. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** The model that answered (a fallback model when the requested one declined). */
  model: string;
  /** "name@version" of the prompt that ran. */
  promptVersion: string;
}

export interface CompleteRequest<T> {
  prompt: PromptSpec;
  vars: Record<string, unknown>;
  schema: z.ZodType<T>;
  effort?: Effort;
}

export interface CompleteResult<T> {
  output: T;
  usage: GatewayUsage;
}

/** The one door to the model. Operators depend on this, never on a provider SDK. */
export interface ModelGateway {
  complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>>;
}

/** Typed convenience: run a prompt with its own vars and schema. */
export function runPrompt<TVars extends Record<string, unknown>, TOut>(gw: ModelGateway, prompt: PromptSpec<TVars, TOut>, vars: TVars, effort?: Effort): Promise<CompleteResult<TOut>> {
  return gw.complete<TOut>({ prompt, vars, schema: prompt.schema, effort });
}

export type FakeHandler = (vars: Record<string, unknown>, req: { prompt: PromptSpec; effort: Effort }) => unknown | Promise<unknown>;

export interface FakeCall {
  prompt: string;
  version: string;
  effort: Effort;
  vars: Record<string, unknown>;
  output: unknown;
  /** The rendered prompt text, so tests can assert on grounding. */
  system: string;
  user: string;
}

export interface FakeGatewayOptions {
  /** Reported as `usage.model`. */
  model?: string;
  /** Price the fake usage as this model so budget math is exercised. */
  priceAs?: string;
}

/**
 * A gateway for tests and offline development: handlers keyed by prompt name return the output; the fake renders
 * the real prompt text, validates the output against the schema exactly like the real gateway, and records every call.
 */
export class FakeGateway implements ModelGateway {
  readonly calls: FakeCall[] = [];
  readonly model: string;
  private readonly priceAs: string;
  private readonly handlers = new Map<string, FakeHandler>();

  constructor(handlers: Record<string, FakeHandler> = {}, opts: FakeGatewayOptions = {}) {
    for (const [name, h] of Object.entries(handlers)) this.handlers.set(name, h);
    this.model = opts.model ?? "fake";
    this.priceAs = opts.priceAs ?? "claude-opus-5-5";
  }

  /** Add or replace a handler. */
  on(promptName: string, handler: FakeHandler): this {
    this.handlers.set(promptName, handler);
    return this;
  }

  callsFor(promptName: string): FakeCall[] {
    return this.calls.filter((c) => c.prompt === promptName);
  }

  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const handler = this.handlers.get(req.prompt.name);
    if (!handler) throw new Error(`FakeGateway: no handler for prompt "${req.prompt.name}"`);
    const effort = req.effort ?? req.prompt.effort;
    const system = req.prompt.system(req.vars);
    const user = req.prompt.user(req.vars);
    const raw = await handler(req.vars, { prompt: req.prompt, effort });
    // Same contract as the real gateway: an output that does not satisfy the schema is an error, not a value.
    const output = req.schema.parse(raw);
    const inputTokens = Math.ceil((system.length + user.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(output).length / 4);
    const usage: GatewayUsage = {
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(this.priceAs, { inputTokens, outputTokens }),
      model: this.model,
      promptVersion: promptVersionTag(req.prompt),
    };
    this.calls.push({ prompt: req.prompt.name, version: req.prompt.version, effort, vars: req.vars, output, system, user });
    return { output, usage };
  }
}
