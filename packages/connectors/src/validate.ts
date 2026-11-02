import { NETWORK_LIMITS, type Media, type Network } from "@starsign/schema";
import type { ValidationIssue } from "./types.ts";

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

export function graphemeLength(s: string): number {
  if (!segmenter) return [...s].length;
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

const URL_RE = /https?:\/\/[^\s]+/gi;

/** X counts every URL as 23 characters (t.co) and most CJK/emoji as 2; we approximate CJK via code points. */
export function xWeightedLength(s: string): number {
  const withoutUrls = s.replace(URL_RE, "");
  const urls = s.match(URL_RE)?.length ?? 0;
  let n = 0;
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    // Ranges weighted 2 in X's config (CJK, Hangul, fullwidth, emoji above BMP).
    const heavy = (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xffef) || cp >= 0x20000;
    n += heavy ? 2 : 1;
  }
  return n + urls * 23;
}

export function textLength(network: Network, s: string): number {
  if (network === "x") return xWeightedLength(s);
  if (network === "bluesky") return graphemeLength(s);
  return [...s].length;
}

/** Generic, network-aware validation every variant passes before policy or publishing. */
export function validateVariant(network: Network, text: string, media: Media[], thread: string[]): ValidationIssue[] {
  const lim = NETWORK_LIMITS[network];
  const issues: ValidationIssue[] = [];
  const segments = [text, ...thread];
  segments.forEach((seg, i) => {
    const len = textLength(network, seg);
    if (len === 0 && i === 0 && media.length === 0) issues.push({ code: "empty", message: "post has no text and no media", segment: 0 });
    if (len > lim.maxText) issues.push({ code: "too_long", message: `${len} > ${lim.maxText} characters for ${network}`, segment: i });
  });
  if (media.length > lim.maxMedia) issues.push({ code: "too_many_media", message: `${media.length} > ${lim.maxMedia} media items for ${network}` });
  if (lim.requiresMedia && media.length === 0) issues.push({ code: "media_required", message: `${network} requires at least one media item` });
  if (thread.length > 0 && !lim.supportsThread) issues.push({ code: "thread_unsupported", message: `${network} does not support threads` });
  for (const m of media) {
    if (m.kind === "video" && lim.maxVideoSeconds && m.durationSeconds && m.durationSeconds > lim.maxVideoSeconds) {
      issues.push({ code: "unsupported_media", message: `video ${m.durationSeconds}s exceeds ${lim.maxVideoSeconds}s on ${network}` });
    }
  }
  return issues;
}
