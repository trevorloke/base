import { NETWORK_LIMITS, type ActionClass, type AutonomyLevel, type Network, type RedLine } from "@starsign/schema";

export interface BrandVoice {
  do: string[];
  dont: string[];
  examples: string[];
}

/** The conventional shape of `workspace.profile` (free-form JSON in the database; coerced, never trusted). */
export interface BrandProfile {
  description: string | null;
  audience: string | null;
  topics: string[];
  voice: BrandVoice;
  competitors: string[];
}

/** Everything a prompt needs to sound like the brand and stay inside its red lines. The operators app builds it from Starsign. */
export interface BrandContext {
  workspace: { name: string; slug?: string; profile: Record<string, unknown> };
  policy: {
    redLines: RedLine[];
    timezone: string;
    autonomy?: Partial<Record<ActionClass, AutonomyLevel>>;
    /** Visible disclosure text the policy appends to AI-assisted posts; empty means none. */
    visibleTextForAi?: string;
    competitors?: string[];
  };
  /** Networks with an active, connected account. Hard limits are rendered for these. */
  networks: Network[];
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const asStringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);

export function readProfile(profile: Record<string, unknown> | null | undefined): BrandProfile {
  const p = profile ?? {};
  const voice = (typeof p.voice === "object" && p.voice !== null ? p.voice : {}) as Record<string, unknown>;
  return {
    description: asString(p.description),
    audience: asString(p.audience),
    topics: asStringList(p.topics),
    voice: { do: asStringList(voice.do), dont: asStringList(voice.dont), examples: asStringList(voice.examples) },
    competitors: asStringList(p.competitors),
  };
}

const quote = (s: string) => `"${s}"`;
const bullets = (items: string[], empty: string) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);

/** One line per red line: what it forbids, concretely, so the model avoids it rather than discovering it at the gate. */
export function summarizeRedLine(rl: RedLine): string {
  const head = `[${rl.severity}] ${rl.description}`;
  switch (rl.kind) {
    case "forbidden_phrase":
      return `${head} — never use the phrases ${rl.phrases.map(quote).join(", ")}`;
    case "forbidden_topic":
      return `${head} — never discuss this topic (signals: ${rl.keywords.join(", ")})${rl.semantic ? "; judged by meaning, not just keywords" : ""}`;
    case "forbidden_claim":
      return `${head} — never make claims shaped like ${rl.patterns.map((p) => `/${p}/`).join(", ")}`;
    case "no_competitor_mention":
      return `${head} — never name ${rl.competitors.join(", ")}`;
    case "quiet_hours":
      return `${head} — nothing goes out ${rl.startHour}:00–${rl.endHour}:00 ${rl.timezone}${rl.days.length ? ` on weekdays ${rl.days.join(",")} (0=Sun)` : ""} (scheduling constraint)`;
    case "required_disclosure":
      return `${head} — include ${quote(rl.requiredText)} ${rl.when === "always" ? "in every post" : rl.when === "paid" ? "in paid posts" : "in AI-assisted posts"}`;
    case "max_posts_per_day":
      return `${head} — at most ${rl.limit} post(s) per day${rl.networks.length ? ` on ${rl.networks.join(", ")}` : ""} (cadence constraint)`;
    case "network_restriction":
      return `${head} — never post to ${rl.networks.join(", ")}`;
    case "custom_regex":
      return `${head} — text must not match /${rl.pattern}/${rl.flags}`;
  }
}

export function renderNetworkLimits(networks: Network[]): string {
  if (networks.length === 0) return "- no network connected";
  return networks
    .map((n) => {
      const lim = NETWORK_LIMITS[n];
      const unit = n === "bluesky" ? "graphemes" : "characters";
      const url = n === "x" ? " (every URL counts as 23)" : "";
      return `- ${n}: max ${lim.maxText} ${unit}${url}; ${lim.requiresMedia ? "requires media, text-only posts are rejected" : "text-only allowed"}; ${lim.supportsThread ? "threads supported" : "no threads"}; up to ${lim.maxMedia} media`;
    })
    .join("\n");
}

/** The operators' character, from the product thesis. Shared by every prompt. */
export const COMMON_RULES = `Principles you work by:
- Estimates carry confidence, never false precision: say how sure you are and what would change your mind.
- Every recommendation shows its evidence: cite the numbers, posts and forecasts you were given, by id where one exists.
- You propose; humans approve. Nothing you write publishes on its own, so write for the person reviewing it.
- Never invent facts, numbers, quotes, names, links or results. If it is not in your inputs, you do not know it.
- Stay inside the red lines in every variant. If a request would cross one, say so in your notes instead of complying.
- Write plainly in the brand's voice: no hype, no filler, no hashtag spam, no emoji unless the voice examples use them.`;

/** The brand block every system prompt is grounded in: profile, voice, red lines, connected networks and their limits. */
export function renderBrandContext(ctx: BrandContext): string {
  const p = readProfile(ctx.workspace.profile);
  const competitors = [...new Set([...p.competitors, ...(ctx.policy.competitors ?? [])])];
  const lines: string[] = [];
  lines.push(`## Brand: ${ctx.workspace.name}`);
  if (p.description) lines.push(`Description: ${p.description}`);
  if (p.audience) lines.push(`Audience: ${p.audience}`);
  if (p.topics.length) lines.push(`Topics the brand owns: ${p.topics.join(", ")}`);
  if (competitors.length) lines.push(`Competitors (never endorse; name only where the red lines allow): ${competitors.join(", ")}`);
  lines.push(`Timezone: ${ctx.policy.timezone}`);
  lines.push("");
  lines.push("## Voice");
  lines.push("Do:");
  lines.push(bullets(p.voice.do, "no guidance given; default to clear, specific, understated"));
  lines.push("Don't:");
  lines.push(bullets(p.voice.dont, "no guidance given; avoid hype and vague claims"));
  lines.push("Examples of the brand's own writing:");
  lines.push(bullets(p.voice.examples.map(quote), "none provided"));
  lines.push("");
  lines.push("## Red lines (never crossed; the gate enforces them on every output and logs each hit)");
  lines.push(bullets(ctx.policy.redLines.map(summarizeRedLine), "none declared yet; still avoid guarantees, unverifiable claims and competitor bashing"));
  if (ctx.policy.visibleTextForAi) lines.push(`Disclosure: AI-assisted posts carry a disclosure record and the visible text ${quote(ctx.policy.visibleTextForAi)} is appended at publish time; do not add it yourself.`);
  else lines.push("Disclosure: AI-assisted posts carry an internal disclosure record (model, prompt version, contributions). Do not announce it in the text unless a red line requires it.");
  lines.push("");
  lines.push("## Connected networks and hard limits");
  lines.push(renderNetworkLimits(ctx.networks));
  return lines.join("\n");
}

/** Compact, deterministic JSON for prompt inputs (sorted keys so identical data renders identically for caching). */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v), 1);
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;
