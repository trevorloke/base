import "server-only";
import { env } from "@/lib/env";

// The human check on public forms: Cloudflare Turnstile. Every accepted
// sign-up becomes a supporter record here and in Base Ground, and can file a
// request for the desk or send an email, so these forms have their own spam
// protection on top of the honeypot and the rate limits. Turnstile is free,
// shows most people nothing at all (no puzzles), sets no ad-tracking cookies
// and works with screen readers.
//
// When both keys are set the check fails closed: no token, a bad token, or
// no answer from Cloudflare all refuse the submission.

export const HUMAN_MESSAGE = "Please complete the check that you're a person, then try again.";
export const HUMAN_FIELD_MESSAGE = "Complete the check that you're a person.";
export const HUMAN_UNAVAILABLE = "We couldn't check that you're a person just now. Please wait a moment and try again.";
export const HUMAN_TIMEOUT_MS = 5_000;
/** Turnstile tokens are at most 2048 characters. */
const MAX_TOKEN = 2048;

export type HumanResult = { ok: true; checked: boolean } | { ok: false; status: 400 | 503; message: string; field: string };

/**
 * Ask Cloudflare whether `token` (from the widget, sent as x-human-token) is
 * a fresh, valid pass. A no-op that answers ok when the check is off.
 */
export async function verifyHuman(token: string | null | undefined, ip?: string | null, doFetch: typeof fetch = fetch): Promise<HumanResult> {
  if (!env.humanCheckEnabled) return { ok: true, checked: false };
  const response = token?.trim() ?? "";
  if (!response || response.length > MAX_TOKEN) return { ok: false, status: 400, message: HUMAN_MESSAGE, field: HUMAN_FIELD_MESSAGE };
  const body = new URLSearchParams({ secret: env.turnstileSecretKey ?? "", response });
  if (ip) body.set("remoteip", ip);
  try {
    const res = await doFetch(env.turnstileVerifyUrl, { method: "POST", body, signal: AbortSignal.timeout(HUMAN_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) throw new Error(`siteverify answered HTTP ${res.status}`);
    const data = (await res.json()) as { success?: unknown; "error-codes"?: unknown };
    if (data?.success === true) return { ok: true, checked: true };
    const codes = Array.isArray(data?.["error-codes"]) ? data["error-codes"] : [];
    // Cloudflare's own fault, not the visitor's: treat it like no answer.
    if (codes.includes("internal-error")) throw new Error("siteverify answered internal-error");
    return { ok: false, status: 400, message: HUMAN_MESSAGE, field: HUMAN_FIELD_MESSAGE };
  } catch (err) {
    console.error("Human check: Cloudflare Turnstile could not be reached", err);
    return { ok: false, status: 503, message: HUMAN_UNAVAILABLE, field: HUMAN_UNAVAILABLE };
  }
}
