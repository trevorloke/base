import { networkLabel } from "../lib/format";

const SHORT: Record<string, string> = {
  x: "X",
  bluesky: "Bsky",
  threads: "Threads",
  instagram: "IG",
  facebook: "FB",
  linkedin: "in",
  tiktok: "TikTok",
  youtube: "YT",
  pinterest: "Pin",
  mastodon: "Masto",
  reddit: "Reddit",
  google_business: "GBP",
  telegram: "TG",
  discord: "Discord",
  whatsapp: "WA",
  wechat: "WeChat",
  line: "LINE",
  news: "News",
  nostr: "Nostr",
  misskey: "Misskey",
  lemmy: "Lemmy",
  tumblr: "Tumblr",
  vk: "VK",
  twitch: "Twitch",
  slack: "Slack",
  matrix: "Matrix",
  google_chat: "GChat",
  teams: "Teams",
  wordpress: "WP",
  ghost: "Ghost",
  mailchimp: "MC",
  kit: "Kit",
  rss: "RSS",
  weibo: "Weibo",
  douyin: "Douyin",
  wecom: "WeCom",
  band: "Band",
  zalo: "Zalo",
  viber: "Viber",
  ok: "OK",
  webhook: "Hook",
};

/** Text-only network badge. Color comes from the per-network token; no logos. `short` is for tight spots like calendar chips. */
export function NetworkBadge({ network, title, className, short = false }: { network: string; title?: string; className?: string; short?: boolean }) {
  return (
    <span className={`netbadge${className ? ` ${className}` : ""}`} data-network={network} title={title ?? networkLabel(network)}>
      {short ? (SHORT[network] ?? networkLabel(network)) : networkLabel(network)}
    </span>
  );
}
