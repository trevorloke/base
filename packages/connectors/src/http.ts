import type { Media } from "@meridian/schema";
import { ConnectorError } from "./types.ts";

export type FetchLike = typeof globalThis.fetch;

/**
 * Resolve fetch at call time rather than at construction so tests can `vi.stubGlobal("fetch", ...)`
 * after building a connector, and so a runtime that swaps the global (proxies, instrumentation)
 * is honored.
 */
export function resolveFetch(injected: FetchLike | undefined): FetchLike {
  return injected ?? globalThis.fetch;
}

/** ISO-8601 at second precision ("2026-11-02T10:00:00Z"); X rejects fractional seconds in time filters. */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** True when `iso` is strictly after `since`; a null `since` means "no lower bound". */
export function isAfter(iso: string, since: Date | null): boolean {
  if (!since) return true;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > since.getTime();
}

/** Parse a JSON body defensively: error bodies are often HTML or empty, and we only need them for messages. */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Shared HTTP status → error classification. 403 is "auth" by default because on most APIs it
 * means the token lacks a scope or the account is restricted; adapters override it where a 403
 * means the request itself was refused (X returns 403 for duplicate or disallowed tweets).
 */
export function classifyHttpStatus(status: number): { kind: ConnectorError["kind"]; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 429) return { kind: "rate_limit", retryable: true };
  if (status >= 500) return { kind: "network", retryable: true };
  if (status >= 400) return { kind: "rejected", retryable: false };
  return { kind: "unknown", retryable: false };
}

/** Transport failures (DNS, reset, timeout) surface from fetch as thrown TypeErrors; they are always worth a retry. */
export function asNetworkError(err: unknown, context: string): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new ConnectorError(`${context}: ${msg}`, "network", true, err);
}

/**
 * Download a media item so it can be re-uploaded to a network. We fetch the bytes ourselves instead
 * of passing the URL along because neither X nor Bluesky accepts remote URLs for media.
 */
export async function downloadMedia(fetchImpl: FetchLike, media: Media): Promise<{ bytes: Uint8Array; mime: string }> {
  let res: Response;
  try {
    res = await fetchImpl(media.url);
  } catch (err) {
    throw asNetworkError(err, `downloading media ${media.url}`);
  }
  if (!res.ok) {
    const { kind, retryable } = classifyHttpStatus(res.status);
    // A 4xx on our own media URL is a bad asset, not a bad credential.
    const k = kind === "auth" ? "rejected" : kind;
    throw new ConnectorError(`downloading media ${media.url}: HTTP ${res.status}`, k, retryable);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = media.mime ?? res.headers.get("content-type")?.split(";")[0]?.trim() ?? (media.kind === "gif" ? "image/gif" : "image/jpeg");
  return { bytes, mime };
}
