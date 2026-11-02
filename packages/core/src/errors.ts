export type CoreErrorCode = "not_found" | "forbidden" | "invalid" | "conflict" | "policy_blocked" | "unavailable";

export class CoreError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CoreError";
  }
  get httpStatus(): number {
    switch (this.code) {
      case "not_found":
        return 404;
      case "forbidden":
        return 403;
      case "invalid":
        return 400;
      case "conflict":
        return 409;
      case "policy_blocked":
        return 422;
      case "unavailable":
        return 503;
    }
  }
}

/** Thrown by publishing when at least one variant failed with a retryable connector error. */
export class RetryablePublishError extends Error {
  constructor(
    public readonly postId: string,
    public readonly failedVariantIds: string[],
  ) {
    super(`post ${postId}: ${failedVariantIds.length} variant(s) failed retryably`);
    this.name = "RetryablePublishError";
  }
}
