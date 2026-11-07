import type { Account, ActivityKind, Connector, ModerateAction, Network, NetworkCapabilities } from "../types";

/**
 * Which connector the room uses to connect a network. A network can be served by more than one (a native
 * adapter and an aggregator); the room prefers one that is set up, then a native one, then whatever exists.
 */
export function connectorFor(connectors: Connector[], network: Network): Connector | null {
  const serving = connectors.filter((c) => c.networks.includes(network) && c.connect !== "none");
  if (!serving.length) return null;
  const rank = (c: Connector) => (c.configured ? 0 : 2) + (c.name === "zernio" ? 1 : 0);
  return [...serving].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/**
 * Every connector that can connect a network, the preferred one first. Discord has two that do different jobs
 * (a webhook that posts, a bot that reads and replies), so the room offers a choice where there is more than one.
 * Aggregators are left out when a native connector exists: they would only repeat the same job.
 */
export function connectorsFor(connectors: Connector[], network: Network): Connector[] {
  const serving = connectors.filter((c) => c.networks.includes(network) && c.connect !== "none");
  const native = serving.filter((c) => c.name !== "zernio");
  const list = native.length ? native : serving;
  const first = connectorFor(list, network);
  return first ? [first, ...list.filter((c) => c !== first)] : [];
}

/** How a person tells two connectors for the same network apart. */
export const CONNECTOR_CHOICE: Record<string, { title: string; detail: string; short: string }> = {
  discord: { title: "Post with a webhook", detail: "Posts to one channel. Doesn't read anything.", short: "Webhook" },
  discord_bot: { title: "Read and reply with a bot", detail: "Reads the server's channels, replies and moderates. Can post too.", short: "Bot" },
};

/** What the connector behind an account can do on its network. Falls back to any connector for that network. */
export function capabilitiesFor(connectors: Connector[], account: Pick<Account, "connector" | "network">): NetworkCapabilities | null {
  const own = connectors.find((c) => c.name === account.connector)?.capabilities?.[account.network];
  if (own) return own;
  for (const c of connectors) {
    const caps = c.capabilities?.[account.network];
    if (caps) return caps;
  }
  return null;
}

/** Post kinds an account can publish, "post" first. */
export function kindsFor(connectors: Connector[], account: Pick<Account, "connector" | "network">): string[] {
  const kinds = capabilitiesFor(connectors, account)?.kinds ?? [];
  return kinds.length ? kinds : ["post"];
}

/**
 * What each network's API lets a brand do to someone else's item in its inbox. The v1.2 contract only says
 * `moderate: true|false` per network; this table narrows it to the actions that network actually offers.
 * A server that sends `moderateActions` overrides it.
 */
const MODERATION_BY_NETWORK: Partial<Record<Network, ModerateAction[]>> = {
  x: ["like", "hide"],
  bluesky: ["like"],
  threads: ["hide"],
  instagram: ["hide", "delete"],
  facebook: ["like", "hide", "delete"],
  linkedin: ["like", "delete"],
  youtube: ["hide", "delete"],
  mastodon: ["like"],
  reddit: ["like", "hide"],
  telegram: ["delete"],
  discord: ["like", "delete"],
  whatsapp: ["like"],
};

/**
 * Hide applies to comments and replies on your own posts; delete also to messages in a chat the account runs;
 * likes (a reaction, in chat apps) to anything someone said.
 */
const HIDEABLE: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["comment", "reply"]);
const DELETABLE: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["comment", "reply", "message"]);
const LIKEABLE: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["comment", "reply", "mention", "quote", "message"]);
const REPLYABLE: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["comment", "reply", "mention", "quote", "dm", "message"]);

export function moderationFor(caps: NetworkCapabilities | null, network: Network, kind: ActivityKind): { like: boolean; hide: boolean; delete: boolean } {
  if (!caps?.moderate) return { like: false, hide: false, delete: false };
  const allowed = caps.moderateActions ?? MODERATION_BY_NETWORK[network] ?? [];
  return {
    like: allowed.includes("like") && LIKEABLE.has(kind),
    hide: allowed.includes("hide") && HIDEABLE.has(kind),
    delete: allowed.includes("delete") && DELETABLE.has(kind),
  };
}

export function canReply(caps: NetworkCapabilities | null, kind: ActivityKind): boolean {
  return !!caps?.reply && REPLYABLE.has(kind);
}

/** "Bot token", "App password", "Webhook URL": fields whose values must not show on screen. */
export function isSecretInput(key: string): boolean {
  return /password|token|secret|webhook/i.test(key);
}
