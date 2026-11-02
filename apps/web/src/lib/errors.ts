/** An error the API returned (or a network failure, status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** A short, human sentence for any thrown value. */
export function errorText(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 0) return "Couldn't reach Starsign.";
    if (e.status === 401) return "That key didn't work.";
    if (e.status === 403) return "Your key isn't allowed to do that.";
    if (e.status >= 500 && e.code.startsWith("http_")) return "Starsign isn't answering right now.";
    return e.message || "Something went wrong.";
  }
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
