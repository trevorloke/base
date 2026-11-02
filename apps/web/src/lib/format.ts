import type {
  ActionClass,
  ActivityKind,
  Actor,
  AlertSeverity,
  AutonomyLevel,
  Network,
  PostStatus,
  RedLineSeverity,
  TrendStage,
  VariantStatus,
} from "../types";

// Their words, not ours. Every label a strategist reads comes from here.

export const STAGE_LABEL: Record<TrendStage, string> = {
  rising: "Rising",
  peaking: "Peaking",
  plateau: "Plateau",
  fading: "Fading",
  dormant: "Dormant",
};

export const STAGE_HINT: Record<TrendStage, string> = {
  rising: "gaining attention",
  peaking: "at or near the top",
  plateau: "holding steady",
  fading: "losing attention",
  dormant: "quiet",
};

export const NETWORK_LABEL: Record<Network, string> = {
  x: "X",
  bluesky: "Bluesky",
  threads: "Threads",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  pinterest: "Pinterest",
  mastodon: "Mastodon",
};

/** Hard text limits per network, for the inline editor's counter. */
export const NETWORK_MAX_TEXT: Record<Network, number> = {
  x: 280,
  bluesky: 300,
  threads: 500,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
  tiktok: 4000,
  youtube: 5000,
  pinterest: 500,
  mastodon: 500,
};

/** Networks where one post can continue as a thread of replies. */
export const NETWORK_THREADS: ReadonlySet<Network> = new Set<Network>(["x", "bluesky", "threads", "mastodon"]);

/** Networks that refuse a post without an image or video. */
export const NETWORK_NEEDS_MEDIA: ReadonlySet<Network> = new Set<Network>(["instagram", "tiktok", "pinterest", "youtube"]);

/** Most attachments a single post can carry. */
export const NETWORK_MAX_MEDIA: Record<Network, number> = {
  x: 4,
  bluesky: 4,
  threads: 20,
  instagram: 10,
  facebook: 10,
  linkedin: 20,
  tiktok: 35,
  youtube: 1,
  pinterest: 1,
  mastodon: 4,
};

const URL_RE = /https?:\/\/[^\s]+/gi;
const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Characters as each network counts them: X weighs links as 23 and emoji/CJK as 2; Bluesky counts graphemes. */
export function textLength(network: Network, s: string): number {
  if (network === "x") {
    const urls = s.match(URL_RE)?.length ?? 0;
    let n = 0;
    for (const ch of s.replace(URL_RE, "")) {
      const cp = ch.codePointAt(0) ?? 0;
      const heavy =
        (cp >= 0x1100 && cp <= 0x11ff) ||
        (cp >= 0x2600 && cp <= 0x27bf) ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7af) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xffef) ||
        cp >= 0x1f000;
      n += heavy ? 2 : 1;
    }
    return n + urls * 23;
  }
  if (network === "bluesky" && graphemes) {
    let n = 0;
    for (const _ of graphemes.segment(s)) n++;
    return n;
  }
  return [...s].length;
}

export const ACCOUNT_STATUS_LABEL: Record<"active" | "reauth_required" | "disabled", string> = {
  active: "Connected",
  reauth_required: "Needs reconnecting",
  disabled: "Disconnected",
};

export function networkLabel(network: string): string {
  return (NETWORK_LABEL as Record<string, string>)[network] ?? network;
}

export const POST_STATUS_LABEL: Record<PostStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting on you",
  approved: "Approved",
  scheduled: "Scheduled",
  publishing: "Going out",
  published: "Went out",
  partially_published: "Partly went out",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked by a red line",
};

export const VARIANT_STATUS_LABEL: Record<VariantStatus, string> = {
  pending: "Waiting",
  publishing: "Going out",
  published: "Went out",
  failed: "Failed",
  skipped: "Skipped",
};

export const AUTONOMY_LABEL: Record<AutonomyLevel, string> = {
  suggest: "Suggest only",
  draft: "Draft only",
  schedule_with_approval: "Approval required",
  autopost: "Posts on its own",
};

export const ACTION_CLASS_LABEL: Record<ActionClass, string> = {
  new_post: "New posts",
  reply: "Replies",
  dm: "DMs",
  repost: "Reposts",
  campaign: "Campaigns",
};

export const ACTION_CLASS_ORDER: ActionClass[] = ["new_post", "reply", "dm", "repost", "campaign"];

export const SEVERITY_LABEL: Record<RedLineSeverity, string> = {
  block: "Blocks",
  require_approval: "Needs approval",
  warn: "Warns",
};

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "FYI",
  attention: "Attention",
  urgent: "Urgent",
};

export const KIND_LABEL: Record<ActivityKind, string> = {
  own_post: "Post",
  reply: "Reply",
  mention: "Mention",
  comment: "Comment",
  dm: "DM",
  repost: "Repost",
  quote: "Quote",
  like: "Like",
  follow: "Follow",
};

export function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? kind;
}

/** "Operator · watch", "MCP agent · claude-desktop", "Human · marta", "System". */
export function actorLabel(actor: Actor | null | undefined): string {
  if (!actor) return "Unknown";
  switch (actor.type) {
    case "human":
      return `Human · ${actor.id}`;
    case "operator":
      return `Operator · ${actor.id}`;
    case "mcp":
      return `MCP agent · ${actor.id}`;
    case "system":
      return "System";
    default:
      return `${actor.type} · ${actor.id}`;
  }
}

/** For sentences: "Approved by marta", "Created by the watch operator", "…by an MCP agent (claude-desktop)". */
export function actorPhrase(actor: Actor | null | undefined): string {
  if (!actor) return "someone";
  switch (actor.type) {
    case "human":
      return actor.id;
    case "operator":
      return `the ${actor.id} operator`;
    case "mcp":
      return `an MCP agent (${actor.id})`;
    case "system":
      return "Starsign";
    default:
      return actor.id;
  }
}

export const ACTION_CLASS_SINGULAR: Record<ActionClass, string> = {
  new_post: "New post",
  reply: "Reply",
  dm: "DM",
  repost: "Repost",
  campaign: "Campaign",
};

export function actionClassLabel(cls: string): string {
  return (ACTION_CLASS_SINGULAR as Record<string, string>)[cls] ?? cls.replace(/_/g, " ");
}

const SOURCE_LABEL: Record<string, string> = {
  google_trends: "Google Trends",
  google_trends_rss: "Google Trends, trending now",
  youtube_trending: "YouTube trending",
  bluesky_firehose: "Bluesky firehose",
  bluesky_search: "Bluesky",
  hacker_news: "Hacker News",
  wikipedia_pageviews: "Wikipedia pageviews",
  reddit: "Reddit",
  x: "X",
  tiktok_creative_center: "TikTok Creative Center",
  news: "News",
  own_feed: "Your feed",
  ai_answers: "AI answers",
  manual: "Manual",
};

/** "[linkedin] Naming a competitor…" → "LinkedIn: Naming a competitor…" (the server prefixes the network key). */
export function violationText(message: string): string {
  const m = message.match(/^\[([a-z_]+)\]\s*(.*)$/s);
  if (!m) return message;
  return `${networkLabel(m[1]!)}: ${m[2]}`;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.replace(/_/g, " ");
}

/** 0.78 → "78%" */
export function pct(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${Math.round(x * 100)}%`;
}

/** 12400 → "12.4k", 1_200_000 → "1.2M" */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/** 3.08 → "3.1x" */
export function lift(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${x.toFixed(1)}x`;
}

/** Velocity 0.14 → "+14%/h" */
export function perHour(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const p = Math.round(v * 100);
  return `${p > 0 ? "+" : ""}${p}%/h`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** "Mentions · 41 in 3h" style evidence kinds → readable words. */
export function evidenceKindLabel(kind: string): string {
  return kind.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
