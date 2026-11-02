import Anthropic, { APIConnectionError, APIError, AnthropicError, AuthenticationError, BadRequestError, InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ModelGatewayError, ModelOutputError, ModelRefusalError } from "./errors.ts";
import type { CompleteRequest, CompleteResult, GatewayUsage, ModelGateway } from "./gateway.ts";
import { estimateCostUsd, priceFor } from "./pricing.ts";
import { promptVersionTag } from "./prompts/types.ts";

/** The exact model id, no date suffix. Overridable with MERIDIAN_MODEL. */
export const DEFAULT_MODEL = "claude-opus-5-5";
/** Beta header for the `fallbacks: "default"` scalar form (the array form uses the -06-01 header). */
export const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function resolveModel(env: NodeJS.ProcessEnv = process.env): string {
  const m = env.MERIDIAN_MODEL?.trim();
  return m && m.length > 0 ? m : DEFAULT_MODEL;
}

export interface AnthropicGatewayOptions {
  /** Injected client (tests). By default the SDK resolves credentials from the environment: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile. */
  client?: Anthropic;
  model?: string;
  /** Server-side refusal fallback (`fallbacks: "default"`), on by default. */
  refusalFallback?: boolean;
  /** SDK retry count for 408/409/429/5xx and connection errors. Default 2. */
  maxRetries?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * The Claude-backed gateway. One request shape for every prompt:
 * - structured output through `output_config.format` (the zod schema), parsed by the SDK into `parsed_output`;
 * - `output_config.effort` as the only depth control: claude-opus-5-5 has thinking always on, so no `thinking`,
 *   `budget_tokens` or sampling parameters are sent (the API rejects them);
 * - the server-side refusal fallback, so a policy decline re-runs on Anthropic's recommended substitute inside the
 *   same call; `stop_reason: "refusal"` on the final message means the whole chain declined;
 * - streaming with `finalMessage()` for long outputs (the weekly brief), `parse()` otherwise.
 */
export class AnthropicGateway implements ModelGateway {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly refusalFallback: boolean;
  private readonly log: (line: string) => void;

  constructor(opts: AnthropicGatewayOptions = {}) {
    this.model = opts.model ?? resolveModel();
    this.refusalFallback = opts.refusalFallback ?? true;
    this.log = opts.log ?? (() => {});
    // No API key in code: `new Anthropic()` reads the environment / auth profile.
    this.client = opts.client ?? new Anthropic({ maxRetries: opts.maxRetries ?? 2, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) });
  }

  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const { prompt, vars } = req;
    const tag = promptVersionTag(prompt);
    const effort = req.effort ?? prompt.effort;
    const format = betaZodOutputFormat(req.schema);
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      // Role + brand context: stable per workspace, so it is the cacheable prefix. Task data goes in the user turn.
      { type: "text", text: prompt.system(vars), cache_control: { type: "ephemeral" } },
    ];
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt.user(vars) }];
    const params = {
      model: this.model,
      max_tokens: prompt.maxTokens,
      system,
      messages,
      output_config: { effort, format },
      betas: this.refusalFallback ? [REFUSAL_FALLBACK_BETA] : undefined,
      fallbacks: this.refusalFallback ? ("default" as const) : undefined,
    } satisfies Anthropic.Beta.MessageCreateParamsNonStreaming;

    const message = await this.send(params, prompt.stream);

    // Check the stop reason before trusting content: a decline is an HTTP 200.
    if (message.stop_reason === "refusal") {
      throw new ModelRefusalError(message.model, message.stop_details?.category ?? null, message.stop_details?.explanation ?? null);
    }
    if (message.stop_reason === "max_tokens") {
      throw new ModelOutputError("truncated", `${tag}: output cut off at max_tokens=${prompt.maxTokens}; raise the prompt's maxTokens`, message.stop_reason);
    }
    if (message.stop_reason !== null && message.stop_reason !== "end_turn" && message.stop_reason !== "stop_sequence") {
      throw new ModelOutputError("unexpected_stop", `${tag}: unexpected stop_reason ${message.stop_reason}`, message.stop_reason);
    }
    const output = message.parsed_output;
    if (output === null || output === undefined) {
      throw new ModelOutputError("missing", `${tag}: the reply carried no structured output`, message.stop_reason);
    }

    const served = message.model;
    const fallbackRan = (message.usage.iterations ?? []).some((it) => it.type === "fallback_message");
    if (fallbackRan || served !== this.model) this.log(`[ai] ${tag}: served by ${served} (requested ${this.model})`);

    const u = message.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    // Bill at the serving model's rates when we know them (a fallback rescue is priced by the fallback model).
    const priceModel = priceFor(served) ? served : this.model;
    const usage: GatewayUsage = {
      inputTokens: u.input_tokens + cacheRead + cacheWrite,
      outputTokens: u.output_tokens,
      costUsd: estimateCostUsd(priceModel, { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }),
      model: served,
      promptVersion: tag,
    };
    return { output, usage };
  }

  private async send<P extends Anthropic.Beta.MessageCreateParamsNonStreaming>(params: P, stream: boolean) {
    try {
      // Long outputs stream and resolve through finalMessage(); everything else goes through parse().
      return stream ? await this.client.beta.messages.stream(params).finalMessage() : await this.client.beta.messages.parse(params);
    } catch (err) {
      throw translateError(err);
    }
  }
}

/** Map the SDK's typed errors onto the gateway's, most specific first. Never string-matches messages. */
export function translateError(err: unknown): Error {
  if (err instanceof ModelGatewayError || err instanceof ModelRefusalError || err instanceof ModelOutputError) return err;
  if (err instanceof RateLimitError) return new ModelGatewayError("rate_limited", err.message, true, err.status, { cause: err });
  if (err instanceof AuthenticationError) return new ModelGatewayError("authentication", err.message, false, err.status, { cause: err });
  if (err instanceof PermissionDeniedError) return new ModelGatewayError("permission", err.message, false, err.status, { cause: err });
  if (err instanceof NotFoundError) return new ModelGatewayError("not_found", err.message, false, err.status, { cause: err });
  if (err instanceof BadRequestError) return new ModelGatewayError("bad_request", err.message, false, err.status, { cause: err });
  if (err instanceof InternalServerError) {
    const overloaded = err.status === 529 || err.type === "overloaded_error";
    return new ModelGatewayError(overloaded ? "overloaded" : "server", err.message, true, err.status, { cause: err });
  }
  // APIConnectionError extends APIError in this SDK, so it is checked first.
  if (err instanceof APIConnectionError) return new ModelGatewayError("connection", err.message, true, undefined, { cause: err });
  if (err instanceof APIError) return new ModelGatewayError("api", err.message, (err.status ?? 0) >= 500, err.status, { cause: err });
  // The SDK's structured-output parser throws its base error when the reply is not JSON or fails the zod schema.
  if (err instanceof AnthropicError) return new ModelOutputError("unparseable", err.message, null, { cause: err });
  return err instanceof Error ? err : new Error(String(err));
}
