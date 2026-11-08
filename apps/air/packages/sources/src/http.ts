import { SourceError, type FetchLike } from "./types.ts";

/** Resolved at call time so tests can stub the global. */
export function fetchOf(custom?: FetchLike): FetchLike {
  return custom ?? ((input, init) => globalThis.fetch(input, init));
}

export async function getText(fetchFn: FetchLike, source: string, url: string, headers: Record<string, string> = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "user-agent": "base-air/0.1 (trend radar; contact: ops@base.win)", ...headers } });
  } catch (e) {
    throw new SourceError(`${source}: network error: ${(e as Error).message}`, source, true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new SourceError(`${source}: HTTP ${res.status} for ${url.split("?")[0]}`, source, retryable, res.status);
  }
  return res.text();
}

export async function getJson<T>(fetchFn: FetchLike, source: string, url: string, headers: Record<string, string> = {}): Promise<T> {
  const text = await getText(fetchFn, source, url, headers);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceError(`${source}: response was not JSON`, source, false);
  }
}

/** Bucket timestamps into counts per bucket, oldest first; empty buckets in range are zeros. */
export function bucketCounts(times: number[], from: number, to: number, stepMs: number): { t: number; n: number }[] {
  const start = Math.floor(from / stepMs) * stepMs;
  const end = Math.floor(to / stepMs) * stepMs;
  const counts = new Map<number, number>();
  for (const t of times) {
    if (t < start || t >= end) continue; // the current, incomplete bucket is excluded: a partial count looks like a drop
    const b = Math.floor(t / stepMs) * stepMs;
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const out: { t: number; n: number }[] = [];
  for (let b = start; b < end; b += stepMs) out.push({ t: b, n: counts.get(b) ?? 0 });
  return out;
}

export function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .trim();
}
