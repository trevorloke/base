export type GatewayErrorCode = "rate_limited" | "overloaded" | "authentication" | "permission" | "bad_request" | "not_found" | "connection" | "server" | "api";

/** A transport/API failure, translated from the SDK's typed error classes. `retryable` follows the status (429, 5xx, network). */
export class ModelGatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ModelGatewayError";
  }
}

/** The model (or the whole fallback chain) declined for policy reasons: HTTP 200 with `stop_reason: "refusal"`. */
export class ModelRefusalError extends Error {
  constructor(
    public readonly model: string,
    public readonly category: string | null,
    public readonly explanation: string | null,
  ) {
    super(`${model} refused the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
    this.name = "ModelRefusalError";
  }
}

export type ModelOutputProblem = "truncated" | "unparseable" | "missing" | "unexpected_stop";

/** The call succeeded but did not yield a usable structured output. */
export class ModelOutputError extends Error {
  constructor(
    public readonly problem: ModelOutputProblem,
    message: string,
    public readonly stopReason: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ModelOutputError";
  }
}
