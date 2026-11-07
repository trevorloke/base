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

// The room talks to the API either with a pasted key (developers) or as a signed-in person.
// A 401 means something different to each, so the client tells this module which one is in use.
let keyMode = false;
export function setKeyMode(on: boolean): void {
  keyMode = on;
}

/** "cannot demote the last owner" → "Cannot demote the last owner." */
export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(first) ? first : `${first}.`;
}

/** The `details.reason` a connect or login refusal carries, when there is one. */
export function reasonOf(e: unknown): string | null {
  if (!isApiError(e) || !e.details || typeof e.details !== "object") return null;
  const r = (e.details as { reason?: unknown }).reason;
  return typeof r === "string" && r.trim() ? r : null;
}

/** A short, human sentence for any thrown value. */
export function errorText(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 0) return "Couldn't reach Starsign.";
    if (e.status === 401) return keyMode ? "That key didn't work." : "You're signed out. Sign in again.";
    if (e.status === 403) {
      if (keyMode) return "Your key isn't allowed to do that.";
      return e.message && !e.code.startsWith("http_") ? sentence(e.message) : "You aren't allowed to do that.";
    }
    if (e.status === 429) return e.code === "rate_limited" || e.code.startsWith("http_") ? "Too many attempts. Try again in 15 minutes." : sentence(e.message);
    if (e.status >= 500 && e.code.startsWith("http_")) return "Starsign isn't answering right now.";
    // A schema refusal says which field and why, not just "Validation failed."
    if (e.code === "invalid" && /^validation failed$/i.test(e.message) && Array.isArray(e.details) && e.details.length) {
      const first = e.details[0] as { path?: unknown; message?: unknown };
      const field = Array.isArray(first.path) ? first.path.filter((p) => typeof p === "string").join(" ") : "";
      if (typeof first.message === "string" && first.message) return sentence(`${field ? `${field}: ` : ""}${first.message}`);
    }
    return e.message ? sentence(e.message) : "Something went wrong.";
  }
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
